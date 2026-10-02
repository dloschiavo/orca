import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  uuid,
  index,
  unique,
} from "drizzle-orm/pg-core";
import type {
  CliDispatchState,
  AuditScheduleKind,
  AuditFindingKind,
  AuditFindingStatus,
} from "@orca/shared";
import { projects } from "./projects.js";

// Standing standards-checks. Distinct from `implementation_audit` (the recipe-
// gap matrix). Prompt lives at <repo>/prompts/audits/<slug>.md.
export const auditChecks = pgTable(
  "audit_checks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    scheduleKind: text("schedule_kind")
      .$type<AuditScheduleKind>()
      .notNull()
      .default("manual"),
    scheduleTime: text("schedule_time"), // "HH:MM" local
    scheduleDays: jsonb("schedule_days").$type<number[]>().notNull().default([]),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    // Dispatch tracking — mirrors stories (reap/adopt + running animation).
    dispatchPid: integer("dispatch_pid"),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    dispatchFailCount: integer("dispatch_fail_count").notNull().default(0),
    dispatchState: jsonb("dispatch_state").$type<CliDispatchState | null>(),
    // Set when the user manually stops a running agent. Suppresses heartbeat
    // auto-pickup (scheduled runs / open-fail fixes) until a new run clears it.
    dispatchStoppedAt: timestamp("dispatch_stopped_at", { withTimezone: true }),
    claudeSessionId: text("claude_session_id"),
    claudeSessionSystemPromptHash: text("claude_session_system_prompt_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    projectSlugUnique: unique("audit_checks_project_slug_unique").on(
      table.projectId,
      table.slug,
    ),
    nextRunIdx: index("audit_checks_next_run_idx").on(table.nextRunAt),
  }),
);

// Each run emits findings: questions (need user input) and fails (auto-fixable).
export const auditFindings = pgTable(
  "audit_findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    auditCheckId: uuid("audit_check_id")
      .notNull()
      .references(() => auditChecks.id, { onDelete: "cascade" }),
    kind: text("kind").$type<AuditFindingKind>().notNull(),
    status: text("status")
      .$type<AuditFindingStatus>()
      .notNull()
      .default("open"),
    title: text("title").notNull(),
    detail: text("detail").notNull().default(""),
    proposedFix: text("proposed_fix"),
    answer: text("answer"),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    targetPrdRelPath: text("target_prd_rel_path"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    checkStatusIdx: index("audit_findings_check_status_idx").on(
      table.auditCheckId,
      table.status,
    ),
  }),
);

export type AuditCheckRow = typeof auditChecks.$inferSelect;
export type AuditCheckInsert = typeof auditChecks.$inferInsert;
export type AuditFindingRow = typeof auditFindings.$inferSelect;
export type AuditFindingInsert = typeof auditFindings.$inferInsert;
