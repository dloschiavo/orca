import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  uuid,
  index,
} from "drizzle-orm/pg-core";
import type { Turn } from "@orca/shared";
import { stories } from "./stories.js";
import { dispatches } from "./dispatches.js";

// Token attribution row. One row per LLM invocation we want to attribute
// (do-er run, QA run, classifier run). Used by GET /api/stories/:id/cost
// to break down spend by agent and by retry, so we can tell which lever
// in the token-reduction work is actually moving the needle.
//
// dispatch_id is nullable: the do-er still has a dispatch row in the
// future, but QA and classifier are out-of-band agents that fire without
// a dispatches row. Cascades come via story_id in that case.
//
// agent ∈ {"do-er", "qa", "classifier"}. We don't constrain it in the
// DB so we can add new agent labels (compactor, scrum-master, …) without
// a migration.

export const tokenHeatmaps = pgTable(
  "token_heatmaps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dispatchId: uuid("dispatch_id").references(() => dispatches.id, {
      onDelete: "cascade",
    }),
    storyId: uuid("story_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    agent: text("agent").notNull().default("do-er"),
    attempt: integer("attempt").notNull().default(0),
    calls: integer("calls").notNull().default(1),
    turns: jsonb("turns").$type<Turn[]>().notNull().default([]),
    fileAttribution: jsonb("file_attribution")
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    toolAttribution: jsonb("tool_attribution")
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    // total_in = uncached + cache_read + cache_creation. Kept for
    // backwards-compat / convenience; the breakdown columns below are
    // what cost analysis actually reads.
    totalIn: integer("total_in").notNull().default(0),
    totalOut: integer("total_out").notNull().default(0),
    totalCached: integer("total_cached").notNull().default(0),
    totalCacheCreation: integer("total_cache_creation").notNull().default(0),
    totalUncached: integer("total_uncached").notNull().default(0),
    promptBytesSent: integer("prompt_bytes_sent").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    dispatchIdx: index("token_heatmaps_dispatch_idx").on(table.dispatchId),
    storyIdx: index("token_heatmaps_story_idx").on(table.storyId),
    storyAgentIdx: index("token_heatmaps_story_agent_idx").on(
      table.storyId,
      table.agent,
    ),
  }),
);

export type TokenHeatmapRow = typeof tokenHeatmaps.$inferSelect;
export type TokenHeatmapInsert = typeof tokenHeatmaps.$inferInsert;
