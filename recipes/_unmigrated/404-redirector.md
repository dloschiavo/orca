---
name: 404-redirector
description: >
  Middleware that intercepts 404s, checks a redirect DB for a matching path, and
  either issues a 301/302 or falls through to 404 while logging the miss. Includes
  a 404 distribution log for ops visibility into un-redirected dead paths.
---

# 404 Redirector

When a CMS item is deleted, renamed, or moved, its old URL becomes a dead link. Rather than baking redirect logic into each feature that creates URLs, a single middleware layer intercepts every would-be 404, checks a shared redirect DB, and either issues a 301/302 or passes through to the real 404 response — logging the miss either way. The miss log feeds an admin dashboard that shows which dead paths are getting traffic, making it easy to decide which ones need redirect entries.

This is a companion to the CMS PRD (`agent/cms.md`). When a CMS item is soft-deleted, its slugs return 404. If the operator wants to redirect those paths elsewhere, they add entries to the redirect DB managed by this system.

---

## Open Questions

1. **[OQ-R1] Middleware placement** — Framework-specific. Where in the request lifecycle does the redirect check sit? Before or after the normal route handler? Proposed: after the route handler resolves a 404 (so real routes are never shadowed), but before the 404 response is sent. Exact placement depends on the app framework.

2. **[OQ-R2] 301 vs 302 default** — 301 (permanent) is the right default for slug renames and retired content. 302 (temporary) is appropriate for seasonal redirects or A/B testing. Proposed: default to 301, with `status_code` field on each redirect entry so operators can choose per-entry. Should the UI allow 302, or is 301-only simpler?

3. **[OQ-R3] Redirect DB scope** — Is the redirect table global (one table for all sites/tenants), scoped per site (a `site_id` column), or scoped per domain? Multi-tenant deployments need per-site scoping. Single-tenant deployments can use a global table.

4. **[OQ-R4] Path matching strategy** — Exact path match only, or also support patterns, wildcards, or regex? Exact match is simple and fast (indexed lookup). Patterns/wildcards cover bulk redirects (e.g. `/blog/*` → `/posts/*`) but require ordered evaluation and are harder to index. Proposed: exact match only for v1; wildcard support as a future extension.

5. **[OQ-R5] 404 log fields** — Which fields to capture on a 404 miss: `path`, `referrer`, `timestamp` are low-risk. `user_agent` and `ip` raise privacy/GDPR considerations. Proposed: log `path`, `referrer`, `timestamp`, `user_agent` (truncated to browser family only). No raw IP. Confirm field list before implementing.

6. **[OQ-R6] 404 log retention** — How long to keep miss logs? High-traffic sites generate large volumes. Proposed: 90-day rolling retention, purged by a scheduled job or TTL index.

7. **[OQ-R7] Admin UI** — Is the redirect DB editor UI in scope for this system, or just the data model and handler? A minimal CRUD interface (list redirects, add, edit, delete) is useful but may belong in an existing admin area. Out of scope for this PRD unless specified otherwise.

8. **[OQ-R8] Permissions** — Should redirect DB management use docpost-amplify's permissions system (e.g. `requirePermission(request, 'redirector.manage')`)? Consistent with the CMS auth model. Confirm before implementing.

---

## Data Model

### `redirects` collection

```typescript
export interface IRedirect {
  redirect_id: string      // random stable ID
  from_path: string        // e.g. '/old-slug' — must begin with '/'
  to_url: string           // absolute URL or relative path; no validation restriction
  status_code: 301 | 302   // default 301
  notes?: string           // operator-facing memo; not user-visible
  created_at: Date
  updated_at: Date
  created_by: string       // user_id
}
```

> **[OQ-R3]** Add `site_id: string` if multi-tenant scoping is required.

**Indexes:**
- `{ from_path: 1 }` — unique (or `{ from_path: 1, site_id: 1 }` unique if multi-tenant). Primary lookup on every intercepted 404.
- `{ created_at: -1 }` — admin list view sort

**Why `from_path` is always relative:** the redirect check runs server-side against the incoming request path (no host). Storing absolute URLs in `from_path` would require stripping the host on every lookup. **Why `to_url` allows both:** operators legitimately redirect to external domains (e.g. a product that moved to a different site) as well as internal paths.

### `redirect_misses` collection (404 log)

```typescript
export interface IRedirectMiss {
  path: string
  referrer: string | null
  user_agent_family: string | null   // browser family only, not raw UA string
  timestamp: Date
}
```

> **[OQ-R5]** Confirm field list. No raw IP stored in proposed schema.
> **[OQ-R6]** TTL index on `timestamp` for rolling retention.

**Indexes:**
- `{ timestamp: 1 }` — TTL (`expireAfterSeconds: <retention_seconds>`)
- `{ path: 1, timestamp: -1 }` — admin dashboard aggregation (top paths by miss count)

---

## Handler Behavior

```
Incoming request
  → normal route resolution
      → match found → serve normally (redirector not involved)
      → no match (would 404):
          1. Look up from_path in redirects collection
             → match found → respond HTTP <status_code> Location: <to_url>
             → no match:
                 2. Write miss to redirect_misses (async, non-blocking)
                 3. Return HTTP 404 as normal
```

**Why non-blocking miss log write:** a slow DB write on every 404 would degrade the user-visible 404 response time. Fire-and-forget the miss log write; 404 UX is not held waiting for analytics.

**Why check redirects before logging the miss:** a redirect match means the path is handled — no need to log it as an unresolved miss.

```typescript
// Pseudocode — adapt to app framework's middleware / route-not-found hook
async function redirectorMiddleware(request: Request, next: () => Response): Promise<Response> {
  const response = await next()
  if (response.status !== 404) return response

  const { pathname } = new URL(request.url)
  const db = await getDb()

  const redirect = await db.collection<IRedirect>('redirects').findOne({ from_path: pathname })
  if (redirect) {
    return new Response(null, {
      status: redirect.status_code,
      headers: { Location: redirect.to_url },
    })
  }

  // Non-blocking miss log
  db.collection<IRedirectMiss>('redirect_misses').insertOne({
    path: pathname,
    referrer: request.headers.get('referer') ?? null,
    user_agent_family: parseUAFamily(request.headers.get('user-agent')),
    timestamp: new Date(),
  }).catch(() => {}) // swallow errors — miss logging must not affect the 404 response

  return response
}
```

---

## Admin Dashboard — 404 Distribution

The miss log powers a read-only admin view showing which paths are generating the most 404s:

```typescript
// Aggregation query — top N un-redirected paths in the last 30 days
db.collection('redirect_misses').aggregate([
  { $match: { timestamp: { $gte: thirtyDaysAgo } } },
  { $group: { _id: '$path', count: { $sum: 1 }, last_seen: { $max: '$timestamp' } } },
  { $sort: { count: -1 } },
  { $limit: 100 },
])
```

Each row in the dashboard shows: path, miss count, last seen, referrer sample. An "Add redirect" button in the row pre-fills `from_path` and opens the redirect editor.

---

## API Routes

> **[OQ-R8]** Auth guard: `requirePermission(request, 'redirector.manage')` from docpost-amplify's `lib/auth.ts`, consistent with CMS.

### `GET /api/redirects` — list all redirect entries (auth required)
### `POST /api/redirects` — create entry; body `{ from_path, to_url, status_code?, notes? }` (auth required)
### `PATCH /api/redirects/:redirect_id` — update entry (auth required)
### `DELETE /api/redirects/:redirect_id` — hard delete (auth required); redirect entries are not soft-deleted
### `GET /api/redirects/misses` — aggregated 404 miss report (auth required); query params: `days` (default 30), `limit` (default 100)

---

## Fit-to-Project

- **Middleware hook** — The `redirectorMiddleware` pseudocode above assumes a `next()` pattern. Adapt to the framework's 404 handler, `notFound()` hook, or catch-all route. ([OQ-R1])
- **Multi-tenant scoping** — Add `site_id` to `IRedirect` and include it in the `findOne` query and the unique index if the app serves multiple sites. ([OQ-R3])
- **Path matching** — Exact match is the default. If wildcard support is needed, the `redirects` collection query must change from a point lookup to an ordered scan, and index design changes significantly. Decide before implementing. ([OQ-R4])
- **UA parsing** — `parseUAFamily` needs a lightweight UA parser (e.g. `ua-parser-js`) to extract browser family without storing the raw string. Alternatively, skip UA entirely and remove `user_agent_family` from the miss schema. ([OQ-R5])
- **Log retention** — Set the TTL index value from an env var (`REDIRECT_MISS_RETENTION_DAYS`, default 90) so it's adjustable without a code change. ([OQ-R6])

---

## Anti-Patterns

- **Checking redirects before normal route resolution** — Running the redirect lookup on every request (not just 404s) adds a DB round-trip to every page load. Only run the redirector when the normal route handler has already determined there is no match.
- **Blocking 404 response on miss log write** — If the miss log write is synchronous and the DB is slow, every unmatched 404 becomes slow. Always fire-and-forget; swallow errors.
- **Storing raw IP in the miss log** — IP addresses are personal data under GDPR and similar regulations. Don't store them unless you have a legal basis and a retention/deletion policy. The proposed schema omits IP entirely.
- **Unique constraint on `from_path` without site scoping in multi-tenant** — A unique index on `from_path` alone will prevent two different sites from both having a redirect for `/about`. Add `site_id` to the unique index in multi-tenant deployments.
- **Soft-deleting redirect entries** — Unlike CMS items, redirect entries don't need soft delete. A deleted redirect should simply stop matching. Hard-delete is correct; the miss log will surface traffic to the now-unredirected path if it's still being hit.
- **Treating this as a CMS feature** — The redirector is intentionally separate from the CMS. Baking redirect logic into CMS item deletion creates coupling: the CMS would need to know redirect targets, manage redirect entries, and handle the UI. Keep the two systems independent.

---

## Logging

- On redirect match: log `from_path`, `to_url`, `status_code`, and the requesting path (for confirming the lookup worked). Optional — redirect matches are high-volume and may not need per-request logging in production.
- On redirect DB write (`POST`, `PATCH`, `DELETE`): log `redirect_id`, `from_path`, `to_url`, `created_by` / `updated_by`.
- Miss log write errors are swallowed (non-blocking) but should increment a counter metric if an observability layer is present.

---

## History

- **2026-04-08** — Initial PRD. Extracted from CMS PRD discussion when OQ-15 (deletion behavior) was resolved as soft-delete-with-404, not soft-delete-with-301. Eight open questions documented.
