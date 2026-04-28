import type { AcceptanceCard } from "./acceptance-card.js";
import type { StoryWorkingMemory } from "./working-memory.js";

export type DispatchStatus =
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "escalated";

export type DispatchTrigger =
  | "manual"
  | "heartbeat"
  | "comment"
  | "file-watch"
  | "audit-retry";

export type DispatchVerdict = "step-complete" | "escalate" | "failed";

export interface UsageSummary {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

// Per-turn telemetry unit, streamed via StoryAdapterContext.onTurn.
// Feeds the token heatmap.
export interface Turn {
  index: number;
  kind: "user" | "assistant" | "tool_use" | "tool_result";
  tokensIn: number;
  tokensOut: number;
  tool: string | null;
  targetPath: string | null; // file or command
  durationMs: number;
}

// Closed, typed dispatch snapshot — NO unbounded JSONB blobs.
// Adding a new kind of input requires adding a new named field and auditing callers.
export interface DispatchSnapshot {
  acceptanceCard: AcceptanceCard;
  workingMemory: StoryWorkingMemory;
  diffSinceLastTick: string; // unified diff, bounded
  riderSectionsReferenced: string[];
  agent: string;
  agentsMd: string;
  toolAllowlist: string[];
  skillRefs: string[];
}

export interface Dispatch {
  id: string;
  storyId: string;
  attempt: number; // 1-based, like admin-prompt-queue
  adapterType: string; // "claude-local" | "agent-sdk" | future
  trigger: DispatchTrigger;
  acceptanceCardId: string;
  stepId: string; // which imperative step this dispatch executed
  snapshot: DispatchSnapshot;
  status: DispatchStatus;
  startedAt: string | null;
  completedAt: string | null;
  // Result fields (null until completed)
  resultDiff: string | null;
  resultFilesTouched: string[] | null;
  resultVerdict: DispatchVerdict | null;
  resultTokenUsage: UsageSummary | null;
  tokenHeatmapId: string | null;
  qaReportId: string | null;
  auditorReportId: string | null;
  // NOTE: No sessionParams / sessionDisplayId field. We do not attempt
  // session resumption; every dispatch is cold.
}

export interface TokenHeatmap {
  id: string;
  dispatchId: string;
  storyId: string;
  turns: Turn[];
  fileAttribution: Record<string, number>;
  toolAttribution: Record<string, number>;
  totalIn: number;
  totalOut: number;
  totalCached: number;
  createdAt: string;
}
