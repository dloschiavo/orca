import { eq, and, isNotNull, sql, asc, inArray } from "drizzle-orm";
import { schema } from "@orca/db";
import type { OrcaDb, DispatchState } from "@orca/db";
import type { StoryStatus } from "@orca/shared";
import { runClaudeDispatch, isDispatchLifecycleActive } from "../routes/stories.js";
import { resolveModelForStory } from "../agents/model.js";
import { isConcurrencyExceeded, countClaudeProcesses, getConcurrencyCap, isRateLimited, getRateLimitInfo } from "./concurrency.js";
import { handleDispatchRejection } from "./dispatch-rejection.js";

const MAX_FAIL_COUNT = 3;

/** Check whether a process with the given PID is still running. */
function isPidAlive(pid: number): boolean {
  try {
    // signal 0 doesn't kill — it just checks if the process exists.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
      agent: story.agent ?? "triage",
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
  // Find in_progress stories that have a PID attached.
  const storiesWithPid = await db
    .select()
    .from(schema.stories)
    .where(
      and(
        eq(schema.stories.status, "in_progress" as StoryStatus),
        isNotNull(schema.stories.dispatchPid),
      ),
    );

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
  // Find in_progress stories whose most recent activity event is older than
  // one heartbeat interval ago. These may have a hung or silently-dead agent.
  const cutoff = new Date(Date.now() - intervalMs);

  const allInProgress = await db
    .select()
    .from(schema.stories)
    .where(eq(schema.stories.status, "in_progress" as StoryStatus));

  for (const story of allInProgress) {
    if (handledIds.has(story.id)) continue;

    // Same lifecycle guard as the dead-PID loop: if Node is still actively
    // running the dispatch lifecycle for this story (do-er, QA, retry),
    // don't let stale-activity detection steal it out from under the
    // in-flight dispatch. QA can legitimately produce no activity events
    // for longer than the heartbeat interval while it waits for its own
    // claude child to return JSON.
    if (isDispatchLifecycleActive(story.id)) {
      console.log(
        `[orca/heartbeat] story ${story.id} stale-check skipped — lifecycle is active`,
      );
      continue;
    }

    // Check for any activity within the heartbeat interval.
    const [recent] = await db
      .select({ id: schema.activityEvents.id })
      .from(schema.activityEvents)
      .where(
        and(
          eq(schema.activityEvents.storyId, story.id),
          sql`${schema.activityEvents.createdAt} >= ${cutoff.toISOString()}`,
        ),
      )
      .limit(1);

    if (recent) continue;

    // No activity in the last interval — story is stale.
    console.log(
      `[orca/heartbeat] story ${story.id} has no activity since ${cutoff.toISOString()}, recovering...`,
    );

    // Kill the process if it's still alive.
    const pid = story.dispatchPid;
    if (pid != null && isPidAlive(pid)) {
      console.log(
        `[orca/heartbeat] killing stale process ${pid} for story ${story.id}`,
      );
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Process may have exited between check and kill — ignore.
      }
    }

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
    // `backlog` = new story waiting for its first agent. `in_qa` = do-er
    // finished and qa-tester is next. `final_review` is intentionally excluded
    // — it's a human gate, not an automation state. `in_progress`, `done`,
    // `canceled`, `blocked`, `icebox` are never picked up here. Agents can
    // still hand off explicitly via POST /api/stories/:id/wake to skip the
    // next heartbeat interval.
    const openStories = await db
      .select()
      .from(schema.stories)
      .where(
        inArray(schema.stories.status, [
          "backlog",
          "in_qa",
        ] as StoryStatus[]),
      )
      .orderBy(asc(schema.stories.createdAt));

    // Assign triage to any story that has no agent set.
    for (const story of openStories.filter((s) => !s.agent)) {
      await db
        .update(schema.stories)
        .set({ agent: "triage", updatedAt: new Date() })
        .where(eq(schema.stories.id, story.id));
    }

    // Filter to stories not already running in this Node process.
    const dispatchable = openStories
      .map((s) => (s.agent ? s : { ...s, agent: "triage" }))
      .filter((s) => !isDispatchLifecycleActive(s.id));

    // How many slots are free?
    const slots = getConcurrencyCap() - countClaudeProcesses();

    // Dispatch assigned stories up to the concurrency cap.
    if (slots > 0) {
      const assigned = dispatchable.filter((s) => !!s.agent);
      let dispatched = 0;

      for (const story of assigned) {
        if (dispatched >= slots) break;

        const [project] = await db
          .select()
          .from(schema.projects)
          .where(eq(schema.projects.id, story.projectId));
        if (!project) continue;

        console.log(
          `[orca/heartbeat] picking up ${story.status} story ${story.id} (agent: ${story.agent}, slot ${dispatched + 1}/${slots})`,
        );

        const previousPickupStatus = story.status;

        await db
          .update(schema.stories)
          .set({
            status: "in_progress" as StoryStatus,
            dispatchedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.stories.id, story.id));

        const pickupModel = await resolveModelForStory(db, story.id);

        if (previousPickupStatus !== "in_progress") {
          await db.insert(schema.activityEvents).values({
            storyId: story.id,
            kind: "state_transition",
            actor: "heartbeat",
            payload: { status: "in_progress", from: previousPickupStatus, reason: "heartbeat_pickup" },
          });
        }

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
        }).catch((err) =>
          handleDispatchRejection(db, story.id, err, {
            context: "pickup dispatch failed",
            revertStatus: true,
            actor: "heartbeat",
          }),
        );

        dispatched++;
      }
    }
  }
}

/**
 * Starts the heartbeat loop. Returns a cleanup function to stop it.
 */
export function startHeartbeat(
  db: OrcaDb,
  intervalMs = 5 * 60 * 1000,
): () => void {
  console.log(
    `[orca/heartbeat] starting heartbeat loop (interval: ${intervalMs}ms)`,
  );

  const timer = setInterval(() => {
    tick(db, intervalMs).catch((err) => {
      console.error("[orca/heartbeat] tick failed:", err);
    });
  }, intervalMs);

  // Run one tick immediately on startup to catch anything that died while
  // the server was down.
  tick(db, intervalMs).catch((err) => {
    console.error("[orca/heartbeat] initial tick failed:", err);
  });

  return () => {
    clearInterval(timer);
    console.log("[orca/heartbeat] stopped");
  };
}
