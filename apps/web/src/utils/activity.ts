import type { ActivityEvent } from "../api.js";
import { formatBytes, formatTokens } from "./formatters.js";

export interface StreamBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  is_error?: boolean;
}

export function shortenHome(p: string): string {
  return p.replace(/\/Users\/[^/]+/g, "~");
}

export function extractContent(p: Record<string, unknown>): StreamBlock[] {
  const msg = p.message as Record<string, unknown> | undefined;
  const content = msg?.content;
  if (!Array.isArray(content)) return [];
  return content as StreamBlock[];
}

export function summarizeToolInput(input: Record<string, unknown> | undefined, full = false): string {
  if (!input) return "";
  const p = input.file_path ?? input.path ?? input.pattern ?? input.command;
  if (typeof p === "string") {
    const short = shortenHome(p);
    return !full && short.length > 80 ? "…" + short.slice(-80) : short;
  }
  return "";
}

/**
 * Decide whether a tool_use content block is "noisy housekeeping"
 * that should be hidden from the activity feed.
 */
export function isHideableToolUse(
  name: string,
  input: Record<string, unknown> | undefined,
  workspace: string | undefined,
): boolean {
  if (name === "Agent") return true;
  if (!input) return false;

  const searchPath = (input.path ?? input.file_path ?? "") as string;
  const pattern = (input.pattern ?? "") as string;
  const command = (input.command ?? "") as string;

  if (name === "Glob" || name === "Grep") {
    if (workspace && searchPath.startsWith(workspace)) return true;
    if (!searchPath || !searchPath.startsWith("/")) return true;
    if (workspace && pattern.startsWith(workspace)) return true;
    return false;
  }

  if (name === "Bash" && command) {
    const trimCmd = command.trimStart();
    if (workspace && trimCmd.startsWith(`ls -la ${workspace}`)) return true;
    const baseCmd = trimCmd.split(/\s/)[0] ?? "";
    if (/^(ls|grep|find)$/.test(baseCmd)) {
      if (workspace && trimCmd.includes(workspace)) return true;
      const beforePipe = trimCmd.split(/\s*[|]\s*/)[0] ?? "";
      if (!/\s\/\S/.test(beforePipe)) return true;
    }
  }

  return false;
}

function sumUsageTokens(usage: unknown): number {
  if (!usage || typeof usage !== "object") return 0;
  const u = usage as Record<string, unknown>;
  const inTok = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const outTok = typeof u.output_tokens === "number" ? u.output_tokens : 0;
  const crTok =
    typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0;
  const ccTok =
    typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0;
  return inTok + outTok + crTok + ccTok;
}

export function renderStreamEvent(p: Record<string, unknown>, full = false): string {
  const type = p.type as string | undefined;
  if (type === "system") {
    return `system: ${(p.subtype as string) ?? "event"}`;
  }
  if (type === "assistant") {
    const content = extractContent(p);
    const parts: string[] = [];
    for (const c of content) {
      if (c.type === "text" && typeof c.text === "string") {
        const text = full ? c.text.trim() : c.text.trim().replace(/\s+/g, " ");
        if (text) parts.push(!full && text.length > 160 ? text.slice(0, 160) + "…" : text);
      } else if (c.type === "tool_use") {
        const name = c.name ?? "tool";
        const target = summarizeToolInput(c.input, full);
        parts.push(`→ ${name}${target ? ` ${target}` : ""}`);
      }
    }
    const msg = p.message as Record<string, unknown> | undefined;
    const tokenTotal = sumUsageTokens(msg?.usage);
    const body = parts.join(" · ") || "assistant";
    return tokenTotal > 0 ? `${body} · ${formatTokens(tokenTotal)}` : body;
  }
  if (type === "user") {
    const content = extractContent(p);
    for (const c of content) {
      if (c.type === "tool_result") {
        if (c.is_error) return full ? JSON.stringify(p, null, 2) : JSON.stringify(p);
        return "tool result: ok";
      }
    }
    return "user";
  }
  if (type === "result") {
    const cost = p.total_cost_usd;
    const tokenTotal = sumUsageTokens(p.usage);
    return `result: ${(p.subtype as string) ?? "?"}${
      typeof cost === "number" ? ` · $${cost.toFixed(4)}` : ""
    }${tokenTotal > 0 ? ` · ${formatTokens(tokenTotal)}` : ""}`;
  }
  if (type === "rate_limit_event") {
    return full ? JSON.stringify(p, null, 2) : JSON.stringify(p);
  }
  return type ?? JSON.stringify(p).slice(0, 160);
}

export function renderEvent(e: ActivityEvent, full = false): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  switch (e.kind) {
    case "story_created":
      return `created "${(p.title as string) ?? ""}"`;
    case "state_transition":
      return `→ ${(p.status as string) ?? "?"}`;
    case "dispatch_started": {
      const agentName = (p.agent ?? p.archetype) as string | undefined;
      const model = p.model as string | undefined;
      const base = `spawning ${(p.adapter as string) ?? "agent"} in ${shortenHome((p.repoPath as string) ?? "?")}`;
      const meta = [agentName, model].filter(Boolean).join(" · ");
      return meta ? `${base} [${meta}]` : base;
    }
    case "agent_spawned": {
      const parts = [`pid ${p.pid ?? "?"}`];
      if (p.resumed) {
        parts.push(`resumed session ${String(p.resumedSessionId ?? "?").slice(0, 8)}`);
      } else {
        parts.push("fresh session");
      }
      // Directive fingerprints — rendered as "deliverables@a1b2c3" so a
      // content change shows up visibly in the feed between runs.
      const directives = p.directives as Record<string, string> | undefined;
      if (directives && Object.keys(directives).length > 0) {
        const pairs = Object.entries(directives).map(([n, h]) => `${n}@${h}`);
        parts.push(`directives: ${pairs.join(", ")}`);
      }
      if (p.sessionDroppedDueToSystemPromptChange) {
        parts.push("(prior session dropped: system prompt changed)");
      }
      if (p.resumeFallback) parts.push("(resume-fallback retry)");
      return parts.join(" · ");
    }
    case "agent_prompt":
    case "triage_prompt":
    case "qa_prompt":
    case "classifier_prompt":
      return (p.prompt as string) ?? "(no prompt)";
    case "agent_log":
      return `[${(p.stream as string) ?? "out"}] ${shortenHome((p.line as string) ?? "")}`;
    case "agent_error":
      return `error: ${(p.message as string) ?? "?"}`;
    case "agent_stream":
      return renderStreamEvent(p, full);
    case "dispatch_completed": {
      const parts: string[] = [];
      if (p.exitCode) parts.push(`exit ${p.exitCode}`);
      parts.push(`${p.fileCount ?? 0} files changed`);
      if (p.model) parts.push(`model: ${p.model as string}`);
      if (typeof p.totalCostUsd === "number") parts.push(`$${p.totalCostUsd.toFixed(4)}`);
      if (typeof p.totalTokensUsed === "number") parts.push(formatTokens(p.totalTokensUsed));
      // Cache-hit diagnostics. A cacheHitRatio of null means the run ended
      // before a result event fired (no usage data). A very low ratio on a
      // resumed session is the signal that --resume didn't actually reuse
      // the cached system turn — usually because the system prompt changed.
      if (typeof p.cacheHitRatio === "number") {
        const pct = Math.round(p.cacheHitRatio * 100);
        const session = p.resumed ? "resumed session" : "fresh session";
        parts.push(`${session} · cache served ${pct}%`);
      } else if (p.resumed) {
        parts.push("resumed session · cache: no usage data");
      }
      return parts.join(" · ");
    }
    case "story_edited": {
      const parts: string[] = [];
      if (p.titleTo) parts.push(`title → "${p.titleTo}"`);
      if (p.specTo !== undefined) parts.push("spec updated");
      return parts.join(", ") || "edited";
    }
    case "qa_started":
      return `→ QA started · ${p.changedFileCount ?? 0} files · ${formatBytes(p.diffBytes)}`;
    case "qa_fast_pass":
      return `→ QA fast pass (attempt ${p.attempt ?? "?"})`;
    case "qa_fast_escalated":
      return `→ QA escalated to strong model: ${(p.reason as string) ?? "?"}`;
    case "qa_completed": {
      const result = p.result as string | undefined;
      if (result === "spawn_error") return `→ QA spawn error (exit ${p.exitCode ?? "?"})`;
      const itemCount = Array.isArray(p.items) ? p.items.length : 0;
      const failCount = Array.isArray(p.failures) ? p.failures.length : 0;
      const verdict = p.pass ? "PASS" : `FAIL (${failCount} failure${failCount !== 1 ? "s" : ""})`;
      return `→ QA ${verdict} · ${itemCount} requirement${itemCount !== 1 ? "s" : ""} checked`;
    }
    case "triage_started":
      return `→ triage started: "${(p.title as string) ?? ""}"`;
    case "triage_question":
      return (p.question as string) ?? "";
    case "triage_completed": {
      const result = (p.result as string) ?? "?";
      const agentName = (p.agent ?? p.archetype) as string | undefined;
      const parts = [`→ triage: ${result}`];
      if (agentName) parts.push(`agent: ${agentName}`);
      if (p.complexity) parts.push(`complexity: ${p.complexity as string}`);
      if (p.doerModel) parts.push(`model → ${p.doerModel as string}`);
      if (result === "uncertain" && p.questionCount)
        parts.push(`${p.questionCount} question${(p.questionCount as number) > 1 ? "s" : ""}`);
      if (result === "error") parts.push(`exit ${p.exitCode ?? "?"}`);
      return parts.join(" · ");
    }
    case "qa_retry": {
      const esc = p.modelEscalation as { from: string; to: string } | undefined;
      const parts = [`→ QA retry (attempt ${p.attempt ?? "?"}/${p.cap ?? "?"})`];
      if (esc) parts.push(`model escalated: ${esc.from} → ${esc.to}`);
      return parts.join(" · ");
    }
    case "dispatch_interrupted":
      return `agent interrupted: ${(p.reason as string) ?? "unknown"}`;
    case "heartbeat_recovery": {
      const reason = p.reason === "stale" ? "stale process" : "dead pid";
      const pidStr = p.deadPid != null ? ` ${p.deadPid}` : "";
      return `recovered ${reason}${pidStr} (attempt ${p.failCount ?? "?"}/${p.maxFailCount ?? "?"})`;
    }
    default:
      return JSON.stringify(p);
  }
}

/** Parse a unified diff string and return per-file addition/deletion counts. */
export function parseDiffStats(diff: string): Map<string, { added: number; removed: number }> {
  const stats = new Map<string, { added: number; removed: number }>();
  if (!diff) return stats;
  let currentFile = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) {
      const m = line.match(/b\/(.+)$/);
      currentFile = m ? (m[1] ?? "") : "";
      if (currentFile && !stats.has(currentFile)) stats.set(currentFile, { added: 0, removed: 0 });
    } else if (currentFile) {
      if (line.startsWith("+") && !line.startsWith("+++")) stats.get(currentFile)!.added++;
      else if (line.startsWith("-") && !line.startsWith("---")) stats.get(currentFile)!.removed++;
    }
  }
  return stats;
}
