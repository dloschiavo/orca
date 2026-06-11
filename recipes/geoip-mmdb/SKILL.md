---
name: geoip-mmdb
description: >
  Use when adding IP-to-location lookups (city, region, country, lat/lng)
  to a web app. DB-IP City Lite binary MMDB (free, no account, no API
  key, CC BY 4.0), with a pluggable backend that auto-selects between
  local disk (dev / single-box) and GCS (Cloud Run / multi-instance) at
  module-load time. Lazy-loaded into process memory via the maxmind
  package; admin spoof cookie lets staff override their resolved
  location for testing. Cloud Build runs a presence/staleness check
  before each image build so the first deploy self-bootstraps GCS and a
  broken cron gets caught at deploy time. No Mongo.
dependencies:
  requires: [admin-routing]
  capabilities:
    auth: otp-auth
    design-system: admin-design-system
provides: [geoip]
---

# GeoIP MMDB

A pattern for adding IP-to-location lookups to a web app using **DB-IP City Lite** — a free monthly MMDB with no account, no license key, no auth headers. Same binary format as MaxMind GeoLite2 (both produce `.mmdb`); same `maxmind` reader works on either. We default to DB-IP because zero-setup-friction matters more than a 5-percentage-point accuracy bump that GeoLite2 buys you.

Six properties are load-bearing:

1. **Binary MMDB, not Mongo range tables.** MMDB is a packed binary tree designed for sub-microsecond `IP → record` lookups. Importing 4M+ IP ranges into Mongo and `$lte`/`$gte`-querying them is 1000× slower for no benefit.
2. **DB-IP is the source of truth.** The file is freely re-downloadable from a versioned permalink (`dbip-city-lite-YYYY-MM.mmdb.gz`). No backup needed.
3. **Pluggable backend, auto-selected.** Two implementations: `local-disk` (default) and `gcs`. Selection is automatic: if `GEOIP_GCS_BUCKET` is set in the env, GCS wins; otherwise local disk. The lookup module doesn't know or care which backend is active — it just calls `backend.localPath()` and opens that file. Cloud Build packages the same code; Cloud Run picks GCS at startup because that's what its env says.
4. **Atomic-rename swap (always).** Both backends write `*.mmdb.new`, validate the buffer, then `fs.rename` onto the canonical local path. Readers either see the old file or the new file, never a half-written one.
5. **Lazy singleton, auto-hot-reload, fail-soft.** First lookup opens the file via `maxmind.open(path, { watchForUpdates: true })`. The library installs an `fs.watchFile` poller that reloads the in-memory Reader within ~5s of a rename. Errors return `null` — a missing/stale GeoIP file never crashes a request.
6. **No Mongo. No status table.** Build date comes from the MMDB's own metadata (`reader.metadata.buildEpoch`). File age comes from `fs.stat().mtime`. Last error and version metadata live in JSON sidecars next to the .mmdb (local disk) or as additional objects in the bucket (GCS). The admin page reads all of this at page-load time — no separate write path, no drift between "what's on disk" and "what the dashboard thinks."

## Library Choice

```
"maxmind":             "^5.0.0"
"@google-cloud/storage": "^7.19.0"    // only loaded at runtime if GEOIP_GCS_BUCKET is set
```

No `tar`. DB-IP ships plain `.mmdb.gz`. Node's `zlib.createGunzip` is enough.

## Env Vars

```
# Always:
GEOIP_EDITION         # optional, default "dbip-city-lite"
GEOIP_CRON_SECRET     # optional — shared-secret header for off-box cron pings

# Local-disk backend (the default when GEOIP_GCS_BUCKET is unset):
GEOIP_DATA_DIR        # optional, default "./data/geoip"

# GCS backend (active when GEOIP_GCS_BUCKET is set):
GEOIP_GCS_BUCKET      # required — bucket name, no `gs://` prefix
GEOIP_GCS_PREFIX      # optional, default "geoip/"
```

Cloud Run service accounts authenticate to GCS via ADC (Application Default Credentials). No JSON key. The serving service's SA needs `storage.objectAdmin` on the bucket if it's also the cron target (it both reads and writes); a read-only SA is fine if the cron is a separate Job.

## Download Endpoint

```
GET https://download.db-ip.com/free/dbip-city-lite-YYYY-MM.mmdb.gz
```

Plain unauthenticated GET. The file is gzipped MMDB directly (no tarball). Both backends share the fetch+gunzip+validate code; only the persistence step diverges.

**Month-boundary handling:** if `dbip-city-lite-${thisMonth}.mmdb.gz` 404s (DB-IP sometimes publishes a day or two late), fall back to last month and let the next cron pick up the current month.

## Backend Interface

`lib/geoip-backend.ts` is the abstraction. The interface is small and shared:

```ts
export interface GeoipBackend {
  readonly name: 'local-disk' | 'gcs';
  /** Absolute path the maxmind Reader will open after ensureLocal(). */
  localPath(): string;
  /** Make sure a usable .mmdb is at localPath(). Called lazily on first lookup.
   *  No-op on local-disk; pulls from GCS to /tmp on cold start under GCS. */
  ensureLocal(): Promise<void>;
  /** Download from DB-IP, validate, persist to canonical location.
   *  Idempotent: re-runs for the same month no-op cheaply. */
  refresh(): Promise<RefreshResult>;
  readStatus(): Promise<GeoipStatus | null>;
  readLastError(): Promise<GeoipLastError | null>;
}

export function getBackend(): GeoipBackend {
  if (process.env.GEOIP_GCS_BUCKET) return new GcsBackend();
  return new LocalDiskBackend();
}
```

### LocalDiskBackend

Canonical files at `${GEOIP_DATA_DIR}/`:

```
dbip-city-lite.mmdb       # canonical, what readers open
dbip-city-lite.mmdb.new   # transient, only exists mid-refresh
version.json              # what we last successfully downloaded
last_error.json           # only after a failed refresh
.gitignore                # ignore everything in this dir
```

`refresh()` writes `*.mmdb.new` → validates via Reader constructor → `fs.rename` → writes `version.json` → deletes `last_error.json`.
`ensureLocal()` is a no-op (the file's already in its canonical home or it isn't).
`readStatus()` does `fs.stat` + `Reader(buf).metadata` + reads `version.json`.

Correct for: localhost dev, single-VM prod, any process that owns persistent local disk.

### GcsBackend

Canonical objects in `gs://${GEOIP_GCS_BUCKET}/${GEOIP_GCS_PREFIX}`:

```
dbip-city-lite.mmdb
dbip-city-lite.version.json
dbip-city-lite.last_error.json    # only after a failed refresh
```

Local cache (per instance, ephemeral) at `${os.tmpdir()}/metamox-geoip/`:

```
dbip-city-lite.mmdb     # what the maxmind Reader actually opens
dbip-city-lite.etag     # the GCS etag we cached
```

`refresh()` downloads from DB-IP → validates → uploads to GCS (overwrite — GCS object writes are atomic) → updates GCS `version.json` → deletes GCS `last_error.json` → also writes to `/tmp/` so the calling instance benefits immediately.
`ensureLocal()` HEADs the GCS object's etag, compares to the cached etag, downloads if different. On a fresh cold-start container with empty `/tmp/`, this pulls the file once.
`readStatus()` reads from `/tmp/` + downloads `version.json` from GCS.

Correct for: Cloud Run, k8s, any stateless-container deploy where local disk evaporates on restart.

**Why the GCS object is the canonical and `/tmp/` is the cache, not the other way around:** Cloud Run can scale to N instances on demand. Without a shared canonical, each instance would have to pull from DB-IP independently — N× the rate-limit risk + N× the cold-start latency. With GCS as canonical, the cron downloads from DB-IP exactly once per month; every instance pulls from GCS (~100ms, no rate limits, free egress within GCP).

## Refresh Flow (shared by both backends)

```ts
async function refreshCommon(): Promise<{ buf: Buffer; yyyymm: string; buildDate: string; sha256: string }> {
  const thisMonth = ymString(new Date());
  let { buf, yyyymm } = await fetchDbipForMonth(thisMonth);    // falls back to last month on 404
  const reader = new Reader<CityResponse>(buf);                 // throws on truncated/bad MMDB
  const buildDate = reader.metadata.buildEpoch.toISOString().slice(0, 10);
  const sha256 = sha256Hex(buf);
  return { buf, yyyymm, buildDate, sha256 };
}
```

Then the backend persists. Same `version.json` shape regardless of backend:

```json
{
  "edition": "dbip-city-lite",
  "yyyymm": "2026-05",
  "build_date": "2026-05-01",
  "byte_length": 130723761,
  "sha256": "382b3dea…",
  "refreshed_at": "2026-05-13T13:58:28.292Z",
  "source": "dbip-city-lite",
  "attribution": "IP Geolocation by DB-IP (https://db-ip.com), CC BY 4.0"
}
```

## In-Process Reader

`lib/geoip.ts` — backend-agnostic:

```ts
const backend = getBackend();
const reader = await maxmind.open<CityResponse>(backend.localPath(), {
  watchForUpdates: true,
  watchForUpdatesHook: () => console.log('[geoip] mmdb hot-reloaded'),
});
```

Two backends, one reader. `maxmind.open` uses `fs.watchFile` (path-based, ~5s poll, handles atomic rename). In local-disk mode, this is essential — cron writes the new file, watcher reloads in place. In GCS mode, the file doesn't change during an instance's lifetime (it was downloaded at cold-start), so the watcher is harmless but does nothing.

Module-level singleton + in-flight dedup as before. Cold start in GCS mode pays one GCS download (~100-300ms for 130 MB on Cloud Run's network) + parse cost; warm requests are sub-microsecond.

## Cron Schedule

DB-IP publishes on the **1st of each month**. Run the refresh **on the 3rd at 06:00 UTC**.

Cron destinations:

- **Local / single-box (local-disk backend)**: a `crontab` entry running `pnpm refresh-geoip`.
- **Cloud Run + Cloud Scheduler (gcs backend)**:
  - **Simplest**: Cloud Scheduler → POST `/api/admin/geoip/refresh` with `x-geoip-cron: $GEOIP_CRON_SECRET`. The serving service handles the refresh. Adds ~5s of latency to one request per month — fine for melee-event-style workloads.
  - **Cleaner**: a separate Cloud Run **Job** that runs `pnpm refresh-geoip`, deployed from the same image. Cloud Scheduler triggers the Job. No latency hit on the serving path, but adds a deploy unit.
- **Kubernetes**: a `CronJob` running the same script.

The script (`scripts/refresh-geoip.ts`) is just `getBackend().refresh()`. The HTTP endpoint and the cron job are both thin wrappers over the same call.

## Cloud Build / Cloud Run Deploy

The recipe is designed to be transparent to the deploy pipeline:

- **Cloud Build** does not bake the .mmdb into the image. The image carries only JS code. Image size unchanged.
- **Cloud Build does run a presence/staleness check** (see below) as a pre-build step, so first-ever deploys self-bootstrap GCS and any "cron has been broken for 2 months" situation gets caught at deploy time.
- **Cloud Run** picks up `GEOIP_GCS_BUCKET` from its env (set via Secret Manager mapping or plain env var) and the GcsBackend activates automatically. First request after cold-start pays a ~200ms GCS download; subsequent requests are warm.
- **Local dev** doesn't set `GEOIP_GCS_BUCKET`, so LocalDiskBackend activates and the `./data/geoip/` cache persists across `pnpm dev` restarts.
- The **same Dockerfile**, the **same `pnpm refresh-geoip` script**, the **same `/api/admin/geoip/refresh` endpoint** work in both environments. Environment chooses behavior; code stays identical.

### Build-time presence / staleness check

`scripts/check-geoip.ts` runs as a Cloud Build step **before** the docker build (or in parallel — it doesn't depend on the image). It does **one cheap HTTP GET** of `version.json` from GCS, then:

- **Missing** → call `backend.refresh()` (downloads from DB-IP, uploads to GCS).
- **`build_date` older than `GEOIP_STALE_DAYS` (default 35d)** → call `backend.refresh()`.
- **Fresh** → exit 0, no-op. No DB-IP traffic, no GCS write.

```
pnpm check-geoip
# logs one of:
#   [check-geoip] build_date=2026-05-01 age=12d (<= 35d) — fresh, no-op
#   [check-geoip] build_date=2026-04-01 age=42d > threshold=35d — refreshing
#   [check-geoip] no version.json at canonical location — refreshing
```

This is **not** a substitute for the monthly cron — it's a safety net. Idempotent across rapid sequential deploys (first build refreshes, the rest no-op). Concurrent builds that both decide to refresh will each download from DB-IP independently; GCS object writes are atomic, both end up with identical contents. Worst case: 2× DB-IP bandwidth on rare concurrent builds. Not worth a lock.

#### `cloudbuild.yaml` snippet

```yaml
steps:
  # Presence/staleness check — refreshes GCS if missing or >35d old.
  # Runs before the image build so a failure here blocks the deploy.
  - id: 'geoip-check'
    name: 'node:20'
    entrypoint: 'bash'
    args:
      - '-c'
      - 'cd web && npm install -g pnpm && pnpm install --frozen-lockfile && pnpm check-geoip'
    env:
      - 'GEOIP_GCS_BUCKET=${_GEOIP_GCS_BUCKET}'
      # GEOIP_STALE_DAYS defaults to 35 if unset.

  # Standard docker build proceeds independently.
  - id: 'docker-build'
    name: 'gcr.io/cloud-builders/docker'
    args: ['build', '-t', '${_IMAGE}', '.']
    waitFor: ['-']    # parallelize with geoip-check

substitutions:
  _GEOIP_GCS_BUCKET: 'metamox-geoip-prod'
  _IMAGE: 'us-central1-docker.pkg.dev/$PROJECT_ID/web/web:$SHORT_SHA'
```

Cloud Build's default service account (`<project-number>@cloudbuild.gserviceaccount.com`) needs `roles/storage.objectAdmin` on the GeoIP bucket. Grant once:

```bash
gcloud storage buckets add-iam-policy-binding gs://metamox-geoip-prod \
  --member="serviceAccount:$(gcloud projects describe $PROJECT_ID --format='value(projectNumber)')@cloudbuild.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"
```

This same SA grant covers both the build-time check and any cron-style Cloud Build trigger used for the monthly refresh.

## Admin Spoof

For testing event-proximity / geo-aware features without touching your real network, an admin can install a location-spoof cookie. Two input modes:

- **By IP**: paste an IP; we resolve it via `lookupIp` and store the result.
- **Manual**: paste city / region / country / lat / lng directly.

`POST /api/admin/geoip/spoof` (admin-gated) sets an HttpOnly cookie carrying the JSON-encoded `GeoLookup`. `DELETE /api/admin/geoip/spoof` clears it.

Feature code never calls `lookupIp()` directly. It calls **`getEffectiveGeo(request)`** from `lib/geo-spoof.ts`, which:

```ts
export async function getEffectiveGeo(request: Request): Promise<GeoLookup | null> {
  const spoof = readSpoofedGeo(request);
  if (spoof) return spoof;
  const ip = getClientIp(request.headers);
  if (!ip) return null;
  return lookupIp(ip);
}
```

The cookie is **not** cryptographically signed. The threat model is "admin temporarily lies to themselves about their own location" — there's no privilege escalation possible (the SET endpoint is admin-gated, and the cookie only affects the cookie-bearer's resolved location). If you ever wire spoof-affected geo into authorization (geo-fencing, regulatory compliance), reconsider — sign with HMAC + a server secret, or move to a server-side spoof store keyed on session_id.

## Admin Page

`app/admin/geoip/page.tsx`. Three cards:

1. **Database status** — backend name, freshness badge, local path, file size, mtime, version yyyymm, last error if any, the caller's own effective location (with `SPOOFED` badge when applicable), DB-IP attribution. "Refresh now" button.
2. **Spoof location** — currently-active spoof display + clear button; tabs for "By IP" vs "Manual" input.
3. **Test lookup** — paste an IP, see the raw `GeoLookup` JSON.

API routes:

```
POST   /api/admin/geoip/refresh   → backend.refresh()
GET    /api/admin/geoip/lookup    → { backend, status, last_error, self, spoof }
POST   /api/admin/geoip/lookup    → body: { ip } → { ip, lookup }
POST   /api/admin/geoip/spoof     → body: { ip } | { lookup } → set cookie
DELETE /api/admin/geoip/spoof     → clear cookie
```

The refresh endpoint accepts an `x-geoip-cron: $GEOIP_CRON_SECRET` header in lieu of an admin session, so an off-box scheduler can trigger it without a logged-in user.

## Fit-to-Project

Before implementing, check:

- **Backend choice.** Set `GEOIP_GCS_BUCKET` in any deploy where local disk doesn't persist across restarts (Cloud Run, k8s, any stateless container runtime). Leave it unset for localhost dev and single-VM prod.
- **GCS bucket setup.** Create the bucket once: `gcloud storage buckets create gs://${PROJECT}-geoip --location=us-central1`. The serving service account needs `storage.objectAdmin` if it'll handle refreshes itself; `storage.objectViewer` is enough if a separate Job handles them.
- **Behind a trusted proxy?** If client IP comes from `x-forwarded-for`, you must have a proxy you control (Cloud Run does this automatically; ALB, Cloudflare also fine). Otherwise the header is attacker-controlled and the lookup is meaningless.
- **License attribution.** DB-IP CC BY 4.0 requires "IP Geolocation by DB-IP (https://db-ip.com)" somewhere user-visible — footer, /credits, or about page. Once is enough.
- **Coverage gaps.** DB-IP free is city-level for ~90% of IPs, country-only for the remainder. If your use case can't tolerate "no city for 1 in 10 lookups" (geo-fencing for compliance), swap `GEOIP_EDITION` to a paid DB-IP edition — same code, swap env var only.

## Anti-Patterns

- **Importing the .mmdb into Mongo as range rows.** Replicates the file in 4M+ docs, ~1000× slower, no win.
- **Storing the .mmdb bytes in Mongo (GridFS or chunks).** Mongo is not the source of truth. Use local disk on single-box; use GCS for multi-instance. Don't invent a third path.
- **Storing a "geoip_status" doc in Mongo.** The .mmdb's own metadata + `fs.stat` + version.json/last_error.json sidecars are strictly more accurate. The Mongo doc only drifts.
- **Hard-coding the local file path in the lookup module.** The path comes from the backend. Backends differ in where they put the file (e.g. `./data/geoip/` vs `/tmp/metamox-geoip/`). Always go through `backend.localPath()`.
- **Conditional branching on backend name in feature code.** The backend is encapsulated. If you find yourself writing `if (backend === 'gcs') ...` outside `lib/geoip-backend.ts`, the abstraction is leaking.
- **Eager top-level `maxmind.open()` at module import.** Blocks startup on file I/O (and in GCS mode, on a network round-trip). Use a lazy singleton.
- **Re-opening the MMDB on every request.** Each `maxmind.open()` installs a fresh `fs.watchFile` watcher. Open once per process.
- **Throwing on lookup failure.** A missing/stale GeoIP file should degrade to `null`, not 500 the request.
- **Bundling the .mmdb into the container image.** Bloats every deploy by 100+ MB and locks the freshness cadence to your deploy cadence. Runtime fetch from GCS keeps the image lean and decouples cron from deploys.
- **Calling `lookupIp()` from feature code.** Use `getEffectiveGeo(request)` instead — it honors the admin spoof cookie. Direct `lookupIp` is for the test endpoint and the spoof-setter only.
- **Trusting `x-forwarded-for` from an untrusted edge.** Spoofable. Only honor it behind a proxy you control.
- **Returning a location for private/bogon IPs.** Filter at the entry point. `10.0.0.1` is not in Iowa.
- **Logging the full `GeoLookup` on every request.** city + country are fine at INFO, lat/lng + IP together is a privacy footgun in logs.
- **Signing the spoof cookie.** It's not a security boundary — the SET endpoint already is. Don't add HMAC just because the data looks like it should be signed. Add it only if/when spoof-affected geo feeds authorization.
- **Updating `version.json` before the file is in place.** Always last write. Otherwise admin shows "refreshed at 14:02" while the file is still mid-extract.
- **Putting the data dir inside the build output / git tree.** `./data/geoip/` is a runtime cache, not a build artifact. Gitignore it.

## File Map

```
{repo}/web/
  lib/
    geoip-backend.ts                    # LocalDiskBackend + GcsBackend + getBackend()
    geoip.ts                            # lazy singleton Reader, lookupIp(), getClientIp()
    geo-spoof.ts                        # readSpoofedGeo, makeSpoofCookie, getEffectiveGeo
  scripts/
    refresh-geoip.ts                    # thin wrapper over backend.refresh(); pnpm refresh-geoip
    check-geoip.ts                      # build-time presence/staleness check; pnpm check-geoip
  app/
    api/admin/geoip/
      refresh/route.ts                  # POST → backend.refresh()
      lookup/route.ts                   # GET (status) + POST (test lookup)
      spoof/route.ts                    # POST (set) + DELETE (clear)
    admin/geoip/
      page.tsx                          # 3 cards: status, spoof, test lookup
  package.json                          # +maxmind, +@google-cloud/storage, +refresh-geoip script

{repo}/web/data/geoip/                  # local-disk backend's runtime cache, gitignored
  .gitignore
  dbip-city-lite.mmdb
  version.json
  last_error.json                       # only on refresh failure

gs://${GEOIP_GCS_BUCKET}/${GEOIP_GCS_PREFIX}    # gcs backend's canonical, populated by cron
  dbip-city-lite.mmdb
  dbip-city-lite.version.json
  dbip-city-lite.last_error.json        # only on refresh failure
```

No collections introduced. No Mongo writes anywhere in this recipe.

## Logging

- Refresh runs: `INFO` with `{ backend, edition, action, yyyymm, build_date, byte_length, elapsed_ms }`. Failures at `ERROR` with the full message; persisted to backend's last_error sidecar.
- Lookups: do **not** log at INFO per call. DEBUG if at all. Metric: `% of lookups returning non-null`.
- Admin spoof set/clear: `INFO` with `{ user_id, email, action: 'set' | 'clear', spoofed_country }`. Audit-relevant.
- Admin refresh-now button: `INFO` with `{ user_id, email }`. Audit-relevant.
