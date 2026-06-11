---
name: extension-crawler
description: >
  Use when scraping a site that requires the user's real authenticated browser
  session (logged-in area, MFA-gated page, site with aggressive anti-bot that
  rejects headless). Covers a Chrome MV3 extension as the worker, a
  backend-owned URL queue with interval-based re-crawl, per-pattern content
  scripts as extractors, hidden background tabs with idle-gated pacing, and
  the three-timestamp job state model.
provides: [extension-crawler]
---

# Extension Crawler

A pattern for continuously scraping an authenticated site without ever running a headless browser. The user's own Chrome is the scraping vehicle — their cookies, fingerprint, and MFA state go along for free — so detection rates collapse to near zero on sites that otherwise block Playwright. A backend owns a URL queue; a Chrome MV3 extension polls it, opens a hidden background tab, runs a page-specific content script, upserts the result, and closes the tab. The loop self-paces around user activity so the human barely notices.

This recipe is **not** a replacement for the `web-scraping` recipe. Use `web-scraping` (Playwright) when a machine can log in and scrape unattended. Use this recipe when the site's auth, fingerprint, or rate-limit posture is tied to a real human's real browser.

Reference implementation: `Vine/MetaVine-2.0/` — files cited inline below.

## Architecture

Three layers, one-way data flow:

```
┌─────────────────────────────────────────────────────────────┐
│  BACKEND  (owns queue, schedule, canonical URL patterns)    │
│   crawl_populators   — pattern config (interval, extractors)│
│   crawl_history      — per-URL job rows                     │
│   POST /crawl-history?tab=queued&limit=1  → next job        │
│   POST /crawl-history  (mark dt_scraped, status, error)     │
│   POST /crawl-populators/upsert  (last_crawl_at, status)    │
│   POST /upsert        (entity data)                         │
└─────────────────────────────────────────────────────────────┘
                             ↑↓ HTTPS (localhost-only, self-signed)
┌─────────────────────────────────────────────────────────────┐
│  EXTENSION SERVICE WORKER  (worker loop)                    │
│   setInterval(_runPipeline, 30s)                            │
│     → /settings (crawl_enabled, require_idle)               │
│     → chrome.idle.queryState(60)                            │
│     → loop: fetch job → _crawl(url) → extract()             │
│                                                             │
│   _crawl(url): open hidden tab (active:false), 20s timeout, │
│                wait for crawl-result message, close tab,    │
│                enforce 10–12s min delay before next         │
└─────────────────────────────────────────────────────────────┘
                             ↑↓ chrome.runtime.sendMessage
┌─────────────────────────────────────────────────────────────┐
│  CONTENT SCRIPT (per-page extractor, injected by Loader)    │
│   Match URL pattern → inject matching extractor             │
│   Parse DOM → POST /upsert → sendMessage crawl-result       │
└─────────────────────────────────────────────────────────────┘
```

The extension is the **only** crawler. The backend never fetches the target site directly — it only queues, schedules, and records. This is the whole point: the backend can't pass the site's bot checks, but the user's Chrome already has.

## Data Model

Two collections. Keep them small and obvious.

### `crawl_populators` — pattern config (one row per canonical URL pattern)

```js
{
  url_pattern: "/orders?page={n}",   // canonical template with placeholders
  label: "Orders",
  method: "chrome",                  // reserved; future: "headless"
  warm_interval_days: 0.25,          // null = non-recurring; 0.25 = 6h; 1 = daily
  warm_page_cap: 145,                // how many {n}/{d} values to generate
  extractors: ["ordersExtractor"],   // named extractors the content script runs
  sample_rate: 1.0,                  // 0–1: fraction of crawls to save raw HTML
  aliases: ["/orders"],              // old/alt patterns that auto-resolve to canonical
  populator_enabled: false,          // admin UI kill-switch per pattern
  last_crawl_at: ISODate,
  last_crawl_status: "success" | "error",
  last_crawl_error: string | null,
  source_prd: "orders.md",           // optional: which spec defined this target
}
```

### `crawl_history` — per-URL job row

```js
{
  url: "https://site.com/orders?page=2",
  url_pattern: "/orders?page={n}",   // canonical (for group-by queries)
  dt_queued:  ISODate,               // when the row was enqueued
  dt_start:   ISODate,               // when the job is eligible to run (may be future)
  dt_scraped: ISODate | null,        // null = pending; set = completed (success or fail)
  status:     "success" | "error" | "timeout" | null,  // null while pending
  error:      string | null,
  priority:   0.5,
  source:     "manual" | "auto" | null,
}
```

**The three-timestamp rule is load-bearing.** `dt_scraped = null` is the authoritative "queued" signal. Never use `status = 'queued'`. A queued row has `status = null` too, because the job hasn't produced a status yet. Status is a property of *completed* jobs.

**Indexes:** `{url, dt_start}` unique (upsert key); `{status, dt_start}` for the tabbed list; `{dt_scraped}` for pending lookup.

## URL Canonicalization

Every concrete URL the extractor encounters maps to exactly one canonical template. Placeholders are literal:

```
/orders?page={n}          → {n} is a 1-based page index
/orders?startIndex={d}    → {d} is a decile offset (0, 10, 20, …)
/dp/{ASIN}                → per-item
/review/{reviewId}        → per-review
/account                  → singleton (no placeholder)
```

A `canonicalizeUrl(url)` helper in the extension converts any observed URL to its canonical form or returns `null` (unrecognized — don't enqueue). **Aliases in `crawl_populators`** auto-rewrite old patterns to canonical server-side, so that an old URL pattern and its canonical successor don't end up as two parallel rows.

## Scheduling & Concurrency

- **Poll cadence:** 30s (service worker `setInterval`). Each pipeline tick may process multiple jobs back-to-back but exits after a hard cap (e.g. 30 iterations) so the SW doesn't starve other messages.
- **Concurrency:** **one** background tab at a time. Enforced with a `_crawlerTabIds` set plus a `_pipelineRunning` flag. Do not parallelise — one tab is cheap; two tabs is a UX tax on the user.
- **Inter-crawl delay:** 10s + 0–2s jitter. Not a rate-limit nicety; it's a debounce against the site noticing rapid sequential requests from one browser.
- **Idle gate:** `chrome.idle.queryState(60)`. If `require_idle` is on and the user is active (keyboard/mouse in the last 60s), the tick is skipped. Do not force the tab open while the user is typing — the hidden tab still takes memory and network.
- **Tab timeout:** 20s. If the content script doesn't send `crawl-result` within 20s, force-close the tab and record `status = 'timeout'`. A hung content script is the #1 way the pipeline stalls forever.

## Server-Side Populator

A separate endpoint (`POST /crawl-populate`) walks `crawl_populators`, and for each enabled pattern with a non-null `warm_interval_days`, generates jobs:

```js
for each pattern where populator_enabled and warm_interval_days != null {
  for i in [0..warm_page_cap) {
    url = pattern.replace('{n}', i) || pattern.replace('{d}', i * 10)
    lastScraped = crawl_history.findOne({url}).dt_scraped
    dtStart = lastScraped ? lastScraped + intervalMs : now()
    upsert crawl_history {url, url_pattern, dt_queued: now(), dt_start: dtStart, dt_scraped: null}
  }
}
```

The upsert on `{url, dt_start}` makes this idempotent — calling the populator twice in a row is a no-op. Future-dated `dt_start` is normal: the pipeline just filters `dt_start <= now()` before picking a job.

## Content-Script Router

A single `Loader.js` runs on every page-match in the manifest. It URL-pattern-matches and dynamically imports the right extractor:

```js
if (location.pathname.startsWith('/orders'))       await import('./pages/Orders.js')
else if (location.pathname.startsWith('/review'))  await import('./pages/Reviews.js')
else if (location.pathname.startsWith('/dp/'))     await import('./pages/Product.js')
```

Each extractor does three things and exactly three things:

1. Parse the DOM with selectors scoped to that page.
2. `POST /upsert` with the entity payload (use `_setIfMissing`, `_addToSet`, etc. — never overwrite ground-truth fields).
3. `chrome.runtime.sendMessage({type: 'crawl-result', url, status: 'success'})` (or `'error'` with an error string).

If the extractor's selectors both fail, send `status: 'error'` with a descriptive message — don't send success with no data.

## Upsert Semantics

The `/upsert` endpoint supports modifier keys so extractors don't have to do read-modify-write:

```js
{
  asin: 'B0...',
  _setIfMissing: { status: 'ordered', dt_order_imputed: now },  // don't clobber existing state
  _addToSet:     { byLineContributors: ['Acme'] },              // grow a set field
  _setFirst:     { canonical_asin: 'B0...' },                   // first writer wins
  _unset:        ['stale_field'],
  _archive_rejection: { title, body, dt },                      // domain-specific snapshots
  // plain fields are $set
  public_price: 29.99,
}
```

Why it matters: different pages see different slices of the same entity. The orders page knows *when* you ordered but not *whether* it's shipped; the deliveries page knows shipped but not the order page's ETV. `_setIfMissing` is the tool for "I have a weaker source for this field." Use it ruthlessly.

## Extension Dedup

Two layers. Both exist for a reason.

**Service-worker side** (`MetaVine.js`): before every `/upsert`, stringify the payload and check an in-memory dedup map with a ~60s TTL. Identical payloads within the window are dropped. This kills the burst when the same page is scraped twice back-to-back (e.g. user hits refresh on a page the extension is also polling).

**Backend side:** `crawl_history` upserts on `{url, dt_start}`. Re-queueing an already-queued URL is a no-op, not a duplicate row.

Memory hygiene: the SW also purges its in-memory entity cache (`~60s` tick, `~10m` staleness window) and clears the dedup map at `~2m`. Unbounded maps in a service worker will eventually OOM it.

## Admin UI

A single `/admin/crawl` page (or equivalent tab in an existing admin shell):

- **Targets table** — every row in `crawl_populators` with `label`, `method`, `warm_interval_days`, `next_crawl_at` (computed: `last_crawl_at + interval`), `last_crawl_status`. Freshness indicator: green (due soon) → yellow (overdue) → red (last run errored). Filters: method, overdue-only, errors-only.
- **History tabs** — three tabs driven by `crawl_history`:
  - **Queued:** `dt_scraped = null`, sorted by `dt_start` desc.
  - **Scraped:** `dt_scraped != null AND status = 'success'`, sorted by `dt_scraped` desc.
  - **Failed:** `dt_scraped != null AND status IN ('error', 'timeout')`, sorted by `dt_scraped` desc.
- **Per-target drill-in** — click a target to see its last N history rows.
- **Settings panel** — `crawl_enabled` master switch and `require_idle` toggle, both backed by the backend `settings` key-value. The extension re-reads both on every tick, so toggling off stops the pipeline within 30s without a reload.
- **Heartbeat** — a small `POST /heartbeat` from the SW on each tick; the admin UI reads it to show "extension is alive, last seen Xs ago, N tabs open."

## Optional: Raw-Page Sampling

For debugging selector drift, the content script can stochastically POST the raw page HTML to `/crawl/raw-page` with `sample_rate` controlling the probability. Save to disk (not the DB), tagged by pattern + extractor name + timestamp. **This must be fire-and-forget** (`.catch(() => {})`); a failed sample write must never surface as a crawl failure.

## Fit-to-Project

Before implementing, answer:

- **What site is the target?** The pattern is a good fit only if the target site (a) requires login, (b) tolerates the user noticing an occasional background tab, and (c) has DOM stable enough to extract from. If any of those three is false, use Playwright (`web-scraping` recipe).
- **Does an extension already exist for this user?** If yes, extend it — one MV3 extension, many use cases. Don't ship a second.
- **What's the canonical URL shape?** Before writing any code, list every URL the extractors will encounter and collapse each to a template with placeholders. This becomes `crawl_populators` seed data.
- **Which fields are ground truth from which page?** Map each field to the page that owns it and the weaker sources. Use `_setIfMissing` for weaker sources.
- **What's the re-crawl interval for each pattern?** Singleton account pages: daily. Paginated lists of recent activity: 6h. Per-item detail pages: on-demand (no interval, enqueue on reference). Don't pick a universal interval; it's per-pattern.
- **Does the site have a daily reset boundary?** If yes, record timestamps at millisecond precision, never date-only. Date-only precision breaks around reset.
- **Where does `/upsert` live?** Match the project's existing DB driver and collection layout. If there's no entity collection yet, define it with the extractors in mind.
- **Localhost-only backend or public?** The reference impl is localhost-only (HTTPS with a self-signed cert, the extension trusts the cert via policy). A public backend is fine too, but requires a real cert and auth on every endpoint.

## Anti-Patterns

- **Using a headless browser instead of the user's Chrome.** The recipe exists *because* the target site detects headless. Swapping Playwright back in throws away the entire reason to pick this pattern. If the site doesn't detect headless, use `web-scraping` instead — you don't need an extension.
- **Crawling while the user is active.** A hidden tab still scrolls, still loads images, still competes for network and CPU. If the user is typing, skip the tick. `require_idle` is not a nice-to-have.
- **Parallel tabs.** One tab at a time, full stop. Two tabs double the detection surface, double the RAM hit, and usually produce worse results because one page's XHRs interfere with another's.
- **No tab timeout.** A content script that silently fails to send `crawl-result` will hold the pipeline forever. 20s hard cap, force-close, record `timeout`.
- **`status` as the queued-vs-done discriminator.** Use `dt_scraped = null`. `status` is a property of completed jobs — a queued job has no status yet, and conflating the two produces enum sprawl (`'pending'`, `'queued'`, `'running'`, etc. — you don't need any of them).
- **Overwriting ground-truth fields from a weaker source.** The orders page doesn't know the delivery status; if it `$sets` `status: 'ordered'` it will revert `delivered` back to `ordered` on every re-crawl. Use `_setIfMissing` for anything a stronger page might own.
- **Two URL patterns for the same page.** If `/orders` and `/orders?startIndex=0` both end up in `crawl_populators`, every crawl double-counts. Canonicalize on the extension side, resolve aliases on the backend side — one row, one pattern.
- **Date-only precision for activity timestamps.** If the site has a daily reset, date-only times straddle the reset and scramble "today vs yesterday" math. Use the site's Unix-ms attribute if present; fall back to text parsing only when it isn't.
- **Synchronous raw-HTML sampling.** A slow disk write shouldn't fail a crawl. Fire-and-forget, swallow errors.
- **Unbounded in-memory caches in the SW.** Dedup maps and entity caches leak. Purge on a timer. Service workers are long-lived; treat them like a server process.
- **Trusting only HTTP 200 from the content script.** If the DOM selectors failed, the page was a CAPTCHA challenge, or the site silently redirected to a login wall, the extractor saw nothing but the SW still got a message. Validate that the extractor produced non-empty output before marking `status: 'success'`.
- **Letting the extension construct URLs from first principles.** Only crawl URLs that either came from the populator or were emitted by another extractor (fan-out). Guessed URLs drift the moment the site adds a query param.
- **Skipping the heartbeat.** Without a heartbeat the admin UI can't tell "crawler off" from "crawler crashed" from "browser closed." Always wire a heartbeat.

## Logging

At minimum, log to the SW console (and optionally forward to a backend log collection):

- Pipeline tick start/end with `crawl_enabled`, idle state, and job count.
- Each crawl: `url`, open-tab timestamp, close-tab timestamp, result status, duration.
- Tab timeouts with the url and elapsed ms — these are the primary signal that a selector broke.
- Every `POST /crawl-history` completion with url, status, error.
- Dedup-hit counts per tick (spikes mean the extension is being re-triggered somehow).

Do not log payloads in production — personal data and large HTML samples both end up in `chrome://inspect` transcripts. Log identifiers, timings, and statuses.
