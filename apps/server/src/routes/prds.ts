import { Hono } from "hono";
import { and, desc, eq, sql } from "drizzle-orm";
import { schema } from "@orca/db";
import { sanitizeForJsonb } from "../services/sanitize-jsonb.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parsePrdDoc, prdTitle, setPrdAnswer } from "@orca/shared";
import type { Prd, PrdSummary } from "@orca/shared";
import type { PrdRow } from "@orca/db";
import type { OrcaEnv } from "../app.js";
import { serializeActivity } from "../services/serialize-activity.js";
import { scanPrdFiles } from "../services/prd-scan.js";
import { expandTilde } from "../services/dispatch-prompt-util.js";
import { runPrdDispatch } from "../services/prd-dispatch.js";
import { killTargetProcesses } from "../services/cli-dispatch.js";
import { withFileWriteLock, atomicWriteFile } from "../services/file-write-lock.js";

function serializePrd(p: PrdRow): Prd {
  return {
    id: p.id,
    projectId: p.projectId,
    relPath: p.relPath,
    title: p.title,
    lastSeenHash: p.lastSeenHash,
    lastChangeAt: p.lastChangeAt?.toISOString() ?? null,
    lastProcessedHash: p.lastProcessedHash,
    lastProcessedAt: p.lastProcessedAt?.toISOString() ?? null,
    ignoredAt: p.ignoredAt?.toISOString() ?? null,
    dispatchPid: p.dispatchPid,
    dispatchedAt: p.dispatchedAt?.toISOString() ?? null,
    dispatchFailCount: p.dispatchFailCount,
    claudeSessionId: p.claudeSessionId,
    claudeSessionSystemPromptHash: p.claudeSessionSystemPromptHash,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export function prdsRoutes(): Hono<OrcaEnv> {
  const app = new Hono<OrcaEnv>();

  // GET /api/prds?projectId=... — scan disk, reconcile rows, parse counts.
  app.get("/", async (c) => {
    const db = c.get("db");
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId required" }, 400);
    const [project] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId));
    if (!project) return c.json({ error: "project not found" }, 404);

    const repoPath = expandTilde(project.repoPath);
    const scanned = await scanPrdFiles(project.repoPath, project.prdIgnoredFolders ?? []);
    const rows = await db
      .select()
      .from(schema.prds)
      .where(eq(schema.prds.projectId, projectId));
    const rowByPath = new Map<string, PrdRow>(rows.map((r) => [r.relPath, r]));

    // Create rows for newly-discovered files.
    for (const s of scanned) {
      if (rowByPath.has(s.relPath)) continue;
      const content = await readFile(join(repoPath, s.relPath), "utf8").catch(() => "");
      // No discovery baseline — the heartbeat decides whether to draft based on
      // whether the drafter has actually run (lastProcessedAt) and whether the
      // doc looks like a PRD. Plain prose .md never gets drafted.
      const [inserted] = await db
        .insert(schema.prds)
        .values({ projectId, relPath: s.relPath, title: prdTitle(content) })
        .onConflictDoNothing()
        .returning();
      if (inserted) rowByPath.set(s.relPath, inserted);
      else {
        const [r] = await db
          .select()
          .from(schema.prds)
          .where(and(eq(schema.prds.projectId, projectId), eq(schema.prds.relPath, s.relPath)));
        if (r) rowByPath.set(s.relPath, r);
      }
    }

    const summaries: PrdSummary[] = [];
    for (const s of scanned) {
      const row = rowByPath.get(s.relPath);
      if (!row) continue;
      const content = await readFile(join(repoPath, s.relPath), "utf8").catch(() => "");
      const parse = parsePrdDoc(content);
      summaries.push({
        id: row.id,
        projectId,
        relPath: s.relPath,
        title: parse.title || row.title || s.relPath.split("/").pop() || s.relPath,
        lastModified: s.mtime.toISOString(),
        outstandingBullets: parse.bullets.outstanding,
        outstandingQuestions: parse.outstandingQuestions,
        readyItems: parse.bullets.ready,
        doneItems: parse.bullets.done,
        totalItems: parse.bullets.total,
        iceboxed: parse.iceboxed,
        completed: parse.completed,
        ignored: row.ignoredAt != null,
        missing: false,
        dispatchPid: row.dispatchPid,
        dispatchedAt: row.dispatchedAt?.toISOString() ?? null,
        activeAgent:
          row.dispatchPid != null ? row.dispatchState?.args?.agentName ?? null : null,
      });
    }
    summaries.sort((a, b) => (b.lastModified ?? "").localeCompare(a.lastModified ?? ""));
    return c.json({ prds: summaries });
  });

  // POST /api/prds/ignore-folder — register BEFORE /:id routes so the static
  // segment isn't captured as an id.
  const ignoreFolderSchema = z.object({ projectId: z.string().uuid(), folder: z.string().min(1) });
  app.post("/ignore-folder", async (c) => {
    const db = c.get("db");
    const body = ignoreFolderSchema.parse(await c.req.json());
    const [project] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, body.projectId));
    if (!project) return c.json({ error: "project not found" }, 404);
    const folder = body.folder.replace(/^\/+|\/+$/g, "");
    const next = Array.from(new Set([...(project.prdIgnoredFolders ?? []), folder]));
    await db
      .update(schema.projects)
      .set({ prdIgnoredFolders: next, updatedAt: new Date() })
      .where(eq(schema.projects.id, body.projectId));
    return c.json({ ok: true, ignoredFolders: next });
  });

  app.post("/unignore-folder", async (c) => {
    const db = c.get("db");
    const body = ignoreFolderSchema.parse(await c.req.json());
    const [project] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, body.projectId));
    if (!project) return c.json({ error: "project not found" }, 404);
    const folder = body.folder.replace(/^\/+|\/+$/g, "");
    const next = (project.prdIgnoredFolders ?? []).filter((f) => f !== folder);
    await db
      .update(schema.projects)
      .set({ prdIgnoredFolders: next, updatedAt: new Date() })
      .where(eq(schema.projects.id, body.projectId));
    return c.json({ ok: true, ignoredFolders: next });
  });

  // GET /api/prds/:id — row + file content + parsed structure. Polled every
  // 4s by the open detail panel, so it deliberately does NOT embed the agent
  // history: a big feed made every poll (and the first paint of *any* tab)
  // crawl. History is lazy-loaded + paginated via GET /:id/activity below; this
  // payload only carries the event count (for the tab badge).
  app.get("/:id", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const [prd] = await db.select().from(schema.prds).where(eq(schema.prds.id, id));
    if (!prd) return c.json({ error: "not found" }, 404);
    const [project] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, prd.projectId));
    const repoPath = project ? expandTilde(project.repoPath) : "";
    const content = await readFile(join(repoPath, prd.relPath), "utf8").catch(() => "");
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.activityEvents)
      .where(
        and(
          eq(schema.activityEvents.targetKind, "prd"),
          eq(schema.activityEvents.targetId, id),
        ),
      );
    return c.json({
      prd: serializePrd(prd),
      content,
      parse: parsePrdDoc(content),
      activityCount: count,
    });
  });

  // GET /api/prds/:id/activity?limit=&before=&beforeId= — paginated agent
  // history, newest-first. Keyset pagination on (createdAt, id) DESC so "load
  // older" can't skip or duplicate rows even when timestamps collide; backed by
  // the (target_kind, target_id, created_at) index. Only fetched when the
  // History tab is open, so the heavy feed never blocks the rest of the panel.
  app.get("/:id/activity", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 60, 1), 200);
    const before = c.req.query("before");
    const beforeId = c.req.query("beforeId");

    const conds = [
      eq(schema.activityEvents.targetKind, "prd"),
      eq(schema.activityEvents.targetId, id),
    ];
    if (before && beforeId) {
      conds.push(
        sql`(${schema.activityEvents.createdAt}, ${schema.activityEvents.id}) < (${before}::timestamptz, ${beforeId}::uuid)`,
      );
    }

    // Fetch one extra row to know whether an older page exists.
    const rows = await db
      .select()
      .from(schema.activityEvents)
      .where(and(...conds))
      .orderBy(desc(schema.activityEvents.createdAt), desc(schema.activityEvents.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);

    // Workspace path (for the history noise filter) lives on the most recent
    // dispatch_started; derive it server-side so the client doesn't need the
    // whole feed loaded to find it.
    const [ds] = await db
      .select({ payload: schema.activityEvents.payload })
      .from(schema.activityEvents)
      .where(
        and(
          eq(schema.activityEvents.targetKind, "prd"),
          eq(schema.activityEvents.targetId, id),
          eq(schema.activityEvents.kind, "dispatch_started"),
        ),
      )
      .orderBy(desc(schema.activityEvents.createdAt))
      .limit(1);
    const workspace = (ds?.payload?.repoPath as string | undefined) ?? null;

    return c.json({
      events: page.map(serializeActivity),
      hasMore,
      workspace,
    });
  });

  // PATCH /api/prds/:id/content — write the file (debounced autosave source).
  const contentSchema = z.object({ content: z.string() });
  app.patch("/:id/content", async (c) => {
    const db = c.get("db");
    const body = contentSchema.parse(await c.req.json());
    const prd = await loadPrdWithProject(db, c.req.param("id"));
    if (!prd) return c.json({ error: "not found" }, 404);
    await withFileWriteLock(prd.abs, async () => {
      await atomicWriteFile(prd.abs, body.content);
      await db
        .update(schema.prds)
        .set({ title: prdTitle(body.content) || prd.row.title, lastChangeAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.prds.id, prd.row.id));
    });
    return c.json({ ok: true });
  });

  // POST /api/prds/:id/answer — write text into a question's --- Q## --- block.
  const answerSchema = z.object({ questionId: z.string().min(1), answer: z.string() });
  app.post("/:id/answer", async (c) => {
    const db = c.get("db");
    const body = answerSchema.parse(await c.req.json());
    const prd = await loadPrdWithProject(db, c.req.param("id"));
    if (!prd) return c.json({ error: "not found" }, 404);
    try {
      await withFileWriteLock(prd.abs, async () => {
        // Read WITHOUT swallowing errors into "". The agent's Write tool
        // truncates-then-rewrites the PRD, so a read that lands mid-write (or
        // any transient fs error) would come back "" — and persisting that
        // nukes the entire document. A failed read must abort, never write.
        const content = await readFile(prd.abs, "utf8");
        const next = setPrdAnswer(content, body.questionId, body.answer);
        // Defense-in-depth: an answer write must never shrink a non-empty PRD
        // to empty. If it would, something is wrong upstream — abort the write.
        if (content.trim().length > 0 && next.trim().length === 0) {
          throw new Error("answer write would empty a non-empty PRD");
        }
        await atomicWriteFile(prd.abs, next);
        // Durable source of truth: persist the answer keyed by question id so the
        // drafter's next wholesale rewrite can't lose it — its post-run merge
        // re-applies every still-open answer from here. (See prd-dispatch.ts.)
        // jsonb concat (`||`) merges keys server-side, so concurrent answers to
        // different questions don't clobber each other's map entries.
        await db
          .update(schema.prds)
          .set({
            answers: sql`COALESCE(${schema.prds.answers}, '{}'::jsonb) || ${JSON.stringify(
              { [body.questionId]: body.answer },
            )}::jsonb`,
            lastChangeAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.prds.id, prd.row.id));
      });
    } catch (err) {
      console.error(`[orca/prds] answer write failed for ${prd.row.id}:`, err);
      return c.json({ error: "answer write failed" }, 500);
    }
    return c.json({ ok: true });
  });

  // POST /api/prds/:id/ignore | /unignore (file-level).
  app.post("/:id/ignore", async (c) => {
    const db = c.get("db");
    const [updated] = await db
      .update(schema.prds)
      .set({ ignoredAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.prds.id, c.req.param("id")))
      .returning();
    if (!updated) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });
  app.post("/:id/unignore", async (c) => {
    const db = c.get("db");
    const [updated] = await db
      .update(schema.prds)
      .set({ ignoredAt: null, updatedAt: new Date() })
      .where(eq(schema.prds.id, c.req.param("id")))
      .returning();
    if (!updated) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  // POST /api/prds/:id/dispatch — force the drafter now (fire-and-forget).
  app.post("/:id/dispatch", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const [prd] = await db.select().from(schema.prds).where(eq(schema.prds.id, id));
    if (!prd) return c.json({ error: "not found" }, 404);
    if (prd.dispatchPid != null) return c.json({ ok: true, note: "already running" }, 202);
    runPrdDispatch({ db, prdId: id, mode: "draft", trigger: "manual" }).catch((err) =>
      console.error(`[orca] prd draft dispatch failed for ${id}:`, err),
    );
    return c.json({ ok: true }, 202);
  });

  // POST /api/prds/:id/implement — force full-stack-engineer now.
  app.post("/:id/implement", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const [prd] = await db.select().from(schema.prds).where(eq(schema.prds.id, id));
    if (!prd) return c.json({ error: "not found" }, 404);
    if (prd.dispatchPid != null) return c.json({ ok: true, note: "already running" }, 202);
    runPrdDispatch({ db, prdId: id, mode: "implement", trigger: "manual" }).catch((err) =>
      console.error(`[orca] prd implement dispatch failed for ${id}:`, err),
    );
    return c.json({ ok: true }, 202);
  });

  // POST /api/prds/:id/stop — hard-stop the running drafter/full-stack-engineer.
  // Kills the process AND stamps dispatchStoppedAt so the heartbeat won't
  // immediately re-dispatch (it stays paused until the file changes again or a
  // manual dispatch clears the flag).
  app.post("/:id/stop", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const [prd] = await db.select().from(schema.prds).where(eq(schema.prds.id, id));
    if (!prd) return c.json({ error: "not found" }, 404);
    if (prd.dispatchPid == null) return c.json({ ok: true, noop: true });

    const agentName = prd.dispatchState?.args?.agentName ?? "drafter";
    killTargetProcesses(id, prd.dispatchPid);
    await db
      .update(schema.prds)
      .set({
        dispatchPid: null,
        dispatchState: null,
        dispatchStoppedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.prds.id, id));
    await db.insert(schema.activityEvents).values({
      storyId: null,
      targetKind: "prd",
      targetId: id,
      kind: "dispatch_interrupted",
      actor: "user",
      payload: sanitizeForJsonb({ reason: "manual_stop", agent: agentName }),
    });
    return c.json({ ok: true });
  });

  return app;
}

async function loadPrdWithProject(
  db: OrcaEnv["Variables"]["db"],
  id: string,
): Promise<{ row: PrdRow; abs: string } | null> {
  const [row] = await db.select().from(schema.prds).where(eq(schema.prds.id, id));
  if (!row) return null;
  const [project] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, row.projectId));
  if (!project) return null;
  return { row, abs: join(expandTilde(project.repoPath), row.relPath) };
}
