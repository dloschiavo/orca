import {
  pgTable,
  text,
  timestamp,
  jsonb,
  uuid,
  index,
} from "drizzle-orm/pg-core";
import type { DispatchTargetKind } from "@orca/shared";
import { stories } from "./stories.js";

// Activity feed events — emitted on every state transition and written to the
// detail view's center pane. Story dispatches keep populating `storyId` (the
// existing FK cascade + StoryDetailPage activity filter rely on it); PRD/audit
// dispatches leave `storyId` null and carry their linkage on (targetKind,
// targetId) instead. Every row also sets (targetKind, targetId) — for story
// rows targetId == storyId.
export const activityEvents = pgTable(
  "activity_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Nullable: PRD/audit dispatch events have no owning story.
    storyId: uuid("story_id").references(() => stories.id, {
      onDelete: "cascade",
    }),
    kind: text("kind").notNull(), // "state_transition" | "dispatch_started" | "tool_call" | "comment" | "finding_created" | ...
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    actor: text("actor").notNull().default("system"), // "user" | "system" | "scrum-master" | "classifier" | "compactor" | "reviewer"
    // UUID of the runClaudeDispatch lifecycle that emitted this event.
    // Null for events emitted outside a dispatch (route handlers, heartbeat
    // bookkeeping). Used by the dispatch-claim guard to detect when two
    // lifecycles are running concurrently for the same target.
    dispatchInstanceId: text("dispatch_instance_id"),
    // Generic dispatch-target linkage (story | prd | audit).
    targetKind: text("target_kind")
      .$type<DispatchTargetKind>()
      .notNull()
      .default("story"),
    targetId: uuid("target_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    storyCreatedIdx: index("activity_events_story_created_idx").on(
      table.storyId,
      table.createdAt,
    ),
    targetIdx: index("activity_events_target_idx").on(
      table.targetKind,
      table.targetId,
      table.createdAt,
    ),
  }),
);

export type ActivityEventRow = typeof activityEvents.$inferSelect;
export type ActivityEventInsert = typeof activityEvents.$inferInsert;
