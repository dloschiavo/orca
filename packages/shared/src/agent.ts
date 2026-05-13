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
// list of models orca will let an agent dispatch on. The server scrapes
// this from the Claude Code CLI bundle (`@anthropic-ai/claude-code/cli.js`)
// on a refresh loop — that's the canonical set of ids `--model <id>` will
// accept, and it picks up new models whenever Claude Code auto-updates.
// `AVAILABLE_MODELS_FALLBACK` is only used before the first scrape
// completes (or if the CLI can't be located).
export interface AvailableModel {
  id: string;
}

export const AVAILABLE_MODELS_FALLBACK: readonly AvailableModel[] = [
  { id: "claude-opus-4-6" },
  { id: "claude-sonnet-4-6" },
  { id: "claude-haiku-4-5" },
] as const;

