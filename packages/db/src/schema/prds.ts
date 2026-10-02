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
import type { CliDispatchState } from "@orca/shared";
import { projects } from "./projects.js";

// One row per discovered *.md doc in a project repo. The file is the source of
// truth for content/questions/markers; this row carries only orca-side state.
// See packages/shared/src/prd.ts for the field contract.
export const prds = pgTable(
  "prds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    relPath: text("rel_path").notNull(),
    title: text("title").notNull().default(""),
    // Debounce bookkeeping for the 120s-settle drafter pickup.
    lastSeenHash: text("last_seen_hash"),
    lastChangeAt: timestamp("last_change_at", { withTimezone: true }),
    lastProcessedHash: text("last_processed_hash"),
    lastProcessedAt: timestamp("last_processed_at", { withTimezone: true }),
    // The content hash at which the heartbeat last re-dispatched the drafter to
    // resolve a *limbo* doc — one with outstanding items but nothing tagged
    // `[IMP]` and no open `❓`, so neither an implementer nor the human can move
    // it. Without this the heartbeat would either never re-engage such a doc (it
    // silently dies, the "hiding in the bathroom" bug) or re-dispatch every
    // settle window forever if the drafter makes no edit. Gating the limbo
    // re-draft on `hash !== limboCheckedHash` gives the drafter exactly one
    // attempt per distinct content state.
    limboCheckedHash: text("limbo_checked_hash"),
    ignoredAt: timestamp("ignored_at", { withTimezone: true }),
    // Dispatch tracking — mirrors stories so the heartbeat reap/adopt path and
    // the running animation work identically for PRD dispatches.
    dispatchPid: integer("dispatch_pid"),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    dispatchFailCount: integer("dispatch_fail_count").notNull().default(0),
    dispatchState: jsonb("dispatch_state").$type<CliDispatchState | null>(),
    // Set when the user manually stops a running agent. Suppresses heartbeat
    // auto-pickup until the underlying trigger moves past it (the file changes,
    // i.e. lastChangeAt > dispatchStoppedAt) or a manual dispatch clears it.
    dispatchStoppedAt: timestamp("dispatch_stopped_at", { withTimezone: true }),
    claudeSessionId: text("claude_session_id"),
    claudeSessionSystemPromptHash: text("claude_session_system_prompt_hash"),
    // The PRD section (nearest heading) the captured session was implementing.
    // A continuation pass on the SAME section may --resume that session (warm
    // cache, same files) instead of cold-starting; a different section, a
    // changed system prompt, or a stale session falls back to a fresh run.
    claudeSessionSection: text("claude_session_section"),
    // Durable store of human answers to PRD `❓` questions, keyed by the stable
    // `Q##` id. The file's `--- Q## ---` block is the rendering surface, but the
    // drafter rewrites the file wholesale and a concurrent human answer would be
    // lost on overwrite. This column is the source of truth: the answer route
    // writes here, and the drafter's post-run merge re-applies every still-open
    // answer back into the rewritten file (dropping ids whose block the drafter
    // folded away). See prd-dispatch.ts mergeAnswersIntoFile.
    answers: jsonb("answers")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    projectRelPathUnique: unique("prds_project_rel_path_unique").on(
      table.projectId,
      table.relPath,
    ),
    projectIdx: index("prds_project_idx").on(table.projectId),
  }),
);

export type PrdRow = typeof prds.$inferSelect;
export type PrdInsert = typeof prds.$inferInsert;
