import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { schema } from "@orca/db";
import { z } from "zod";
import type { AuditStatus } from "@orca/shared";
import type { OrcaEnv } from "../app.js";
import { resyncImplementationAudit } from "../services/audit-resync.js";

const updateRowSchema = z.object({
  status: z.enum([
    "unaudited",
    "implemented",
    "partially-implemented",
    "not-implemented",
    "forgone",
    "substituted",
  ]),
  decisionReason: z.string().nullable().optional(),
  substituteRecipeSlug: z.string().nullable().optional(),
  customSubstituteNotes: z.string().nullable().optional(),
  linkedStoryIds: z.array(z.string().uuid()).optional(),
  linkedTriggerIds: z.array(z.string().uuid()).optional(),
  /** Who is making this update — "user" (default) or an agent name. */
  actor: z.string().optional(),
});

export function auditRoutes(): Hono<OrcaEnv> {
  const app = new Hono<OrcaEnv>();

  app.get("/", async (c) => {
    const db = c.get("db");
    const projectId = c.req.query("projectId");
    const status = c.req.query("status") as AuditStatus | undefined;

    // Auto-resync disabled — only on-demand manual audits for now.
    // See: "audits - disable automated audit" story.

    const conditions = [];
    if (projectId)
      conditions.push(eq(schema.implementationAudit.projectId, projectId));
    if (status) conditions.push(eq(schema.implementationAudit.status, status));

    const rows = await db
      .select()
      .from(schema.implementationAudit)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(schema.implementationAudit.cluster, schema.implementationAudit.concernTitle);

    return c.json({ rows });
  });

  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const { actor, ...fields } = updateRowSchema.parse(await c.req.json());
    const db = c.get("db");

    // `unaudited` means "reset to unreviewed" — clear the review timestamp.
    // All other statuses represent a completed review and get a fresh stamp.
    const reviewedAt = fields.status === "unaudited" ? null : new Date();

    const [updated] = await db
      .update(schema.implementationAudit)
      .set({
        ...fields,
        recipeStale: false,
        lastReviewedAt: reviewedAt,
        lastReviewedBy: (actor ?? "user") as import("@orca/shared").AuditLastReviewedBy,
        updatedAt: new Date(),
      })
      .where(eq(schema.implementationAudit.id, id))
      .returning();
    if (!updated) return c.json({ error: "audit row not found" }, 404);
    return c.json({ row: updated });
  });

  /** Resync recipe files — discovers new recipes, updates metadata. */
  app.post("/resync", async (c) => {
    const db = c.get("db");
    const { projectId } = z
      .object({ projectId: z.string().uuid() })
      .parse(await c.req.json());

    const result = await resyncImplementationAudit(db, projectId);
    return c.json(result);
  });

  /**
   * Per-row AI audit — creates a backlogged story assigned to the
   * "auditor" agent. Normal dispatch picks it up, giving full prompt
   * logging and visibility in the activity stream.
   */
  app.post("/:id/verify", async (c) => {
    const id = c.req.param("id");
    const db = c.get("db");

    const [row] = await db
      .select()
      .from(schema.implementationAudit)
      .where(eq(schema.implementationAudit.id, id));
    if (!row) return c.json({ error: "audit row not found" }, 404);
    if (row.status === "forgone") {
      return c.json({ error: "forgone rows do not need audit" }, 400);
    }

    const [story] = await db
      .insert(schema.stories)
      .values({
        projectId: row.projectId,
        title: `audit ${row.concernSlug} rx`,
        specMd: "",
        status: "backlog",
        agent: "auditor",
        labels: ["audit-generated"],
        priority: 0,
      })
      .returning();

    if (!story) {
      return c.json({ error: "failed to create audit story" }, 500);
    }

    await db.insert(schema.activityEvents).values({
      storyId: story.id,
      kind: "story_created",
      actor: "auditor",
      payload: {
        title: story.title,
        auditRowId: id,
        concernSlug: row.concernSlug,
      },
    });

    return c.json({ ok: true, storyId: story.id, message: "audit story created" }, 202);
  });

  return app;
}
