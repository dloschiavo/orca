import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  uuid,
  index,
  doublePrecision,
} from "drizzle-orm/pg-core";
import type { StoryStatus, HeartbeatPolicy } from "@orca/shared";
import { projects } from "./projects.js";

/**
 * Persistent state attached to a story while a detached `claude` child is
 * running. Survives Node restarts so an orphaned child can be tailed or
 * reaped by a fresh process. See `runClaudeDispatch` for how each field is
 * populated and consumed.
 */
export interface DispatchState {
  /** Absolute path to the file the child's stdout is being redirected to. */
  stdoutPath: string;
  /** Absolute path to the file the child's stderr is being redirected to. */
  stderrPath: string;
  /** `git stash create` ref captured before the child ran, used for the per-session diff. May be empty. */
  preDispatchRef: string;
  /** HEAD SHA captured before the child ran, used for the committed-changes fallback. May be null when not in a git repo. */
  preDispatchHead: string | null;
  /** Marker file used by `find -newer` to detect changed files in non-git workspaces. */
  markerPath: string;
  /** mtime of the marker file at spawn time, ISO-8601. */
  markerMtime: string;
  /** Session ID we tried to `--resume` (if any) — used to detect resume failure on reap. */
  existingSessionId: string | null;
  /** Wall-clock spawn time, ISO-8601. */
  spawnedAt: string;
  /** Original arguments to `runClaudeDispatch` so a reaper can run the post-spawn pipeline (QA, retries, etc.) without re-deriving them. */
  args: {
    storyId: string;
    repoPath: string;
    title: string;
    specMd: string;
    changeSummary?: string;
    isRecovery?: boolean;
    qaFailureSummary?: string;
  };
}

export const stories = pgTable(
  "stories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    specMd: text("spec_md").notNull().default(""),
    status: text("status").$type<StoryStatus>().notNull().default("backlog"),
    agent: text("agent"),
    agentOverride: text("agent_override"),
    agentOverrideReason: text("agent_override_reason"),
    parentStoryId: uuid("parent_story_id"),
    // IDs of other stories that must reach `done` before this one can be
    // dispatched. Structured form of the natural-language "depends on
    // sibling X" references agents write into specs. Heartbeat does not
    // gate on this yet — the field is informational and surfaced in the
    // UI hierarchy tab so the human can see the dependency graph.
    prereqStoryIds: jsonb("prereq_story_ids").$type<string[]>().notNull().default([]),
    labels: jsonb("labels").$type<string[]>().notNull().default([]),
    priority: integer("priority").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    currentDispatchId: uuid("current_dispatch_id"),
    currentAcceptanceCardId: uuid("current_acceptance_card_id"),
    blockedReason: text("blocked_reason"),
    dispatchPid: integer("dispatch_pid"),
    dispatchFailCount: integer("dispatch_fail_count").notNull().default(0),
    // Per-story model override. Resolved as:
    //   story.modelOverride ?? agent.model ?? <dispatcher default>
    // Set this when one specific story needs a beefier model than the
    // agent default — e.g., a story the QA agent has bounced multiple
    // times. Null = inherit from agent.
    modelOverride: text("model_override"),
    // How many times the QA agent has bounced this story back to the do-er
    // for the current dispatch loop. Reset to 0 on successful QA pass or on
    // a fresh manual dispatch. Capped at 2 — after that the story is left
    // `blocked` with `blockedReason: "QA failed N times"` and a meta-finding
    // is filed against the loop itself.
    dispatchQaRetryCount: integer("dispatch_qa_retry_count")
      .notNull()
      .default(0),
    heartbeatEnabled: boolean("heartbeat_enabled").notNull().default(false),
    heartbeatIntervalMs: integer("heartbeat_interval_ms"),
    nextTickAt: timestamp("next_tick_at", { withTimezone: true }),
    heartbeatPolicy: text("heartbeat_policy")
      .$type<HeartbeatPolicy>()
      .notNull()
      .default("coalesce_if_active"),
    workingMemoryId: uuid("working_memory_id"),
    totalCostUsd: doublePrecision("total_cost_usd"),
    totalTokensUsed: integer("total_tokens_used"),
    // Claude CLI session ID for the most recent dispatch. Used with
    // `--resume` so subsequent dispatches continue the prior conversation
    // instead of starting fresh, making multi-run activity additive.
    claudeSessionId: text("claude_session_id"),
    // sha256 of the fully-rendered system prompt that was sent when this
    // session was created. On subsequent dispatches we re-render the
    // system prompt and compare — if the hash changes (system-prompt row
    // was edited, or a directive it references changed on disk), we drop
    // the session and start fresh so the new system prompt actually takes
    // effect. Without this check, Claude would keep serving the cached
    // old system turn on --resume and prompt edits would silently no-op.
    claudeSessionSystemPromptHash: text("claude_session_system_prompt_hash"),
    // Persistent state for an in-flight detached dispatch. Set at spawn
    // time so a fresh Node process (after a `tsx watch` restart, crash,
    // etc.) can find the orphaned child via PID and either tail it
    // (still alive) or reap it (already exited) by reading the log
    // files referenced here. Cleared on terminal completion. See
    // `runClaudeDispatch` and `reapOrphanedDispatch` in
    // `apps/server/src/routes/stories.ts` for the contract.
    dispatchState: jsonb("dispatch_state").$type<DispatchState | null>(),
    // Timestamp of the first time this story entered "backlog" status
    // (either created in backlog, or patched from icebox to backlog).
    // Used by the QA reviewer to bound the "files touched" list:
    // only files whose mtime > firstBacklogAt are shown, so the list
    // reflects this story's work and not the entire repo history.
    firstBacklogAt: timestamp("first_backlog_at", { withTimezone: true }),
    // Snapshot of the human-authored title and spec captured at story
    // creation, before the spec-writer agent rewrites them. Shown on the
    // "Original" archive tab so the user can compare the before/after.
    originalTitle: text("original_title"),
    originalSpecMd: text("original_spec_md"),
  },
  (table) => ({
    projectStatusIdx: index("stories_project_status_idx").on(
      table.projectId,
      table.status,
    ),
    nextTickIdx: index("stories_next_tick_idx").on(table.nextTickAt),
  }),
);

export type StoryRow = typeof stories.$inferSelect;
export type StoryInsert = typeof stories.$inferInsert;
