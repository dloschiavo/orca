import { existsSync, readdirSync, accessSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hasStoredOAuthCredentials } from "./claude-oauth.js";

function findClaudeBin(): string | null {
  // 1. Explicit env var set by setup-env.ts
  if (process.env.CLAUDE_BIN && existsSync(process.env.CLAUDE_BIN)) {
    return process.env.CLAUDE_BIN;
  }

  // 2. Mac desktop app
  const codeRoot = join(homedir(), "Library", "Application Support", "Claude", "claude-code");
  try {
    const versions = readdirSync(codeRoot).filter((v) => /^\d/.test(v)).sort();
    const latest = versions.at(-1);
    if (latest) {
      const candidate = join(codeRoot, latest, "claude.app", "Contents", "MacOS", "claude");
      accessSync(candidate);
      return candidate;
    }
  } catch { /* not installed */ }

  return null;
}

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  method: "api-key" | "host-managed" | "oauth" | "none";
  binFound: boolean;
}

// `/health` is polled every ~10s by the login banner. Auth state changes
// rarely and the OAuth presence read touches the macOS keychain (spawns
// `security`), so a determinate *positive* result is cached briefly to keep
// the poll cheap. Negative results are NOT cached, so a fresh `claude auth
// login` (or a Recheck click) is reflected on the very next poll.
let cachedPositive: { status: ClaudeAuthStatus; at: number } | null = null;
const POSITIVE_CACHE_TTL_MS = 30_000;

export async function checkClaudeAuth(): Promise<ClaudeAuthStatus> {
  // API key in env — works for any spawn
  if (process.env.ANTHROPIC_API_KEY) {
    return { loggedIn: true, method: "api-key", binFound: true };
  }

  // Running inside Claude desktop — auth is injected by the host
  if (process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST) {
    return { loggedIn: true, method: "host-managed", binFound: true };
  }

  // Explicit token in env (used by some CI / headless setups)
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { loggedIn: true, method: "oauth", binFound: true };
  }
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    return { loggedIn: true, method: "api-key", binFound: true };
  }

  if (cachedPositive && Date.now() - cachedPositive.at < POSITIVE_CACHE_TTL_MS) {
    return cachedPositive.status;
  }

  const binFound = findClaudeBin() != null;

  // Determine login state by reading the CLI's stored OAuth credentials
  // directly — the same source the dispatcher refreshes from. Unlike spawning
  // `claude auth status`, this can't time out under load, be SIGTERM'd
  // mid-startup, or choke on a non-JSON line — the failure modes that were
  // flipping the banner to "not logged in" on a perfectly authenticated CLI.
  const hasOAuth = await hasStoredOAuthCredentials();
  if (hasOAuth) {
    const status: ClaudeAuthStatus = { loggedIn: true, method: "oauth", binFound };
    cachedPositive = { status, at: Date.now() };
    return status;
  }

  cachedPositive = null;
  return { loggedIn: false, method: "none", binFound };
}

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

export function printLoginBanner(): void {
  const lines = [
    "",
    `${RED}${BOLD}╔══════════════════════════════════════════════════════════════╗${RESET}`,
    `${RED}${BOLD}║                                                              ║${RESET}`,
    `${RED}${BOLD}║   ⚠  CLAUDE CODE CLI NOT LOGGED IN                          ║${RESET}`,
    `${RED}${BOLD}║                                                              ║${RESET}`,
    `${RED}${BOLD}║   Agents will fail until Claude Code is authenticated.       ║${RESET}`,
    `${RED}${BOLD}║                                                              ║${RESET}`,
    `${RED}${BOLD}║   To fix, run one of the following in a terminal:            ║${RESET}`,
    `${RED}${BOLD}║                                                              ║${RESET}`,
    `${YELLOW}${BOLD}║     claude auth login                                        ║${RESET}`,
    `${YELLOW}${BOLD}║     export ANTHROPIC_API_KEY=sk-ant-...                      ║${RESET}`,
    `${RED}${BOLD}║                                                              ║${RESET}`,
    `${RED}${BOLD}║   Then restart the orca server.                              ║${RESET}`,
    `${RED}${BOLD}║                                                              ║${RESET}`,
    `${RED}${BOLD}╚══════════════════════════════════════════════════════════════╝${RESET}`,
    "",
  ];
  for (const line of lines) process.stderr.write(line + "\n");
}
