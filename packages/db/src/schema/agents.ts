import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  uuid,
  boolean,
  unique,
} from "drizzle-orm/pg-core";
import type { AgentName } from "@orca/shared";

// Agent prompts now live as flat files at <repo>/prompts/<agent>.md
// (split on [SYSTEM] / [MAIN]). Versioning is git's responsibility, so
// the agent_prompts table and its drizzle binding have been removed.

// Agents are versioned so editing an AGENTS.md is a commit with history.
// Pattern adapted from paperclip's `agentConfigRevisions`.
export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").$type<AgentName>().notNull(),
    version: integer("version").notNull().default(1),
    agentsMd: text("agents_md").notNull().default(""),
    defaultToolAllowlist: jsonb("default_tool_allowlist")
      .$type<string[]>()
      .notNull()
      .default([]),
    defaultSkillRefs: jsonb("default_skill_refs")
      .$type<string[]>()
      .notNull()
      .default([]),
    description: text("description").notNull().default(""),
    isCodeModifying: boolean("is_code_modifying").notNull().default(false),
    // Per-agent model override. Null = use the dispatcher default
    // (currently whatever `claude` CLI picks). Set this to bump a specific
    // agent to a more capable model when QA findings show that agent
    // consistently failing on the default. The story-level override
    // (`stories.modelOverride`) takes precedence over this.
    model: text("model"),
    // Per-agent "fast model" — the cheap model orca will try FIRST for
    // this agent. If the fast model returns a confident verdict we keep
    // the result and skip the expensive model. If uncertain we escalate
    // to the `model` column above.
    fastModel: text("fast_model"),
    // Soft-delete: null = active, timestamp = archived at that time.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    nameVersionUnique: unique("agents_name_version_unique").on(
      table.name,
      table.version,
    ),
  }),
);

export type AgentRow = typeof agents.$inferSelect;
export type AgentInsert = typeof agents.$inferInsert;
