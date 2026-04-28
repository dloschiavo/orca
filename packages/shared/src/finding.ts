// The feedback loop's core data type.
//
// CORE INVARIANT: the automated classifier is forbidden from shipping
// `agent-failure` or `agent-false-completion` as a verdict. Those are
// human-only root causes — they exist precisely because they have no
// upstream fix, and routing the classifier there would let the system
// silently shrug at agent unreliability instead of fixing the upstream
// gap. The classifier MUST always propose one of:
//   (a) pipeline-failure — spec was correct, plumbing dropped something
//   (b) a human-foresight gap — bad-spec / missing-context / missing-constraint / missing-audit-row
//   (c) tooling-gap — process gap that a new tool/check can close
// A human reviewer is the only actor that can land a finding at
// `agent-failure` or `agent-false-completion`. The count of these
// findings is the canonical signal for whether the agent can be trusted
// for a given class of work.

export type FindingSource =
  | "human"
  | "code-qa"
  | "auditor"
  | "agent-self"
  | "scrum-master";

export type FindingRootCause =
  // PIPELINE FAILURES — spec was correct, plumbing dropped it; fix the pipeline.
  | "pipeline-failure"
  // HUMAN-FORESIGHT GAPS — spec was incomplete; only fixable by surfacing uncertainty earlier.
  | "bad-spec"
  | "missing-context"
  | "missing-constraint"
  | "missing-audit-row"
  // PROCESS GAPS — a new check/tool/gate could close this.
  | "tooling-gap"
  // AGENT-RELIABILITY (HUMAN-ASSIGNED ONLY — classifier may NOT propose).
  // `agent-failure`: agent misread the instruction and did the wrong thing.
  //   Defense-in-depth (clearer riders, inline invariants, checklists) can
  //   partially compensate. Comprehension/judgment failure.
  // `agent-false-completion`: agent claimed work done that was not done.
  //   No defense-in-depth fixes this — the only mitigations are external
  //   verification (the QA agent gate) and not using the agent for that
  //   class of work. Worst class of failure orca measures.
  | "agent-failure"
  | "agent-false-completion"
  // OTHER
  | "user-error"
  | "unknown"; // classifier could not identify an upstream cause — escalates

export type FindingScope = "project-local" | "cross-project";

export type FindingDestinationKind =
  | "acceptance-card" // rewrite the card; story returns to Refinement
  | "recipe-body" // upstream recipe needs a clarification (cross-project only)
  | "recipe-antipattern" // upstream recipe needs a "don't do this" section (cross-project only)
  | "project-rider" // project-local rule or invariant
  | "agent-prompt" // the agent's prompt needs an addendum
  | "agent-model" // the agent needs to be bumped to a more capable model
  | "implementation-audit" // log a new/existing pipeline thread as reviewed
  | "backlog" // new Story (e.g. tooling-gap becomes a tooling Story)
  | "dismissed"; // user-error, retained for analytics

export interface FindingDestination {
  kind: FindingDestinationKind;
  path: string | null; // e.g., _recipes/admin-prompt-queue/SKILL.md#anti-patterns
  auditRowId: string | null; // when kind == "implementation-audit"
}

export interface FindingCitation {
  file: string;
  line: number | null;
}

export type FindingStatus = "pending" | "triaged" | "applied" | "dismissed";

export interface Finding {
  id: string;
  storyId: string;
  source: FindingSource;
  body: string;
  citation: FindingCitation | null;
  rootCause: FindingRootCause;
  scope: FindingScope;
  destination: FindingDestination;
  status: FindingStatus;
  createdAt: string;
  appliedAt: string | null;
  appliedCommit: string | null; // git SHA of the write-back
}

// Classifier proposal — separate table so the classifier's reasoning is auditable.
export interface Classification {
  id: string;
  findingId: string;
  classifierVersion: string;
  proposedRootCause: FindingRootCause;
  proposedScope: FindingScope;
  proposedDestination: FindingDestination;
  reasoning: string;
  confidence: number; // 0..1
  createdAt: string;
}

// True IFF the finding's root cause represents a human-foresight gap.
// Used by the UI to bias sorting and banner rendering.
export function isHumanForesightGap(rootCause: FindingRootCause): boolean {
  return (
    rootCause === "bad-spec" ||
    rootCause === "missing-context" ||
    rootCause === "missing-constraint" ||
    rootCause === "missing-audit-row"
  );
}

// True IFF the finding represents agent unreliability (comprehension or
// false-completion). These root causes can ONLY be assigned by a human;
// the classifier is forbidden from proposing them. The accumulating count
// of these findings is the canonical signal that the agent cannot be
// trusted for the affected class of work — defense-in-depth (rider edits,
// inline invariants, deliverables checklists) does not fix them.
export function isAgentReliabilityFailure(
  rootCause: FindingRootCause,
): boolean {
  return rootCause === "agent-failure" || rootCause === "agent-false-completion";
}

// Destinations the classifier may auto-apply without human confirmation.
// Restricted to text-only appends to rider/recipe/agent files. Code
// edits, schema changes, and user-visible state changes still require a
// human click. The auto-apply commits are tagged `[orca auto-apply finding
// <id>]` so they're trivially revertable as a group.
export function isAutoApplyableDestination(
  kind: FindingDestinationKind,
): boolean {
  return (
    kind === "project-rider" ||
    kind === "recipe-body" ||
    kind === "recipe-antipattern" ||
    kind === "agent-prompt" ||
    kind === "agent-model"
  );
}
