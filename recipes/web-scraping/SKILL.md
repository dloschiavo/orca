---
name: web-scraping
description: >
  Use when building a scraper, crawler, or ingest pipeline against any
  external HTTP source — SPAs, anti-bot sites, directory listings, paginated
  feeds, public APIs, government docket pages. Covers the two-phase
  discovery/extraction split, anti-bot evasion, content validation, and the
  load-bearing R&D rule that 100% of raw fetches must land in non-ephemeral
  storage so parser iteration never costs another roundtrip.
---

# Web Scraping

## Architecture — Two Phases (mandatory)

**Phase 1 — Discovery:**
- Start from real entry points: sitemap.xml, index/directory pages, search results.  Strategy is usually breadth-first, not depth-first.
- Use Playwright — raw HTML fetch is useless on React/SPA sites before JS renders
- Wait for a specific content selector (not `networkidle` — unreliable for SPAs)
- For SPA sites: intercept XHR/fetch network calls to find the underlying API; call it directly
- Validate the page has actual results — a 200 with 0 results is a failure
- Deduplicate, write to a checkpoint file (e.g. `urls.json`), stop

**Phase 2 — Extraction:**
- Read checkpoint; never construct or guess URLs at this stage
- Persist raw bytes BEFORE parsing (see Raw Fetch Cache below) — parsing reads from the on-disk copy, not from the live response
- Validate content on each page (see Content Validation)
- Write results incrementally — not at the end

## Raw Fetch Cache (R&D Discipline)

**The rule:** during scraper R&D, 100% of raw fetch payloads are written to non-ephemeral storage *before* any parsing. Zero exceptions. Re-runs read from disk; the network is consulted only for URLs that aren't already cached.

**Why this is load-bearing.** Iteration on a parser is the #1 thing you do when building a scraper. Every bug in the HTML/PDF/JSON parser, every classifier edge case, every regex tweak — you fix it and you want to re-run. If the raw bytes are on disk, that re-run is a local for-loop. If the raw bytes are gone (or were never saved), every iteration burns another roundtrip to the target. That costs (1) wall-clock time per iteration, (2) target bandwidth you don't own, (3) your fingerprint's rate-limit budget, and (4) eventually a ban that ends the project. The target site is not your test fixture — your local cache is.

**Allowed cache locations** (in priority order):
1. Project-local cache dir: `<repo>/_scrape-cache/<source>/...`, `<repo>/_eval-runs/raw/...`, or a path the project's docs name
2. User-named persistent path (`~/Documents/...`, `~/Library/Caches/<project>/...`)
3. A dedicated GCS/S3 prefix when the cache is shared across machines

**Forbidden cache locations** — `/tmp`, `/var/tmp`, `/private/tmp`, `$TMPDIR`, anything under a path that the OS, Docker, Cloud Run, or your shell session wipes. **If you stage scrape output to /tmp, the next session wipe forces a full re-fetch — never do this.** This failure mode is silent: the bytes are gone before you notice, and you "fix" it by re-scraping, which papers over the bug instead of removing it. If you find yourself re-running a scrape because output went missing, the bug is the storage path, not the missing bytes.

**Disk layout that holds up over time:**

```
_scrape-cache/<source>/
  manifest.jsonl              # one row per fetched URL (see below)
  raw/
    <stable-key>.<ext>        # exact response bytes, unchanged
    ...
```

The stable-key derives from something the URL gives you for free (an event id, a docket number, a content hash of the URL). Never key on a sequence counter or "first-time-I-saw-it" timestamp — those change on every run and break dedup.

**Manifest** — one JSONL row per fetched URL, written immediately after the bytes hit disk:

```jsonc
{
  "url": "https://...",
  "local_path": "raw/abc123.pdf",
  "fetched_at": "2026-05-27T17:35:01Z",
  "http_status": 200,
  "content_type": "application/pdf",
  "content_length": 384921,
  "sha256": "..."        // optional; cheap insurance against silent corruption
}
```

The manifest is the index. Skip-if-exists logic reads it (or stats the file) before fetching; downstream parsers iterate it; debugging traces a finding back to a local file path, not a URL that may have rotted.

**Idempotency rule:** if `local_path` exists and matches the expected size/hash, do not re-fetch. Provide an explicit `--refresh` flag for cache invalidation; default behavior is always to use the cache.

**Concurrency rule:** the manifest is append-only. Workers append their own rows; never rewrite. If multiple workers hit the same URL, write-then-rename the raw file (so a half-written byte stream never gets indexed) and let the manifest carry duplicates — dedup at read time, not write time.

**Promotion to production.** Once parsing has been validated end-to-end against real data and the user has signed off, stochastic raw-storage is acceptable for production throughput — e.g. keep 1% of raw responses for ongoing drift detection. **Not before.** Stochastic-from-day-one is the same failure as no-storage: the bytes you actually need to debug are the ones not sampled.

## Fit-to-Project

Before writing code:
- What browser automation library is already in deps? Use it instead of adding Playwright if one exists
- What HTTP client does the project use? Match it for non-browser requests
- Where do external integrations live? Put scrapers there
- Match project async/error handling patterns

## Technology Defaults

- Playwright with a persistent browser context (shared cookies/session across all requests)
- Real headers: User-Agent, Accept-Language, Accept-Encoding, Referer
- playwright-stealth or equivalent to suppress headless fingerprints
- Keep a persistent browser context to evade bot detection
- Target block rate: <10%

## Content Validation

HTTP 200 is not sufficient. Check all of:
- Result count > 0 (find and check the result count element)
- Expected content selectors present (rules out CAPTCHA / bot challenge)
- Final URL matches expected pattern (catches silent redirect to login/homepage)
- Response matches expected schema (rules out "suggested alternatives" or fallback content)

## Anti-Patterns

- **Staging raw fetches to `/tmp` (or any ephemeral path)** — the next OS-level wipe (session restart, container restart, scheduled cleanup) deletes the cache without warning. The next parser-iteration run re-fetches from the target. You don't notice until you've burned a rate-limit budget or a ban. *Why this is the #1 anti-pattern:* unlike other anti-patterns it fails silently — there's no error, just a slow drift toward "why are we getting throttled?" Use a project-local or `~/Documents`-rooted path, full stop.
- **Parsing the response in-memory and discarding the bytes** — same failure mode as `/tmp`, even faster. Every parser bugfix re-fetches. Persist the raw payload first, then parse from disk.
- **No URL → local-path manifest** — you can't dedupe, can't resume a partial run, can't trace a downstream finding back to the byte stream that produced it. A 50-line jsonl writer pays for itself in the first re-run.
- **Re-fetching to "fix" a parser bug** — if your impulse on a parser regression is "let me re-run the scrape," the cache is wrong. The right fix is iterating against the on-disk raw copy until the parser is green, then promoting the parser, not re-pulling the source.
- **Stochastic raw-storage before the parser is validated** — once parsing is proven correct, sampling is fine for prod. Day-one sampling guarantees the one byte stream you need to debug is the one that wasn't saved.
- **Firecrawl** — 30-50% block rates; shared proxy state exposes scraping intent. Well-configured headless gets <10%.
- **Only checking HTTP status** — 200 with no results, a CAPTCHA, or a redirect is still a failure
- **Fresh browser context per URL** — loses session/cookies, re-triggers fingerprint detection
- **Constructing or guessing URLs** — only use URLs found in rendered DOM or API responses
- **Writing results at the end** — loses all progress on interrupt
- **`networkidle` as wait condition** — unreliable on SPAs; use a specific content selector

## Logging

- Log all URLs visited, with validation results (success/failure and reason)
- Log any anti-bot challenges encountered (CAPTCHA, bot detection pages)
- Log cache state per URL: `hit | miss | refresh`. A scraper that prints "miss" on every run is silently fighting the target instead of using its cache.
- Log summary stats: total URLs, cache hits, fresh fetches, successes, failures, block rate