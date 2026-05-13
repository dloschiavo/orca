import {
  pgTable,
  text,
  timestamp,
  boolean,
  jsonb,
  uuid,
  real,
  index,
} from "drizzle-orm/pg-core";
import type {
  RefinementQuestionPriorityFactors,
  RefinementQuestionSource,
  RefinementQuestionStatus,
} from "@orca/shared";
import { stories } from "./stories.js";
import { acceptanceCards } from "./acceptance-cards.js";

// The Refinement Q&A Inbox backing table.
// The metavine principle: the scheduler skips To Do stories with open blocking
// questions, so agent resources are only ever spent on stories whose thinking is complete.

export const refinementQuestions = pgTable(
  "refinement_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storyId: uuid("story_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    // Nullable — spec-writer writes questions before any acceptance card
    // exists, so the FK is optional. The original producer (scrum-master)
    // still always supplies one.
    acceptanceCardId: uuid("acceptance_card_id").references(
      () => acceptanceCards.id,
      { onDelete: "cascade" },
    ),
    stepId: text("step_id"), // nullable — question may be about the whole card
    source: text("source").$type<RefinementQuestionSource>().notNull(),
    question: text("question").notNull(),
    context: text("context").notNull().default(""),
    status: text("status")
      .$type<RefinementQuestionStatus>()
      .notNull()
      .default("open"),
    answer: text("answer"),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    // Continuously recomputed; higher = bubble up sooner in the inbox.
    priority: real("priority").notNull().default(0),
    priorityFactors: jsonb("priority_factors")
      .$type<RefinementQuestionPriorityFactors>()
      .notNull()
      .default({
        closenessToDispatch: 0,
        certaintyDelta: 0,
        blocksDispatch: false,
        ageMs: 0,
      }),
    // Denormalized for cheap dispatch-gate indexing.
    blocksDispatch: boolean("blocks_dispatch").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    storyStatusIdx: index("refinement_questions_story_status_idx").on(
      table.storyId,
      table.status,
    ),
    // The dispatch gate's hot path: find stories with open blocking questions.
    openBlockingIdx: index("refinement_questions_open_blocking_idx").on(
      table.status,
      table.blocksDispatch,
      table.storyId,
    ),
    // The inbox's default sort.
    priorityIdx: index("refinement_questions_priority_idx").on(
      table.status,
      table.priority,
    ),
  }),
);

export type RefinementQuestionRow = typeof refinementQuestions.$inferSelect;
export type RefinementQuestionInsert = typeof refinementQuestions.$inferInsert;
