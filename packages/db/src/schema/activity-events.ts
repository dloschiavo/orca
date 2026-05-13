import {
  pgTable,
  text,
  timestamp,
  jsonb,
  uuid,
  index,
} from "drizzle-orm/pg-core";
import { stories } from "./stories.js";

// Activity feed events — emitted on every state transition and written to the
// Story detail view's center pane.
export const activityEvents = pgTable(
  "activity_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storyId: uuid("story_id")
      .notNull()
      .references(() => stories.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // "state_transition" | "dispatch_started" | "tool_call" | "comment" | "finding_created" | ...
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    actor: text("actor").notNull().default("system"), // "user" | "system" | "scrum-master" | "classifier" | "compactor" | "reviewer"
    // UUID of the runClaudeDispatch lifecycle that emitted this event.
    // Null for events emitted outside a dispatch (route handlers, heartbeat
    // bookkeeping). Used by the dispatch-claim guard to detect when two
    // lifecycles are running concurrently for the same story.
    dispatchInstanceId: text("dispatch_instance_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    storyCreatedIdx: index("activity_events_story_created_idx").on(
      table.storyId,
      table.createdAt,
    ),
  }),
);

export type ActivityEventRow = typeof activityEvents.$inferSelect;
export type ActivityEventInsert = typeof activityEvents.$inferInsert;
