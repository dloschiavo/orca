import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export type OrcaDb = ReturnType<typeof drizzle<typeof schema>>;

export interface CreateDbOptions {
  connectionString: string;
  maxConnections?: number;
}

/**
 * Create a Drizzle client against a running Postgres (embedded or otherwise).
 * The server owns the lifetime of the returned client.
 */
export function createDb(options: CreateDbOptions): OrcaDb {
  const client = postgres(options.connectionString, {
    max: options.maxConnections ?? 10,
    prepare: false,
  });
  return drizzle(client, { schema });
}
