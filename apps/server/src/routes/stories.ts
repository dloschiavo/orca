import { Hono } from "hono";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, stat, mkdir, open as fsOpen, readFile, utimes, rm } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { and, desc, eq, isNotNull, max, sql } from "drizzle-orm";
import { schema } from "@orca/db";
import { z } from "zod";
import type { StoryStatus } from "@orca/shared";
import type { OrcaEnv } from "../app.js";
import type { OrcaDb, DispatchState } from "@orca/db";
import type { ChildProcess } from "node:child_process";
import { resolveModelForStory, resolveModelForAgent } from "../agents/model.js";
import { getRegisteredAgentNames, getRegisteredAgentsWithDescriptions, loadPrompt, assertSystemPromptStable, renderPromptLazy, once } from "../services/prompt-loader.js";
import { enforceStoryTokenBudget } from "../services/token-budget.js";
import { isConcurrencyExceeded, countClaudeProcesses, getConcurrencyCap, recordRateLimit, isRateLimited, getRateLimitInfo, recordUsageFraction, persistUsageFraction, extractUsageFraction } from "../services/concurrency.js";
import { extractModelFromStreamResult, extractModelFromCliWrapper } from "../services/token-usage.js";
import { handleDispatchRejection } from "../services/dispatch-rejection.js";

// Track running agent processes so we can interrupt them when a story is edited
// mid-dispatch. Key = storyId.
// Stored on globalThis so vite-node hot-module reloads don't reset the Map —
// if the Map were reset mid-dispatch, heartbeat would see no active lifecycle
// and spawn a second concurrent tail loop on the same log file.
const _g = globalThis as typeof globalThis & {
  _orcaRunningDispatches?: Map<string, ChildProcess>;
  _orcaActiveLifecycles?: Set<string>;
  // Deduplication guard: tracks `${storyId}:${uuid}` keys for agent_stream
  // events that have already been written to the DB this process lifetime.
  // Shared across all concurrent tail loops (including duplicate loops that
  // form when vite-node hot-reloads mid-dispatch) so each Claude event is
  // inserted exactly once regardless of how many readers exist.
  _orcaStreamedUuids?: Set<string>;
};
if (!_g._orcaRunningDispatches) _g._orcaRunningDispatches = new Map<string, ChildProcess>();
if (!_g._orcaActiveLifecycles)  _g._orcaActiveLifecycles  = new Set<string>();
if (!_g._orcaStreamedUuids)     _g._orcaStreamedUuids     = new Set<string>();
const runningDispatches = _g._orcaRunningDispatches;


/**
 * Whether a PID is still running. Local copy of `heartbeat.ts`'s helper —
 * duplicated to avoid a circular import (heartbeat already imports
 * runClaudeDispatch from this file). Used by the adoption-mode exit waiter
 * in `runClaudeDispatch` to poll a detached child whose ChildProcess handle
 * was lost across a Node restart.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill every process associated with a story.
 *
 * Checks three sources in parallel — no status gate, no short-circuit:
 *   1. In-memory ChildProcess handle (most reliable; avoids PID-reuse risk)
 *   2. DB-persisted PID passed in as `dbPid` (survives server restarts)
 *   3. The actual OS process table via `process.kill(pid, 0)` to verify
 *      liveness before sending SIGTERM
 *
 * The cost of leaving an orphan agent running is far higher than the cost
 * of a redundant SIGTERM, so we always attempt all three.
 */
function killStoryProcesses(storyId: string, dbPid: number | null): void {
  const pidsToKill = new Set<number>();

  // 1. In-memory handle — kill directly and evict from the map.
  const child = runningDispatches.get(storyId);
  if (child) {
    if (child.pid != null) pidsToKill.add(child.pid);
    if (!child.killed) child.kill("SIGTERM");
    runningDispatches.delete(storyId);
  }

  // 2. DB-persisted PID (may differ from in-memory if a re-dispatch raced
  //    ahead before the new PID was written to DB, or after a Node restart).
  if (dbPid != null) pidsToKill.add(dbPid);

  // 3. SIGTERM every PID we collected, confirming liveness via signal 0
  //    first so we don't swallow real errors from unrelated failures.
  for (const pid of pidsToKill) {
    try {
      process.kill(pid, 0); // throws if the process is gone
      process.kill(pid, "SIGTERM");
    } catch {
      // Already dead or permission denied — acceptable either way.
    }
  }
}

// In-flight dispatch lifecycle guard. A story is in this set for the entire
// duration of `runClaudeDispatch` — from the moment the function is called
// until it returns — including the post-do-er-exit work (listChangedFiles,
// captureGitDiff, QA gate, QA retry recursion). This is separate from
// `runningDispatches` (which tracks the current child process for
// story-edit-kill) because the lifecycle spans multiple child processes in
// sequence (do-er → QA → retry do-er) and we need heartbeat to skip the
// story during the brief sync gaps between them.
//
// Heartbeat imports `isDispatchLifecycleActive` and refuses to recover any
// story for which Node still has an active lifecycle — the in-memory
// invariant wins over the DB's `dispatchPid` column, because the dispatchPid
// can be a zombie reference to a do-er that already exited while QA is
// actively running. If the Node process itself dies/restarts, the set is
// empty on boot and heartbeat will correctly treat every DB-tracked
// dispatch as orphaned.
// Persisted on globalThis (see runningDispatches above) for the same reason.
const activeLifecycles = _g._orcaActiveLifecycles!;

/**
 * True iff there is a live `runClaudeDispatch` lifecycle actively managing
 * this story in this Node process. Heartbeat recovery must skip these.
 */
export function isDispatchLifecycleActive(storyId: string): boolean {
  return activeLifecycles.has(storyId);
}

// QA cap: how many QA failures we tolerate before marking the story
// `blocked` and filing a meta-finding. The first failure recurses; the
const createStorySchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1),
  specMd: z.string().default(""),
  status: z.enum(["icebox", "backlog"]).default("backlog"),
  agent: z.string().optional(),
  labels: z.array(z.string()).optional(),
  priority: z.number().int().optional(),
});

const updateStorySchema = z.object({
  title: z.string().min(1).optional(),
  specMd: z.string().optional(),
  status: z
    .enum([
      "icebox",
      "backlog",
      "in_progress",
      "in_qa",
      "final_review",
      "blocked",
      "done",
      "canceled",
    ])
    .optional(),
  agent: z.string().nullable().optional(),
  labels: z.array(z.string()).optional(),
  priority: z.number().int().optional(),
  blockedReason: z.string().nullable().optional(),
  /** Who is making this update. Defaults to "user". Agents should pass their agent name. */
  actor: z.string().optional(),
});

export function storiesRoutes(): Hono<OrcaEnv> {
  const app = new Hono<OrcaEnv>();

  app.get("/", async (c) => {
    const db = c.get("db");
    const projectId = c.req.query("projectId");
    const status = c.req.query("status") as StoryStatus | undefined;

    const conditions = [];
    if (projectId) conditions.push(eq(schema.stories.projectId, projectId));
    if (status) conditions.push(eq(schema.stories.status, status));

    const rows = await db
      .select()
      .from(schema.stories)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(schema.stories.updatedAt));

    // For in-progress stories, fetch last activity timestamps in one query.
    const inProgressIds = rows
      .filter((r) => r.status === "in_progress")
      .map((r) => r.id);

    let lastActivityMap: Record<string, string> = {};
    if (inProgressIds.length > 0) {
      const actRows = await db
        .select({
          storyId: schema.activityEvents.storyId,
          lastActivityAt: max(schema.activityEvents.createdAt),
        })
        .from(schema.activityEvents)
        .where(
          sql`${schema.activityEvents.storyId} IN (${sql.join(
            inProgressIds.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        )
        .groupBy(schema.activityEvents.storyId);

      for (const r of actRows) {
        if (r.lastActivityAt) {
          lastActivityMap[r.storyId] = r.lastActivityAt.toISOString();
        }
      }
    }

    const stories = rows.map((r) => ({
      ...r,
      lastActivityAt: lastActivityMap[r.id] ?? null,
    }));

    return c.json({ stories });
  });

  // Lightweight counts grouped by projectId + status (for sidebar badges)
  app.get("/counts", async (c) => {
    const db = c.get("db");
    const rows = await db
      .select({
        projectId: schema.stories.projectId,
        status: schema.stories.status,
        count: sql<number>`cast(count(*) as int)`,
      })
      .from(schema.stories)
      .where(
        sql`${schema.stories.status} IN ('in_progress', 'in_qa', 'final_review')`,
      )
      .groupBy(schema.stories.projectId, schema.stories.status);
    return c.json({ counts: rows });
  });

  app.post("/", async (c) => {
    const body = createStorySchema.parse(await c.req.json());
    const db = c.get("db");
    const now = new Date();
    const [story] = await db
      .insert(schema.stories)
      .values({
        projectId: body.projectId,
        title: body.title,
        specMd: body.specMd,
        status: body.status,
        agent: body.agent ?? "triage",
        labels: body.labels ?? [],
        priority: body.priority ?? 0,
        // Stamp firstBacklogAt when the story is created in backlog status.
        ...(body.status === "backlog" ? { firstBacklogAt: now } : {}),
      })
      .returning();
    if (!story) throw new Error("failed to insert story");

    await db.insert(schema.activityEvents).values({
      storyId: story.id,
      kind: "story_created",
      actor: "user",
      payload: { title: story.title },
    });

    return c.json({ story }, 201);
  });

  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    const db = c.get("db");
    const [story] = await db
      .select()
      .from(schema.stories)
      .where(eq(schema.stories.id, id));
    if (!story) return c.json({ error: "story not found" }, 404);

    // Fetch the current acceptance card (highest version for this story).
    const cards = await db
      .select()
      .from(schema.acceptanceCards)
      .where(eq(schema.acceptanceCards.storyId, id))
      .orderBy(desc(schema.acceptanceCards.version))
      .limit(1);

    // Fetch open refinement questions.
    const questions = await db
      .select()
      .from(schema.refinementQuestions)
      .where(
        and(
          eq(schema.refinementQuestions.storyId, id),
          eq(schema.refinementQuestions.status, "open"),
        ),
      )
      .orderBy(desc(schema.refinementQuestions.priority));

    // Working memory (may not exist yet).
    const [wm] = await db
      .select()
      .from(schema.storyWorkingMemory)
      .where(eq(schema.storyWorkingMemory.storyId, id));

    // Activity feed.
    const events = await db
      .select()
      .from(schema.activityEvents)
      .where(eq(schema.activityEvents.storyId, id))
      .orderBy(desc(schema.activityEvents.createdAt));

    // Backfill empty gitDiff on dispatch_completed events: older dispatches
    // didn't capture diffs when the agent committed (or the repo had no
    // commits). Generate synthetic diffs on-the-fly so the UI can show
    // per-file line counts for historical runs.
    const [project] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, story.projectId));
    const repoPath = project?.repoPath;

    const enrichedEvents = repoPath
      ? await Promise.all(
          events.map(async (e) => {
            if (e.kind !== "dispatch_completed") return e;
            const p = e.payload as Record<string, unknown>;
            const hasFiles =
              Array.isArray(p.changedFiles) && (p.changedFiles as string[]).length > 0;
            const hasDiff = typeof p.gitDiff === "string" && p.gitDiff;
            if (hasFiles && !hasDiff) {
              const synth = await synthDiffForNewFiles(
                repoPath,
                p.changedFiles as string[],
              );
              if (synth) {
                return { ...e, payload: { ...p, gitDiff: synth } };
              }
            }
            return e;
          }),
        )
      : events;

    return c.json({
      story,
      acceptanceCard: cards[0] ?? null,
      refinementQuestions: questions,
      workingMemory: wm ?? null,
      activity: enrichedEvents,
    });
  });

  // GET /api/stories/:id/cost
  //
  // Token-attribution breakdown for the story. Reads token_heatmaps
  // (one row per LLM invocation we instrumented) and returns:
  //   - a flat list of every recorded call, newest first
  //   - per-agent rollups (do-er / qa / classifier)
  //   - per-attempt rollups (so the cost of each QA-retry loop is
  //     visible in isolation)
  //   - grand totals
  //
  // This is the load-bearing endpoint for evaluating whether the
  // token-reduction levers (prompt caching, cheaper models, deterministic
  // shortcuts) actually work — without it, every "this should save
  // tokens" claim is unfalsifiable.
  app.get("/:id/cost", async (c) => {
    const id = c.req.param("id");
    const db = c.get("db");

    const [story] = await db
      .select({ id: schema.stories.id })
      .from(schema.stories)
      .where(eq(schema.stories.id, id));
    if (!story) return c.json({ error: "story not found" }, 404);

    const rows = await db
      .select()
      .from(schema.tokenHeatmaps)
      .where(eq(schema.tokenHeatmaps.storyId, id))
      .orderBy(desc(schema.tokenHeatmaps.createdAt));

    type Bucket = {
      calls: number;
      totalIn: number;
      totalOut: number;
      totalCached: number;
      totalCacheCreation: number;
      totalUncached: number;
      promptBytesSent: number;
    };
    const empty = (): Bucket => ({
      calls: 0,
      totalIn: 0,
      totalOut: 0,
      totalCached: 0,
      totalCacheCreation: 0,
      totalUncached: 0,
      promptBytesSent: 0,
    });
    const add = (b: Bucket, r: typeof rows[number]): Bucket => ({
      calls: b.calls + (r.calls ?? 1),
      totalIn: b.totalIn + (r.totalIn ?? 0),
      totalOut: b.totalOut + (r.totalOut ?? 0),
      totalCached: b.totalCached + (r.totalCached ?? 0),
      totalCacheCreation:
        b.totalCacheCreation + (r.totalCacheCreation ?? 0),
      totalUncached: b.totalUncached + (r.totalUncached ?? 0),
      promptBytesSent:
        b.promptBytesSent + (r.promptBytesSent ?? 0),
    });

    const byAgent: Record<string, Bucket> = {};
    const byAttempt: Record<string, Bucket> = {};
    let total: Bucket = empty();

    for (const r of rows) {
      total = add(total, r);
      const ak = r.agent ?? "do-er";
      byAgent[ak] = add(byAgent[ak] ?? empty(), r);
      const tk = `${ak}/${r.attempt ?? 0}`;
      byAttempt[tk] = add(byAttempt[tk] ?? empty(), r);
    }

    // Cache hit rate is the most important single number for
    // evaluating prompt-caching work — surface it directly so the UI
    // doesn't have to compute it.
    const cacheHitRate =
      total.totalIn > 0 ? total.totalCached / total.totalIn : 0;

    return c.json({
      total: { ...total, cacheHitRate },
      byAgent,
      byAttempt,
      rows,
    });
  });

  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const parsed = updateStorySchema.parse(await c.req.json());
    const db = c.get("db");
    // If no actor was provided, infer it: a PATCH arriving while the story has
    // an active dispatch was almost certainly made by the running agent, not the
    // human.
    const [preCheck] = await db
      .select({ agent: schema.stories.agent, dispatchPid: schema.stories.dispatchPid })
      .from(schema.stories)
      .where(eq(schema.stories.id, id));
    const eventActor =
      parsed.actor ?? (preCheck?.dispatchPid != null ? (preCheck.agent ?? "system") : "user");
    // actor is not a DB column — strip it before building the update set.
    const body = {
      ...(parsed.title !== undefined ? { title: parsed.title } : {}),
      ...(parsed.specMd !== undefined ? { specMd: parsed.specMd } : {}),
      ...(parsed.status !== undefined ? { status: parsed.status } : {}),
      ...(parsed.agent !== undefined ? { agent: parsed.agent } : {}),
      ...(parsed.labels !== undefined ? { labels: parsed.labels } : {}),
      ...(parsed.priority !== undefined ? { priority: parsed.priority } : {}),
      ...(parsed.blockedReason !== undefined ? { blockedReason: parsed.blockedReason } : {}),
    };

    // Read current story before updating so we can detect what changed.
    const [current] = await db
      .select()
      .from(schema.stories)
      .where(eq(schema.stories.id, id));
    if (!current) return c.json({ error: "story not found" }, 404);

    // Stamp firstBacklogAt the first time a story transitions to "backlog"
    // (covers icebox → backlog moves). Only set once — never overwrite an
    // existing value so re-queuing a story doesn't reset the clock.
    const firstBacklogAtUpdate =
      body.status === "backlog" && !current.firstBacklogAt
        ? { firstBacklogAt: new Date() }
        : {};

    const [updated] = await db
      .update(schema.stories)
      .set({ ...body, ...firstBacklogAtUpdate, updatedAt: new Date() })
      .where(eq(schema.stories.id, id))
      .returning();
    if (!updated) return c.json({ error: "story not found" }, 404);

    if (body.status) {
      await db.insert(schema.activityEvents).values({
        storyId: id,
        kind: "state_transition",
        actor: eventActor,
        payload: { status: body.status },
      });

      // If the story is being canceled (or manually blocked), kill all running
      // agent processes immediately.  Without this the agent runs to completion
      // even though the story has been abandoned.
      if (body.status === "canceled" || body.status === "blocked") {
        killStoryProcesses(id, current.dispatchPid);
      }
    }

    // If the agent was reassigned, log an agent_transition.
    const agentChanged =
      body.agent !== undefined && body.agent !== current.agent;
    if (agentChanged) {
      await db.insert(schema.activityEvents).values({
        storyId: id,
        kind: "agent_transition",
        actor: eventActor,
        payload: { from: current.agent, to: body.agent },
      });
    }

    // If spec or title changed, log a story_edited event.
    const specChanged =
      body.specMd !== undefined && body.specMd !== current.specMd;
    const titleChanged =
      body.title !== undefined && body.title !== current.title;

    if (specChanged || titleChanged) {
      await db.insert(schema.activityEvents).values({
        storyId: id,
        kind: "story_edited",
        actor: eventActor,
        payload: {
          ...(titleChanged
            ? { titleFrom: current.title, titleTo: body.title }
            : {}),
          ...(specChanged
            ? { specFrom: current.specMd, specTo: body.specMd }
            : {}),
        },
      });
    }


    // If the story is in_progress and its spec/title changed by a *human*,
    // interrupt the running agent and re-dispatch with an explanation of what
    // changed.  Agent-initiated edits (e.g. spec-writer updating its own spec)
    // must not kill the agent — the agent is doing exactly what it's supposed
    // to do.  eventActor comes from the PATCH body's `actor` field; agents
    // set it to their own name (e.g. "spec-writer"), humans omit it (defaults
    // to "user").
    if (
      current.status === "in_progress" &&
      (specChanged || titleChanged) &&
      eventActor === "user"
    ) {
      killStoryProcesses(id, current.dispatchPid);

      // Fetch project for repoPath.
      const [project] = await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, current.projectId));

      if (project) {
        await db.insert(schema.activityEvents).values({
          storyId: id,
          kind: "dispatch_interrupted",
          actor: "system",
          payload: {
            reason: "story_edited",
            titleChanged,
            specChanged,
          },
        });

        // Build a change summary for the agent.
        const changeParts: string[] = [];
        if (titleChanged) {
          changeParts.push(
            `Title changed from "${current.title}" to "${body.title}".`,
          );
        }
        if (specChanged) {
          changeParts.push(
            `Spec changed.\n\nPrevious spec:\n${current.specMd || "(empty)"}\n\nNew spec:\n${body.specMd || "(empty)"}`,
          );
        }

        runClaudeDispatch({
          db,
          storyId: id,
          repoPath: project.repoPath,
          title: updated.title,
          specMd: updated.specMd,
          changeSummary: changeParts.join("\n\n"),
          trigger: "edit-redispatch",
        }).catch((err) =>
          handleDispatchRejection(db, id, err, {
            context: "re-dispatch after edit failed",
            revertStatus: true,
          }),
        );
      }
    }

    return c.json({ story: updated });
  });

  // POST /api/stories/:id/stop
  //
  // Hard-stop a running dispatch. Only meaningful for stories that are
  // actually running — i.e. status is `in_progress` or `in_qa`. Every other
  // status (icebox, backlog, done, final_review, blocked, canceled) is
  // definitionally already stopped, so /stop is a no-op for those.
  app.post("/:id/stop", async (c) => {
    const id = c.req.param("id");
    const db = c.get("db");

    const [story] = await db
      .select()
      .from(schema.stories)
      .where(eq(schema.stories.id, id));
    if (!story) return c.json({ error: "story not found" }, 404);

    if (story.status !== "in_progress" && story.status !== "in_qa") {
      return c.json({ ok: true, noop: true, status: story.status });
    }

    killStoryProcesses(id, story.dispatchPid);

    const previousStatus = story.status;

    await db
      .update(schema.stories)
      .set({
        status: "blocked" as StoryStatus,
        blockedReason: "Manually stopped by user",
        dispatchPid: null,
        dispatchState: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.stories.id, id));

    await db.insert(schema.activityEvents).values({
      storyId: id,
      kind: "dispatch_interrupted",
      actor: "user",
      payload: { reason: "manual_stop" },
    });

    if (previousStatus !== "blocked") {
      await db.insert(schema.activityEvents).values({
        storyId: id,
        kind: "state_transition",
        actor: "user",
        payload: { status: "blocked", from: previousStatus, reason: "manual_stop" },
      });
    }

    return c.json({ ok: true });
  });

  // POST /api/stories/:id/comment
  //
  // Post a user (or agent) comment on a story. Comments feed into the next
  // dispatch as the user turn (-p) instead of the full spec, enabling back-and-
  // forth turns without resending the entire spec each time.
  //
  // interrupt=true kills the running agent immediately so the comment is picked
  // up right away. interrupt=false (default) queues the comment for the next
  // natural dispatch or completion.
  app.post("/:id/comment", async (c) => {
    const id = c.req.param("id");
    const db = c.get("db");

    const body = await c.req.json().catch(() => ({})) as {
      body?: string;
      interrupt?: boolean;
      actor?: string;
    };
    const commentBody = typeof body.body === "string" ? body.body.trim() : "";
    if (!commentBody) return c.json({ error: "body is required" }, 400);

    const interrupt = body.interrupt === true;
    const actor = typeof body.actor === "string" ? body.actor : "user";

    // Store the comment as an activity event
    await db.insert(schema.activityEvents).values({
      storyId: id,
      kind: "comment",
      actor,
      payload: { body: commentBody, interrupt, acknowledged: false },
    });

    if (interrupt) {
      const [story] = await db
        .select({ dispatchPid: schema.stories.dispatchPid, status: schema.stories.status })
        .from(schema.stories)
        .where(eq(schema.stories.id, id));

      if (story && story.status === "in_progress") {
        killStoryProcesses(id, story.dispatchPid);
        await db
          .update(schema.stories)
          .set({
            status: "backlog" as StoryStatus,
            dispatchPid: null,
            dispatchState: null,
            updatedAt: new Date(),
          })
          .where(eq(schema.stories.id, id));
        await db.insert(schema.activityEvents).values({
          storyId: id,
          kind: "dispatch_interrupted",
          actor: "user",
          payload: { reason: "comment_interrupt" },
        });
        await db.insert(schema.activityEvents).values({
          storyId: id,
          kind: "state_transition",
          actor: "user",
          payload: { status: "backlog", from: "in_progress", reason: "comment_interrupt" },
        });
      }
    }

    return c.json({ ok: true });
  });

  // DELETE /api/stories/:id
  //
  // Hard-delete a story and all child rows (cascade handles FK relations).
  // Kills any in-flight agent process first so it doesn't orphan.
  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const db = c.get("db");

    const [story] = await db
      .select()
      .from(schema.stories)
      .where(eq(schema.stories.id, id));
    if (!story) return c.json({ error: "story not found" }, 404);

    killStoryProcesses(id, story.dispatchPid);

    await db.delete(schema.stories).where(eq(schema.stories.id, id));

    return c.json({ ok: true });
  });

  // POST /api/stories/:id/dispatch
  //
  // MVP agent loop. Spawns `claude` with the story spec as a prompt, in the
  // project's repoPath, with permissions bypassed so it can actually write.
  // Streams stdout/stderr into activity_events as it goes, then captures the
  // resulting git diff and transitions the story to in_qa.
  //
  // Fire-and-forget: we kick the child, return 202, and let the UI poll via
  // GET /stories/:id for activity updates. No queue, no scheduler, no worker —
  // this is the smallest thing that actually does work.
  app.post("/:id/dispatch", async (c) => {
    const id = c.req.param("id");
    const db = c.get("db");

    const [story] = await db
      .select()
      .from(schema.stories)
      .where(eq(schema.stories.id, id));
    if (!story) return c.json({ error: "story not found" }, 404);

    const [project] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, story.projectId));
    if (!project) return c.json({ error: "project not found" }, 404);

    if (story.status === "in_progress") {
      return c.json({ error: "story already in progress" }, 409);
    }

    if (!story.agent) {
      await db
        .update(schema.stories)
        .set({ agent: "triage", updatedAt: new Date() })
        .where(eq(schema.stories.id, id));
      story.agent = "triage";
    }

    const previousStatus = story.status;

    await db
      .update(schema.stories)
      .set({
        status: "in_progress",
        dispatchedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.stories.id, id));

    const resolvedModel = await resolveModelForStory(db, id);

    if (previousStatus !== "in_progress") {
      await db.insert(schema.activityEvents).values({
        storyId: id,
        kind: "state_transition",
        actor: "user",
        payload: { status: "in_progress", from: previousStatus, reason: "manual_dispatch" },
      });
    }

    await db.insert(schema.activityEvents).values({
      storyId: id,
      kind: "dispatch_started",
      actor: "system",
      payload: {
        repoPath: project.repoPath,
        adapter: "claude-local",
        trigger: "manual",
        agent: story.agent,
        ...(resolvedModel ? { model: resolvedModel } : {}),
      },
    });

    runClaudeDispatch({
      db,
      storyId: id,
      repoPath: project.repoPath,
      title: story.title,
      specMd: story.specMd,
      trigger: "manual",
    }).catch((err) =>
      handleDispatchRejection(db, id, err, {
        context: "manual dispatch failed",
        revertStatus: true,
      }),
    );

    return c.json({ ok: true }, 202);
  });

  // Wake: trigger the currently-assigned agent on a story immediately.
  // Agents call this after reassigning a story to hand off without waiting
  // for the next heartbeat tick. Safe to call while the current agent is
  // still running — returns 202 in that case and the heartbeat handles pickup.
  app.post("/:id/wake", async (c) => {
    const id = c.req.param("id");
    const db = c.get("db");

    const [story] = await db
      .select()
      .from(schema.stories)
      .where(eq(schema.stories.id, id));
    if (!story) return c.json({ error: "story not found" }, 404);

    if (
      story.status === "done" ||
      story.status === "blocked" ||
      story.status === "canceled"
    ) {
      return c.json({ error: "story is in a terminal state" }, 409);
    }

    // If a dispatch lifecycle is already active for this story, the agent is
    // still running. Let it finish — heartbeat will pick up the next agent.
    if (isDispatchLifecycleActive(id)) {
      return c.json({ ok: true, message: "agent already running" }, 202);
    }

    const [project] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, story.projectId));
    if (!project) return c.json({ error: "project not found" }, 404);

    if (!story.agent) {
      await db
        .update(schema.stories)
        .set({ agent: "triage", updatedAt: new Date() })
        .where(eq(schema.stories.id, id));
      story.agent = "triage";
    }

    const previousWakeStatus = story.status;

    await db
      .update(schema.stories)
      .set({ status: "in_progress", dispatchedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.stories.id, id));

    const resolvedModel = await resolveModelForStory(db, id);

    if (previousWakeStatus !== "in_progress") {
      await db.insert(schema.activityEvents).values({
        storyId: id,
        kind: "state_transition",
        actor: "system",
        payload: { status: "in_progress", from: previousWakeStatus, reason: "wake" },
      });
    }

    await db.insert(schema.activityEvents).values({
      storyId: id,
      kind: "dispatch_started",
      actor: "system",
      payload: {
        repoPath: project.repoPath,
        adapter: "claude-local",
        trigger: "wake",
        agent: story.agent,
        ...(resolvedModel ? { model: resolvedModel } : {}),
      },
    });

    runClaudeDispatch({
      db,
      storyId: id,
      repoPath: project.repoPath,
      title: story.title,
      specMd: story.specMd,
      trigger: "wake",
    }).catch((err) =>
      handleDispatchRejection(db, id, err, {
        context: "wake dispatch failed",
        revertStatus: true,
      }),
    );

    return c.json({ ok: true }, 202);
  });

  return app;
}

// ---------------------------------------------------------------------------
// claude-local dispatch runner
// ---------------------------------------------------------------------------

export interface DispatchArgs {
  db: OrcaDb;
  storyId: string;
  repoPath: string;
  title: string;
  specMd: string;
  /** When present, the agent is informed that the story was edited mid-flight. */
  changeSummary?: string;
  /** When true, the agent is told this is a recovery — it should try to finish
   *  whatever the previous process left incomplete. */
  isRecovery?: boolean;
  /** Adoption mode: don't spawn a new claude child. Instead, restore state
   *  from a previous detached dispatch (whose PID may still be alive or may
   *  already have exited) and run the tail+completion pipeline against the
   *  existing log files. Used by heartbeat to reap orphans after a Node
   *  restart. When set, runClaudeDispatch skips prompt build, snapshot
   *  capture, and spawn — everything else (tail loop, dispatch_completed)
   *  runs unchanged. */
  adoptExistingPid?: { pid: number; state: DispatchState };
  /** Source that initiated this dispatch — logged to activity. */
  trigger?: "manual" | "wake" | "edit-redispatch" | "heartbeat-pickup" | "heartbeat-recovery" | "heartbeat-adoption";
  /** Internal: set when we're recursing after a --resume failure so the
   *  resume-fallback branch can't fire a second time and loop forever. */
  _resumeFallback?: boolean;
}

export async function runClaudeDispatch(args: DispatchArgs): Promise<void> {
  const {
    db,
    storyId,
    repoPath,
    title,
    specMd,
    changeSummary,
    isRecovery,
    adoptExistingPid,
    trigger,
  } = args;

  // Mark this story as having an active dispatch lifecycle in the current
  // Node process BEFORE any await. Heartbeat checks this set and will skip
  // recovery for any story in it — which is what protects the post-do-er
  // window (QA gate, retry recursion) from spurious "dead PID" recovery.
  // This line MUST be synchronous with the caller so the guard is visible
  // to any heartbeat tick that fires between now and the first await.
  activeLifecycles.add(storyId);
  try {

  const [[storyRow]] = await Promise.all([
    db
      .select({
        claudeSessionId: schema.stories.claudeSessionId,
        claudeSessionSystemPromptHash: schema.stories.claudeSessionSystemPromptHash,
        agent: schema.stories.agent,
        projectId: schema.stories.projectId,
      })
      .from(schema.stories)
      .where(eq(schema.stories.id, storyId)),
  ]);
  let existingSessionId = storyRow?.claudeSessionId ?? null;
  const storedSystemPromptHash = storyRow?.claudeSessionSystemPromptHash ?? null;
  const storyAgent = storyRow?.agent ?? "triage";
  const projectId = storyRow?.projectId ?? "";

  // Validate the agent exists in the registry. If not, fail loudly — never
  // silently fall back to another agent.
  const registeredAgentNames = await getRegisteredAgentNames(db);
  if (!registeredAgentNames.includes(storyAgent)) {
    await db.insert(schema.activityEvents).values({
      storyId,
      kind: "dispatch_failed",
      actor: "system",
      payload: {
        reason: `agent "${storyAgent}" is not registered — set a valid agent before dispatching`,
      },
    });
    return;
  }

  const [agentPromptText, agentSystemPromptText] = await Promise.all([
    loadPrompt(storyAgent as import("@orca/shared").AgentName, "main"),
    loadPrompt(storyAgent as import("@orca/shared").AgentName, "system"),
  ]);
  if (!agentPromptText) throw new Error(`[orca] agent "${storyAgent}" [MAIN] prompt not found at prompts/${storyAgent}.md`);

  // Cache-stability guard: the system prompt is only re-sent on fresh
  // sessions; on --resume, Claude reuses the cached system turn. If the
  // system prompt template contains story- or dispatch-scoped placeholders,
  // its rendered text changes every dispatch, the cache is invalidated,
  // and we pay full input tokens every time. Fail loud at dispatch so
  // prompt edits that would break caching are caught immediately.
  if (agentSystemPromptText) {
    assertSystemPromptStable(storyAgent, agentSystemPromptText);
  }

  const orcaApiUrl = `http://localhost:${process.env.PORT ?? 4455}`;
  const orcaStoriesApi = `\
## Orca Stories API (base: ${orcaApiUrl})

All requests use JSON. No authentication required (local only).

### List stories
GET /api/stories?projectId={story.project_id}[&status=<status>]
→ { stories: Story[] }

### Get story
GET /api/stories/<id>
→ { story: Story, events: ActivityEvent[] }

### Create story
POST /api/stories
Body (all fields except projectId and title are optional):
  projectId  string (uuid)   — required; use "{story.project_id}"
  title      string          — required
  specMd     string          — markdown spec body (default "")
  status     icebox|backlog  — default "backlog"
  labels     string[]
  priority   integer

→ { story: Story }

### Update story
PATCH /api/stories/<id>
Body (all optional):
  title        string
  specMd       string
  status       icebox | backlog | in_progress | in_qa | final_review | blocked | done | canceled
  agent        string | null
  labels       string[]
  priority     integer
  blockedReason string | null
  actor        string   — who is making this update; agents MUST pass their agent name here

→ { story: Story }

### Wake story (trigger assigned agent immediately)
POST /api/stories/<id>/wake
→ { ok: true }  (202)
Use after reassigning a story's agent to hand off without waiting for the
next heartbeat tick. If the story's current agent is already running, returns
202 and the heartbeat handles pickup when it finishes.

### Example — create a story in icebox
\`\`\`bash
curl -s -X POST ${orcaApiUrl}/api/stories \\
  -H "Content-Type: application/json" \\
  -d '{
    "projectId": "{story.project_id}",
    "title": "My new story",
    "specMd": "## Goal\\nDo the thing.",
    "status": "icebox"
  }'
\`\`\`
`;

  const getProject = once(() =>
    db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).then((r) => r[0]),
  );

  const getChangedFiles = once(async () => {
    // Use the story's firstBacklogAt (or createdAt as fallback) as the mtime
    // anchor. This ensures the list reflects all files touched since this story
    // began — across every dispatch — rather than only the most-recent dispatch
    // window, which was causing the QA agent to see an unexpectedly broad or
    // narrow set of files.
    const [storyMeta] = await db
      .select({ firstBacklogAt: schema.stories.firstBacklogAt, createdAt: schema.stories.createdAt })
      .from(schema.stories)
      .where(eq(schema.stories.id, storyId));

    const anchor: Date = storyMeta?.firstBacklogAt ?? storyMeta?.createdAt ?? new Date(0);

    // Write a temp file and stamp its mtime to `anchor` so `find -newer`
    // treats it as the cutoff. Using `join(tmpdir(), ...)` keeps the file
    // on a local filesystem (no network-mount mtime weirdness).
    const anchorFile = join(tmpdir(), `orca-backlog-anchor-${storyId}.tmp`);
    await writeFile(anchorFile, "");
    await utimes(anchorFile, anchor, anchor);

    try {
      return await listChangedFiles(repoPath, anchorFile);
    } finally {
      await rm(anchorFile, { force: true });
    }
  });

  // Scan both prompt texts for {directive.X} vars and add file-read resolvers.
  // Directive files live at ~/Documents/Goliath/orca/recipes/_directives/{x}.md.
  const directivesBase = join(homedir(), "Documents", "Goliath", "orca", "recipes", "_directives");
  const directiveVarPattern = /\{directive\.([a-zA-Z0-9_-]+)\}/g;
  const directiveNames = new Set<string>();
  for (const text of [agentPromptText, agentSystemPromptText ?? ""]) {
    for (const m of text.matchAll(directiveVarPattern)) {
      if (m[1]) directiveNames.add(m[1]);
    }
  }
  // As each directive is resolved, capture its resolved text so we can
  // hash it for cache-provenance logging. A resolver only fires if its
  // placeholder actually appears in one of the rendered prompts, so this
  // map ends up containing exactly the directives that shipped to the
  // agent on this run — the right thing to correlate with cache hits.
  const directiveContents = new Map<string, string>();
  const directiveResolvers: Record<string, () => Promise<string>> = {};
  for (const name of directiveNames) {
    const filePath = join(directivesBase, `${name}.md`);
    directiveResolvers[`directive.${name}`] = async () => {
      const content = await readFile(filePath, "utf8").catch(
        () => `(directive "${name}" not found at ${filePath})`,
      );
      directiveContents.set(name, content);
      return content;
    };
  }

  const promptResolvers = {
    "story.title":      title,
    "story.spec":       specMd || "(no spec provided)",
    "story.id":         storyId,
    "story.project_id": projectId,
    "story.agent":      storyAgent,
    "project.name":     () => getProject().then((p) => p?.name ?? ""),
    "project.repo_path": repoPath,
    "project.rider_path": () => getProject().then((p) => p?.riderPath ?? "CLAUDE.md (default)"),
    "project.context":  () => getProject().then((p) => p?.context ?? ""),
    "project.instructions": () => getProject().then(async (p) => {
      if (!p) return "";
      const riderFile = p.riderPath ?? join(p.repoPath, "CLAUDE.md");
      const content = await readFile(riderFile, "utf8").catch(() => "");
      return content
        ? `Project instructions (CLAUDE.md / rider):\n${content.slice(0, 8000)}`
        : "(no project instructions file found)";
    }),
    "project.file_tree": () => getProject().then((p) => {
      if (!p) return "(file tree unavailable)";
      return new Promise<string>((resolve) => {
        const child = spawn("find", [
          ".", "-maxdepth", "3",
          "-not", "-path", "*/node_modules/*",
          "-not", "-path", "*/.git/*",
          "-not", "-path", "*/dist/*",
          "-not", "-path", "*/.next/*",
          "-not", "-path", "*/build/*",
        ], { cwd: p.repoPath });
        let out = "";
        child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
        child.on("close", () => resolve(out.split("\n").filter(Boolean).slice(0, 200).join("\n")));
        child.on("error", () => resolve("(file tree unavailable)"));
      });
    }),
    "agents.list":      () => getRegisteredAgentsWithDescriptions(db).then((a) => a.join("\n")),
    "orca.api_url":     orcaApiUrl,
    "orca.stories_api": orcaStoriesApi,
    "recovery":         isRecovery ? "true" : "",
    "change_summary":   changeSummary ?? "",
    "findings":         "",
    "files.count": () => getChangedFiles().then((f) => `${f.length} file${f.length === 1 ? "" : "s"}`),
    "files.list":  () => getChangedFiles().then((f) => f.length > 0 ? f.join("\n") : "(no files recorded)"),
    // {directive.X} placeholders resolve to the contents of
    // ~/Documents/Goliath/orca/recipes/_directives/X.md. The resolvers
    // also record the resolved text into `directiveContents` so we can
    // hash it below for cache-provenance logging.
    ...directiveResolvers,
  };

  // Fetch any unacknowledged user comments. For resumed sessions these become
  // the -p (user turn) instead of the full spec, keeping turns small and
  // avoiding a full spec resend every dispatch.
  const pendingComments = await db
    .select({ id: schema.activityEvents.id, payload: schema.activityEvents.payload })
    .from(schema.activityEvents)
    .where(
      and(
        eq(schema.activityEvents.storyId, storyId),
        eq(schema.activityEvents.kind, "comment"),
        sql`(${schema.activityEvents.payload}->>'acknowledged')::boolean = false`,
      ),
    )
    .orderBy(schema.activityEvents.createdAt);

  const [prompt, systemPrompt] = await Promise.all([
    renderPromptLazy(agentPromptText, promptResolvers),
    agentSystemPromptText ? renderPromptLazy(agentSystemPromptText, promptResolvers) : Promise.resolve(null),
  ]);

  // Short sha256 of each directive's resolved text. Stamped onto
  // agent_spawned so cache-hit regressions can be correlated with
  // directive-file edits ("deliverables@a1b2c3" → "@d4e5f6" tells you
  // the content changed between runs). The resolver only populates
  // `directiveContents` for directives whose placeholder actually
  // appeared in the rendered prompt, so this is a faithful inventory
  // of what shipped this run.
  const directiveHashes: Record<string, string> = {};
  for (const [name, content] of directiveContents) {
    directiveHashes[name] = createHash("sha256").update(content).digest("hex").slice(0, 12);
  }

  // Full sha256 of the rendered system prompt. Used to detect when the
  // system-prompt row (or a directive it embeds) has changed since this
  // session was created — in which case Claude's cached system turn is
  // stale and --resume would keep serving the old content. When stale,
  // we drop the session here and fall through to the fresh-spawn path.
  const systemPromptHash = systemPrompt
    ? createHash("sha256").update(systemPrompt).digest("hex")
    : null;

  let sessionDroppedDueToSystemPromptChange = false;
  if (
    existingSessionId &&
    systemPromptHash != null &&
    storedSystemPromptHash != null &&
    storedSystemPromptHash !== systemPromptHash
  ) {
    await db
      .update(schema.stories)
      .set({ claudeSessionId: null, claudeSessionSystemPromptHash: null })
      .where(eq(schema.stories.id, storyId));
    // Inline insert instead of calling logEvent — logEvent is declared
    // a few lines below, and this check has to happen before the spawn
    // decision (which uses existingSessionId). The actor is "system"
    // because the dispatcher, not the agent, is invalidating the session.
    try {
      await db.insert(schema.activityEvents).values({
        storyId,
        kind: "dispatch_interrupted",
        actor: "system",
        payload: {
          reason: "system_prompt_changed",
          previousSessionId: existingSessionId,
          previousSystemPromptHash: storedSystemPromptHash.slice(0, 12),
          currentSystemPromptHash: systemPromptHash.slice(0, 12),
        },
      });
    } catch (err) {
      console.error("[orca] failed to log system_prompt_changed event:", err);
    }
    existingSessionId = null;
    sessionDroppedDueToSystemPromptChange = true;
  }

  // Pending comments are the channel for QA-failure feedback (and any other
  // delta a prior turn left for this dispatch). Two delivery modes:
  //   • Resumed session: replace the -p with just the comment bodies. The
  //     agent already has the full spec in conversation history, so this
  //     keeps the user turn small and avoids a full spec resend.
  //   • Fresh spawn (no session, e.g. agent reassigned by QA): the rendered
  //     prompt already carries the full spec, so we append the comments as
  //     a feedback block instead of replacing — the agent needs both.
  // Either way the comments are marked acknowledged exactly once.
  let effectivePrompt = prompt;
  if (pendingComments.length > 0) {
    const bodies = pendingComments.map((c, i) => {
      const p = c.payload as { body?: string };
      return pendingComments.length === 1 ? (p.body ?? "") : `${i + 1}. ${p.body ?? ""}`;
    });
    if (existingSessionId) {
      effectivePrompt = pendingComments.length === 1
        ? `User comment:\n${bodies[0]}`
        : `The user has sent the following comments:\n\n${bodies.join("\n\n")}`;
    } else {
      const block = pendingComments.length === 1
        ? bodies[0]
        : bodies.join("\n\n");
      effectivePrompt = `${prompt}\n\n═══ PENDING FEEDBACK — address these before declaring done ═══\n${block}\n═══════════════════════════════════════════════════════════`;
    }
    await Promise.all(
      pendingComments.map((c) =>
        db
          .update(schema.activityEvents)
          .set({ payload: sql`${schema.activityEvents.payload} || '{"acknowledged":true}'::jsonb` })
          .where(eq(schema.activityEvents.id, c.id)),
      ),
    );
  }

  const logEvent = async (
    kind: string,
    payload: Record<string, unknown>,
    actor = storyAgent,
  ) => {
    try {
      await db.insert(schema.activityEvents).values({
        storyId,
        kind,
        actor,
        payload,
      });
    } catch (err) {
      console.error("[orca] failed to write activity event:", err);
    }
  };

  // Variables shared between fresh-spawn and adoption branches. The tail
  // loop and post-tail completion pipeline below read these regardless of
  // how the dispatch got here, so they have to be hoisted out of the
  // branches.
  let marker: string;
  let markerMtime: Date;
  let preDispatchRef: string | null;
  let preDispatchHead: string | null;
  let stdoutPath: string;
  let stderrPath: string;
  // `child` is non-null for fresh spawns and null for adoption (the original
  // ChildProcess handle does not survive a Node restart — only the PID does).
  // The exit waiter below branches on this.
  let child: ChildProcess | null;
  // Effective PID we're tailing — either child.pid for a fresh spawn, or
  // the PID we're adopting from a prior Node process.
  let dispatchPid: number | null;

  if (!adoptExistingPid) {
    // ── Fresh spawn path ─────────────────────────────────────────────
    // Drop a marker file in a scratch dir and record its mtime. After the
    // dispatch we use `find -newer <marker>` to list every file the agent
    // touched — this works whether or not repoPath is a git repo.
    const scratch = await mkdtemp(join(tmpdir(), "orca-dispatch-"));
    marker = join(scratch, "started");
    await writeFile(marker, "");
    markerMtime = (await stat(marker)).mtime;

    // Snapshot the working-tree state before the agent runs so we can compute
    // an *incremental* diff (only this session's changes) instead of the
    // cumulative diff-vs-HEAD that `git diff HEAD` would produce. `git stash
    // create` produces a commit object without actually modifying the index or
    // working tree — if there are no uncommitted changes it outputs nothing.
    preDispatchRef = await snapshotWorkingTree(repoPath);

    // Also record the current HEAD SHA so we can diff committed changes.
    // When the agent commits its work, `git diff HEAD` returns empty (working
    // tree matches HEAD). Diffing pre-dispatch HEAD against post-dispatch HEAD
    // captures the committed changes.
    preDispatchHead = await getHeadSha(repoPath);

    // Resolve the model the do-er should run under: story override beats
    // agent default beats the CLI default. Passed via ANTHROPIC_MODEL
    // env var rather than --model flag for cross-CLI-version stability.
    const doerModel = await resolveModelForStory(db, storyId);
    const doerEnv: NodeJS.ProcessEnv = { ...process.env };
    if (doerModel) doerEnv.ANTHROPIC_MODEL = doerModel;

    // --output-format stream-json emits one JSON message per stdout line as
    // claude thinks/acts, so the activity feed updates in real time instead of
    // dumping everything at the end. --verbose is required by the CLI when
    // stream-json is used with -p. stdin → "ignore" kills the "no stdin data"
    // warning.
    //
    // When a prior session exists for this story, pass --resume so the agent
    // continues from where it left off (full conversation history) instead of
    // starting fresh. This makes multi-run activity additive: the agent sees
    // all its prior tool calls, messages, and reasoning — not just a summary.
    const claudeArgs = [
      // Resume prior session if one exists, otherwise start fresh.
      ...(existingSessionId ? ["--resume", existingSessionId] : []),
      // For fresh sessions only: pass the agent's system prompt so Claude
      // caches it as the system turn. Skipped on --resume because the session
      // already has its system context stored.
      ...(systemPrompt && !existingSessionId ? ["--system-prompt", systemPrompt] : []),
      "-p",
      effectivePrompt,
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--verbose",
    ];

    // Spawn detached + redirect stdio to log files so the child survives a
    // Node restart (e.g. `tsx watch` reload triggered by the agent editing
    // a file in the watched tree). With piped stdio the child would die
    // from SIGPIPE on its next write the moment Node exits — that was the
    // root cause of the "heartbeat keeps respawning agents that do nothing"
    // failure mode tracked in `services/heartbeat.ts`. The log files are
    // tailed in real time below for the live UI feed, AND can be adopted
    // by a fresh Node process via `adoptExistingPid` if Node dies mid-run.
    const logDir = join(
      homedir(),
      ".orca",
      "dispatch-logs",
      storyId,
      String(Date.now()),
    );
    await mkdir(logDir, { recursive: true });
    stdoutPath = join(logDir, "stdout.log");
    stderrPath = join(logDir, "stderr.log");
    const outFd = openSync(stdoutPath, "w");
    const errFd = openSync(stderrPath, "w");
    let spawned: ChildProcess;
    try {
      spawned = spawn("claude", claudeArgs, {
        cwd: repoPath,
        env: doerEnv,
        detached: true,
        stdio: ["ignore", outFd, errFd],
      });
    } finally {
      // Once the child has inherited these fds the parent's copies are no
      // longer needed — the kernel keeps them alive for the child. Closing
      // them here means our process doesn't pin the file descriptor, so the
      // child writing to them after Node exits Just Works.
      closeSync(outFd);
      closeSync(errFd);
    }
    // unref so an outstanding child does not prevent Node from exiting on
    // SIGTERM (tsx watch restart). The child is now fully orphan-safe.
    spawned.unref();
    child = spawned;
    dispatchPid = spawned.pid ?? null;

    runningDispatches.set(storyId, spawned);

    // Persist PID + dispatchState BEFORE doing anything else so a Node
    // crash between this point and the first stream event is still
    // recoverable: a fresh process can find the live PID via the story
    // row, find the log files via dispatchState, and adopt.
    const dispatchState: DispatchState = {
      stdoutPath,
      stderrPath,
      preDispatchRef: preDispatchRef ?? "",
      preDispatchHead: preDispatchHead ?? null,
      markerPath: marker,
      markerMtime: markerMtime.toISOString(),
      existingSessionId,
      spawnedAt: new Date().toISOString(),
      args: {
        storyId,
        repoPath,
        title,
        specMd,
        ...(changeSummary ? { changeSummary } : {}),
        ...(isRecovery ? { isRecovery } : {}),
      },
    };
    if (dispatchPid != null) {
      await db
        .update(schema.stories)
        .set({
          dispatchPid,
          dispatchState,
          updatedAt: new Date(),
        })
        .where(eq(schema.stories.id, storyId));
    }

    await logEvent("agent_spawned", {
      pid: dispatchPid,
      agent: storyAgent,
      trigger: trigger ?? "manual",
      repoPath,
      // Cache-diagnostics fields: downstream consumers (activity UI, cost
      // reports) correlate these with the cache_read/creation numbers on
      // dispatch_completed to tell a cache hit from a cache miss.
      resumed: Boolean(existingSessionId),
      resumedSessionId: existingSessionId,
      systemPromptSent: Boolean(systemPrompt && !existingSessionId),
      resumeFallback: Boolean(args._resumeFallback),
      // Cache-provenance: content-hash fingerprints of the directive
      // files spliced into this run, plus the full system-prompt hash.
      // If the system prompt changes between runs these let you confirm
      // which part (prompt row vs directive) moved.
      ...(Object.keys(directiveHashes).length > 0 ? { directives: directiveHashes } : {}),
      ...(systemPromptHash ? { systemPromptHash: systemPromptHash.slice(0, 12) } : {}),
      ...(sessionDroppedDueToSystemPromptChange
        ? { sessionDroppedDueToSystemPromptChange: true }
        : {}),
    });
    // Log the full prompt as a separate event so it's always visible
    // in the activity stream — not buried in a payload field the UI
    // might truncate. The system prompt is included whenever one exists
    // for the agent so reviewers can see the full context the agent ran
    // under, not just the per-turn main prompt. On --resume runs the
    // system prompt wasn't re-sent (Claude has it cached), but we still
    // record what was in effect at dispatch time.
    await logEvent("agent_prompt", {
      prompt,
      ...(systemPrompt ? { systemPrompt } : {}),
    });
  } else {
    // ── Adoption path ────────────────────────────────────────────────
    // We are picking up a detached child that was spawned by a previous
    // Node process. The child either is still running (we tail it until
    // it exits) or has already exited (the tail loop drains the leftover
    // log bytes and the exit waiter notices the dead PID immediately).
    // Either way, no new process is created — we resume the
    // tail+completion pipeline against the existing log files.
    //
    // IMPORTANT: clear dispatchState from the DB immediately so that a
    // server restart (e.g. tsx watch) during the completion pipeline or
    // QA window does NOT re-adopt this same dead process. The in-memory
    // `state` object is sufficient for the rest of this function. Without
    // this, every tsx-watch restart would re-discover dispatchState in the
    // DB, re-adopt, re-run the completion pipeline + QA, generating dozens
    // of duplicate dispatch_completed/qa_started events and burning tokens
    // on repeated QA calls against the same unchanged diff.
    //
    // If this adoption crashes before reaching a terminal state, the story
    // stays in_progress with no PID and no dispatchState — stale-activity
    // detection in the heartbeat will eventually catch it and do a fresh
    // recovery via recoverStory.
    const state = adoptExistingPid.state;
    marker = state.markerPath;
    markerMtime = new Date(state.markerMtime);
    preDispatchRef = state.preDispatchRef || null;
    preDispatchHead = state.preDispatchHead;
    stdoutPath = state.stdoutPath;
    stderrPath = state.stderrPath;
    child = null;
    dispatchPid = adoptExistingPid.pid;

    // Clear dispatchState BEFORE any async work so re-adoption is impossible.
    await db
      .update(schema.stories)
      .set({ dispatchState: null, updatedAt: new Date() })
      .where(eq(schema.stories.id, storyId));

    await logEvent(
      "agent_adopted",
      {
        pid: dispatchPid,
        agent: storyAgent,
        trigger: trigger ?? "heartbeat-adoption",
        stdoutPath,
        stderrPath,
        spawnedAt: state.spawnedAt,
      },
      "system",
    );
  }

  let stdoutBuf = "";
  let stderrBuf = "";
  let totalCostUsd: number | null = null;
  let totalTokensUsed: number | null = null;
  let capturedSessionId: string | null = null;
  let modelUsed: string | null = null;
  // Prompt-cache accounting, captured from the CLI's result event. Hoisted
  // out of the per-line handler so dispatch_completed can report them —
  // high cacheReadInputTokens relative to uncached inputTokens is the
  // signal that --resume actually hit the cache.
  let cacheReadInputTokens = 0;
  let cacheCreationInputTokens = 0;
  let uncachedInputTokens = 0;

  // Token-attribution attempt index for THIS do-er run. The QA gate
  // recurses into runClaudeDispatch on retry, so each call sees an
  // already-incremented dispatchQaRetryCount on the story row — that's
  // exactly the attempt index we want stamped on the heatmap row.
  // Read it once up front so we don't issue another DB query inside
  // the per-stream-line hot path.
  const [doerAttemptRow] = await db
    .select({ dispatchQaRetryCount: schema.stories.dispatchQaRetryCount })
    .from(schema.stories)
    .where(eq(schema.stories.id, storyId));
  const doerAttemptForTokens = doerAttemptRow?.dispatchQaRetryCount ?? 0;

  const handleStreamJsonLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      // Not valid JSON — fall back to a raw log line so we don't silently
      // drop anything the CLI printed.
      await logEvent("agent_log", { stream: "stdout", line: trimmed });
      return;
    }
    // Dedup guard: every Claude stream event carries a UUID. If two concurrent
    // tail loops (e.g. from a hot-reload mid-dispatch) both read the same line,
    // only the first one wins. The Set lives on globalThis so it survives
    // vite-node hot-module reloads and is shared across all tail instances.
    const msgUuid = (msg as Record<string, unknown>)?.uuid;
    if (typeof msgUuid === "string") {
      const key = `${storyId}:${msgUuid}`;
      if (_g._orcaStreamedUuids!.has(key)) return;
      _g._orcaStreamedUuids!.add(key);
    }
    await logEvent("agent_stream", msg as Record<string, unknown>);

    // Capture the session/conversation ID from the stream so we can
    // --resume this session on subsequent dispatches for the same story.
    // The CLI emits session_id in the init event and/or the result event.
    const mAny = msg as Record<string, unknown>;
    if (!capturedSessionId && typeof mAny.session_id === "string") {
      capturedSessionId = mAny.session_id;
    }

    // Detect rate-limit signals in stream-json events and extract
    // type/reason + retry_after from the API error payload so we can
    // predict overage and gate future auto-dispatches.
    //
    // IMPORTANT: claude emits `rate_limit_event` messages constantly during
    // normal operation with statuses like "allowed" and "allowed_warning"
    // to tell the client its current utilization. These are informational,
    // NOT limit hits, and treating them as real rate limits gates orca for
    // 60 seconds on every single event. We only gate on:
    //   1. an `error` event that matches rate-limit / 429 / too-many-requests, or
    //   2. a `rate_limit_event` whose status does NOT start with "allowed"
    //      (e.g. "blocked", "limited", whatever the actual hit-state is).
    // A naive substring match on "rate_limit" in the serialized event — our
    // old detector — matches the literal event-type name itself and fires
    // on every heartbeat.
    const mPeek = msg as Record<string, unknown>;
    const rli = (mPeek.rate_limit_info &&
      typeof mPeek.rate_limit_info === "object"
      ? mPeek.rate_limit_info
      : null) as Record<string, unknown> | null;
    const rliStatus = typeof rli?.status === "string" ? (rli!.status as string) : null;
    const isBenignRateLimitBroadcast =
      mPeek.type === "rate_limit_event" &&
      (rliStatus == null || rliStatus.startsWith("allowed"));

    // Capture weekly-allotment usage fraction from benign broadcasts.
    if (isBenignRateLimitBroadcast && rli != null) {
      const uf = extractUsageFraction(rli as Record<string, unknown>);
      if (uf != null) {
        recordUsageFraction(uf);
        persistUsageFraction(db).catch(() => {});
      }
    }

    // For everything that is not a benign broadcast, run the substring
    // detector on the serialized event. Real errors serialize with
    // "error", "429", or "too many requests" somewhere in their payload.
    const mStr = isBenignRateLimitBroadcast ? "" : JSON.stringify(msg);
    const isRealLimit =
      !isBenignRateLimitBroadcast &&
      (
        (mPeek.type === "error" && /rate.?limit|429|too many requests/i.test(mStr)) ||
        (mPeek.type === "rate_limit_event") // non-benign branch: status is not "allowed*"
      );
    if (isRealLimit) {
      const pidCount = countClaudeProcesses();
      const cap = getConcurrencyCap();

      // Try to extract structured rate-limit fields from the event.
      const mObj = msg as Record<string, unknown>;
      const errObj = (mObj.error && typeof mObj.error === "object" ? mObj.error : null) as Record<string, unknown> | null;
      // type/reason: e.g. "input_tokens_per_minute", "requests_per_minute"
      const rlType = (errObj?.type as string)
        ?? (mObj.type === "error" && typeof mObj.reason === "string" ? mObj.reason : null)
        ?? (typeof mObj.rate_limit_type === "string" ? mObj.rate_limit_type : null)
        ?? null;
      // retry_after: seconds (number or numeric string)
      const rawRetry = errObj?.retry_after ?? mObj.retry_after ?? (
        typeof mObj.headers === "object" && mObj.headers != null
          ? (mObj.headers as Record<string, unknown>)["retry-after"]
          : undefined
      );
      const retryAfterSec = rawRetry != null ? Number(rawRetry) || null : null;

      console.warn(
        `[orca] rate limit detected (stream) for story ${storyId}: ${pidCount} claude processes (cap ${cap}), type=${rlType}, retryAfter=${retryAfterSec}`,
      );

      recordRateLimit({ rateLimitType: rlType, retryAfterSec, claudeProcessCount: pidCount });

      await logEvent("rate_limit_detected", {
        source: "stream-json",
        rateLimitType: rlType,
        retryAfterSec,
        claudeProcessCount: pidCount,
        concurrencyCap: cap,
      });
    }

    // Capture cost and token totals from the result event.
    // The CLI has used several field names across versions — check all known
    // variants so we don't silently miss the data.
    const m = msg as Record<string, unknown>;
    if (m.type === "result") {
      const cost =
        typeof m.total_cost_usd === "number"
          ? m.total_cost_usd
          : typeof m.cost_usd === "number"
            ? m.cost_usd
            : typeof m.total_cost === "number"
              ? m.total_cost
              : null;
      if (cost != null) totalCostUsd = cost;

      // Capture the actual model the CLI used from the result event.
      const resultModel = extractModelFromStreamResult(m);
      if (resultModel) modelUsed = resultModel;

      // Token counts live inside the nested `usage` object in the CLI's
      // stream-json result event (e.g. usage.input_tokens,
      // usage.cache_creation_input_tokens, usage.cache_read_input_tokens).
      // Fall back to top-level fields for older CLI versions.
      const usage = (m.usage && typeof m.usage === "object" ? m.usage : null) as
        | Record<string, unknown>
        | null;

      // Also check modelUsage — the CLI emits per-model breakdowns that
      // include inputTokens / outputTokens / cacheReadInputTokens etc.
      const modelUsage = (m.modelUsage && typeof m.modelUsage === "object"
        ? m.modelUsage
        : null) as Record<string, Record<string, unknown>> | null;

      let inTok = 0;
      let outTok = 0;
      let cacheReadTok = 0;
      let cacheCreateTok = 0;

      if (usage) {
        inTok = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
        outTok = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
        cacheReadTok = typeof usage.cache_read_input_tokens === "number"
          ? usage.cache_read_input_tokens : 0;
        cacheCreateTok = typeof usage.cache_creation_input_tokens === "number"
          ? usage.cache_creation_input_tokens : 0;
      } else if (modelUsage) {
        // Sum across all models in the modelUsage map.
        for (const model of Object.values(modelUsage)) {
          if (model && typeof model === "object") {
            inTok += typeof model.inputTokens === "number" ? model.inputTokens : 0;
            outTok += typeof model.outputTokens === "number" ? model.outputTokens : 0;
            cacheReadTok += typeof model.cacheReadInputTokens === "number"
              ? model.cacheReadInputTokens : 0;
            cacheCreateTok += typeof model.cacheCreationInputTokens === "number"
              ? model.cacheCreationInputTokens : 0;
          }
        }
      } else {
        // Legacy top-level fields
        inTok = typeof m.total_input_tokens === "number" ? m.total_input_tokens : 0;
        outTok = typeof m.total_output_tokens === "number" ? m.total_output_tokens : 0;
      }

      const totalTok = inTok + outTok + cacheReadTok + cacheCreateTok;
      if (totalTok > 0) {
        totalTokensUsed = totalTok;
      }
      // Publish to outer-scope accumulators so dispatch_completed can emit
      // the cache-hit breakdown. The result event fires once per run, so a
      // simple assign is enough; we don't accumulate across multiple result
      // events within a single dispatch.
      cacheReadInputTokens = cacheReadTok;
      cacheCreationInputTokens = cacheCreateTok;
      uncachedInputTokens = inTok;

      // Persist per-dispatch token attribution so the cost endpoint can
      // break spend down by agent + retry. The do-er attempt index is
      // (dispatchQaRetryCount - 1) on retries, but we don't want to
      // bother with another DB roundtrip in the stream-line hot path —
      // instead capture the value the lifecycle started with via the
      // outer-scope `doerAttemptForTokens` (set just before we spawn).
      if (totalTok > 0) {
        try {
          await db.insert(schema.tokenHeatmaps).values({
            storyId,
            agent: "do-er",
            attempt: doerAttemptForTokens,
            calls: 1,
            totalIn: inTok + cacheReadTok + cacheCreateTok,
            totalOut: outTok,
            totalCached: cacheReadTok,
            totalCacheCreation: cacheCreateTok,
            totalUncached: inTok,
            promptBytesSent: 0,
          });
        } catch (err) {
          console.error("[orca] failed to insert do-er token_heatmap row:", err);
        }
      }

      console.log("[orca] result event fields:", Object.keys(m).join(", "),
        "| cost:", cost, "| tokens:", totalTok);
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

  const flushStderrLines = async (chunk: Buffer): Promise<void> => {
    stderrBuf += chunk.toString("utf8");
    const lastNl = stderrBuf.lastIndexOf("\n");
    if (lastNl < 0) return;
    const complete = stderrBuf.slice(0, lastNl);
    stderrBuf = stderrBuf.slice(lastNl + 1);
    for (const line of complete.split("\n")) {
      if (!line.trim()) continue;
      await logEvent("agent_log", { stream: "stderr", line });

      // Detect rate-limit activity and log PID count for threshold calibration.
      // Try to extract retry_after from stderr text (e.g. "retry after 30s",
      // "retry-after: 45", "retry_after=60").
      if (/rate.?limit/i.test(line) || /429/i.test(line) || /too many requests/i.test(line)) {
        const pidCount = countClaudeProcesses();
        const cap = getConcurrencyCap();

        // Best-effort extraction of retry_after from the stderr line.
        const retryMatch = line.match(/retry[\-_\s]?after[\s:=]*(\d+)/i);
        const retryAfterSec = retryMatch ? Number(retryMatch[1]) || null : null;
        // Best-effort extraction of rate-limit type from stderr.
        const typeMatch = line.match(/(input_tokens_per_minute|output_tokens_per_minute|requests_per_minute|tokens_per_minute|tokens_per_day)/i);
        const rlType = typeMatch ? typeMatch[1] : null;

        console.warn(
          `[orca] rate limit detected (stderr) for story ${storyId}: ${pidCount} claude processes (cap ${cap}), type=${rlType}, retryAfter=${retryAfterSec}`,
        );

        recordRateLimit({ rateLimitType: rlType, retryAfterSec, claudeProcessCount: pidCount });

        await logEvent("rate_limit_detected", {
          stderrLine: line.slice(0, 500),
          rateLimitType: rlType,
          retryAfterSec,
          claudeProcessCount: pidCount,
          concurrencyCap: cap,
        });
      }
    }
  };

  // Tail the log files instead of reading from child.stdout/stderr pipes.
  // The child writes directly to the log files (its stdio is redirected
  // there) so we read from the same files via stat+read at a polling
  // interval. This decouples the child's lifetime from Node's stdio
  // pipes — see the spawn-detached comment above.
  let stdoutOffset = 0;
  let stderrOffset = 0;

  // For adoption: every byte currently in the log files was already
  // processed by the previous Node process and is already in the DB.
  // Fast-forward past those bytes so the tail loop only picks up data
  // written after this adoption started — otherwise every prior event
  // would be re-inserted as a duplicate row.
  if (adoptExistingPid) {
    const [stdoutSt, stderrSt] = await Promise.all([
      stat(stdoutPath).catch(() => null),
      stat(stderrPath).catch(() => null),
    ]);
    stdoutOffset = stdoutSt?.size ?? 0;
    stderrOffset = stderrSt?.size ?? 0;
  }

  const flushStdoutOnce = async (): Promise<void> => {
    const st = await stat(stdoutPath).catch(() => null);
    if (!st || st.size <= stdoutOffset) return;
    // Advance offset synchronously before the next await so a concurrent
    // call that resumes from its own stat() sees the updated value and
    // exits early — preventing duplicate reads of the same bytes.
    const start = stdoutOffset;
    const len = st.size - stdoutOffset;
    stdoutOffset = st.size;
    const fh = await fsOpen(stdoutPath, "r");
    try {
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      await flushStdoutLines(buf);
    } finally {
      await fh.close();
    }
  };

  const flushStderrOnce = async (): Promise<void> => {
    const st = await stat(stderrPath).catch(() => null);
    if (!st || st.size <= stderrOffset) return;
    const start = stderrOffset;
    const len = st.size - stderrOffset;
    stderrOffset = st.size;
    const fh = await fsOpen(stderrPath, "r");
    try {
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      await flushStderrLines(buf);
    } finally {
      await fh.close();
    }
  };

  const exitCode: number | null = await new Promise((resolve) => {
    let resolved = false;
    const finish = (code: number | null) => {
      if (resolved) return;
      resolved = true;
      resolve(code);
    };
    if (child) {
      // Fresh-spawn case: the OS hands us the actual exit code via the
      // "exit" event on the ChildProcess handle.
      child.once("exit", (code) => finish(code));
      child.once("error", async (err) => {
        await logEvent("agent_error", { message: String(err) });
        finish(null);
      });
    }
    const tick = async () => {
      try {
        await flushStdoutOnce();
        await flushStderrOnce();
      } catch (err) {
        console.error(`[orca] tail error for story ${storyId}:`, err);
      }
      if (resolved) return;
      // Adoption case: we have no ChildProcess handle (it belonged to a
      // dead Node process), so the only way to know whether the detached
      // child has exited is to poll its PID for liveness. When it dies,
      // we infer success — the actual exit code is unrecoverable, but
      // the result event in the log file will provide the real signal.
      if (!child && dispatchPid != null && !isPidAlive(dispatchPid)) {
        finish(0);
        return;
      }
      setTimeout(tick, 200);
    };
    tick();
  });

  // Final flush after the child exits — there may be bytes the kernel
  // wrote between the last poll and the exit event.
  await flushStdoutOnce();
  await flushStderrOnce();

  runningDispatches.delete(storyId);

  if (stdoutBuf.trim()) await handleStreamJsonLine(stdoutBuf);
  if (stderrBuf.trim())
    await logEvent("agent_log", { stream: "stderr", line: stderrBuf });

  // Collect everything the agent touched via mtime, plus git diffs if we
  // happen to be in a repo. We capture two diffs:
  //   - gitDiff: only this session's changes (vs the pre-dispatch snapshot)
  // Collect changed files and git diff for the activity feed.
  const changedFiles = await listChangedFiles(repoPath, marker);
  let gitDiff = await captureGitDiff(repoPath, preDispatchRef);

  // When the agent commits its changes, `git diff` against the working tree
  // returns empty. Fall back to diffing the pre-dispatch HEAD against the
  // current HEAD to capture committed changes.
  if (!gitDiff && preDispatchHead) {
    const postHead = await getHeadSha(repoPath);
    if (postHead && postHead !== preDispatchHead) {
      gitDiff = await captureCommittedDiff(repoPath, preDispatchHead);
    }
  }

  // Final fallback: repo has no commits (initial scaffold), so all git diff
  // variants fail. Generate synthetic diffs via `git diff --no-index` for
  // each changed file so the UI can show line counts.
  if (!gitDiff && changedFiles.length > 0 && !preDispatchHead) {
    gitDiff = await synthDiffForNewFiles(repoPath, changedFiles);
  }

  // cacheHitRatio = cached input / total input. A well-cached --resume
  // run is close to 1.0; a fresh spawn or cache miss is close to 0.0.
  // Emit null when we saw no input tokens at all (e.g. process died
  // before the result event fired) so the UI can distinguish "miss"
  // from "no data".
  const totalInputTokensSeen =
    cacheReadInputTokens + cacheCreationInputTokens + uncachedInputTokens;
  const cacheHitRatio =
    totalInputTokensSeen > 0
      ? cacheReadInputTokens / totalInputTokensSeen
      : null;

  await logEvent("dispatch_completed", {
    exitCode,
    changedFiles,
    fileCount: changedFiles.length,
    gitDiff,
    markerMtime: markerMtime.toISOString(),
    ...(preDispatchHead ? { preDispatchHead } : {}),
    ...(totalCostUsd != null ? { totalCostUsd } : {}),
    ...(totalTokensUsed != null ? { totalTokensUsed } : {}),
    ...(modelUsed ? { model: modelUsed } : {}),
    resumed: Boolean(existingSessionId),
    cacheReadInputTokens,
    cacheCreationInputTokens,
    uncachedInputTokens,
    cacheHitRatio,
  });

  // Persist the session ID so subsequent dispatches can --resume this
  // conversation instead of starting fresh. This makes multi-run activity
  // additive: the agent sees its full prior conversation history.
  //
  // We also stamp the full systemPromptHash that was sent on THIS run.
  // The next dispatch re-renders the system prompt, computes a fresh
  // hash, and compares — if it differs, the session is dropped so the
  // new system prompt actually reaches the agent (Claude's cached system
  // turn on --resume would otherwise keep serving the old content).
  if (capturedSessionId) {
    await db
      .update(schema.stories)
      .set({
        claudeSessionId: capturedSessionId,
        ...(systemPromptHash ? { claudeSessionSystemPromptHash: systemPromptHash } : {}),
      })
      .where(eq(schema.stories.id, storyId));
  }

  // If a new dispatch was already kicked off for this story (e.g. because the
  // user edited the story mid-flight), skip everything below — the new
  // dispatch owns the story's state now.
  if (runningDispatches.has(storyId)) {
    return;
  }

  // Reusable cost/token snapshot — applied on every terminal transition so
  // we don't lose accounting when a path takes a non-default branch (QA
  // fail, retry exhaustion, etc).  Costs are ACCUMULATED across runs, not
  // replaced, so re-dispatching a story preserves the prior spend.
  const [currentStory] = await db
    .select({ totalCostUsd: schema.stories.totalCostUsd, totalTokensUsed: schema.stories.totalTokensUsed })
    .from(schema.stories)
    .where(eq(schema.stories.id, storyId));
  const costSnapshot = {
    ...(totalCostUsd != null
      ? { totalCostUsd: (currentStory?.totalCostUsd ?? 0) + totalCostUsd }
      : {}),
    ...(totalTokensUsed != null
      ? { totalTokensUsed: (currentStory?.totalTokensUsed ?? 0) + totalTokensUsed }
      : {}),
  };

  // Path 0: --resume failed (session not found / CLI doesn't support it).
  // Detected when we passed --resume, the process exited non-zero, and no
  // session_id was captured (meaning the CLI never got past init). Clear
  // the stale session ID and retry without --resume.
  //
  // Guarded by `_resumeFallback` so a second failure on the retried fresh
  // run falls through to normal error handling instead of looping. The
  // retry is also invoked as a fresh spawn — adoptExistingPid is stripped
  // so we never try to re-adopt the dead PID on the fallback path.
  if (
    !args._resumeFallback &&
    exitCode !== 0 &&
    existingSessionId &&
    !capturedSessionId
  ) {
    console.log(
      `[orca] --resume failed for story ${storyId} (session ${existingSessionId}), retrying without --resume`,
    );
    await db
      .update(schema.stories)
      .set({ claudeSessionId: null })
      .where(eq(schema.stories.id, storyId));
    await logEvent("dispatch_interrupted", {
      reason: "resume_failed",
      staleSessionId: existingSessionId,
      exitCode,
    }, "system");
    // Retry without --resume by recursing. The cleared session ID means
    // the next call will start a fresh session — --system-prompt will be
    // re-sent (see claudeArgs above: `systemPrompt && !existingSessionId`).
    return runClaudeDispatch({
      ...args,
      adoptExistingPid: undefined,
      _resumeFallback: true,
    });
  }


  // Path 2.4: Token budget gate. If the do-er has already burned more
  // tokens than the per-story budget, hard-stop the loop here. The
  // file-a-finding logic inside enforceStoryTokenBudget is idempotent
  // (one finding per story), and the gate is a no-op when the budget
  // is unset (default).
  const budgetCheck = await enforceStoryTokenBudget(db, storyId);
  if (budgetCheck.exceeded) {
    await db
      .update(schema.stories)
      .set({
        status: "blocked" as StoryStatus,
        dispatchPid: null,
        dispatchState: null,
        blockedReason:
          `Token budget exceeded (${budgetCheck.spent}/${budgetCheck.budget})`,
        updatedAt: new Date(),
        ...costSnapshot,
      })
      .where(eq(schema.stories.id, storyId));
    await db.insert(schema.activityEvents).values({
      storyId,
      kind: "state_transition",
      actor: "system",
      payload: {
        status: "blocked",
        reason: "token_budget_exceeded",
        spent: budgetCheck.spent,
        budget: budgetCheck.budget,
      },
    });
    return;
  }

  // Path 2: Agent exited cleanly. The agent's prompt is responsible for
  // updating status/agent via the Orca API before exiting. If the story is
  // still in_progress (agent exited without self-transitioning), bump it back
  // to backlog so the heartbeat picks it up on the next tick.
  {
  const [postRunStory] = await db
    .select({ status: schema.stories.status, agent: schema.stories.agent })
    .from(schema.stories)
    .where(eq(schema.stories.id, storyId));

  await db
    .update(schema.stories)
    .set({ dispatchPid: null, dispatchState: null, updatedAt: new Date(), ...costSnapshot })
    .where(eq(schema.stories.id, storyId));

  // If the story landed in backlog with an agent (either the agent handed off
  // to a new agent and called wake, or exited without transitioning), fire the
  // next dispatch immediately instead of waiting for the heartbeat interval.
  if (postRunStory?.status === "backlog" && postRunStory.agent) {
    runClaudeDispatch(args).catch((err) =>
      handleDispatchRejection(db, storyId, err, {
        context: "auto-handoff dispatch failed",
        revertStatus: true,
      }),
    );
  }
  }

  } finally {
    // Release the lifecycle guard no matter how we exit — terminal state,
    // thrown error, early return, or awaited retry recursion. On a fresh
    // Node process, this set is empty, so heartbeat correctly treats every
    // DB-tracked dispatch from the previous Node process as orphaned.
    activeLifecycles.delete(storyId);
  }
}

// List every regular file under `cwd` whose mtime is newer than `marker`.
// Skip noisy/huge trees (node_modules, .git, build outputs) so the response
// payload stays bounded on a real codebase.
async function listChangedFiles(
  cwd: string,
  marker: string,
): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawn(
      "find",
      [
        ".",
        "-type",
        "f",
        "-newer",
        marker,
        "-not",
        "-path",
        "*/node_modules/*",
        "-not",
        "-path",
        "*/.git/*",
        "-not",
        "-path",
        "*/dist/*",
        "-not",
        "-path",
        "*/.next/*",
        "-not",
        "-path",
        "*/build/*",
      ],
      { cwd },
    );
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString("utf8")));
    child.on("close", () => {
      const files = out
        .split("\n")
        .map((f) => f.replace(/^\.\//, "").trim())
        .filter(Boolean)
        .slice(0, 500);
      resolve(files);
    });
    child.on("error", () => resolve([]));
  });
}


/**
 * Snapshot the current working-tree state by creating a temporary stash
 * commit (git stash create). This does NOT modify the working directory or
 * index — it only creates a dangling commit object we can diff against
 * later. Returns the commit SHA, or null if there are no uncommitted
 * changes or this isn't a git repo.
 */
async function snapshotWorkingTree(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("git", ["stash", "create"], { cwd });
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString("utf8")));
    child.on("close", (code) => {
      const sha = out.trim();
      resolve(code === 0 && sha.length > 0 ? sha : null);
    });
    child.on("error", () => resolve(null));
  });
}

/**
 * Capture a git diff for this dispatch session. When `baseRef` is provided
 * (a stash commit from before the agent ran), we diff that commit against
 * the current working tree so we capture only the changes the agent made
 * in this session, not the accumulated changes from prior runs. Falls back
 * to `git diff HEAD` when no baseline is available (first run, or non-git
 * directory).
 */
async function captureGitDiff(
  cwd: string,
  baseRef?: string | null,
): Promise<string> {
  return new Promise((resolve) => {
    // When we have a pre-dispatch snapshot, diff it against the current
    // working tree. Otherwise fall back to `git diff HEAD`.
    const args = baseRef
      ? ["diff", baseRef, "--no-color"]
      : ["diff", "HEAD", "--no-color"];
    const child = spawn("git", args, { cwd });
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString("utf8")));
    child.on("close", (code) => resolve(code === 0 ? out : ""));
    child.on("error", () => resolve(""));
  });
}

/** Return the current HEAD commit SHA, or null if not a git repo. */
async function getHeadSha(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("git", ["rev-parse", "HEAD"], { cwd });
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString("utf8")));
    child.on("close", (code) => {
      const sha = out.trim();
      resolve(code === 0 && sha.length > 0 ? sha : null);
    });
    child.on("error", () => resolve(null));
  });
}

/** Diff committed changes between two refs (e.g. pre-dispatch HEAD vs current HEAD). */
async function captureCommittedDiff(
  cwd: string,
  fromRef: string,
): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("git", ["diff", fromRef, "HEAD", "--no-color"], { cwd });
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString("utf8")));
    child.on("close", (code) => resolve(code === 0 ? out : ""));
    child.on("error", () => resolve(""));
  });
}

/**
 * Generate synthetic diffs for repos with no commits by diffing /dev/null
 * against each file. This produces standard unified diff output so
 * parseDiffStats in the frontend can extract line counts.
 */
async function synthDiffForNewFiles(
  cwd: string,
  files: string[],
): Promise<string> {
  const parts: string[] = [];
  for (const f of files) {
    const d = await new Promise<string>((resolve) => {
      const child = spawn(
        "git",
        ["diff", "--no-index", "--no-color", "/dev/null", f],
        { cwd },
      );
      let out = "";
      child.stdout.on("data", (c) => (out += c.toString("utf8")));
      // git diff --no-index exits 1 when files differ (not an error)
      child.on("close", () => resolve(out));
      child.on("error", () => resolve(""));
    });
    if (d) parts.push(d);
  }
  return parts.join("\n");
}
