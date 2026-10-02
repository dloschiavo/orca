// PRD = a *.md spec doc discovered in a project repo. The file on disk is the
// source of truth for content, questions (the ❓ / --- Q## --- blocks), and the
// [IMP] / [ICEBOX] line-item markers. The `prds` DB row holds only orca-side
// state: ignore status, dispatch tracking, and the debounce hashes the
// heartbeat uses to decide when the drafter should run.

export interface Prd {
  id: string;
  projectId: string;
  /** Path relative to the project repo root, e.g. "docs/billing-prd.md". */
  relPath: string;
  title: string;
  // Debounce bookkeeping. Each tick recomputes the file hash: if it changed,
  // lastSeenHash/lastChangeAt are bumped and we wait. Once settled
  // (hash == lastSeenHash) AND hash != lastProcessedHash AND it's been stable
  // >= 120s, the drafter is dispatched. lastProcessedHash is stamped after.
  lastSeenHash: string | null;
  lastChangeAt: string | null;
  lastProcessedHash: string | null;
  lastProcessedAt: string | null;
  ignoredAt: string | null;
  dispatchPid: number | null;
  dispatchedAt: string | null;
  dispatchFailCount: number;
  claudeSessionId: string | null;
  claudeSessionSystemPromptHash: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * List-row shape: a `prds` row merged with counts parsed from the file on disk.
 * Returned by `GET /api/prds`. Counts are derived per request (files are small,
 * local) — never cached on the row.
 */
export interface PrdSummary {
  id: string;
  projectId: string;
  relPath: string;
  title: string;
  /** File mtime, ISO-8601. Null if the file no longer exists on disk. */
  lastModified: string | null;
  outstandingBullets: number;
  outstandingQuestions: number;
  readyItems: number;
  /** Checked-off line-items (`- [x]`). */
  doneItems: number;
  /** All line-items, checked + unchecked. The completion-bar denominator. */
  totalItems: number;
  iceboxed: boolean;
  completed: boolean;
  ignored: boolean;
  /** True when the file is gone but the row lingers (will be reconciled away). */
  missing: boolean;
  dispatchPid: number | null;
  dispatchedAt: string | null;
  /** Agent currently dispatching on this PRD (drafter / full-stack-engineer), else null. */
  activeAgent: string | null;
}
