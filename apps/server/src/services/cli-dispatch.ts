import { spawn } from "node:child_process";
import {
  mkdtemp,
  writeFile,
  stat,
  mkdir,
  open as fsOpen,
  readFile,
} from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { schema } from "@orca/db";
import { sanitizeForJsonb } from "./sanitize-jsonb.js";
import type { OrcaDb } from "@orca/db";
import type { DispatchTarget, CliDispatchState } from "@orca/shared";
import { ensureFreshOAuthToken, refreshClaudeOAuthToken } from "./claude-oauth.js";
import {
  countClaudeProcesses,
  getConcurrencyCap,
  recordRateLimit,
  recordUsageFraction,
  persistUsageFraction,
  extractUsageFraction,
} from "./concurrency.js";
import { extractModelFromStreamResult } from "./token-usage.js";
import { isPidAlive } from "./pid.js";
import {
  listChangedFiles,
  snapshotWorkingTree,
  captureGitDiff,
  getHeadSha,
  captureCommittedDiff,
  synthDiffForNewFiles,
} from "./dispatch-git.js";

// ─────────────────────────────────────────────────────────────────────────────
// runCliDispatch — the generic claude-code CLI dispatcher for NON-story targets
// (PRDs, audits). It reuses the exact same shared apparatus the story path
// uses — the lifecycle/PID/dedup maps (via the same globalThis keys), the OAuth
// self-heal, the concurrency/rate-limit recorders, and the git/file helpers —
// so heartbeat reap/adopt, the running animation, dedup, and rate-limit gating
// all behave identically across every target kind.
//
// The story path (routes/stories.ts `runClaudeDispatch`) is the canonical
// reference for the stream-json handling quirks (401-on-stdout, benign
// rate-limit broadcasts, SIGTERM log-scan token fallback). This module ports
// exactly those load-bearing cases. Keep the two in sync when the CLI's
// stream-json shape changes — they are version-coupled to the `claude` binary,
// not the SDK. runCliDispatch deliberately omits the story-only machinery:
// QA gate, refinement questions, acceptance cards, per-agent token_heatmaps.
// ─────────────────────────────────────────────────────────────────────────────

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

// Shared maps — SAME globalThis keys as routes/stories.ts so the heartbeat's
// PID-liveness/reap, the dedup guard, and the lifecycle ref-count are unified
// across stories AND prds AND audits. Target ids are UUIDs, unique across
// tables, so keying every map by bare id can't collide.
const _g = globalThis as typeof globalThis & {
  _orcaRunningDispatches?: Map<string, ChildProcess>;
  _orcaActiveLifecycles?: Map<string, number>;
  _orcaStreamedUuids?: Set<string>;
};
if (!_g._orcaRunningDispatches) _g._orcaRunningDispatches = new Map();
if (!(_g._orcaActiveLifecycles instanceof Map)) _g._orcaActiveLifecycles = new Map();
if (!_g._orcaStreamedUuids) _g._orcaStreamedUuids = new Set();
const runningDispatches = _g._orcaRunningDispatches;
const activeLifecycles = _g._orcaActiveLifecycles;
const streamedUuids = _g._orcaStreamedUuids;

function acquireLifecycle(id: string): void {
  activeLifecycles.set(id, (activeLifecycles.get(id) ?? 0) + 1);
}
function releaseLifecycle(id: string): void {
  const n = (activeLifecycles.get(id) ?? 0) - 1;
  if (n <= 0) activeLifecycles.delete(id);
  else activeLifecycles.set(id, n);
}

/**
 * Kill every process associated with a dispatch target (story | prd | audit),
 * checking the in-memory handle and the DB-persisted PID. Generalized twin of
 * the story-only killStoryProcesses — keyed by bare target id.
 */
export function killTargetProcesses(targetId: string, dbPid: number | null): void {
  const pidsToKill = new Set<number>();
  const child = runningDispatches.get(targetId);
  if (child) {
    if (child.pid != null) pidsToKill.add(child.pid);
    if (!child.killed) child.kill("SIGTERM");
    runningDispatches.delete(targetId);
  }
  if (dbPid != null) pidsToKill.add(dbPid);
  for (const pid of pidsToKill) {
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGTERM");
    } catch {
      // already dead — fine.
    }
  }
}

/** Build the claude-code CLI argv. Mirrors routes/stories.ts exactly — keep in sync. */
function buildClaudeArgs(opts: {
  existingSessionId: string | null;
  systemPrompt: string | null;
  maxTurns: number | null;
  prompt: string;
}): string[] {
  return [
    ...(opts.existingSessionId ? ["--resume", opts.existingSessionId] : []),
    // --append-system-prompt (NOT --system-prompt) so CLAUDE.md auto-discovery
    // still runs. Only sent on fresh sessions (resume already has it cached).
    ...(opts.systemPrompt && !opts.existingSessionId
      ? ["--append-system-prompt", opts.systemPrompt]
      : []),
    ...(opts.maxTurns != null ? ["--max-turns", String(opts.maxTurns)] : []),
    // Chrome MCP gate — default-deny the whole browser surface; opt in with
    // ORCA_ENABLE_CHROME_MCP=1 (even then, tab-lifecycle tools stay denied).
    "--disallowedTools",
    (process.env.ORCA_ENABLE_CHROME_MCP === "1"
      ? [
          "mcp__Claude_in_Chrome__tabs_close_mcp",
          "mcp__Claude_in_Chrome__tabs_create_mcp",
          "mcp__chrome-devtools__close_page",
          "mcp__chrome-devtools__new_page",
        ]
      : ["mcp__Claude_in_Chrome", "mcp__chrome-devtools"]
    ).join(","),
    "-p",
    opts.prompt,
    "--dangerously-skip-permissions",
    "--output-format",
    "stream-json",
    "--verbose",
  ];
}

export interface CliDispatchArgs {
  db: OrcaDb;
  target: DispatchTarget;
  /** Repo path (a leading ~ is expanded for spawn cwd). */
  cwd: string;
  /** Agent name — used as the activity actor and the agent_spawned label. */
  agentName: string;
  /** Fully-rendered [MAIN] prompt. Band-B prompt build is the caller's job. */
  prompt: string;
  /** Fully-rendered [SYSTEM] prompt; sent only on fresh sessions. */
  systemPrompt?: string | null;
  model?: string | null;
  maxTurns?: number | null;
  existingSessionId?: string | null;
  /** sha256 of the system prompt sent — persisted alongside the session id. */
  systemPromptHash?: string | null;
  trigger?: string;
  adoptExistingPid?: { pid: number; state: CliDispatchState };
  /** Persist pid + dispatchState on the target's own row. */
  onPidPersist: (pid: number, state: CliDispatchState) => Promise<void>;
  /** Persist the captured session id (+ system prompt hash) for --resume. */
  onSessionPersist: (sessionId: string, systemPromptHash: string | null) => Promise<void>;
  /** Clear pid/dispatchState on the target's row (terminal or adoption). */
  onClearTracking: () => Promise<void>;
}

export interface CliDispatchResult {
  exitCode: number | null;
  capturedSessionId: string | null;
  authFailureDetected: boolean;
  resumeStartFailed: boolean;
  changedFiles: string[];
  gitDiff: string | null;
  totalCostUsd: number | null;
  totalTokensUsed: number | null;
}

export async function runCliDispatch(
  args: CliDispatchArgs,
): Promise<CliDispatchResult> {
  const { db, target, agentName, prompt, adoptExistingPid, trigger } = args;
  const cwd = args.cwd.replace(/^~($|\/)/, `${homedir()}$1`);
  const systemPrompt = args.systemPrompt ?? null;
  const existingSessionId = args.existingSessionId ?? null;
  const dispatchInstanceId = randomUUID();

  acquireLifecycle(target.id);
  try {
    const logEvent = async (
      kind: string,
      payload: Record<string, unknown>,
      actor: string = agentName,
    ): Promise<void> => {
      try {
        await db.insert(schema.activityEvents).values({
          storyId: null,
          targetKind: target.kind,
          targetId: target.id,
          kind,
          actor,
          payload: sanitizeForJsonb(payload),
          dispatchInstanceId,
        });
      } catch (err) {
        console.error("[orca/cli-dispatch] failed to write activity event:", err);
      }
    };

    // Variables shared by both spawn/adoption branches and the tail loop.
    let marker: string;
    let markerMtime: Date;
    let preDispatchRef: string | null;
    let preDispatchHead: string | null;
    let stdoutPath: string;
    let stderrPath: string;
    let child: ChildProcess | null;
    let exitCodePromise: Promise<number | null> | null = null;
    let dispatchPid: number | null;

    if (!adoptExistingPid) {
      // ── Fresh spawn ────────────────────────────────────────────────────
      const scratch = await mkdtemp(join(tmpdir(), "orca-cli-dispatch-"));
      marker = join(scratch, "started");
      await writeFile(marker, "");
      markerMtime = (await stat(marker)).mtime;
      preDispatchRef = await snapshotWorkingTree(cwd);
      preDispatchHead = await getHeadSha(cwd);
      await ensureFreshOAuthToken();

      const env: NodeJS.ProcessEnv = { ...process.env };
      if (args.model) env.ANTHROPIC_MODEL = args.model;

      const claudeArgs = buildClaudeArgs({
        existingSessionId,
        systemPrompt,
        maxTurns: args.maxTurns ?? null,
        prompt,
      });

      const logDir = join(
        homedir(),
        ".orca",
        "dispatch-logs",
        `${target.kind}-${target.id}`,
        String(Date.now()),
      );
      await mkdir(logDir, { recursive: true });
      stdoutPath = join(logDir, "stdout.log");
      stderrPath = join(logDir, "stderr.log");
      const outFd = openSync(stdoutPath, "w");
      const errFd = openSync(stderrPath, "w");
      let spawned: ChildProcess;
      try {
        spawned = spawn(CLAUDE_BIN, claudeArgs, {
          cwd,
          env,
          detached: true,
          stdio: ["ignore", outFd, errFd],
        });
      } finally {
        closeSync(outFd);
        closeSync(errFd);
      }
      spawned.unref();
      child = spawned;
      dispatchPid = spawned.pid ?? null;

      exitCodePromise = new Promise<number | null>((resolve) => {
        let resolved = false;
        const finish = (code: number | null) => {
          if (resolved) return;
          resolved = true;
          resolve(code);
        };
        spawned.once("exit", (code) => finish(code));
        spawned.once("error", async (err) => {
          await logEvent("agent_error", { message: String(err) });
          finish(null);
        });
      });

      runningDispatches.set(target.id, spawned);

      const dispatchState: CliDispatchState = {
        stdoutPath,
        stderrPath,
        preDispatchRef: preDispatchRef ?? "",
        preDispatchHead: preDispatchHead ?? null,
        markerPath: marker,
        markerMtime: markerMtime.toISOString(),
        existingSessionId,
        spawnedAt: new Date().toISOString(),
        args: {
          targetKind: target.kind,
          targetId: target.id,
          projectId: target.projectId,
          cwd,
          agentName,
          ...(trigger ? { trigger } : {}),
        },
      };
      if (dispatchPid != null) await args.onPidPersist(dispatchPid, dispatchState);

      await logEvent("agent_spawned", {
        pid: dispatchPid,
        agent: agentName,
        trigger: trigger ?? "manual",
        repoPath: cwd,
        resumed: Boolean(existingSessionId),
        systemPromptSent: Boolean(systemPrompt && !existingSessionId),
      });
      await logEvent("agent_prompt", {
        prompt,
        ...(systemPrompt ? { systemPrompt } : {}),
      });
    } else {
      // ── Adoption (orphan from a previous Node process) ──────────────────
      const state = adoptExistingPid.state;
      marker = state.markerPath;
      markerMtime = new Date(state.markerMtime);
      preDispatchRef = state.preDispatchRef || null;
      preDispatchHead = state.preDispatchHead;
      stdoutPath = state.stdoutPath;
      stderrPath = state.stderrPath;
      child = null;
      dispatchPid = adoptExistingPid.pid;
      // Clear dispatchState immediately so a restart during completion can't
      // re-adopt the same dead process.
      await args.onClearTracking();
      await logEvent(
        "agent_adopted",
        {
          pid: dispatchPid,
          agent: agentName,
          trigger: trigger ?? "heartbeat-adoption",
          stdoutPath,
          stderrPath,
          spawnedAt: state.spawnedAt,
        },
        "system",
      );
    }

    // ── Tail state ────────────────────────────────────────────────────────
    let stdoutBuf = "";
    let stderrBuf = "";
    let totalCostUsd: number | null = null;
    let totalTokensUsed: number | null = null;
    let capturedSessionId: string | null = null;
    let modelUsed: string | null = null;
    let resumeStartFailed = false;
    let authFailureDetected = false;
    let cacheReadInputTokens = 0;
    let cacheCreationInputTokens = 0;
    let uncachedInputTokens = 0;

    const handleStreamJsonLine = async (line: string): Promise<void> => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: unknown;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        await logEvent("agent_log", { stream: "stdout", line: trimmed });
        return;
      }
      const m = msg as Record<string, unknown>;
      // Dedup across all concurrent tail loops (shared set, survives HMR).
      const msgUuid = m?.uuid;
      if (typeof msgUuid === "string") {
        const key = `${target.id}:${msgUuid}`;
        if (streamedUuids.has(key)) return;
        streamedUuids.add(key);
      }
      await logEvent("agent_stream", m);

      if (!capturedSessionId && typeof m.session_id === "string") {
        capturedSessionId = m.session_id;
      }

      // Per-message usage accumulation (SIGTERM fallback source + model).
      if (m.type === "assistant") {
        const msgObj = (m.message && typeof m.message === "object" ? m.message : null) as
          | Record<string, unknown>
          | null;
        const u = (msgObj?.usage && typeof msgObj.usage === "object" ? msgObj.usage : null) as
          | Record<string, unknown>
          | null;
        if (u) {
          uncachedInputTokens += typeof u.input_tokens === "number" ? u.input_tokens : 0;
        }
        const msgModel = msgObj?.model;
        if (typeof msgModel === "string" && msgModel && !modelUsed) modelUsed = msgModel;
      }

      // Rate-limit detection. Benign "allowed*" broadcasts only update the
      // weekly usage fraction; real limit hits get recorded + logged.
      const rli = (m.rate_limit_info && typeof m.rate_limit_info === "object"
        ? m.rate_limit_info
        : null) as Record<string, unknown> | null;
      const rliStatus = typeof rli?.status === "string" ? (rli.status as string) : null;
      const isBenignRateLimitBroadcast =
        m.type === "rate_limit_event" && (rliStatus == null || rliStatus.startsWith("allowed"));
      if (isBenignRateLimitBroadcast && rli != null) {
        const uf = extractUsageFraction(rli);
        if (uf != null) {
          recordUsageFraction(uf);
          persistUsageFraction(db).catch(() => {});
        }
      }
      const mStr = isBenignRateLimitBroadcast ? "" : JSON.stringify(msg);
      const isRealLimit =
        !isBenignRateLimitBroadcast &&
        ((m.type === "error" && /rate.?limit|429|too many requests/i.test(mStr)) ||
          m.type === "rate_limit_event");
      if (isRealLimit) {
        const pidCount = countClaudeProcesses();
        const errObj = (m.error && typeof m.error === "object" ? m.error : null) as
          | Record<string, unknown>
          | null;
        const rlType =
          (errObj?.type as string) ??
          (typeof m.rate_limit_type === "string" ? m.rate_limit_type : null) ??
          null;
        const rawRetry = errObj?.retry_after ?? m.retry_after;
        const retryAfterSec = rawRetry != null ? Number(rawRetry) || null : null;
        recordRateLimit({ rateLimitType: rlType, retryAfterSec, claudeProcessCount: pidCount });
        await logEvent("rate_limit_detected", {
          source: "stream-json",
          rateLimitType: rlType,
          retryAfterSec,
          claudeProcessCount: pidCount,
          concurrencyCap: getConcurrencyCap(),
        });
      }

      // 401 self-heal — 401s land on STDOUT as stream-json (stderr never sees them).
      if (
        !authFailureDetected &&
        (m.error === "authentication_failed" ||
          m.error_status === 401 ||
          m.api_error_status === 401)
      ) {
        authFailureDetected = true;
        void refreshClaudeOAuthToken(`stream-401 ${target.kind}=${target.id}`);
        await logEvent("auth_error_self_heal", { source: "stream-json", refreshTriggered: true });
      }

      if (m.type === "result") {
        if (
          existingSessionId &&
          m.is_error === true &&
          typeof m.num_turns === "number" &&
          m.num_turns === 0
        ) {
          resumeStartFailed = true;
        }
        const cost =
          typeof m.total_cost_usd === "number"
            ? m.total_cost_usd
            : typeof m.cost_usd === "number"
              ? m.cost_usd
              : typeof m.total_cost === "number"
                ? m.total_cost
                : null;
        if (cost != null) totalCostUsd = cost;
        const resultModel = extractModelFromStreamResult(m);
        if (resultModel) modelUsed = resultModel;
        const usage = (m.usage && typeof m.usage === "object" ? m.usage : null) as
          | Record<string, unknown>
          | null;
        let inTok = 0,
          outTok = 0,
          cacheReadTok = 0,
          cacheCreateTok = 0;
        if (usage) {
          inTok = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
          outTok = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
          cacheReadTok =
            typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0;
          cacheCreateTok =
            typeof usage.cache_creation_input_tokens === "number"
              ? usage.cache_creation_input_tokens
              : 0;
        }
        const totalTok = inTok + outTok + cacheReadTok + cacheCreateTok;
        if (totalTok > 0) totalTokensUsed = totalTok;
        cacheReadInputTokens = cacheReadTok;
        cacheCreationInputTokens = cacheCreateTok;
        uncachedInputTokens = inTok;
      }
    };

    const flushStdoutLines = async (chunk: Buffer): Promise<void> => {
      stdoutBuf += chunk.toString("utf8");
      let nl = stdoutBuf.indexOf("\n");
      while (nl >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        await handleStreamJsonLine(line);
        nl = stdoutBuf.indexOf("\n");
      }
    };

    let authErrorSelfHealed = false;
    const flushStderrLines = async (chunk: Buffer): Promise<void> => {
      stderrBuf += chunk.toString("utf8");
      const lastNl = stderrBuf.lastIndexOf("\n");
      if (lastNl < 0) return;
      const complete = stderrBuf.slice(0, lastNl);
      stderrBuf = stderrBuf.slice(lastNl + 1);
      for (const line of complete.split("\n")) {
        if (!line.trim()) continue;
        await logEvent("agent_log", { stream: "stderr", line });
        if (
          !authErrorSelfHealed &&
          (/"type"\s*:\s*"authentication_error"/i.test(line) || /API Error:\s*401/i.test(line))
        ) {
          authErrorSelfHealed = true;
          authFailureDetected = true;
          if (process.env.CLAUDE_CODE_OAUTH_TOKEN) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
          void refreshClaudeOAuthToken(`stderr-401 ${target.kind}=${target.id}`);
          await logEvent("auth_error_self_heal", {
            stderrLine: line.slice(0, 500),
            refreshTriggered: true,
          });
        }
        if (/rate.?limit/i.test(line) || /429/i.test(line) || /too many requests/i.test(line)) {
          const pidCount = countClaudeProcesses();
          const retryMatch = line.match(/retry[\-_\s]?after[\s:=]*(\d+)/i);
          const retryAfterSec = retryMatch ? Number(retryMatch[1]) || null : null;
          recordRateLimit({ rateLimitType: null, retryAfterSec, claudeProcessCount: pidCount });
          await logEvent("rate_limit_detected", {
            stderrLine: line.slice(0, 500),
            retryAfterSec,
            claudeProcessCount: pidCount,
            concurrencyCap: getConcurrencyCap(),
          });
        }
      }
    };

    let stdoutOffset = 0;
    let stderrOffset = 0;
    if (adoptExistingPid) {
      const [so, se] = await Promise.all([
        stat(stdoutPath).catch(() => null),
        stat(stderrPath).catch(() => null),
      ]);
      stdoutOffset = so?.size ?? 0;
      stderrOffset = se?.size ?? 0;
    }

    const flushOnce = async (
      path: string,
      getOffset: () => number,
      setOffset: (n: number) => void,
      flush: (b: Buffer) => Promise<void>,
    ): Promise<void> => {
      const st = await stat(path).catch(() => null);
      const off = getOffset();
      if (!st || st.size <= off) return;
      const len = st.size - off;
      setOffset(st.size);
      const fh = await fsOpen(path, "r");
      try {
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, off);
        await flush(buf);
      } finally {
        await fh.close();
      }
    };
    const flushStdoutOnce = () =>
      flushOnce(stdoutPath, () => stdoutOffset, (n) => (stdoutOffset = n), flushStdoutLines);
    const flushStderrOnce = () =>
      flushOnce(stderrPath, () => stderrOffset, (n) => (stderrOffset = n), flushStderrLines);

    const exitCode: number | null = await new Promise((resolve) => {
      let resolved = false;
      const finish = (code: number | null) => {
        if (resolved) return;
        resolved = true;
        resolve(code);
      };
      if (exitCodePromise) exitCodePromise.then(finish);
      const tick = async () => {
        try {
          await flushStdoutOnce();
          await flushStderrOnce();
        } catch (err) {
          console.error(`[orca/cli-dispatch] tail error ${target.kind}=${target.id}:`, err);
        }
        if (resolved) return;
        if (!child && dispatchPid != null && !isPidAlive(dispatchPid)) {
          finish(0);
          return;
        }
        setTimeout(tick, 200);
      };
      tick();
    });

    await flushStdoutOnce();
    await flushStderrOnce();
    runningDispatches.delete(target.id);
    if (stdoutBuf.trim()) await handleStreamJsonLine(stdoutBuf);
    if (stderrBuf.trim()) await logEvent("agent_log", { stream: "stderr", line: stderrBuf });

    // SIGTERM fallback: scan the raw log for assistant-message usage when the
    // result event never fired.
    if (totalTokensUsed == null && stdoutPath) {
      let scanIn = 0,
        scanOut = 0,
        scanRead = 0,
        scanCreate = 0;
      try {
        const rawLog = await readFile(stdoutPath, "utf-8");
        for (const rawLine of rawLog.split("\n")) {
          const t = rawLine.trim();
          if (!t) continue;
          let evt: Record<string, unknown>;
          try {
            evt = JSON.parse(t) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (evt.type !== "assistant") continue;
          const msgObj = (evt.message && typeof evt.message === "object" ? evt.message : null) as
            | Record<string, unknown>
            | null;
          const u = (msgObj?.usage && typeof msgObj.usage === "object" ? msgObj.usage : null) as
            | Record<string, unknown>
            | null;
          if (u) {
            scanIn += typeof u.input_tokens === "number" ? u.input_tokens : 0;
            scanOut += typeof u.output_tokens === "number" ? u.output_tokens : 0;
            scanRead +=
              typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0;
            scanCreate +=
              typeof u.cache_creation_input_tokens === "number"
                ? u.cache_creation_input_tokens
                : 0;
          }
        }
      } catch {
        // best effort
      }
      const scanTotal = scanIn + scanOut + scanRead + scanCreate;
      if (scanTotal > 0) {
        totalTokensUsed = scanTotal;
        cacheReadInputTokens = scanRead;
        cacheCreationInputTokens = scanCreate;
        uncachedInputTokens = scanIn;
      }
    }

    // Changed files + git diff (same fallback chain as the story path).
    const changedFiles = await listChangedFiles(cwd, marker);
    let gitDiff: string | null = await captureGitDiff(cwd, preDispatchRef);
    if (!gitDiff && preDispatchHead) {
      const postHead = await getHeadSha(cwd);
      if (postHead && postHead !== preDispatchHead) {
        gitDiff = await captureCommittedDiff(cwd, preDispatchHead);
      }
    }
    if (!gitDiff && changedFiles.length > 0 && !preDispatchHead) {
      gitDiff = await synthDiffForNewFiles(cwd, changedFiles);
    }

    await logEvent("dispatch_completed", {
      exitCode,
      changedFiles,
      fileCount: changedFiles.length,
      gitDiff,
      ...(preDispatchHead ? { preDispatchHead } : {}),
      ...(totalCostUsd != null ? { totalCostUsd } : {}),
      ...(totalTokensUsed != null ? { totalTokensUsed } : {}),
      ...(modelUsed ? { model: modelUsed } : {}),
      resumed: Boolean(existingSessionId),
      cacheReadInputTokens,
      cacheCreationInputTokens,
      uncachedInputTokens,
      authFailureDetected,
    });

    if (capturedSessionId) {
      await args.onSessionPersist(capturedSessionId, args.systemPromptHash ?? null);
    }
    // Clear PID/dispatchState on the target row so heartbeat stops tracking it.
    await args.onClearTracking();

    return {
      exitCode,
      capturedSessionId,
      authFailureDetected,
      resumeStartFailed,
      changedFiles,
      gitDiff,
      totalCostUsd,
      totalTokensUsed,
    };
  } finally {
    releaseLifecycle(target.id);
  }
}
