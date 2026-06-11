# Firestore-compat scan-billing — realtime alert + audit

Binding whenever you write, review, or generate a `mongodb`-driver query in a
Goliath project whose **prod** datastore is Firestore in MongoDB-compat mode, and
whenever you're asked to audit or deploy such a project. This is the standard
Goliath deploy shape (docpost is live on it; other projects use the same
local-Mongo/Firestore-prod pattern but aren't deployed yet — so the bill hasn't
hit them *yet*).

## The trap

Goliath projects run the **same `mongodb` driver in both environments**, but the
engine differs and that split IS the trap:

- **Local dev = real MongoDB.** Collection scans are free. Everything looks fine.
- **Prod = Firestore in Mongo-compat mode.** The unit of billing is documents a
  query **SCANS, not returns.** Any query the compat layer can't serve from a
  **composite index** scans the entire matched slice and bills a read for every
  doc it touches. `maxTimeMS` caps **latency, not reads** — a query that "safely"
  times out at 3 s is still charged for everything it read first.

**Corollary (load-bearing):** "it works locally" / "the test passed" / "it's fast
on dev" is **NOT** evidence a query is safe. The code never says the word
"Firestore" — it's just the `mongodb` driver — so the trigger is the *deploy
setup*, not a keyword. Reason about the prod engine, every query, every time.

## Scope — this is NOT a crawler/scraping problem (it just surfaced there first)

The pattern bites **equally** in two scopes, and the gate + the audit must cover
**both** — do not scope either to the crawler:

- **Scraping / pipeline scope** — queue + state collections: claim-next, "has-work
  for source X", manifest/extraction-status counts, per-cycle supervisor checks.
- **Application / feature scope** — any user-facing or admin surface querying a
  collection that can grow large: React/SSR **page data loaders**, **API route
  handlers**, **admin dashboards / reports**, search/explorer pages, a user's
  document/workspace/authority lists, background jobs. A single unindexed
  `countDocuments` or `find().sort()` behind a page that renders on every visit is
  the same money-fire as the crawler loop — often worse, because pages get traffic.

When auditing, the feature/page queries are usually the *bigger* surprise than the
crawler, because nobody thinks of a list page as "a million-doc scan." Sweep them.

## Realtime alert — ALERT HARD, before it runs

This gate is **scope-agnostic**: it fires the same whether you're writing a
crawler claim loop, a React/SSR page loader, an API route handler, an admin
dashboard query, or a one-off script. Any `mongodb`-driver query, anywhere.

When you are writing or reviewing a query in the moment and it could
whole-collection scan in prod, do not bury it in prose and do not proceed
quietly. **Stop and raise it loudly** — a prominent ⚠️, naming:

1. the **collection** and the **query** (filter + sort),
2. **why** it scans (no composite index for that shape, or an op with no Firestore
   primitive — see catalog below),
3. the **blast radius**: `docs-in-collection × call-frequency = billed reads`, and
   roughly what that costs.

Then offer the fix (index / counter / relational) and **wait** — don't ship a
scanning query because it's expedient. A single unindexed query on a per-request
React/SSR loader or a polling dashboard is how the bill explodes.

### Scan patterns to flag

- A `find` / `findOne` / `findOneAndUpdate` / `countDocuments` / `updateMany` /
  `deleteMany` whose **(filter fields + sort)** is not covered by a composite index.
- `distinct(...)` and `$group`-into-buckets — **no Firestore primitive**, always scan.
- `$sum` / rollup of a field across matches — scans on every engine.
- `$regex` that isn't an anchored prefix; `$sort` without a matching index.
- ANY of the above on a **per-request / per-poll hot path** (page loaders, API
  handlers, dashboards, a crawler's per-cycle state checks) over a collection that
  can reach the millions — frequency multiplies the bill.

Note: a **plain filtered `count` IS cheap** *given a matching composite index*
(Firestore has a real `count()`). A slow `countDocuments({a,b})` means a missing
`(a,b)` index — add the index, don't blanket-avoid count.

### Driver `createIndex` is DDL — never await it on a request path

`col.createIndex(...)` is instant on local real Mongo but on Firestore-compat it
is a long-running DDL call that can block **indefinitely** (measured live: a
single `createIndex` on prod still blocked after 19 minutes, 2026-06-10) — and it
does NOT produce a working prod composite index anyway. So the common recipe
pattern `ensureXxxIndexes()` awaited inside `getDb()` / an enqueue / any request
path is a guaranteed first-request hang on prod: the request dies at the Cloud
Run timeout with work half-persisted (the diplomat chat incident: user turn
saved, no job, no reply, silent UI). Rules:

- **Never `await` `createIndex` anywhere a request waits on it.** Make the
  ensure-indexes pass fire-and-forget (`void ensure().catch(log)`), kicked off
  from instrumentation/boot — or skip it on prod entirely.
- **Even fast-failing `createIndex` is poison — it kills pooled connections.**
  Measured live against prod Firestore-compat (docpost, 2026-06-11): calls
  return quickly (~0.2–3.5 s, IAM-denied), but ~45% of a concurrent burst get
  their TCP connection KILLED by the Firestore LB (`MongoNetworkError:
  connection N closed`) — the unsupported option shapes (`unique`,
  `expireAfterSeconds`, `partialFilterExpression`) are the killers. A
  recipe-style `ensureIndexes()` burst (~70 calls) on a request path slaughters
  ~30 pooled connections per hit; with the typical `catch { _done = false }`
  retry-arming, EVERY hit re-fires it. On a long-lived instance (Cloud Run
  `minScale=1`) the driver pool degrades until checkout starves
  (`waitQueueTimeoutMS` defaults to 0 = wait forever) — then EVERY DB-touching
  route hangs to the platform timeout while static routes keep serving, the
  instance looks TCP-healthy, and with no HTTP liveness probe it is never
  reaped. That exact chain took the whole docpost site down for ~16 h
  (2026-06-10T23:26Z → 06-11T15:58Z). The ensure pass must short-circuit on
  Firestore-compat (detect `firestore.goog` in MONGO_URI) — not merely be
  un-awaited.
- **Real prod indexes are created via `gcloud firestore indexes composite
  create`**, not the driver. Treat the in-code ensure as a dev-Mongo convenience.
  Array fields need `--multikey` (a plain ascending field-config on an array
  fails the build with "Cannot index array").
- When auditing a Mongo-compat project pre-deploy, grep `createIndex` and flag
  every awaited call reachable from a request — AND every catch block that
  re-arms the ensure pass on failure (retry-forever turns one bad burst into a
  per-request burst).

## Firestore audit — how to sweep a codebase (do before deploying a Mongo-compat project)

1. **Inventory call sites across the WHOLE repo — both scopes.** Grep for driver
   calls: `\.(find|findOne|findOneAndUpdate|countDocuments|estimatedDocumentCount|distinct|aggregate|updateMany|deleteMany)\(`.
   Do **not** limit to the crawler/pipeline — sweep `app/` (page loaders, SSR,
   `+api` route handlers), `components/`, `lib/`, admin/dashboard surfaces, and
   scripts, as well as the scrape/state collections. For each, record the
   **collection**, the **filter** shape, and any **sort**. Tag each as
   scraping-scope vs feature-scope so neither is missed — the feature/page queries
   are the ones people forget.
2. **List prod indexes.** `gcloud firestore indexes composite list` (mongodb-compatible-api
   scope) — the actual composite indexes that exist in prod. (Driver `createIndex`
   does NOT create a working prod index here.)
3. **Diff query shapes vs indexes.** Flag every query whose (filter + sort) has no
   covering composite index → it full-scans in prod.
4. **Flag by operation** regardless of index: every `distinct`, `$group`-bucket,
   field-`$sum`, unanchored `$regex`, unindexed `$sort`.
5. **Flag hot paths.** Mark which flagged queries run per-request / per-poll
   (SSR/React page loaders, API routes, dashboard refresh, crawler state loops) —
   these are the budget-killers; frequency × collection size.
6. **Size the exposure.** For each: `docs scanned × calls/day × read-price` → a
   per-query $/day estimate. Rank; the top few usually dominate.
7. **Decide the fix per query** (below) and track to closed.

## Fixes

- **Point lookups / filtered counts** → add the matching **composite index**
  (`gcloud firestore indexes composite create`).
- **Aggregations / rollups / "how many in state X"** → **maintain a counter on
  write; never scan/count/distinct on read.** Serve dashboards from O(1) counters.
- **Queue / pipeline state** (claim-next, has-work, progress) → Firestore-compat
  is the wrong engine. Use a relational store: `SELECT … FOR UPDATE SKIP LOCKED`
  for contention-free batch-claim, instance-priced (no per-read billing), a
  `UNIQUE(source, key)` for dedup. This is the standard tool for work queues.

## Why this directive exists (war story — 2026-06-04, NOT operative state)

A docpost crawler scrape/pipeline session ran per-cycle state queries — a
supervisor `hasWork` across ~67 domains × 8 containers every 8 s, a
`distinct('source')` = 33 s full-scan of the 14M-doc `crawl_manifest`, plus
repeated count/aggregations — alongside a polling `/platform/crawler` dashboard
scanning the ~13M `static.case.law` slice per request. Each was a full-collection
scan billing every doc; it ran up a large Firestore bill in a few **HOURS** (the
dashboard alone ~$140/day). The tells were visible early (33 s `distinct`,
200 ms–1 s claims) but got read as *latency* instead of *scan-billing*. Local Mongo
hid all of it.
