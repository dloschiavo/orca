// The imperative artifact produced during Refinement.
// Replaces paperclip's "figure out the task" open-ended prompt.
// Implementor dispatches receive this as their primary input alongside Working Memory.

export type CertaintyLevel = "high" | "medium" | "low";

export interface ImperativeStep {
  id: string;
  body: string; // "Do exactly X against file A."
}

export interface TargetFile {
  path: string;
  reason: string;
}

export interface StepCertainty {
  stepId: string;
  level: CertaintyLevel;
  // Free-form explanations shown on hover. Examples:
  // - "Scrum Master assumed the new section goes at the end of the file."
  // - "Correlated prior bad-spec finding on src/auth/middleware.ts."
  // - "Target files intersect unaudited audit row: error-handling."
  // - "forbidden_changes is empty for a wide target_files."
  reasons: string[];
}

export interface AcceptanceCheck {
  id: string;
  description: string; // "The new section renders with props X and Y"
  automatedCheck: string | null; // optional command or code-qa rule id
  status: "pending" | "passed" | "failed";
}

export type AcceptanceReferenceKind =
  | "recipe"
  | "rider"
  | "audit-row"
  | "prior-story";

export interface AcceptanceReference {
  kind: AcceptanceReferenceKind;
  path: string;
}

export interface AcceptanceCard {
  id: string;
  storyId: string;
  version: number; // cards are versioned; history retained
  producedByScrumMasterRunId: string;
  imperativeSteps: ImperativeStep[];
  targetFiles: TargetFile[];
  forbiddenChanges: string[]; // "Do not touch the auth middleware." "Do not add dependencies."
  acceptanceChecks: AcceptanceCheck[];
  references: AcceptanceReference[];
  escalationRule: string; // "If a step requires touching a file outside target_files, stop and report — do not proceed."
  // Certainty — feeds the Implementation Certainty Heatbar (see spec §Feedback Loop).
  stepCertainties: StepCertainty[];
  overallCertainty: CertaintyLevel;
  scrumMasterAssumptions: string[];
  scrumMasterUnaskedQuestions: string[];
  createdAt: string;
}
