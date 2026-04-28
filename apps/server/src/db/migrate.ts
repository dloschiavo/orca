import postgres from "postgres";
import { getTableColumns, getTableName, is, SQL } from "drizzle-orm";
import { PgTable, PgDialect } from "drizzle-orm/pg-core";
import { schema } from "@orca/db";

// Two-phase schema sync:
//
//   1) Base DDL — idempotent CREATE TABLE IF NOT EXISTS for every table, plus
//      historical data migrations (status vocabulary renames etc.). This
//      handles fresh databases and keeps us on the no-drizzle-kit-in-dev path.
//
//   2) Auto-sync — walk every exported drizzle schema table, diff its columns
//      against information_schema.columns, and run ALTER TABLE ADD COLUMN IF
//      NOT EXISTS for anything missing. This means a new field added to a
//      packages/db schema file just Works on the next server boot, instead of
//      silently 500ing every query that selects it.
//
// Rules for auto-sync:
//   - Columns are added with type + default from the drizzle declaration.
//   - NOT NULL is only emitted when the column also has a default, otherwise
//     Postgres rejects the ALTER on a non-empty table. A warning is logged.
//   - Foreign keys, unique constraints, and index changes are NOT auto-applied
//     — those still require a hand edit to BASE_DDL or a one-off ALTER here.
//     Most additions are plain fields, so this covers 90% of the pain without
//     pretending to be a real migration engine.
//   - Column *removals* and *type changes* are NOT handled; drizzle-kit is the
//     right tool when that day comes.

const BASE_DDL = `
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ═══════════════════════════════════════════════════════════════════════
-- Idempotent renames: archetypes → agents. Must run BEFORE CREATE TABLE
-- so existing DBs get renamed, then CREATE TABLE IF NOT EXISTS is a no-op.
-- Fresh DBs skip these (tables don't exist yet).
-- ═══════════════════════════════════════════════════════════════════════
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'archetypes' AND relkind = 'r')
     AND NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'agents' AND relkind = 'r')
  THEN
    ALTER TABLE archetypes RENAME TO agents;
    ALTER INDEX IF EXISTS archetypes_name_version_unique RENAME TO agents_name_version_unique;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agents' AND column_name = 'system_prompt') THEN
    ALTER TABLE agents RENAME COLUMN system_prompt TO agents_md;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'stories' AND column_name = 'archetype') THEN
    ALTER TABLE stories RENAME COLUMN archetype TO agent;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'stories' AND column_name = 'archetype_override') THEN
    ALTER TABLE stories RENAME COLUMN archetype_override TO agent_override;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'stories' AND column_name = 'archetype_override_reason') THEN
    ALTER TABLE stories RENAME COLUMN archetype_override_reason TO agent_override_reason;
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'project_rider_sections' AND column_name = 'archetype') THEN
    ALTER TABLE project_rider_sections RENAME COLUMN archetype TO agent_name;
  END IF;
END $$;

-- Rename agent names: frontend-implementor → frontend, backend-implementor → backend
UPDATE agents SET name = 'frontend' WHERE name = 'frontend-implementor';
UPDATE agents SET name = 'backend'  WHERE name = 'backend-implementor';
UPDATE stories SET agent = 'frontend' WHERE agent = 'frontend-implementor';
UPDATE stories SET agent = 'backend'  WHERE agent = 'backend-implementor';
UPDATE project_rider_sections SET agent_name = 'frontend' WHERE agent_name = 'frontend-implementor';
UPDATE project_rider_sections SET agent_name = 'backend'  WHERE agent_name = 'backend-implementor';

-- Migrate finding destinations: archetype-prompt → agent-prompt, archetype-model → agent-model
UPDATE findings SET destination = jsonb_set(destination, '{kind}', '"agent-prompt"')
  WHERE destination->>'kind' = 'archetype-prompt';
UPDATE findings SET destination = jsonb_set(destination, '{kind}', '"agent-model"')
  WHERE destination->>'kind' = 'archetype-model';

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  repo_path text NOT NULL,
  rider_path text,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  heartbeat_default_interval_ms integer NOT NULL DEFAULT 300000,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orca_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title text NOT NULL,
  spec_md text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'backlog',
  agent text,
  agent_override text,
  agent_override_reason text,
  parent_story_id uuid,
  labels jsonb NOT NULL DEFAULT '[]'::jsonb,
  priority integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  completed_at timestamptz,
  current_dispatch_id uuid,
  current_acceptance_card_id uuid,
  blocked_reason text,
  heartbeat_enabled boolean NOT NULL DEFAULT false,
  heartbeat_interval_ms integer,
  next_tick_at timestamptz,
  heartbeat_policy text NOT NULL DEFAULT 'coalesce_if_active',
  working_memory_id uuid,
  dispatch_pid integer,
  dispatch_fail_count integer NOT NULL DEFAULT 0,
  total_cost_usd double precision,
  total_tokens_used integer
);
CREATE INDEX IF NOT EXISTS stories_project_status_idx ON stories(project_id, status);
CREATE INDEX IF NOT EXISTS stories_next_tick_idx ON stories(next_tick_at);

CREATE TABLE IF NOT EXISTS acceptance_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1,
  produced_by_scrum_master_run_id text NOT NULL DEFAULT '',
  imperative_steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  target_files jsonb NOT NULL DEFAULT '[]'::jsonb,
  forbidden_changes jsonb NOT NULL DEFAULT '[]'::jsonb,
  acceptance_checks jsonb NOT NULL DEFAULT '[]'::jsonb,
  "references" jsonb NOT NULL DEFAULT '[]'::jsonb,
  escalation_rule text NOT NULL DEFAULT '',
  step_certainties jsonb NOT NULL DEFAULT '[]'::jsonb,
  overall_certainty text NOT NULL DEFAULT 'low',
  scrum_master_assumptions jsonb NOT NULL DEFAULT '[]'::jsonb,
  scrum_master_unasked_questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS acceptance_cards_story_version_idx ON acceptance_cards(story_id, version);

CREATE TABLE IF NOT EXISTS story_working_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id uuid NOT NULL UNIQUE REFERENCES stories(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1,
  current_hypothesis text NOT NULL DEFAULT '',
  approach text NOT NULL DEFAULT '',
  progress_ledger jsonb NOT NULL DEFAULT '[]'::jsonb,
  open_questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  dead_ends jsonb NOT NULL DEFAULT '[]'::jsonb,
  key_files jsonb NOT NULL DEFAULT '[]'::jsonb,
  invariants_discovered jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_updated_at timestamptz NOT NULL DEFAULT now(),
  last_updated_by_dispatch_id uuid,
  reset_count integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS dispatches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  attempt integer NOT NULL DEFAULT 1,
  adapter_type text NOT NULL,
  trigger text NOT NULL,
  acceptance_card_id uuid NOT NULL REFERENCES acceptance_cards(id) ON DELETE RESTRICT,
  step_id text NOT NULL,
  snapshot jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  started_at timestamptz,
  completed_at timestamptz,
  result_diff text,
  result_files_touched jsonb,
  result_verdict text,
  result_token_usage jsonb,
  token_heatmap_id uuid,
  qa_report_id uuid,
  auditor_report_id uuid
);
CREATE INDEX IF NOT EXISTS dispatches_story_attempt_idx ON dispatches(story_id, attempt);
CREATE INDEX IF NOT EXISTS dispatches_status_idx ON dispatches(status);

CREATE TABLE IF NOT EXISTS token_heatmaps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatch_id uuid REFERENCES dispatches(id) ON DELETE CASCADE,
  story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  agent text NOT NULL DEFAULT 'do-er',
  attempt integer NOT NULL DEFAULT 0,
  calls integer NOT NULL DEFAULT 1,
  turns jsonb NOT NULL DEFAULT '[]'::jsonb,
  file_attribution jsonb NOT NULL DEFAULT '{}'::jsonb,
  tool_attribution jsonb NOT NULL DEFAULT '{}'::jsonb,
  total_in integer NOT NULL DEFAULT 0,
  total_out integer NOT NULL DEFAULT 0,
  total_cached integer NOT NULL DEFAULT 0,
  total_cache_creation integer NOT NULL DEFAULT 0,
  total_uncached integer NOT NULL DEFAULT 0,
  prompt_bytes_sent integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Existing DBs may have token_heatmaps.dispatch_id as NOT NULL from the
-- v1 schema. Drop the constraint so QA / classifier (which run without
-- a dispatches row) can record usage too. Idempotent.
ALTER TABLE token_heatmaps ALTER COLUMN dispatch_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS token_heatmaps_dispatch_idx ON token_heatmaps(dispatch_id);
CREATE INDEX IF NOT EXISTS token_heatmaps_story_idx ON token_heatmaps(story_id);
CREATE INDEX IF NOT EXISTS token_heatmaps_story_agent_idx ON token_heatmaps(story_id, agent);

CREATE TABLE IF NOT EXISTS findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  source text NOT NULL,
  body text NOT NULL,
  citation jsonb,
  root_cause text NOT NULL DEFAULT 'unknown',
  scope text NOT NULL DEFAULT 'project-local',
  destination jsonb NOT NULL DEFAULT '{"kind":"dismissed","path":null,"auditRowId":null}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  applied_commit text
);
CREATE INDEX IF NOT EXISTS findings_story_idx ON findings(story_id);
CREATE INDEX IF NOT EXISTS findings_root_cause_idx ON findings(root_cause);
CREATE INDEX IF NOT EXISTS findings_status_idx ON findings(status);

CREATE TABLE IF NOT EXISTS classifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id uuid NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  classifier_version text NOT NULL,
  proposed_root_cause text NOT NULL,
  proposed_scope text NOT NULL,
  proposed_destination jsonb NOT NULL,
  reasoning text NOT NULL DEFAULT '',
  confidence real NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refinement_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  acceptance_card_id uuid NOT NULL REFERENCES acceptance_cards(id) ON DELETE CASCADE,
  step_id text,
  source text NOT NULL,
  question text NOT NULL,
  context text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open',
  answer text,
  answered_at timestamptz,
  priority real NOT NULL DEFAULT 0,
  priority_factors jsonb NOT NULL DEFAULT '{"closenessToDispatch":0,"certaintyDelta":0,"blocksDispatch":false,"ageMs":0}'::jsonb,
  blocks_dispatch boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refinement_questions_story_status_idx ON refinement_questions(story_id, status);
CREATE INDEX IF NOT EXISTS refinement_questions_open_blocking_idx ON refinement_questions(status, blocks_dispatch, story_id);
CREATE INDEX IF NOT EXISTS refinement_questions_priority_idx ON refinement_questions(status, priority);

CREATE TABLE IF NOT EXISTS implementation_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  concern_slug text NOT NULL,
  concern_title text NOT NULL,
  cluster text NOT NULL,
  recipe_type text NOT NULL,
  applicability text NOT NULL DEFAULT 'universal',
  status text NOT NULL DEFAULT 'unaudited',
  decision_reason text,
  substitute_recipe_slug text,
  custom_substitute_notes text,
  linked_story_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  linked_trigger_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  blocking_story_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_reviewed_at timestamptz,
  last_reviewed_by text,
  applied_from_finding_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_project_concern_unique UNIQUE (project_id, concern_slug)
);
CREATE INDEX IF NOT EXISTS audit_project_cluster_idx ON implementation_audit(project_id, cluster);
CREATE INDEX IF NOT EXISTS audit_project_status_idx ON implementation_audit(project_id, status);

CREATE TABLE IF NOT EXISTS agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  agents_md text NOT NULL DEFAULT '',
  default_tool_allowlist jsonb NOT NULL DEFAULT '[]'::jsonb,
  default_skill_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  description text NOT NULL DEFAULT '',
  is_code_modifying boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agents_name_version_unique UNIQUE (name, version)
);

CREATE TABLE IF NOT EXISTS project_rider_sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_name text,
  recipe_slug text,
  body_md text NOT NULL,
  applied_from_finding_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_rider_sections_project_idx ON project_rider_sections(project_id);

CREATE TABLE IF NOT EXISTS triggers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind text NOT NULL,
  schedule text,
  watch_pattern text,
  target_story_template_id uuid,
  linked_audit_row_id uuid,
  concurrency_policy text NOT NULL DEFAULT 'coalesce_if_active',
  enabled boolean NOT NULL DEFAULT true,
  last_fired_at timestamptz,
  next_fire_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS triggers_project_idx ON triggers(project_id);
CREATE INDEX IF NOT EXISTS triggers_next_fire_idx ON triggers(next_fire_at);

CREATE TABLE IF NOT EXISTS activity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_events_story_created_idx ON activity_events(story_id, created_at);

-- Vocabulary migrations. Idempotent — re-running is a no-op once applied.
-- Story: 'refinement' folded into 'backlog' (agile-standard "committed but
-- needs more details"). 'icebox' is a new uncommitted state, no migration
-- needed since nothing was previously labeled that way.
UPDATE stories SET status = 'backlog' WHERE status = 'refinement';

-- 'todo' removed: without sprints it has no meaning; fold into 'backlog'.
UPDATE stories SET status = 'backlog' WHERE status = 'todo';

-- 'in_review' renamed to 'final_review'; 'in_qa' added as the step before it.
UPDATE stories SET status = 'final_review' WHERE status = 'in_review';

-- Audit: 'unreviewed' renamed to 'unaudited' (clearer: we haven't checked
-- the codebase yet). 'implementing' is gone — that's a story-workflow state,
-- not a state of the codebase. We don't know whether the work shipped, so
-- the honest reset is 'unaudited'; the human re-checks the repo.
UPDATE implementation_audit SET status = 'unaudited' WHERE status = 'unreviewed';
UPDATE implementation_audit SET status = 'unaudited' WHERE status = 'implementing';

-- Backfill: extract total_tokens_used from stored result activity events for
-- stories that have the data in their activity feed but never persisted it on
-- the stories row (race condition in earlier code).
UPDATE stories s
SET total_tokens_used = sub.tokens
FROM (
  SELECT
    ae.story_id,
    (
      COALESCE((ae.payload->'usage'->>'input_tokens')::int, 0) +
      COALESCE((ae.payload->'usage'->>'output_tokens')::int, 0) +
      COALESCE((ae.payload->'usage'->>'cache_read_input_tokens')::int, 0) +
      COALESCE((ae.payload->'usage'->>'cache_creation_input_tokens')::int, 0)
    ) AS tokens
  FROM activity_events ae
  WHERE ae.kind = 'agent_stream'
    AND ae.payload->>'type' = 'result'
    AND ae.story_id IN (SELECT id FROM stories WHERE total_tokens_used IS NULL)
) sub
WHERE s.id = sub.story_id
  AND sub.tokens > 0;

-- Backfill: extract total_cost_usd from stored result activity events for
-- stories that have the data in their activity feed but never persisted it on
-- the stories row. Sums across all result events to match the accumulation
-- logic in the runtime dispatch path.
UPDATE stories s
SET total_cost_usd = sub.cost
FROM (
  SELECT
    ae.story_id,
    SUM(CAST(ae.payload->>'total_cost_usd' AS double precision)) AS cost
  FROM activity_events ae
  WHERE ae.kind = 'agent_stream'
    AND ae.payload->>'type' = 'result'
    AND ae.payload->>'total_cost_usd' IS NOT NULL
    AND ae.story_id IN (SELECT id FROM stories WHERE total_cost_usd IS NULL)
  GROUP BY ae.story_id
) sub
WHERE s.id = sub.story_id
  AND sub.cost > 0;

-- Backfill: set agent to 'backend' for stories that were dispatched
-- before triage/default-agent code was added.
UPDATE stories
SET agent = 'backend'
WHERE agent IS NULL
  AND status NOT IN ('icebox', 'backlog');

-- Seed: ensure the canonical agent list exists in the table so the
-- Agents page has rows to display, the classifier has names to propose,
-- and resolveModelForStory has rows to look up. Idempotent via the
-- UNIQUE (name, version) constraint — re-running on a populated DB is
-- a no-op. New agents added to the canonical list later land via this
-- same INSERT ON CONFLICT path.
INSERT INTO agents (name, version, description, is_code_modifying)
VALUES
  ('scrum-master',   1, 'Refinement + heartbeat next-action.',           false),
  ('spec-writer',    1, 'Shapes vague stories before Refinement.',        false),
  ('architect',      1, 'Multi-file or dependency-graph changes.',        true),
  ('frontend',       1, 'React / Tailwind UI work.',                      true),
  ('backend',        1, 'Server routes, DB, job handlers.',               true),
  ('scraper',        1, 'Scraping / extraction paths.',                   true),
  ('ui-polisher',    1, 'Visual polish, match-the-design.',               true),
  ('refactorer',     1, 'No behavioral change; rename/move/extract.',     true),
  ('test-writer',    1, 'Adds or repairs tests.',                         true),
  ('reviewer',       1, 'QA gate after each completed dispatch.',         false),
  ('explorer',       1, 'Pure research — no edits permitted.',            false),
  ('classifier',     1, 'Routes every finding to an upstream cause.',     false),
  ('compactor',      1, 'Rewrites Working Memory each heartbeat tick.',   false),
  ('triage',         1, 'Classifies incoming stories and assigns agents.', false),
  ('auditor',        1, 'Audits codebase against recipe specs; creates stories for gaps.', false)
ON CONFLICT (name, version) DO NOTHING;

-- Agent prompts now live as flat files at <repo>/prompts/<agent>.md
-- (split on [SYSTEM] / [MAIN]). The agent_prompts table is gone — git
-- handles versioning. Existing tables on older DBs are harmless and can
-- be dropped manually when convenient.

-- Normalize old actor names in activity_events so the invocations endpoint
-- can find historical events by current agent name.
UPDATE activity_events SET actor = 'triage' WHERE actor = 'triage-agent';
UPDATE activity_events SET actor = 'reviewer' WHERE actor = 'qa-agent';
UPDATE activity_events SET actor = 'frontend' WHERE actor = 'claude-local' AND kind IN ('agent_prompt', 'dispatch_completed')
  AND story_id IN (SELECT id FROM stories WHERE agent = 'frontend');
UPDATE activity_events SET actor = 'backend' WHERE actor = 'claude-local' AND kind IN ('agent_prompt', 'dispatch_completed')
  AND story_id IN (SELECT id FROM stories WHERE agent = 'backend');
-- Catch remaining claude-local that don't match a specific agent — default to backend
UPDATE activity_events SET actor = 'backend' WHERE actor = 'claude-local';
`;

export async function runMigrations(connectionString: string): Promise<void> {
  const sql = postgres(connectionString, { max: 1, prepare: false });
  try {
    await sql.unsafe(BASE_DDL);
    const added = await autoSyncColumns(sql);
    if (added > 0) {
      console.log(`[orca] schema applied (+${added} auto-synced column${added === 1 ? "" : "s"})`);
    } else {
      console.log("[orca] schema applied");
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// ---------------------------------------------------------------------------
// Auto-sync: walk drizzle schema, ALTER TABLE ADD COLUMN for anything the
// live database is missing.
// ---------------------------------------------------------------------------

type PgColumnMeta = {
  name: string;
  notNull: boolean;
  hasDefault: boolean;
  default: unknown;
  defaultFn: unknown;
  getSQLType: () => string;
};

async function autoSyncColumns(
  sql: postgres.Sql<Record<string, never>>,
): Promise<number> {
  const dialect = new PgDialect();
  let addedCount = 0;

  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable => is(v, PgTable),
  );

  for (const table of tables) {
    const tableName = getTableName(table);
    const drizzleColumns = getTableColumns(table) as Record<
      string,
      PgColumnMeta
    >;

    const existing = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${tableName}
    `;
    const existingNames = new Set(existing.map((r) => r.column_name));

    // Fresh database: the CREATE TABLE IF NOT EXISTS above will have populated
    // everything the base DDL knows about. If the table has zero columns in
    // information_schema, something is very wrong — skip rather than try to
    // synthesize an entire CREATE TABLE. drizzle-kit is the right tool then.
    if (existingNames.size === 0) continue;

    for (const col of Object.values(drizzleColumns)) {
      if (existingNames.has(col.name)) continue;

      const stmt = buildAddColumnSql(tableName, col, dialect);
      if (!stmt) continue;

      console.log(`[orca/migrate] auto-sync: ${stmt}`);
      await sql.unsafe(stmt);
      addedCount += 1;
    }
  }

  return addedCount;
}

function buildAddColumnSql(
  tableName: string,
  col: PgColumnMeta,
  dialect: PgDialect,
): string | null {
  const sqlType = col.getSQLType();
  if (!sqlType) return null;

  const parts = [
    `ALTER TABLE "${tableName}" ADD COLUMN IF NOT EXISTS "${col.name}" ${sqlType}`,
  ];

  const defaultClause = serializeDefault(col, dialect);
  if (defaultClause) parts.push(`DEFAULT ${defaultClause}`);

  // NOT NULL is only safe with a default (or runtime default) — otherwise
  // Postgres rejects the ALTER on a non-empty table. We emit a warning and
  // leave the column nullable so the boot doesn't fail.
  if (col.notNull) {
    const hasAnyDefault =
      defaultClause !== null || col.defaultFn !== undefined;
    if (hasAnyDefault) {
      parts.push("NOT NULL");
    } else {
      console.warn(
        `[orca/migrate] ${tableName}.${col.name} is NOT NULL with no default — adding as nullable. Provide a default or hand-edit BASE_DDL if this matters.`,
      );
    }
  }

  return parts.join(" ");
}

function serializeDefault(
  col: PgColumnMeta,
  dialect: PgDialect,
): string | null {
  if (!col.hasDefault) return null;
  const value = col.default;
  if (value === undefined) return null;
  if (value === null) return "NULL";

  // SQL expression default — e.g. sql`now()`, sql`gen_random_uuid()`.
  // Drizzle's .defaultNow() and .defaultRandom() route through here.
  if (is(value, SQL)) {
    try {
      const { sql: rendered, params } = dialect.sqlToQuery(value);
      if (params.length > 0) {
        // Parameterized SQL defaults aren't safe to inline without
        // substitution. Skip and rely on runtime defaults.
        console.warn(
          `[orca/migrate] ${col.name} has a parameterized SQL default — skipping DEFAULT clause`,
        );
        return null;
      }
      return rendered;
    } catch (err) {
      console.warn(
        `[orca/migrate] ${col.name}: failed to render SQL default:`,
        err,
      );
      return null;
    }
  }

  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return `'${value.toISOString()}'::timestamptz`;

  // jsonb defaults: arrays and plain objects go through here.
  if (Array.isArray(value) || typeof value === "object") {
    return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
  }

  return null;
}
