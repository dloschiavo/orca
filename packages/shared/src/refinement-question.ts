// Refinement Q&A Inbox backing type.
//
// The metavine principle: a resource (free agent slot) is never idle waiting on a human,
// and the human is never idle waiting on a resource. All of the human's thinking about a
// story — every Scrum Master assumption, every unasked question — is extracted
// asynchronously ahead of time, while the story is still in the queue. When a resource
// arrives, either the thinking is done or the story is skipped for one where it is.

export type RefinementQuestionSource =
  | "spec-writer"
  | "scrum-master"
  | "classifier"
  | "reviewer"
  | "prior-finding-correlation";

export type RefinementQuestionStatus = "open" | "answered" | "obsolete";

export interface RefinementQuestionPriorityFactors {
  // Higher when story is closer to dispatch.
  // in_progress > to_do > refinement > blocked
  closenessToDispatch: number;
  // How much answering this would lift the Card's overall_certainty (0..1).
  certaintyDelta: number;
  // If true, a dispatch cannot select this story until the question is answered.
  blocksDispatch: boolean;
  // Gentle staleness bump so nothing rots in the queue.
  ageMs: number;
}

export interface RefinementQuestion {
  id: string;
  storyId: string;
  acceptanceCardId: string | null; // the card version this question was raised against; null for spec-writer-sourced rows
  stepId: string | null; // optional: which step the uncertainty is on
  source: RefinementQuestionSource;
  question: string; // "Should the new button replace the old one or sit alongside it?"
  context: string; // <= 300 chars: why it's being asked, what the assumption would otherwise be
  status: RefinementQuestionStatus;
  answer: string | null;
  answeredAt: string | null;
  // Priority is recomputed continuously from the factors below.
  priority: number;
  priorityFactors: RefinementQuestionPriorityFactors;
  blocksDispatch: boolean; // denormalized from priorityFactors for cheap indexing
  createdAt: string;
  updatedAt: string;
}

export const REFINEMENT_QUESTION_BOUNDS = {
  questionMaxChars: 400,
  contextMaxChars: 300,
  answerMaxChars: 2000,
} as const;
