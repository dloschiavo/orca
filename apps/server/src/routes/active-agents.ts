import { Hono } from "hono";
import { isNotNull } from "drizzle-orm";
import { schema } from "@orca/db";
import type { CliDispatchState } from "@orca/shared";
import type { OrcaEnv } from "../app.js";

// Cheap, DB-only view of the PRD/audit dispatches that are live right now (no
// disk scan). The sidebar merges these with the story-agent buckets so the
// drafter / full-stack-engineer / audit-runner show up under "Active agents"
// with the item they're processing + the running animation.
export function activeAgentsRoutes(): Hono<OrcaEnv> {
  const app = new Hono<OrcaEnv>();

  app.get("/", async (c) => {
    const db = c.get("db");
    const [prds, audits] = await Promise.all([
      db.select().from(schema.prds).where(isNotNull(schema.prds.dispatchPid)),
      db.select().from(schema.auditChecks).where(isNotNull(schema.auditChecks.dispatchPid)),
    ]);
    const agentOf = (state: CliDispatchState | null, fallback: string) =>
      state?.args?.agentName ?? fallback;
    const dispatches = [
      ...prds.map((p) => ({
        agent: agentOf(p.dispatchState, "drafter"),
        kind: "prd" as const,
        id: p.id,
        projectId: p.projectId,
        label: p.title || p.relPath,
        dispatchedAt: p.dispatchedAt ? p.dispatchedAt.toISOString() : null,
      })),
      ...audits.map((a) => ({
        agent: agentOf(a.dispatchState, "audit-runner"),
        kind: "audit" as const,
        id: a.id,
        projectId: a.projectId,
        label: a.name,
        dispatchedAt: a.dispatchedAt ? a.dispatchedAt.toISOString() : null,
      })),
    ];
    return c.json({ dispatches });
  });

  return app;
}
