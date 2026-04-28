import {
  boolean,
  pgTable,
  text,
  timestamp,
  jsonb,
  uuid,
  index,
  unique,
} from "drizzle-orm/pg-core";
import type {
  AuditApplicability,
  AuditCluster,
  AuditLastReviewedBy,
  AuditRecipeType,
  AuditStatus,
} from "@orca/shared";
import { projects } from "./projects.js";

export const implementationAudit = pgTable(
  "implementation_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    // identity
    concernSlug: text("concern_slug").notNull(),
    concernTitle: text("concern_title").notNull(),
    cluster: text("cluster").$type<AuditCluster>().notNull(),
    recipeType: text("recipe_type").$type<AuditRecipeType>().notNull(),
    applicability: text("applicability")
      .$type<AuditApplicability>()
      .notNull()
      .default("universal"),
    // decision
    status: text("status")
      .$type<AuditStatus>()
      .notNull()
      .default("unaudited"),
    decisionReason: text("decision_reason"),
    substituteRecipeSlug: text("substitute_recipe_slug"),
    customSubstituteNotes: text("custom_substitute_notes"),
    // linkage
    linkedStoryIds: jsonb("linked_story_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    linkedTriggerIds: jsonb("linked_trigger_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    blockingStoryIds: jsonb("blocking_story_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    // recipe versioning
    recipeContentHash: text("recipe_content_hash"),
    recipeStale: boolean("recipe_stale").notNull().default(false),
    lastAuditedAt: timestamp("last_audited_at", { withTimezone: true }),
    auditVerdict: text("audit_verdict"),
    // provenance
    lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true }),
    lastReviewedBy: text("last_reviewed_by").$type<AuditLastReviewedBy>(),
    appliedFromFindingId: uuid("applied_from_finding_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    projectClusterIdx: index("audit_project_cluster_idx").on(
      table.projectId,
      table.cluster,
    ),
    projectStatusIdx: index("audit_project_status_idx").on(
      table.projectId,
      table.status,
    ),
    projectConcernUnique: unique("audit_project_concern_unique").on(
      table.projectId,
      table.concernSlug,
    ),
  }),
);

export type AuditRowDb = typeof implementationAudit.$inferSelect;
export type AuditRowInsert = typeof implementationAudit.$inferInsert;
