import {
  pgTable,
  text,
  timestamp,
  uuid,
  index,
} from "drizzle-orm/pg-core";
import { projects } from "./projects.js";

export const projectRiderSections = pgTable(
  "project_rider_sections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    agentName: text("agent_name"),
    recipeSlug: text("recipe_slug"),
    bodyMd: text("body_md").notNull(),
    appliedFromFindingId: uuid("applied_from_finding_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    projectIdx: index("project_rider_sections_project_idx").on(table.projectId),
  }),
);

export type ProjectRiderSectionRow =
  typeof projectRiderSections.$inferSelect;
export type ProjectRiderSectionInsert =
  typeof projectRiderSections.$inferInsert;
