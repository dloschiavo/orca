---
name: gcp-crawler
description: >
  Use when building a large-scale corpus crawler on GCP — Cloud Run Jobs that
  scrape third-party sources, cache 100% of raw bytes to GCS, and run pure
  extractors behind a human approval gate. Distinct from `web-scraping` (local
  R&D pipeline) and `extension-crawler` (auth-gated browser scraping). Covers
  the scrape→manifest→extract fan-out, the raw-cache-first + dirty-extractor
  discipline, scraper escalation, the Cloud SQL Postgres queue (queue/pipeline
  state must NEVER live on Firestore-compat — per-doc scan billing), and
  Firestore-in-Mongo-compat gotchas.
---

# GCP Crawler

A scalable, restartable corpus crawler that runs as **Cloud Run Jobs**, not as
HTTP request handlers. The load-bearing insight: a crawl is not "one program you
run" — it is two long-lived jobs (`scrape`, `extract`) cooperating through a
single manifest table — on **Cloud SQL Postgres**, never Firestore-compat (see
the storage rule below) — as a work queue. Scrapers are the *only* thing
that touches the network; extractors are *pure* functions over raw bytes. Every
raw fetch is persisted to GCS **before** any parser runs and kept until a human
approves the extractor that consumes it. This is what makes the crawl resumable,
auditable, and recoverable from a parser bug six months later without re-hitting
the source.

Reference implementation: `docpost/docpost-app/` (the "verbatim" crawler) — files cited inline. This recipe is **incomplete and will keep growing** as the reference impl does; treat the architecture as binding and the file list as a snapshot.

## Architecture — two jobs, one queue

```
seed_urls (source YAML)  ─┐
                          ▼
                    crawl_manifest  ◄──────────────┐  (emitted_urls re-enqueued)
                  (Cloud SQL Postgres)             │
                          │ claim                  │
                          ▼                        │
   crawler-scrape job ──► raw bytes ──► GCS  ──► crawler-extract job
   (network: raw_http/cloak)            (raw cache)   (pure extractors)
                          │                        │
                          ▼                        ▼
                  manifest row state         records → corpus
                  (queued|hit|fail)          + emitted next-tier URLs
```

- **You never "run the crawler."** You run a **scrape** (one scraper × one URL list × one source) or an **extract** (one extractor × a cache subset). Both are `gcloud run jobs execute` invocations, fanned out across `--tasks N`.
- **The manifest IS the queue — and it lives on Cloud SQL Postgres.** Each task atomically claims `queued` rows via `SELECT … FOR UPDATE SKIP LOCKED`, so adding tasks scales throughput with no coordinator and no cross-task contention. Discovery extractors push next-tier URLs back as new `queued` rows → the scrape→extract→scrape fan-out.
- **Long-lived warm jobs, fired on a schedule** — not per-request, not every-few-minutes. The reference impl runs `--task-timeout 86400` (23h budget) fired once daily by Cloud Scheduler, so the cloak/Chromium browser stays warm across a single execution instead of paying cold-start per URL.

## Data model

Storage is split by access pattern — this split is load-bearing (see the storage rule below):
- **Queue/pipeline state (`crawl_manifest`) → Cloud SQL Postgres.** Claim-next, has-work, dedup, and progress counts are per-poll hot-path queries; on Firestore-compat each one bills every document it *scans*.
- **Small point-read ledgers (`extractor_state`, `crawler_source_state`, `extraction_status`) and the corpus → the app's Mongo/Firestore-compat database.**

**`crawl_manifest`** — Postgres table, one row per `(source, stable_key)`; the queue + fetch ledger:
```
{ source, url, stable_key,        // stable_key = sha1(url)
  cache_state: 'queued'|'hit'|'fail',
  fetched_at, http_status, content_type, content_length,
  sha256,                         // body hash
  scraper, scraper_version,       // "" while still queued (no scraper ran yet)
  artifact_kind,                  // stamped at fetch; extract selection = indexed equality
  task_id, enqueued_at }
```
`PRIMARY KEY (source, stable_key)` is the dedup. Indexes: `(source, cache_state)`, partial `(source) WHERE cache_state='queued'` (claim), partial stale-reclaim on `fetching`. Claiming is `SELECT … FOR UPDATE SKIP LOCKED` — parallel tasks grab distinct rows with no contention and no scan (reference: `scripts/lib/crawlerPg.mjs` `claimNext`, pool in `lib/crawlerPg.ts`, decision record in `docs/crawler-queue-storage-prd.md` §5a).

**`extractor_state`** — approval + version ledger, `_id = "<domain>:<name>"`:
```
{ source, name, version,          // version bumps on output-shape change
  approval_state: 'dirty'|'approved'|'pending',
  approved_at, approved_by, dirty_count, ok_count, error_count,
  retention_policy, last_run_at }
```
**Only `approved` extractors run on fresh content.** Newly-ported = `dirty`. `pending` rows (never run) are synthesized from the source YAML registry for the UI.

**`crawler_source_state`** — per-domain escalation + pause, `_id = <domain>`:
```
{ scraper: 'cloak', escalated_at,   // set when raw_http was escalated to cloak
  paused: bool, paused_reason, paused_at }
```

**Source config** — `verbatim/crawler/sources/<domain>.yaml`, one file per host (`source:` must be an RFC-1035 hostname, not a slug):
```yaml
source: www.supremecourt.gov
scraper_default: raw_http        # raw_http | cloak
scraper_overrides: []            # per-URL-pattern preemptive escalation
politeness: { rps: 2 }           # per-domain throttle
content_validation: { min_bytes: 500, forbid_substrings: ["Just a moment..."] }
seed_urls: [ ... ]               # initial queue
extractors: [ scotus-docket-page, scotus-filing-pdf ]
```

**Raw artifact bytes** — sharded by stable_key for filesystem/bucket balance:
```
<key[0:2]>/<key[2:4]>/<key>
  dev : verbatim/_scrape-cache/<domain>/raw/...        (local disk)
  prod: gs://<RAW_BUCKET>/<domain>/raw/...              (GCS)
```

## Scrapers — the only network layer

Three scrapers, selected by the source's `scraper_default` (overridable per URL pattern):

- **`raw_http`** — plain Node `fetch()` + UA header. Buffer small bodies, **stream bodies >64 MiB** straight to GCS (Node's Buffer ceiling is ~2 GB). Inline in the scrape job.
- **`cloak`** — CloakBrowser (anti-bot Chromium) behind a **localhost HTTP sidecar** (`verbatim/scrapers/browser/server.mjs`, `POST /fetch` + `GET /healthz`), spawned once per task and kept warm. Handles per-origin Cloudflare warm-up. The scrape job POSTs the URL to `127.0.0.1:<port>/fetch`.
- **`playwright`** — for sites cloak doesn't cover.

**Escalation flow** (the core reliability pattern): `raw_http` response → `classify()` → `ok` | `dead` (404/410, don't escalate) | `blocked` (403/429/5xx, or anti-bot interstitial markers in the HTML head — "Just a moment...", "Attention Required!", etc.). On `blocked`, retry with `cloak`; if cloak succeeds, persist `cloak` as the effective scraper for that domain in `crawler_source_state`. If both fail, **pause the whole domain** (don't hammer it).

## Extractors — pure, fail-loud, gated

- **Interface** (`lib/verbatim/crawler/extractors/base.ts`): `{ name, version, extract(rawBytes, manifestRow) → { records, emitted_urls, errors } }`. Same input → same output, **no I/O beyond the bytes handed in**. Never a network call.
- **Registry** (`extractors/index.ts`): `Record<string, () => Extractor>` — each entry is a factory producing a fresh instance.
- **URL-pattern gating** (`lib/crawlerExtractorPatterns.ts`): `EXTRACTOR_URL_PATTERNS` maps each extractor name → an anchored (`^…$`) regex. **A registered extractor with no pattern entry never runs** — the pattern is how the extract job decides which extractor a cached artifact belongs to.
- **Discovery vs content split**: a `DISCOVERY_EXTRACTORS` set marks list/index extractors that **always run** and emit next-tier URLs into the queue. Everything else is a content extractor that **only runs once approved** (the "check them one by one" gate — keeps un-reviewed data out of the corpus).
- **Fail loud**: an extractor that can't faithfully extract throws `ExtractionFailed` — no fabrication, no silent truncation, no partial drop. The orchestrator keeps the raw artifact, marks per-extractor status `failed`, and persists no record.

## Raw cache + retention discipline

This is non-negotiable and is the reason the architecture exists (see the global CLAUDE.md "Scrape retention" rule and the `web-scraping` recipe):

1. **Persist 100% of raw bytes to durable storage BEFORE the parser runs.** The same scrape pass that would write parsed output writes the raw bytes first. Never `/tmp`, never memory-only.
2. **Keep them indefinitely until the consuming extractor is approved at scale.** Scale QA is the only thing that reveals whether the scrape is good, and that signal arrives late.
3. **Only after explicit human approval** may the raw cache for that extractor downgrade to stochastic sampling (e.g. ≤1% for drift detection). Pre-approval sampling is the same failure as no storage — the bytes you need are the ones you didn't sample.
4. **Every extractor starts `dirty`**; only an explicit human approve action (`/platform/crawler` → approve) flips it to `approved`. Bumping an extractor's `version` re-dirties it.

This dirty/reprocess shape isn't new — the reference impl had it before the crawler existed (`MARKDOWN_CONVERTER_VERSION` in `lib/markdownKeys.ts`): a version constant that, when bumped, marks everything produced by the old version stale for reprocessing. The extractor approval model is the same pattern, hosted in Cloud Run. Reach for the existing version-bump-dirty precedent rather than inventing a new one.

`useGcs()` picks the backend: `!!process.env.K_SERVICE` (Cloud Run auto-detect) `|| RAW_USE_GCS === '1'`. GCS reads/writes use the metadata-server OAuth token — no credentials file.

## Cloud Run jobs, image, deploy

- **`deploy-crawler-jobs.sh`** — idempotent create-or-update of the `crawler-scrape` + `crawler-extract` jobs (`--tasks`, `--task-timeout`, env, secrets) plus the Cloud Scheduler triggers. Owns job *creation*.
- **`cloudbuild.yaml`** — after bundling the image, updates the existing jobs to the new image SHA (skips provisioning if they don't exist). Deploys happen via the **git push → trigger** path only (see CLAUDE.md "triggered builds") — never `gcloud builds submit`.
- **Image** — multistage `Dockerfile`: a content-hashed `*-base` image holds `node_modules` + browser + Python venvs (rebuilt only when base inputs change); the final stage re-bundles app code and esbuild-bundles the TS extract entry (`crawler-extract.mts` → `dist/jobs/crawler-extract.mjs`) so prod runs it without `tsx`.
- **Entry scripts**: scrape entry is a plain `.mjs` (no transpile); extract entry is `.mts` bundled at build. Task 0 seeds each source's `seed_urls` on first run (idempotent `$setOnInsert`).
- **Secrets**: `MONGO_URI` and `CRAWLER_PG_PASSWORD` via Secret Manager `--set-secrets`. Job env: the raw bucket name, `RAW_USE_GCS=1`, project id, region, `CRAWLER_PG_SOCKET` (with the instance attached via `--set-cloudsql-instances`).

## Storage rule — queue/pipeline state goes on Cloud SQL, NEVER Firestore-compat

**Hard requirement, not a preference.** Prod Firestore-compat bills a read for every document a query **SCANS, not returns** — `maxTimeMS` caps latency, not reads — and local dev runs real MongoDB where scans are free, so "works locally / test passed" proves nothing. A crawler's queue queries (claim-next, has-work, manifest/progress counts, dedup checks) run per-poll over a collection that reaches the millions; on Firestore-compat that is a full-collection scan billed per cycle. The docpost reference impl ran exactly this shape and bled ~$140/day within **hours** (2026-06-04) before the manifest moved to Cloud SQL.

So when scaffolding this recipe on a new project:
- **Provision a Cloud SQL Postgres instance for the manifest/queue from day one** (reference: `docpost-crawler`, Postgres 16, db-custom-2-8192, zonal — instance-priced, scan billing does not exist). Jobs + web attach via the Cloud SQL connector socket (`CRAWLER_PG_SOCKET=/cloudsql/<connectionName>`, `--set-cloudsql-instances`); local dev via cloud-sql-proxy (`CRAWLER_PG_HOST/PORT`).
- **Claim with `SELECT … FOR UPDATE SKIP LOCKED`**, dedup with the `(source, stable_key)` PK, count with plain `GROUP BY` on the composite indexes — all fine on Postgres.
- **Do NOT put the manifest on the app's Mongo/Firestore-compat DB** "to keep one database." That was the original shape of this recipe and it is the documented disaster.
- Everything that *stays* on Firestore-compat is governed by `_directives/firestore-scan-audit.md` — composite index per query shape, counter-on-write for rollups, ALERT HARD before any scanning query ships.

## Firestore-in-Mongo-compat gotchas

The app DB is **Firestore in MongoDB-compatibility mode** (native `mongodb` driver, no Firestore SDK) — not real MongoDB. These bite the crawler's remaining Mongo-resident collections (`extractor_state`, `crawler_source_state`, `extraction_status`, corpus):
- **Scan billing** (the big one — see the storage rule above and `_directives/firestore-scan-audit.md`): reads are billed per document scanned; any query not served by a composite index full-scans and bills the matched slice. `distinct`/`$group`/field-`$sum` have no Firestore primitive and always scan.
- **`retryWrites=false`** is required in the URI (wire-protocol constraint).
- **Idle connections drop (~10 min).** Wrap idempotent ops (find/delete/replaceOne/idempotent updates) in retry; cursor iteration needs caller-side error handling.
- **`count` / `distinct` / `$group` scan every matched doc** (~0.5–0.85M/s) and hit a query deadline (seconds). A byte-sum `$group` over a million-doc source **times out**. Fallback: compute only the cheap state counts (hit/fail) live and leave total/queued null rather than aggregating at scale. **There is no live aggregation at corpus scale** — design counters as you write, not as you read.
- **`createIndex` is a silent no-op** under the app service account. Usable composite indexes must be created out-of-band (`gcloud firestore indexes composite create`, `mongodb-compatible-api` scope). Don't assume an index exists because the code "created" it.

## Counting model

Numbers on the inspection surface must each come from ONE snapshot, or they drift — a fast crawl mutates the manifest thousands of rows/sec, so any two independently-sampled counts disagree.

- **Scrape side: one aggregate call — against Postgres.** A single `aggregateSource(domain)` groups `crawl_manifest` by `{scraper, cache_state}` → the source funnel (`queued`/`hit`/`fail`/`total`) AND the per-scraper split, atomically. On Postgres this is a plain count-only `GROUP BY` on the composite indexes — cheap, instance-priced, no per-row billing (a field-`$sum` of bytes is still O(n) heap; the reference impl dropped `bytes_cached` from the dashboard instead). Queued rows carry `scraper:""` (enqueued before any scraper ran), so the whole queue attributes to the source's `scraper_default` (for a single-scraper source, the scraper row == the source funnel). The source header, source dropdown, table footer, and scraper row ALL read that one payload — never re-count in a second query or endpoint.
- **Extract side: live, not the rollup.** Extractor counts are derived LIVE from the `extraction_status` collection (one upserted doc per processed artifact), NOT from an `extractor_state.ok_count` rollup. A `$inc` rollup that flushes only when the extract process EXITS shows `ok=0` for hours during a long discovery run while the queue explodes, and it double-counts on re-runs. Derive `ok_count`/`error_count`/`last_run_at` by grouping over `extraction_status`.
- **Reconciliation invariant:** every hit is consumed by exactly ONE extractor (by URL shape), so `hit = Σ(extracted) + (awaiting extraction)`. `ok_count` = extractor RUNS on hit artifacts (one per artifact), not records parsed. A per-extractor row reads "done of inbox" where inbox = hits matching its URL pattern; at source level, `extracted = count(extraction_status)` vs `hit` gives the backlog with no patterns needed.
- Any count that reads a **Mongo/Firestore-resident** collection (e.g. `extraction_status`) must respect the Firestore deadline + scan billing (above): keep it index-served or counter-on-write; never `$group`/`distinct` over a large Firestore-compat collection on a request path.

## `/platform/crawler` — inspection + control

A superadmin page (`app/(app)/platform/crawler/index.tsx`) with a sources tree (per-domain queued/hit/fail/total/bytes, per-scraper split, extractor dirty count, escalation/pause state) and a filterable manifest log with inline raw-artifact preview. Backed by read APIs (`/sources`, `/sources/[domain]/manifest`, `/sources/[domain]/raw/[stable_key]`, `/extractors`, `/extractors/[id]/samples`) and two control actions: `POST /extractors/[id]/approve` (clear dirty) and `POST /sources/[domain]/resume` (unpause). **The page does not fire scrape/extract jobs** — that's the Scheduler/`gcloud run jobs execute`, gated on explicit human intent.

## Citation extraction (the one Python sidecar)

Citation parsing uses the `eyecite` Python library exposed as a localhost FastAPI sidecar (`workers/eyecite/`, `127.0.0.1:<port>`, spawned by the container entrypoint). This is the **only** Python permitted — all scraper and extractor logic is Node/TS. Don't add new Python; port to the extractor registry instead.

## Fit-to-Project

Before building, decide:
- **Project id / region / bucket names** — the reference impl hard-codes a GCP project, `us-east4`, and a `*-verbatim-raw-*` bucket. Yours differ; thread them as env (`RAW_BUCKET`, `GCP_PROJECT_ID`, `GCP_REGION`).
- **Cloud SQL instance for the queue** — non-optional (storage rule above); size to the crawl (the reference impl's db-custom-2-8192 zonal carries a 14M-row manifest). Provision it in `gcp-bootstrap.sh` alongside the buckets, before the first scrape.
- **Which sources, which scrapers** — one YAML per host. Start `raw_http`; let escalation move to `cloak`. Set `politeness.rps` per the target's tolerance (CDN-static can take 20; polite agency sites 2).
- **Job cadence + timeout** — daily long-lived warm execution is right when you have a persistent browser to keep warm; tune `--tasks` to the source mix and `--task-timeout` to the largest single execution.
- **Counter strategy** — given no live aggregation at scale, decide which counts you maintain incrementally vs compute live on cheap states only.
- **Discovery vs content** — which extractors seed URLs (always-run) vs produce corpus records (approval-gated).
- **Corpus sink** — where approved records land (a separate bucket/collection), kept distinct from the raw cache.

## Anti-Patterns

- **Writing a `run.ts` orchestrator or a `run+api.ts` "run the crawl" route** — the reference impl deleted exactly these twice. A crawl is two Cloud Run Jobs over a manifest queue, not an HTTP-request orchestration or a single driver script. If you're writing a loop that fetches URLs, you've rebuilt the wrong thing.
- **Parsing then discarding the source** — the disaster this recipe exists to prevent: an ingest that fetched HTML, ran a lossy strip, persisted only the stripped text, and threw away the raw. A formatting bug surfaced months later was unrecoverable without re-fetching millions of pages from a third-party CDN. Persist raw bytes before the parser, always.
- **Stochastic sampling before the extractor is approved** — the bytes you'll need to debug are statistically the ones you didn't keep. Sample only after explicit at-scale sign-off.
- **Running content extractors before a human approves them** — dumps un-reviewed, possibly-wrong data into the corpus. Only discovery extractors auto-run; content extractors gate on `approved`.
- **A network call inside an extractor** — breaks purity, makes extraction non-replayable against the cache, and re-hammers the source. Extractors see only the bytes handed in.
- **Hosting the manifest/queue on the app's Mongo/Firestore-compat DB** — the original shape of this recipe, and the documented disaster: every claim/has-work/count cycle full-scans and bills per document scanned (~$140/day in hours on the reference impl, 2026-06-04). Queue state goes on Cloud SQL Postgres, period.
- **`$group`/`count`/`distinct` over a large Firestore-compat collection** — scans (billed per doc) and times out at corpus scale. Maintain counters on write; reserve live `GROUP BY` counting for the Postgres-resident manifest.
- **Assuming `createIndex` worked** — it's a silent no-op under the app SA. Create composite indexes out-of-band and verify.
- **Per-request or every-few-minutes job firing** — pays browser cold-start repeatedly and fragments throttling. Fire long-lived warm executions on a schedule.
- **Registering an extractor without a URL-pattern entry** — it silently never runs. Every extractor needs an anchored pattern in the dispatch map.
- **Escalating to `cloak` without persisting the decision, or hammering a blocked domain** — record the effective scraper per domain and pause domains that block both scrapers; don't rediscover the block on every URL.
- **Adding Python for a new extractor** — eyecite is the only sanctioned Python. New extraction logic goes in the TS registry.

## Logging

- **Scrape job**: per task — claimed count, per-URL `{source, url, scraper, http_status, bytes, classify result, escalated?}`, domain pauses with reason. Cold-start: browser-sidecar up, Postgres + Mongo connected, seed counts.
- **Extract job**: per artifact — `{extractor, version, source, records, emitted_urls, errors}`; `ExtractionFailed` with the full reason and the retained artifact key. Skipped-because-unapproved counts per extractor.
- **Counts must reconcile**: `hit = extracted + awaiting`. Log when they don't — it means a state transition was lost.
- Job-level: execution id, task index, duration, items processed, exit reason. Cloud Run captures stdout JSON.
