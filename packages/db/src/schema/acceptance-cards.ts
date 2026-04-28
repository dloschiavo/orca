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
  ImperativeStep,
  TargetFile,
  AcceptanceCheck,
  AcceptanceReference,
  StepCertainty,
  CertaintyLevel,
} from "@orca/shared";
import { stories } from "./stories.js";

export const acceptanceCards = pgTable(
  "acceptance_cards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storyId: uuid("story_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    producedByScrumMasterRunId: text("produced_by_scrum_master_run_id")
      .notNull()
      .default(""),
    imperativeSteps: jsonb("imperative_steps")
      .$type<ImperativeStep[]>()
      .notNull()
      .default([]),
    targetFiles: jsonb("target_files")
      .$type<TargetFile[]>()
      .notNull()
      .default([]),
    forbiddenChanges: jsonb("forbidden_changes")
      .$type<string[]>()
      .notNull()
      .default([]),
    acceptanceChecks: jsonb("acceptance_checks")
      .$type<AcceptanceCheck[]>()
      .notNull()
      .default([]),
    references: jsonb("references")
      .$type<AcceptanceReference[]>()
      .notNull()
      .default([]),
    escalationRule: text("escalation_rule").notNull().default(""),
    stepCertainties: jsonb("step_certainties")
      .$type<StepCertainty[]>()
      .notNull()
      .default([]),
    overallCertainty: text("overall_certainty")
      .$type<CertaintyLevel>()
      .notNull()
      .default("low"),
    scrumMasterAssumptions: jsonb("scrum_master_assumptions")
      .$type<string[]>()
      .notNull()
      .default([]),
    scrumMasterUnaskedQuestions: jsonb("scrum_master_unasked_questions")
      .$type<string[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    storyVersionIdx: index("acceptance_cards_story_version_idx").on(
      table.storyId,
      table.version,
    ),
  }),
);

export type AcceptanceCardRow = typeof acceptanceCards.$inferSelect;
export type AcceptanceCardInsert = typeof acceptanceCards.$inferInsert;
