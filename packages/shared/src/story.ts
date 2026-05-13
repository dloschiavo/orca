export type StoryStatus =
  | "icebox"
  | "planning"
  | "backlog"
  | "implementing"
  | "qa"
  | "review"
  | "blocked"
  | "done"
  | "canceled";

export type HeartbeatPolicy = "coalesce_if_active" | "skip_missed";

export interface Story {
  id: string;
  projectId: string;
  title: string;
  specMd: string;
  status: StoryStatus;
  agent: string | null;
  agentOverride: string | null;
  agentOverrideReason: string | null;
  parentStoryId: string | null;
  labels: string[];
  priority: number;
  createdAt: string;
  updatedAt: string;
  dispatchedAt: string | null;
  completedAt: string | null;
  currentDispatchId: string | null;
  currentAcceptanceCardId: string | null;
  blockedReason: string | null;
  dispatchPid: number | null;
  dispatchFailCount: number;
  heartbeatEnabled: boolean;
  heartbeatIntervalMs: number | null;
  nextTickAt: string | null;
  heartbeatPolicy: HeartbeatPolicy;
  workingMemoryId: string | null;
  totalCostUsd: number | null;
  totalTokensUsed: number | null;
  claudeSessionId: string | null;
  lastActivityAt: string | null;
  // True iff this story has at least one open refinement question whose
  // blocksDispatch=true. Server-decorated on the list endpoint so the UI
  // can pulse the status dot without a per-row round-trip.
  hasOpenBlockingQuestion?: boolean;
}
