import { Hono } from "hono";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@orca/db";
import type { OrcaEnv } from "../app.js";
import type { OrcaDb } from "@orca/db";
import type { StoryStatus } from "@orca/shared";
import { runClaudeDispatch, isDispatchLifecycleActive } from "./stories.js";
import { resolveModelForStory } from "../agents/model.js";
import { handleDispatchRejection } from "../services/dispatch-rejection.js";

const createSchema = z.object({
  storyId: z.string().uuid(),
  question: z.string().min(1),
  context: z.string().optional(),
  source: z.string().default("spec-writer"),
  blocksDispatch: z.boolean().optional(),
  priority: z.number().optional(),
});

const answerSchema = z.object({
  answer: z.string().min(1),
});

/**
 * On-answer auto-dispatch hook. Called after a refinement question is
 * answered. If the answer cleared the last blocksDispatch=true question
 * for the story and the story is in `planning`, immediately re-enqueue
 * spec-writer so the user doesn't have to wait up to one heartbeat tick.
 *
 * Hard cap: after the user has answered AUTO_REDISPATCH_CAP questions on
 * a story, this hook stops firing. The pattern that triggered the cap is
 * spec-writer creating one new clarifying question per re-dispatch
 * forever, never folding answers into the spec body. The cap forces the
 * conversation to converge — past the cap, the user must explicitly click
 * Re-spec on the story page to trigger another spec-writer pass. Two
 * answered questions is enough thinking; anything beyond that is a sign
 * the agent is failing to atomize and a fresh pair of eyes is needed.
 */
const AUTO_REDISPATCH_CAP = 2;

async function maybeRedispatchSpecWriter(
  db: OrcaDb,
  storyId: string,
): Promise<void> {
  // Count remaining open blocking questions on this story.
  const blockingRows = await db
    .select({
      openBlocking: sql<number>`cast(count(*) as int)`,
    })
    .from(schema.refinementQuestions)
    .where(
      and(
        eq(schema.refinementQuestions.storyId, storyId),
        eq(schema.refinementQuestions.status, "open"),
        eq(schema.refinementQuestions.blocksDispatch, true),
      ),
    );
  const openBlocking = blockingRows[0]?.openBlocking ?? 0;

  if (openBlocking > 0) return;

  // Hard cap: count answered questions on this story. If we're already
  // past the cap, refuse to auto-redispatch.
  const answeredRows = await db
    .select({
      answered: sql<number>`cast(count(*) as int)`,
    })
    .from(schema.refinementQuestions)
    .where(
      and(
        eq(schema.refinementQuestions.storyId, storyId),
        eq(schema.refinementQuestions.status, "answered"),
      ),
    );
  const answeredCount = answeredRows[0]?.answered ?? 0;
  if (answeredCount > AUTO_REDISPATCH_CAP) {
    console.log(
      `[orca/refinement-questions] auto-redispatch suppressed for story ${storyId}: ${answeredCount} answered > cap ${AUTO_REDISPATCH_CAP}. User must click Re-spec manually.`,
    );
    await db.insert(schema.activityEvents).values({
      storyId,
      kind: "comment",
      actor: "system",
      payload: {
        body: `Auto-redispatch suppressed: this story has already had ${answeredCount} refinement-question rounds. Click **Re-spec** to manually trigger another spec-writer pass, or update the spec body directly. The agent has had enough chances to atomize; further questions are unlikely to converge.`,
        source: "anti-loop-cap",
      },
    });
    return;
  }

  const [story] = await db
    .select()
    .from(schema.stories)
    .where(eq(schema.stories.id, storyId));
  if (!story) return;

  // Only auto-dispatch if spec-writer owns the story (planning). Implementing
  // or qa stories are already mid-pipeline — don't preempt them.
  if (story.status !== "planning") return;

  // Don't fire if a dispatch lifecycle is already active for this story.
  if (isDispatchLifecycleActive(storyId)) return;
  // Or if the row already has a tracked dispatch PID (set by another path
  // mid-spawn). dispatchPid is the canonical busy mutex.
  if (story.dispatchPid != null) return;

  const [project] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, story.projectId));
  if (!project) return;

  // No status change here. Spec-writer owns its own status — if there are
  // still open non-blocking questions or no questions, it will PATCH to
  // `backlog` (or stay `planning` if its run produces a new blocker).
  // Heartbeat doesn't change status either; this hook is the same rule.
  await db
    .update(schema.stories)
    .set({
      agent: "spec-writer",
      dispatchedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.stories.id, storyId));

  const resolvedModel = await resolveModelForStory(db, storyId);

  await db.insert(schema.activityEvents).values({
    storyId,
    kind: "dispatch_started",
    actor: "system",
    payload: {
      repoPath: project.repoPath,
      adapter: "claude-local",
      trigger: "answer-redispatch",
      agent: "spec-writer",
      ...(resolvedModel ? { model: resolvedModel } : {}),
    },
  });

  runClaudeDispatch({
    db,
    storyId,
    repoPath: project.repoPath,
    title: story.title,
    specMd: story.specMd,
    trigger: "manual",
  }).catch((err) =>
    handleDispatchRejection(db, storyId, err, {
      context: "answer-redispatch failed",
      revertStatus: false,
      actor: "system",
    }),
  );
}

export function refinementQuestionsRoutes(): Hono<OrcaEnv> {
  const app = new Hono<OrcaEnv>();

  // GET / — list questions; optionally scoped to a project and/or
  // including already-answered rows. Joins to stories so the UI can show
  // each question's title and status without a second round-trip.
  app.get("/", async (c) => {
    const db = c.get("db");
    const projectId = c.req.query("projectId");
    const includeAnswered = c.req.query("includeAnswered") === "1";

    const conds = [];
    if (!includeAnswered) {
      conds.push(eq(schema.refinementQuestions.status, "open"));
    }
    if (projectId) {
      conds.push(eq(schema.stories.projectId, projectId));
    }

    const rows = await db
      .select({
        q: schema.refinementQuestions,
        storyTitle: schema.stories.title,
        storyStatus: schema.stories.status,
        storyProjectId: schema.stories.projectId,
      })
      .from(schema.refinementQuestions)
      .innerJoin(
        schema.stories,
        eq(schema.refinementQuestions.storyId, schema.stories.id),
      )
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(schema.refinementQuestions.priority));

    return c.json({ questions: rows });
  });

  // POST / — create a new question. Used by spec-writer (and other agents)
  // to surface uncertainty as structured rows the UI can render inline.
  app.post("/", async (c) => {
    const db = c.get("db");
    let body: z.infer<typeof createSchema>;
    try {
      body = createSchema.parse(await c.req.json());
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }

    const blocksDispatch = body.blocksDispatch ?? true;
    const [question] = await db
      .insert(schema.refinementQuestions)
      .values({
        storyId: body.storyId,
        question: body.question,
        context: body.context ?? "",
        source: body.source as "spec-writer" | "scrum-master",
        blocksDispatch,
        priority: body.priority ?? 0,
        priorityFactors: {
          closenessToDispatch: 0,
          certaintyDelta: 0,
          blocksDispatch,
          ageMs: 0,
        },
      })
      .returning();
    if (!question) return c.json({ error: "failed to insert" }, 500);

    return c.json({ question }, 201);
  });

  // POST /:id/answer — answer a question. Triggers the on-answer hook,
  // which auto-redispatches spec-writer if this was the last blocking
  // question for a story in `planning`.
  app.post("/:id/answer", async (c) => {
    const id = c.req.param("id");
    const db = c.get("db");

    let body: z.infer<typeof answerSchema>;
    try {
      body = answerSchema.parse(await c.req.json());
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }

    const [updated] = await db
      .update(schema.refinementQuestions)
      .set({
        answer: body.answer,
        answeredAt: new Date(),
        status: "answered",
        updatedAt: new Date(),
      })
      .where(eq(schema.refinementQuestions.id, id))
      .returning();
    if (!updated) return c.json({ error: "question not found" }, 404);

    // Persist the Q+A to the activity timeline so it survives independently
    // of the refinement_questions table state and shows up as audit history
    // alongside the rest of the conversation.
    await db.insert(schema.activityEvents).values({
      storyId: updated.storyId,
      kind: "comment",
      actor: "user",
      payload: {
        body: `**Q:** ${updated.question}\n\n**A:** ${body.answer}`,
        source: "refinement-answer",
        questionId: updated.id,
      },
    });

    // Fire-and-forget: the auto-dispatch is best-effort, don't block the
    // HTTP response on it. Errors are logged inside the hook.
    maybeRedispatchSpecWriter(db, updated.storyId).catch((err) =>
      console.error(
        `[orca/refinement-questions] auto-redispatch failed for story ${updated.storyId}:`,
        err,
      ),
    );

    return c.json({ question: updated });
  });

  // POST /:id/skip — mark a question obsolete (e.g. spec-writer went down
  // a wrong path; the question is no longer relevant).
  app.post("/:id/skip", async (c) => {
    const id = c.req.param("id");
    const db = c.get("db");

    const [updated] = await db
      .update(schema.refinementQuestions)
      .set({
        status: "obsolete",
        updatedAt: new Date(),
      })
      .where(eq(schema.refinementQuestions.id, id))
      .returning();
    if (!updated) return c.json({ error: "question not found" }, 404);

    return c.json({ question: updated });
  });

  return app;
}
