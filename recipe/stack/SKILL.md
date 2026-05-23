---
name: stack
description: >
  The default Goliath stack. Use when scaffolding a new project, deciding
  which layer owns a given concern, or cross-referencing layer names used by
  other skills. Covers Expo + React Native client with Expo Router API routes
  as the backend, native MongoDB driver, Next.js for SSR/logged-out pages,
  localhost dev, single-box AWS EC2 deployment.
provides: [stack]
---

# Goliath Stack

The reference stack assumed by every other skill in this repo. When a skill
says "the client", "the API route", or "the public site", it maps to the
layers below. The load-bearing insight: one Expo project hosts both the
authenticated client **and** the backend API via Expo Router `+api.ts` files,
so there is no separate Express/Fastify process to deploy. Next.js is a
second, independent app used only for logged-out, SEO-indexed surfaces.

Reference implementation: `docpost/docpost-app/` — cited inline below.

## Layers

| Layer | Tech | Responsibility |
|---|---|---|
| Client | Expo Router + React Native (iOS, Android, Web via `react-native-web`) | Authenticated app. All logged-in UX, data entry, real-time surfaces. |
| API | Expo Router API routes (`app/api/**/+api.ts`) | REST endpoints, session validation, business logic, queue enqueues. Served by the same Node process as the Expo web build. |
| Public site | Next.js (App Router, SSR) | Marketing, landing pages, SEO-indexed content, logged-out flows (signup entry, public share links). Optional — many projects skip it. |
| Database | MongoDB via the native `mongodb` driver (no ORM) | One database, collections per domain. Monthly rotation (`collection_YYYY_MM`) for append-heavy data. |

## Why this shape

- **Expo Router API routes, not Express.** The `+api.ts` pattern lets one project own client + backend with a single dependency tree, one deploy, one env file. Native clients hit the same URLs the web client does.
- **No ORM.** Skills in this repo write raw queries, batch ops, aggregation pipelines, and rely on monthly rotation patterns. Mongoose's schema layer fights those.
- **Next.js is optional and only for SSR.** Anything behind auth stays in the Expo client to avoid double-implementing screens in two runtimes. If a project has no public surface, drop Next.js entirely.
- **Single EC2 box until proven otherwise.** Cross-box networking, TLS between services, and multi-target deploys cost more than they save until real saturation forces the split.

## Data Model Boundaries

The API layer is the only thing that talks to MongoDB from inside the Expo
project. Import `lib/db.ts` (the client singleton) from `+api.ts` files only
— never from a component file, even a screen that looks server-ish. The
Expo Router bundler will happily let you shoot yourself in the foot here.

Next.js, when present, reads MongoDB **directly** on SSR (especially the
`sessions` collection) rather than proxying through the Expo API. Doubling
the hop doubles latency on every page load and couples public-site uptime
to the API's uptime.

## Repo layout

```
<project>/
  <expo-app>/              # one Expo project: client + API
    app/
      (app)/               # authenticated screens (expo-router groups)
      api/                 # backend — every file ends in +api.ts
        auth/
          request-otp+api.ts
          verify-otp+api.ts
        ...
      _layout.tsx
      index.tsx
    lib/                   # shared server-side code (db.ts, auth.ts, worker.ts)
    components/
    models/                # typed document shapes
    scripts/               # seed, index setup, env checks
  web/                     # Next.js public site (optional)
  mongo/                   # dev seed data, mongodump output
```

Observed in `docpost/docpost-app/` — the `app/api/` tree mirrors domain
boundaries (`auth/`, `chat/`, `documents/`, `prompt-queue/`, `tracking/`,
`user/`), and `lib/` holds the shared server utilities imported by those
routes.

## Pre-install: detect the canonical webapp

**STOP before scaffolding a new Expo app.** Inspect the target repo first
and decide whether one of the layers below is already filled by an
existing app — if so, use it. Spinning up a second app in parallel is the
single most expensive mistake this recipe enables.

Detection procedure (run from the project root):

1. `find . -maxdepth 3 -name 'next.config.js' -o -name 'next.config.mjs' -o -name 'next.config.ts' -not -path '*/node_modules/*'` — if any hit, a Next.js app already exists.
2. `find . -maxdepth 3 -name 'app.json' -not -path '*/node_modules/*' | xargs -I {} sh -c 'grep -l "\"expo\"" {} 2>/dev/null'` — if any hit, an Expo app already exists.
3. Open whichever exists and look at `app/` (or `pages/`). If you see real product routes (`/cards`, `/dashboard`, `/admin`, `/decks`, anything beyond a single landing page), this app **is** the product, not a marketing surface. The "Next.js is optional and only for SSR" wording below does NOT apply — that line assumes Next.js is being added new alongside an Expo client.

**Decision matrix for what to install where:**

| Existing apps in repo | Where admin / authenticated UI goes |
|---|---|
| Nothing | Default: scaffold the Expo app per this recipe; the Next.js layer is optional. |
| Only an Expo app | Add admin to the existing Expo app's `app/` and `app/api/`. |
| Only a Next.js app **with non-trivial routes** | Add admin to the existing Next.js app under `app/admin/` and `app/api/`. **Do not create an Expo app.** Convert the API-route shape from `+api.ts` to `route.ts`, swap RN primitives for plain HTML/Tailwind, and use `next/navigation` instead of `expo-router`. |
| Only a Next.js app that is clearly marketing-only (one landing page, no auth, no `app/api/`) | Either path is defensible — confirm with the user before scaffolding the Expo app. |
| Both Expo and Next.js | Admin goes in the Expo app per the default split. The Next.js app stays the marketing layer. |

If you're about to write `expo init` or `npx create-expo-app` and the repo
already has a Next.js app with a `app/` directory containing more than a
landing page, **stop and ask the user** which app should own admin. The
cost of asking once is one message; the cost of being wrong is rebuilding
the entire admin surface (this happened — see anti-patterns).

## Repo bootstrap

After the canonical-webapp check above, the target project directory
**must** be a git repository before any other scaffolding step runs. This
is non-negotiable — every other skill in this library assumes a working
`git` history for diffs, blame, rollbacks, and CI deploy hooks.

Procedure at install time:

1. From the project root, run `git rev-parse --is-inside-work-tree` to
   detect an existing repo.
2. If the command fails (no repo), **force-create one**: `git init`, then
   add a minimal `.gitignore` (at least `node_modules/`, `.env*`,
   `.expo/`, `dist/`, `build/`, `.DS_Store`), then `git add -A && git
   commit -m "Initial commit"` so subsequent skills have a baseline to
   diff against.
3. If a repo already exists, leave it alone — do not re-init, do not
   reset, do not touch the existing history.

Do not skip this step "because the user can do it later". Skills further
down the install chain (deployment scripts, CI hooks, the auditor) will
silently misbehave or hard-fail against a non-repo directory, and the
failure mode points at the wrong layer.

## Auth boundary

- **`+api.ts` routes** own OTP issuance, session creation, and session validation. The validator is a helper in `lib/auth.ts` that every protected route calls at the top of its handler.
- **Expo client** stores the session token in secure storage (native) or cookies (web) and attaches it to every request.
- **Next.js** (if present) reads the session cookie directly from the `sessions` collection on SSR — same Mongo connection string, different Node process. Never proxy session reads through the Expo API.
- **Logged-out Next.js pages** never touch the session middleware. They're cacheable and crawlable.

See the `otp-auth` skill for the sessions collection shape and middleware details.

## Background work

Expo Router API routes are request-scoped — they must return fast, and they
must not hold work that outlives the HTTP request. Anything longer than a
few hundred milliseconds goes to a queue:

- Enqueue from the `+api.ts` handler (write a `prompt_queue` doc, return 202).
- A worker process (`lib/worker.ts` loaded by a sidecar Node script, or a cron'd `node --loader` call) drains the queue.
- See the `admin-prompt-queue` skill for the queue collection and worker pattern.

Do **not** try to run the worker inside an API route by kicking off an async
function and returning early — the Expo web server may tear the process
down, and you lose observability.

## Topology

Development — everything on localhost:

```
Expo dev server         :8081   ←  native clients + web client
  └─ API routes         :8081/api/*  (same process)
Next.js dev             :3001   ←  public/logged-out web
MongoDB                 :27017
```

Production — single AWS EC2 instance, reverse-proxied:

```
                    ┌── nginx (TLS) ──┐
  app.domain.com  ──┤                 ├──  Expo web server  (pm2 / systemd)
                    │                 │    ├─ static web bundle
                    │                 │    └─ /api/*  (+api.ts handlers)
  www.domain.com  ──┤                 ├──  Next.js          (pm2 / systemd)
                    └─────────────────┘
                                                   │
                                                   ▼
                                           MongoDB (local or Atlas)

  worker (pm2)   ──  drains prompt_queue, writes results back to Mongo
```

Two or three Node processes on one box: the Expo web server (which serves
both the web client bundle **and** the API routes), Next.js (optional), and
the worker. Scale vertically before horizontally.

## Expo Configuration Gotchas

A handful of Expo-specific config settings are load-bearing for the patterns every other skill in this repo assumes. Get them wrong and the failure mode is a silent 404, a wrong-version package, or a runtime throw on first render — none of which point at the actual cause.

### `web.output: "server"` in `app.json`

Expo Router API routes (`+api.ts`) only register when the web bundler is in server output mode. The default is `"single"` (SPA), which ships a static bundle and **404s every `/api/*` request with no error in the terminal**. You'll chase a phantom network bug through the fetch, the route file, the middleware, the CORS headers — none of it. The fix is one line:

```jsonc
// app.json
{
  "expo": {
    "web": {
      "bundler": "metro",
      "output": "server"
    }
  }
}
```

Config changes don't hot-reload: kill and relaunch `expo start` after editing.

### Expo package versions follow their own lines, not the SDK major

`expo@~54.x` does **not** mean `expo-router@~54.x`. Every expo-* package has its own semver line (`expo-router@~6.x`, `expo-constants@~18.x`, `expo-linking@~8.x` for SDK 54). The canonical version-to-SDK mapping lives inside the installed `expo` package at `node_modules/expo/bundledNativeModules.json` — that's the source of truth.

**Always install expo-* packages with `npx expo install`**, never raw `npm install`. `expo install` reads `bundledNativeModules.json` and picks the version that matches the SDK; `npm install` happily pulls whatever the package.json caret resolves to, including versions from a completely different SDK generation. A typical failure mode looks like:

```
Error: Cannot find module 'expo-router/build/routes-manifest'
```

That error means `@expo/cli@54.x` is calling into `expo-router@55.x`, which moved the file. The fix is `npx expo install --fix` to re-align everything at once. If the package.json has caret pins like `"expo-router": "^55.0.11"` from a prior manual `npm install`, fix the caret before running — `expo install` respects existing ranges.

Run `npx expo install --check` at the top of every debugging session to catch version drift before it wastes an afternoon.

### Node version must match the SDK's engine requirement

Each Expo SDK pins a minimum Node version in its `package.json` `engines.node` field. SDK 54 requires `>=20.19.4`; older Node versions fail in weird ways — `@expo/cli` uses syntax like `??` (Node 14+) and optional chaining, so Node 12 throws `SyntaxError: Unexpected token ?` from inside `installAsync.js` before anything useful runs. Node 20.19.2 installs cleanly but emits `EBADENGINE` warnings.

Before running any Expo command, check `node --version` **in the shell you're launching expo from** — not a different terminal with a different nvm state. `nvm use 20` (or whatever the SDK wants) only applies to the current shell; a subprocess or a new terminal tab starts with whatever `nvm default` points to. If your `expo start` terminal still shows the wrong Node, you're debugging the wrong problem.

### NativeWind `darkMode: "class"` before `setColorScheme`

NativeWind v4 defaults to `darkMode: "media"`, which hooks the system color scheme and refuses to let code override it. The first call to `setColorScheme(...)` throws:

```
Cannot manually set color scheme, as dark mode is type 'media'.
Please use StyleSheet.setFlag('darkMode', 'class')
```

Fix at the config layer:

```js
// tailwind.config.js
module.exports = {
  darkMode: "class",
  // ...
};
```

Set this before you ship any `setColorScheme` calls — the error surfaces in production mid-render and looks like a component bug.

### `cacheVersion` in `metro.config.js` — stop needing `expo start --clear`

Metro's on-disk transform cache doesn't reliably invalidate on changes to the files that *should* invalidate it: `babel.config.js`, `metro.config.js`, `tsconfig.json`, `app.config.ts` / `app.json`, `.env`, and the lockfile. When one of those changes you either run `expo start --clear` manually (annoying, easy to forget) or chase phantom bugs from stale transform output.

The habitual fix — always passing `--clear` / `-c` — is worse than it looks. `--clear` forces Metro to re-transform every module in the graph into the live V8 heap on every start. For a typical Expo app that's 2–4 GB of peak footprint (Activity Monitor's Memory column, which counts compressed pages). Two Expo dev servers started with `--clear` on a 16 GB Mac will push the machine into swap and sit at multi-GB footprints even when idle, because V8 almost never returns pages to the OS once it has grown. `ps rss` under-reports this — the pages get compressed out when the process goes idle, but they're still part of the working set and come back as soon as the process is touched.

The right fix is to make Metro bust its own cache when meta files change. Metro's config accepts a `cacheVersion` string that becomes part of the cache key — change it and Metro treats the existing cache as invalid exactly like `--clear` does, but only when it's actually needed.

```js
// metro.config.js
const { getDefaultConfig } = require('expo/metro-config');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const config = getDefaultConfig(__dirname);

// Files whose changes should bust Metro's transform cache.
const cacheBusters = [
  'babel.config.js',
  'metro.config.js',
  'package.json',
  'pnpm-lock.yaml',    // or package-lock.json / yarn.lock
  'tsconfig.json',
  'app.config.ts',     // or app.json / app.config.js
  '.env',              // if the app uses one
];

const hash = crypto.createHash('sha1');
for (const f of cacheBusters) {
  const p = path.join(__dirname, f);
  if (fs.existsSync(p)) hash.update(fs.readFileSync(p));
}
config.cacheVersion = hash.digest('hex');

module.exports = config;
```

Warm restarts now reuse the disk cache — startup is seconds instead of a full re-transform, and peak RAM stays bounded because Metro isn't re-materializing every AST into the heap. The moment you install a package, edit `babel.config.js`, or switch branches with a different lockfile, the hash changes and Metro re-transforms on the next start. No manual intervention, no stale-cache bugs.

Drop this into every Expo app's `metro.config.js` individually — each app owns its own Metro process and there's no workspace-level place for it. Keep `--clear` as an escape hatch for genuinely weird corruption (Metro version bumps, symlink surgery), not as a daily habit.

## Package manager — pnpm with `node-linker=hoisted`

Every standalone app in a multi-project workspace like Goliath should install with **pnpm**, configured to write a **flat (hoisted) `node_modules`**. The motivation is disk, not speed: pnpm maintains a single machine-wide content-addressable store (`~/Library/pnpm/store` on macOS), and every project's `node_modules` is a tree of hardlinks — or, on macOS APFS, copy-on-write clonefiles — into that store. A fresh Expo app's `node_modules` is typically 1–1.3 GB under raw `npm install`. Under pnpm, each additional app after the first costs only the packages that aren't already in the store — typically 100–300 MB of real disk. Five independent Expo apps drops from ~6 GB of duplicated `react-native` / Expo SDK / Babel / Metro to ~1.5 GB. The same mechanism handles different versions of the same package across projects — the store is keyed on `(name, version, integrity)`, so conflicting pins coexist without special config.

You don't share `node_modules` directories between projects — each project still has its own for isolation. You share the *backing storage* underneath them.

### Why hoisted, not pnpm's default

pnpm's default `isolated` linker lays out a symlinked `node_modules/.pnpm/` tree that is strict about phantom dependencies. The React Native ecosystem is full of packages that `require()` undeclared peers, and Metro's resolver has historically tripped on symlinks. You can make `isolated` work, but you'll fight a Whac-A-Mole of `public-hoist-pattern` and `shamefully-hoist` tweaks.

`node-linker=hoisted` tells pnpm to lay out a flat `node_modules` that looks exactly like npm's — Metro, Expo CLI, `expo install`, config plugins, and anything else that walks `node_modules` directly all behave normally. The store and hardlink/clonefile mechanics are unchanged, so the disk savings are preserved. You get the storage model of pnpm with the compatibility surface of npm.

One file per project:

```
# <expo-app>/.npmrc
node-linker=hoisted
```

### Migration for an existing app

From the app's root directory:

```bash
rm -rf node_modules package-lock.json yarn.lock
echo 'node-linker=hoisted' > .npmrc
pnpm import    # only if a package-lock.json / yarn.lock existed and you want to preserve exact versions
pnpm install
```

Then update scripts and muscle memory:

- `npm install` → `pnpm install`
- `npm install some-pkg` → `pnpm add some-pkg`
- `npx expo install some-pkg` → `pnpm expo install some-pkg`
- `npm run dev` → `pnpm dev`

The *first* app you migrate pays the full store-population cost. Every subsequent app is mostly links to packages already in the store — seconds to install, near-zero marginal disk. After migrating a few apps, delete `~/.npm` if you no longer have any npm-managed projects; its cache is no longer earning its keep.

### Same-filesystem requirement

Hardlinks and APFS clonefiles both require the store and the project to live on the same filesystem. If a project is on a different volume than `~/Library/pnpm/store`, pnpm falls back to *copying* files from the store instead of linking, and you lose the dedup benefit for that project. Verify with:

```bash
pnpm store path
df -h "$(pnpm store path)" .
```

Both paths must report the same device. If a project genuinely has to live on an external drive, set `store-dir` in that project's `.npmrc` to a path on the same volume — you'll have a second store, but each one still dedupes within its own volume.

### Rolling out across multiple existing repos

A practical order of operations when converting a directory of npm-managed apps:

1. Pick the largest app first. Migrate it and confirm `expo start` still works end-to-end (including a physical-device build if the app uses native modules). The store populates against this app's lockfile.
2. Migrate the rest in any order. Each one is fast because the store is already warm.
3. After all apps are on pnpm, run `pnpm store prune` to drop any orphaned packages that the old npm installs pulled in.
4. Commit the `.npmrc` and the new `pnpm-lock.yaml` per repo. Delete the old `package-lock.json` / `yarn.lock` in the same commit.
5. Update any CI that still runs `npm ci` to run `pnpm install --frozen-lockfile` instead. Update deploy scripts the same way — the `rsync` + `pm2 reload` flow from the Deployment section keeps working, but the install step on the build host changes.

### What this doesn't fix

Disk is the only thing shared. Each Metro dev server still loads its own independent copy of the module graph into its own V8 heap — the multi-GB per-process memory footprint is unaffected by pnpm. The relevant lever for memory is still "don't leave dev servers running for apps you aren't touching" plus the `cacheVersion` trick above so that killing and restarting a dev server is cheap.

## Environment variables

Each Node process loads its own `.env.local` in dev. Don't share a single
root `.env` — server secrets will leak into whatever bundle ships to the
browser or native binary.

- `<expo-app>/.env.local` — `MONGO_URI`, session secret, SES/provider keys (server-only); `EXPO_PUBLIC_*` for values that are safe in the client bundle.
- `web/.env.local` — `MONGO_URI` (SSR only), `NEXT_PUBLIC_*` for client.

`EXPO_PUBLIC_` is the only prefix that lands in the client bundle. Anything
else is server-only and is readable from `+api.ts` handlers. Verify before
every release — a leaked `MONGO_URI` in a mobile bundle is game over.

In production, systemd unit files or pm2 ecosystem files inject real values.
Never commit prod env to the repo.

## Deployment

- Git push to `main` → CI builds the Expo web bundle and the Next.js bundle → `rsync` to EC2 → `pm2 reload` each Node process.
- MongoDB backups via `mongodump` on cron to S3. Retention per project.
- nginx config lives in-repo under `scripts/nginx/` and deploys with the app.
- Schema migrations are forward-compatible (add-only) so a pm2 rollback doesn't require data revert.

## Fit-to-Project

Before scaffolding, confirm:

- **Does the repo already have a webapp?** Run the detection procedure under `Pre-install: detect the canonical webapp` (top of file). If a Next.js app already exists with non-trivial routes, it is the product — add admin/auth/api into it instead of creating a parallel Expo app.
- Does the project actually need Next.js? If there's no public surface and no SEO requirement, drop it. The Expo web build can serve a simple landing at `/` if you really want one URL.
- Is the authenticated client mobile-first or web-first? Expo does both, but the web bundle size is a real concern if web is the primary surface — audit before launch.
- Will MongoDB run on the same EC2 box or managed (Atlas)? Same-box is cheaper for small prod; Atlas wins once you need point-in-time restore or multi-region.
- Which collections need monthly rotation? Decide at schema time — retrofitting `collection_YYYY_MM` is painful.
- Does the API need background jobs? If yes, pull in the `admin-prompt-queue` skill and add a worker process on day one. Don't bolt it on later.
- Are there any routes that need raw Node (websockets, long-polling, SSE beyond a few seconds)? Expo Router API routes are the wrong tool — stand up a minimal sidecar process for those specific endpoints and leave the rest in `+api.ts`.

## FastAPI / Python Variant

Some projects use FastAPI + Motor (async pymongo) as the backend instead of Expo Router `+api.ts`. The Expo frontend is unchanged — same React Native + NativeWind + Expo Router client. Only the server side differs.

Reference implementation: `influencer-studio/twp.react/`.

### When to use

- The project already has Python backend code (ML pipelines, data processing, existing FastAPI services)
- The team is Python-first and the Expo Router +api.ts pattern is unfamiliar
- You need Python-specific libraries (Anthropic SDK, scientific computing, etc.) that don't have Node equivalents

### Layers

| Layer | Tech | Responsibility |
|---|---|---|
| Client | Expo Router + React Native (same as default stack) | Authenticated app |
| API | FastAPI + uvicorn | REST endpoints, session validation, business logic |
| Database | MongoDB via Motor (async pymongo) | Same collections and patterns — Motor is the async equivalent of pymongo |

### Repo layout

```
<project>/
  <expo-app>/              # Expo frontend — unchanged from default stack
    app/
    components/
    src/hooks/
    src/lib/
    src/api/client.js      # axios client pointing at FastAPI
  api/                     # FastAPI backend — replaces app/api/+api.ts
    routers/               # one .py file per domain (chat.py, auth.py, etc.)
    lib/                   # shared server-side code (auth.py, db helpers)
    models.py              # Pydantic request/response models
    database.py            # Motor client singleton + global indexes
    main.py                # FastAPI app — includes all routers
  prompts/                 # prompt markdown files (read by api/lib/)
  rag/                     # knowledge base files
```

### Key adaptation patterns

**Motor instead of native MongoDB driver.** Same query surface as pymongo but every operation is `await`. Cursors iterate with `async for` instead of `.toArray()`. Parallel operations use `asyncio.gather()` instead of `Promise.all()`.

**BackgroundTasks instead of worker queue.** FastAPI's `BackgroundTasks` parameter lets you fire-and-forget work that runs after the response is sent, within the same process. Suitable for LLM calls, summary updates, and index pre-creation. Promote to a real queue (Celery, RQ) only when you need retries, dead-letter, or multi-box.

**Single router file per domain.** FastAPI groups endpoints on an `APIRouter(prefix="/chat")` — all chat endpoints in one `routers/chat.py`. More natural than one-file-per-endpoint.

**Pydantic models for request validation.** Replace manual body parsing with Pydantic `BaseModel` subclasses. FastAPI handles validation and 422 errors automatically.

**Auth via `lib/auth.py`.** Same cookie-based session pattern (`HttpOnly; SameSite=Strict`), same `require_session(request)` / `require_admin(request)` helpers, same fail-secure `LOCALHOST_AUTH_BYPASS` dev opt-in. Uses `@dataclass AuthSession` instead of a TS interface. Raises `PermissionError` instead of throwing `Error`.

### Topology (development)

```
Expo dev server         :8081   ←  native clients + web client
FastAPI (uvicorn)       :9000   ←  API server (separate process)
MongoDB                 :27017
```

The Expo client's `src/api/client.js` points `baseURL` at `http://localhost:9000/api`. In production, nginx proxies both under one domain.

### Topology (production)

```
                    ┌── nginx (TLS) ──┐
  app.domain.com  ──┤                 ├──  Expo web server  (static bundle)
  app.domain.com  ──┤  /api/*         ├──  FastAPI (uvicorn, systemd/pm2)
                    └─────────────────┘
                                                   │
                                                   ▼
                                           MongoDB (local or Atlas)
```

One fewer Node process than the default stack (no Expo API routes to serve). The trade-off: Python's `asyncio` event loop replaces Node's event loop for request handling.

## Anti-Patterns

- **Scaffolding a parallel Expo app when the repo already has a working Next.js app with non-trivial routes** — the "Next.js is optional and only for SSR" framing in this recipe assumes Next.js is being *added* alongside an Expo client, not that you're walking into a repo where Next.js is already the canonical product. If `web/` (or wherever) has a Next.js app with `/cards`, `/decks`, `/admin`, or any routes beyond a landing page, that app **is** the product — add admin/auth/api there as `route.ts` handlers + `app/admin/` pages, and convert RN primitives to HTML/Tailwind. Spinning up a second Expo app duplicates auth, db, components, styling, and node_modules; rebuilding from the wrong starting point cost ~5800 lines and a full afternoon in metamox/. Run the `Pre-install: detect the canonical webapp` procedure at the top of this recipe before writing any new app.
- **Importing `lib/db.ts` from a component or screen file** — the Expo bundler may pull Mongo driver code into the client bundle, leaking credentials and ballooning the bundle. DB access lives in `+api.ts` handlers and worker scripts only.
- **Adding Express or Fastify "for the real API"** — duplicates the HTTP layer you already get from Expo Router, forces a second deploy target, and fragments session/auth helpers across two codebases. If you think you need it, you probably need a worker process instead.
- **Using Next.js API routes as the backend** — splits the API across two frameworks, forces duplicate auth helpers, and locks native clients out of a coherent base URL. The Expo app owns the API; Next.js only renders logged-out pages.
- **Putting authenticated UI in Next.js** — double-implements every screen and hydrates the same React tree in two runtimes. Next.js is the public-site layer; logged-in UX lives in Expo.
- **Running long work inside a `+api.ts` handler via fire-and-forget async** — the Expo web server can tear down the process after the response, dropping the work with no log. Enqueue and return 202.
- **Sharing one root `.env` across Expo and Next.js** — server secrets end up in client bundles. Each Node process gets its own env file, and only `EXPO_PUBLIC_` / `NEXT_PUBLIC_` prefixed values ever ship to clients.
- **Reading sessions via fetch to the Expo API during Next.js SSR** — doubles request latency and ties public-page uptime to Expo API uptime. Next.js reads the `sessions` collection directly.
- **Adding Mongoose "for safety"** — casting and hooks fight the monthly-rotation and aggregation patterns every other skill in this repo assumes. Use the native driver.
- **Splitting services onto multiple EC2 boxes before a real bottleneck exists** — operational cost outweighs any benefit until a single box is measurably saturated. Vertical first.
- **Running MongoDB embedded/in-memory in dev** — index behavior, write concerns, and auth all diverge from prod. Use a real `mongod`.
- **Leaving `web.output` unset (defaults to `"single"`) when using `+api.ts` routes** — every `/api/*` request 404s silently with no terminal error. Set `web.output: "server"` in `app.json` and restart `expo start`.
- **Raw `npm install` for expo-* packages** — pulls versions from the wrong SDK line, breaks `@expo/cli` with `Cannot find module 'expo-router/build/routes-manifest'` and similar. Use `npx expo install` / `npx expo install --fix`; run `npx expo install --check` proactively.
- **Caret-pinned expo-* dependencies** (`"expo-router": "^55.0.11"`) — `^` lets npm drift up past the SDK-compatible line on the next install. Use `~` pinning to stay inside the minor, and let `expo install --fix` reseat the version on SDK bumps.
- **Running `expo start` in a shell with the wrong Node version** — `nvm use 20` in one terminal doesn't affect another. Check `node --version` in the exact shell where expo runs, not the one you just used to install packages.
- **Calling `setColorScheme(...)` without `darkMode: "class"` in `tailwind.config.js`** — NativeWind defaults to `"media"` and throws at the first override. Set the config before you ship any manual theme code.
- **Habitually passing `--clear` / `-c` to `expo start`** — Metro re-materializes the entire module graph into V8's heap on every start, spiking peak footprint to 2–4 GB per app and pushing a 16 GB Mac into swap once two dev servers are up. V8 doesn't hand the pages back when the process goes idle, so the cost is persistent, not transient. Configure `cacheVersion` in `metro.config.js` (see Expo Configuration Gotchas) so Metro auto-busts when meta files change, and reserve `--clear` for actual corruption.
- **Installing standalone Expo apps with raw `npm install` (or unconfigured `yarn`)** — npm's cache stores tarballs, not extracted files, so every project ends up with its own ~1–1.3 GB copy of `react-native` + Expo SDK + Babel + Metro on disk. A few independent apps in one workspace balloon to tens of gigabytes of pure duplication (the Goliath directory hit 60 GB this way). Use `pnpm install` with `node-linker=hoisted` (see Package manager section) so every app's `node_modules` is hardlinked/clonefiled into a single machine-wide store.
- **Using pnpm's default `isolated` linker for Expo apps** — the symlinked `.pnpm/` layout triggers phantom-dependency failures and Metro resolver breakage in the React Native ecosystem, and the fix is a running battle of `public-hoist-pattern` and `shamefully-hoist` tweaks. Set `node-linker=hoisted` in `.npmrc` up front. You still get the store-level dedup.
- **Placing the pnpm store on a different volume from your project repos** — pnpm falls back to *copying* files from the store instead of hardlinking/clonefiling across filesystems, which silently defeats the dedup and leaves you with full-size `node_modules` on every project. Keep projects and `~/Library/pnpm/store` on the same APFS volume, or set `store-dir` per-project to a same-volume path.

## Logging

- **Expo API routes** log to stdout in JSON; pm2 or systemd captures. Include request id, user id (if authed), route, status, duration. A shared `lib/log.ts` helper enforces the shape so every handler logs the same fields.
- **Next.js** logs SSR errors to stdout with the same JSON shape. Client-side errors bubble to a `/api/log+api.ts` endpoint in the Expo app — don't add a third-party SDK just for this.
- **Expo client** uses a thin logger that batches to the API's log endpoint in prod and `console` in dev.
- **Worker** logs per-job: job id, type, duration, outcome. Failures include the full error chain. See `admin-prompt-queue` for the exact shape.
- **MongoDB** slow-query log enabled at `>100ms` in prod. Check it before reaching for application-level tracing.
