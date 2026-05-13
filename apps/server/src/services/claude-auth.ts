import { spawn } from "node:child_process";
import { existsSync, readdirSync, accessSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

export async function checkClaudeAuth(): Promise<ClaudeAuthStatus> {
  // API key in env — works for any spawn
  if (process.env.ANTHROPIC_API_KEY) {
    return { loggedIn: true, method: "api-key", binFound: true };
  }

  // Running inside Claude desktop — auth is injected by the host
  if (process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST) {
    return { loggedIn: true, method: "host-managed", binFound: true };
  }

  const bin = findClaudeBin();
  if (!bin) {
    return { loggedIn: false, method: "none", binFound: false };
  }

  // Run `claude auth status` — fast, local-only, no API calls
  const result = await new Promise<{ loggedIn: boolean }>((resolve) => {
    const child = spawn(bin, ["auth", "status"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    });
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.once("close", () => {
      try {
        const parsed = JSON.parse(stdout);
        resolve({ loggedIn: parsed.loggedIn === true });
      } catch {
        resolve({ loggedIn: false });
      }
    });
    child.once("error", () => resolve({ loggedIn: false }));
  });

  return { loggedIn: result.loggedIn, method: result.loggedIn ? "oauth" : "none", binFound: true };
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
