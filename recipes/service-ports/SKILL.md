---
name: service-ports
description: >
  Uniform package.json script contract (`dev`/`build`/`start`/`typecheck`/`clean`)
  across every Goliath repo, plus a copy-in `scripts/service-ports.mjs` helper
  that registers each running dev service in `/tmp/goliath-{port}`, evicts its
  own prior instance (same project + same name) on each new run, and hunts
  for a free port when colliding with sibling projects. Service identity
  (role, name, canonical port, framework, optional backend peer) lives in
  each package.json's `goliath` block — a single source of truth. Handles
  Vite/Next/Express/Hono/Expo. Dev-only registration; `pnpm start` is the
  uniform prod entry that Cloud Run drives via `process.env.PORT`.
dependencies:
  requires: []
  capabilities: {}
provides: [service-ports]
---

# Service Ports

The canonical script + port-registry contract for every Goliath repo.

The load-bearing insight: **`pnpm dev` means "the watcher" and `pnpm start` means "the built artifact" — always, in every Goliath repo, including the ones you haven't installed this recipe in yet.** The five-script contract (`dev`/`build`/`start`/`typecheck`/`clean`) is the language. The `scripts/service-ports.mjs` helper is the runtime: every dev service announces itself in `/tmp/goliath-{port}`, evicts its own prior instance on a new run, and hunts past sibling-project listeners on collision.

orca is the **dev orchestrator** for Goliath projects — it discovers running services and surfaces them. What every project under orca needs is uniform behaviour so orca (and operators) can find services without `lsof`-and-pray. This recipe is the protocol.

Reference implementation: this orca repo — `scripts/service-ports.mjs`, root + `apps/*` + `packages/*` package.json files, `apps/web/vite.config.ts`, `apps/server/src/app.ts`.

## Single source of truth: the `goliath` block

Every port, every service name, every peer relationship lives in **one place per service**: the `goliath` block in that service's `package.json`. Nothing is repeated anywhere else — not in scripts, not in framework configs, not in CLI flags.

The umbrella project slug lives **once**, in the repo-root `package.json`:

```json
{
  "goliath": { "project": "<slug>" }
}
```

Each service then declares its own identity — and only its own — in its own `package.json`:

```json
// apps/server/package.json — a BACKEND
{
  "goliath": {
    "role": "backend",
    "name": "server",
    "canonicalPort": 4455,
    "framework": "hono"
  }
}
```

```json
// apps/web/package.json — a FRONTEND that consumes the backend
{
  "goliath": {
    "role": "frontend",
    "name": "web",
    "canonicalPort": 5173,
    "framework": "vite",
    "consumes": { "name": "server", "envVar": "<SLUG>_SERVER_URL" }
  }
}
```

Schema rules (the helper enforces these — install fails the audit if not):

- **`role`** is `"frontend"` or `"backend"`. Required. The two have different allowed shapes; mixing them is a schema error.
- **`name`** is the service identity within the project. Required. Used to dedupe registry entries.
- **`canonicalPort`** is the preferred dev port. Required. The helper hunts upward from here if it's taken.
- **`framework`** is a string label for the registry (`"vite"`, `"hono"`, `"next"`, etc.). Required. Operator UI only — the helper itself is framework-agnostic.
- **`consumes`** is **frontend-only**. Declares *which* backend this frontend talks to (`name`) and *what env var* the helper should inject with the resolved peer URL (`envVar`). Backends MUST NOT declare `consumes` — they don't reach out to other services in this model; they are reached out to. The asymmetry is the whole point.
- **`project`** lives ONLY at the umbrella root. Services do not duplicate it.

Why the role split: backends are addressable identities; frontends are clients of one of those identities. Treating them as one undifferentiated "service" leaks frontend concerns (peer wiring, proxy targets) into backend configs and vice versa. Two roles, two schemas, no mixing.

## The Eviction Rule (read this first)

Every dev process the helper spawns has an **identity**: the tuple `(project, name)` read from the goliath block. The registry file `/tmp/goliath-{port}` records this identity along with the PID.

The helper's single rule for deciding what to kill on a new run:

| Existing registry entry vs. new run | Action |
|---|---|
| **Same `project` AND same `name`** (identity match) | **Always evicted.** SIGTERM the registered PID, wait up to 2 s, SIGKILL if still alive, unlink the registry file. The new run then claims the canonical port. |
| **Different `project`** (any name) | **Never touched.** New run hunts to `canonical+1`, `canonical+2`, … |
| **Same `project`, different `name`** (e.g. `web-admin` vs `web-public`) | **Never touched.** New run hunts past it. |
| **No registry entry but OS port is bound** (non-Goliath listener, or orphan after `kill -9`) | **Never touched.** New run hunts past it. The orphan can only be evicted by an operator (`lsof -ti:<port> | xargs kill`) — by design, because we cannot prove ownership without a registry entry. |

In one sentence: **the only thing a `service-ports.mjs` run ever kills is its own previous incarnation, identified by `(project, name)` — nothing else, ever.**

This is what makes parallel `pnpm dev` across many Goliath repos safe, and what makes a crashed-and-restarted `pnpm dev` land back on its canonical port instead of hunting forever past its own corpse.

## The Script Contract

Every Goliath repo — root and every workspace package — speaks the same five scripts. Anything beyond this set is project-specific extra, not part of the contract.

| Script           | Meaning                                                | Watchers? | Registers `/tmp/goliath-{port}`? |
|------------------|--------------------------------------------------------|-----------|----------------------------------|
| `pnpm dev`       | Dev server(s) with file watchers + hot reload          | yes       | yes                              |
| `pnpm build`     | Production build artifacts (`dist/`, `.next/`, etc.)   | no        | no                               |
| `pnpm start`     | Run the built artifact, reads `process.env.PORT`       | no        | no (prod is Cloud Run's job)     |
| `pnpm typecheck` | `tsc --noEmit`                                         | no        | no                               |
| `pnpm clean`     | Remove build output + framework caches                 | no        | no                               |

Rules:

- `pnpm dev` is **always** the watcher. Never `pnpm start`. Never `pnpm watch`.
- `pnpm start` is **always** the prod runtime. It also goes through the helper — but in `--start` mode, which just resolves `PORT` from env (Cloud Run injects it) with a fallback to `goliath.canonicalPort`, and execs the framework. No registry, no eviction.
- A monorepo root with multiple apps gets the same five scripts; root delegates to its apps in parallel.
- Library packages (`packages/*`) that have no dev server omit `dev` and `start`. They keep `build`/`typecheck`/`clean`. The root's `pnpm dev` filters them out. Libraries also don't need a `goliath` block.

## The Helper

A single file, `scripts/service-ports.mjs`, ~400 lines, Node 20+, **no dependencies**. Copied verbatim into each repo by the recipe — the file is the spec.

### CLI

```
# Dev mode (full lifecycle: registry, eviction, peer wait, early-failure watchdog)
node scripts/service-ports.mjs -- <command-to-spawn> [args...]

# Start mode (prod-friendly: just resolves PORT, substitutes {PORT}, execs)
node scripts/service-ports.mjs --start -- <command-to-spawn> [args...]
```

That's it — no `--project`, `--name`, `--canonical-port`, `--framework`, `--require-peer`, or `--peer-env-var` flags. The helper reads `./package.json`'s `goliath` block for service identity and walks up to find `goliath.project`. Anything you'd want to override on the CLI would be a duplication of what's already in `package.json` — and duplication is exactly what this redesign exists to eliminate.

Apps wire this into `package.json`:

```json
"dev": "node ../../scripts/service-ports.mjs -- vite --port {PORT} --strictPort"
```

Everything after `--` is the framework command. The helper owns port resolution + registry; the framework owns serving.

**Use `{PORT}` (curly-braces literal), not `$PORT`,** in the framework args. pnpm/npm runs the entire `dev` script through a shell, and that outer shell expands `$PORT` to empty *before* the helper sets it. The helper substitutes `{PORT}` (and `${PORT}`, and `$PORT` for hand-typed shell invocations) with the resolved port just before spawning the child. The same rule applies to whatever env var name a frontend declares in `consumes.envVar` — use the curly-brace form in the args after `--` if you need to interpolate it.

### The `/tmp/goliath-{port}` file

```json
{
  "port": 5173,
  "pid": 12345,
  "project": "orca",
  "name": "web",
  "role": "frontend",
  "framework": "vite",
  "cwd": "/Users/davidloschiavo/Documents/Goliath/orca/apps/web",
  "canonicalPort": 5173,
  "startedAt": "2026-05-14T15:23:00.000Z"
}
```

One file per running dev process. Path: `/tmp/goliath-${port}` (no extension — `ls /tmp/goliath-*` is the operator UI).

### Lifecycle (dev mode)

1. **Load service config.** Read `./package.json` for the `goliath` block. Validate the schema (role, required fields, no `consumes` on backends, etc.). Walk up the filesystem to find an ancestor `package.json` with `goliath.project`. Failure at any step is a 2-exit before any side effects.
2. **Evict own prior instances** (implements the [Eviction Rule](#the-eviction-rule-read-this-first)). Scan the registry. For every entry where `entry.project === cfg.project && entry.name === cfg.name && entry.pid !== process.pid`:
   - Liveness probe via `process.kill(pid, 0)`. Dead → unlink the file and move on.
   - Alive → `SIGTERM`, poll liveness for up to 2 s, then `SIGKILL` if still alive. Unlink the registry file.

   Invariants this step enforces:
   - The matcher is `(project, name)`. Port is not part of the match — an evictee may be on any port in the hunted range.
   - Entries whose `project` differs are skipped, full stop. No fallback, no "if no other option" — sibling projects are never evicted, regardless of port collision.
   - Entries whose `name` differs are skipped, full stop. Same project, different `name` = different service = coexists.
   - The helper never kills by port (`lsof -ti:N`) — only by registered identity. A port held by something with no registry entry is a non-Goliath listener and is never touched; the run hunts past it instead.
3. **Wait for required peer** (frontends only, when `consumes` is declared). Poll the registry for an entry with matching `project` + `consumes.name`, 100 ms interval, 30 s timeout. On hit, build `http://localhost:{peer.port}` and stash it for the `consumes.envVar` substitution.
4. **Resolve port.** Try `canonical`, then `canonical+1`, …, up to `canonical+50`. For each candidate:
   - If `/tmp/goliath-{port}` exists → read it, run `process.kill(pid, 0)` liveness probe. Throws `ESRCH` → owner dead → unlink the stale file. Succeeds (or `EPERM`) → owner alive → skip.
   - If the OS port is bound on **either** `::` (IPv6, dual-stack on systems where `IPV6_V6ONLY=0`) **or** `0.0.0.0` (IPv4) → skip even if no registry file. Frameworks bind the unspecified address by default, so probing only `127.0.0.1` would miss a dual-stack orphan listening on `::` — the most common real-world false-pass for the probe.
   - Race-safe registry write: `fs.writeFileSync(path, body, { flag: "wx" })`. `EEXIST` → another helper beat us → continue scanning.
   - If all 51 candidates are taken: print every occupier and exit 1.
5. **Spawn child + early-failure watchdog.** Inherit stdio. Set `PORT={resolved}` in env, and (frontend only) `cfg.consumes.envVar={peerUrl}`. Watch the child for `EARLY_FAILURE_WINDOW_MS` (2.5 s). If the child exits non-zero or by signal inside that window — almost always `EADDRINUSE` that the probe couldn't catch (TIME_WAIT race, address family the probe missed, framework-internal port conflict like Vite's worker socket) — unlink the registry file, mark this port as tried-and-failed, and resume the hunt from `canonical + (failed_port - canonical + 1)`. This is the second layer of robustness behind the probe.
6. **Forward signals.** Once the child survives the watchdog, catch `SIGINT`/`SIGTERM`/`SIGHUP`, forward to child, unlink the registry file before exiting with the child's exit code.
7. **Backstop cleanup.** `process.on("exit", …)` unlinks the file on non-graceful exit. Stale files from `kill -9` are handled by step 2 of the next run (own-instance eviction) and the per-candidate liveness probe in step 4.

### Lifecycle (--start mode)

Drastically simpler than dev mode — `pnpm start` is for prod where Cloud Run owns the port, so there's nothing to register and no eviction to do.

1. Load service config (same as dev — same schema, same validation).
2. Resolve `PORT`: `process.env.PORT` wins; fall back to `goliath.canonicalPort` for local `pnpm start` invocations without Cloud Run.
3. Substitute `{PORT}` and (frontend only) `{consumes.envVar}` in the args after `--`.
4. exec the framework. Forward signals. That's it.

No `/tmp/goliath-*` files are touched in this mode — the registry is dev-only.

### Framework adapters

The helper just sets `PORT`. Each framework reads it differently:

| Framework  | How the framework picks up `PORT`                            |
|------------|--------------------------------------------------------------|
| Vite       | `vite --port {PORT} --strictPort`                             |
| Hono/Node  | `process.env.PORT` (canonical)                               |
| Express    | `app.listen(process.env.PORT)`                               |
| Next dev   | `next dev -p {PORT}`                                          |
| Next start | `next start -p {PORT}`                                        |
| Expo/Metro | `expo start --port {PORT}`                                    |
| Watchman   | **Not port-scoped** — global daemon. Recipe does not touch.  |

`--strictPort` on Vite is **mandatory**. Without strict, Vite silently auto-hunts to a port different from what the helper registered, decoupling the registry from reality.

### Peer discovery (frontend → backend)

A frontend that proxies to a backend (Vite proxy, Next.js rewrites) **declares the peer in its own package.json** under `consumes`. The helper, on `pnpm dev`, waits for that backend to appear in the registry and injects its URL via the env var name the frontend chose:

- Backend dev script starts under the helper → writes `/tmp/goliath-4455` (or shifted).
- Frontend's package.json has `"consumes": { "name": "server", "envVar": "ORCA_SERVER_URL" }`. The helper polls for `/tmp/goliath-*` files matching `project=orca, name=server`, then sets `ORCA_SERVER_URL=http://localhost:{port}` for the framework child.
- Frontend config (e.g. `vite.config.ts`) reads `process.env.ORCA_SERVER_URL` and **fails loudly** if missing — there is no `?? "http://localhost:4455"` fallback. Falling back to a literal port re-introduces the hardcoding this recipe exists to eliminate, and it hides the case where someone bypassed the helper.

Backend CORS list **must not** hardcode `http://localhost:5173`. The backend has no business knowing what port any particular frontend ran on. In dev, allow any localhost port via regex `/^http:\/\/localhost:\d+$/`; in prod, populate an allow-list from `process.env.<SLUG>_CORS_ORIGINS` (comma-separated) or wherever your deploy supplies real prod origins. Either way, no frontend port literal in the backend.

## File Map

What the recipe drops into the target project:

```
<project>/
  scripts/
    service-ports.mjs                    ← copied verbatim from templates/
  package.json                           ← adds `goliath: { project }` + script block (root)
  apps/*/package.json                    ← adds `goliath` block (per-service identity) + script block
  packages/*/package.json                ← script block only (libraries; no goliath block)
  docs/
    scripts.md                           ← one-page reference of the contract
```

Project-specific wiring (per-stack template, applied during install):

```
apps/web/vite.config.ts                  ← reads <SLUG>_SERVER_URL env var, no fallback
apps/server/src/<server-entry>.ts        ← CORS regex in dev, env-driven allow-list in prod
```

## Install-Time Audits

Before writing any file, the recipe runs these checks. Any failure stops the install.

| Audit | Grep | Pass condition |
|---|---|---|
| `no-lsof-kill-in-pre-hooks` | `rg -n 'lsof -ti.*xargs kill' package.json apps/*/package.json packages/*/package.json` | Zero matches. These `pre*` hooks are the cross-project killing behavior this recipe replaces; they must be deleted before the helper goes in. |
| `no-canonical-port-flag` | `rg -n -- '--canonical-port' package.json apps/*/package.json` | Zero matches. The CLI flag form is the old API; ports now live in `goliath.canonicalPort`. |
| `no-hardcoded-port-in-scripts` | `rg -nP ':\s*\d{4,5}' apps/*/package.json` | Zero matches **outside** the `goliath` block. (Ports in `goliath.canonicalPort` are the SSoT and exempt.) |
| `vite-strict-port` | `rg -n '"dev":.*vite( |$)' apps/*/package.json` | Every match passes `--port {PORT} --strictPort` (after install). |
| `no-hardcoded-localhost-proxy` | `rg -n "localhost:[0-9]+" apps/*/vite.config.ts apps/*/next.config.* 2>/dev/null` | Zero matches. Frontends read the helper-injected env var with no port literal as fallback. |
| `no-hardcoded-localhost-cors` | `rg -n '"http://localhost:[0-9]+"' apps/*/src/**/*.ts 2>/dev/null` | Zero matches in CORS allow-list literals. Dev = regex; prod = env-driven. |
| `goliath-block-present` | (script reads each `apps/*/package.json` JSON) | Each app has a `goliath` block with `role`, `name`, `canonicalPort`, `framework`. Backends have no `consumes`; frontends with `consumes` have `name` + `envVar`. |
| `node-20-or-later` | `node -p "process.versions.node"` | Major ≥ 20 (the helper uses `fs.writeFileSync` `flag: "wx"`, `net.createServer`, ESM imports). |

## Concrete Script Blocks (templates)

Root `package.json` (monorepo):

```json
{
  "goliath": { "project": "<slug>" },
  "scripts": {
    "dev": "pnpm -r --parallel --filter=./apps/* dev",
    "build": "pnpm -r --filter=./apps/* --filter=./packages/* build",
    "start": "pnpm -r --parallel --filter=./apps/* start",
    "typecheck": "pnpm -r typecheck",
    "clean": "pnpm -r clean"
  }
}
```

Backend (Hono / Express / Node) app:

```json
{
  "goliath": {
    "role": "backend",
    "name": "server",
    "canonicalPort": 4455,
    "framework": "hono"
  },
  "scripts": {
    "dev": "node ../../scripts/service-ports.mjs -- <watch-cmd>",
    "build": "tsc",
    "start": "node ../../scripts/service-ports.mjs --start -- tsx src/index.ts",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist .turbo"
  }
}
```

Vite frontend app (with backend peer):

```json
{
  "goliath": {
    "role": "frontend",
    "name": "web",
    "canonicalPort": 5173,
    "framework": "vite",
    "consumes": { "name": "server", "envVar": "<SLUG>_SERVER_URL" }
  },
  "scripts": {
    "dev": "node ../../scripts/service-ports.mjs -- vite --port {PORT} --strictPort",
    "build": "tsc --noEmit && vite build",
    "start": "node ../../scripts/service-ports.mjs --start -- vite preview --port {PORT} --host",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist node_modules/.vite"
  }
}
```

Next.js app:

```json
{
  "goliath": {
    "role": "frontend",
    "name": "web",
    "canonicalPort": 3000,
    "framework": "next",
    "consumes": { "name": "server", "envVar": "<SLUG>_SERVER_URL" }
  },
  "scripts": {
    "dev": "node ../../scripts/service-ports.mjs -- next dev -p {PORT}",
    "build": "next build",
    "start": "node ../../scripts/service-ports.mjs --start -- next start -p {PORT}",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf .next"
  }
}
```

Expo app:

```json
{
  "goliath": {
    "role": "frontend",
    "name": "mobile",
    "canonicalPort": 8081,
    "framework": "expo",
    "consumes": { "name": "server", "envVar": "<SLUG>_SERVER_URL" }
  },
  "scripts": {
    "dev": "node ../../scripts/service-ports.mjs -- expo start --port {PORT}",
    "build": "expo export",
    "start": "node ../../scripts/service-ports.mjs --start -- expo serve --port {PORT}",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist .expo"
  }
}
```

Library package (no dev server, no goliath block):

```json
{
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist .turbo"
  }
}
```

## Fit-to-Project

- **Watchman** is not a per-project listener — it's a global daemon. The recipe does not register or hunt for it.
- **Embedded Postgres** in orca runs in-process, so the database port is owned by the server's `pnpm dev` and does not need a separate registry entry or goliath block.
- **Multiple frontends** (e.g. admin + public web): each gets its own `name` (`web-admin`, `web-public`) and its own canonical port in its own package.json. They register independently. If they consume the same backend, both declare the same `consumes.name`.
- **GCP / Cloud Run**: `pnpm start` reads `process.env.PORT` injected by Cloud Run via `--start` mode. The registry is not used in prod.
- **Lockstep peer** is the default: declaring `consumes` makes the helper block until the backend appears. If a frontend tolerates a missing backend at boot (degraded UI), omit `consumes` and let the framework retry on its own.

## Anti-Patterns

1. **Hardcoded port numbers in `package.json` scripts** like `--canonical-port 5173` or `${PORT:-5173}`. The whole reason `goliath.canonicalPort` exists is so the number lives in exactly one place per service. If it appears in the `scripts` block too, the SSoT is broken.
2. **Backend reading a frontend's port** (e.g. importing `apps/web/package.json` from `apps/server/src/app.ts` to populate a CORS allow-list). This re-mixes the very thing the role split exists to separate. The backend has no business knowing a specific frontend's port.
3. **Frontend with a literal `localhost:<port>` fallback** in `vite.config.ts` / `next.config.*` (e.g. `process.env.SERVER_URL ?? "http://localhost:4455"`). The fallback duplicates the canonical port and hides the case where someone bypassed the helper. Read the env var; throw if missing.
4. **`lsof -ti:N | xargs kill -9` in any `pre*` hook, or anywhere else in a project's scripts.** Killing by port is unsafe: a sibling Goliath project may have hunted to that port, and a non-Goliath user process may be using it. The recipe's eviction is scoped by *identity* (`project` + `name`) — never by port — precisely so it can be aggressive about "kill your own previous instance" without ever risking a sibling. `predev`/`pretest`/etc. hooks of the `lsof | kill` shape must be deleted on install.
5. **`vite` without `--strictPort`.** Without strict, Vite silently auto-hunts to a different port than the helper registered, decoupling the registry from reality.
6. **`pnpm start` that runs a dev server.** `start` is prod-only. If you want hot reload, that's `dev`.
7. **A helper that polls without a timeout.** `consumes`-based peer wait must give up after 30 s and print the missing peer name. Otherwise a misspelled peer name hangs `pnpm dev` forever.
8. **Writing the registry file without `flag: "wx"`.** Without exclusive-create semantics, two helpers racing on the same port both think they won and both spawn the framework.
9. **Skipping cleanup on SIGTERM.** If the helper doesn't unlink `/tmp/goliath-{port}` on shutdown, the *liveness probe* on the next `pnpm dev` cleans it up — but the file lingers in the meantime and `ls /tmp/goliath-*` lies.
10. **Calling the helper from `prestart` / `postinstall`.** The registry is dev-only. `pnpm start` (prod) uses `--start` mode which intentionally doesn't write to `/tmp`.
11. **Trusting the registry without `process.kill(pid, 0)`.** A stale file from a `kill -9` looks identical to a live one. Liveness probe every read, or you'll wait forever on a peer that died yesterday.
12. **Skipping the OS-bind probe.** A non-Goliath process can hold a port without a registry entry. The helper must `net.createServer().listen(port)` before claiming, or it will register a port the framework can't bind.
13. **Probing only `127.0.0.1`.** An orphan listening on `::` (dual-stack) is invisible to a `127.0.0.1`-only probe on systems where `IPV6_V6ONLY` differs between sockets — the probe passes, the framework binds the same port the framework's own default address family looks at, and crashes with `EADDRINUSE: address ':::PORT'`. The probe must check both `::` and `0.0.0.0`. This is the single most common production failure for naive port helpers.
14. **No early-failure watchdog.** Even with a perfect probe, frameworks can fail to bind because of TIME_WAIT races, framework-internal sub-ports (Vite worker socket, Next.js telemetry port), and address-family quirks the probe can't model exactly. If the helper does not watch the spawned child for the first ~2 s and re-hunt on early non-zero exit, every one of those races bubbles up as a confusing `pnpm dev` crash. The two layers — probe and watchdog — together cover the failure surface.
15. **`consumes` on a backend.** Backends are addressable identities; they don't reach out. If your "backend" needs to call another backend, that's a service-to-service concern handled by a real service-discovery mechanism, not by this recipe.

## Verification

After install, all of the following must hold:

1. **Clean run.** `pnpm dev` from project root with nothing running. Expect `/tmp/goliath-<server>` and `/tmp/goliath-<web>` to appear with correct `project`/`name`/`role`/`framework`. `curl http://localhost:<server>/health` returns 200. Browser at `http://localhost:<web>` loads with no CORS errors.
2. **Self-eviction (positive).** With `pnpm dev` running normally for this project, start a second `pnpm dev` from another shell for the *same* project. Expect:
   - The second run logs `[service-ports] evicting previous <project>/<name> pid=<old> on port <canonical>` and SIGTERMs the first.
   - The second run binds the *canonical* port within ~2 s — it does NOT hunt to `canonical+1`.
   - `/tmp/goliath-<canonical>` now references the new pid.
   - The first shell exits cleanly (the supervisor cascades down).
3. **Cross-project safety (negative).** With this project's `pnpm dev` running, in a sibling Goliath repo with a *different* `goliath.project` value, start a `pnpm dev` whose canonical port is the same. Expect:
   - The sibling does NOT touch this project's process or registry file.
   - The sibling hunts to `canonical+1` (or further) and writes its own registry entry there.
   - Two helpers, two registry files, both alive. No cross-kill.
4. **Conflict run (probe + registry hunt).** With dev servers up, manually write a sibling-project fake at `/tmp/goliath-<canonical+1>` (live PID like `$$`). Bind the canonical port with `nc -l <canonical> &`. Re-run `pnpm dev`. Expect the helper to skip the canonical (OS-busy) and the fake (registry-busy, different project) and bind `canonical+2`. Sibling fake untouched.
5. **Stale-file run.** Write a registry file with a dead PID (`99999`). `pnpm dev` should unlink it and take the port.
6. **Shutdown.** `Ctrl-C` `pnpm dev`. Every `/tmp/goliath-*` for this project gone within 2 s.
7. **No 500 ISE.** Browse all main routes; server log shows no 500s.
8. **GCP `start` smoke.** `pnpm build && PORT=8080 pnpm --filter @<scope>/server start &`. Verify it binds 8080 and **does not** write `/tmp/goliath-8080`.
9. **Schema violations rejected.** Add `consumes` to a backend's goliath block; `pnpm dev` must exit 2 with a clear error before doing anything.

If any step fails the install is not done.
