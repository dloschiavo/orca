import { desc, eq } from "drizzle-orm";
import { schema } from "@orca/db";
import type { OrcaDb } from "@orca/db";
import type { AgentName } from "@orca/shared";

// Current available models, injected into prompts as {models.list} so
// prompt text never hard-codes version strings. Update this constant when
// Anthropic ships new models — no prompt edits required.
export const AVAILABLE_MODELS_LIST = `\
- claude-haiku-4-5   — fastest and cheapest; use for simple, mechanical tasks (single-file edits, renaming, config tweaks)
- claude-sonnet-4-6  — balanced speed and capability; use for most tasks (new features, multi-file refactors, standard bugs)
- claude-opus-4-6    — most capable; use for complex, high-stakes work (architectural changes, tricky concurrency, cross-cutting refactors)

Set modelOverride on the story via PATCH /api/stories/:id with { "modelOverride": "<model-id>" }.`;

// Model resolution for spawned agents.
//
// We pass the resolved model to the spawned `claude` process via the
// ANTHROPIC_MODEL env var, NOT a `--model` CLI flag — the env var is
// honored by every CLI version we care about, while the flag's spelling
// has shifted across releases. Callers add `ANTHROPIC_MODEL` to the env
// they hand to `child_process.spawn`.
//
// Resolution order for the do-er agent on a story:
//   1. story.modelOverride — set per-dispatch when one specific story
//      needs a beefier model than the agent default (e.g. the QA agent
//      has bounced the story multiple times).
//   2. agent.model — set per-agent on the Agents page when an entire
//      class of work consistently fails on the default.
//   3. null — let the claude CLI pick its default.
//
// QA / classifier / other "support" agents resolve via their own agent
// name (`reviewer`, `classifier`, …) and intentionally do NOT inherit
// `story.modelOverride`, because the override is about boosting the
// do-er, not the verifier.

export async function resolveModelForAgent(
  db: OrcaDb,
  agentName: AgentName,
): Promise<string | null> {
  const [agent] = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.name, agentName))
    .orderBy(desc(schema.agents.version))
    .limit(1);
  return agent?.model ?? null;
}

/**
 * Returns both the fast model (cheap-first) and the strong model
 * (escalation target) for an agent. The QA agent uses this to
 * implement a two-stage gate: try `fast` first, escalate to `strong`
 * if the fast model is uncertain.
 *
 * `fast` is null when no fast model is configured — in that case the
 * caller should skip the cheap pass and go straight to `strong`.
 */
export async function resolveModelTierForAgent(
  db: OrcaDb,
  agentName: AgentName,
): Promise<{ fast: string | null; strong: string | null }> {
  const [agent] = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.name, agentName))
    .orderBy(desc(schema.agents.version))
    .limit(1);
  return {
    fast: agent?.fastModel ?? null,
    strong: agent?.model ?? null,
  };
}

export async function resolveModelForStory(
  db: OrcaDb,
  storyId: string,
): Promise<string | null> {
  const [story] = await db
    .select()
    .from(schema.stories)
    .where(eq(schema.stories.id, storyId));
  if (!story) return null;
  if (story.modelOverride) return story.modelOverride;
  if (!story.agent) return null;
  return resolveModelForAgent(db, story.agent as AgentName);
}
