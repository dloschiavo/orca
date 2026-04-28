// StoryAdapter — the swappable execution backend interface.
//
// Borrowed in shape from paperclip's `ServerAdapterModule` (type discriminator
// + execute(ctx) → result) but with a CLOSED, TYPED context object, not the
// `context: Record<string, unknown>` blob that caused paperclip's context-
// management problems. Adding a new kind of input requires adding a new named
// field and auditing all callers — the adapter can't silently accept more than
// it was designed for.
//
// We also explicitly DO NOT model session resumption. Every dispatch is cold.
// Working Memory is what makes cold dispatches cheap.

import type {
  AcceptanceCard,
  StoryWorkingMemory,
  Turn,
  DispatchVerdict,
  UsageSummary,
} from "@orca/shared";

export interface StoryAdapterContext {
  dispatchId: string;
  storyId: string;
  cwd: string; // git worktree path

  // --- closed, typed, bounded inputs (NOT a JSONB blob) ---
  acceptanceCard: AcceptanceCard; // frozen at dispatch start
  workingMemory: StoryWorkingMemory; // frozen at dispatch start
  diffSinceLastTick: string; // unified diff, bounded
  targetFiles: string[]; // derived from acceptanceCard.targetFiles
  forbiddenChanges: string[];
  stepId: string; // which imperative step to execute
  agentsMd: string; // agent prompt, resolved at dispatch start
  toolAllowlist: string[];
  skillRefs: string[];

  // --- live callbacks (kept verbatim from paperclip — these are good) ---
  onLog(stream: "stdout" | "stderr", chunk: string): Promise<void>;
  onMeta(meta: {
    command: string;
    args: string[];
    env: Record<string, string>;
  }): Promise<void>;
  onSpawn(meta: { pid: number; startedAt: string }): Promise<void>;
  // NEW — feeds the token heatmap.
  onTurn(turn: Turn): Promise<void>;
}

export interface StoryAdapterResult {
  exitCode: number | null;
  timedOut: boolean;
  diff: string;
  filesTouched: string[];
  verdict: DispatchVerdict;
  escalationReason: string | null;
  tokenUsage: UsageSummary;
  // NO sessionParams / clearSession — we do not model session resumption.
}

export interface AdapterEnvironmentCheck {
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface AdapterModelInfo {
  id: string;
  label: string;
}

export interface StoryAdapter {
  /** Discriminator — unique across all registered adapters. */
  type: string;

  /** Human-readable name for UI. */
  label: string;

  /** Whether this adapter is allowed to modify code. `false` for narrow helpers. */
  isCodeModifying: boolean;

  /** Execute a single imperative step against a frozen context. */
  execute(ctx: StoryAdapterContext): Promise<StoryAdapterResult>;

  /** Runs on project setup / dashboard. */
  testEnvironment(): Promise<AdapterEnvironmentCheck>;

  /** Optional — populate a model picker. */
  listModels?(): Promise<AdapterModelInfo[]>;
}
