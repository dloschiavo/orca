import { eq } from "drizzle-orm";
import { schema } from "@orca/db";
import type { OrcaDb } from "@orca/db";
import type { StoryStatus } from "@orca/shared";

const MAX_FAIL_COUNT = 3;

/**
 * Handle a synchronous-or-promise rejection from a fire-and-forget
 * `runClaudeDispatch` call. Without this, a dispatch that throws between
 * `dispatch_started` and `agent_spawned` (e.g. the cache-stability prompt
 * guard) leaves the story stuck `implementing` with no PID, no
 * `dispatch_failed` event, and invisible in the UI.
 *
 * Logs `dispatch_failed`, bumps `dispatchFailCount`, and either rolls the
 * story back to `backlog` (so the next heartbeat tick can retry) or marks
 * it `blocked` once failures hit MAX_FAIL_COUNT.
 *
 * `revertStatus = false` is for the adoption path, where the previous
 * Node process spawned a detached child that may still be alive; touching
 * the row's status would race with the live child's own state writes.
 * In that case we still log the failure so it's visible and let
 * stale-activity detection take over on the next tick.
 */
export async function handleDispatchRejection(
  db: OrcaDb,
  storyId: string,
  err: unknown,
  ctx: { context: string; revertStatus: boolean; actor?: string },
): Promise<void> {
  const errMsg = err instanceof Error ? err.message : String(err);
  const actor = ctx.actor ?? "system";
  console.error(`[orca] ${ctx.context} for story ${storyId}:`, err);

  await db.insert(schema.activityEvents).values({
    storyId,
    kind: "dispatch_failed",
    actor,
    payload: { context: ctx.context, error: errMsg },
  }).catch((logErr) => {
    console.error(`[orca] failed to log dispatch_failed for ${storyId}:`, logErr);
  });

  if (!ctx.revertStatus) return;

  const [current] = await db
    .select({ dispatchFailCount: schema.stories.dispatchFailCount })
    .from(schema.stories)
    .where(eq(schema.stories.id, storyId));
  const newFailCount = (current?.dispatchFailCount ?? 0) + 1;

  if (newFailCount >= MAX_FAIL_COUNT) {
    await db
      .update(schema.stories)
      .set({
        status: "blocked" as StoryStatus,
        dispatchPid: null,
        dispatchedAt: null,
        dispatchFailCount: newFailCount,
        blockedReason: `Dispatch failed ${newFailCount}x synchronously: ${errMsg}`,
        updatedAt: new Date(),
      })
      .where(eq(schema.stories.id, storyId));
    await db.insert(schema.activityEvents).values({
      storyId,
      kind: "state_transition",
      actor,
      payload: { status: "blocked", reason: `dispatch failed ${newFailCount}x` },
    });
    return;
  }

  await db
    .update(schema.stories)
    .set({
      status: "backlog" as StoryStatus,
      dispatchPid: null,
      dispatchedAt: null,
      dispatchFailCount: newFailCount,
      updatedAt: new Date(),
    })
    .where(eq(schema.stories.id, storyId));
  await db.insert(schema.activityEvents).values({
    storyId,
    kind: "state_transition",
    actor,
    payload: { status: "backlog", from: "implementing", reason: "dispatch_failed_revert" },
  });
}
