import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  uuid,
} from "drizzle-orm/pg-core";
import type { ProgressEntry, KeyFile } from "@orca/shared";
import { stories } from "./stories.js";

export const storyWorkingMemory = pgTable("story_working_memory", {
  id: uuid("id").primaryKey().defaultRandom(),
  storyId: uuid("story_id")
    .notNull()
    .references(() => stories.id, { onDelete: "cascade" })
    .unique(), // exactly one live WM per story
  version: integer("version").notNull().default(1), // optimistic locking
  currentHypothesis: text("current_hypothesis").notNull().default(""),
  approach: text("approach").notNull().default(""),
  progressLedger: jsonb("progress_ledger")
    .$type<ProgressEntry[]>()
    .notNull()
    .default([]),
  openQuestions: jsonb("open_questions").$type<string[]>().notNull().default([]),
  deadEnds: jsonb("dead_ends").$type<string[]>().notNull().default([]),
  keyFiles: jsonb("key_files").$type<KeyFile[]>().notNull().default([]),
  invariantsDiscovered: jsonb("invariants_discovered")
    .$type<string[]>()
    .notNull()
    .default([]),
  lastUpdatedAt: timestamp("last_updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastUpdatedByDispatchId: uuid("last_updated_by_dispatch_id"),
  resetCount: integer("reset_count").notNull().default(0),
});

export type StoryWorkingMemoryRow = typeof storyWorkingMemory.$inferSelect;
export type StoryWorkingMemoryInsert = typeof storyWorkingMemory.$inferInsert;
