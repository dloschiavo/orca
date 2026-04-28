import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  uuid,
  index,
} from "drizzle-orm/pg-core";
import type {
  DispatchSnapshot,
  DispatchStatus,
  DispatchTrigger,
  DispatchVerdict,
  UsageSummary,
} from "@orca/shared";
import { stories } from "./stories.js";
import { acceptanceCards } from "./acceptance-cards.js";

export const dispatches = pgTable(
  "dispatches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storyId: uuid("story_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull().default(1),
    adapterType: text("adapter_type").notNull(),
    trigger: text("trigger").$type<DispatchTrigger>().notNull(),
    acceptanceCardId: uuid("acceptance_card_id")
      .notNull()
      .references(() => acceptanceCards.id, { onDelete: "restrict" }),
    stepId: text("step_id").notNull(),
    // Snapshot is the full frozen object at dispatch start — closed and typed.
    // NO session_params / sessionDisplayId here by design.
    snapshot: jsonb("snapshot").$type<DispatchSnapshot>().notNull(),
    status: text("status")
      .$type<DispatchStatus>()
      .notNull()
      .default("queued"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // Result fields
    resultDiff: text("result_diff"),
    resultFilesTouched: jsonb("result_files_touched").$type<string[]>(),
    resultVerdict: text("result_verdict").$type<DispatchVerdict>(),
    resultTokenUsage: jsonb("result_token_usage").$type<UsageSummary>(),
    tokenHeatmapId: uuid("token_heatmap_id"),
    qaReportId: uuid("qa_report_id"),
    auditorReportId: uuid("auditor_report_id"),
  },
  (table) => ({
    storyAttemptIdx: index("dispatches_story_attempt_idx").on(
      table.storyId,
      table.attempt,
    ),
    statusIdx: index("dispatches_status_idx").on(table.status),
  }),
);

export type DispatchRow = typeof dispatches.$inferSelect;
export type DispatchInsert = typeof dispatches.$inferInsert;
