/**
 * Standalone audit seeder.
 *
 * Usage:
 *   pnpm --filter @orca/server seed:audit <projectId>
 *
 * Boots against the same embedded-postgres the server uses (or
 * DATABASE_URL if set), then upserts Implementation Audit rows from
 * /Users/davidloschiavo/Documents/Goliath/_recipes/_unmigrated/*.md for the
 * given project. Idempotent — safe to re-run.
 */

import { createDb, startEmbeddedPg } from "@orca/db";
import { seedImplementationAudit } from "../services/audit-seed.js";
import { runMigrations } from "../db/migrate.js";

async function main() {
  const projectId = process.argv[2];
  if (!projectId) {
    console.error("usage: seed-audit <projectId>");
    process.exit(2);
  }

  let connectionString = process.env.DATABASE_URL ?? "";
  let stop: (() => Promise<void>) | null = null;
  if (!connectionString) {
    const running = await startEmbeddedPg();
    connectionString = running.connectionString;
    stop = running.stop;
  }

  try {
    await runMigrations(connectionString);
    const db = createDb({ connectionString });
    const inserted = await seedImplementationAudit(db, projectId);
    console.log(`[orca] seeded ${inserted} audit rows for project ${projectId}`);
  } finally {
    if (stop) await stop();
  }
}

main().catch((err) => {
  console.error("[orca] seed-audit fatal:", err);
  process.exit(1);
});
