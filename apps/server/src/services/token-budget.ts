import { eq, sql } from "drizzle-orm";
import { schema } from "@orca/db";
import type { OrcaDb } from "@orca/db";

// Per-story token budget enforcement.
//
// The dispatch loop calls `checkStoryTokenBudget` before any LLM
// invocation (do-er, QA, classifier). If the story has already
// burned more tokens than the configured budget, the dispatch is
// hard-stopped: a `tooling-gap` finding is filed pointing at the
// loop, and the caller bails out.
//
// Why a budget instead of a retry cap: retry caps catch a runaway
// QA loop, but they don't catch a do-er that quietly cooks 800k
// tokens on a single attempt by reading the entire repo. The budget
// catches both, and it's the only mechanism that keeps a single
// stuck story from monopolizing the day's spend.
//
// The budget value lives in `orca_settings` under the key
// `token_budget_per_story`. Setting it to 0 or unsetting the key
// disables the gate entirely (default for now — opt-in until users
// have a feel for what their normal stories cost). The cost endpoint
// is the canonical place to look up "what's normal".

const BUDGET_KEY = "token_budget_per_story";

export async function getStoryTokenBudget(db: OrcaDb): Promise<number> {
  try {
    const [row] = await db
      .select()
      .from(schema.orcaSettings)
      .where(eq(schema.orcaSettings.key, BUDGET_KEY));
    if (!row) return 0;
    const n = Number(row.value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export async function setStoryTokenBudget(
  db: OrcaDb,
  value: number,
): Promise<void> {
  await db
    .insert(schema.orcaSettings)
    .values({ key: BUDGET_KEY, value: String(value) })
    .onConflictDoUpdate({
      target: schema.orcaSettings.key,
      set: { value: String(value), updatedAt: new Date() },
    });
}

export interface BudgetCheckResult {
  exceeded: boolean;
  budget: number;
  spent: number;
}

/**
 * Sums the story's recorded token usage across every agent (do-er,
 * QA, classifier) and compares against the configured budget.
 * `exceeded === true` means the next LLM call should be skipped and
 * the caller should bail out of the dispatch loop. `budget === 0`
 * disables the gate (the helper still returns the spend so callers
 * can log it).
 */
export async function checkStoryTokenBudget(
  db: OrcaDb,
  storyId: string,
): Promise<BudgetCheckResult> {
  const budget = await getStoryTokenBudget(db);
  const [row] = await db
    .select({
      total: sql<number>`COALESCE(SUM(${schema.tokenHeatmaps.totalIn} + ${schema.tokenHeatmaps.totalOut}), 0)`,
    })
    .from(schema.tokenHeatmaps)
    .where(eq(schema.tokenHeatmaps.storyId, storyId));
  const spent = Number(row?.total ?? 0);
  if (budget === 0) return { exceeded: false, budget, spent };
  return { exceeded: spent >= budget, budget, spent };
}

/**
 * Convenience wrapper that, if the budget is exceeded, files a
 * tooling-gap finding pointing at the dispatch loop. Used by the
 * dispatcher and the agent runners so the over-budget event is
 * always recorded — without it, the only signal a human gets is
 * "the story stopped progressing", which is the wrong shape of
 * alert.
 */
export async function enforceStoryTokenBudget(
  db: OrcaDb,
  storyId: string,
): Promise<BudgetCheckResult> {
  const result = await checkStoryTokenBudget(db, storyId);
  if (!result.exceeded) return result;

  return result;
}
