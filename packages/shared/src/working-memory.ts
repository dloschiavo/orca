// Compact, structured, deterministically-written ledger that persists across
// dispatches and heartbeats. Written ONLY by the Compactor; read by everyone.
// Bounded by contract so it can never balloon into a chain-of-thought scratchpad.

export type ProgressOutcome =
  | "advanced"
  | "blocked"
  | "reverted"
  | "verified";

export interface ProgressEntry {
  at: string;
  dispatchId: string;
  summary: string; // 1-line: "step 2 passed; step 3 blocked on missing type export"
  outcome: ProgressOutcome;
}

export interface KeyFile {
  path: string;
  why: string;
}

export interface StoryWorkingMemory {
  id: string;
  storyId: string;
  version: number; // optimistic locking; bumped every write
  // All fields are bounded. Each is rewritten (not appended) by the compaction call.
  currentHypothesis: string; // <= 500 chars
  approach: string; // <= 1000 chars
  progressLedger: ProgressEntry[]; // capped; oldest drop off
  openQuestions: string[]; // surfaced to user; non-empty can trigger Blocked
  deadEnds: string[]; // approaches ruled out with reason — prevents retrying
  keyFiles: KeyFile[];
  invariantsDiscovered: string[];
  lastUpdatedAt: string;
  lastUpdatedByDispatchId: string | null;
  resetCount: number; // high count is a signal the spec is drifting
}

// Field size bounds — enforced by the Compactor's schema validator.
export const WORKING_MEMORY_BOUNDS = {
  currentHypothesisMaxChars: 500,
  approachMaxChars: 1000,
  progressLedgerMaxEntries: 20,
  openQuestionsMaxEntries: 10,
  deadEndsMaxEntries: 10,
  keyFilesMaxEntries: 15,
  invariantsDiscoveredMaxEntries: 20,
} as const;
