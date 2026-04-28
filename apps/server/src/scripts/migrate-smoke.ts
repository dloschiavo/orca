// Runtime smoke test for the auto-sync migrator. Not wired into CI — run
// manually with `tsx src/scripts/migrate-smoke.ts` from apps/server when
// touching migrate.ts.
//
//   1. Boot embedded postgres
//   2. Run runMigrations once on a fresh DB (all tables created via BASE_DDL)
//   3. Run it again (should be a no-op — no auto-sync activity)
//   4. Manually drop columns that only exist in the drizzle schema, not the
//      base DDL, then run runMigrations — auto-sync should re-add them
//   5. Verify the columns exist via information_schema
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { startEmbeddedPg } from "@orca/db";
import { runMigrations } from "../db/migrate.js";

// Isolated data dir + port so this never collides with a running dev server.
// Use a fresh (non-existent) path so startEmbeddedPg runs pg.initialise().
const dataDir = join(tmpdir(), `orca-smoke-${Date.now()}`);
const { connectionString, stop } = await startEmbeddedPg({
  dataDir,
  port: 5999,
});
console.log("[smoke] pg ready:", connectionString);

try {
  console.log("\n[smoke] === first run: fresh DB ===");
  await runMigrations(connectionString);

  console.log("\n[smoke] === second run: idempotent ===");
  await runMigrations(connectionString);

  console.log("\n[smoke] === dropping auto-sync columns ===");
  const sql = postgres(connectionString, { max: 1, prepare: false });
  await sql.unsafe(`ALTER TABLE stories DROP COLUMN IF EXISTS total_cost_usd`);
  await sql.unsafe(`ALTER TABLE stories DROP COLUMN IF EXISTS total_tokens_used`);
  await sql.unsafe(`ALTER TABLE stories DROP COLUMN IF EXISTS dispatch_pid`);
  await sql.unsafe(`ALTER TABLE stories DROP COLUMN IF EXISTS dispatch_fail_count`);
  await sql.end({ timeout: 5 });

  console.log("\n[smoke] === third run: should auto-sync 4 columns ===");
  await runMigrations(connectionString);

  const sql2 = postgres(connectionString, { max: 1, prepare: false });
  const cols = await sql2`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'stories'
      AND column_name IN ('total_cost_usd','total_tokens_used','dispatch_pid','dispatch_fail_count')
    ORDER BY column_name
  `;
  console.log("\n[smoke] stories columns after sync:");
  for (const c of cols) console.log(" ", c);
  await sql2.end({ timeout: 5 });

  if (cols.length !== 4) {
    console.error(`[smoke] FAIL: expected 4 columns, got ${cols.length}`);
    process.exit(1);
  }
  console.log("\n[smoke] PASS");
} finally {
  await stop();
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // best effort — embedded-postgres may still hold file handles briefly
  }
}
