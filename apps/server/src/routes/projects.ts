import { Hono } from "hono";
import { eq, sql, desc, asc } from "drizzle-orm";
import { schema } from "@orca/db";
import { z } from "zod";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
        serverConfig: schema.projects.serverConfig,
      })
      .from(schema.projects);

    // Lazy backfill / re-detect: detect config for projects that have none.
    for (const r of rows) {
      if (!r.serverConfig?.endpoints?.length) {
        try {
          const endpoints = await detectServerConfig(r.repoPath);
          if (endpoints.length > 0) {
            const config: ServerConfig = { endpoints };
            await db
              .update(schema.projects)
              .set({ serverConfig: config })
              .where(eq(schema.projects.id, r.id));
            r.serverConfig = config;
          }
        } catch {
          // detection failed — skip
        }
      }
    }

    // Check ports for all projects that have config
    const statuses = await Promise.all(
      rows
        .filter((r) => r.serverConfig?.endpoints?.length)
        .map(async (r) => {
          const checks = await Promise.all(
            r.serverConfig!.endpoints.map(async (ep) => ({
              ...ep,
              running: await isEndpointRunning(r.repoPath, ep.port),
            })),
          );
          return { projectId: r.id, endpoints: checks };
        }),
    );

    // Re-detect for projects where ALL endpoints are down — config may be stale.
    // Only re-detect one project per poll cycle to avoid slowdowns.
    let redetected = false;
    for (const s of statuses) {
      if (redetected) break;
      if (s.endpoints.length > 0 && s.endpoints.every((e) => !e.running)) {
        const row = rows.find((r) => r.id === s.projectId);
        if (!row) continue;
        try {
          const fresh = await detectServerConfig(row.repoPath);
          if (fresh.length > 0) {
            const changed = fresh.some(
              (f) => !s.endpoints.some((e) => e.port === f.port && e.kind === f.kind),
            );
            if (changed) {
              const config: ServerConfig = { endpoints: fresh };
              await db
                .update(schema.projects)
                .set({ serverConfig: config })
                .where(eq(schema.projects.id, row.id));
              // Re-check the new endpoints
              const rechecks = await Promise.all(
                fresh.map(async (ep) => ({
                  ...ep,
                  running: await isEndpointRunning(row.repoPath, ep.port),
                })),
              );
              const idx = statuses.findIndex((x) => x.projectId === s.projectId);
              if (idx >= 0) statuses[idx] = { projectId: s.projectId, endpoints: rechecks };
              redetected = true;
            }
          }
        } catch { /* skip */ }
      }
    }

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
  app.post("/:id/start", async (c) => {
    const id = c.req.param("id");
    const body = z
      .object({ kind: z.enum(["frontend", "backend"]).optional() })
      .parse(await c.req.json().catch(() => ({})));
    const db = c.get("db");
    const [project] = await db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id));
    if (!project) return c.json({ error: "project not found" }, 404);
    if (!project.serverConfig?.endpoints?.length) {
      return c.json({ error: "no server config — run detect first" }, 400);
    }

    const toStart = project.serverConfig.endpoints.filter((ep) => {
      if (!ep.startCommand) return false;
      if (body.kind && ep.kind !== body.kind) return false;
      return true;
    });
    if (toStart.length === 0) {
      return c.json({ error: "no startable endpoints found" }, 400);
    }

    const launched: string[] = [];
    for (const ep of toStart) {
      // Skip if already running for this project
      const running = await isEndpointRunning(project.repoPath, ep.port);
      if (running) {
        launched.push(`${ep.kind}:${ep.port} (already running)`);
        continue;
      }
      const cwd = ep.cwd
        ? join(project.repoPath, ep.cwd)
        : project.repoPath;
      const child = spawn(ep.startCommand!, {
        cwd,
        shell: true,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      launched.push(`${ep.kind}:${ep.port} (pid ${child.pid})`);
    }
    return c.json({ ok: true, launched });
  });

  return app;
}

/* ── helpers ──────────────────────────────────────────────── */

/**
 * Returns true only if a process listening on `port` is running from
 * within `repoPath`. Uses lsof to find the listening PID, then checks
 * its working directory — so two different projects sharing a port number
 * don't falsely report each other as running.
 */
async function isEndpointRunning(repoPath: string, port: number): Promise<boolean> {
  const pid = await getListeningPid(port);
  if (!pid) return false;
  const cwd = await getProcessCwd(pid);
  if (!cwd) return false;
  return cwd === repoPath || cwd.startsWith(repoPath + "/");
}

/** Finds the PID of the process listening on the given TCP port via lsof. */
function getListeningPid(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    exec(
      `lsof -i TCP:${port} -n -P -sTCP:LISTEN -t`,
      { timeout: 2000 },
      (_err, stdout) => {
        const pid = parseInt(stdout.trim().split("\n")[0] ?? "", 10);
        resolve(isNaN(pid) ? null : pid);
      },
    );
  });
}

/** Returns the working directory of the given PID via lsof. */
function getProcessCwd(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    exec(
      `lsof -p ${pid} -a -d cwd -Fn`,
      { timeout: 2000 },
      (_err, stdout) => {
        // lsof -Fn output: "p{pid}\nn{cwd}"
        const match = stdout.match(/\nn(.+)/);
        resolve(match?.[1]?.trim() ?? null);
      },
    );
  });
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

    // Frontend detection — also try to extract port from scripts
    if (deps.next) {
      const port = extractPortFromScripts(scripts, 3000);
      endpoints.push({
        kind: "frontend", framework: "next", port,
        startCommand: hasDev ? "npm run dev" : "npx next dev",
        cwd: relCwd,
      });
    } else if (deps.expo || deps["expo-router"]) {
      const port = extractPortFromScripts(scripts, 8081);
      endpoints.push({
        kind: "frontend", framework: "expo", port,
        startCommand: hasDev ? "npm run dev" : "npx expo start --web",
        cwd: relCwd,
      });
    } else if (deps.vite) {
      const port = extractPortFromScripts(scripts, 5173);
      endpoints.push({
        kind: "frontend", framework: "vite", port,
        startCommand: hasDev ? "npm run dev" : "npx vite",
        cwd: relCwd,
      });
    } else if (deps["react-scripts"]) {
      const port = extractPortFromScripts(scripts, 3000);
      endpoints.push({
        kind: "frontend", framework: "cra", port,
        startCommand: "npm start",
        cwd: relCwd,
      });
    }

    // Backend detection
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

/** Extract port number from npm scripts (looks for --port N, PORT=N, :N patterns). */
function extractPortFromScripts(
  scripts: Record<string, string>,
  fallback: number,
): number {
  const all = Object.values(scripts).join(" ");
  // --port 9091, --port=9091
  const portFlag = all.match(/--port[= ](\d+)/);
  if (portFlag?.[1]) return parseInt(portFlag[1], 10);
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
