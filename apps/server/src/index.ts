import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createDb, startEmbeddedPg } from "@orca/db";
import { runMigrations } from "./db/migrate.js";
import { startHeartbeat } from "./services/heartbeat.js";
import { startAvailableModelsRefresh } from "./services/available-models.js";

const PORT = Number(process.env.PORT ?? 4455);

async function main() {

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
