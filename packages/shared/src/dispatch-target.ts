// Cross-cutting dispatch-target identity. A claude-code CLI dispatch can run
// against a story, a PRD doc, or an audit check. activity_events and the
// generic cli-dispatch core key off this (kind, id) pair so the same spawn /
// tail / reap machinery serves all three.

export type DispatchTargetKind = "story" | "prd" | "audit";

export interface DispatchTarget {
  kind: DispatchTargetKind;
  id: string;
  projectId: string;
}

/**
 * Persistent state for an in-flight detached `claude` child, generalized
 * across target kinds so the heartbeat's orphan-adoption path can reconstruct
 * any dispatch after a Node restart. Mirrors stories' `DispatchState` but with
 * a target-agnostic `args` payload. Cleared on terminal completion.
 */
export interface CliDispatchState {
  /** Absolute path the child's stdout is redirected to. */
  stdoutPath: string;
  /** Absolute path the child's stderr is redirected to. */
  stderrPath: string;
  /** `git stash create` ref captured before the child ran (per-session diff). May be empty. */
  preDispatchRef: string;
  /** HEAD SHA before the child ran (committed-changes fallback). Null when not a git repo. */
  preDispatchHead: string | null;
  /** Marker file used by `find -newer` to detect changed files in non-git workspaces. */
  markerPath: string;
  /** mtime of the marker file at spawn time, ISO-8601. */
  markerMtime: string;
  /** Session ID we tried to `--resume` (if any) — used to detect resume failure on reap. */
  existingSessionId: string | null;
  /** Wall-clock spawn time, ISO-8601. */
  spawnedAt: string;
  /** Everything a reaper needs to reconstruct the run without re-deriving it. */
  args: {
    targetKind: DispatchTargetKind;
    targetId: string;
    projectId: string;
    cwd: string;
    agentName: string;
    trigger?: string;
    /** Target-specific opaque payload (e.g. prd relPath, audit slug + mode). */
    [k: string]: unknown;
  };
}
