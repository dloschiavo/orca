import { execSync } from "node:child_process";
import { basename } from "node:path";
import { isNotNull } from "drizzle-orm";
import { schema } from "@orca/db";
import type { OrcaDb } from "@orca/db";
import { isPidAlive } from "./pid.js";

// ─────────────────────────────────────────────────────────────────────────────
// Orphaned-process reaper.
//
// orca dispatches `claude` detached (its own process group leader). Claude runs
// build tooling via the Bash tool — `pnpm dev`, `vite`, `tsc --watch`, test
// runners, `esbuild`, etc. When the claude wrapper is reaped (or the Node host
// restarts) those grandchildren frequently ESCAPE the process-group kill:
//   - a dev server that re-parents to PID 1 keeps its old (now headless) pgid,
//   - or a tool that called setsid() lands in a brand-new session entirely.
// The dispatch reap does `kill(-pid)` against the *claude* pgid, which never
// reaches an escapee. Result: dozens of `node`/`npm` processes "attached to
// nothing" pile up across an agent-farm session, each holding a port and RAM.
//
// This sweep hunts those down directly: any node/npm-family process owned by us
// whose parent is dead (re-parented to PID 1) or whose process-group leader is
// dead (headless group) is an orphan with no owner. We SIGTERM it on first
// sighting and SIGKILL it if it's still around next tick.
//
// SAFETY — this kills processes by heuristic, so the guards are not optional:
//   1. Match on the executable BASENAME against an allowlist, never a substring
//      of the command line. orca's own embedded Postgres lives under a path
//      containing "node_modules" and runs headless (ppid 1, dead pgid leader);
//      a substring match on "node" would kill the database. basename() of its
//      argv[0] is "postgres", which is not in the allowlist — so it's spared.
//   2. Protect orca's own process tree (this Node process, its ancestors, and
//      whatever is listening on the backend/frontend ports) by pgid.
//   3. Protect every currently-tracked, still-alive dispatch (and its whole
//      group — pgid == pid for our detached spawns).
//   4. Own-user processes only (`ps -U <uid>`), so we never touch root/system
//      daemons.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Executable basenames we are willing to reap when orphaned. These are the
 * JS/TS build-tooling programs claude spawns; everything else (postgres,
 * editors, the user's native apps) is left alone. `claude` itself is
 * deliberately absent — its lifecycle is owned by the dispatch/concurrency
 * machinery, not this sweep.
 */
const TOOL_BINARIES = new Set([
  "node",
  "npm",
  "pnpm",
  "npx",
  "yarn",
  "bun",
  "deno",
  "vite",
  "esbuild",
  "tsx",
  "tsc",
  "ts-node",
  "vite-node",
  "next",
  "webpack",
  "rollup",
  "jest",
  "vitest",
  "nodemon",
  "concurrently",
]);

const BACKEND_PORT = 4455;
const FRONTEND_PORT = 5173;

interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
  /** First whitespace-delimited token of the command (argv[0]). */
  exe: string;
  /** Full command line, for logging. */
  command: string;
}

/**
 * Processes we SIGTERMed on a previous tick. If a pid here is still alive on
 * the next sweep it gets SIGKILLed — that's the "reap harder" escalation, and
 * it catches dev servers/watchers that ignore SIGTERM (the very reason they
 * accumulate). Stashed on globalThis so a `vite-node --watch` re-eval of this
 * module doesn't reset the escalation state mid-session.
 */
const PENDING_KEY = "__orcaOrphanReapPending";
type GlobalWithPending = typeof globalThis & {
  [PENDING_KEY]?: Set<number>;
};
function pendingKill(): Set<number> {
  const g = globalThis as GlobalWithPending;
  if (!g[PENDING_KEY]) g[PENDING_KEY] = new Set<number>();
  return g[PENDING_KEY];
}

/** Snapshot every process owned by the current user. */
function listProcesses(): Proc[] {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const selector = uid != null ? `-U ${uid}` : "-x";
  let out: string;
  try {
    out = execSync(`ps -o pid=,ppid=,pgid=,command= ${selector}`, {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  const procs: Proc[] = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // pid ppid pgid then the rest is the command (which itself contains spaces).
    const m = trimmed.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const command = m[4];
    const firstToken = command.split(/\s+/, 1)[0] ?? command;
    procs.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      exe: basename(firstToken).toLowerCase(),
      command,
    });
  }
  return procs;
}

/** PIDs listening on a TCP port (orca's own backend/frontend). */
function pidsOnPort(port: number): number[] {
  try {
    const out = execSync(`lsof -ti TCP:${port} -sTCP:LISTEN 2>/dev/null || true`, {
      encoding: "utf8",
      timeout: 5000,
    });
    return out
      .trim()
      .split("\n")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

/**
 * Find and kill orphaned node/npm-family processes that no live owner is
 * responsible for. Returns the number of orphan roots signalled this tick.
 */
export async function reapOrphanedProcesses(db: OrcaDb): Promise<number> {
  if (process.env.ORCA_ORPHAN_REAP === "0") return 0;

  const procs = listProcesses();
  if (procs.length === 0) return 0;

  const byPid = new Map<number, Proc>(procs.map((p) => [p.pid, p]));
  const alivePgidLeaders = new Set<number>(procs.map((p) => p.pid));
  const children = new Map<number, number[]>();
  for (const p of procs) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid)!.push(p.pid);
  }

  // ── Build the protected set ────────────────────────────────────────────
  const protectedPids = new Set<number>();
  const protectedPgids = new Set<number>();

  const protect = (pid: number) => {
    protectedPids.add(pid);
    const p = byPid.get(pid);
    if (p) protectedPgids.add(p.pgid);
  };

  // This Node process and every ancestor up the tree (the shell / pnpm that
  // launched orca — which may itself be headless if backgrounded with `&`).
  protect(process.pid);
  let cursor: number | undefined = byPid.get(process.pid)?.ppid;
  const guard = new Set<number>();
  while (cursor != null && cursor > 1 && !guard.has(cursor)) {
    guard.add(cursor);
    protect(cursor);
    cursor = byPid.get(cursor)?.ppid;
  }

  // Whatever currently serves orca's own ports.
  for (const port of [BACKEND_PORT, FRONTEND_PORT]) {
    for (const pid of pidsOnPort(port)) protect(pid);
  }

  // Every tracked, still-alive dispatch. Detached spawns use pgid == pid, so
  // protecting the pid's pgid covers the dispatch's whole subtree.
  const [stories, prds, audits] = await Promise.all([
    db
      .select({ pid: schema.stories.dispatchPid })
      .from(schema.stories)
      .where(isNotNull(schema.stories.dispatchPid)),
    db
      .select({ pid: schema.prds.dispatchPid })
      .from(schema.prds)
      .where(isNotNull(schema.prds.dispatchPid)),
    db
      .select({ pid: schema.auditChecks.dispatchPid })
      .from(schema.auditChecks)
      .where(isNotNull(schema.auditChecks.dispatchPid)),
  ]);
  for (const row of [...stories, ...prds, ...audits]) {
    const pid = row.pid;
    if (pid == null) continue;
    protectedPids.add(pid);
    protectedPgids.add(pid); // pgid == pid for our detached spawns
    if (isPidAlive(pid)) {
      // Also protect by the live pgid the kernel actually assigned, in case it
      // ever diverges from pid.
      const p = byPid.get(pid);
      if (p) protectedPgids.add(p.pgid);
    }
  }

  // ── Identify orphan roots ──────────────────────────────────────────────
  // A candidate is a tool-binary process owned by us whose parent is dead
  // (re-parented to PID 1) or whose process-group leader is dead (headless
  // group) — i.e. nothing live owns it.
  const orphanRoots: Proc[] = [];
  for (const p of procs) {
    if (protectedPids.has(p.pid)) continue;
    if (protectedPgids.has(p.pgid)) continue;
    if (!TOOL_BINARIES.has(p.exe)) continue;
    const reParented = p.ppid === 1;
    const headlessGroup = !alivePgidLeaders.has(p.pgid);
    if (reParented || headlessGroup) orphanRoots.push(p);
  }
  if (orphanRoots.length === 0) {
    // Prune escalation state for pids that are gone.
    const pending = pendingKill();
    for (const pid of [...pending]) {
      if (!isPidAlive(pid)) pending.delete(pid);
    }
    return 0;
  }

  // Expand each root to its full subtree so we don't leave dangling children.
  const subtree = (rootPid: number): number[] => {
    const acc: number[] = [];
    const stack = [rootPid];
    const seen = new Set<number>();
    while (stack.length) {
      const pid = stack.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      acc.push(pid);
      for (const c of children.get(pid) ?? []) stack.push(c);
    }
    return acc;
  };

  const pending = pendingKill();
  let reaped = 0;
  for (const root of orphanRoots) {
    // Escalate: SIGTERM the first time we see this root, SIGKILL if it's still
    // alive on a later tick (it ignored the polite signal).
    const escalate = pending.has(root.pid);
    const signal: NodeJS.Signals = escalate ? "SIGKILL" : "SIGTERM";
    const pids = subtree(root.pid).filter((pid) => !protectedPids.has(pid));
    console.log(
      `[orca/reap-orphans] orphan ${root.exe} pid=${root.pid} pgid=${root.pgid} ppid=${root.ppid} ` +
        `(${root.ppid === 1 ? "re-parented" : "headless-group"}) → ${signal} ` +
        `${pids.length} proc(s): ${root.command.slice(0, 120)}`,
    );
    for (const pid of pids) {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone between snapshot and signal — fine.
      }
    }
    if (escalate) pending.delete(root.pid);
    else pending.add(root.pid);
    reaped++;
  }

  // Prune escalation state for pids that have since exited.
  for (const pid of [...pending]) {
    if (!isPidAlive(pid)) pending.delete(pid);
  }

  if (reaped > 0) {
    console.log(`[orca/reap-orphans] reaped ${reaped} orphan root(s)`);
  }
  return reaped;
}
