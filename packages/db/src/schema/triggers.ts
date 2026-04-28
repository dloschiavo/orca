import {
  pgTable,
  text,
  timestamp,
  boolean,
  uuid,
  index,
} from "drizzle-orm/pg-core";
import type { TriggerConcurrencyPolicy, TriggerKind } from "@orca/shared";
import { projects } from "./projects.js";

// Recurring automations (cron / file-watch / webhook).
// Schema ships in MVP; scheduler + UI land post-MVP per the spec.
export const triggers = pgTable(
  "triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").$type<TriggerKind>().notNull(),
    schedule: text("schedule"),
    watchPattern: text("watch_pattern"),
    targetStoryTemplateId: uuid("target_story_template_id"),
    linkedAuditRowId: uuid("linked_audit_row_id"),
    concurrencyPolicy: text("concurrency_policy")
      .$type<TriggerConcurrencyPolicy>()
      .notNull()
      .default("coalesce_if_active"),
    enabled: boolean("enabled").notNull().default(true),
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
    nextFireAt: timestamp("next_fire_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    projectIdx: index("triggers_project_idx").on(table.projectId),
    nextFireIdx: index("triggers_next_fire_idx").on(table.nextFireAt),
  }),
);

export type TriggerRow = typeof triggers.$inferSelect;
export type TriggerInsert = typeof triggers.$inferInsert;
