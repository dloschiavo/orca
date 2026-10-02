/**
 * One-off throttle freeze.
 *
 * Boots the same embedded-postgres the server uses and sets every throttle
 * concurrency cap to 0 ("dispatch nothing"). Run while the orca server is
 * STOPPED so the value is in place before the server's startup heartbeat tick
 * fires (avoids a dispatch race).
 *
 *   pnpm --filter @orca/server exec tsx src/scripts/set-throttle-zero.ts
 */

import { createDb, startEmbeddedPg, schema } from "@orca/db";
import { runMigrations } from "../db/migrate.js";
import { THROTTLE_KEYS, getThrottleSettings } from "../services/throttle.js";

async function main() {
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

    for (const key of Object.values(THROTTLE_KEYS)) {
      await db
        .insert(schema.orcaSettings)
        .values({ key, value: "0", updatedAt: new Date() })
        .onConflictDoUpdate({
          target: schema.orcaSettings.key,
          set: { value: "0", updatedAt: new Date() },
        });
      console.log(`[orca] set ${key} = 0`);
    }

    const throttle = await getThrottleSettings(db);
    console.log("[orca] throttle now:", JSON.stringify(throttle));
  } finally {
    if (stop) await stop();
  }
}

main().catch((err) => {
  console.error("[orca] set-throttle-zero fatal:", err);
  process.exit(1);
});
