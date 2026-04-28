import {
  pgTable,
  text,
  timestamp,
  jsonb,
  uuid,
  integer,
  real,
  index,
} from "drizzle-orm/pg-core";
import type {
  FindingCitation,
  FindingDestination,
  FindingRootCause,
  FindingScope,
  FindingSource,
  FindingStatus,
} from "@orca/shared";
import { stories } from "./stories.js";

export const findings = pgTable(
  "findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storyId: uuid("story_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    source: text("source").$type<FindingSource>().notNull(),
    body: text("body").notNull(),
    citation: jsonb("citation").$type<FindingCitation | null>(),
    // `agent-failure` and `agent-false-completion` are valid root cause
    // values, but they are HUMAN-ASSIGNED ONLY — the automated classifier
    // is forbidden from proposing either. See the type comment in
    // `packages/shared/src/finding.ts` and the prompt in
    // `apps/server/src/agents/classifier.ts`. The accumulating count of
    // these findings is the canonical signal that the agent cannot be
    // trusted for the affected class of work.
    rootCause: text("root_cause")
      .$type<FindingRootCause>()
      .notNull()
      .default("unknown"),
    scope: text("scope").$type<FindingScope>().notNull().default("project-local"),
    destination: jsonb("destination")
      .$type<FindingDestination>()
      .notNull()
      .default({ kind: "dismissed", path: null, auditRowId: null }),
    status: text("status")
      .$type<FindingStatus>()
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    appliedCommit: text("applied_commit"),
  },
  (table) => ({
    storyIdx: index("findings_story_idx").on(table.storyId),
    rootCauseIdx: index("findings_root_cause_idx").on(table.rootCause),
    statusIdx: index("findings_status_idx").on(table.status),
  }),
);

export type FindingRow = typeof findings.$inferSelect;
export type FindingInsert = typeof findings.$inferInsert;

// Classifier proposals (separate table; classifier reasoning is auditable).
export const classifications = pgTable("classifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  findingId: uuid("finding_id")
    .notNull()
    .references(() => findings.id, { onDelete: "cascade" }),
  classifierVersion: text("classifier_version").notNull(),
  proposedRootCause: text("proposed_root_cause")
    .$type<FindingRootCause>()
    .notNull(),
  proposedScope: text("proposed_scope").$type<FindingScope>().notNull(),
  proposedDestination: jsonb("proposed_destination")
    .$type<FindingDestination>()
    .notNull(),
  reasoning: text("reasoning").notNull().default(""),
  confidence: real("confidence").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ClassificationRow = typeof classifications.$inferSelect;
export type ClassificationInsert = typeof classifications.$inferInsert;
