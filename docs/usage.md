# PRD — Claude usage bar in the Topbar

## Goal

Show the current Claude rate-limit utilization as a small filled bar with a
percentage label in the app **Topbar**, immediately next to the "N agents
working" counter. The bar updates as new `rate_limit_event` stream messages
arrive and resets automatically when the window's `resetsAt` time passes.

## Event shape (reference)

The Claude CLI emits these continuously on stdout during any dispatch:

```json
{
  "type": "rate_limit_event",
  "uuid": "457286b7-e857-44b3-8a8b-e4619aca538d",
  "session_id": "c6d7e73a-9bd2-4cea-a7d0-a195760e7cc7",
  "rate_limit_info": {
    "status": "allowed_warning",
    "resetsAt": 1781972400,
    "utilization": 0.93,
    "rateLimitType": "five_hour",
    "isUsingOverage": false,
    "surpassedThreshold": 0.9
  }
}
```

- `utilization` — decimal 0-1 of the bucket's allotment consumed.
- `rateLimitType` — `five_hour` | `seven_day` | `seven_day_sonnet` (others may exist).
- `resetsAt` — unix epoch seconds at which the bucket rolls over to 0.
- `status` — `allowed` | `allowed_warning` | non-allowed (real limit hit; handled
  elsewhere by the rate-limit gate in `apps/server/src/services/concurrency.ts`).

## What already exists in the repo (do NOT rebuild)

- [x] Stream-json handler captures `rate_limit_info` from benign broadcasts and feeds them into the usage cache (already implemented: `apps/server/src/routes/stories.ts`).
- [x] In-memory cache + DB persistence of the latest utilization fraction via `recordUsageFraction` / `getUsageFraction` / `persistUsageFraction` / `loadUsageFractionFromDb` (already implemented: `apps/server/src/services/concurrency.ts`).
- [x] On-boot backfill from the most recent matching `rate_limit_event` in `activity_events` (already implemented: `backfillUsageFractionFromActivity` in `apps/server/src/services/concurrency.ts`).
- [x] `GET /api/rate-limit-usage` endpoint returning `{ usage: { fraction, updatedAt } | null }` (already implemented: `apps/server/src/app.ts`).
- [x] Frontend `api.usage.get()` client (already implemented: `apps/web/src/api.ts`).
- [x] A bar-with-% rendering already exists in `apps/web/src/components/PageHeader.tsx` using a green→yellow→red `heatColor()` ramp and a 24h staleness drop.

> **Reconciliation note:** the existing pipeline captures **only the `seven_day`
> bucket** — `extractUsageFraction` in `concurrency.ts` explicitly returns `null`
> for any other `rateLimitType`. The PRD's example event is `five_hour`, so this
> PRD's behavior is a genuine delta from what's shipped today. See ❓ Q01.

> **Stale directive warning:** `recipes/_directives/claude-usage.md` describes
> a puppeteer scraper at `apps/server/src/services/usage-scraper.ts` and
> `POST /api/rate-limit-usage/refresh` + `/push` endpoints. **None of that
> exists in the codebase.** The directive is stale and should be rewritten or
> deleted once this PRD lands, but that cleanup is out of scope here.

## Outstanding work (subject to the open questions below)

- [ ] Decide which bucket(s) drive the Topbar bar — see ❓ Q01.
- [ ] Extend `extractUsageFraction` (or add a sibling extractor) in `apps/server/src/services/concurrency.ts` so the chosen bucket(s) are captured from `rate_limit_event` messages. Today the function hard-filters to `seven_day`.
- [ ] Capture `resetsAt` alongside the fraction so the client can auto-zero the bar when the window rolls over. Today only `{ fraction, updatedAt }` is stored.
- [ ] Update the DB-persisted shape in `orca_settings.rateLimitUsageFraction` to include `resetsAt` and (if Q01 picks multi-bucket) the bucket type. Migration is just a JSON-shape change in that one row — no schema migration needed.
- [ ] Extend `GET /api/rate-limit-usage` to return the new fields. Confirm shape with ❓ Q03.
- [ ] Render the bar in `apps/web/src/components/Topbar.tsx`, placed immediately to the right of the "N agent(s) working" counter inside `.tb-status`. Bar style decision in ❓ Q04.
- [ ] On the client, treat the bar as 0% (or hide it — ❓ Q02) once `Date.now() >= resetsAt * 1000`. The bar should not require a network round-trip to zero out — the client knows when the window expires.
- [ ] Decide what happens to the existing `PageHeader.tsx` bar — see ❓ Q05.

## Open decisions

❓ Q01 — Which rate-limit bucket(s) should the Topbar bar reflect?
The CLI emits utilization for multiple buckets (`five_hour`, `seven_day`,
`seven_day_sonnet`, possibly more). The example event in the original brief
is `five_hour`, but the existing pipeline captures only `seven_day`. Pick one:
- (a) **`five_hour` only** — matches the example event, shows short-term throttling risk for the current session.
- (b) **`seven_day` only** — matches what's shipped today; shows long-horizon allotment.
- (c) **Whichever is highest right now** — bar reflects the most-utilized bucket; tooltip names which one.
- (d) **Both, as two stacked bars** in the Topbar (label each).
--- Q01 ---

/// Q01 ///

❓ Q02 — When `resetsAt` has passed, should the bar show "0%" or disappear entirely?
- (a) Render at 0% (empty bar, "0%" label) so the slot stays visually anchored.
- (b) Hide the bar entirely until the next `rate_limit_event` arrives.
- (c) Render at 0% only if we have ever seen a value for this bucket; otherwise hide.
--- Q02 ---

/// Q02 ///

❓ Q03 — What exactly does `GET /api/rate-limit-usage` return after this change?
Current shape: `{ usage: { fraction: number; updatedAt: string } | null }`.
- (a) Add `resetsAt: number` (epoch seconds) and `rateLimitType: string` to the existing single-bucket object.
- (b) Change to a map keyed by bucket: `{ usage: { five_hour: {...}, seven_day: {...} } }`. Required if Q01 picks (c) or (d).
- (c) Keep single-bucket but make the bucket selection server-side (Q01 = a/b/c) so the response stays flat.
--- Q03 ---

/// Q03 ///

❓ Q04 — Visual style for the Topbar bar.
The PageHeader bar today is an 88px × 5px filled rect with a heatmap color and a numeric `%`. The brief says "filled bar with #":
- (a) Reuse the existing graphical bar style and `heatColor()` ramp from `PageHeader.tsx` — keep it consistent.
- (b) Render as monospace ASCII (e.g. `[####······] 93%`) to match the terminal-ish feel of the rest of the Topbar (counter pulse, `mono` font on `next tick`).
- (c) Other (describe).
--- Q04 ---

/// Q04 ///

❓ Q05 — What happens to the existing usage bar in `PageHeader.tsx`?
Putting one in the Topbar would mean two bars on screen at once (Topbar is global; PageHeader renders per page).
- (a) **Remove** the `PageHeader` bar — Topbar is the single source.
- (b) **Keep both** — they show the same thing but in different surfaces.
- (c) Keep `PageHeader` but switch it to show a *different* bucket than the Topbar (only meaningful if Q01 picks a single bucket).
--- Q05 ---

/// Q05 ///

## History

- 2026-06-21 11:08 UTC — [dedup] initial draft: confirmed substantial overlap with existing `seven_day` usage pipeline (`extractUsageFraction`/`recordUsageFraction`/`getUsageFraction` in `concurrency.ts`, `/api/rate-limit-usage` in `app.ts`, bar in `PageHeader.tsx`); flagged stale `claude-usage.md` directive (refers to non-existent puppeteer scraper); checked sibling PRDs (`recipes/_directives/claude-usage.md` is the only overlap and is stale, not a supersession). Marked existing work as done with paths; atomized remaining delta into 8 outstanding items; opened Q01–Q05 covering the genuine product decisions (which bucket, reset behavior, API shape, visual style, fate of the existing PageHeader bar).
