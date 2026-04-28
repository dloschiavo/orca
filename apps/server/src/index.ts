import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createDb, startEmbeddedPg } from "@orca/db";
import { runMigrations } from "./db/migrate.js";
import { startHeartbeat } from "./services/heartbeat.js";

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

  // Start heartbeat loop — default 5 min (300 000 ms), override via env.
  const heartbeatMs = Number(
    process.env.ORCA_HEARTBEAT_INTERVAL_MS ?? 5 * 60 * 1000,
  );
  const stopHeartbeat = startHeartbeat(db, heartbeatMs);

  const shutdown = async () => {
    console.log("\n[orca] shutting down...");
    stopHeartbeat();
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
