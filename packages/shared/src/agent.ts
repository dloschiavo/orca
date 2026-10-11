// Agent registry types. Agents are the "type of agent best suited for a story."
// Scrum Master picks transparently; user can override.

export type AgentName =
  | "scrum-master"
  | "spec-writer"
  | "architect"
  | "frontend"
  | "backend"
  | "scraper"
  | "ui-polisher"
  | "refactorer"
  | "test-writer"
  | "reviewer"
  | "explorer"
  | "classifier"
  | "compactor"
  | "triage"
  | "auditor";

export interface Agent {
  id: string;
  name: AgentName;
  version: number;
  agentsMd: string;
  defaultToolAllowlist: string[];
  defaultSkillRefs: string[];
  description: string;
  isCodeModifying: boolean;
  model: string | null;
  fastModel: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// Shape returned by `GET /api/models` and used everywhere we render the
// list of models a user can pick from. The server populates this from
// Anthropic's `/v1/models` endpoint on a refresh loop, so we never
// hard-code the live model lineup. `AVAILABLE_MODELS_FALLBACK` is only
// used before the first refresh completes (or if it fails).
export interface AvailableModel {
  id: string;
  displayName: string;
}

export const AVAILABLE_MODELS_FALLBACK: readonly AvailableModel[] = [
  { id: "claude-opus-4-7", displayName: "Claude Opus 4.7" },
  { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5" },
] as const;

