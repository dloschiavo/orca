import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

// Self-healing for the Claude CLI's OAuth credentials.
//
// Dispatched agents authenticate via the standalone `claude` CLI's stored
// OAuth tokens (file + macOS keychain), NOT via this server's env. Access
// tokens live ~8h; the refresh token rotates on every refresh and is
// single-use. If the CLI sits idle past expiry and its own refresh fails,
// every dispatch 401s until someone re-auths — observed 2026-06-11 as a
// silent ~90-retry loop. This module refreshes the token directly against
// the OAuth endpoint and rewrites BOTH stores, so dispatches keep working
// without `claude auth login`.
//
// `claude auth status` is NOT a validity check — it's local-only and reports
// loggedIn:true for an expired token. Always compare expiresAt to the clock.

// OAuth client id of the Claude Code CLI itself (a public client — the same
// id ships in every CLI install; it is not a secret).
const CLAUDE_CODE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");
const KEYCHAIN_SERVICE = "Claude Code-credentials";

// Refresh proactively when the access token is within this window of expiry,
// so a dispatch never spawns with a token that dies mid-run.
const EXPIRY_MARGIN_MS = 15 * 60 * 1000;
// Floor between refresh attempts. The refresh token is single-use (rotated
// on each exchange), so concurrent failing dispatches must never race their
// own refreshes — the loser's token is already consumed and the exchange
// fails, which is exactly the wedge this module exists to fix.
const ATTEMPT_COOLDOWN_MS = 60 * 1000;

interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

let inFlight: Promise<boolean> | null = null;
let lastAttemptAt = 0;

function extractTokens(raw: unknown): OAuthTokens | null {
  if (!raw || typeof raw !== "object") return null;
  const outer = raw as Record<string, unknown>;
  const c = (outer.claudeAiOauth && typeof outer.claudeAiOauth === "object"
    ? outer.claudeAiOauth
    : outer) as Record<string, unknown>;
  if (
    typeof c.accessToken === "string" &&
    typeof c.refreshToken === "string" &&
    typeof c.expiresAt === "number"
  ) {
    return { accessToken: c.accessToken, refreshToken: c.refreshToken, expiresAt: c.expiresAt };
  }
  return null;
}

async function runSecurity(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("security", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.once("error", () => resolve({ code: 1, stdout, stderr }));
  });
}

async function readFileStore(): Promise<{ json: Record<string, unknown>; tokens: OAuthTokens } | null> {
  try {
    const json = JSON.parse(await readFile(CREDENTIALS_PATH, "utf8")) as Record<string, unknown>;
    const tokens = extractTokens(json);
    return tokens ? { json, tokens } : null;
  } catch {
    return null;
  }
}

async function readKeychainStore(): Promise<{ json: Record<string, unknown>; tokens: OAuthTokens; account: string } | null> {
  if (process.platform !== "darwin") return null;
  const secret = await runSecurity(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]);
  if (secret.code !== 0) return null;
  // The account name is needed to update the entry in place; -w omits it.
  const meta = await runSecurity(["find-generic-password", "-s", KEYCHAIN_SERVICE]);
  const account = meta.stdout.match(/"acct"<blob>="([^"]*)"/)?.[1] ?? "";
  try {
    const json = JSON.parse(secret.stdout.trim()) as Record<string, unknown>;
    const tokens = extractTokens(json);
    return tokens ? { json, tokens, account } : null;
  } catch {
    return null;
  }
}

function mergeTokens(json: Record<string, unknown>, fresh: OAuthTokens): Record<string, unknown> {
  if (json.claudeAiOauth && typeof json.claudeAiOauth === "object") {
    return { ...json, claudeAiOauth: { ...(json.claudeAiOauth as Record<string, unknown>), ...fresh } };
  }
  return { ...json, ...fresh };
}

// Write the refreshed pair into every store that exists. Both must stay in
// sync: the CLI prefers the keychain on macOS but falls back to the file,
// and a stale copy in either one resurfaces as a 401 weeks later.
async function writeStores(fresh: OAuthTokens): Promise<void> {
  const file = await readFileStore().then((f) => f?.json ?? null).catch(() => null);
  if (file) {
    await writeFile(CREDENTIALS_PATH, JSON.stringify(mergeTokens(file, fresh)), { mode: 0o600 });
  }
  const keychain = await readKeychainStore();
  if (keychain) {
    const payload = JSON.stringify(mergeTokens(keychain.json, fresh));
    const res = await runSecurity([
      "add-generic-password", "-U",
      "-s", KEYCHAIN_SERVICE,
      "-a", keychain.account,
      "-w", payload,
    ]);
    if (res.code !== 0) {
      console.warn(`[orca/oauth] keychain write failed: ${res.stderr.trim().slice(0, 200)}`);
    }
  }
}

/**
 * True when a usable OAuth credential pair exists in either store.
 *
 * This is a PRESENCE check, not a validity check. Access tokens are
 * short-lived (~8h) but auto-refreshed before every dispatch
 * (`ensureFreshOAuthToken`), so the only thing that matters for "is the CLI
 * logged in" is whether a refreshable credential pair exists at all. Reading
 * the stores directly (a file read + a `security` lookup) can't time out,
 * emit non-JSON, or be killed mid-startup the way spawning `claude auth
 * status` can — which is exactly what was flipping the login banner on
 * spuriously. Never throws; both store readers swallow their own errors.
 */
export async function hasStoredOAuthCredentials(): Promise<boolean> {
  const [file, keychain] = await Promise.all([readFileStore(), readKeychainStore()]);
  return Boolean(file?.tokens || keychain?.tokens);
}

// True when the CLI authenticates through something other than the stored
// OAuth pair — refreshing would be irrelevant (or actively confusing).
function usingNonOAuthCredentials(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY ||
    process.env.ANTHROPIC_AUTH_TOKEN ||
    process.env.CLAUDE_CODE_OAUTH_TOKEN ||
    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST,
  );
}

async function doRefresh(reason: string): Promise<boolean> {
  // Refresh with whichever store rotated most recently — the older store's
  // refresh token has likely already been consumed by a past rotation.
  const file = await readFileStore();
  const keychain = await readKeychainStore();
  const newest = [file?.tokens, keychain?.tokens]
    .filter((t): t is OAuthTokens => t != null)
    .sort((a, b) => b.expiresAt - a.expiresAt)[0];
  if (!newest) {
    console.warn(`[orca/oauth] refresh skipped (${reason}): no stored credentials found`);
    return false;
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Cloudflare in front of the endpoint 403s generic non-browser agents
      // (error 1010); the CLI's own UA shape passes.
      "User-Agent": "claude-cli/2.0.0 (external, cli)",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: newest.refreshToken,
      client_id: CLAUDE_CODE_CLIENT_ID,
    }),
  });

  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 200);
    console.warn(`[orca/oauth] refresh failed (${reason}): HTTP ${res.status} ${body} — manual \`claude auth login\` needed`);
    return false;
  }

  const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  const fresh: OAuthTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? newest.refreshToken,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  await writeStores(fresh);
  console.log(`[orca/oauth] refreshed CLI OAuth token (${reason}); new expiry ${new Date(fresh.expiresAt).toISOString()}`);
  return true;
}

/**
 * Refresh the CLI's stored OAuth token, deduplicating concurrent callers and
 * rate-limiting attempts. Returns true if a refresh succeeded (or one was
 * already in flight and succeeded), false otherwise. Never throws.
 */
export async function refreshClaudeOAuthToken(reason: string): Promise<boolean> {
  if (usingNonOAuthCredentials()) return false;
  if (inFlight) return inFlight;
  if (Date.now() - lastAttemptAt < ATTEMPT_COOLDOWN_MS) return false;
  lastAttemptAt = Date.now();
  inFlight = doRefresh(reason)
    .catch((err) => {
      console.warn(`[orca/oauth] refresh threw (${reason}): ${err}`);
      return false;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Pre-dispatch gate: if the stored access token is expired or expiring
 * within EXPIRY_MARGIN_MS, refresh it before the CLI is spawned. No-op for
 * env-key / host-managed auth setups. Never throws.
 */
export async function ensureFreshOAuthToken(): Promise<void> {
  if (usingNonOAuthCredentials()) return;
  const file = await readFileStore();
  const keychain = await readKeychainStore();
  const expiries = [file?.tokens.expiresAt, keychain?.tokens.expiresAt]
    .filter((e): e is number => e != null);
  // No stored creds at all: nothing to refresh with; the dispatch will fail
  // and the 401 strike path surfaces it.
  if (expiries.length === 0) return;
  const newest = Math.max(...expiries);
  if (newest - Date.now() > EXPIRY_MARGIN_MS) return;
  await refreshClaudeOAuthToken(
    newest < Date.now() ? "pre-dispatch (token expired)" : "pre-dispatch (token expiring soon)",
  );
}
