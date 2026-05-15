import { readdirSync, accessSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createDb, startEmbeddedPg } from "@orca/db";
import { runMigrations } from "./db/migrate.js";
import { startHeartbeat } from "./services/heartbeat.js";
import { startAvailableModelsRefresh } from "./services/available-models.js";
import { checkClaudeAuth, printLoginBanner } from "./services/claude-auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Auto-detect the claude CLI binary if CLAUDE_BIN isn't already set.
// Tries: PATH → Mac app bundle → pnpm home dir.
if (!process.env.CLAUDE_BIN) {
  const found = (() => {
    try {
      const p = execSync("which claude 2>/dev/null", { encoding: "utf8" }).trim();
      if (p) return p;
    } catch { /* not in PATH */ }

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

    const pnpmHome = process.env.PNPM_HOME ?? join(homedir(), "Library", "pnpm");
    try {
      const candidate = join(pnpmHome, "claude");
      accessSync(candidate);
      return candidate;
    } catch { /* not there */ }

    return null;
  })();

  if (found) {
    process.env.CLAUDE_BIN = found;
    console.log(`[orca] CLAUDE_BIN=${found}`);
  } else {
    console.warn("[orca] warning: claude binary not found — dispatch will fail. Install @anthropic-ai/claude-code or set CLAUDE_BIN.");
  }
}

if (!process.env.PORT) {
  throw new Error(
    "[orca] PORT is not set. Run via `pnpm dev` or `pnpm start` so service-ports.mjs resolves it from package.json's goliath.canonicalPort.",
  );
}
const PORT = Number(process.env.PORT);

async function main() {
  // Check Claude auth before anything else — print a loud banner if not logged in.
  const authStatus = await checkClaudeAuth();
  if (!authStatus.loggedIn) printLoginBanner();

  // In dev, boot embedded postgres unless DATABASE_URL is provided.
  let connectionString = process.env.DATABASE_URL ?? "";
  let stopEmbedded: (() => Promise<void>) | null = null;

  if (!connectionString) {
    console.log("[orca] booting embedded postgres...");
    const running = await startEmbeddedPg();
    connectionString = running.connectionString;
    stopEmbedded = running.stop;
    console.log(`[orca] embedded postgres ready: ${connectionString}`);
  }

  const db = createDb({ connectionString });

  // Apply schema — MVP path: push the schema directly so we don't need to run
  // drizzle-kit migrations in dev. Real migrations land once we start shipping.
  await runMigrations(connectionString);

  const app = createApp({ db });
  const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`[orca] server listening on http://localhost:${info.port}`);
  });

  // Start heartbeat loop — default 1 min (60 000 ms), override via env.
  // Concurrency gates are cheap, non-LLM checks, so the tighter cadence is
  // fine. Liveness windows are pinned to absolute durations inside the tick.
  const heartbeatMs = Number(
    process.env.ORCA_HEARTBEAT_INTERVAL_MS ?? 60 * 1000,
  );
  const stopHeartbeat = startHeartbeat(db, heartbeatMs);

  // Keep the Anthropic model list fresh so newly-shipped models show up
  // in the agent dropdown and the `{models.list}` prompt placeholder
  // without a server-code change.
  const stopModelsRefresh = startAvailableModelsRefresh();

  const shutdown = async () => {
    console.log("\n[orca] shutting down...");
    stopHeartbeat();
    stopModelsRefresh();
    server.close();
    if (stopEmbedded) await stopEmbedded();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[orca] fatal:", err);
  process.exit(1);
});



