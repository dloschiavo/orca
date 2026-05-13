/**
 * Detects device-specific paths and writes them to apps/server/.env.local.
 * Runs automatically via postinstall and predev. Idempotent — only writes
 * values that aren't already set.
 *
 * Currently detects:
 *   CLAUDE_BIN — path to the `claude` CLI binary. Required for dispatch.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { readdirSync, accessSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_LOCAL = join(__dirname, "../../../.env.local");

function findClaudeBin(): string | null {
  // 1. Already in PATH
  try {
    const found = execSync("which claude 2>/dev/null", { encoding: "utf8" }).trim();
    if (found) return found;
  } catch { /* not in PATH */ }

  // 2. Mac app: ~/Library/Application Support/Claude/claude-code/<version>/claude.app/Contents/MacOS/claude
  const codeRoot = join(homedir(), "Library", "Application Support", "Claude", "claude-code");
  try {
    const versions = readdirSync(codeRoot).filter(v => /^\d/.test(v)).sort();
    const latest = versions.at(-1);
    if (latest) {
      const candidate = join(codeRoot, latest, "claude.app", "Contents", "MacOS", "claude");
      accessSync(candidate);
      return candidate;
    }
  } catch { /* not installed */ }

  // 3. pnpm PNPM_HOME dir (binaries land directly in $PNPM_HOME, not $PNPM_HOME/bin)
  const pnpmHome = process.env.PNPM_HOME ?? join(homedir(), "Library", "pnpm");
  try {
    const candidate = join(pnpmHome, "claude");
    try { accessSync(candidate); return candidate; } catch { /* not there yet */ }
  } catch { /* skip */ }

  return null;
}

function ensureOnPath(binDir: string): void {
  const profile = join(homedir(), ".bash_profile");
  if (!existsSync(profile)) return;
  const content = readFileSync(profile, "utf8");
  const exportLine = `export PATH="${binDir}:$PATH"`;
  if (content.includes(binDir)) return;
  appendFileSync(profile, `\n# added by orca setup\n${exportLine}\n`, "utf8");
  console.log(`[orca/setup] added ${binDir} to ~/.bash_profile`);
}

function installClaudeCli(): string | null {
  console.log("[orca/setup] claude CLI not found — installing @anthropic-ai/claude-code via pnpm...");
  const pnpmHome = process.env.PNPM_HOME ?? join(homedir(), "Library", "pnpm");
  const env = { ...process.env, PNPM_HOME: pnpmHome, PATH: `${pnpmHome}:${process.env.PATH}` };

  try {
    execSync("pnpm add -g @anthropic-ai/claude-code", { stdio: "inherit", env });
  } catch {
    console.error("[orca/setup] pnpm global install failed. Set CLAUDE_BIN in apps/server/.env.local manually.");
    return null;
  }

  // approve-builds so the postinstall script actually runs
  try {
    execSync("pnpm approve-builds -g --all", { stdio: "inherit", env });
  } catch {
    // fallback: directly rebuild the package
    try {
      execSync("pnpm rebuild -g @anthropic-ai/claude-code", { stdio: "inherit", env });
    } catch { /* best effort */ }
  }

  ensureOnPath(pnpmHome);
  return findClaudeBin();
}

function readEnvLocal(): Record<string, string> {
  if (!existsSync(ENV_LOCAL)) return {};
  return Object.fromEntries(
    readFileSync(ENV_LOCAL, "utf8")
      .split("\n")
      .filter(l => l.trim() && !l.startsWith("#") && l.includes("="))
      .map(l => {
        const idx = l.indexOf("=");
        return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
      })
  );
}

function writeEnvLocal(vars: Record<string, string>): void {
  const lines = Object.entries(vars).map(([k, v]) => `${k}=${v}`);
  writeFileSync(ENV_LOCAL, lines.join("\n") + "\n", "utf8");
}

const existing = readEnvLocal();
let changed = false;

if (!existing.CLAUDE_BIN) {
  const bin = findClaudeBin() ?? installClaudeCli();
  if (bin) {
    existing.CLAUDE_BIN = bin;
    changed = true;
    console.log(`[orca/setup] CLAUDE_BIN=${bin}`);
  } else {
    console.warn("[orca/setup] warning: could not locate claude binary. Set CLAUDE_BIN in apps/server/.env.local manually.");
  }
} else {
  console.log(`[orca/setup] CLAUDE_BIN already set: ${existing.CLAUDE_BIN}`);
}

if (changed) writeEnvLocal(existing);
