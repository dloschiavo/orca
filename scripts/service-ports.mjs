#!/usr/bin/env node
// Goliath service-ports helper.
//
// Reads its own service config from the cwd's package.json `goliath` block
// and the umbrella project slug from the nearest ancestor package.json that
// declares `goliath.project`. Resolves a dev port, registers it in
// /tmp/goliath-{port}, forwards signals to the framework command, and
// cleans the registry up on exit. Hunts canonical..canonical+50 when the
// canonical port is already in use by a sibling Goliath project.
//
// The `goliath` block in a service's package.json describes ONLY that
// service. Backends declare what they ARE; frontends additionally declare
// what they CONSUME (a single backend, by name + env var). The helper
// never reads another service's package.json — peer discovery is
// runtime-only, via the registry.
//
// Two modes:
//   default (dev)   full registry + eviction + peer wait + early-failure
//                   watchdog. Used by `pnpm dev`.
//   --start (prod)  just sets PORT={env.PORT ?? goliath.canonicalPort},
//                   substitutes {PORT}/{ENV_VAR} in args, execs the
//                   framework. No registry, no eviction. Used by
//                   `pnpm start`; safe under Cloud Run (PORT comes from
//                   the env).
//
// Spec: recipes/service-ports/SKILL.md.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

const REGISTRY_DIR = "/tmp";
const REGISTRY_PREFIX = "goliath-";
const HUNT_RANGE = 50;
const PEER_POLL_INTERVAL_MS = 100;
const PEER_TIMEOUT_MS = 30_000;
// Window after spawning during which an EADDRINUSE-style early exit is
// interpreted as a bind failure and the helper hunts to the next port.
const EARLY_FAILURE_WINDOW_MS = 2500;

function usage() {
  process.stderr.write(
    "Usage: service-ports.mjs [--start] -- <cmd> [args...]\n" +
      "  Reads ./package.json's `goliath` block for service config.\n" +
      "  Walks up to find the umbrella project slug in `goliath.project`.\n",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { start: false, cmd: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      opts.cmd = argv.slice(i + 1);
      break;
    }
    if (a === "--start") opts.start = true;
    else {
      process.stderr.write(`[service-ports] unknown arg: ${a}\n`);
      usage();
    }
  }
  if (opts.cmd.length === 0) usage();
  return opts;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function die(msg) {
  process.stderr.write(`[service-ports] ${msg}\n`);
  process.exit(2);
}

// Reads ./package.json `goliath` block for service identity, walks up for
// the umbrella project slug. The schema is role-shaped:
//
//   role:    "frontend" | "backend"  (required; controls allowed fields)
//   name:    string                   (required; service identity within project)
//   canonicalPort: number             (required; preferred dev port)
//   framework:     string             (required; for the registry entry)
//   consumes: { name, envVar }        (frontend-only; the backend it talks to)
//
// Backends MUST NOT declare `consumes`. Frontends MAY; if they do,
// `pnpm dev` blocks until that backend appears in the registry, then sets
// `envVar=http://localhost:{peer.port}` for the spawned framework.
function loadServiceConfig() {
  const cwd = process.cwd();
  const localPkgPath = path.join(cwd, "package.json");
  const localPkg = readJson(localPkgPath);
  if (!localPkg || !localPkg.goliath) {
    die(`${localPkgPath} has no "goliath" block — cannot resolve service config`);
  }
  const g = localPkg.goliath;
  for (const key of ["role", "name", "canonicalPort", "framework"]) {
    if (g[key] === undefined) die(`${localPkgPath} goliath.${key} is missing`);
  }
  if (g.role !== "frontend" && g.role !== "backend") {
    die(`${localPkgPath} goliath.role must be "frontend" or "backend" (got ${JSON.stringify(g.role)})`);
  }
  if (g.role === "backend" && g.consumes !== undefined) {
    die(`${localPkgPath} goliath.consumes is frontend-only; backends do not declare peers`);
  }
  let consumes = null;
  if (g.consumes !== undefined) {
    if (!g.consumes || typeof g.consumes !== "object") {
      die(`${localPkgPath} goliath.consumes must be an object`);
    }
    if (!g.consumes.name || !g.consumes.envVar) {
      die(`${localPkgPath} goliath.consumes must have { name, envVar }`);
    }
    consumes = { name: g.consumes.name, envVar: g.consumes.envVar };
  }

  let project = g.project ?? null;
  let dir = path.dirname(cwd);
  while (!project && dir !== path.dirname(dir)) {
    const parent = readJson(path.join(dir, "package.json"));
    if (parent?.goliath?.project) {
      project = parent.goliath.project;
      break;
    }
    dir = path.dirname(dir);
  }
  if (!project) {
    die(`no ancestor package.json declares goliath.project (searched from ${cwd})`);
  }

  return {
    project,
    role: g.role,
    name: g.name,
    canonicalPort: Number(g.canonicalPort),
    framework: g.framework,
    consumes,
  };
}

function registryPath(port) {
  return path.join(REGISTRY_DIR, `${REGISTRY_PREFIX}${port}`);
}

function isAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = process exists, we just lack permission; still alive.
    return e.code === "EPERM";
  }
}

function readRegistry(port) {
  try {
    return JSON.parse(fs.readFileSync(registryPath(port), "utf8"));
  } catch {
    return null;
  }
}

function listRegistry() {
  let names;
  try {
    names = fs.readdirSync(REGISTRY_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!n.startsWith(REGISTRY_PREFIX)) continue;
    const port = Number(n.slice(REGISTRY_PREFIX.length));
    if (!Number.isFinite(port)) continue;
    const entry = readRegistry(port);
    if (entry) out.push(entry);
  }
  return out;
}

// Probe a port at one specific address. Resolves true if bindable.
function probeBind(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    try {
      srv.listen({ port, host, exclusive: true });
    } catch {
      resolve(false);
    }
  });
}

// Most frameworks (Hono via @hono/node-server, Express, Next, Vite) bind
// the unspecified address — IPv6 `::` with dual-stack fallback to IPv4
// when IPv6 is available, otherwise `0.0.0.0`. We probe BOTH `::` and
// `0.0.0.0` to mirror what the framework will attempt: if either fails
// with EADDRINUSE, the port is occupied in some form the framework will
// also see.
async function isOsPortFree(port) {
  const ipv6Free = await probeBind(port, "::");
  if (!ipv6Free) return false;
  const ipv4Free = await probeBind(port, "0.0.0.0");
  return ipv4Free;
}

function tryClaimPort(cfg, port) {
  const body = JSON.stringify(
    {
      port,
      pid: process.pid,
      project: cfg.project,
      name: cfg.name,
      role: cfg.role,
      framework: cfg.framework,
      cwd: process.cwd(),
      canonicalPort: cfg.canonicalPort,
      startedAt: new Date().toISOString(),
    },
    null,
    2,
  );
  try {
    fs.writeFileSync(registryPath(port), body, { flag: "wx" });
    return true;
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e;
  }
}

// Try to claim ONE port starting at canonical + startOffset, walking
// upward. Returns the claimed port number, or null if the entire range
// is exhausted (the caller decides whether to fail or report).
async function tryClaimNextFreePort(cfg, startOffset, skipPorts, occupied) {
  for (let i = startOffset; i <= HUNT_RANGE; i++) {
    const port = cfg.canonicalPort + i;
    if (skipPorts.has(port)) continue;
    const existing = readRegistry(port);
    if (existing) {
      if (isAlive(existing.pid)) {
        occupied.push(existing);
        continue;
      }
      try {
        fs.unlinkSync(registryPath(port));
      } catch {}
    }
    if (!(await isOsPortFree(port))) {
      occupied.push({
        port,
        project: "<os-bound>",
        name: "<unknown>",
        pid: null,
      });
      continue;
    }
    if (tryClaimPort(cfg, port)) return port;
    const winner = readRegistry(port);
    if (winner) occupied.push(winner);
  }
  return null;
}

function failExhausted(cfg, occupied) {
  process.stderr.write(
    `[service-ports] no free port in range ${cfg.canonicalPort}..${
      cfg.canonicalPort + HUNT_RANGE
    }\n`,
  );
  for (const e of occupied) {
    process.stderr.write(
      `  ${e.port}: ${e.project}/${e.name}${e.pid ? ` pid=${e.pid}` : ""}\n`,
    );
  }
  process.stderr.write(
    `\nTo free a port held by an orphan: lsof -ti:<PORT> | xargs kill\n`,
  );
  process.exit(1);
}

// "Running anew kills your own old." Before claiming a port, scan the
// registry for entries that match THIS service's project + name and evict
// them. Scoping by project+name (not just port) means:
//   - Sibling Goliath projects (different `project`) are never touched.
//   - Multiple frontends on the same project with different `name`s
//     (e.g. web-admin vs web-public) coexist freely.
//   - A stale instance of THIS exact service — same project, same name —
//     gets cleaned up before the new run starts, so `pnpm dev` after a
//     crashed or `kill -9`d previous run lands on the canonical port
//     instead of hunting upward forever.
async function killOwnStaleInstances(cfg) {
  for (const entry of listRegistry()) {
    if (entry.project !== cfg.project) continue;
    if (entry.name !== cfg.name) continue;
    if (!Number.isInteger(entry.pid)) continue;
    if (entry.pid === process.pid) continue;
    const file = registryPath(entry.port);
    if (!isAlive(entry.pid)) {
      try {
        fs.unlinkSync(file);
      } catch {}
      continue;
    }
    process.stderr.write(
      `[service-ports] evicting previous ${entry.project}/${entry.name} pid=${entry.pid} on port ${entry.port}\n`,
    );
    try {
      process.kill(entry.pid, "SIGTERM");
    } catch (e) {
      if (e.code !== "ESRCH") {
        process.stderr.write(
          `[service-ports] could not SIGTERM pid=${entry.pid} (${e.code}); leaving it alone\n`,
        );
        continue;
      }
    }
    // Give the registered process up to 2s to handle SIGTERM and clean up
    // (its own exit handler will unlink the registry file and forward the
    // signal to the framework child).
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && isAlive(entry.pid)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (isAlive(entry.pid)) {
      try {
        process.kill(entry.pid, "SIGKILL");
      } catch {}
    }
    try {
      fs.unlinkSync(file);
    } catch {}
  }
}

async function waitForPeer(cfg) {
  const deadline = Date.now() + PEER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    for (const e of listRegistry()) {
      if (
        e.project === cfg.project &&
        e.name === cfg.consumes.name &&
        isAlive(e.pid)
      ) {
        return e;
      }
    }
    await new Promise((r) => setTimeout(r, PEER_POLL_INTERVAL_MS));
  }
  process.stderr.write(
    `[service-ports] timeout waiting for peer ${cfg.project}/${cfg.consumes.name} (${PEER_TIMEOUT_MS}ms)\n`,
  );
  process.exit(1);
}

function substituteArgs(rawArgs, port, peerEnvVar, peerUrl) {
  const portStr = String(port);
  const peerPattern = peerEnvVar
    ? new RegExp(`\\{${peerEnvVar}\\}|\\$\\{${peerEnvVar}\\}|\\$${peerEnvVar}\\b`, "g")
    : null;
  return rawArgs.map((arg) => {
    let out = arg
      .replace(/\{PORT\}/g, portStr)
      .replace(/\$\{PORT\}/g, portStr)
      .replace(/\$PORT\b/g, portStr);
    if (peerPattern && peerUrl) out = out.replace(peerPattern, peerUrl);
    return out;
  });
}

// Spawn the framework command and watch it for the first
// EARLY_FAILURE_WINDOW_MS. If it exits non-zero within that window we
// treat it as a bind failure (the most common cause is EADDRINUSE that
// our probe didn't catch — TIME_WAIT race, orphaned listener on a
// different address family, framework-internal port conflict). The
// caller then hunts to the next port. If the child survives the window,
// we install the normal long-lived lifecycle and resolve(null) so the
// caller awaits it.
function spawnWithEarlyFailureWatchdog(cfg, cmd, port, env, cleanupRegistry) {
  return new Promise((resolve, reject) => {
    const peerEnvVar = cfg.consumes?.envVar ?? null;
    const substituted = substituteArgs(cmd, port, peerEnvVar, peerEnvVar ? env[peerEnvVar] : null);
    const [bin, ...args] = substituted;
    const child = spawn(bin, args, { stdio: "inherit", env, shell: false });

    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const watchdog = setTimeout(() => {
      // Child survived the window — assume bind succeeded. Hand it off
      // to the long-lived lifecycle.
      const forward = (sig) => {
        try {
          child.kill(sig);
        } catch {}
      };
      process.on("SIGINT", () => forward("SIGINT"));
      process.on("SIGTERM", () => forward("SIGTERM"));
      process.on("SIGHUP", () => forward("SIGHUP"));
      child.on("exit", (code, signal) => {
        cleanupRegistry();
        if (signal) process.kill(process.pid, signal);
        else process.exit(code ?? 0);
      });
      child.on("error", (err) => {
        process.stderr.write(`[service-ports] spawn error: ${err.message}\n`);
        cleanupRegistry();
        process.exit(1);
      });
      settle({ earlyFailure: false });
    }, EARLY_FAILURE_WINDOW_MS);

    child.once("exit", (code, signal) => {
      if (settled) return;
      clearTimeout(watchdog);
      // Within the early window — treat any non-zero or signal exit as
      // a bind failure. A clean 0-exit this fast is suspicious too
      // (framework refused to even start) — treat as failure so we
      // surface it rather than silently succeed.
      const failed = code !== 0 || signal != null;
      if (failed) {
        process.stderr.write(
          `[service-ports] child exited early (code=${code}, signal=${signal}) on port ${port} — assuming bind failure, hunting next port\n`,
        );
      }
      settle({ earlyFailure: failed, code, signal });
    });

    child.once("error", (err) => {
      if (settled) return;
      clearTimeout(watchdog);
      process.stderr.write(`[service-ports] spawn error: ${err.message}\n`);
      reject(err);
    });
  });
}

// --start mode: read PORT from env (Cloud Run injects it in prod, missing
// in local invocations), fall back to package.json canonicalPort,
// substitute {PORT}/{ENV_VAR} in args, exec the framework. No registry,
// no eviction, no peer wait — those are dev-only concerns.
function runStartMode(cfg, cmd) {
  const port = Number(process.env.PORT ?? cfg.canonicalPort);
  const env = { ...process.env, PORT: String(port) };
  const peerEnvVar = cfg.consumes?.envVar ?? null;
  const peerUrl = peerEnvVar ? env[peerEnvVar] : null;
  const substituted = substituteArgs(cmd, port, peerEnvVar, peerUrl);
  const [bin, ...args] = substituted;
  const child = spawn(bin, args, { stdio: "inherit", env, shell: false });
  const forward = (sig) => {
    try {
      child.kill(sig);
    } catch {}
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGHUP", () => forward("SIGHUP"));
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
  child.on("error", (err) => {
    process.stderr.write(`[service-ports] spawn error: ${err.message}\n`);
    process.exit(1);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadServiceConfig();

  if (args.start) {
    runStartMode(cfg, args.cmd);
    return;
  }

  // Evict any prior instance of THIS service (same project + name) before
  // doing anything else. Scoped to project+name on purpose — never kills
  // sibling Goliath projects or differently-named services in the same
  // project. See killOwnStaleInstances() comment for the full rationale.
  await killOwnStaleInstances(cfg);

  let peerUrl = null;
  if (cfg.consumes) {
    const peer = await waitForPeer(cfg);
    peerUrl = `http://localhost:${peer.port}`;
    process.stderr.write(
      `[service-ports] peer ${cfg.project}/${cfg.consumes.name} at ${peerUrl}\n`,
    );
  }

  const occupied = [];
  const triedAndFailed = new Set();
  let nextOffset = 0;
  while (nextOffset <= HUNT_RANGE) {
    const port = await tryClaimNextFreePort(
      cfg,
      nextOffset,
      triedAndFailed,
      occupied,
    );
    if (port == null) {
      failExhausted(cfg, occupied);
      return; // unreachable
    }

    const file = registryPath(port);
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      try {
        fs.unlinkSync(file);
      } catch {}
    };
    // Per-attempt exit hook. The hook is harmless if cleanup already ran.
    process.on("exit", cleanup);

    process.stderr.write(
      `[service-ports] ${cfg.project}/${cfg.name} → port ${port} (canonical ${cfg.canonicalPort}) → ${file}\n`,
    );

    const env = { ...process.env, PORT: String(port) };
    if (peerUrl && cfg.consumes) env[cfg.consumes.envVar] = peerUrl;

    const result = await spawnWithEarlyFailureWatchdog(
      cfg,
      args.cmd,
      port,
      env,
      cleanup,
    );
    if (!result.earlyFailure) {
      // Long-lived lifecycle installed by the watchdog — this main()
      // call will be terminated by the child's exit handler.
      return;
    }

    cleanup();
    triedAndFailed.add(port);
    occupied.push({
      port,
      project: "<bind-failed>",
      name: cfg.name,
      pid: null,
    });
    nextOffset = port - cfg.canonicalPort + 1;
  }

  failExhausted(cfg, occupied);
}

main().catch((err) => {
  process.stderr.write(`[service-ports] fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
