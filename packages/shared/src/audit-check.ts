// Audit = a standing standards-check (starter: the frontend directive) that runs
// on a schedule against a project repo. Its prompt lives as a flat file at
// <repo>/prompts/audits/<slug>.md (git-versioned, edited in the pane). Each run
// emits findings: `question` (needs user input → routed into a PRD) and `fail`
// (auto-fixable → full-stack-engineer fixes it).
//
// NOTE: distinct from the prior `implementation_audit` concept (the recipe-gap
// matrix). Different tables, different route, different agents.

export type AuditScheduleKind = "manual" | "daily" | "weekly";
export type AuditFindingKind = "question" | "fail";
export type AuditFindingStatus = "open" | "answered" | "resolved" | "obsolete";

export interface AuditCheck {
  id: string;
  projectId: string;
  /** Stable id; also the prompt filename: prompts/audits/<slug>.md. */
  slug: string;
  name: string;
  scheduleKind: AuditScheduleKind;
  /** "HH:MM" 24h local time. Null for manual. */
  scheduleTime: string | null;
  /** Days-of-week (0=Sun..6=Sat) for weekly schedules. */
  scheduleDays: number[];
  lastRunAt: string | null;
  nextRunAt: string | null;
  dispatchPid: number | null;
  dispatchedAt: string | null;
  dispatchFailCount: number;
  claudeSessionId: string | null;
  claudeSessionSystemPromptHash: string | null;
  createdAt: string;
  updatedAt: string;
}

/** List-row shape: an AuditCheck merged with open-finding counts. */
export interface AuditCheckSummary extends AuditCheck {
  openQuestions: number;
  openFails: number;
  /** Agent currently dispatching on this audit (audit-runner / full-stack-engineer), else null. */
  activeAgent: string | null;
}

export interface AuditFinding {
  id: string;
  auditCheckId: string;
  kind: AuditFindingKind;
  status: AuditFindingStatus;
  title: string;
  detail: string;
  proposedFix: string | null;
  answer: string | null;
  answeredAt: string | null;
  /** When a `question` is answered, which PRD the answer should be folded into. */
  targetPrdRelPath: string | null;
  createdAt: string;
  updatedAt: string;
}
