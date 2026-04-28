// Implementation Audit — the PM pipeline visibility matrix.
// One row per thread of work this project should be thinking about.
// Human-driven; Scrum Master reads it as context, never as a gate.

export type AuditCluster =
  | "core-infrastructure"
  | "auth-identity"
  | "monetization-billing"
  | "observability-admin"
  | "compliance-legal"
  | "ux-content-shell"
  | "error-handling-resilience"
  | "performance"
  | "seo-content"
  | "notifications-comms"
  | "devops-deployment"
  | "saas-specific";

export type AuditRecipeType = "project" | "enhancement";

export type AuditApplicability =
  | "universal"
  | "web-only"
  | "native-only"
  | "saas-only"
  | "commerce-only";

export type AuditStatus =
  | "unaudited"
  | "implemented"
  | "partially-implemented"
  | "not-implemented"
  | "forgone"
  | "substituted";

export type AuditLastReviewedBy = "user" | "scrum-master" | "finding";

export interface AuditRow {
  id: string;
  projectId: string;
  // identity
  concernSlug: string; // e.g., "error-handling" — matches _unmigrated filename
  concernTitle: string; // human label
  cluster: AuditCluster;
  recipeType: AuditRecipeType;
  applicability: AuditApplicability;
  // decision
  status: AuditStatus;
  decisionReason: string | null; // required for forgone/substituted
  substituteRecipeSlug: string | null;
  customSubstituteNotes: string | null;
  // linkage
  linkedStoryIds: string[];
  linkedTriggerIds: string[];
  blockingStoryIds: string[];
  // recipe versioning
  recipeContentHash: string | null;
  recipeStale: boolean;
  lastAuditedAt: string | null;
  auditVerdict: string | null;
  // provenance
  lastReviewedAt: string | null;
  lastReviewedBy: AuditLastReviewedBy | null;
  appliedFromFindingId: string | null;
  createdAt: string;
  updatedAt: string;
}
