import { Hono } from "hono";
import { eq, sql, desc, asc } from "drizzle-orm";
import { schema } from "@orca/db";
import { z } from "zod";
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { exec, spawn } from "node:child_process";
import type { OrcaEnv } from "../app.js";
import { seedImplementationAudit } from "../services/audit-seed.js";
import type { ServerConfig, ServerEndpoint } from "@orca/shared";

const createProjectSchema = z.object({
  name: z.string().min(1),
  repoPath: z.string().min(1),
  riderPath: z.string().optional(),
});

export function projectsRoutes(): Hono<OrcaEnv> {
  const app = new Hono<OrcaEnv>();

  /* ── GET /server-status — check running status for all projects ─ */
  /* Registered before /:id so the literal path wins over the param. */
  app.get("/server-status", async (c) => {
    const db = c.get("db");
    const rows = await db
      .select({
        id: schema.projects.id,
        repoPath: schema.projects.repoPath,
      })
      .from(schema.projects);

    // ── Pass 1: discover what's actually running ──
    // Enumerate every listening TCP socket on the box, resolve each PID's
    // cwd + cmdline, then match cwds to project repoPaths. This is the
    // ground truth — service-ports.mjs registry files (/tmp/goliath-*) are
    // explicitly NOT consulted; the recipe has shipped buggy revisions
    // and the registry can lie. lsof can't.
    const listeners = await discoverAllListeners();

    // Sort projects by repoPath length DESC so nested projects match
    // before their parents (e.g. orca/apps/server vs orca).
    const ranked = [...rows].sort(
      (a, b) => normalizePath(b.repoPath).length - normalizePath(a.repoPath).length,
    );

    // Dedupe discovered listeners on (port, cwd) — uvicorn/expo fork workers
    // that share the listening socket via SO_REUSEADDR, so the same port
    // shows up under multiple PIDs. Keep the most specific framework match.
    type BestPick = DiscoveredEndpoint & { specificity: number };
    const discoveredByProject = new Map<string, Map<string, BestPick>>();
    // Track which PIDs are listeners we already represent as endpoint pips,
    // so the stray-process pass doesn't double-list them.
    const listenerPidsByProject = new Map<string, Set<number>>();
    for (const r of rows) {
      discoveredByProject.set(r.id, new Map());
      listenerPidsByProject.set(r.id, new Set());
    }

    // Resolve the *effective* cwd for each listener — preferring the
    // package.json that owns the source file named in the cmdline over
    // the OS-reported cwd. Fixes Biblia: `tsx watch apps/api/src/index.ts`
    // launched from `apps/mobile` should be attributed to `apps/api`.
    const effectiveCwds = await Promise.all(
      listeners.map((l) => effectiveCwd(l.cwd, l.cmd)),
    );

    for (let i = 0; i < listeners.length; i++) {
      const l = listeners[i]!;
      const cwd = normalizePath(effectiveCwds[i]!);
      const match = ranked.find((r) => {
        const repo = normalizePath(r.repoPath);
        return cwd === repo || cwd.startsWith(repo + "/");
      });
      if (!match) continue;
      listenerPidsByProject.get(match.id)!.add(l.pid);
      const cls = classifyProcess(l.cmd);
      const relCwd = cwd === normalizePath(match.repoPath)
        ? undefined
        : cwd.slice(normalizePath(match.repoPath).length + 1);
      const key = `${l.port}|${relCwd ?? ""}`;
      const bucket = discoveredByProject.get(match.id)!;
      const prev = bucket.get(key);
      if (!prev || cls.specificity > prev.specificity) {
        bucket.set(key, {
          kind: cls.kind,
          framework: cls.framework,
          port: l.port,
          cwd: relCwd,
          running: true,
          specificity: cls.specificity,
        });
      }
    }

    // ── Pass 2: declared services from in-repo package.json scripts ──
    // Walk each project's repoPath subtree and parse every package.json's
    // scripts to find declared services. Two sources, in priority order:
    //   (a) `service-ports.mjs --framework F --canonical-port N` — explicit,
    //       authoritative declaration of one service.
    //   (b) Dep + script inference — fallback for projects that don't use
    //       service-ports yet (e.g. plain `expo start`). At most one
    //       endpoint per package.json so a transitive `express` dep
    //       inside an Expo app can't fabricate a phantom backend.
    const declaredByProject = new Map<string, DeclaredService[]>();
    await Promise.all(
      rows.map(async (r) => {
        try {
          declaredByProject.set(r.id, await readDeclaredServices(r.repoPath));
        } catch {
          declaredByProject.set(r.id, []);
        }
      }),
    );

    // ── Pass 3: dev-server-ish processes (incl. non-listening parents) ──
    // npm / pnpm / concurrently / tsx-watch wrappers don't bind a port, so
    // they never show up in pass 1. Enumerate them here so we can surface
    // strays — orphans of prior sessions whose listener got killed but
    // whose wrapper survived.
    //
    // Build a per-project set of "active pgids" — process-group ids that
    // already own a listener pip above. Any dev proc whose pgid is in this
    // set is part of a *live* server tree (the npm/sh -c parent of a
    // running vite-node, for example) and should NOT be listed as a stray.
    const devProcs = await discoverDevProcesses();
    const activePgidsByProject = new Map<string, Set<number>>();
    for (const r of rows) activePgidsByProject.set(r.id, new Set());
    for (const p of devProcs) {
      // A devProc whose own PID is already a listener for some project is
      // by definition "live"; its pgid is the live tree's pgid.
      for (const [projId, pids] of listenerPidsByProject) {
        if (pids.has(p.pid) && p.pgid > 1) {
          activePgidsByProject.get(projId)!.add(p.pgid);
        }
      }
    }

    const devProcsByProject = new Map<string, StrayProcessInternal[]>();
    for (const r of rows) devProcsByProject.set(r.id, []);
    for (const p of devProcs) {
      const cwd = normalizePath(p.effectiveCwd);
      const match = ranked.find((r) => {
        const repo = normalizePath(r.repoPath);
        return cwd === repo || cwd.startsWith(repo + "/");
      });
      if (!match) continue;
      // Skip live-tree members — see comment above.
      if (activePgidsByProject.get(match.id)!.has(p.pgid)) continue;
      const repoNorm = normalizePath(match.repoPath);
      const relCwd = cwd === repoNorm ? "" : cwd.slice(repoNorm.length + 1);
      devProcsByProject.get(match.id)!.push({
        pid: p.pid,
        cmd: p.cmd,
        etime: p.etime,
        cwd: relCwd,
        port: p.port,
      });
    }

    // ── Merge ──
    // For each declared service: emit it as running=true (with the actual
    // hunted port from discovery) when a matching live proc is found, else
    // running=false at the canonical port. Then add any unmatched live
    // procs as orphan running endpoints so background services still show.
    // Finally, every running next/expo frontend gets a backend twin on the
    // same port — Next.js API routes and expo-router api routes mean the
    // dev server doubles as a local backend.
    const statuses = rows
      .map((r) => {
        const discovered = [...(discoveredByProject.get(r.id)?.values() ?? [])];
        const declared = declaredByProject.get(r.id) ?? [];
        const merged: DiscoveredEndpoint[] = [];
        const usedDiscoveryKeys = new Set<string>();

        for (const cfg of declared) {
          const cfgKey = `${cfg.cwd ?? ""}|${cfg.kind}`;
          const match = discovered.find((d) => {
            if (usedDiscoveryKeys.has(`${d.port}|${d.cwd ?? ""}`)) return false;
            if ((d.cwd ?? "") !== (cfg.cwd ?? "")) return false;
            // For *guessed* (dep-scan) declarations the port is a placeholder
            // (e.g. Express's conventional 3001 when the code actually binds
            // 3000). Match by cwd alone — take whatever port is running. For
            // explicit declarations the port is authoritative.
            if (cfg.guessed) return true;
            return (
              d.port === cfg.canonicalPort ||
              (d.port >= cfg.canonicalPort &&
                d.port <= cfg.canonicalPort + 50)
            );
          });
          if (match) {
            usedDiscoveryKeys.add(`${match.port}|${match.cwd ?? ""}`);
            merged.push({
              kind: cfg.kind,
              framework: cfg.framework,
              port: match.port,
              label: cfg.label,
              cwd: cfg.cwd,
              running: true,
            });
          } else {
            merged.push({
              kind: cfg.kind,
              framework: cfg.framework,
              port: cfg.canonicalPort,
              label: cfg.label,
              cwd: cfg.cwd,
              running: false,
            });
          }
          void cfgKey;
        }

        // Orphan discovered procs (no declared match) — still show them.
        for (const d of discovered) {
          const k = `${d.port}|${d.cwd ?? ""}`;
          if (usedDiscoveryKeys.has(k)) continue;
          merged.push({
            kind: d.kind,
            framework: d.framework,
            port: d.port,
            cwd: d.cwd,
            running: true,
          });
        }

        // Collapse declared-backend + discovered-frontend pairs at the same
        // (port, cwd) into a single entry. Next.js and Expo Router dev
        // servers serve API routes on the same port, so when a project
        // declares both a frontend and a backend at the same port (or a
        // running frontend matches a declared backend's port), they're
        // the same process — one pip, no duplicate label.
        const deduped: DiscoveredEndpoint[] = [];
        for (const e of merged) {
          const idx = deduped.findIndex(
            (d) => d.port === e.port && (d.cwd ?? "") === (e.cwd ?? ""),
          );
          if (idx < 0) {
            deduped.push(e);
            continue;
          }
          const prev = deduped[idx]!;
          // Prefer running over not-running; prefer frontend label (more
          // specific framework) over backend when both apply to one proc.
          if (e.running && !prev.running) {
            deduped[idx] = e;
          } else if (e.running === prev.running && e.kind === "frontend") {
            deduped[idx] = { ...e, label: e.label ?? prev.label };
          }
        }
        merged.length = 0;
        merged.push(...deduped);

        merged.sort((a, b) => {
          if (a.port !== b.port) return a.port - b.port;
          return a.kind.localeCompare(b.kind);
        });

        // Strays = dev procs in this repo that aren't already represented
        // by a listener endpoint pip above.
        const listenerPids = listenerPidsByProject.get(r.id) ?? new Set();
        const strayProcesses = (devProcsByProject.get(r.id) ?? [])
          .filter((p) => !listenerPids.has(p.pid))
          .sort((a, b) => a.pid - b.pid);

        return { projectId: r.id, endpoints: merged, strayProcesses };
      })
      .filter((s) => s.endpoints.length > 0 || s.strayProcesses.length > 0);

    return c.json({ statuses });
  });

  /* ── GET /unattached-dirs — directories under company root
       that are not linked to any project ───────────────────── */
  app.get("/unattached-dirs/list", async (c) => {
    const db = c.get("db");

    // DB setting takes precedence, then env var fallback
    const [setting] = await db
      .select()
      .from(schema.orcaSettings)
      .where(eq(schema.orcaSettings.key, "companyRoot"));
    const root = setting?.value || process.env.ORCA_COMPANY_ROOT || null;

    if (!root) return c.json({ dirs: [], companyRoot: null });

    const allProjects = await db
      .select({ repoPath: schema.projects.repoPath })
      .from(schema.projects);
    const attachedPaths = new Set(allProjects.map((p) => p.repoPath));

    let entries: string[];
    try {
      const dirents = await readdir(root, { withFileTypes: true });
      entries = [];
      for (const d of dirents) {
        if (!d.isDirectory()) continue;
        if (d.name.startsWith(".")) continue; // skip hidden dirs
        const full = join(root, d.name);
        if (!attachedPaths.has(full)) {
          entries.push(d.name);
        }
      }
      entries.sort((a, b) => a.localeCompare(b));
    } catch {
      entries = [];
    }

    return c.json({ dirs: entries, companyRoot: root });
  });

  /* ── PUT /company-root — persist the company root directory ─ */
  app.put("/company-root", async (c) => {
    const { path: rootPath } = z
      .object({ path: z.string().min(1) })
      .parse(await c.req.json());
    const db = c.get("db");
    await db
      .insert(schema.orcaSettings)
      .values({ key: "companyRoot", value: rootPath, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.orcaSettings.key,
        set: { value: rootPath, updatedAt: new Date() },
      });
    return c.json({ ok: true, companyRoot: rootPath });
  });

  app.get("/", async (c) => {
    const db = c.get("db");
    const lastStoryUpdate = db
      .select({
        projectId: schema.stories.projectId,
        lastUpdate: sql<string>`max(${schema.stories.updatedAt})`.as(
          "last_update",
        ),
      })
      .from(schema.stories)
      .groupBy(schema.stories.projectId)
      .as("lsu");

    const rows = await db
      .select({
        id: schema.projects.id,
        name: schema.projects.name,
        repoPath: schema.projects.repoPath,
        riderPath: schema.projects.riderPath,
        context: schema.projects.context,
        capabilities: schema.projects.capabilities,
        heartbeatDefaultIntervalMs:
          schema.projects.heartbeatDefaultIntervalMs,
        serverConfig: schema.projects.serverConfig,
        createdAt: schema.projects.createdAt,
        updatedAt: schema.projects.updatedAt,
      })
      .from(schema.projects)
      .leftJoin(lastStoryUpdate, eq(schema.projects.id, lastStoryUpdate.projectId))
      .orderBy(
        desc(sql`${lastStoryUpdate.lastUpdate} IS NOT NULL`),
        desc(lastStoryUpdate.lastUpdate),
        asc(schema.projects.name),
      );
    return c.json({ projects: rows });
  });

  app.post("/", async (c) => {
    const body = createProjectSchema.parse(await c.req.json());
    const db = c.get("db");
    const [project] = await db
      .insert(schema.projects)
      .values({
        name: body.name,
        repoPath: body.repoPath,
        riderPath: body.riderPath ?? null,
      })
      .returning();
    if (!project) throw new Error("failed to insert project");

    // Auto-detect server config from the repo so status indicators work immediately.
    try {
      const endpoints = await detectServerConfig(project.repoPath);
      if (endpoints.length > 0) {
        const config: ServerConfig = { endpoints };
        const [updated] = await db
          .update(schema.projects)
          .set({ serverConfig: config })
          .where(eq(schema.projects.id, project.id))
          .returning();
        if (updated) Object.assign(project, updated);
        console.log(
          `[orca] auto-detected ${endpoints.length} endpoint(s) for ${project.name}`,
        );
      }
    } catch (e) {
      console.warn(`[orca] server-config detection failed for ${project.name}:`, e);
    }

    // Seed the Implementation Audit matrix on first project create, per the spec.
    const seeded = await seedImplementationAudit(db, project.id);
    console.log(
      `[orca] seeded ${seeded} audit rows for project ${project.name}`,
    );

    return c.json({ project, auditRowsSeeded: seeded }, 201);
  });

  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    const db = c.get("db");
    const [project] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id));
    if (!project) return c.json({ error: "project not found" }, 404);
    return c.json({ project });
  });

  /* ── GET /:id/rider-preview — read the rider file from disk ─ */
  app.get("/:id/rider-preview", async (c) => {
    const id = c.req.param("id");
    const db = c.get("db");
    const [project] = await db
      .select({ repoPath: schema.projects.repoPath, riderPath: schema.projects.riderPath })
      .from(schema.projects)
      .where(eq(schema.projects.id, id));
    if (!project) return c.json({ error: "project not found" }, 404);
    const riderFile = project.riderPath
      ? join(project.repoPath, project.riderPath)
      : join(project.repoPath, "CLAUDE.md");
    let content: string | null = null;
    try {
      content = await readFile(riderFile, "utf8");
    } catch {
      content = null;
    }
    return c.json({ content, path: riderFile });
  });

  /* ── PUT /:id/rider — write rider file to disk ──────────── */
  app.put("/:id/rider", async (c) => {
    const id = c.req.param("id");
    const db = c.get("db");
    const body = await c.req.json();
    const content: string = body.content ?? "";
    const [project] = await db
      .select({ repoPath: schema.projects.repoPath, riderPath: schema.projects.riderPath })
      .from(schema.projects)
      .where(eq(schema.projects.id, id));
    if (!project) return c.json({ error: "project not found" }, 404);
    const riderFile = project.riderPath
      ? join(project.repoPath, project.riderPath)
      : join(project.repoPath, "CLAUDE.md");
    await writeFile(riderFile, content, "utf8");
    return c.json({ ok: true, path: riderFile });
  });

  /* ── PATCH /:id — rename project ─────────────────────────── */
  const serverEndpointSchema = z.object({
    kind: z.enum(["frontend", "backend"]),
    framework: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    label: z.string().optional(),
    startCommand: z.string().optional(),
    cwd: z.string().optional(),
  });

  const patchProjectSchema = z.object({
    name: z.string().min(1).optional(),
    repoPath: z.string().min(1).optional(),
    riderPath: z.string().nullable().optional(),
    context: z.string().nullable().optional(),
    serverConfig: z
      .object({ endpoints: z.array(serverEndpointSchema) })
      .nullable()
      .optional(),
  });

  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const body = patchProjectSchema.parse(await c.req.json());
    const db = c.get("db");
    const [project] = await db
      .update(schema.projects)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(schema.projects.id, id))
      .returning();
    if (!project) return c.json({ error: "project not found" }, 404);
    return c.json({ project });
  });

  /* ── DELETE /:id — remove project from orca ──────────────── */
  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const db = c.get("db");

    // Delete dependent rows first (order matters for FK constraints)
    // Stories and their dependents
    const storyIds = db
      .select({ id: schema.stories.id })
      .from(schema.stories)
      .where(eq(schema.stories.projectId, id));

    await db
      .delete(schema.activityEvents)
      .where(
        sql`${schema.activityEvents.storyId} IN (${storyIds})`,
      );
    await db
      .delete(schema.refinementQuestions)
      .where(
        sql`${schema.refinementQuestions.storyId} IN (${storyIds})`,
      );
    await db
      .delete(schema.storyWorkingMemory)
      .where(
        sql`${schema.storyWorkingMemory.storyId} IN (${storyIds})`,
      );
    await db
      .delete(schema.acceptanceCards)
      .where(
        sql`${schema.acceptanceCards.storyId} IN (${storyIds})`,
      );
    await db
      .delete(schema.dispatches)
      .where(
        sql`${schema.dispatches.storyId} IN (${storyIds})`,
      );
    await db
      .delete(schema.tokenHeatmaps)
      .where(
        sql`${schema.tokenHeatmaps.storyId} IN (${storyIds})`,
      );

    // Findings depend on stories
    const findingIds = db
      .select({ id: schema.findings.id })
      .from(schema.findings)
      .where(
        sql`${schema.findings.storyId} IN (${storyIds})`,
      );
    await db
      .delete(schema.classifications)
      .where(
        sql`${schema.classifications.findingId} IN (${findingIds})`,
      );
    await db
      .delete(schema.findings)
      .where(
        sql`${schema.findings.storyId} IN (${storyIds})`,
      );

    await db.delete(schema.stories).where(eq(schema.stories.projectId, id));

    // Project-level dependents
    await db
      .delete(schema.implementationAudit)
      .where(eq(schema.implementationAudit.projectId, id));
    await db
      .delete(schema.projectRiderSections)
      .where(eq(schema.projectRiderSections.projectId, id));
    await db
      .delete(schema.triggers)
      .where(eq(schema.triggers.projectId, id));

    // Finally, the project itself
    const [deleted] = await db
      .delete(schema.projects)
      .where(eq(schema.projects.id, id))
      .returning();
    if (!deleted) return c.json({ error: "project not found" }, 404);
    return c.json({ ok: true });
  });

  /* ── POST /:id/detect-server-config — auto-detect endpoints ── */
  app.post("/:id/detect-server-config", async (c) => {
    const id = c.req.param("id");
    const db = c.get("db");
    const [project] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id));
    if (!project) return c.json({ error: "project not found" }, 404);

    const endpoints = await detectServerConfig(project.repoPath);
    const config: ServerConfig = { endpoints };
    await db
      .update(schema.projects)
      .set({ serverConfig: config, updatedAt: new Date() })
      .where(eq(schema.projects.id, id));
    return c.json({ serverConfig: config });
  });

  /* ── POST /:id/start — start server process(es) for a project ── */
  /* ── POST /:id/start — launch one declared service in this project ──
       Body: { port?: number, cwd?: string }
       Resolves the service from `readDeclaredServices(repoPath)` matching
       port and/or cwd, then spawns `pnpm dev` (or `npm run dev`) in the
       service's directory. Detached so killing orca doesn't kill the child. */
  app.post("/:id/start", async (c) => {
    const id = c.req.param("id");
    const body = z
      .object({
        port: z.number().int().min(1).max(65535).optional(),
        cwd: z.string().optional(),
      })
      .parse(await c.req.json().catch(() => ({})));
    const db = c.get("db");
    const [project] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id));
    if (!project) return c.json({ error: "project not found" }, 404);

    // Resolve the target service from in-repo declarations.
    const declared = await readDeclaredServices(project.repoPath);
    const target = declared.find((d) => {
      if (body.cwd != null && (d.cwd ?? "") !== body.cwd) return false;
      if (body.port != null && d.canonicalPort !== body.port) return false;
      return true;
    }) ?? declared.find((d) => body.port != null && d.canonicalPort === body.port);
    if (!target) {
      return c.json(
        { error: `no declared service matches port=${body.port} cwd=${body.cwd}` },
        404,
      );
    }

    // Don't relaunch if something is already listening from this dir.
    const liveListeners = await discoverAllListeners();
    const targetDir = target.cwd
      ? join(project.repoPath, target.cwd)
      : project.repoPath;
    const targetDirNorm = normalizePath(targetDir);
    const alreadyUp = liveListeners.some((l) => {
      const lCwd = normalizePath(l.cwd);
      return lCwd === targetDirNorm || lCwd.startsWith(targetDirNorm + "/");
    });
    if (alreadyUp) {
      return c.json({ ok: true, status: "already running", target });
    }

    // Pick package manager: pnpm if pnpm-lock.yaml at repo root, else npm.
    let pkgManager = "npm run dev";
    try {
      await stat(join(project.repoPath, "pnpm-lock.yaml"));
      pkgManager = "pnpm dev";
    } catch { /* fall back to npm */ }

    const child = spawn(pkgManager, {
      cwd: targetDir,
      shell: true,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return c.json({
      ok: true,
      status: "launched",
      pid: child.pid,
      target,
      command: pkgManager,
      cwd: targetDir,
    });
  });

  /* ── POST /:id/stop — kill the listener on `port` for this project ──
       Body: { port: number }
       Verifies the listening PID's effective cwd is inside the project's
       repoPath so we never kill another project's process by mistake.
       SIGTERM first, SIGKILL after 1s if still alive. */
  app.post("/:id/stop", async (c) => {
    const id = c.req.param("id");
    const body = z
      .object({ port: z.number().int().min(1).max(65535) })
      .parse(await c.req.json());
    const db = c.get("db");
    const [project] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id));
    if (!project) return c.json({ error: "project not found" }, 404);

    const repo = normalizePath(project.repoPath);
    const listeners = await discoverAllListeners();
    const candidates = listeners.filter((l) => l.port === body.port);

    // Resolve each candidate's effective cwd (cmdline path > OS cwd) and
    // keep only those rooted in this project's repoPath.
    const owned: { pid: number; cwd: string }[] = [];
    for (const l of candidates) {
      const eff = normalizePath(await effectiveCwd(l.cwd, l.cmd));
      if (eff === repo || eff.startsWith(repo + "/")) {
        owned.push({ pid: l.pid, cwd: eff });
      }
    }
    if (owned.length === 0) {
      return c.json(
        { ok: false, error: `no listener on :${body.port} owned by this project` },
        404,
      );
    }

    // Resolve each listener's process group so we take down the whole
    // dev-server tree (npm → concurrently → tsx watch → vite-node) — not
    // just the leaf listener, which often leaves its wrapper script
    // dangling as a stray.
    const killed: number[] = [];
    const pgids = new Set<number>();
    for (const { pid } of owned) {
      const pgid = await getProcessPgid(pid);
      if (pgid && pgid > 1) pgids.add(pgid);
      try { process.kill(pid, "SIGTERM"); killed.push(pid); }
      catch { /* already gone */ }
    }
    for (const pgid of pgids) {
      try { process.kill(-pgid, "SIGTERM"); }
      catch { /* group already gone */ }
    }
    // Escalate to SIGKILL for any survivor after a grace period.
    setTimeout(() => {
      for (const pid of killed) {
        try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); }
        catch { /* dead, good */ }
      }
      for (const pgid of pgids) {
        try { process.kill(-pgid, "SIGKILL"); }
        catch { /* group already gone */ }
      }
    }, 1000);

    return c.json({ ok: true, killed, pgids: [...pgids] });
  });

  /* ── POST /:id/kill-pid — kill an individual stray process for this
       project. Body: { pid: number }. Verifies the PID's effective cwd
       is inside the project's repoPath before killing — never lets the
       UI take out a process belonging to another project. */
  app.post("/:id/kill-pid", async (c) => {
    const id = c.req.param("id");
    const body = z
      .object({ pid: z.number().int().positive() })
      .parse(await c.req.json());
    const db = c.get("db");
    const [project] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id));
    if (!project) return c.json({ error: "project not found" }, 404);

    const repo = normalizePath(project.repoPath);
    const cwd = await getProcessCwd(body.pid);
    if (!cwd) {
      return c.json({ ok: false, error: `pid ${body.pid} not found` }, 404);
    }
    const cmd = await getProcessCmdline(body.pid);
    const eff = normalizePath(await effectiveCwd(cwd, cmd));
    if (eff !== repo && !eff.startsWith(repo + "/")) {
      return c.json(
        { ok: false, error: `pid ${body.pid} is not owned by this project` },
        403,
      );
    }

    const pgid = await getProcessPgid(body.pid);
    try { process.kill(body.pid, "SIGTERM"); }
    catch { /* already gone */ }
    if (pgid && pgid > 1) {
      try { process.kill(-pgid, "SIGTERM"); }
      catch { /* group already gone */ }
    }
    setTimeout(() => {
      try { process.kill(body.pid, 0); process.kill(body.pid, "SIGKILL"); }
      catch { /* dead, good */ }
      if (pgid && pgid > 1) {
        try { process.kill(-pgid, "SIGKILL"); }
        catch { /* group already gone */ }
      }
    }, 1000);

    return c.json({ ok: true, killed: body.pid, pgid });
  });

  return app;
}

/* ── helpers ──────────────────────────────────────────────── */

type DiscoveredEndpoint = {
  kind: "frontend" | "backend";
  framework: string;
  port: number;
  label?: string;
  cwd?: string;
  running: boolean;
};

type DeclaredService = {
  kind: "frontend" | "backend";
  framework: string;
  canonicalPort: number;
  label?: string;
  /** Relative path inside the project repoPath where this service's
   *  package.json lives. `undefined` means the project root. */
  cwd?: string;
  /** True when the port + framework were inferred from deps (the script
   *  had no explicit port flag). Guessed ports are placeholders and the
   *  matcher should fall back to cwd-only matching when they conflict
   *  with what's actually running. */
  guessed?: boolean;
};

type Listener = { pid: number; port: number; cwd: string; cmd: string };

/** Collapse repeated slashes (`/Documents//Vine` → `/Documents/Vine`)
 *  and drop a trailing slash so path comparison is consistent. */
function normalizePath(p: string): string {
  return p.replace(/\/+/g, "/").replace(/\/$/, "");
}

/** Given an OS-reported cwd and the proc's full cmdline, return the dir of
 *  the closest package.json walking up from the first absolute source-file
 *  argument in the cmdline. Falls back to cwd when nothing matches. This
 *  fixes `tsx watch apps/api/src/index.ts` launched from `apps/mobile`:
 *  cwd lies (says mobile), but the cmdline truthfully names the api file. */
async function effectiveCwd(cwd: string, cmd: string): Promise<string> {
  const fileMatches = cmd.match(/\/[^\s'"]+\.(?:ts|tsx|mjs|cjs|js)\b/g);
  if (!fileMatches) return cwd;
  for (const file of fileMatches) {
    // Skip node_modules — those are loaders/wrappers, not the app entrypoint.
    if (file.includes("/node_modules/")) continue;
    let dir = dirname(file);
    for (let i = 0; i < 8; i++) {
      try {
        await stat(join(dir, "package.json"));
        return dir;
      } catch { /* keep climbing */ }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return cwd;
}

/** Enumerate every listening TCP socket on the box and resolve its PID's
 *  cwd + command line. One `lsof` enumeration + parallel per-PID cwd/cmd
 *  lookups — typically ~50–200 ms total. */
async function discoverAllListeners(): Promise<Listener[]> {
  const stdout = await new Promise<string>((resolve) => {
    exec(
      "lsof -iTCP -sTCP:LISTEN -P -n -Fpn",
      { timeout: 4000, maxBuffer: 4 * 1024 * 1024 },
      (_err, out) => resolve(out ?? ""),
    );
  });

  // lsof -F output: per record, lines beginning with the field code.
  //   p<pid>     starts a new process
  //   n*:<port>  bound address for each listener of that process
  const portsByPid = new Map<number, Set<number>>();
  let curPid: number | null = null;
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const code = line[0];
    const rest = line.slice(1);
    if (code === "p") {
      curPid = parseInt(rest, 10);
      if (!isNaN(curPid) && !portsByPid.has(curPid)) {
        portsByPid.set(curPid, new Set());
      }
    } else if (code === "n" && curPid != null) {
      // address like "*:3001", "127.0.0.1:5173", "[::1]:8080"
      const m = rest.match(/:(\d+)$/);
      if (m?.[1]) {
        const port = parseInt(m[1], 10);
        if (!isNaN(port)) portsByPid.get(curPid)!.add(port);
      }
    }
  }

  // Resolve cwd + cmdline for every PID in parallel.
  const pids = [...portsByPid.keys()];
  const meta = await Promise.all(
    pids.map(async (pid) => ({
      pid,
      cwd: await getProcessCwd(pid),
      cmd: await getProcessCmdline(pid),
    })),
  );

  const out: Listener[] = [];
  for (const m of meta) {
    if (!m.cwd) continue;
    const ports = portsByPid.get(m.pid);
    if (!ports) continue;
    for (const port of ports) {
      out.push({ pid: m.pid, port, cwd: m.cwd, cmd: m.cmd });
    }
  }
  return out;
}

/** Returns the working directory of the given PID via lsof. */
function getProcessCwd(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    exec(
      `lsof -p ${pid} -a -d cwd -Fn`,
      { timeout: 2000 },
      (_err, stdout) => {
        const match = stdout.match(/\nn(.+)/);
        resolve(match?.[1]?.trim() ?? null);
      },
    );
  });
}

/** Returns the full command line of the given PID via ps. */
function getProcessCmdline(pid: number): Promise<string> {
  return new Promise((resolve) => {
    exec(
      `ps -p ${pid} -o command=`,
      { timeout: 2000, maxBuffer: 256 * 1024 },
      (_err, stdout) => resolve(stdout.trim()),
    );
  });
}

/** Returns the POSIX process-group id for the given PID, or null if the
 *  process no longer exists. Used so Stop can SIGTERM the whole dev-server
 *  tree at once (npm → concurrently → tsx watch share a pgid). */
function getProcessPgid(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    exec(
      `ps -p ${pid} -o pgid=`,
      { timeout: 2000 },
      (_err, stdout) => {
        const n = parseInt(stdout.trim(), 10);
        resolve(Number.isFinite(n) && n > 0 ? n : null);
      },
    );
  });
}

type StrayProcessInternal = {
  pid: number;
  cmd: string;
  etime: string;
  cwd: string;
  port?: number;
};

type DevProc = {
  pid: number;
  pgid: number;
  cmd: string;
  etime: string;
  effectiveCwd: string;
  port?: number;
};

/** Pattern used to recognise "this is a dev-server-ish process" by its
 *  command line. Covers package-manager wrappers (npm/pnpm/yarn run dev),
 *  concurrent multi-process launchers, TS watch runners, and the common
 *  Node/Python dev servers themselves.
 *
 *  Each branch requires the verb (dev/start/watch) to be reachable from
 *  the package-manager / runner by an unbroken sequence of flag-like
 *  tokens — preventing false positives where a long shell command happens
 *  to contain `/dev/null` further down the line. */
const DEV_PROC_PATTERN =
  /\b(?:npm|pnpm|yarn)\b\s+(?:[-/\w@.:=]+\s+)*(?:run\s+|exec\s+)?(?:dev|start|watch)(?::[\w:-]+)?\b|\bconcurrently\b|\btsx\b\s+(?:--)?watch\b|\bvite(?:-node)?\b|\bnext-server\b|\bnext\b\s+(?:dev|start)\b|\bexpo\b\s+start\b|\bmetro\b|\b(?:uvicorn|gunicorn)\b|service-ports\.mjs/;

/** Enumerate every dev-server-ish process on the box, resolve each one's
 *  effective working directory + any TCP port it's listening on. Used by
 *  /server-status to surface "strays" — orphaned npm/concurrently/tsx
 *  wrappers whose listener was killed but whose parent script kept
 *  running. One `ps` enumeration + one `lsof` enumeration + parallel
 *  per-PID cwd lookups for the matched subset. */
async function discoverDevProcesses(): Promise<DevProc[]> {
  const psOut = await new Promise<string>((resolve) => {
    exec(
      "ps -axo pid=,pgid=,etime=,command=",
      { timeout: 4000, maxBuffer: 8 * 1024 * 1024 },
      (_err, out) => resolve(out ?? ""),
    );
  });

  type Row = { pid: number; pgid: number; etime: string; cmd: string };
  const rows: Row[] = [];
  for (const raw of psOut.split("\n")) {
    const line = raw.trimStart();
    if (!line) continue;
    // First token is pid, second is pgid, third is etime, the rest is the
    // command line.
    const m = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    const pid = parseInt(m[1]!, 10);
    const pgid = parseInt(m[2]!, 10);
    // Don't skip our own pid — when orca is run via vite-node this
    // process IS the listener leaf, and including it is what lets the
    // pgid filter recognise our wrapper chain (pnpm/sh -c/service-ports)
    // as live rather than orphaned.
    if (!Number.isFinite(pid)) continue;
    const cmd = m[4]!;
    if (!DEV_PROC_PATTERN.test(cmd)) continue;
    // Skip the harness wrapper that runs ps itself, plus obvious
    // false positives that aren't really dev servers we'd kill.
    if (/\bps\s+-axo\b/.test(cmd)) continue;
    rows.push({ pid, pgid, etime: m[3]!, cmd });
  }

  // Listening ports indexed by pid (one shared lsof for the whole set —
  // cheaper than asking lsof per pid).
  const listeners = await discoverAllListeners();
  const portsByPid = new Map<number, number>();
  for (const l of listeners) {
    if (!portsByPid.has(l.pid)) portsByPid.set(l.pid, l.port);
  }

  // Resolve cwd in parallel, but capped — lsof per pid is the slow step.
  const resolved = await Promise.all(
    rows.map(async (r) => {
      const cwd = await getProcessCwd(r.pid);
      if (!cwd) return null;
      const eff = await effectiveCwd(cwd, r.cmd);
      return {
        pid: r.pid,
        pgid: r.pgid,
        cmd: r.cmd,
        etime: r.etime,
        effectiveCwd: eff,
        port: portsByPid.get(r.pid),
      } satisfies DevProc;
    }),
  );
  return resolved.filter((r): r is DevProc => r !== null);
}

/** Infer framework + kind (frontend/backend) from a process command line.
 *  This is heuristic but covers the common Node/Python frameworks we run
 *  locally. Defaults to a generic backend when nothing else matches —
 *  if a process is bound to a port and we can't tell what it is, calling
 *  it a backend service is the least surprising fallback. Returns a
 *  `specificity` score so we can pick the most informative match when
 *  multiple PIDs share a port (worker procs, etc.). */
function classifyProcess(
  cmd: string,
): { kind: "frontend" | "backend"; framework: string; specificity: number } {
  const c = cmd.toLowerCase();
  // Frontend dev servers
  if (/\bexpo\b.*\bstart\b|\/expo\/bin\/cli\b|\bmetro\b/.test(c)) {
    return { kind: "frontend", framework: "expo", specificity: 3 };
  }
  if (/\bnext-server\b|\bnext\b\s+(dev|start)/.test(c)) {
    return { kind: "frontend", framework: "next", specificity: 3 };
  }
  // `vite-node` is a TS runner used to run backend code (Hono, Express)
  // under HMR — match plain `vite` only, never `vite-node`.
  if (/\bvite\b/.test(c) && !/\bvite-node\b/.test(c)) {
    return { kind: "frontend", framework: "vite", specificity: 3 };
  }
  if (/\breact-scripts\b/.test(c)) {
    return { kind: "frontend", framework: "cra", specificity: 3 };
  }
  // Backend frameworks (best-effort — these often show up as `node ...`)
  if (/\buvicorn\b|\bgunicorn\b|\bfastapi\b/.test(c)) {
    return { kind: "backend", framework: "fastapi", specificity: 3 };
  }
  if (/\bhono\b/.test(c)) {
    return { kind: "backend", framework: "hono", specificity: 3 };
  }
  if (/\bvite-node\b/.test(c)) {
    // vite-node is the dev-mode TS runner; the actual app is a backend.
    return { kind: "backend", framework: "node", specificity: 2 };
  }
  // Anything else listening on TCP from a Node-ish runtime — backend.
  return { kind: "backend", framework: "node", specificity: 1 };
}

/** Scan a project directory and infer frontend/backend endpoints.
 *  `rootRepoPath` is always the top-level repo; `scanPath` may be a sub-app.
 *  `depth` prevents infinite recursion on nested directories. */
async function detectServerConfig(
  repoPath: string,
  rootRepoPath?: string,
  depth = 0,
): Promise<ServerEndpoint[]> {
  const root = rootRepoPath ?? repoPath;
  const endpoints: ServerEndpoint[] = [];
  const relCwd =
    repoPath === root ? undefined : repoPath.slice(root.length + 1);

  // ── 1. Parse run.sh at repo root for explicit ports & commands ──
  // Only at the top level (depth 0) — run.sh is a project-level launcher.
  if (depth === 0) {
    try {
      const sh = await readFile(join(repoPath, "run.sh"), "utf-8");
      const parsed = parseRunSh(sh, repoPath, root);
      for (const ep of parsed) {
        if (!endpoints.some((e) => e.port === ep.port && e.kind === ep.kind)) {
          endpoints.push(ep);
        }
      }
    } catch { /* no run.sh */ }
  }

  // ── 2. package.json (Node projects) ──
  let npmWorkspaces: string[] = [];
  try {
    const raw = await readFile(join(repoPath, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const deps = {
      ...(pkg.dependencies as Record<string, string> | undefined),
      ...(pkg.devDependencies as Record<string, string> | undefined),
    };
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    const hasDev = !!scripts.dev;

    // Capture npm/yarn workspaces for subdirectory scanning
    if (Array.isArray(pkg.workspaces)) {
      npmWorkspaces = (pkg.workspaces as string[]).filter(
        (w) => typeof w === "string" && !w.includes("*"),
      );
    }

    // ── 2a. Authoritative: service-ports.mjs declaration ──
    //   `--framework X --canonical-port N` in a script is a definitive
    //   statement about what this package.json runs and where. Trust it,
    //   skip dep-scanning entirely (a transitive `express` in deps must
    //   not fabricate a phantom backend for what is actually an Expo app).
    const sp = parseServicePortsScripts(scripts);
    if (sp) {
      endpoints.push({
        kind: sp.kind,
        framework: sp.framework,
        port: sp.port,
        startCommand: hasDev ? "npm run dev" : undefined,
        cwd: relCwd,
      });
    } else {
      // ── 2b. Fallback: dep-scan (older projects without service-ports) ──
      let frontendEmitted = false;
      if (deps.next) {
        const port = extractPortFromScripts(scripts, 3000);
        endpoints.push({
          kind: "frontend", framework: "next", port,
          startCommand: hasDev ? "npm run dev" : "npx next dev",
          cwd: relCwd,
        });
        frontendEmitted = true;
      } else if (deps.expo || deps["expo-router"]) {
        const port = extractPortFromScripts(scripts, 8081);
        endpoints.push({
          kind: "frontend", framework: "expo", port,
          startCommand: hasDev ? "npm run dev" : "npx expo start --web",
          cwd: relCwd,
        });
        frontendEmitted = true;
      } else if (deps.vite) {
        const port = extractPortFromScripts(scripts, 5173);
        endpoints.push({
          kind: "frontend", framework: "vite", port,
          startCommand: hasDev ? "npm run dev" : "npx vite",
          cwd: relCwd,
        });
        frontendEmitted = true;
      } else if (deps["react-scripts"]) {
        const port = extractPortFromScripts(scripts, 3000);
        endpoints.push({
          kind: "frontend", framework: "cra", port,
          startCommand: "npm start",
          cwd: relCwd,
        });
        frontendEmitted = true;
      }

      // Backend detection — only when the package isn't already a frontend.
      // Expo/Next apps frequently include `express` as a transitive helper;
      // don't pretend that's a backend service.
      if (!frontendEmitted) {
        if (deps.express) {
          const port = extractPortFromScripts(scripts, 3001);
          endpoints.push({
            kind: "backend", framework: "express", port,
            startCommand: hasDev ? "npm run dev" : "npm start",
            cwd: relCwd,
          });
        } else if (deps.hono) {
          const port = extractPortFromScripts(scripts, 4455);
          endpoints.push({
            kind: "backend", framework: "hono", port,
            startCommand: hasDev ? "npm run dev" : "npm start",
            cwd: relCwd,
          });
        }
      }
    }
  } catch {
    // no package.json
  }

  // ── 3. Tauri ──
  try {
    const raw = await readFile(
      join(repoPath, "src-tauri", "tauri.conf.json"),
      "utf-8",
    );
    const conf = JSON.parse(raw) as Record<string, unknown>;
    const devUrl =
      ((conf.build as Record<string, unknown>)?.devUrl as string) ?? "";
    const urlMatch = devUrl.match(/:(\d+)/);
    const port = urlMatch?.[1] ? parseInt(urlMatch[1], 10) : 1420;
    endpoints.push({
      kind: "frontend", framework: "tauri", port,
      startCommand: "cargo tauri dev",
      cwd: relCwd,
    });
  } catch { /* not tauri */ }

  // ── 4. Python backends ──
  for (const file of ["pyproject.toml", "requirements.txt"]) {
    try {
      const raw = await readFile(join(repoPath, file), "utf-8");
      if (raw.includes("fastapi") || raw.includes("uvicorn")) {
        if (!endpoints.some((e) => e.framework === "fastapi")) {
          endpoints.push({
            kind: "backend", framework: "fastapi", port: 8000,
            startCommand: "uvicorn main:app --reload --port 8000",
            cwd: relCwd,
          });
        }
      }
    } catch { /* not present */ }
  }

  // ── 5. Recurse into subdirectories ──
  // Scan apps/ first (standard monorepo), then fall back to scanning
  // ALL top-level subdirectories if we still have no endpoints.
  if (depth < 2) {
    let isPnpm = false;
    try {
      await readFile(join(root, "pnpm-workspace.yaml"), "utf-8");
      isPnpm = true;
    } catch { /* not pnpm */ }

    const scannedDirs: string[] = [];

    // Always try apps/ first
    try {
      const dirents = await readdir(join(repoPath, "apps"), {
        withFileTypes: true,
      });
      for (const d of dirents) {
        if (d.isDirectory() && !d.name.startsWith(".")) {
          scannedDirs.push(join(repoPath, "apps", d.name));
          await mergeSubEndpoints(
            join(repoPath, "apps", d.name), d.name,
            root, endpoints, isPnpm, depth,
          );
        }
      }
    } catch { /* no apps/ */ }

    // Scan npm/yarn workspaces (e.g. "workspaces": ["app", "web"])
    for (const ws of npmWorkspaces) {
      const wsPath = join(repoPath, ws);
      if (scannedDirs.includes(wsPath)) continue;
      try {
        const stat = await readdir(wsPath, { withFileTypes: true });
        if (stat) {
          scannedDirs.push(wsPath);
          await mergeSubEndpoints(wsPath, ws, root, endpoints, isPnpm, depth);
        }
      } catch { /* workspace dir missing */ }
    }

    // If still no endpoints, scan all top-level subdirectories (depth 0 only)
    if (endpoints.length === 0 && depth === 0) {
      try {
        const dirents = await readdir(repoPath, { withFileTypes: true });
        for (const d of dirents) {
          if (!d.isDirectory() || d.name.startsWith(".")) continue;
          if (d.name === "apps" || d.name === "node_modules") continue;
          const full = join(repoPath, d.name);
          if (scannedDirs.includes(full)) continue;
          await mergeSubEndpoints(
            full, d.name, root, endpoints, isPnpm, depth,
          );
        }
      } catch { /* can't read dir */ }
    }
  }

  return endpoints;
}

/** Merge sub-directory detection results into the parent endpoints array. */
async function mergeSubEndpoints(
  dirPath: string,
  label: string,
  root: string,
  endpoints: ServerEndpoint[],
  isPnpm: boolean,
  depth: number,
): Promise<void> {
  const subEndpoints = await detectServerConfig(dirPath, root, depth + 1);
  for (const ep of subEndpoints) {
    if (endpoints.some((e) => e.port === ep.port && e.kind === ep.kind)) continue;
    let startCmd = ep.startCommand;
    if (isPnpm && ep.cwd) {
      try {
        const subRaw = await readFile(
          join(root, ep.cwd, "package.json"), "utf-8",
        );
        const subPkg = JSON.parse(subRaw) as Record<string, unknown>;
        const subName = subPkg.name as string | undefined;
        if (subName) startCmd = `pnpm --filter ${subName} dev`;
      } catch { /* use original */ }
    }
    endpoints.push({
      ...ep,
      label: ep.label ?? label,
      startCommand: startCmd,
      cwd: isPnpm ? undefined : ep.cwd,
    });
  }
}

/** Walk a project repo (depth-limited) and gather every declared service —
 *  one entry per package.json + (service-ports invocation OR dep heuristic).
 *  At most one dep-heuristic entry per package.json (a transitive express
 *  inside an Expo app must not fabricate a phantom backend). */
async function readDeclaredServices(repoPath: string): Promise<DeclaredService[]> {
  const SKIP_DIRS = new Set([
    "node_modules", ".git", ".next", ".turbo", ".expo",
    "dist", "build", "coverage", ".cache", ".venv",
  ]);
  const services: DeclaredService[] = [];
  // Some project records carry malformed repoPaths (e.g. "/Documents//Vine"
  // with a stray double-slash). Normalize once so relative-cwd slicing is
  // computed against a canonical prefix.
  const normRepo = normalizePath(repoPath);

  async function visit(dir: string, depth: number): Promise<void> {
    // Process package.json at this level (if any).
    let pkg: Record<string, unknown> | null = null;
    try {
      pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf-8"));
    } catch { /* no package.json here */ }

    if (pkg) {
      const scripts = (pkg.scripts ?? {}) as Record<string, string>;
      const normDir = normalizePath(dir);
      const relCwd = normDir === normRepo ? undefined : normDir.slice(normRepo.length + 1);

      // (a) `goliath` block in package.json — explicit declaration of a
      //     single service (orca's own apps/server, future projects).
      const fromGoliathBlock = parseGoliathBlock(pkg);
      // (b) `service-ports.mjs --framework F --canonical-port N` in scripts.
      const fromServicePorts = parseAllServicePortsDeclarations(scripts);

      if (fromGoliathBlock || fromServicePorts.length > 0) {
        if (fromGoliathBlock) {
          services.push({ ...fromGoliathBlock, cwd: relCwd });
        }
        for (const sp of fromServicePorts) {
          // Avoid duplicating the goliath block when CLI flags echo it.
          if (
            fromGoliathBlock &&
            sp.kind === fromGoliathBlock.kind &&
            sp.canonicalPort === fromGoliathBlock.canonicalPort
          ) continue;
          services.push({ ...sp, cwd: relCwd });
        }
      } else {
        // (c) Dep + script fallback — one service max per package.json,
        //     for projects that haven't adopted service-ports yet.
        const deps = {
          ...(pkg.dependencies as Record<string, string> | undefined),
          ...(pkg.devDependencies as Record<string, string> | undefined),
        };
        const inferred = inferServiceFromDeps(deps, scripts);
        if (inferred) services.push({ ...inferred, cwd: relCwd, guessed: true });
      }
    }

    // Recurse into subdirectories (max depth 4 — apps/<name>/<service>).
    if (depth >= 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch { return; }
    await Promise.all(
      entries.map(async (e) => {
        if (!e.isDirectory()) return;
        if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) return;
        await visit(join(dir, e.name), depth + 1);
      }),
    );
  }

  await visit(repoPath, 0);
  return services;
}

/** Parse a package.json's `goliath` block — the in-repo declaration used by
 *  orca itself and any project that prefers a JSON block over CLI flags. */
function parseGoliathBlock(
  pkg: Record<string, unknown>,
): Omit<DeclaredService, "cwd"> | null {
  const g = pkg.goliath;
  if (!g || typeof g !== "object") return null;
  const block = g as Record<string, unknown>;
  const framework = typeof block.framework === "string" ? block.framework : null;
  const port =
    typeof block.canonicalPort === "number" ? block.canonicalPort : null;
  if (!framework || port == null) return null;
  const role = typeof block.role === "string" ? block.role : null;
  const kind: "frontend" | "backend" | undefined =
    role === "frontend" || role === "backend"
      ? role
      : FRAMEWORK_KIND[framework];
  if (!kind) return null;
  return {
    kind,
    framework,
    canonicalPort: port,
    label: typeof block.name === "string" ? block.name : undefined,
  };
}

/** Parse every service-ports.mjs invocation in a scripts block.
 *  Returns one DeclaredService per `--framework F --canonical-port N` pair. */
function parseAllServicePortsDeclarations(
  scripts: Record<string, string>,
): Array<Omit<DeclaredService, "cwd">> {
  const out: Array<Omit<DeclaredService, "cwd">> = [];
  for (const script of Object.values(scripts)) {
    if (!script.includes("service-ports")) continue;
    const fw = script.match(/--framework[= ]([a-z-]+)/);
    const port = script.match(/--canonical-port[= ](\d+)/);
    const name = script.match(/--name[= ]([\w.-]+)/);
    if (!fw?.[1] || !port?.[1]) continue;
    const kind = FRAMEWORK_KIND[fw[1]];
    if (!kind) continue;
    out.push({
      kind,
      framework: fw[1],
      canonicalPort: parseInt(port[1], 10),
      label: name?.[1],
    });
  }
  return out;
}

/** Fallback inference: pick one service from deps + scripts when there's no
 *  service-ports declaration. Frontend wins over backend in the same
 *  package.json — projects without a separate backend subdir typically have
 *  express in deps only as a transitive helper. Returns null when nothing
 *  looks like a service. */
function inferServiceFromDeps(
  deps: Record<string, string | undefined>,
  scripts: Record<string, string>,
): Omit<DeclaredService, "cwd"> | null {
  if (deps.next) {
    return { kind: "frontend", framework: "next", canonicalPort: extractPortFromScripts(scripts, 3000) };
  }
  if (deps.expo || deps["expo-router"]) {
    return { kind: "frontend", framework: "expo", canonicalPort: extractPortFromScripts(scripts, 8081) };
  }
  if (deps.vite) {
    return { kind: "frontend", framework: "vite", canonicalPort: extractPortFromScripts(scripts, 5173) };
  }
  if (deps["react-scripts"]) {
    return { kind: "frontend", framework: "cra", canonicalPort: extractPortFromScripts(scripts, 3000) };
  }
  if (deps.express) {
    return { kind: "backend", framework: "express", canonicalPort: extractPortFromScripts(scripts, 3001) };
  }
  if (deps.hono) {
    return { kind: "backend", framework: "hono", canonicalPort: extractPortFromScripts(scripts, 4455) };
  }
  if (deps.fastify) {
    return { kind: "backend", framework: "fastify", canonicalPort: extractPortFromScripts(scripts, 3000) };
  }
  return null;
}

/** Recognized framework tags from `--framework X` in service-ports.mjs scripts. */
const FRAMEWORK_KIND: Record<string, "frontend" | "backend"> = {
  next: "frontend",
  expo: "frontend",
  vite: "frontend",
  cra: "frontend",
  "react-scripts": "frontend",
  express: "backend",
  hono: "backend",
  fastify: "backend",
  fastapi: "backend",
};

/** Parse a `service-ports.mjs --framework X --canonical-port N` invocation
 *  from any script. This is the authoritative source for projects that
 *  use the service-ports recipe — trust it over dep scanning. Returns
 *  null when no such declaration is present. */
function parseServicePortsScripts(
  scripts: Record<string, string>,
): { kind: "frontend" | "backend"; framework: string; port: number } | null {
  for (const script of Object.values(scripts)) {
    if (!script.includes("service-ports")) continue;
    const fw = script.match(/--framework[= ]([a-z-]+)/);
    const port = script.match(/--canonical-port[= ](\d+)/);
    if (!fw?.[1] || !port?.[1]) continue;
    const kind = FRAMEWORK_KIND[fw[1]];
    if (!kind) continue;
    return { kind, framework: fw[1], port: parseInt(port[1], 10) };
  }
  return null;
}

/** Extract port number from npm scripts. Recognizes:
 *    --canonical-port 3001       (service-ports.mjs recipe)
 *    --port 9091, --port=9091    (vite, next, etc — long form)
 *    -p 3001                     (next dev -p N short form)
 *    PORT=3001                   (env-prefix)
 *    ${PORT:-3001}               (shell default expansion)
 *  Scans every script value, not just `dev`, so a project whose `start`
 *  hard-codes the port but whose `dev` uses a placeholder still resolves.
 */
function extractPortFromScripts(
  scripts: Record<string, string>,
  fallback: number,
): number {
  const all = Object.values(scripts).join(" ");
  // --canonical-port 3001 (service-ports recipe — most authoritative)
  const canonical = all.match(/--canonical-port[= ](\d+)/);
  if (canonical?.[1]) return parseInt(canonical[1], 10);
  // ${PORT:-3001} shell default
  const shellDefault = all.match(/\$\{PORT:-(\d+)\}/);
  if (shellDefault?.[1]) return parseInt(shellDefault[1], 10);
  // --port 9091, --port=9091
  const portFlag = all.match(/--port[= ](\d+)/);
  if (portFlag?.[1]) return parseInt(portFlag[1], 10);
  // -p 3001 (short form, word-bounded so it doesn't match -p inside other tokens)
  const shortFlag = all.match(/(?:^|\s)-p[ =](\d+)\b/);
  if (shortFlag?.[1]) return parseInt(shortFlag[1], 10);
  // PORT=3001
  const portEnv = all.match(/PORT[= ]+(\d+)/);
  if (portEnv?.[1]) return parseInt(portEnv[1], 10);
  return fallback;
}

/** Parse a run.sh script for uvicorn/expo/node commands and extract ports.
 *  Returns endpoints inferred from the shell script. */
function parseRunSh(
  sh: string,
  repoPath: string,
  root: string,
): ServerEndpoint[] {
  const endpoints: ServerEndpoint[] = [];
  const lines = sh.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || !trimmed) continue;

    // Detect uvicorn commands: uvicorn main:app --reload --port 9000
    const uvicornMatch = trimmed.match(
      /uvicorn\s+(\S+)\s.*?--port\s+(\d+)/,
    );
    if (uvicornMatch?.[2]) {
      const port = parseInt(uvicornMatch[2], 10);
      // Try to figure out the cwd from cd commands before this line
      const cwd = findCwdBefore(lines, lines.indexOf(line), repoPath, root);
      endpoints.push({
        kind: "backend",
        framework: "fastapi",
        port,
        startCommand: trimmed.replace(/\s*&\s*$/, ""),
        cwd,
      });
      continue;
    }

    // Detect expo start: npx expo start --web --port 9091
    const expoMatch = trimmed.match(
      /(?:npx\s+)?expo\s+start\b.*?--port\s+(\d+)/,
    );
    if (expoMatch?.[1]) {
      const port = parseInt(expoMatch[1], 10);
      const cwd = findCwdBefore(lines, lines.indexOf(line), repoPath, root);
      endpoints.push({
        kind: "frontend",
        framework: "expo",
        port,
        startCommand: trimmed.replace(/\s*&\s*$/, ""),
        cwd,
      });
      continue;
    }

    // Detect next dev / vite / npm run dev with port
    const nodePortMatch = trimmed.match(
      /(?:next|vite|npm\s+run\s+dev)\b.*?--port\s+(\d+)/,
    );
    if (nodePortMatch?.[1]) {
      const port = parseInt(nodePortMatch[1], 10);
      const cwd = findCwdBefore(lines, lines.indexOf(line), repoPath, root);
      const isBackend = trimmed.includes("express") || trimmed.includes("server");
      endpoints.push({
        kind: isBackend ? "backend" : "frontend",
        framework: trimmed.includes("next") ? "next" : trimmed.includes("vite") ? "vite" : "node",
        port,
        startCommand: trimmed.replace(/\s*&\s*$/, ""),
        cwd,
      });
    }
  }

  return endpoints;
}

/** Walk backward through shell lines to find the most recent cd command
 *  and resolve it to a relative cwd from the repo root. */
function findCwdBefore(
  lines: string[],
  beforeIdx: number,
  repoPath: string,
  root: string,
): string | undefined {
  for (let i = beforeIdx - 1; i >= 0; i--) {
    const ln = lines[i];
    if (!ln) continue;
    const trimmed = ln.trim();
    // cd "$SCRIPT_DIR/twp.react/api"  or  cd some/path
    const cdMatch = trimmed.match(
      /^cd\s+["']?\$(?:SCRIPT_DIR|\{SCRIPT_DIR\}|DIR)[/\\]?([^"'&;]+)/,
    );
    if (cdMatch?.[1]) {
      const sub = cdMatch[1].replace(/["']/g, "").trim();
      return sub || undefined;
    }
    // Plain cd: cd twp.react/api
    const plainCd = trimmed.match(/^cd\s+["']?([^$"'&;\s]+)/);
    if (plainCd?.[1] && !plainCd[1].startsWith("/")) {
      return plainCd[1].replace(/["']/g, "").trim() || undefined;
    }
  }
  return undefined;
}
