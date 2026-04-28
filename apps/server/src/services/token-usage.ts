import { schema } from "@orca/db";
import type { OrcaDb } from "@orca/db";

// One-stop helper for writing a row into `token_heatmaps`. Every LLM
// invocation that orca makes (do-er, QA, classifier, future agents)
// should call this so the cost endpoint can break spend down by agent
// and by retry attempt.
//
// We deliberately do NOT shove these inserts into a single `dispatches`
// row — QA and classifier run out-of-band, without a dispatch lifecycle.
// `dispatch_id` is therefore nullable on token_heatmaps. The
// `(story_id, agent)` index keeps the cost endpoint cheap.

export type TokenAgent = "do-er" | "qa" | "classifier";

export interface RecordTokenUsageArgs {
  db: OrcaDb;
  storyId: string;
  agent: TokenAgent;
  attempt: number;
  // Token counts as reported by the model. Pre-broken-down by source
  // (uncached / cache_read / cache_creation) so the cost endpoint can
  // tell whether prompt caching is actually doing anything.
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  // Number of LLM calls aggregated into this row. Usually 1; the do-er
  // result event covers a whole multi-turn run, so it can be > 1 there.
  calls?: number;
  // Bytes of prompt we shipped to the model. Lets us spot the case
  // where token counts went down but the prompt got bigger (= caching
  // is hiding a problem).
  promptBytesSent?: number;
  dispatchId?: string | null;
}

export async function recordTokenUsage(args: RecordTokenUsageArgs): Promise<void> {
  const totalIn =
    args.inputTokens + args.cacheReadTokens + args.cacheCreationTokens;
  try {
    await args.db.insert(schema.tokenHeatmaps).values({
      storyId: args.storyId,
      dispatchId: args.dispatchId ?? null,
      agent: args.agent,
      attempt: args.attempt,
      calls: args.calls ?? 1,
      totalIn,
      totalOut: args.outputTokens,
      totalCached: args.cacheReadTokens,
      totalCacheCreation: args.cacheCreationTokens,
      totalUncached: args.inputTokens,
      promptBytesSent: args.promptBytesSent ?? 0,
    });
  } catch (err) {
    // Never let instrumentation kill the dispatch path. Log and move on.
    console.error("[orca] recordTokenUsage failed:", err);
  }
}

// Pulled out so QA / classifier can share the same parser. The
// `claude -p --output-format json` wrapper has shifted shape across CLI
// versions; this collapses every variant into the four numbers we care
// about. All callers should funnel through this — keeping it in one
// place means a CLI upgrade is one edit, not four.
export interface ClaudeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export function extractUsageFromCliWrapper(stdout: string): ClaudeUsage {
  const empty: ClaudeUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  let wrap: unknown;
  try {
    wrap = JSON.parse(stdout.trim());
  } catch {
    return empty;
  }
  if (!wrap || typeof wrap !== "object") return empty;
  const w = wrap as Record<string, unknown>;

  // Shape A: { usage: { input_tokens, output_tokens, ... } }
  const usage =
    w.usage && typeof w.usage === "object"
      ? (w.usage as Record<string, unknown>)
      : null;
  if (usage) {
    return {
      inputTokens:
        typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
      outputTokens:
        typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
      cacheReadTokens:
        typeof usage.cache_read_input_tokens === "number"
          ? usage.cache_read_input_tokens
          : 0,
      cacheCreationTokens:
        typeof usage.cache_creation_input_tokens === "number"
          ? usage.cache_creation_input_tokens
          : 0,
    };
  }

  // Shape B: { modelUsage: { "model-id": { inputTokens, ... } } }
  const modelUsage =
    w.modelUsage && typeof w.modelUsage === "object"
      ? (w.modelUsage as Record<string, Record<string, unknown>>)
      : null;
  if (modelUsage) {
    let i = 0,
      o = 0,
      cr = 0,
      cc = 0;
    for (const m of Object.values(modelUsage)) {
      if (m && typeof m === "object") {
        i += typeof m.inputTokens === "number" ? m.inputTokens : 0;
        o += typeof m.outputTokens === "number" ? m.outputTokens : 0;
        cr +=
          typeof m.cacheReadInputTokens === "number"
            ? m.cacheReadInputTokens
            : 0;
        cc +=
          typeof m.cacheCreationInputTokens === "number"
            ? m.cacheCreationInputTokens
            : 0;
      }
    }
    return {
      inputTokens: i,
      outputTokens: o,
      cacheReadTokens: cr,
      cacheCreationTokens: cc,
    };
  }

  // Shape C: legacy top-level total_input_tokens / total_output_tokens.
  return {
    inputTokens:
      typeof w.total_input_tokens === "number" ? w.total_input_tokens : 0,
    outputTokens:
      typeof w.total_output_tokens === "number" ? w.total_output_tokens : 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

/**
 * Extract the actual model name(s) from the `--output-format json` wrapper.
 * The CLI embeds a `model` field or `modelUsage` map (keyed by model ID)
 * in the wrapper. We return the first (usually only) model ID so callers
 * can log what the CLI *actually* used, not just what was requested.
 *
 * For `--output-format stream-json`, callers should use
 * `extractModelFromStreamResult` on the `type: "result"` event instead.
 */
export function extractModelFromCliWrapper(stdout: string): string | null {
  let wrap: unknown;
  try {
    wrap = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!wrap || typeof wrap !== "object") return null;
  const w = wrap as Record<string, unknown>;

  // Direct `model` field (newer CLI versions).
  if (typeof w.model === "string" && w.model) return w.model;

  // `modelUsage` map: keys are model IDs.
  if (w.modelUsage && typeof w.modelUsage === "object") {
    const keys = Object.keys(w.modelUsage as Record<string, unknown>);
    if (keys.length > 0) return keys.join(", ");
  }

  return null;
}

/**
 * Extract the actual model name(s) from a `type: "result"` event in the
 * `--output-format stream-json` output. The result event contains a
 * `modelUsage` map keyed by model ID.
 */
export function extractModelFromStreamResult(
  msg: Record<string, unknown>,
): string | null {
  // Direct `model` field.
  if (typeof msg.model === "string" && msg.model) return msg.model;

  // `modelUsage` map: keys are model IDs.
  if (msg.modelUsage && typeof msg.modelUsage === "object") {
    const keys = Object.keys(msg.modelUsage as Record<string, unknown>);
    if (keys.length > 0) return keys.join(", ");
  }

  return null;
}
