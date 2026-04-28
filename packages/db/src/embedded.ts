import EmbeddedPostgres from "embedded-postgres";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

export interface EmbeddedPgOptions {
  /** Directory to store the Postgres data dir. Defaults to ~/.orca/pgdata. */
  dataDir?: string;
  /** TCP port to listen on. Defaults to 5464. */
  port?: number;
  /** Postgres user. Defaults to "orca". */
  user?: string;
  /** Postgres password. Defaults to "orca". */
  password?: string;
  /** Database name to ensure exists. Defaults to "orca". */
  database?: string;
}

export interface RunningEmbeddedPg {
  connectionString: string;
  stop(): Promise<void>;
}

/**
 * Boots an embedded Postgres instance for local dev. Idempotent — if the data
 * dir already exists, it reuses it. On first boot, initializes and creates the
 * `orca` database.
 *
 * This is the "single local DB file per install" described in the spec.
 * For production (or when someone sets DATABASE_URL), the server skips this
 * and connects directly.
 */
export async function startEmbeddedPg(
  options: EmbeddedPgOptions = {},
): Promise<RunningEmbeddedPg> {
  const dataDir =
    options.dataDir ?? path.join(os.homedir(), ".orca", "pgdata");
  const port = options.port ?? 5464;
  const user = options.user ?? "orca";
  const password = options.password ?? "orca";
  const database = options.database ?? "orca";

  const firstBoot = !fs.existsSync(dataDir);
  fs.mkdirSync(path.dirname(dataDir), { recursive: true });

  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user,
    password,
    port,
    persistent: true,
  });

  // If postgres is already running (e.g. a previous vite-node reload didn't
  // cleanly shut it down), skip pg.start() and reuse the live instance.
  const pidFile = path.join(dataDir, "postmaster.pid");
  const alreadyRunning = fs.existsSync(pidFile) && (() => {
    try {
      const pid = parseInt(fs.readFileSync(pidFile, "utf8").split("\n")[0] ?? "", 10);
      process.kill(pid, 0); // throws if PID is dead
      return true;
    } catch {
      return false;
    }
  })();

  if (!alreadyRunning) {
    if (firstBoot) {
      await pg.initialise();
    }
    await pg.start();

    if (firstBoot) {
      try {
        await pg.createDatabase(database);
      } catch (err) {
        // Race or re-init — ignore "already exists".
        if (!String(err).includes("already exists")) throw err;
      }
    }
  }

  const connectionString = `postgres://${user}:${password}@localhost:${port}/${database}`;
  return {
    connectionString,
    async stop() {
      if (!alreadyRunning) await pg.stop();
    },
  };
}
