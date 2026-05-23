---
name: admin-gcp-deploy
description: >
  Use when setting up the canonical GCP deploy pipeline for a Goliath project
  (Cloud Build → Artifact Registry → Cloud Run, Firestore in MongoDB-compat
  mode, Secret Manager → runtime env). Installs framework-aware deploy
  artifacts (Dockerfile, cloudbuild.yaml, bootstrap script, local→prod sync
  script) plus a superadmin status page at `/platform/deploy` that live-detects which
  one-time human GCP setup tasks are complete and reports automated-task
  progress (or the upstream human task blocking each one).
dependencies:
  requires: [admin-routing]
  capabilities:
    auth: otp-auth
    design-system: admin-only-notus
provides: [deploy]
---

# Admin GCP Deploy

The canonical GCP deploy stack for any Goliath project, plus a live operations dashboard so the operator always knows what's blocking the deploy.

The load-bearing insight: the deploy pipeline is the easy half. The hard half is that **a deploy has multiple actors** — Claude can write a Dockerfile and call gcloud, but only a human can install the Cloud Build GitHub App, click "Enable MongoDB compatibility" in the Firestore console, or paste an API key into Secret Manager. Without a single page that detects which side is currently blocking, every new deploy turns into a Slack thread of "did you do the thing yet?" The status page is the artifact that resolves that.

Reference implementations:
- `goliathdynamics.com/web` (Next.js variant) — original recipe baseline. Files cited inline by path.
- `docpost/docpost-app` (Expo + `+api.ts` variant) — reference for the **dev/prod split column view**, `Check.targets`, `prodEnv.ts` introspection, `ActionLink` outlinks, and `reauthCommands`. Use docpost over goliathdynamics.com when the two diverge on page UX or check shape — the dev/prod split is the canonical form.

**The FastAPI variant of the Dockerfile and route layout is unproven** until first install on a Python project. Treat per-stack template bodies as preliminary on FastAPI; fold the final form back into this recipe after the first FastAPI install converges.

This recipe is the **GCP variant** of the deploy. It diverges from the `stack` recipe's "single EC2 box" default. Use this when the project needs Cloud Run / Firestore / Secret Manager; stay on the EC2 default otherwise.

The page itself lives behind `/platform/deploy` and is **not reachable until the first deploy succeeds**. Until then, the operator watches the Cloud Build console and reads `docs/deploy.md`. After first deploy, `/platform/deploy` becomes the source of truth and `docs/deploy.md` becomes a glossary the page deep-links into.

## The Deploy Pattern (universal across all stacks)

These four invariants apply to every Goliath project regardless of framework. The recipe greps for each at install time and refuses to proceed if any is violated (see Install-Time Audits below).

### 1. MongoDB driver against Firestore's MongoDB-compat endpoint

The native `mongodb` driver is preserved end-to-end. **No `firebase-admin`, no `@google-cloud/firestore`, no schema changes between local and prod.** The only thing that changes is `MONGO_URI`.

Two auth modes; **OIDC is the default for Cloud Run** (no static password, uses the runtime SA's metadata token), SCRAM is the fallback when something outside Cloud Run needs to connect (a sync script on a dev workstation, an ETL job in a different cloud, etc.).

**OIDC (recommended for Cloud Run):**

```
mongodb://<DB_UID>.<REGION>.firestore.goog:443/<DB_NAME>?loadBalanced=true&tls=true&retryWrites=false&authMechanism=MONGODB-OIDC&authMechanismProperties=ENVIRONMENT:gcp,TOKEN_RESOURCE:FIRESTORE
```

- No `<user>:<pass>@` block — auth happens via the metadata server.
- `<DB_UID>` comes from `gcloud firestore databases describe --database=<name> --format='value(uid)'` after creation.
- The runtime SA needs `roles/datastore.user` (already bound by `gcp-bootstrap.sh`).
- Requires `mongodb` driver ≥ 6.0 (OIDC support landed in v6).

**SCRAM (fallback for non-Cloud-Run callers):**

```
mongodb://<user>:<pass>@<DB_UID>.<REGION>.firestore.goog:443/<DB_NAME>?loadBalanced=true&tls=true&authMechanism=SCRAM-SHA-256&retryWrites=false
```

The user/password come from `gcloud firestore user-creds create <user> --database=<name>` — the password is returned exactly once, capture it immediately. Then `gcloud projects add-iam-policy-binding <project> --member='principal://firestore.googleapis.com/projects/<PROJECT_NUMBER>/name/databases/<DB>/userCreds/<user>' --role=roles/datastore.user`.

**Both shapes share these required query params** (each one load-bearing, not optional):

- `:443` (HTTPS port, not 27017)
- `loadBalanced=true`
- `tls=true`
- `retryWrites=false` — **most-skipped requirement**; omitting it produces cryptic per-write failures because Firestore rejects Mongo's retryable-writes protocol

**Why:** Firestore's MongoDB-compat mode lets the entire codebase (driver, `ObjectId`, `bulkWrite`, `createIndex` calls) work unchanged in prod. Switching to the native Firestore SDK would force a parallel data-access layer for prod-only code paths and break local-dev parity. See `goliathdynamics.com/web/src/lib/mongo.ts` and `web/scripts/sync-local-to-firestore.mjs` for the full pattern.

The `audit-mongo-uri-shape` check accepts both forms — match on the shared required params, not on the auth mechanism.

### 2. Secret Manager → Cloud Run env (build-time vs runtime split)

All runtime secrets live in **GCP Secret Manager** and mount as env vars on the Cloud Run service. The runtime service account holds `roles/secretmanager.secretAccessor`, separate from the build SA.

**Build-time vs runtime is the recurring foot-gun:** anything `NEXT_PUBLIC_*` (Next.js) or `EXPO_PUBLIC_*` (Expo) gets baked into the bundle at build time, so it must be passed as a **Cloud Build substitution**, not a Cloud Run runtime env mount. A runtime-only mount silently produces stale or undefined values in the client bundle. Server-only secrets (`MONGO_URI`, API keys) go the other way — runtime mount only, never build args, or they bake into the container image.

**Why:** This split is invisible until prod traffic hits a client-bundle code path that reads `NEXT_PUBLIC_SITE_URL` and gets `undefined`. The recipe enforces the split by giving each variable exactly one home in the env-var matrix.

### 3. Fail-secure auth bypass

Every Goliath app gates admin surfaces with `LOCALHOST_AUTH_BYPASS`. The check **must** be:

```ts
const bypass = process.env.LOCALHOST_AUTH_BYPASS === "true";
```

…never the inverted `!== "false"` form, which defaults to bypass-on whenever the env var is unset. In prod the var is **explicitly absent** on the Cloud Run service — not set to `"false"`, not set to anything. The runtime check on the status page verifies absence, not just falsy.

**Why:** `!== "false"` means a fresh Cloud Run deploy with no env config = open admin to the world. The recipe greps the auth gate at install and **fails the install** if the check is inverted; that's a security bug, not a fit issue. See `goliathdynamics.com/web/src/middleware.ts:28` and `web/src/lib/auth.ts:91` for the canonical form.

### 4. Cloud Build (GitHub `main`) → Artifact Registry → Cloud Run

One trigger on `^main$`, one Dockerfile per stack template, one `cloudbuild.yaml`. No staging environment by default — promote-via-tag or branch can be added later, but a fresh project ships with one prod target. The Dockerfile and cloudbuild.yaml are **checked into the repo** — not configured inline in the trigger console — so the build is reproducible and code-reviewable.

## File Map

What the recipe drops into the target project:

```
<project>/
  Dockerfile                              ← from templates/Dockerfile.<stack>
  cloudbuild.yaml                         ← from templates/cloudbuild.yaml
  .dockerignore
  .env.prod.example                       ← generated by env-scan audit
  scripts/
    gcp-bootstrap.sh                      ← idempotent gcloud setup
    sync-local-to-firestore.mjs           ← lifted from reference impl
  app/(or src/app)/platform/deploy/
    index.tsx                             ← status page UI
  app/api/platform/deploy/
    status+api.ts (Expo)                  ← status check API endpoint
    status/route.ts (Next.js)
  src/lib/deploy/
    checks/
      registry.ts                         ← canonical check list
      gcp.ts                              ← GCP API checks
      dns.ts                              ← DNS resolution checks
      audit.ts                            ← code-grep checks
      runtime.ts                          ← env / process checks
    statusCache.ts                        ← server-side memo
  docs/
    deploy.md                             ← human runbook (linked from status page)
```

## Install-Time Audits

Before writing any file, the recipe runs these checks against the existing codebase. **Any failure stops the install** with a precise diff target — fix the underlying issue, then re-run.

Each audit is a literal grep with a documented pass/fail condition:

| Audit | Grep | Pass condition |
|---|---|---|
| `auth-bypass-fail-secure` | `rg -n 'LOCALHOST_AUTH_BYPASS' src/ app/` | Every match is `=== "true"` form. Any `!== "false"` / `!= "false"` / default-truthy form fails the audit. |
| `no-firestore-sdk` | `rg -n "from ['\"]firebase-admin['\"]\|from ['\"]@google-cloud/firestore['\"]\|from ['\"]firebase['\"]" src/ app/` | Zero matches. |
| `no-localhost-literal` | `rg -n "mongodb://localhost" src/ app/ scripts/` | Zero matches outside `*.example` files. |
| `env-via-process-env` | `rg -n "from ['\"]dotenv['\"]\|require\(['\"]dotenv['\"]\)\|\.env\.prod" src/ app/` | Zero matches in source (script-level dotenv loading in `scripts/` is allowed). |
| `cookie-secure-prod` | `rg -n 'Secure\|secure:' src/lib/auth*.ts src/lib/session*.ts app/lib/auth*.ts` | The Secure flag (or `secure: true` cookie option) is gated on `process.env.NODE_ENV === "production"`. |
| `mongo-driver-present` | `jq -r '.dependencies.mongodb' package.json` | Returns a version string (not `null`). |

The audits emit a single report; the operator fixes the surfaced issues and re-runs. **The recipe does not auto-fix audit failures** — they're either security bugs or architectural mismatches, both of which need human review.

### `.env.prod.example` generation

After the audits pass, the recipe generates `.env.prod.example` by scanning the codebase for env-var references and emitting one stub per variable it finds.

Scan rules (executed in this order):

1. `rg -no "process\.env\.([A-Z][A-Z0-9_]+)" src/ app/ scripts/ -r '$1' | sort -u` — every `process.env.X` in source.
2. Filter out development-only vars: `NODE_ENV`, `NEXT_PHASE`, `NEXT_DEV_*`, `NEXT_PUBLIC_VERCEL_*`, `npm_*`, `__NEXT_*`. Configurable via `.deploy-spec.yaml` `envScanIgnore`.
3. Group into **build-time** (matches `^NEXT_PUBLIC_` / `^EXPO_PUBLIC_`) vs **runtime** (everything else).
4. Emit `.env.prod.example` with a comment header listing which group each var belongs to:

```
# Build-time (Cloud Build substitutions, baked into bundle):
NEXT_PUBLIC_SITE_URL=https://www.<domain>

# Runtime (Cloud Run env from Secret Manager — values pasted by operator):
MONGO_URI=
GEMINI_API_KEY=
AMAZON_SES_ACCESS_KEY_ID=
AMAZON_SES_SECRET_ACCESS_KEY=
AMAZON_SES_REGION=us-east-1
AMAZON_SES_FROM=
LOCALHOST_AUTH_BYPASS=        # MUST stay empty in prod — see fail-secure invariant
```

`LOCALHOST_AUTH_BYPASS` is always emitted with an empty value and the comment, even if the codebase doesn't read it (it's a deploy-pattern invariant, not a per-project var).

**Do NOT hand-add aspirational secrets** (secrets for features the codebase doesn't currently reference). Bootstrap creates a stub for every entry in `.env.prod.example`, and `secrets-populated` then blocks deploy until each stub has a value. A token for a feature that doesn't exist yet means "deploy is permanently failing on a phantom secret." When a feature lands, the env-scan re-run will pick it up — that's the right time to add it. If you have to add it manually, also wire the *code* that reads it in the same change.

## Bootstrap

`scripts/gcp-bootstrap.sh` is idempotent. Run it any number of times; it creates what's missing and leaves the rest alone.

What it does, in order:

1. Enable APIs: `cloudbuild.googleapis.com`, `run.googleapis.com`, `firestore.googleapis.com`, `secretmanager.googleapis.com`, `artifactregistry.googleapis.com`, `iam.googleapis.com`, `compute.googleapis.com`
2. Create Artifact Registry repo `<project>-images` in `${REGION}`
3. Create runtime service account `<project>-runtime@`
4. Create build service account `<project>-build@` (separate from default Cloud Build SA so least-privilege is explicit)
5. Bind IAM:
   - Runtime SA: `roles/secretmanager.secretAccessor`, `roles/datastore.user`
   - Build SA: `roles/run.admin`, `roles/iam.serviceAccountUser`, `roles/artifactregistry.writer`, `roles/secretmanager.secretAccessor` (so build can pull build-time public vars)
6. Create empty Secret Manager entries for each var in `.env.prod.example` (values populated separately, by the human)
7. Read-only roles for the runtime SA so the status page can introspect deploy state: `roles/run.viewer`, `roles/cloudbuild.viewer`, `roles/secretmanager.viewer`
8. Create the Cloud Build trigger pointing at `^main$` once the repo is connected (skips with a warning if the GitHub App isn't installed yet)

The script must be run **after** the human creates the GCP project and links billing — it cannot do those itself.

## Firestore Setup (MongoDB-compat)

`gcp-bootstrap.sh` enables `firestore.googleapis.com` but does NOT create the database — database creation is one-shot and irreversible (location is immutable, edition is immutable), so it's a deliberate operator step rather than a bootstrap side effect.

### Create the database

```bash
gcloud firestore databases create \
  --project=<project> \
  --database=<project> \
  --location=<region> \
  --edition=enterprise \
  --enable-mongodb-compatible-data-access \
  --delete-protection
```

Required flag pairing: `--edition=enterprise` AND `--enable-mongodb-compatible-data-access` together — MongoDB-compatibility only exists on the Enterprise edition. Status: **GA** as of 2025.

- **`--database=<project>`** — use the same token as the GCP project ID and Cloud Run service name. One name everywhere.
- **`--location=<region>`** — match the Cloud Run region exactly (us-east4, us-central1, etc.). Same-region traffic is free; cross-region adds egress. Location is **immutable after creation**.
- **`--delete-protection`** — leave on. Removing it later is a one-line gcloud call when you actually want to delete.

### Wire up MONGO_URI

After creation, grab the assigned UID:

```bash
DB_UID=$(gcloud firestore databases describe \
  --database=<project> --project=<project> \
  --format='value(uid)')
```

Then assemble the OIDC URI per "MongoDB driver against Firestore's MongoDB-compat endpoint" above and push to Secret Manager:

```bash
printf 'mongodb://%s.<region>.firestore.goog:443/<project>?loadBalanced=true&tls=true&retryWrites=false&authMechanism=MONGODB-OIDC&authMechanismProperties=ENVIRONMENT:gcp,TOKEN_RESOURCE:FIRESTORE' "$DB_UID" \
  | gcloud secrets versions add MONGO_URI --data-file=- --project=<project>

printf '<project>' | gcloud secrets versions add MONGO_DB --data-file=- --project=<project>
```

No DB user creation needed for OIDC — the runtime SA already holds `roles/datastore.user` from `gcp-bootstrap.sh`.

### Why OIDC, not SCRAM, for the default

- **No rotating password** — SCRAM passwords are returned exactly once by `user-creds create` and must be re-rotated to recover from loss. OIDC has no shared secret to rotate.
- **No password in Secret Manager** — fewer values to populate, fewer values that can leak.
- **Same identity as everything else** — Cloud Logging, Cloud Trace, Cloud Run audit logs all attribute database access to `<service>-runtime@`. With SCRAM the audit trail attributes to the synthetic Firestore user instead.

SCRAM is right when the caller doesn't have GCP IAM — e.g., a dev workstation script that connects without ADC, or a third-party ETL service. Cover those cases with a SCRAM user *in addition to* the default OIDC path, not instead of it.

### Verification

The `firestore-online/prod` check pings the URI via `db.runCommand({ping:1})`. From dev it returns `unknown` (dev has no OIDC token to present); once first deploy lands and the Cloud Run service can introspect itself, the check resolves.

## Cloud Build + Dockerfile

`cloudbuild.yaml` is identical across stacks; only the substitutions differ:

```yaml
substitutions:
  _REGION: us-east4
  _SERVICE: <project>
  _REPO: <project>-images
  _PUBLIC_SITE_HOST: https://www.<domain>     # build-time public env (also surfaced as runtime env for prodEnv.prodHost())

steps:
  - name: gcr.io/cloud-builders/docker
    args:
      - build
      - --build-arg=PUBLIC_SITE_HOST=${_PUBLIC_SITE_HOST}
      - -t=${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO}/${_SERVICE}:$SHORT_SHA
      - .
  - name: gcr.io/cloud-builders/docker
    args: [push, "${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO}/${_SERVICE}:$SHORT_SHA"]
  - name: gcr.io/google.com/cloudsdktool/cloud-sdk
    entrypoint: gcloud
    args:
      - run
      - deploy
      - ${_SERVICE}
      - --image=${_REGION}-docker.pkg.dev/$PROJECT_ID/${_REPO}/${_SERVICE}:$SHORT_SHA
      - --region=${_REGION}
      - --service-account=${_SERVICE}-runtime@$PROJECT_ID.iam.gserviceaccount.com
      - --update-secrets=MONGO_URI=MONGO_URI:latest,MONGO_DB=MONGO_DB:latest,GEMINI_API_KEY=GEMINI_API_KEY:latest    # extend per project
      # Non-secret config — needed by the deploy-status page so the running
      # service can introspect itself (project id, region, service name, host)
      # without relying on metadata-server lookups for everything.
      - --update-env-vars=GCP_PROJECT=$PROJECT_ID,GCP_REGION=${_REGION},GCP_SERVICE=${_SERVICE},NEXT_PUBLIC_SITE_HOST=${_PUBLIC_SITE_HOST}
      - --min-instances=1
      - --allow-unauthenticated
options:
  logging: CLOUD_LOGGING_ONLY
```

**Substitution naming is load-bearing**: the build-arg name (`PUBLIC_SITE_HOST`), the cloudbuild substitution key (`_PUBLIC_SITE_HOST`), and the runtime env var (`NEXT_PUBLIC_SITE_HOST`) must all align with what `prodEnv.ts` reads. Mismatches (e.g., cloudbuild substitution named `_PUBLIC_SITE_URL` while `prodEnv.ts` reads `_PUBLIC_SITE_HOST`) produce silent "prod hostname not configured" failures with no obvious cause.

Dockerfile templates ship per stack. Each follows the same shape — multi-stage build, non-root runtime, healthcheck endpoint at `GET /healthz` returning 200, `PORT` env honored, no secrets in the image:

- **`Dockerfile.nextjs`** — assumes `output: "standalone"` in `next.config.mjs`. Build stage runs `next build`, runtime stage copies `.next/standalone` + `.next/static` + `public/` and runs `node server.js`. Build args: `PUBLIC_SITE_HOST` (and any other `NEXT_PUBLIC_*`). Runtime user: `node` (Debian image's built-in).

  **Workspace check before generating the deps stage.** Many Goliath repos have root `package.json` that delegates to `web/` via `pnpm --dir web …` but are NOT pnpm workspaces (no `pnpm-workspace.yaml`, no `workspaces` field). On those, `pnpm install --filter ./web...` fails at build time with `ERR_PNPM_NO_LOCKFILE` because the filter expects a workspace. Detect at recipe install time:

  ```bash
  if [[ -f pnpm-workspace.yaml ]] || jq -e '.workspaces' package.json >/dev/null 2>&1; then
    # workspace — single install at root covers /web
    DEPS_INSTALL='RUN pnpm install --frozen-lockfile --filter ./web...'
    DEPS_COPY='COPY package.json pnpm-lock.yaml ./\nCOPY web/package.json web/'
  else
    # independent root + web pnpm projects — install each
    DEPS_INSTALL='RUN pnpm install --frozen-lockfile && pnpm --dir web install --frozen-lockfile'
    DEPS_COPY='COPY package.json pnpm-lock.yaml ./\nCOPY web/package.json web/pnpm-lock.yaml web/'
  fi
  ```

  Whichever variant is emitted, the builder stage's `COPY --from=deps` lines stay the same (both shapes write `/app/node_modules` and `/app/web/node_modules`).
- **`Dockerfile.expo`** — assumes Expo Router app with `+api.ts` routes. Build stage runs `expo export --platform web`, runtime stage runs the Expo Node server (`npx expo start --no-dev --minify` is wrong here — production serves the exported bundle through a Node entrypoint; pin the exact entrypoint when first installing on docpost). Build args: `EXPO_PUBLIC_*` set.
- **`Dockerfile.fastapi`** — assumes `pyproject.toml` with `uvicorn` and the app module declared. Build stage installs deps via `pip install --no-cache-dir`. Runtime: `uvicorn ${APP_MODULE} --host 0.0.0.0 --port ${PORT:-8080}`. No build args (Python doesn't have a build-time public-env equivalent).

**The literal contents of these Dockerfiles are not yet pinned in this recipe** — Next.js will be set after the first goliathdynamics.com install converges; Expo will be set after docpost; FastAPI after the first Python project. Until then, each install lifts the closest matching Dockerfile from a Goliath project, validates against the four invariants above, and folds the final form back into this recipe.

## Initial Data Sync

`scripts/sync-local-to-firestore.mjs` is lifted directly from `goliathdynamics.com/web/scripts/sync-local-to-firestore.mjs` (already generic — reads `MONGO_URI` from `.env.local` source and `.env.prod` target, bulk-upserts every collection by `_id`, tolerant of per-doc Firestore rejections via `ordered: false`).

Usage at first deploy:

```bash
node scripts/sync-local-to-firestore.mjs            # all collections
node scripts/sync-local-to-firestore.mjs --dry-run  # read-only preview
node scripts/sync-local-to-firestore.mjs --drop     # nuke target first
```

The script writes a `_deploy_meta` doc in the target with `synced_at: <timestamp>`. The status page reads this to detect "initial sync done."

## Platform Deploy Status Page

Lives at `/platform/deploy` per the `admin-routing` skill's URL grammar (platform-wide pages live under `/platform/**`). **Superadmin-only** — gated by the platform auth layout *and* an in-page `requireRole("superadmin")` check (the page exposes secret/IAM state and one-shot rerun controls; admin/operator/viewer roles never see it, and the link is omitted from the platform sidebar for non-superadmins). The role-check helper is provided by `otp-auth` (TS variant: `requireRole(req, "superadmin")` from `lib/auth.ts`; FastAPI variant: `require_permission("deploy:read")` per `otp-auth`'s RBAC). One card per check, grouped by category, sortable by status, with a status banner at the top summarizing overall deploy health.

### Check registry shape

Every check is a registered object with this exact contract:

```ts
type CheckStatus =
  | "pass"          // ✅ verified working
  | "fail"          // ❌ needs attention
  | "pending"       // ⏳ blocked on an upstream check
  | "warning"       // ⚠️ passed with a caveat
  | "unknown"       // ❓ detector itself failed — infra error only, never "not configured"
  | "security-fail";// 🚨 invariant violated; loud red banner

type DeployEnv = "dev" | "prod";

/** Action surfaced on a check card.
 *  - External (`href`): outlink to a console, opens in new tab.
 *  - Internal (`endpoint` + `payload`): POST to one of our routes; the card
 *    renders as a "do it" button and re-fetches status after the POST. */
type ActionLink = {
  label: string;
  href?: string;                              // mutually exclusive with endpoint
  endpoint?: string;                          // POST target on our own API
  payload?: Record<string, unknown>;
  confirm?: string;                           // confirm prompt before firing
};

type DetectResult = {
  status: CheckStatus;
  detail?: string;                            // one-line plain text
  actions?: ActionLink[];                     // per-card outlinks / do-it buttons
  reauthCommands?: string[];                  // shell commands the human runs locally
                                              // (e.g. `gcloud auth login --update-adc`)
                                              // Server can't run these; rendered as a
                                              // copyable code block on the card.
  lastChecked: string;                        // ISO timestamp
};

type Check = {
  id: string;                                 // stable, kebab-case
  name: string;                               // human label
  category: "human" | "automatic" | "audit" | "runtime";
  /** Environments this check applies to. Default: both ['dev', 'prod']. */
  targets?: DeployEnv[];
  dependsOn?: string[];                       // other check ids; if any (target-matched)
                                              // dep is fail/pending/security-fail, this
                                              // is cascaded as pending (or fail if upstream
                                              // was a hard fail — see "Cascade rule").
  /** Detector receives the target it should evaluate. Same check id can run twice in dev:
   *  once for target='dev' and once for target='prod' (the second introspects live prod
   *  state via prodEnv.ts). */
  detect: (target: DeployEnv) => Promise<DetectResult>;
  /** Always-relevant outlinks. Surfaced on cascade-blocked cards so the operator can still
   *  click through to the right console even when detect didn't run. */
  defaultActions?: ActionLink[];
  cacheTtlSeconds?: number;                   // default 30 (deploying), 3600 (deployed)
  noCache?: boolean;                          // security-invariant checks set this to true
};

// Registry API — all helpers live in src/lib/deploy/checks/registry.ts
export function registerCheck(check: Check): void;
export function registerIntegration(spec: IntegrationSpec): void;  // wraps registerCheck for each spec.checks entry
export function getRegisteredChecks(): Check[];
export function clearRegistry(): void;        // tests only

/** Decides which environment the page itself is running in. The running env
 *  determines whether the dev column is rendered alongside prod.
 *  - On Cloud Run with NODE_ENV=production → 'prod'
 *  - Anywhere else → 'dev' */
export function detectRunningEnv(): DeployEnv;
```

**Registry initialization order (load-bearing):**

1. `src/lib/deploy/checks/registry.ts` — module exports above; module-scope state holds the registered list.
2. `src/lib/deploy/checks/canonical.ts` — imports `registerCheck` and registers every entry from the Canonical Checks tables below. Imported eagerly by the registry barrel.
3. `src/lib/deploy/checks/integrations/<name>.ts` — one file per detected integration, calls `registerIntegration(...)` at module scope. Imported by an `index.ts` barrel that the integration-detector generates at install time based on `.deploy-spec.yaml`.
4. The status API endpoint imports the barrel to ensure all registrations have run before the first request.

This order guarantees every status response sees a complete registry — no race between request handler and lazy module loading.

### Canonical checks (every project gets these)

**Human tasks** (page detects whether the human has done them):

| id | what it checks | how |
|---|---|---|
| `gcp-project-billing` | Project exists, billing linked | Any GCP API call from runtime SA returns 200 (not "billing not enabled") |
| `firestore-online` | Firestore created in MongoDB-compat mode, user exists | Connect via `MONGO_URI`, run `db.runCommand({ping:1})` |
| `cloudbuild-github-connected` | Cloud Build GitHub App installed, repo connected | Cloud Build API: list triggers; expect ≥1 pointing at this repo |
| `domain-verified` | Custom domain verified + Cloud Run mapping `READY` | Cloud Run API: domain mapping resource state |
| `dns-records-published` | All required DNS records resolve correctly | DNS lookup for the prod hostname (A/AAAA/CNAME) |
| `ssl-cert-active` | Managed SSL cert is `ACTIVE` | TLS handshake to prod URL with valid cert chain |

**Automated tasks** (page tracks pipeline state):

| id | what it checks | how | dependsOn |
|---|---|---|---|
| `bootstrap-ran` | `gcp-bootstrap.sh` has run | Required SAs and AR repo exist | `gcp-project-billing` |
| `secrets-populated` | Every entry in env-matrix has a non-empty value in Secret Manager | Secret Manager API: list versions per secret | `bootstrap-ran` |
| `initial-data-sync` | First-time data sync ran | `_deploy_meta.synced_at` exists in Firestore | `firestore-online` |
| `first-deploy-succeeded` | Cloud Run service has at least one healthy revision | Cloud Run API: revision status | `bootstrap-ran`, `cloudbuild-github-connected`, `secrets-populated` |
| `last-build-status` | Most recent Cloud Build for `main` succeeded | Cloud Build API: list builds, filter by trigger | `cloudbuild-github-connected` |

**Runtime invariants** (page asserts these continuously, regardless of human/auto status):

| id | what it checks | how | severity if failed |
|---|---|---|---|
| `auth-bypass-off-in-prod` | `LOCALHOST_AUTH_BYPASS` is unset (not just "false") when `NODE_ENV === "production"` | Read `process.env` from runtime | **`security-fail`** (red banner) |
| `cookie-secure-prod` | Session cookie sent with `Secure` flag in prod | Inspect outgoing `Set-Cookie` header on a probe request | **`security-fail`** |

Workers used to live here (`worker-running` + `min-instances-when-worker`). They're gone: the recipe no longer assumes an in-process worker. Long-running work fans out via Cloud Tasks → Cloud Run handlers driven by Cloud Scheduler. Liveness of those scheduled fires is visible in Cloud Scheduler + Cloud Logging, not on this page. Projects that *do* still run an in-process worker can re-add the pair locally; the registry is open.

**Code audits** (re-run from runtime, in case someone reverted a recipe-time fix):

| id | what it checks | severity if failed |
|---|---|---|
| `audit-no-firestore-sdk` | No `firebase-admin`/`@google-cloud/firestore` in installed deps | `fail` |
| `audit-mongo-uri-shape` | `MONGO_URI` includes the four required query params | `fail` |

### Status API contract

`GET /api/platform/deploy/status` (Next.js: `app/api/platform/deploy/status/route.ts`; Expo: `app/api/platform/deploy/status+api.ts`).

**Query params:**
- `?fresh=1` — bypass server-side cache for this request only.

**Response shape (literal):**

```jsonc
{
  "overall": "pending",
  "mode": "deploying",
  "runningEnv": "dev",
  "generatedAt": "2026-04-27T18:42:11.123Z",
  "checks": [
    {
      "id": "auth-bypass-off-in-prod",
      "name": "LOCALHOST_AUTH_BYPASS unset in prod",
      "category": "runtime",
      "target": "prod",
      "status": "pass",
      "detail": "env var is unset; NODE_ENV=production",
      "actions": [
        { "label": "Cloud Run env", "href": "https://console.cloud.google.com/run/detail/..." }
      ],
      "lastChecked": "2026-04-27T18:42:11.118Z",
      "cached": false
    },
    {
      "id": "firestore-online",
      "name": "Firestore (MongoDB-compat) reachable",
      "category": "human",
      "target": "prod",
      "status": "fail",
      "detail": "ping failed: connection refused — confirm MONGO_URI host and credentials",
      "reauthCommands": ["gcloud auth login --update-adc"],
      "lastChecked": "2026-04-27T18:42:09.840Z",
      "cached": true
    },
    {
      "id": "first-deploy-succeeded",
      "name": "First Cloud Run deploy",
      "category": "automatic",
      "target": "prod",
      "status": "pending",
      "detail": "blocked on: firestore-online, secrets-populated",
      "blockedBy": ["firestore-online", "secrets-populated"],
      "actions": [
        { "label": "Cloud Run console", "href": "https://console.cloud.google.com/run" }
      ],
      "lastChecked": "2026-04-27T18:42:11.121Z",
      "cached": false
    }
  ]
}
```

Fields:
- `overall` — worst status in the graph: `security-fail` > `fail` > `warning` > `pending` > `unknown` > `pass`.
- `mode` — `"deploying"` or `"deployed"` per the polling-cadence rules; the page reads this to set its foreground poll interval.
- `runningEnv` — `"dev"` or `"prod"`, set by `detectRunningEnv()`. The page uses this to decide between split-column (dev) or single-column (prod) layout.
- `target` (per-check) — which environment this result is *for*. On dev, the same check id appears once per `target` it declares; on prod, only `target: "prod"` results are returned.
- `cached` — true when this check returned a memoized result (i.e., `detect()` did not run on this request).
- `actions` — outlinks rendered as buttons on the card. Always shown when present, including on `pending`/cascade-blocked cards (via the check's `defaultActions`) so the operator can still click through.
- `reauthCommands` — shell commands the operator runs locally to recover (expired gcloud auth, etc.). Surfaced as a copy-pasteable code block on the card. Server can't run these — only the human at a browser can complete OAuth.
- `blockedBy` — present only on `pending` checks; the upstream check ids that caused the skip.

**Server-side flow:**

1. Resolve dependency graph (DAG of `dependsOn`).
2. Determine `runningEnv` via `detectRunningEnv()`.
3. For each check, in topological order, **for each target in `effectiveTargets(check, runningEnv)`**:
   - `effectiveTargets` returns `['prod']` if running on prod; otherwise returns whatever the check declared in `targets` (default both).
   - **Cascade rule**: if any `dependsOn` is `fail` / `pending` / `security-fail` for the same target (falling back to `prod` if no same-target result exists), mark this check `pending` without running its detector; populate `blockedBy`. If the upstream was a *hard* `fail` (not pending), surface this one as `fail` too — "blocked due to failure is also a failure."
   - Otherwise consult the cache (keyed by `id::target`); if hit and not `?fresh=1`, use cached result with `cached: true`. Else run `detect(target)` and store the result.
4. Compute `overall` and `mode`. Mode is `"deployed"` iff every prod-target deploy-gate check is `pass`.

**Cache backing:** in-memory per Cloud Run instance (a plain `Map<string, {result, expiresAt}>`), keyed by `${id}::${target}` so dev and prod results don't collide. With `min-instances=1` and typical concurrency, cache hit rate is good enough; cross-instance duplication is acceptable cost for not pulling in Redis. Do not back the cache with Firestore — that adds a write per check per TTL window for no operator-visible benefit.

### Page rendering rules

**Layout:**
- **On dev**: two columns side by side, "dev" on the left and "prod" on the right. Each column renders only the checks whose `target` matches that column. Checks declared on both targets appear in both columns (one card per target).
- **On prod**: a single column rendering only the `target: "prod"` results. The dev column is omitted entirely; there is no "this Cloud Run instance has a local mongod" thing to surface.

**Buckets within each column** (collapse the four `category` slices into three operator-facing buckets; the original `category` is preserved on the wire for filtering / debugging):
- **Security** — any check whose `status === "security-fail"`, regardless of category. Pinned to the top of its column.
- **Human Tasks** — `category === "human"`.
- **Automated** — `category` in `{"automatic", "runtime", "audit"}`. Operators don't meaningfully distinguish these.

Within a bucket, sort by status (failures first), then by id alphabetically.

**Each card shows:** name, status badge, one-line detail, last-checked-at relative time, `actions[]` rendered as outlink buttons (`href`) and "do it" buttons (`endpoint` POST). When `reauthCommands` are present, render them as a copy-pasteable code block. A `pending` card explicitly names the upstream blocker(s) (`"Blocked on: gcp-project-billing"`).

**Top banner:** green "Deploy healthy" / yellow "N tasks pending" / red "N failures". Red **sticky** banner "Security invariant violated" appears when any check is `security-fail` and contains a "Recheck now" button.

**Component bindings** (per `admin-only-notus`):
- Top banner — full-width Notus alert; sticky position uses `position: fixed; top: 0; left: 0; right: 0; z-index: 9999` (the canonical pattern, not `absolute` inside an overflow container)
- Cards — Notus card surface with the paired status badge for the check status (red/yellow/blue/green per the design system's badge palette)
- "Recheck now" buttons — Notus button variant `light` for per-card, variant `danger` for the banner-level button
- Last-checked time — relative ("2m ago"), updated client-side every 10s without re-fetching

**Failure modes for the page itself:**
- If the status API itself errors (5xx), render a single full-width red banner "Status API unreachable — view Cloud Logging" with the timestamp of the last successful response, and keep last-known cards visible (greyed). Do not blank the page.
- If every check returns `unknown`, that's almost always a missing GCP IAM binding — show a one-card explainer "Runtime SA missing read roles; rerun gcp-bootstrap.sh" linking to `docs/deploy.md#bootstrap-iam`.

### Dev vs prod columns

The deploy page is **two columns when running on dev** (dev | prod, side by side) and **a single prod column when running on prod**. This is the canonical UX — surface dev-side and prod-side state simultaneously so the operator can see both without context-switching. `detectRunningEnv()` decides which layout to render; `runChecks.ts` fans each `Check` out into one result per declared `target` and the page groups by `(category, target)`.

**Why two columns on dev specifically:**

- The operator's workflow is: edit on dev → push → observe on prod. They want both states visible at once.
- Many checks naturally pair across envs: "dev mongo reachable" / "prod Firestore reachable"; "dev .env.local has GEMINI_API_KEY" / "prod Secret Manager has GEMINI_API_KEY". Showing them in adjacent columns makes mismatches obvious.
- On prod itself the dev column is irrelevant (there is no "this Cloud Run instance's localhost mongo"). Single column avoids the empty / always-failing cells.

**Per-check `targets` declaration:**

A check declares which environments it applies to via `targets?: DeployEnv[]`. Default: `['dev', 'prod']` (both). When the page runs on dev, the check fires once per declared target; when it runs on prod, only the `prod` evaluation runs.

```ts
// Pure dev check: nothing to check on prod (Cloud Run has no .env.local file).
registerCheck({
  id: 'env-local-mongo-uri-shape',
  name: 'MONGO_URI in .env.local matches local mongod',
  category: 'audit',
  targets: ['dev'],
  detect: async () => { /* read .env.local, compare to local mongod */ },
});

// Pure prod check: nothing to check on dev (no Cloud Run service exists locally).
registerCheck({
  id: 'first-deploy-succeeded',
  name: 'First Cloud Run deploy succeeded',
  category: 'automatic',
  targets: ['prod'],
  detect: async () => { /* Cloud Run API: revision status */ },
});

// Both-target check: same probe shape, different data source per target.
registerCheck({
  id: 'mongo-reachable',
  name: 'Mongo reachable',
  category: 'human',
  targets: ['dev', 'prod'],
  detect: async (target) => {
    if (target === 'dev') {
      // ping local mongod via process.env.MONGO_URI
    } else {
      // ping Firestore via prod MONGO_URI resolved from prodEnv.getProdService()
    }
  },
});
```

**`prodEnv.ts` — dev introspection of live prod:**

To make the prod column meaningful on dev, the page needs to read live prod state without operator-side hand-waving. The recipe ships `src/lib/deploy/prodEnv.ts` (reference: [docpost/docpost-app/lib/deploy/prodEnv.ts](../../docpost/docpost-app/lib/deploy/prodEnv.ts)) which:

1. Resolves an access token via a three-step chain:
   - **On Cloud Run**: metadata server (`http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token`) returns the runtime SA token. Path used in prod.
   - **On dev**: prefers `gcloud auth print-access-token` (operator's session, typically broader IAM than ADC) and falls back to `google-auth-library` ADC (`gcloud auth application-default login` or `GOOGLE_APPLICATION_CREDENTIALS`).
   - Tokens cached ~5 min per process.
2. Wraps that token into `gcpFetch(path)` / `gcpPost(path, body)` helpers that any check detector can call to introspect prod from dev.
3. Exposes `getProdService()` returning the live Cloud Run service config (env vars including literal vs. secret-ref bindings, min-instances, image, latest revision, ready state). Cached 30s per process.
4. Reads `cloudbuild.yaml` substitutions (`_FOO: bar`) for non-secret runtime config that's committed to the repo. `cloudbuildSub('_PUBLIC_SITE_HOST')` is the single canonical resolver for the prod hostname.
5. Exposes `clearProdEnvCache()`. **`runChecks` MUST call this when the request bypasses cache** (`?fresh=1` or `?only=<id>`). Otherwise the operator runs `gcloud auth login --update-adc`, clicks Recheck, and gets the old result back from the 5-min token cache (or the 30-sec service cache) — making reauth look like it did nothing. The status cache being bypassed is *not enough*; the prod-env caches sit a layer deeper and need their own invalidation.

**Dev needs these env vars in `.env.local`** for prod-side checks to do anything useful — without them the prod column short-circuits with "project ID unknown" before auth even runs:

```
GCP_PROJECT=<project>
GCP_REGION=<region>
GCP_SERVICE=<project>
NEXT_PUBLIC_SITE_HOST=https://www.<domain>
```

These mirror what `cloudbuild.yaml`'s `--update-env-vars` sets on the deployed service, so the same `prodEnv.ts` resolver works in both environments.

**When to emit `reauthCommands`:** only when the failure *actually is* an auth failure — not on every `unknown`. The reauth advice is misleading when surfaced on:

- `403` with response body `"has not been used in project ... or it is disabled"` — that's "API not enabled", fix is `gcloud services enable …`.
- `403` with response body `"permission denied"` — that's IAM, fix is a role binding (often runtime SA missing `roles/<thing>.viewer`).
- `404` — resource doesn't exist; fix is to create it.
- "project ID unknown" — env var missing, not auth.

The check helper that converts a GCP `Response` to a detail string MUST read `error.message` from the body and surface it (and ideally categorize): the deploy-status page's UX collapses when "API disabled" is indistinguishable from "permission denied". Emit `reauthCommands` only on `401`, on token-fetch failure (no token at all), and on `403` with no body or with a body that mentions tokens/credentials.

The page never tries to refresh OAuth on the operator's behalf — only a browser can complete that flow.

**Detection of running env:**

```ts
export function detectRunningEnv(): DeployEnv {
  // On Cloud Run, K_SERVICE is always set by the runtime.
  if (process.env.NODE_ENV === 'production' && process.env.K_SERVICE) return 'prod';
  return 'dev';
}
```

`NODE_ENV === 'production'` alone is *not* sufficient — `next build` runs with `NODE_ENV=production` locally during release builds, but that's still dev for our purposes. The `K_SERVICE` env var is the load-bearing signal: only the Cloud Run runtime sets it.

### When checks fire (pageload + button, no polling)

The page operates in two modes determined by overall status:

- **Deploying mode** — any human task is `fail`/`pending`, or any of `bootstrap-ran` / `secrets-populated` / `initial-data-sync` / `first-deploy-succeeded` is not `pass`. The deploy is in-flight; the operator is actively working through the checklist.
- **Deployed mode** — every above check is `pass`. The pipeline is functional; the operator opens the page for spot health checks and post-change verification.

**The page does not poll.** Checks fire on exactly two triggers:

1. **On mount** — the page fetches `/api/platform/deploy/status` once when it loads. This is the operator's "where am I now?" snapshot.
2. **On button click** — a top-level **"Refresh all"** button re-fetches the whole status (`?fresh=1` to bypass cache). Each card also has a per-card **"Recheck"** button that re-runs only that check (the route accepts `?only=<id>` to scope the work).

This is deliberate. The page is the operator's **interactive go-live checklist** — it's not a dashboard you leave open. The operator opens it, sees what's pending, clicks through to the GCP/DNS/whatever console to fix the next item, comes back, hits "Refresh all", sees the next blocker. Polling would burn API quota for no operator-visible benefit between actions.

The `?fresh=1` query param bypasses the server-side cache for a one-shot recheck. The cache exists so the on-mount fetch returns fast (most cards from a 30s TTL hit); the "Refresh all" button skips the cache.

External API checks (GCP, DNS) cache for `cacheTtlSeconds` (default 30s in deploying mode, 1h in deployed mode). Code/env reads don't cache. **Security-invariant checks never cache** — they run live on every status request, so a regression surfaces the next time the page is opened or refreshed.

### Persistent doc shapes (Firestore)

The page reads two project-owned Firestore docs that store deploy state outside of GCP APIs.

**`_deploy_meta` collection, `singleton` doc** — written by `scripts/sync-local-to-firestore.mjs` at the end of each successful sync, and updated by the bootstrap script when it completes:

```jsonc
{
  "_id": "singleton",
  "schema_version": 1,
  "first_synced_at": "2026-04-15T12:00:00.000Z",   // set once, never updated
  "last_synced_at":  "2026-04-27T09:30:00.000Z",   // updated on every sync
  "last_sync_summary": [                           // collections: counts from the most recent run
    { "name": "users",     "upserted": 12, "failed": 0 },
    { "name": "cms_items", "upserted": 47, "failed": 0 }
  ],
  "bootstrap_completed_at": "2026-04-15T11:45:00.000Z",
  "deploy_spec_hash": "sha256:abcd…"               // hash of .deploy-spec.yaml at last bootstrap; status page warns if drift
}
```

The `initial-data-sync` check passes iff `_deploy_meta.singleton` exists and `last_synced_at` is present.

`_deploy_heartbeat` is no longer part of the canonical schema — see the deletion note in "Runtime invariants" above. A project that genuinely runs an in-process worker can re-introduce the doc shape locally, but the recipe no longer mandates it.

### Security-fail surfacing

When any check returns `security-fail`, the page renders a fixed-position red banner across the top of the entire `/platform/deploy` view: red background, white text, the offending check name, and a "Recheck now" button. The banner is sticky — scrolling the card list does not scroll it off. The corresponding card is also pinned to the top of the Security group, regardless of normal sort order. **No external alerting is wired by this skill** — the surface is the page itself, on the assumption a superadmin checks it during any active deploy and at least weekly otherwise. Wiring Slack/email/PagerDuty is left to a future skill that reuses the check registry.

## Project-Specific Integrations

Every Goliath project pulls in some subset of third-party services (email, payments, LLM providers, object storage, analytics). Each integration brings its own human-task checklist (paste API key, verify domain, register webhook, exit sandbox) **and** its own runtime health signal (API ping returns 200, account is in good standing). The recipe **detects intended integrations from the repo itself** and registers the corresponding checks automatically — the operator doesn't hand-list them.

### How detection works

Three signals, in order of authority:

1. **`.deploy-spec.yaml` at the repo root** (optional override) — explicit list of integrations and their config. Always wins when present.
2. **Installed dependencies** — recipe scans `package.json` (or `pyproject.toml`) for a known set of integration-signaling packages.
3. **Env-var pattern scan** — recipe greps for `process.env.<PREFIX>_*` references in the codebase. Catches integrations the dependency scan missed (e.g., raw `fetch` against an HTTP API with no SDK).

When all three signals disagree, the recipe asks at install time and writes the answer to `.deploy-spec.yaml` so future installs are deterministic.

### Built-in integrations

Each ships a small bundle of checks, registered when the integration is detected. The bundle adds checks to all four categories (human, automated, runtime, audit) as appropriate.

| Integration | Detected by | Human checks added | Runtime checks added |
|---|---|---|---|
| **Amazon SES** | `@aws-sdk/client-sesv2` package, `AMAZON_SES_*` env vars | `ses-iam-key-populated`, `ses-domain-verified`, `ses-dkim-published`, `ses-spf-published`, `ses-out-of-sandbox` | `ses-test-send-works` (sends to superadmin email, expects 200), `ses-bounce-rate-ok` (CloudWatch metric < threshold) |
| **Stripe** | `stripe` package, `STRIPE_*` env vars | `stripe-secret-key-populated`, `stripe-publishable-key-populated`, `stripe-webhook-secret-populated`, `stripe-webhook-registered` (URL pointing at this deploy's `/api/webhooks/stripe`) | `stripe-account-active` (`/v1/account` returns `charges_enabled: true`), `stripe-webhook-deliveries-healthy` (last 24h success rate > threshold) |
| **Google Gemini** | `@google/genai` or `@google-ai/generativelanguage`, `GEMINI_API_KEY` | `gemini-api-key-populated` | `gemini-models-list-ok` (trivial models.list call) |
| **Anthropic Claude** | `@anthropic-ai/sdk`, `ANTHROPIC_API_KEY` | `anthropic-api-key-populated` | `anthropic-message-create-ok` (1-token completion) |
| **OpenAI** | `openai` package, `OPENAI_API_KEY` | `openai-api-key-populated` | `openai-models-list-ok` |
| **Twilio** | `twilio` package, `TWILIO_*` env vars | `twilio-credentials-populated`, `twilio-sender-verified` (number/messaging-service approved) | `twilio-account-active` |
| **AWS S3** | `@aws-sdk/client-s3`, `S3_BUCKET` or `AWS_S3_*` | `s3-iam-key-populated`, `s3-bucket-exists`, `s3-bucket-policy-applied` | `s3-write-then-read-roundtrip` (recipe-time only; runtime check omitted to avoid garbage objects) |
| **Sentry** | `@sentry/*` package, `SENTRY_DSN` | `sentry-dsn-populated`, `sentry-project-created` | `sentry-test-event-received` (one-shot at install, not per-poll) |
| **Cloudflare R2** | `@aws-sdk/client-s3` + `R2_*` env vars | `r2-credentials-populated`, `r2-bucket-exists` | `r2-write-then-read-roundtrip` (install-only) |

The reference impl (`goliathdynamics.com/web`) currently triggers **SES** (sees `@aws-sdk/client-sesv2` + `AMAZON_SES_*`) and **Gemini** (sees `@google/genai` + `GEMINI_API_KEY`). Stripe is **not** detected and its checks are not registered — adding `stripe` to dependencies later auto-enables the Stripe bundle on next install or refresh.

### Detection precedence example

A project has `stripe` in `package.json` but no `STRIPE_*` env vars referenced anywhere (someone added the dep speculatively, never wired it). The recipe:

1. Dependency scan flags Stripe as candidate.
2. Env scan finds zero references.
3. Mismatch → recipe asks: "Stripe is installed but no `STRIPE_*` env vars are referenced. Enable Stripe checks?" Default: **no** (avoid noisy red cards for unwired integrations). Answer is written to `.deploy-spec.yaml` as `integrations.stripe: disabled`.

### `.deploy-spec.yaml` schema

Optional file at the repo root. When present, it overrides auto-detection. The recipe writes/updates it whenever the operator answers a detection-mismatch prompt during install.

```yaml
# .deploy-spec.yaml — committed to the repo, no secrets
schema_version: 1

stack: nextjs                  # nextjs | expo | fastapi
region: us-east4               # GCP region (Firestore, Artifact Registry, Cloud Run all match)
domain:
  canonical: www               # www | apex
  mapping: cloud-run           # cloud-run | external-lb
public_env_namespace: NEXT_PUBLIC   # NEXT_PUBLIC_ | EXPO_PUBLIC_ | (omit for FastAPI)

worker:
  in_process: true             # toggles worker-running + min-instances-when-worker checks
  tick_interval_seconds: 30    # heartbeat freshness threshold = 3x this

integrations:
  ses:        enabled
  gemini:     enabled
  stripe:     disabled         # detected as candidate; operator confirmed unwired
  anthropic:  enabled
  # Auto-detected entries omitted from this file are treated as enabled by default.

envScanIgnore:
  - VERCEL_*                   # extends the built-in dev-only ignore list

custom_checks:
  # File path (relative to repo root) of a module that registers extra checks via registerCheck().
  - src/lib/deploy/checks/projectSpecific.ts
```

The recipe stores `sha256(.deploy-spec.yaml)` in `_deploy_meta.deploy_spec_hash`. If the file changes after a deploy, the page shows a `warning`-level card "Deploy spec drift — bootstrap may need re-running" with a one-shot "Re-run bootstrap" button.

### Adding a new integration

```ts
// src/lib/deploy/checks/integrations/<name>.ts
import { registerIntegration } from "../registry";

registerIntegration({
  id: "myservice",
  detect: {
    packages: ["my-service-sdk"],
    envPrefixes: ["MYSERVICE_"],
  },
  checks: [
    { id: "myservice-api-key-populated", category: "human", detect: () => /* ... */ },
    { id: "myservice-account-active",    category: "runtime", detect: () => /* ... */ },
  ],
});
```

The recipe re-scans on every install and on a manual `Refresh integrations` button at the bottom of `/platform/deploy`. Removing an integration's package from `package.json` does **not** auto-deregister its checks — the operator must remove the integration file or set `disabled` in `.deploy-spec.yaml`. **Why:** silently dropping checks because someone removed an unused-looking dependency is how regressions go un-monitored.

### What an integration check is allowed to do

- ✅ Read env vars
- ✅ Make a single low-cost API call to the integration (head request, list of zero items, account-status endpoint)
- ✅ Read provider-side config (e.g., SES DKIM verification status)
- ❌ **Send a real test message in a runtime check** (one-shot install-time only — recurring sends spam users and burn quota)
- ❌ Mutate any provider-side state during a status poll (no creating webhooks, no rotating keys, no sending test charges)

Integration checks that violate the runtime budget (slow, expensive, side-effecting) belong as **install-time-only** validations, not registry entries.

## Fit-to-Project

Before installing, the recipe asks:

- **Stack**: Next.js, Expo + `+api.ts`, or FastAPI? (Picks `Dockerfile.<stack>` and the right page-route file extension.)
- **Region**: Which GCP region? (Pinned across Firestore, Artifact Registry, Cloud Run — they must match.)
- **In-process worker**: Does this project run a queue/scheduler/cron inside the same process? (If yes, the recipe enables the `worker-running` and `min-instances-when-worker` checks and recommends `min-instances ≥ 1`. The deploy status page itself has no background poller — it polls only while open.)
- **Domain mapping vs external LB**: Cloud Run domain mapping (simpler) or external HTTPS load balancer (CDN/Armor in front)? (Default: domain mapping. LB switch changes which DNS-record set the `dns-records-published` check expects.)
- **Public env namespace**: `NEXT_PUBLIC_*`, `EXPO_PUBLIC_*`, or none? (Determines which env vars get pushed to Cloud Build substitutions vs Secret Manager runtime mounts.)
- **Integration overrides**: Confirm the auto-detected integration list (SES, Stripe, Gemini, etc.) and resolve any mismatches the env-vs-deps scan surfaces. Result is written to `.deploy-spec.yaml`.

## Anti-Patterns

- **Configuring the build inline in the Cloud Build trigger console** — uncheckable into git, invisible in PR review, lost when the trigger is recreated. Always check `cloudbuild.yaml` into the repo.
- **`LOCALHOST_AUTH_BYPASS !== "false"` (or any default-to-true variant)** — opens admin to the world on any fresh deploy with no env config. Always `=== "true"`, fail-secure.
- **Mounting `NEXT_PUBLIC_*` / `EXPO_PUBLIC_*` as Cloud Run runtime secrets** — they bake into the bundle at build time, so a runtime-only mount produces undefined client-side. Push them through Cloud Build substitutions instead.
- **`MONGO_URI` without `retryWrites=false`** — Firestore rejects retryable writes; you get cryptic per-write failures with no obvious cause. Always include all four required query params.
- **Importing `firebase-admin` "just for one thing"** — the parallel data-access layer is the start of a slow drift away from the local-Mongo / prod-Firestore parity that makes local dev work at all. Stay on the `mongodb` driver against the compat endpoint.
- **Single shared service account for build and runtime** — least-privilege blast radius. Build SA needs `run.admin`; runtime SA must not. Two SAs.
- **Skipping the `_deploy_meta` doc after initial sync** — the status page can't tell "fresh empty Firestore" from "we forgot to sync" without it. Always write the doc at the end of the sync script.
- **Pretty-printing the status check results in the API response** — frontend-vs-backend tightly coupling on shape; some checks are slow and the server already serializes them. The API returns the raw `Check[]` and the page does its own grouping/sorting.
- **Treating `security-fail` as a regular failure** — it's a P0. Sticky red banner across the top of `/platform/deploy`, pinned to the top of the Security group, never cached. A red card buried in a sorted list is invisible.
- **Sending real messages from a runtime integration check** — a `ses-test-send-works` runtime check that fires on every poll spams the superadmin every 30 seconds and burns SES quota for nothing. Runtime integration checks are read-only or low-cost API pings; real-message validation is install-time only.
- **Auto-deregistering integration checks when the dependency disappears** — silently dropping monitoring because someone removed an unused-looking package is exactly how regressions go undetected. Removal is explicit (delete the integration file or set `disabled` in `.deploy-spec.yaml`).
- **Dropping a `Dockerfile` and assuming Cloud Run buildpacks will handle it** — buildpack inference works until it doesn't; then you're debugging deploys against an opaque builder. Always check in an explicit Dockerfile.
- **Running the deploy status checks from a background poller on the web service** — every Cloud Run instance that boots would start its own copy of the poller, so autoscaling N instances means N duplicate GCP/DNS API calls. With `min-instances=0` (correct default for a low-traffic admin app), cold-starts fire the poller once per request burst and then the instance dies — nondeterministic and wasteful. The deploy page polls only while open; drift detection is handled by the operator opening the page, not by a phantom background loop.
- **Surfacing raw GCP HTTP status without the response body** — `403` from GCP means either "API not enabled" or "permission denied" with the same status code; the operator can't distinguish them and wastes time on the wrong fix (frequently chasing IAM when the actual answer is `gcloud services enable …`). Every `gcpFetch`-style helper must parse `error.message` from the body and surface a categorized detail string. Detect the "has not been used in project … or it is disabled" pattern and render it as "API not enabled."
- **Not invalidating `prodEnv` caches on user-initiated refresh** — `runChecks` honors `?fresh=1` for the per-check status cache, but the deeper token cache (5 min) and Cloud Run service-config cache (30 sec) in `prodEnv.ts` are separate Maps that nothing else touches. Without `clearProdEnvCache()` on user-initiated refresh, the operator runs `gcloud auth login --update-adc`, hits Recheck, and the page keeps using the stale token. Looks like a deploy-page bug; is actually a layered-cache bug.
- **Suggesting `gcloud auth login --update-adc` on every `unknown`** — "unknown" covers auth failures, API-disabled, missing env vars, missing resources, and detector exceptions. Pinning the reauth advice on all of them sends the operator down the wrong path several times before they figure out the real issue. Only emit `reauthCommands` when the failure is *actually* auth (`401`, no token, or `403` with an auth-shaped body).
- **Substitution-name drift between cloudbuild.yaml and prodEnv.ts** — the build-arg name, the cloudbuild substitution key (`_PUBLIC_SITE_HOST`), the runtime env var (`NEXT_PUBLIC_SITE_HOST`), and the `cloudbuildSub('…')` reader all have to agree. A subtle rename in one place produces "prod hostname not configured" with no obvious cause and no failing build. Pin one name, search for all four spellings before merging any change to either file.
- **Missing `GCP_PROJECT` in dev `.env.local`** — `prodEnv.PROJECT_ID()` reads only env vars (intentionally — it does NOT shell out to `gcloud config get-value project`, because that pulls in whatever project the operator was last working on in *another* repo). When dev doesn't set `GCP_PROJECT`, every prod check short-circuits with "project ID unknown" before auth runs, and the operator misreads it as an auth problem. `.env.local` must include `GCP_PROJECT`, `GCP_REGION`, `GCP_SERVICE`, `NEXT_PUBLIC_SITE_HOST`.
- **Skipping Firestore database creation on first bootstrap** — `gcp-bootstrap.sh` enables `firestore.googleapis.com` but does NOT run `gcloud firestore databases create` (location and edition are immutable, so it's a deliberate operator step, not a bootstrap side effect). On a fresh project this means everything Mongo-related fails until the operator runs the create command manually — see "Firestore Setup" above. Don't conflate "API enabled" with "database created."
- **Preserve/restore the operator's previous active gcloud project around a per-project script** — operators switch active project as they switch repos, intentionally. Save-then-restore (back to whatever was active before the script ran) defeats that workflow and leaves them on the wrong project for the *next* command they'd naturally type. Just `gcloud config set project <target>` or pass `--project=<target>` per call and leave the active project where the script puts it.
- **Pushing without running `pnpm typecheck` (or equivalent) first** — `next dev` skips `tsc --noEmit`; `next build` runs it. Local dev passes silently with a broken `theme.rSm` / wrong import / unsatisfied generic, then Cloud Build dies at the linting/type-checking step after burning a docker image pull and a multi-minute build. Pre-push hook or local typecheck run is cheap; a failed Cloud Build is not. Per-stack equivalent: `pnpm typecheck` (Next), `tsc --noEmit` (Expo TS), `mypy` or `pyright` (FastAPI).
- **Pushing without running `pnpm install` first when `package.json` was edited** — `pnpm install --frozen-lockfile` in Docker (the right CI invariant) refuses to bridge a stale lockfile. Adding a dep to `package.json` and not refreshing `pnpm-lock.yaml` produces a confusing `ERR_PNPM_OUTDATED_LOCKFILE` at deploy time with a long diff of specifiers. Either run `pnpm install` after every `package.json` edit, or use `pnpm add <pkg>` which does both at once.

## Logging

Everything goes through Cloud Logging by default — no extra setup needed for stdout/stderr capture. Log these at the boundaries:

- **`[deploy-check] id=<check-id> status=<status> ms=<elapsed>`** — every status check, every run. Cardinality is small (one line per check per cache window).
- **`[deploy-check][error] id=<check-id> err=<message>`** — when a detector throws. Include the GCP API error code if applicable so the operator can distinguish "permission denied" from "not found."
- **`[deploy-status] overall=<status> failing=[<ids>] pending=[<ids>]`** — once per status API call, summarizes the page state at that instant. Lets you reconstruct the deploy state at any past timestamp from logs alone.
- **`[deploy-bootstrap] step=<step> result=<created|exists|error>`** — every step of `gcp-bootstrap.sh`. Idempotency claims are verifiable from logs.
- **`[deploy-sync] collection=<name> upserted=<n> failed=<n>`** — per-collection results from the initial sync. Already implemented in the reference impl.

Do NOT log secret values, full `MONGO_URI` strings, or the `Set-Cookie` header contents. Mask before logging — same convention as the reference impl's URI mask: `uri.replace(/:\/\/[^@]*@/, "://***@")`.
