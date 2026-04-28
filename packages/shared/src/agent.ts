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

