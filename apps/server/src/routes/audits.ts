import { Hono } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import { schema } from "@orca/db";
import { sanitizeForJsonb } from "../services/sanitize-jsonb.js";
import { z } from "zod";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  AuditCheck,
  AuditCheckSummary,
  AuditFinding,
} from "@orca/shared";
import type { AuditCheckRow, AuditFindingRow } from "@orca/db";
import type { OrcaEnv } from "../app.js";
import { expandTilde } from "../services/dispatch-prompt-util.js";
import { serializeActivity } from "../services/serialize-activity.js";
import {
  runAuditDispatch,
  auditPromptPath,
  computeNextRunAt,
} from "../services/audit-dispatch.js";
import { killTargetProcesses } from "../services/cli-dispatch.js";

function serializeCheck(r: AuditCheckRow): AuditCheck {
  return {
    id: r.id,
    projectId: r.projectId,
    slug: r.slug,
    name: r.name,
    scheduleKind: r.scheduleKind,
    scheduleTime: r.scheduleTime,
    scheduleDays: r.scheduleDays,
    lastRunAt: r.lastRunAt?.toISOString() ?? null,
    nextRunAt: r.nextRunAt?.toISOString() ?? null,
    dispatchPid: r.dispatchPid,
    dispatchedAt: r.dispatchedAt?.toISOString() ?? null,
    dispatchFailCount: r.dispatchFailCount,
    claudeSessionId: r.claudeSessionId,
    claudeSessionSystemPromptHash: r.claudeSessionSystemPromptHash,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function serializeFinding(r: AuditFindingRow): AuditFinding {
  return {
    id: r.id,
    auditCheckId: r.auditCheckId,
    kind: r.kind,
    status: r.status,
    title: r.title,
    detail: r.detail,
    proposedFix: r.proposedFix,
    answer: r.answer,
    answeredAt: r.answeredAt?.toISOString() ?? null,
    targetPrdRelPath: r.targetPrdRelPath,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// Ensure a per-project 'frontend' audit exists. Starter check that runs the
// frontend directive. Idempotent via the (project_id, slug) unique constraint.
async function ensureStarterChecks(
  db: OrcaEnv["Variables"]["db"],
  projectId: string,
): Promise<void> {
  await db
    .insert(schema.auditChecks)
    .values({ projectId, slug: "frontend", name: "Frontend audit" })
    .onConflictDoNothing();
}

export function auditsRoutes(): Hono<OrcaEnv> {
  const app = new Hono<OrcaEnv>();

  // GET /api/audits?projectId=... — checks for the project + open counts.
  app.get("/", async (c) => {
    const db = c.get("db");
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId required" }, 400);
    await ensureStarterChecks(db, projectId);
    const checks = await db
      .select()
      .from(schema.auditChecks)
      .where(eq(schema.auditChecks.projectId, projectId));
    const checkIds = checks.map((c2) => c2.id);
    const openFindings = checkIds.length
      ? await db
          .select({
            auditCheckId: schema.auditFindings.auditCheckId,
            kind: schema.auditFindings.kind,
          })
          .from(schema.auditFindings)
          .where(
            and(
              inArray(schema.auditFindings.auditCheckId, checkIds),
              eq(schema.auditFindings.status, "open"),
            ),
          )
      : [];
    const counts = new Map<string, { q: number; f: number }>();
    for (const f of openFindings) {
      const e = counts.get(f.auditCheckId) ?? { q: 0, f: 0 };
      if (f.kind === "question") e.q++;
      else e.f++;
      counts.set(f.auditCheckId, e);
    }
    const summaries: AuditCheckSummary[] = checks.map((r) => ({
      ...serializeCheck(r),
      openQuestions: counts.get(r.id)?.q ?? 0,
      openFails: counts.get(r.id)?.f ?? 0,
      activeAgent: r.dispatchPid != null ? r.dispatchState?.args?.agentName ?? null : null,
    }));
    summaries.sort((a, b) => a.name.localeCompare(b.name));
    return c.json({ audits: summaries });
  });

  // GET /api/audits/:id — check + flat-file prompt + findings.
  app.get("/:id", async (c) => {
    const db = c.get("db");
    const [check] = await db
      .select()
      .from(schema.auditChecks)
      .where(eq(schema.auditChecks.id, c.req.param("id")));
    if (!check) return c.json({ error: "not found" }, 404);
    const prompt = await readFile(auditPromptPath(check.slug), "utf8").catch(() => "");
    const findings = await db
      .select()
      .from(schema.auditFindings)
      .where(eq(schema.auditFindings.auditCheckId, check.id))
      .orderBy(schema.auditFindings.createdAt);
    const activity = await db
      .select()
      .from(schema.activityEvents)
      .where(
        and(
          eq(schema.activityEvents.targetKind, "audit"),
          eq(schema.activityEvents.targetId, check.id),
        ),
      )
      .orderBy(schema.activityEvents.createdAt);
    return c.json({
      audit: serializeCheck(check),
      prompt,
      findings: findings.map(serializeFinding),
      activity: activity.map(serializeActivity),
    });
  });

  // PUT /api/audits/:id/prompt — save the flat-file prompt.
  const promptSchema = z.object({ prompt: z.string() });
  app.put("/:id/prompt", async (c) => {
    const db = c.get("db");
    const body = promptSchema.parse(await c.req.json());
    const [check] = await db
      .select()
      .from(schema.auditChecks)
      .where(eq(schema.auditChecks.id, c.req.param("id")));
    if (!check) return c.json({ error: "not found" }, 404);
    const path = auditPromptPath(check.slug);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body.prompt, "utf8");
    return c.json({ ok: true });
  });

  // PATCH /api/audits/:id/schedule
  const scheduleSchema = z.object({
    scheduleKind: z.enum(["manual", "daily", "weekly"]),
    scheduleTime: z.string().regex(/^\d{1,2}:\d{2}$/).nullable().optional(),
    scheduleDays: z.array(z.number().int().min(0).max(6)).optional(),
  });
  app.patch("/:id/schedule", async (c) => {
    const db = c.get("db");
    const body = scheduleSchema.parse(await c.req.json());
    const [check] = await db
      .select()
      .from(schema.auditChecks)
      .where(eq(schema.auditChecks.id, c.req.param("id")));
    if (!check) return c.json({ error: "not found" }, 404);
    const scheduleTime = body.scheduleKind === "manual" ? null : body.scheduleTime ?? null;
    const scheduleDays = body.scheduleDays ?? check.scheduleDays;
    const nextRunAt = computeNextRunAt(body.scheduleKind, scheduleTime, scheduleDays);
    const [updated] = await db
      .update(schema.auditChecks)
      .set({
        scheduleKind: body.scheduleKind,
        scheduleTime,
        scheduleDays,
        nextRunAt,
        updatedAt: new Date(),
      })
      .where(eq(schema.auditChecks.id, check.id))
      .returning();
    return c.json({ audit: serializeCheck(updated!) });
  });

  // POST /api/audits/:id/run — force a run now (fire-and-forget).
  app.post("/:id/run", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const [check] = await db.select().from(schema.auditChecks).where(eq(schema.auditChecks.id, id));
    if (!check) return c.json({ error: "not found" }, 404);
    if (check.dispatchPid != null) return c.json({ ok: true, note: "already running" }, 202);
    runAuditDispatch({ db, auditCheckId: id, mode: "run", trigger: "manual" }).catch((err) =>
      console.error(`[orca] audit run failed for ${id}:`, err),
    );
    return c.json({ ok: true }, 202);
  });

  // POST /api/audits/:id/stop — hard-stop the running audit-runner / fixer.
  // Kills the process AND stamps dispatchStoppedAt so the heartbeat won't
  // immediately re-dispatch (open-fail fixes stay paused until the next run;
  // a scheduled run resumes once its due time advances past the stop).
  app.post("/:id/stop", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const [check] = await db.select().from(schema.auditChecks).where(eq(schema.auditChecks.id, id));
    if (!check) return c.json({ error: "not found" }, 404);
    if (check.dispatchPid == null) return c.json({ ok: true, noop: true });

    const agentName = check.dispatchState?.args?.agentName ?? "audit-runner";
    killTargetProcesses(id, check.dispatchPid);
    await db
      .update(schema.auditChecks)
      .set({
        dispatchPid: null,
        dispatchState: null,
        dispatchStoppedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.auditChecks.id, id));
    await db.insert(schema.activityEvents).values({
      storyId: null,
      targetKind: "audit",
      targetId: id,
      kind: "dispatch_interrupted",
      actor: "user",
      payload: sanitizeForJsonb({ reason: "manual_stop", agent: agentName }),
    });
    return c.json({ ok: true });
  });

  // POST /api/audits/:id/findings — the audit run agent reports findings here.
  const findingsSchema = z.object({
    replaceOpen: z.boolean().optional(),
    findings: z.array(
      z.object({
        kind: z.enum(["question", "fail"]),
        title: z.string().min(1),
        detail: z.string().optional(),
        proposedFix: z.string().optional(),
        targetPrdRelPath: z.string().optional(),
      }),
    ),
  });
  app.post("/:id/findings", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const body = findingsSchema.parse(await c.req.json());
    const [check] = await db.select().from(schema.auditChecks).where(eq(schema.auditChecks.id, id));
    if (!check) return c.json({ error: "not found" }, 404);
    if (body.replaceOpen) {
      await db
        .update(schema.auditFindings)
        .set({ status: "obsolete", updatedAt: new Date() })
        .where(
          and(
            eq(schema.auditFindings.auditCheckId, id),
            eq(schema.auditFindings.status, "open"),
          ),
        );
    }
    if (body.findings.length > 0) {
      await db.insert(schema.auditFindings).values(
        body.findings.map((f) => ({
          auditCheckId: id,
          kind: f.kind,
          title: f.title,
          detail: f.detail ?? "",
          proposedFix: f.proposedFix ?? null,
          targetPrdRelPath: f.targetPrdRelPath ?? null,
        })),
      );
    }
    return c.json({ ok: true, inserted: body.findings.length });
  });

  // POST /api/audits/findings/:fid/answer — record answer + route into a PRD.
  const findingAnswerSchema = z.object({
    answer: z.string().min(1),
    targetPrdRelPath: z.string().optional(),
  });
  app.post("/findings/:fid/answer", async (c) => {
    const db = c.get("db");
    const fid = c.req.param("fid");
    const body = findingAnswerSchema.parse(await c.req.json());
    const [finding] = await db
      .select()
      .from(schema.auditFindings)
      .where(eq(schema.auditFindings.id, fid));
    if (!finding) return c.json({ error: "not found" }, 404);
    const [check] = await db
      .select()
      .from(schema.auditChecks)
      .where(eq(schema.auditChecks.id, finding.auditCheckId));

    const targetPrdRelPath = body.targetPrdRelPath ?? finding.targetPrdRelPath ?? null;
    // Route the Q+A into the chosen PRD as a question block the drafter folds in.
    if (targetPrdRelPath && check) {
      await routeAnswerIntoPrd(db, check.projectId, targetPrdRelPath, finding, body.answer);
    }
    await db
      .update(schema.auditFindings)
      .set({
        status: "answered",
        answer: body.answer,
        answeredAt: new Date(),
        targetPrdRelPath,
        updatedAt: new Date(),
      })
      .where(eq(schema.auditFindings.id, fid));
    return c.json({ ok: true });
  });

  app.post("/findings/:fid/resolve", async (c) => {
    const db = c.get("db");
    const [u] = await db
      .update(schema.auditFindings)
      .set({ status: "resolved", updatedAt: new Date() })
      .where(eq(schema.auditFindings.id, c.req.param("fid")))
      .returning();
    if (!u) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });
  app.post("/findings/:fid/dismiss", async (c) => {
    const db = c.get("db");
    const [u] = await db
      .update(schema.auditFindings)
      .set({ status: "obsolete", updatedAt: new Date() })
      .where(eq(schema.auditFindings.id, c.req.param("fid")))
      .returning();
    if (!u) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  return app;
}

// Append an answered question block into the target PRD so the drafter blends
// the audit answer into the doc on its next pass.
async function routeAnswerIntoPrd(
  db: OrcaEnv["Variables"]["db"],
  projectId: string,
  relPath: string,
  finding: AuditFindingRow,
  answer: string,
): Promise<void> {
  const [project] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId));
  if (!project) return;
  const abs = join(expandTilde(project.repoPath), relPath);
  const existing = await readFile(abs, "utf8").catch(() => null);
  if (existing == null) return;
  const qid = `Qaudit-${finding.id.slice(0, 8)}`;
  const block = [
    "",
    `❓ (from audit) ${finding.title}`,
    ...(finding.detail ? [finding.detail] : []),
    `--- ${qid} ---`,
    answer,
    `/// ${qid} ///`,
    "",
  ].join("\n");
  await writeFile(abs, `${existing.replace(/\s*$/, "")}\n${block}`, "utf8");

  const [prdRow] = await db
    .select()
    .from(schema.prds)
    .where(and(eq(schema.prds.projectId, projectId), eq(schema.prds.relPath, relPath)));
  if (prdRow) {
    await db
      .update(schema.prds)
      .set({ lastChangeAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.prds.id, prdRow.id));
  }
}
