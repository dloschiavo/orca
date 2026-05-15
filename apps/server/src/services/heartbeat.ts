import { eq, and, isNotNull, sql, inArray } from "drizzle-orm";
import { schema } from "@orca/db";
import type { OrcaDb, DispatchState } from "@orca/db";
import type { StoryStatus } from "@orca/shared";
import { runClaudeDispatch, isDispatchLifecycleActive } from "../routes/stories.js";
import { resolveModelForStory } from "../agents/model.js";
import { isConcurrencyExceeded, countClaudeProcesses, getConcurrencyCap, isRateLimited, getRateLimitInfo } from "./concurrency.js";
import { handleDispatchRejection } from "./dispatch-rejection.js";
import { getThrottleSettings } from "./throttle.js";
import { isPidAlive } from "./pid.js";

const MAX_FAIL_COUNT = 3;

// Activity-event actors that are NOT proof of agent life. The reaper uses
// *agent activity* — events written by the dispatched claude process — as
// the signal that a story is still progressing. Heartbeat / system / user
// / auditor events are bookkeeping noise and must not keep a wedged agent
// alive: without this filter the reaper feedback-loops on its own
// `concurrency_deferred` / `dispatch_started` writes.
const NON_AGENT_ACTORS = ["heartbeat", "system", "user", "auditor"];

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
      payload: {
        status: "planning",
        from: story.status,
        reason: "blocked_by_open_question",
      },
    });
    return;
  }

  const newFailCount = story.dispatchFailCount + 1;

  // Log recovery event.
  await db.insert(schema.activityEvents).values({
    storyId: story.id,
    kind: "heartbeat_recovery",
    actor: "heartbeat",
    payload: {
      reason,
      deadPid,
      failCount: newFailCount,
      maxFailCount: MAX_FAIL_COUNT,
    },
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
      payload: {
        status: "blocked",
        reason: `Agent process died ${newFailCount} times`,
      },
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
    payload: {
      repoPath: project.repoPath,
      adapter: "claude-local",
      trigger: "heartbeat-recovery",
      attempt: newFailCount + 1,
      agent: story.agent ?? "spec-writer",
      ...(recoveryModel ? { model: recoveryModel } : {}),
    },
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
      payload: {
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
      },
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

    // Load throttle settings and count currently-dispatching stories. The
    // mutex is `dispatchPid IS NOT NULL` — not status — because heartbeat
    // doesn't change status. A story is "actively dispatched" if it has a
    // tracked PID (set inside runClaudeDispatch as soon as the spawn lands).
    const throttle = await getThrottleSettings(db);
    const currentlyInProgress = await db
      .select({
        id: schema.stories.id,
        projectId: schema.stories.projectId,
        agent: schema.stories.agent,
        status: schema.stories.status,
      })
      .from(schema.stories)
      .where(isNotNull(schema.stories.dispatchPid));

    // Mutable counters: updated as we dispatch so per-story checks stay accurate.
    //
    // `throttleTotalInProgress` and `throttleByProject` represent the
    // *impl pipeline* footprint — every active dispatch EXCEPT spec-writer
    // and qa-tester. Both of those have their own independent caps and
    // must not burn impl-pipeline slots (per-project or global), otherwise
    // a project with a spec-writer or a qa-tester running blocks its own
    // frontend/backend agent from being picked up — and the impl-pipeline
    // cap being saturated would in turn block spec-writer / qa-tester
    // dispatches that should run regardless.
    const implPipelineInProgress = currentlyInProgress.filter(
      (s) => s.agent !== "spec-writer" && s.agent !== "qa-tester",
    );
    let throttleTotalInProgress = implPipelineInProgress.length;
    const throttleByProject = new Map<string, number>();
    // Count of QA-tester agents actively running. QA spikes system load —
    // cap how many can run simultaneously. Independent of impl pipeline.
    let throttleQaInProgress = currentlyInProgress.filter(
      (s) => s.agent === "qa-tester",
    ).length;
    // Count of spec-writer agents actively running. Capped separately
    // because spec-writer dispatches are independent of the implementing
    // pipeline — they don't compete for per-project slots but the system
    // has its own ceiling.
    let throttleSpecWriterInProgress = currentlyInProgress.filter(
      (s) => s.agent === "spec-writer",
    ).length;
    for (const s of implPipelineInProgress) {
      throttleByProject.set(
        s.projectId,
        (throttleByProject.get(s.projectId) ?? 0) + 1,
      );
    }

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
            payload: {
              trigger: "throttle-spec-writer",
              specWriterInProgress: throttleSpecWriterInProgress,
              maxConcurrentSpecWriter: throttle.maxConcurrentSpecWriter,
              reason: `spec-writer throttle limit reached (${throttleSpecWriterInProgress}/${throttle.maxConcurrentSpecWriter})`,
            },
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
            payload: {
              trigger: "throttle-total",
              totalInProgress: throttleTotalInProgress,
              maxConcurrentTotal: throttle.maxConcurrentTotal,
              reason: `total impl-pipeline throttle limit reached (${throttleTotalInProgress}/${throttle.maxConcurrentTotal})`,
            },
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
            payload: {
              trigger: "throttle-qa",
              qaInProgress: throttleQaInProgress,
              maxConcurrentQa: throttle.maxConcurrentQa,
              reason: `QA throttle limit reached (${throttleQaInProgress}/${throttle.maxConcurrentQa}) — staying in qa`,
            },
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
            payload: {
              trigger: "throttle-per-project",
              projectInProgress,
              maxConcurrentPerProject: throttle.maxConcurrentPerProject,
              reason: `per-project throttle limit reached (${projectInProgress}/${throttle.maxConcurrentPerProject})`,
            },
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
          payload: {
            repoPath: project.repoPath,
            adapter: "claude-local",
            trigger: "heartbeat-pickup",
            fromStatus: story.status,
            claudeProcessCount: countClaudeProcesses(),
            concurrencyCap: getConcurrencyCap(),
            agent: story.agent,
            ...(pickupModel ? { model: pickupModel } : {}),
          },
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
