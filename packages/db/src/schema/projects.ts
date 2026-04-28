import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  uuid,
} from "drizzle-orm/pg-core";

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  repoPath: text("repo_path").notNull(),
  riderPath: text("rider_path"),
  capabilities: jsonb("capabilities").$type<string[]>().notNull().default([]),
  serverConfig: jsonb("server_config").$type<import("@orca/shared").ServerConfig | null>().default(null),
  context: text("context"),
  heartbeatDefaultIntervalMs: integer("heartbeat_default_interval_ms")
    .notNull()
    .default(5 * 60 * 1000), // 5 minutes per the spec
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ProjectRow = typeof projects.$inferSelect;
export type ProjectInsert = typeof projects.$inferInsert;
