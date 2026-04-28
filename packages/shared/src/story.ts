export type StoryStatus =
  | "icebox"
  | "backlog"
  | "in_progress"
  | "in_qa"
  | "final_review"
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
}
