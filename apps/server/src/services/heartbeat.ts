import { eq, and, isNotNull, sql, inArray } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { schema } from "@orca/db";
import { sanitizeForJsonb } from "./sanitize-jsonb.js";
import type { OrcaDb, DispatchState } from "@orca/db";
import type { StoryStatus, CliDispatchState, PrdParse } from "@orca/shared";
import { parsePrdDoc } from "@orca/shared";
import { runClaudeDispatch, isDispatchLifecycleActive } from "../routes/stories.js";
import { resolveModelForStory } from "../agents/model.js";
import { isConcurrencyExceeded, countClaudeProcesses, getConcurrencyCap, isRateLimited, getRateLimitInfo } from "./concurrency.js";
import { handleDispatchRejection } from "./dispatch-rejection.js";
import { getThrottleSettings, poolForAgent } from "./throttle.js";
import { isPidAlive } from "./pid.js";
import { runPrdDispatch } from "./prd-dispatch.js";
import { isUnderProductDir } from "./prd-scan.js";
import { runAuditDispatch } from "./audit-dispatch.js";
import { sha256, expandTilde } from "./dispatch-prompt-util.js";
import { reapOrphanedProcesses } from "./reap-orphans.js";

const MAX_FAIL_COUNT = 3;

// Activity-event actors that are NOT proof of agent life. The reaper uses
// *agent activity* — events written by the dispatched claude process — as
// the signal that a story is still progressing. Heartbeat / system / user
// / auditor events are bookkeeping noise and must not keep a wedged agent
// alive: without this filter the reaper feedback-loops on its own
// `concurrency_deferred` / `dispatch_started` writes.
const NON_AGENT_ACTORS = ["heartbeat", "system", "user", "auditor"];

interface ActivePools {
  /** impl-pipeline code editors: story frontend/backend + full-stack-engineer. */
  impl: number;
  /** doc authors: story spec-writer + PRD drafter. */
  spec: number;
  /** qa-tester agents. */
  qa: number;
  /** read-only audit-runner scans. */
  auditRun: number;
  /** impl-pipeline count keyed by projectId (for the per-project cap). */
  implByProject: Map<string, number>;
}

/**
 * Count every active dispatch across ALL target tables (stories, prds, audits),
 * bucketed by throttle pool via `poolForAgent`. The mutex for "actively
 * dispatched" is `dispatchPid IS NOT NULL` on each row — the same one the
 * reaper uses. PRD/audit agents share the story pools so the /settings caps
 * (impl-pipeline total + per-project, spec-writer) bound true system-wide
 * concurrency: full-stack-engineer counts as impl, drafter as spec, audit-runner
 * as audit-run. The returned counters are seeds — callers mutate them as they
 * dispatch so later per-item checks stay accurate within a single tick.
 */
async function countActivePools(db: OrcaDb): Promise<ActivePools> {
  const agentOfState = (s: CliDispatchState | null): string | null =>
    s?.args?.agentName ?? null;
  const [stories, prds, audits] = await Promise.all([
    db
      .select({
        agent: schema.stories.agent,
        projectId: schema.stories.projectId,
      })
      .from(schema.stories)
      .where(isNotNull(schema.stories.dispatchPid)),
    db
      .select({
        projectId: schema.prds.projectId,
        dispatchState: schema.prds.dispatchState,
      })
      .from(schema.prds)
      .where(isNotNull(schema.prds.dispatchPid)),
    db
      .select({
        projectId: schema.auditChecks.projectId,
        dispatchState: schema.auditChecks.dispatchState,
      })
      .from(schema.auditChecks)
      .where(isNotNull(schema.auditChecks.dispatchPid)),
  ]);

  const active: { agent: string | null; projectId: string }[] = [
    ...stories.map((s) => ({ agent: s.agent, projectId: s.projectId })),
    ...prds.map((p) => ({
      agent: agentOfState(p.dispatchState as CliDispatchState | null),
      projectId: p.projectId,
    })),
    ...audits.map((a) => ({
      agent: agentOfState(a.dispatchState as CliDispatchState | null),
      projectId: a.projectId,
    })),
  ];

  const pools: ActivePools = {
    impl: 0,
    spec: 0,
    qa: 0,
    auditRun: 0,
    implByProject: new Map<string, number>(),
  };
  for (const a of active) {
    switch (poolForAgent(a.agent)) {
      case "spec":
        pools.spec++;
        break;
      case "qa":
        pools.qa++;
        break;
      case "audit-run":
        pools.auditRun++;
        break;
      default:
        pools.impl++;
        pools.implByProject.set(
          a.projectId,
          (pools.implByProject.get(a.projectId) ?? 0) + 1,
        );
    }
  }
  return pools;
}

/**
 * Recover a story whose agent process has died or gone stale.
 * Handles fail-count tracking, blocking after MAX_FAIL_COUNT, and respawning.
 */
async function recoverStory(
  db: OrcaDb,
  story: typeof schema.stories.$inferSelect,
  reason: "dead_pid" | "stale",
  deadPid: number | null,
): Promise<void> {
  // Dispatch gate: if the story has open blocking refinement questions,
  // recovering is just going to burn tokens on an agent that has already
  // asked the question and can't make progress. Revert the row to
  // `planning` and exit — the on-answer hook (or the user's manual Re-spec
  // button) will pick the story back up when there's actually new input.
  const [blocker] = await db
    .select({ id: schema.refinementQuestions.id })
    .from(schema.refinementQuestions)
    .where(
      and(
        eq(schema.refinementQuestions.storyId, story.id),
        eq(schema.refinementQuestions.status, "open"),
        eq(schema.refinementQuestions.blocksDispatch, true),
      ),
    )
    .limit(1);
  if (blocker) {
    console.log(
      `[orca/heartbeat] story ${story.id} (${reason}) has open blocking question(s) — parking in planning instead of recovering`,
    );
    await db
      .update(schema.stories)
      .set({
        status: "planning" as StoryStatus,
        dispatchPid: null,
        dispatchedAt: null,
        dispatchState: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.stories.id, story.id));
    await db.insert(schema.activityEvents).values({
      storyId: story.id,
      kind: "state_transition",
      actor: "heartbeat",
      payload: sanitizeForJsonb({
        status: "planning",
        from: story.status,
        reason: "blocked_by_open_question",
      }),
    });
    return;
  }

  const newFailCount = story.dispatchFailCount + 1;

  // Log recovery event.
  await db.insert(schema.activityEvents).values({
    storyId: story.id,
    kind: "heartbeat_recovery",
    actor: "heartbeat",
    payload: sanitizeForJsonb({
      reason,
      deadPid,
      failCount: newFailCount,
      maxFailCount: MAX_FAIL_COUNT,
    }),
  });

  if (newFailCount >= MAX_FAIL_COUNT) {
    // Too many failures — block the story.
    console.log(
      `[orca/heartbeat] story ${story.id} failed ${newFailCount}x, marking blocked`,
    );

    await db
      .update(schema.stories)
      .set({
        status: "blocked" as StoryStatus,
        dispatchPid: null,
        dispatchFailCount: newFailCount,
        blockedReason: `Agent process died ${newFailCount} times — possible external issue`,
        updatedAt: new Date(),
      })
      .where(eq(schema.stories.id, story.id));

    await db.insert(schema.activityEvents).values({
      storyId: story.id,
      kind: "state_transition",
      actor: "heartbeat",
      payload: sanitizeForJsonb({
        status: "blocked",
        reason: `Agent process died ${newFailCount} times`,
      }),
    });

    return;
  }

  // Clear the dead PID, bump fail count, keep in_progress for the respawn.
  await db
    .update(schema.stories)
    .set({
      dispatchPid: null,
      dispatchFailCount: newFailCount,
      updatedAt: new Date(),
    })
    .where(eq(schema.stories.id, story.id));

  // Fetch the project to get repoPath for dispatch.
  const [project] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, story.projectId));

  if (!project) {
    console.error(
      `[orca/heartbeat] no project found for story ${story.id}, skipping recovery`,
    );
    return;
  }

  // Log dispatch restart.
  const recoveryModel = await resolveModelForStory(db, story.id);
  await db.insert(schema.activityEvents).values({
    storyId: story.id,
    kind: "dispatch_started",
    actor: "heartbeat",
    payload: sanitizeForJsonb({
      repoPath: project.repoPath,
      adapter: "claude-local",
      trigger: "heartbeat-recovery",
      attempt: newFailCount + 1,
      agent: story.agent ?? "spec-writer",
      ...(recoveryModel ? { model: recoveryModel } : {}),
    }),
  });

  // Gate recovery behind rate-limit and concurrency checks. If either
  // condition is active, defer to backlog for the next heartbeat tick.
  const rlInfo = getRateLimitInfo();
  if (rlInfo || isConcurrencyExceeded()) {
    const pidCount = countClaudeProcesses();
    const cap = getConcurrencyCap();
    const gateReason = rlInfo
      ? `rate limit cooldown active (type=${rlInfo.rateLimitType}, until=${rlInfo.gatedUntil.toISOString()})`
      : `at or above concurrency cap (${pidCount}/${cap})`;
    console.log(
      `[orca/heartbeat] gate: ${gateReason}, deferring recovery for story ${story.id}`,
    );
    await db.insert(schema.activityEvents).values({
      storyId: story.id,
      kind: "concurrency_deferred",
      actor: "heartbeat",
      payload: sanitizeForJsonb({
        trigger: "heartbeat-recovery",
        claudeProcessCount: pidCount,
        concurrencyCap: cap,
        ...(rlInfo ? {
          rateLimitType: rlInfo.rateLimitType,
          retryAfterSec: rlInfo.retryAfterSec,
          gatedUntil: rlInfo.gatedUntil.toISOString(),
        } : {}),
        reason: rlInfo
          ? "rate limit cooldown active — recovery deferred to next tick"
          : "at or above concurrency cap — recovery deferred to next tick",
      }),
    });
    // Move story back to backlog so heartbeat pickup can grab it later.
    await db
      .update(schema.stories)
      .set({
        status: "backlog" as StoryStatus,
        updatedAt: new Date(),
      })
      .where(eq(schema.stories.id, story.id));
    return;
  }

  // Spawn a new agent process to resume the story.
  runClaudeDispatch({
    db,
    storyId: story.id,
    repoPath: project.repoPath,
    title: story.title,
    specMd: story.specMd,
    isRecovery: true,
  }).catch((err) =>
    handleDispatchRejection(db, story.id, err, {
      context: "recovery dispatch failed",
      revertStatus: true,
      actor: "heartbeat",
    }),
  );
}

/**
 * Runs one heartbeat tick: finds all in_progress stories with a tracked PID,
 * checks liveness, and recovers any whose agent process has died.
 * Also detects stale stories with no activity in the last heartbeat interval.
 */
async function tick(db: OrcaDb, intervalMs: number): Promise<void> {
  // ── 1. Dead-PID detection ──────────────────────────────────────────
  // Find any story with a tracked dispatchPid, regardless of status.
  // Heartbeat does not own status — its only mutex for "this story is
  // actively dispatched" is `dispatchPid IS NOT NULL` plus the in-memory
  // activeLifecycles guard. The agent is responsible for setting status.
  const storiesWithPid = await db
    .select()
    .from(schema.stories)
    .where(isNotNull(schema.stories.dispatchPid));

  // Track which story IDs we already handled so we don't double-recover.
  const handledIds = new Set<string>();

  for (const story of storiesWithPid) {
    const pid = story.dispatchPid;
    if (pid == null) continue;

    // Node-side lifecycle guard. `runClaudeDispatch` maintains a set of
    // stories it is actively managing, which spans the do-er process, the
    // QA gate that runs after it, and any QA retry recursion. The
    // `dispatchPid` column can legitimately point to a dead do-er PID
    // during the QA window — treating that as "agent died" would spawn a
    // duplicate do-er on top of the running QA. Skip the story as long as
    // a lifecycle is active in this Node process. If the Node process
    // restarted, this set is empty on boot and genuine orphans will be
    // picked up correctly.
    if (isDispatchLifecycleActive(story.id)) {
      handledIds.add(story.id);
      continue;
    }

    // Detached-child adoption. When a Node process dies mid-dispatch, it
    // leaves behind a detached `claude` child whose stdio is redirected to
    // log files (see `runClaudeDispatch`'s spawn block). The child either:
    //   (a) is still running — we tail its log files until it exits, then
    //       run the standard completion pipeline (diff capture,
    //       dispatch_completed, QA gate, retry recursion); or
    //   (b) has already exited — same code path, the exit waiter notices
    //       the dead PID immediately and proceeds to completion.
    // This replaces the old recoverStory respawn-from-scratch behavior,
    // which was the root cause of "heartbeat keeps respawning agents that
    // do literally nothing": fresh-spawned recovery agents were being
    // killed by SIGPIPE the next time `tsx watch` restarted Node, before
    // they could make progress. With adoption we attach to the original
    // child instead of replacing it.
    const dispatchState = story.dispatchState as DispatchState | null;
    if (dispatchState) {
      handledIds.add(story.id);
      const aliveStr = isPidAlive(pid) ? "alive" : "dead";
      console.log(
        `[orca/heartbeat] story ${story.id} PID ${pid} is ${aliveStr} with dispatchState — adopting`,
      );
      // Fire-and-forget: adoption runs the full lifecycle (tail + QA +
      // retry) and we don't want to block the rest of the heartbeat tick
      // on it. The adopted runClaudeDispatch call adds itself to
      // `activeLifecycles` synchronously before its first await, so the
      // next heartbeat tick will see it and skip via the lifecycle guard.
      runClaudeDispatch({
        db,
        storyId: story.id,
        repoPath: dispatchState.args.repoPath,
        title: dispatchState.args.title,
        specMd: dispatchState.args.specMd,
        ...(dispatchState.args.changeSummary
          ? { changeSummary: dispatchState.args.changeSummary }
          : {}),
        ...(dispatchState.args.isRecovery
          ? { isRecovery: dispatchState.args.isRecovery }
          : {}),
        ...(dispatchState.args.qaFailureSummary
          ? { qaFailureSummary: dispatchState.args.qaFailureSummary }
          : {}),
        adoptExistingPid: { pid, state: dispatchState },
      }).catch((err) =>
        handleDispatchRejection(db, story.id, err, {
          context: "adoption dispatch failed",
          // Don't revert: the original detached child may still be running,
          // and rewriting status would race with its own writes. Stale-
          // activity detection on a later tick will resolve it.
          revertStatus: false,
          actor: "heartbeat",
        }),
      );
      continue;
    }

    if (isPidAlive(pid)) continue;

    // PID is dead and there's no dispatchState (legacy row, or the
    // dispatch never reached the persist step). Fall back to the old
    // respawn-from-scratch recovery — not ideal, but the best we can do
    // without log files to tail.
    console.log(
      `[orca/heartbeat] story ${story.id} PID ${pid} is dead with no dispatchState, recovering via respawn...`,
    );

    handledIds.add(story.id);
    await recoverStory(db, story, "dead_pid", pid);
  }

  // ── 2. Stale-activity detection ────────────────────────────────────
  // Find stories with a tracked dispatchPid whose most recent activity
  // event is older than the stale-activity threshold. Pinned to an
  // absolute 5min duration so dropping the picker cadence to 1min doesn't
  // reap legitimately-thinking agents (slow first token, model warmup,
  // multi-turn tool calls). As with dead-PID detection, the mutex is
  // dispatchPid presence — status is owned by the agent, not heartbeat.
  const STALE_ACTIVITY_THRESHOLD_MS = 5 * 60 * 1000;
  const cutoff = new Date(Date.now() - STALE_ACTIVITY_THRESHOLD_MS);

  const allInProgress = await db
    .select()
    .from(schema.stories)
    .where(isNotNull(schema.stories.dispatchPid));

  for (const story of allInProgress) {
    // NOTE: this loop deliberately does NOT short-circuit on
    // `handledIds.has(story.id)` or `isDispatchLifecycleActive(story.id)`.
    // Earlier versions did, which silently disabled stale-activity reaping
    // for every modern dispatch: any story with `dispatchState` set hit the
    // dead-PID adoption branch (handledIds.add), and any story whose
    // runClaudeDispatch was still pending hit the lifecycle-active branch.
    // The lifecycle has no stale-output watchdog of its own — it just
    // awaits child exit — so a claude wrapper hung on a stuck Bash-tool
    // subprocess would keep `dispatchPid`/`dispatchState` set forever.
    // Treat stale-activity as the universal fallback timer: 5 minutes of
    // agent silence → kill the process group regardless of in-process
    // lifecycle state. The lifecycle's exit handler then runs naturally.

    // Check for recent *agent* activity within the heartbeat interval.
    // Definitionally, a story is alive iff its agent process is writing
    // events. Heartbeat / system / user / auditor events do not count —
    // counting them creates a feedback loop where the heartbeat's own
    // `concurrency_deferred` / `dispatch_started` writes keep a wedged
    // agent looking alive forever.
    const [recent] = await db
      .select({ id: schema.activityEvents.id })
      .from(schema.activityEvents)
      .where(
        and(
          eq(schema.activityEvents.storyId, story.id),
          sql`${schema.activityEvents.createdAt} >= ${cutoff.toISOString()}`,
          sql`${schema.activityEvents.actor} NOT IN (${sql.join(
            NON_AGENT_ACTORS.map((a) => sql`${a}`),
            sql`, `,
          )})`,
        ),
      )
      .limit(1);

    if (recent) continue;

    // No activity in the last interval — story is stale.
    const lifecycleActive = isDispatchLifecycleActive(story.id);
    console.log(
      `[orca/heartbeat] story ${story.id} has no activity since ${cutoff.toISOString()} (lifecycleActive=${lifecycleActive}), killing PID...`,
    );

    // Kill the process group if it's still alive. Claude is spawned with
    // `detached: true` so its PID is also the pgid — `kill(-pid)` cascades
    // to every descendant (Bash-tool subprocesses, MCP servers, etc.).
    // Without the negative pid, an orphaned bash subprocess keeps stdio
    // open and the claude wrapper never exits, and the whole reap is
    // pointless. Fall back to a plain `kill(pid)` if pgid kill fails
    // (e.g. the leader already exited but children re-parented).
    const pid = story.dispatchPid;
    if (pid != null && isPidAlive(pid)) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Process may have exited between check and kill — ignore.
        }
      }
    }

    // If a runClaudeDispatch lifecycle is still active in this Node, its
    // `child.on("exit")` handler will fire as soon as the SIGTERM lands
    // and will run the normal completion path (dispatch_completed event,
    // clear dispatchPid/dispatchState, release lifecycle). Calling
    // recoverStory here would race that teardown and spawn a duplicate
    // claude on top of the still-finishing one. Heartbeat pickup on a
    // later tick will re-dispatch the row once the columns are clear.
    if (lifecycleActive) continue;

    // No in-process lifecycle — legacy/orphaned row (e.g. server restarted
    // mid-dispatch and `dispatchState` was never persisted). Fall back to
    // respawn-from-scratch recovery.
    await recoverStory(db, story, "stale", pid);
  }

  // ── 3. Open-story pickup ───────────────────────────────────────────
  // On every tick, run the currently-assigned agent for every open story
  // (backlog + in_review) that is not already actively dispatched. Each
  // agent's prompt is idempotent — it detects its own state and transitions
  // via the Orca API. Concurrency cap and rate-limit gate still apply.
  if (isRateLimited()) {
    const rl = getRateLimitInfo();
    console.log(
      `[orca/heartbeat] rate-limit gate active (type=${rl?.rateLimitType}, until=${rl?.gatedUntil.toISOString()}), skipping open-story pickup`,
    );
  } else {
    // Automated statuses — heartbeat dispatches the assigned agent for these.
    //   `planning`      = spec-writer owns the back-and-forth with the user;
    //                     re-pick on each tick so it can incorporate answers.
    //   `backlog`       = legacy; kept for backward compat with existing rows.
    //   `implementing`  = spec complete; assigned agent works the story.
    //   `qa`            = implementing finished, qa-tester is next.
    // `icebox` is intentionally excluded — it means uncommitted; heartbeat
    // does not dispatch for iceboxed stories.
    // `review` is a human gate. `done`, `canceled`, `blocked` are terminal.
    const openStoriesRaw = await db
      .select()
      .from(schema.stories)
      .where(
        inArray(schema.stories.status, [
          "planning",
          "backlog",
          "implementing",
          "qa",
        ] as StoryStatus[]),
      );

    // Dispatch gate: a story with any open blocking refinement question must
    // NOT be auto-dispatched. The agent's last pass already asked the
    // question — re-running it on the next tick burns tokens with no new
    // information. The on-answer hook in /api/refinement-questions handles
    // re-dispatch the moment the user actually answers the last blocker;
    // until then, the story sits. The manual Dispatch / Re-spec button on
    // the story page can still force a run when the user wants to redirect
    // the agent regardless of question state.
    const blockedRows = openStoriesRaw.length
      ? await db
          .selectDistinct({
            storyId: schema.refinementQuestions.storyId,
          })
          .from(schema.refinementQuestions)
          .where(
            and(
              inArray(
                schema.refinementQuestions.storyId,
                openStoriesRaw.map((s) => s.id),
              ),
              eq(schema.refinementQuestions.status, "open"),
              eq(schema.refinementQuestions.blocksDispatch, true),
            ),
          )
      : [];
    const blockedByQuestionIds = new Set(blockedRows.map((r) => r.storyId));
    if (blockedByQuestionIds.size > 0) {
      console.log(
        `[orca/heartbeat] gate: ${blockedByQuestionIds.size} stor${
          blockedByQuestionIds.size === 1 ? "y has" : "ies have"
        } open blocking question(s) — skipping auto-dispatch`,
      );
    }

    // Order eligible stories by total past token usage descending, so stories
    // with the most work already invested get finished out before fresh ones
    // are picked up. Avoids bouncing between partially-done tasks. createdAt
    // ascending is the tiebreaker for stories with no token history yet.
    const storyIds = openStoriesRaw.map((s) => s.id);
    const tokenSums = storyIds.length
      ? await db
          .select({
            storyId: schema.tokenHeatmaps.storyId,
            totalTokens: sql<string>`COALESCE(SUM(${schema.tokenHeatmaps.totalIn} + ${schema.tokenHeatmaps.totalOut}), 0)`,
          })
          .from(schema.tokenHeatmaps)
          .where(inArray(schema.tokenHeatmaps.storyId, storyIds))
          .groupBy(schema.tokenHeatmaps.storyId)
      : [];
    const tokensByStory = new Map<string, number>(
      tokenSums.map((t) => [t.storyId, Number(t.totalTokens)]),
    );
    const openStories = [...openStoriesRaw].sort((a, b) => {
      const ta = tokensByStory.get(a.id) ?? 0;
      const tb = tokensByStory.get(b.id) ?? 0;
      if (ta !== tb) return tb - ta;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });

    // Default any story with no agent to spec-writer. Spec-writer is now the
    // canonical first pass for every story — it atomizes the spec, surfaces
    // refinement questions, and splits multi-agent work into sibling stories
    // before any implementing agent burns tokens.
    for (const story of openStories.filter((s) => !s.agent)) {
      await db
        .update(schema.stories)
        .set({ agent: "spec-writer", updatedAt: new Date() })
        .where(eq(schema.stories.id, story.id));
    }

    // Filter to stories not already running in this Node process and not
    // gated by an open blocking refinement question. Log lifecycle-gated
    // exclusions so a wedged story (phantom `activeLifecycles` entry, or
    // a legitimately-running dispatch we silently passed over) shows up
    // in heartbeat logs instead of having to be reverse-engineered from
    // activity events.
    const dispatchable = openStories
      .map((s) => (s.agent ? s : { ...s, agent: "spec-writer" }))
      .filter((s) => {
        if (isDispatchLifecycleActive(s.id)) {
          console.log(
            `[orca/heartbeat] pickup skipped story ${s.id} (status=${s.status}, agent=${s.agent}) — lifecycle active in this process`,
          );
          return false;
        }
        return true;
      })
      .filter((s) => !blockedByQuestionIds.has(s.id));

    // How many slots are free?
    const slots = getConcurrencyCap() - countClaudeProcesses();

    // Load throttle settings and count every currently-dispatching agent,
    // bucketed by pool. The mutex is `dispatchPid IS NOT NULL` — not status —
    // because heartbeat doesn't change status. Counting spans stories AND
    // prds/audits: full-stack-engineer (PRD implement / audit fix) draws from
    // the impl-pipeline budget here just like a story's frontend/backend agent,
    // and PRD drafter draws from the spec-writer budget. spec-writer and
    // qa-tester each have their own independent cap and must NOT burn
    // impl-pipeline slots (per-project or global), otherwise a project with a
    // spec-writer or qa-tester running would block its own implementing agent.
    //
    // These counters are mutable seeds — incremented as we dispatch below so
    // per-story checks stay accurate within the tick.
    const throttle = await getThrottleSettings(db);
    const pools = await countActivePools(db);
    let throttleTotalInProgress = pools.impl;
    const throttleByProject = pools.implByProject;
    let throttleQaInProgress = pools.qa;
    let throttleSpecWriterInProgress = pools.spec;

    // Dispatch assigned stories up to the concurrency cap and throttle limits.
    if (slots > 0) {
      const assigned = dispatchable.filter((s) => !!s.agent);
      let dispatched = 0;

      for (const story of assigned) {
        if (dispatched >= slots) break;

        // Spec-writer and qa-tester dispatches don't compete with the
        // implementing-pipeline slots — each has its own independent
        // concurrency cap. Skip the impl-pipeline throttles entirely for them.
        const isSpecWriter = story.agent === "spec-writer";
        const isQa = story.agent === "qa-tester";
        const isImplPipeline = !isSpecWriter && !isQa;

        // ── Throttle: spec-writer concurrent cap ───────────────────
        if (
          isSpecWriter &&
          throttleSpecWriterInProgress >= throttle.maxConcurrentSpecWriter
        ) {
          console.log(
            `[orca/heartbeat] spec-writer-throttle: running (${throttleSpecWriterInProgress}) >= maxConcurrentSpecWriter (${throttle.maxConcurrentSpecWriter}), deferring story ${story.id}`,
          );
          await db.insert(schema.activityEvents).values({
            storyId: story.id,
            kind: "concurrency_deferred",
            actor: "heartbeat",
            payload: sanitizeForJsonb({
              trigger: "throttle-spec-writer",
              specWriterInProgress: throttleSpecWriterInProgress,
              maxConcurrentSpecWriter: throttle.maxConcurrentSpecWriter,
              reason: `spec-writer throttle limit reached (${throttleSpecWriterInProgress}/${throttle.maxConcurrentSpecWriter})`,
            }),
          });
          continue;
        }

        // ── Throttle: total in-progress cap ────────────────────────
        // Spec-writer and qa-tester are exempt — each has its own
        // independent cap. Use `continue` (not `break`) so stories with
        // independent caps later in the iteration order still get a
        // chance to be evaluated. `assigned` is sorted by token-count
        // desc, so a token-heavy impl story arriving first must not bury
        // spec-writers or qa-testers behind it.
        if (
          isImplPipeline &&
          throttleTotalInProgress >= throttle.maxConcurrentTotal
        ) {
          console.log(
            `[orca/heartbeat] throttle: total dispatched (${throttleTotalInProgress}) >= maxConcurrentTotal (${throttle.maxConcurrentTotal}), deferring story ${story.id}`,
          );
          await db.insert(schema.activityEvents).values({
            storyId: story.id,
            kind: "concurrency_deferred",
            actor: "heartbeat",
            payload: sanitizeForJsonb({
              trigger: "throttle-total",
              totalInProgress: throttleTotalInProgress,
              maxConcurrentTotal: throttle.maxConcurrentTotal,
              reason: `total impl-pipeline throttle limit reached (${throttleTotalInProgress}/${throttle.maxConcurrentTotal})`,
            }),
          });
          continue;
        }

        // ── Throttle: max concurrent QA ────────────────────────────
        // qa-tester dispatches spike system load — cap how many can run
        // simultaneously. Story stays in `qa` and waits for the next tick.
        // Independent of the impl-pipeline caps.
        if (
          isQa &&
          throttleQaInProgress >= throttle.maxConcurrentQa
        ) {
          console.log(
            `[orca/heartbeat] qa-throttle: dispatched qa (${throttleQaInProgress}) >= maxConcurrentQa (${throttle.maxConcurrentQa}), keeping story ${story.id} in qa`,
          );
          await db.insert(schema.activityEvents).values({
            storyId: story.id,
            kind: "concurrency_deferred",
            actor: "heartbeat",
            payload: sanitizeForJsonb({
              trigger: "throttle-qa",
              qaInProgress: throttleQaInProgress,
              maxConcurrentQa: throttle.maxConcurrentQa,
              reason: `QA throttle limit reached (${throttleQaInProgress}/${throttle.maxConcurrentQa}) — staying in qa`,
            }),
          });
          continue;
        }

        // ── Throttle: per-project in-progress cap ──────────────────
        // Spec-writer and qa-tester are exempt — each has its own global cap.
        const projectInProgress = throttleByProject.get(story.projectId) ?? 0;
        if (
          isImplPipeline &&
          projectInProgress >= throttle.maxConcurrentPerProject
        ) {
          console.log(
            `[orca/heartbeat] throttle: project ${story.projectId} implementing (${projectInProgress}) >= maxConcurrentPerProject (${throttle.maxConcurrentPerProject}), skipping story ${story.id}`,
          );
          await db.insert(schema.activityEvents).values({
            storyId: story.id,
            kind: "concurrency_deferred",
            actor: "heartbeat",
            payload: sanitizeForJsonb({
              trigger: "throttle-per-project",
              projectInProgress,
              maxConcurrentPerProject: throttle.maxConcurrentPerProject,
              reason: `per-project throttle limit reached (${projectInProgress}/${throttle.maxConcurrentPerProject})`,
            }),
          });
          continue;
        }

        const [project] = await db
          .select()
          .from(schema.projects)
          .where(eq(schema.projects.id, story.projectId));
        if (!project) continue;

        console.log(
          `[orca/heartbeat] picking up ${story.status} story ${story.id} (agent: ${story.agent}, slot ${dispatched + 1}/${slots})`,
        );

        // Heartbeat does NOT change status. The agent owns its own status
        // transitions: spec-writer flips planning → implementing on handoff,
        // qa-tester stays in `qa`, etc. All heartbeat does here is bump
        // dispatchedAt (purely informational) and spawn.
        await db
          .update(schema.stories)
          .set({
            dispatchedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.stories.id, story.id));

        const pickupModel = await resolveModelForStory(db, story.id);

        await db.insert(schema.activityEvents).values({
          storyId: story.id,
          kind: "dispatch_started",
          actor: "heartbeat",
          payload: sanitizeForJsonb({
            repoPath: project.repoPath,
            adapter: "claude-local",
            trigger: "heartbeat-pickup",
            fromStatus: story.status,
            claudeProcessCount: countClaudeProcesses(),
            concurrencyCap: getConcurrencyCap(),
            agent: story.agent,
            ...(pickupModel ? { model: pickupModel } : {}),
          }),
        });

        runClaudeDispatch({
          db,
          storyId: story.id,
          repoPath: project.repoPath,
          title: story.title,
          specMd: story.specMd,
          trigger: "heartbeat-pickup",
        }).catch((err) =>
          handleDispatchRejection(db, story.id, err, {
            context: "pickup dispatch failed",
            // Status was never optimistically transitioned, so nothing to
            // revert. The agent owns status; if it never gets to PATCH
            // because the dispatch died, the row stays in its prior status
            // and gets re-picked next tick.
            revertStatus: false,
            actor: "heartbeat",
          }),
        );

        // Update local throttle counters to reflect this new dispatch.
        // Only impl-pipeline pickups (not spec-writer, not qa-tester)
        // bump the total / per-project counters — those two have their
        // own independent caps.
        if (isImplPipeline) {
          throttleTotalInProgress++;
          throttleByProject.set(
            story.projectId,
            (throttleByProject.get(story.projectId) ?? 0) + 1,
          );
        }
        if (isQa) {
          throttleQaInProgress++;
        }
        if (isSpecWriter) {
          throttleSpecWriterInProgress++;
        }
        dispatched++;
      }
    }
  }

  // ── 4. PRD + audit reap + pickup ────────────────────────────────────
  // Disconnected from the story pipeline; own independent throttle caps.
  await tickNonStoryTargets(db).catch((err) =>
    console.error("[orca/heartbeat] non-story (prd/audit) tick failed:", err),
  );

  // ── 5. Orphaned-process sweep ───────────────────────────────────────
  // The phase-1/2 reaps only `kill(-pid)` the claude process group. Build
  // tooling the agent spawned (dev servers, watchers, test runners) routinely
  // escapes that group — re-parenting to PID 1 or landing in a fresh session —
  // and piles up as dozens of node/npm processes "attached to nothing". Hunt
  // those down directly. Strictly guarded (own tree + live dispatches + ports)
  // and basename-matched so it never touches orca's own embedded Postgres.
  await reapOrphanedProcesses(db).catch((err) =>
    console.error("[orca/heartbeat] orphan reap failed:", err),
  );
}

// Settle/debounce windows: how long a PRD's edits must be quiet before the
// heartbeat acts on it. The drafter reacts faster (catch spec edits soon); the
// implementer waits longer (don't kick off a build until the doc is well
// settled). Per-agent so a flurry of edits doesn't trigger an expensive impl.
const PRD_DRAFT_SETTLE_MS = 3 * 60 * 1000; // drafter: 3 min
const PRD_IMPLEMENT_SETTLE_MS = 10 * 60 * 1000; // full-stack-engineer: 10 min
const NON_STORY_STALE_MS = 5 * 60 * 1000;

// Heuristic: is this .md doc a PRD the drafter should auto-process, vs. plain
// prose (KB/FAQ/marketing/README) we must never rewrite? Path naming OR
// PRD-convention structure (checkboxes / ❓ questions / [IMP]|[ICEBOX] tags).
// False positives are recoverable via the per-file "Ignore" action.
function looksLikePrd(relPath: string, parse: PrdParse, content: string): boolean {
  if (/(?:^|[/_.\-])(prd|spec|rfc)s?(?:[/_.\-]|$)/i.test(relPath)) return true;
  if (parse.bullets.total > 0) return true;
  if (parse.questions.length > 0) return true;
  if (/\[(IMP|ICEBOX)\]/i.test(content)) return true;
  return false;
}

/** Recent agent (non-bookkeeping) activity for a prd/audit target? */
async function hasRecentTargetActivity(
  db: OrcaDb,
  kind: "prd" | "audit",
  id: string,
  cutoff: Date,
): Promise<boolean> {
  const [r] = await db
    .select({ id: schema.activityEvents.id })
    .from(schema.activityEvents)
    .where(
      and(
        eq(schema.activityEvents.targetKind, kind),
        eq(schema.activityEvents.targetId, id),
        sql`${schema.activityEvents.createdAt} >= ${cutoff.toISOString()}`,
        sql`${schema.activityEvents.actor} NOT IN (${sql.join(
          NON_AGENT_ACTORS.map((a) => sql`${a}`),
          sql`, `,
        )})`,
      ),
    )
    .limit(1);
  return Boolean(r);
}

function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

/**
 * Reap dead/stale dispatches and pick up new work for PRDs and audits. Mirrors
 * the story phases 1+2 (adopt orphans, kill stale) and phase 3 (pickup) but for
 * the non-story target tables, using the shared lifecycle/PID guards.
 */
async function tickNonStoryTargets(db: OrcaDb): Promise<void> {
  const cutoff = new Date(Date.now() - NON_STORY_STALE_MS);

  // ── PRD reap ──────────────────────────────────────────────────────────
  // Mirrors the story reap's two concerns: adopt genuine orphans, AND sanity-
  // check that any tracked pid is actually making progress. The story path has
  // a dedicated stale-activity watchdog (tick phase 2) that kills a wedged pid
  // after the stale window REGARDLESS of in-process lifecycle state; PRDs/audits
  // lacked the equivalent. That gap is exactly how a PRD got pinned to "building"
  // for hours: an alive-but-hung child (claude wrapper stuck on a subprocess,
  // producing no output) keeps the dispatch lifecycle's tail loop spinning
  // forever — `isDispatchLifecycleActive` stays true, every branch below used to
  // `continue`, and the row's dispatchPid was never cleared until a server
  // restart. The watchdog below kills such a pid even while a lifecycle owns it;
  // the now-dead pid lets the tail loop run its normal completion + clear.
  const prdActive = await db
    .select()
    .from(schema.prds)
    .where(isNotNull(schema.prds.dispatchPid));
  for (const row of prdActive) {
    const pid = row.dispatchPid;
    if (pid == null) continue;

    const lifecycleActive = isDispatchLifecycleActive(row.id);
    const state = row.dispatchState as CliDispatchState | null;

    // Adopt a live orphan from a PRIOR Node before the stale check. While Node
    // was down the detached child wrote to its log files but no DB activity
    // event (those are written by the tail loop), so a healthy orphan looks
    // "silent" on boot — adopting replays its logs instead of reaping it. If it
    // turns out genuinely wedged, the next tick's watchdog (lifecycle now active)
    // kills it; a dead orphan's adoption completes immediately and clears the row.
    if (!lifecycleActive && state) {
      const mode = state.args.agentName === "drafter" ? "draft" : "implement";
      runPrdDispatch({ db, prdId: row.id, mode, trigger: "heartbeat-adoption", adoptExistingPid: { pid, state } }).catch(
        (err) => console.error(`[orca/heartbeat] prd adopt failed ${row.id}:`, err),
      );
      continue;
    }

    // Stale-PID watchdog — the missing sanity check. No agent activity in the
    // stale window ⇒ the dispatch is wedged (hung child, or a dead legacy pid).
    if (!(await hasRecentTargetActivity(db, "prd", row.id, cutoff))) {
      console.log(
        `[orca/heartbeat] prd ${row.id} pid ${pid} has no activity since ${cutoff.toISOString()} (lifecycleActive=${lifecycleActive}) — reaping`,
      );
      if (isPidAlive(pid)) killProcessGroup(pid);
      // An active lifecycle's tail loop notices the now-dead pid and runs the
      // normal completion path (dispatch_completed + clear). Clearing here would
      // race that teardown — let it finish.
      if (lifecycleActive) continue;
      await db
        .update(schema.prds)
        .set({ dispatchPid: null, dispatchState: null, updatedAt: new Date() })
        .where(eq(schema.prds.id, row.id));
      await db.insert(schema.activityEvents).values({
        storyId: null,
        targetKind: "prd",
        targetId: row.id,
        kind: "heartbeat_recovery",
        actor: "heartbeat",
        payload: sanitizeForJsonb({ reason: "stale", deadPid: pid, relPath: row.relPath }),
      });
      continue;
    }

    // Progressing: owned by an active lifecycle in this Node, or a live legacy
    // row we can't tail (no state to adopt from). Leave it; tidy a dead one.
    if (lifecycleActive) continue;
    if (!isPidAlive(pid)) {
      await db
        .update(schema.prds)
        .set({ dispatchPid: null, dispatchState: null, updatedAt: new Date() })
        .where(eq(schema.prds.id, row.id));
    }
  }

  // ── Audit reap ────────────────────────────────────────────────────────
  // Same stale-PID watchdog as the PRD reap above — see that comment for why an
  // alive-but-hung child would otherwise pin the row forever.
  const auditActive = await db
    .select()
    .from(schema.auditChecks)
    .where(isNotNull(schema.auditChecks.dispatchPid));
  for (const row of auditActive) {
    const pid = row.dispatchPid;
    if (pid == null) continue;

    const lifecycleActive = isDispatchLifecycleActive(row.id);
    const state = row.dispatchState as CliDispatchState | null;

    // Adopt a live orphan from a prior Node before the stale check (see PRD reap).
    if (!lifecycleActive && state) {
      const mode = state.args.agentName === "full-stack-engineer" ? "fix" : "run";
      runAuditDispatch({ db, auditCheckId: row.id, mode, trigger: "heartbeat-adoption", adoptExistingPid: { pid, state } }).catch(
        (err) => console.error(`[orca/heartbeat] audit adopt failed ${row.id}:`, err),
      );
      continue;
    }

    // Stale-PID watchdog.
    if (!(await hasRecentTargetActivity(db, "audit", row.id, cutoff))) {
      console.log(
        `[orca/heartbeat] audit ${row.id} pid ${pid} has no activity since ${cutoff.toISOString()} (lifecycleActive=${lifecycleActive}) — reaping`,
      );
      if (isPidAlive(pid)) killProcessGroup(pid);
      if (lifecycleActive) continue; // tail loop completes + clears
      await db
        .update(schema.auditChecks)
        .set({ dispatchPid: null, dispatchState: null, updatedAt: new Date() })
        .where(eq(schema.auditChecks.id, row.id));
      await db.insert(schema.activityEvents).values({
        storyId: null,
        targetKind: "audit",
        targetId: row.id,
        kind: "heartbeat_recovery",
        actor: "heartbeat",
        payload: sanitizeForJsonb({ reason: "stale", deadPid: pid, slug: row.slug }),
      });
      continue;
    }

    // Progressing — leave it; tidy a dead legacy row.
    if (lifecycleActive) continue;
    if (!isPidAlive(pid)) {
      await db
        .update(schema.auditChecks)
        .set({ dispatchPid: null, dispatchState: null, updatedAt: new Date() })
        .where(eq(schema.auditChecks.id, row.id));
    }
  }

  // ── Pickup (gated by rate-limit, concurrency, and per-table caps) ──────
  if (isRateLimited()) return;
  const throttle = await getThrottleSettings(db);

  // Count active dispatches across ALL tables (stories + prds + audits),
  // bucketed by pool, so PRD/audit code agents share the story budgets:
  //   - full-stack-engineer (PRD implement / audit fix) → impl pool,
  //     capped by maxConcurrentTotal + maxConcurrentPerProject, alongside
  //     story frontend/backend agents.
  //   - drafter (PRD draft) → spec pool, capped by maxConcurrentSpecWriter,
  //     alongside story spec-writers.
  //   - audit-runner (read-only scan) → its own audit-run pool.
  // These counters are mutable seeds — bumped as we dispatch below.
  const pools = await countActivePools(db);
  let implInProgress = pools.impl;
  const implByProject = pools.implByProject;
  let specInProgress = pools.spec;
  let auditRunInProgress = pools.auditRun;

  const freeSlots = () => getConcurrencyCap() - countClaudeProcesses();

  // Project repoPath lookup, fetched once.
  const projects = await db.select().from(schema.projects);
  const repoByProject = new Map(projects.map((p) => [p.id, expandTilde(p.repoPath)]));
  // Folder-level ignore (`prdIgnoredFolders`) is curated per project and, until
  // now, only filtered the UI scan — leaving stale rows under those folders
  // (agent prompt templates in `prompts/`, scaffolding in `recipes/`, …) still
  // dispatchable here. Honor it as a dispatch gate so ignored folders are never
  // drafted/implemented, matching the scan.
  const ignoredFoldersByProject = new Map(
    projects.map((p) => [
      p.id,
      (p.prdIgnoredFolders ?? []).map((f) => f.replace(/^\/+|\/+$/g, "")),
    ]),
  );
  const isUnderIgnoredFolder = (projectId: string, rel: string): boolean =>
    (ignoredFoldersByProject.get(projectId) ?? []).some(
      (f) => rel === f || rel.startsWith(`${f}/`),
    );

  // ── PRD pass: read+parse each doc ONCE, classify into draft-vs-implement,
  // handling the settle gate and prose-skip inline. Then dispatch IMPLEMENTERS
  // FIRST (priority over the drafting backlog) — so a big drafting backlog can
  // never crowd full-stack-engineer out of the shared impl-pipeline budget.
  const prds = await db.select().from(schema.prds);
  const toDraft: (typeof prds)[number][] = [];
  const toImplement: (typeof prds)[number][] = [];
  // Limbo docs the drafter must re-examine. Two shapes, both re-engaged the
  // same way (one re-draft attempt per distinct content hash, gated on
  // `limboCheckedHash`):
  //   - "untagged-outstanding": outstanding line-items that are neither `[IMP]`
  //     (no implementer can pick them up) nor backed by an open `❓` (the human
  //     was never asked) — drive each into `[IMP]` / `❓` / split-out PRD.
  //   - "unitemized": the drafter ran a full pass (`[dedup]` recorded) yet left
  //     the doc with ZERO line-items and no open questions. A zero-item PRD is
  //     definitionally still in drafting — the requirements were never atomized
  //     (a shipped/reference doc must be atomized into `- [x]` done items, per
  //     the drafter's prime invariant), so "complete" can never trip and the doc
  //     would otherwise fall through every branch and sit forever.
  // Carries the content hash so the dispatch loop can stamp `limboCheckedHash`
  // and log the event.
  const toResolveLimbo: {
    prd: (typeof prds)[number];
    hash: string;
    outstanding: number;
    reason: "untagged-outstanding" | "unitemized";
  }[] = [];
  for (const prd of prds) {
    if (prd.ignoredAt != null) continue;
    // orca only ingests PRDs from a project's `product/` dir. Stale rows from
    // before that rule (or any non-product .md still in the table) must never be
    // drafted/implemented — mirror the disk scan's scope here.
    if (!isUnderProductDir(prd.relPath)) continue;
    if (isUnderIgnoredFolder(prd.projectId, prd.relPath)) continue;
    if (prd.dispatchPid != null || isDispatchLifecycleActive(prd.id)) continue;
    const repo = repoByProject.get(prd.projectId);
    if (!repo) continue;
    const content = await readFile(join(repo, prd.relPath), "utf8").catch(() => null);
    if (content == null) continue; // file deleted

    const hash = sha256(content);
    // A fresh change resets the settle timer (and establishes the baseline on
    // first sight). While a file is actively changing we do nothing with it.
    if (hash !== prd.lastSeenHash) {
      await db
        .update(schema.prds)
        .set({ lastSeenHash: hash, lastChangeAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.prds.id, prd.id));
      continue;
    }
    // Manually stopped — stay paused until the file changes again (the branch
    // above bumps lastChangeAt past the stop) or a manual dispatch clears the
    // flag. Without this, the heartbeat would re-draft/re-implement on the very
    // next tick, making the Stop button a no-op.
    if (
      prd.dispatchStoppedAt != null &&
      (prd.lastChangeAt == null ||
        prd.lastChangeAt.getTime() <= prd.dispatchStoppedAt.getTime())
    ) {
      continue;
    }
    // Per-agent settle/debounce: drafting waits for the shorter window, impl for
    // the longer one — both measured from the last edit (lastChangeAt).
    const settledFor = prd.lastChangeAt ? Date.now() - prd.lastChangeAt.getTime() : Infinity;
    const draftSettled = settledFor >= PRD_DRAFT_SETTLE_MS;
    const implementSettled = settledFor >= PRD_IMPLEMENT_SETTLE_MS;

    const parse = parsePrdDoc(content);
    // Whole-doc iceboxed = parked: never draft or implement it. It re-enters the
    // pipeline automatically once the user removes the first-line [ICEBOX]
    // (which changes the hash → fresh-change branch above).
    if (parse.iceboxed) continue;
    // "Drafted" = the drafter actually ran (lastProcessedAt). lastProcessedHash
    // alone isn't enough — legacy rows were baseline-stamped without running.
    const neverDrafted = prd.lastProcessedAt == null;
    const changedSinceDraft = !neverDrafted && hash !== prd.lastProcessedHash;
    const isPrd = looksLikePrd(prd.relPath, parse, content);
    // First-round sweep: an active PRD that has never had its duplication check
    // run is forced through the drafter BEFORE it can be implemented — so legacy
    // docs describing already-built features don't get rebuilt. The drafter
    // stamps `[dedup]` into History, flipping this false and ending the sweep
    // for that doc. (Iceboxed/ignored docs already `continue`d out above.)
    const needsDedupPass = isPrd && !parse.dedupVerified;

    if ((neverDrafted && isPrd) || changedSinceDraft || needsDedupPass) {
      if (draftSettled) toDraft.push(prd); // else: still settling, wait
    } else if (neverDrafted && !isPrd) {
      if (draftSettled) {
        // Plain prose (KB/FAQ/marketing) — mark processed so we never rewrite
        // it and stop re-reading it every tick.
        await db
          .update(schema.prds)
          .set({ lastProcessedHash: hash, lastProcessedAt: new Date(), updatedAt: new Date() })
          .where(eq(schema.prds.id, prd.id));
      }
    } else if (parse.hasImplementableWork) {
      if (implementSettled) toImplement.push(prd); // else: wait out the impl window
    } else if (
      isPrd &&
      parse.bullets.outstanding - parse.bullets.ready - parse.bullets.iceboxed >
        0 &&
      parse.bullets.ready === 0 &&
      parse.outstandingQuestions === 0 &&
      hash !== prd.limboCheckedHash
    ) {
      // ── Limbo re-engagement ────────────────────────────────────────────
      // The doc is drafted, dedup'd, settled, and unchanged — yet it has
      // outstanding line-items with NOTHING tagged `[IMP]` (no implementer can
      // grab them) and NO open `❓` (the human was never asked). This is the
      // silent-death state: an agent "waiting for approval" but never raising
      // the request, so the doc sits "outstanding" forever and bubbles up
      // nowhere. None of the branches above fire, so without this it is never
      // looked at again. Re-dispatch the drafter to drive every limbo bullet
      // into `[IMP]` / `❓` / `[ICEBOX]` per its prompt. Gated on
      // `hash !== limboCheckedHash` so the drafter gets exactly one attempt per
      // distinct content state — if it makes no edit, the hash is unchanged and
      // we do NOT re-loop every settle window; a real human/file edit (new
      // hash) re-arms it.
      if (draftSettled) {
        toResolveLimbo.push({
          prd,
          hash,
          outstanding: parse.bullets.outstanding,
          reason: "untagged-outstanding",
        });
      }
    } else if (
      parse.dedupVerified &&
      parse.bullets.total === 0 &&
      parse.outstandingQuestions === 0 &&
      hash !== prd.limboCheckedHash
    ) {
      // ── Unitemized re-engagement ───────────────────────────────────────
      // The drafter ran a full pass on this doc (it stamped `[dedup]`, which
      // ONLY the drafter writes) but left it with ZERO line-items and no open
      // `❓`. A zero-item PRD is definitionally still in drafting — the
      // requirements were never atomized. Per the drafter's prime invariant a
      // shipped/reference doc must be atomized into `- [x]` done items (each
      // with the implementing path) so "done" is verifiable per item; a prose
      // "no outstanding work" claim is not that. Without re-engagement the doc
      // matches none of the branches above: `completed` can't trip (it needs
      // `total > 0`), there's no implementable work, and the untagged-outstanding
      // limbo needs `outstanding > 0`. So it silently sits forever. Re-dispatch
      // the drafter to itemize. `dedupVerified` (not the content-derived `isPrd`,
      // which a zero-item doc fails) is the authoritative "this was drafted as a
      // PRD" signal. Same per-hash gate as limbo: one attempt per content state.
      if (draftSettled) {
        toResolveLimbo.push({ prd, hash, outstanding: 0, reason: "unitemized" });
      }
    }
  }

  // Implementers first — impl-pipeline budget (total + per-project), priority
  // over the drafting backlog. `continue` (not `break`) on the per-project cap
  // so a PRD in a different, non-saturated project later in the list still gets
  // a chance; `break` on the global total cap since nothing else can fit.
  for (const prd of toImplement) {
    if (freeSlots() <= 0 || implInProgress >= throttle.maxConcurrentTotal) break;
    const projCount = implByProject.get(prd.projectId) ?? 0;
    if (projCount >= throttle.maxConcurrentPerProject) continue;
    console.log(`[orca/heartbeat] PRD ${prd.relPath} has [IMP] work → full-stack-engineer (1 item)`);
    runPrdDispatch({ db, prdId: prd.id, mode: "implement", trigger: "heartbeat-pickup" }).catch((err) =>
      console.error(`[orca/heartbeat] prd implement failed ${prd.id}:`, err),
    );
    implInProgress++;
    implByProject.set(prd.projectId, projCount + 1);
  }
  // Then drafters — spec-writer budget, shared with story spec-writers.
  for (const prd of toDraft) {
    if (specInProgress >= throttle.maxConcurrentSpecWriter || freeSlots() <= 0) break;
    console.log(`[orca/heartbeat] PRD ${prd.relPath} → drafter`);
    runPrdDispatch({ db, prdId: prd.id, mode: "draft", trigger: "heartbeat-pickup" }).catch((err) =>
      console.error(`[orca/heartbeat] prd draft failed ${prd.id}:`, err),
    );
    specInProgress++;
  }
  // Finally, limbo re-engagement — same spec-writer budget. Stamp
  // `limboCheckedHash` AT dispatch (not at classification) so a tick that runs
  // out of budget or slots doesn't burn this doc's single per-hash attempt
  // without the drafter actually running. The stamp + activity event make the
  // re-engagement visible in the PRD's timeline.
  for (const { prd, hash, outstanding, reason } of toResolveLimbo) {
    if (specInProgress >= throttle.maxConcurrentSpecWriter || freeSlots() <= 0) break;
    const reasonText =
      reason === "unitemized"
        ? "drafted (dedup'd) but zero line-items and no open question — never itemized; re-dispatching drafter to atomize the requirements into [x] / [IMP] / ❓"
        : "outstanding items but nothing tagged [IMP] and no open question — re-dispatching drafter to resolve each into [IMP] / ❓ / [ICEBOX]";
    console.log(
      reason === "unitemized"
        ? `[orca/heartbeat] PRD ${prd.relPath} drafted but unitemized (0 items, 0 open ❓) → drafter`
        : `[orca/heartbeat] PRD ${prd.relPath} in limbo (${outstanding} outstanding, 0 [IMP], 0 open ❓) → drafter`,
    );
    await db
      .update(schema.prds)
      .set({ limboCheckedHash: hash, updatedAt: new Date() })
      .where(eq(schema.prds.id, prd.id));
    await db.insert(schema.activityEvents).values({
      storyId: null,
      targetKind: "prd",
      targetId: prd.id,
      kind: "prd_limbo_reengaged",
      actor: "heartbeat",
      payload: sanitizeForJsonb({
        relPath: prd.relPath,
        outstanding,
        reason: reasonText,
      }),
    });
    runPrdDispatch({ db, prdId: prd.id, mode: "draft", trigger: "heartbeat-limbo" }).catch((err) =>
      console.error(`[orca/heartbeat] prd limbo re-draft failed ${prd.id}:`, err),
    );
    specInProgress++;
  }

  // ── Audit pickup: scheduled runs, then fix open fails ──────────────────
  const checks = await db.select().from(schema.auditChecks);
  const now = Date.now();
  for (const check of checks) {
    if (check.dispatchPid != null || isDispatchLifecycleActive(check.id)) continue;
    if (freeSlots() <= 0) break;

    // Manual stop pauses auto-pickup. A scheduled run resumes only once its due
    // time advances past the stop (rescheduling, or the next slot after a run);
    // open-fail fixes resume only after a fresh run clears dispatchStoppedAt.
    const stoppedAt = check.dispatchStoppedAt?.getTime() ?? null;

    // Scheduled run due? (audit-runner cap)
    if (check.nextRunAt && check.nextRunAt.getTime() <= now) {
      if (stoppedAt != null && check.nextRunAt.getTime() <= stoppedAt) continue;
      if (auditRunInProgress >= throttle.maxConcurrentAudit) continue;
      console.log(`[orca/heartbeat] audit ${check.slug} scheduled run due`);
      runAuditDispatch({ db, auditCheckId: check.id, mode: "run", trigger: "heartbeat-schedule" }).catch((err) =>
        console.error(`[orca/heartbeat] audit run failed ${check.id}:`, err),
      );
      auditRunInProgress++;
      continue;
    }

    // Paused by a manual stop — skip open-fail auto-fix until a new run resumes it.
    if (stoppedAt != null) continue;

    // Open fails to fix? full-stack-engineer draws from the impl-pipeline
    // budget (total + per-project), shared with stories and PRD implement.
    if (implInProgress >= throttle.maxConcurrentTotal) continue;
    const auditProjCount = implByProject.get(check.projectId) ?? 0;
    if (auditProjCount >= throttle.maxConcurrentPerProject) continue;
    const [openFail] = await db
      .select({ id: schema.auditFindings.id })
      .from(schema.auditFindings)
      .where(
        and(
          eq(schema.auditFindings.auditCheckId, check.id),
          eq(schema.auditFindings.kind, "fail"),
          eq(schema.auditFindings.status, "open"),
        ),
      )
      .limit(1);
    if (openFail) {
      console.log(`[orca/heartbeat] audit ${check.slug} has open fails → full-stack-engineer`);
      runAuditDispatch({ db, auditCheckId: check.id, mode: "fix", trigger: "heartbeat-pickup" }).catch((err) =>
        console.error(`[orca/heartbeat] audit fix failed ${check.id}:`, err),
      );
      implInProgress++;
      implByProject.set(check.projectId, auditProjCount + 1);
    }
  }
}

// Handle to the active heartbeat timer, stashed on globalThis so it
// survives vite-node --watch re-evaluations. vite-node re-evaluates
// index.ts (and everything it imports) on any watched-file change, which
// re-invokes startHeartbeat with a fresh module instance — a module-scoped
// `let` would reset to null and lose the prior handle. Node keeps the old
// timer alive in the event loop, so without persistent tracking each
// re-eval leaks another setInterval, and within minutes you have N timers
// all firing tick() at independent offsets.
const TIMER_KEY = "__orcaHeartbeatTimer";
type TimerHandle = ReturnType<typeof setInterval>;
type GlobalWithTimer = typeof globalThis & {
  [TIMER_KEY]?: TimerHandle | null;
};

/**
 * Starts the heartbeat loop. Returns a cleanup function to stop it.
 */
export function startHeartbeat(
  db: OrcaDb,
  intervalMs = 60 * 1000,
): () => void {
  const g = globalThis as GlobalWithTimer;
  if (g[TIMER_KEY]) {
    clearInterval(g[TIMER_KEY]);
    g[TIMER_KEY] = null;
    console.log("[orca/heartbeat] cleared previous timer before restart");
  }

  console.log(
    `[orca/heartbeat] starting heartbeat loop (interval: ${intervalMs}ms)`,
  );

  const timer = setInterval(() => {
    tick(db, intervalMs).catch((err) => {
      console.error("[orca/heartbeat] tick failed:", err);
    });
  }, intervalMs);
  g[TIMER_KEY] = timer;

  // Run one tick immediately on startup to catch anything that died while
  // the server was down.
  tick(db, intervalMs).catch((err) => {
    console.error("[orca/heartbeat] initial tick failed:", err);
  });

  return () => {
    if (g[TIMER_KEY]) {
      clearInterval(g[TIMER_KEY]);
      g[TIMER_KEY] = null;
    }
    console.log("[orca/heartbeat] stopped");
  };
}
