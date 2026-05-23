---
name: web-scraping
description: >
  Use when scraping web content — SPAs, sites with anti-bot protection,
  directory listings, or paginated sources. Covers URL discovery, anti-bot
  evasion, and content validation.
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
- Validate content on each page (see Content Validation)
- Write results incrementally — not at the end

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

- **Firecrawl** — 30-50% block rates; shared proxy state exposes scraping intent. Well-configured headless gets <10%.
- **Only checking HTTP status** — 200 with no results, a CAPTCHA, or a redirect is still a failure
- **Fresh browser context per URL** — loses session/cookies, re-triggers fingerprint detection
- **Constructing or guessing URLs** — only use URLs found in rendered DOM or API responses
- **Writing results at the end** — loses all progress on interrupt
- **`networkidle` as wait condition** — unreliable on SPAs; use a specific content selector

## Logging

- Log all URLs visited, with validation results (success/failure and reason)
- Log any anti-bot challenges encountered (CAPTCHA, bot detection pages)
- Log summary stats: total URLs, successes, failures, block rate