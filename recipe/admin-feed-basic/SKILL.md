---
name: admin-feed-basic
description: >
  Use when adding an operator-attention feed — a single platform-staff page
  that ranks "things that need a human" across the app: unviewed chats,
  system exceptions, and security-notable events. Defines one `feed_items`
  collection, an `emitFeedItem()` helper that any producer in the app can
  call (idempotent via `dedupe_key`), an auto-resolve helper keyed on
  `(source_collection, source_id)`, the canonical `/platform/feed` page,
  the API surface (`GET /api/platform/feed`, `PATCH /api/platform/feed/[id]`,
  `POST /api/platform/feed/bulk`), and three baked-in producers
  (chat-unviewed, system-exception, security-notable). The deep recipe
  layers more producers on top of this one without touching the model
  or page.
dependencies:
  requires: [admin-routing]
  capabilities:
    auth: otp-auth
    design-system: admin-only-notus
provides: [admin-feed]
---

# Admin Feed (Basic)

A single platform page at **`/platform/feed`** that ranks every "thing the operator should look at" in one priority-sorted list. Today the dashboard exists for stats; the feed exists for *attention*. Stats answer "how is the system doing"; the feed answers "what should I do next."

The insight is that every operator-attention signal in the app — an unreviewed user-agent chat exchange, a 5xx that just fired, a burst of failed logins — has the same lifecycle (open → snoozed | resolved | dismissed) and wants the same UI affordances (filter, snooze, dismiss, deep-link into context). Modelling them as one collection with one mutation API and one page lets every producer in the codebase contribute by calling a single helper. New producers don't ship new admin pages; they ship one `emitFeedItem()` call.

This is the **basic** recipe: it owns the model, the helper, the page, and three producers. The **`admin-feed-deep`** recipe layers additional producers (signature workflow, drive sync, lifecycle, billing, etc.) on top of this same machinery — same collection, same emitter, same page.

Reference implementation: `docpost-app/app/(app)/platform/feed/index.tsx`, `docpost-app/app/api/platform/feed+api.ts`, `docpost-app/lib/adminFeed/emit.ts`.

---

## Canonical Path & Sidebar

- Page: **`/platform/feed`** — directory-style (`app/(app)/platform/feed/index.tsx`), platform-level per `admin-routing/SKILL.md` § Two trees. Sibling pages: `/platform/chat`, `/platform/prompts`, `/platform/deploy`. Never flat-file as `admin-feed.tsx`, `platform-feed.tsx`, or nested under `/admin/**`.
- Sidebar label: **"Feed"**, icon `stream`. Place it directly above the dashboard "Chat" entry in the platform nav so the operator's first stop after login is the queue, not a stats page.
- Auth gate: `requireAdmin` on the route + on every API endpoint under `/api/platform/feed`.

---

## Data Model

One collection, `feed_items`. Every event from every producer lands here.

```ts
export type FeedCategory = 'knowledge' | 'system' | 'security'
export type FeedPriority = 'critical' | 'high' | 'normal' | 'low'
export type FeedState    = 'open' | 'snoozed' | 'resolved' | 'dismissed'

export interface IFeedItem {
  _id?: ObjectId
  organization_id: string | null  // null = platform-wide (cross-org)
  type: string                    // dotted path: 'chat.unviewed' | 'system.exception' | 'security.failed_login_burst'
  category: FeedCategory          // top-level grouping for the page tabs
  priority: FeedPriority
  title: string                   // one-line title (rendered bold in the row)
  preview: string                 // one-line subtitle (truncated to 200 chars in the row)
  link: string                    // deep link the row navigates to on click — RELATIVE path, never absolute URL
  source_collection: string       // e.g. 'chat_2026_05', 'system_exceptions', 'audit_log'
  source_id: string               // _id (hex) of the source row
  dedupe_key: string | null       // when set: at most one open item with this key exists
  count: number                   // bumped on dedupe-hit; UI shows ×N when > 1
  state: FeedState
  snoozed_until: Date | null
  resolved_by: string | null      // user_id of the admin who resolved
  resolved_at: Date | null
  first_seen_at: Date             // time of the first emit for this item
  last_seen_at: Date              // bumped on every dedupe-hit
  created_at: Date                // identical to first_seen_at; kept separate so it never drifts on bumps
}
```

### Indexes

```ts
db.collection('feed_items').createIndexes([
  // Default page sort: open items, most recent first, with priority pinning
  { key: { state: 1, priority: 1, last_seen_at: -1 }, name: 'feed_state_priority_seen' },

  // Dedupe lookup: only one open item per dedupe_key. Partial filter
  // restricts uniqueness to open items so resolved/dismissed history coexists.
  { key: { dedupe_key: 1 }, name: 'feed_dedupe_open',
    unique: true,
    partialFilterExpression: { state: 'open', dedupe_key: { $type: 'string' } } },

  // Auto-resolve lookup
  { key: { source_collection: 1, source_id: 1 }, name: 'feed_source' },

  // Snooze cron
  { key: { state: 1, snoozed_until: 1 }, name: 'feed_snooze',
    partialFilterExpression: { state: 'snoozed' } },

  // Category filter
  { key: { category: 1, state: 1, last_seen_at: -1 }, name: 'feed_category' },
])
```

The dedupe index's partial filter must include both `state: 'open'` AND `dedupe_key: { $type: 'string' }`. **Why:** items emitted without a `dedupe_key` set the field to `null`. Without the type check, every null-keyed item collides on the unique index after the first one is open, and every emit after the first throws. (Producers that opt out of dedup must be free to emit unboundedly.)

---

## Emitter — `emitFeedItem`

The whole point of one collection + one mutation API is that producers don't think about the page; they call one function. The function lives in `lib/adminFeed/emit.ts` and is the only public surface for *writing* to the feed.

```ts
export interface EmitFeedItemArgs {
  type: string                    // dotted path; see Type Vocabulary below
  category: FeedCategory
  priority: FeedPriority
  title: string
  preview: string
  link: string
  source_collection: string
  source_id: string
  organization_id?: string | null // default null
  dedupe_key?: string | null      // default null (no coalesce)
}

export async function emitFeedItem(args: EmitFeedItemArgs): Promise<{ _id: string; coalesced: boolean }>
```

Behavior:

1. **No `dedupe_key`** — insert a new row with `count: 1`, `state: 'open'`, `first_seen_at = last_seen_at = created_at = now`. Return `{ coalesced: false }`.

2. **`dedupe_key` set** — `findOneAndUpdate({ dedupe_key, state: 'open' }, { $inc: { count: 1 }, $set: { last_seen_at: now, title, preview, priority, link } }, { returnDocument: 'after' })`. If a doc was returned, that's the coalesced existing item — return `{ coalesced: true }`. If null, insert a new row (race with the unique index) and on `E11000` retry the update once.

3. **Allowed updates on coalesce** are `count`, `last_seen_at`, `title`, `preview`, `priority`, `link`. **Not** `category`, `type`, `source_*`, or `organization_id` — those identify *which* feed item this is, and a producer that needs to mutate them is making a different item, not coalescing.

The retry-on-E11000 path is load-bearing: between the `findOneAndUpdate` and the insert, a concurrent emitter may have inserted the row, and the unique index throws. Retrying the update covers that race.

### Auto-resolve helper

```ts
export async function resolveFeedItemsBySource(
  source_collection: string,
  source_id: string,
  resolved_by: string,
): Promise<{ updated: number }>
```

Updates every open or snoozed item for the source to `state: 'resolved'`. Producers call this when their source resolves (chat read past a message, exception fingerprint marked benign, security event acknowledged externally). `dismissed` items are not flipped — dismiss is the operator's explicit "stop showing me this," and a fresh source resolution shouldn't undo it.

---

## Type Vocabulary

The `type` field is a dotted path: `<producer>.<event>`. The producer prefix groups related events; the suffix names the specific signal. This lets the page filter on `type` prefixes (`type: { $regex: '^chat\\.' }` for "all chat events") without parsing.

The basic recipe registers three producers:

| Producer prefix | Category | Events (basic) |
|---|---|---|
| `chat.*` | knowledge | `chat.unviewed` |
| `system.*` | system | `system.exception` |
| `security.*` | security | `security.failed_login_burst`, `security.role_change`, `security.audit_anomaly` |

The deep recipe extends this vocabulary; see `admin-feed-deep/SKILL.md`. Adding a new producer is one new prefix in the table, one or more `emitFeedItem` call sites, and one resolver call site if the source has a resolution event.

---

## Producer 1 — `chat.unviewed`

The signal: **the operator hasn't read every chat message yet.** When chat traffic comes in faster than the operator reads it, the feed item exists; once they've read up to the latest message in every org, the feed item resolves.

### Emit point

In the chat-message write handler (`POST /api/chat/messages` for `chat-support`, plus the public-chat write handler for `public-contact-chat`), after the message is inserted, fire-and-forget:

```ts
await emitFeedItem({
  type: 'chat.unviewed',
  category: 'knowledge',
  priority: 'normal',
  title: `Unviewed chat in ${org_name}`,
  preview: `${sender_name}: ${content.slice(0, 160)}`,
  link: `/platform/chat?org=${organization_id}`,
  source_collection: collectionName,           // e.g. 'chat_2026_05'
  source_id: insertedId.toHexString(),
  organization_id,
  dedupe_key: `chat.unviewed:${organization_id}`,  // one open item per org
})
```

The dedupe key is per-org, not per-message. **Why:** ten messages in one org should be one feed entry with `count: 10`, not ten entries that flood the page.

Public-contact-chat (no `organization_id`) uses `dedupe_key: 'chat.unviewed:contact'` and `link: '/platform/chat#contact'`. Same coalescing semantics, single bucket.

### Resolve point

`POST /api/chat/read` (the read-receipt write handler) — after the receipt update succeeds, call:

```ts
await resolveFeedItemsBySource('chat_unviewed', `org:${organization_id}`, session.user_id)
```

Note the synthetic `source_collection: 'chat_unviewed'` + `source_id: 'org:{id}'` pair — they don't reference a literal Mongo doc, they're a *bucket* identifier matching what `emitFeedItem` should pass. Use this synthetic pair on **both** sides; do NOT pass the actual `chat_YYYY_MM` collection + message id, because the dedupe coalesces many messages into one item and there's no single message to resolve against.

To make this consistent, the chat-unviewed emitter sets `source_collection: 'chat_unviewed'`, `source_id: 'org:${organization_id}'` (or `'contact'` for public chat). The actual message id is *not* the source identity for this item type — the bucket is.

This is the cleanest way to model "ambient unread state": one feed item per bucket, the bucket is what the resolver targets, the actual rows are a forensic detail that lives in the source chat collection itself.

---

## Producer 2 — `system.exception`

The signal: **the server threw something.** Every uncaught exception in an `+api.ts` handler (or its FastAPI equivalent) becomes one feed item, deduped on a stack-fingerprint hash so the same crash in a hot loop is one row, not a thousand.

### `system_exceptions` collection

A small companion collection holds the raw exception data — the feed row links to it.

```ts
export interface ISystemException {
  _id?: ObjectId
  fingerprint: string             // sha256(error.name + first frame + url path)
  error_name: string              // e.g. 'TypeError'
  error_message: string           // e.g. 'Cannot read property X of undefined'
  stack: string                   // full stack
  url: string | null              // request URL when triggered from an HTTP handler
  user_id: string | null          // session user when applicable
  organization_id: string | null
  count: number                   // bumped on fingerprint hit
  first_seen_at: Date
  last_seen_at: Date
}
```

Index: `{ fingerprint: 1 }` unique. Independent of `feed_items.dedupe_key` — these track exception identity at the data layer; the feed dedup tracks attention identity.

### Emit point

A single `recordException(err, request)` helper that producers wrap their handler bodies in (or that the framework's error boundary calls). The helper:

1. Computes `fingerprint = sha256(error_name + first_stack_frame + url_path_without_ids)`. URL ids are stripped (replace `/[a-f0-9]{24}` and `/\d+` with `/:id`) so the same handler crashing on different ids coalesces.
2. Upserts the `system_exceptions` row by fingerprint, bumping `count` and `last_seen_at`.
3. Calls `emitFeedItem` with:

```ts
await emitFeedItem({
  type: 'system.exception',
  category: 'system',
  priority: 'high',
  title: `${error.name}: ${error.message.slice(0, 80)}`,
  preview: `${url ?? '(non-http)'} — ${first_stack_frame}`,
  link: `/platform/feed#exception-${exceptionDocId}`,  // opens detail panel; see § Detail panels
  source_collection: 'system_exceptions',
  source_id: exceptionDocId,
  organization_id,
  dedupe_key: `system.exception:${fingerprint}`,
})
```

Priority is `high` by default. Use `critical` only for exceptions whose handler explicitly tags them as such (e.g., a payment-write failure surfaces as `priority: 'critical'`); ordinary 5xx are `high`.

### Resolve point

There is no automatic resolve — exceptions are resolved when the operator clicks the row, reads the stack, and either dismisses (false alarm / known-and-tracked) or fixes the code and resolves (the rebuild plus the next clean run is enough; we don't auto-resolve on a successful subsequent request because that would clear active incidents the moment one good request lands).

### Anti-pattern: emitting from inside a `try`/`catch` fallback path

If a handler catches its own error and returns a 500, the global error boundary doesn't see it and `recordException` never fires. Either let the exception propagate, or call `recordException(err, request)` explicitly inside the catch *before* returning. The recipe's contract is "every exception that produced a 5xx ends up in the feed" — a swallowed error that returns a 500 still counts.

---

## Producer 3 — `security.notable`

Three sub-events in the basic recipe. Each is one `emitFeedItem` call from the auth or RBAC layer.

### `security.failed_login_burst`

Emit when one email accumulates **5 failed login attempts within 10 minutes**. The auth handler tracks per-email failure counts in memory (or a small `auth_failures` collection for multi-instance deploys). When the threshold trips:

```ts
await emitFeedItem({
  type: 'security.failed_login_burst',
  category: 'security',
  priority: 'high',
  title: `5+ failed logins for ${email} in 10min`,
  preview: `Source IP: ${ip}; user agent: ${ua.slice(0, 80)}`,
  link: `/admin/users?email=${encodeURIComponent(email)}`,
  source_collection: 'auth_failures',
  source_id: email,                          // synthetic — email is the bucket
  organization_id: null,
  dedupe_key: `security.failed_login_burst:${email}`,
})
```

Resolve when a successful login for that email lands, OR when the operator dismisses.

### `security.role_change`

Emit on every successful update to `users.role`. Produced from the user-edit handler in `admin-user-crud`:

```ts
await emitFeedItem({
  type: 'security.role_change',
  category: 'security',
  priority: 'normal',
  title: `Role change: ${target.email} → ${newRole}`,
  preview: `By ${actor.email} (was ${oldRole})`,
  link: `/admin/users/${target.user_id}`,
  source_collection: 'audit_log',
  source_id: auditLogEntryId,
  organization_id: null,
  dedupe_key: null,                          // every role change is its own row
})
```

Each role change is its own feed entry — coalescing would hide rapid-fire promotions/demotions from the same actor.

### `security.audit_anomaly`

Emit when an `audit_log` entry is created with `severity: 'high'` (a tag the producer of the audit row sets, not derived). Examples in scope: bulk delete, super-admin permission grant, session-revocation cascade. Producer sets `severity` at write time; the audit-log writer fans out to `emitFeedItem` automatically when severity is high:

```ts
await emitFeedItem({
  type: 'security.audit_anomaly',
  category: 'security',
  priority: 'high',
  title: `${entry.action}: ${entry.summary}`,
  preview: `By ${actor.email} on ${target.kind} ${target.id}`,
  link: `/platform/audit/${entry._id}`,
  source_collection: 'audit_log',
  source_id: entry._id.toHexString(),
  organization_id: entry.organization_id ?? null,
  dedupe_key: null,
})
```

Resolve point: operator dismisses or resolves manually. The audit log itself is append-only; there is no "this audit entry is fixed" lifecycle.

---

## API Endpoints

All routes `requireAdmin`. All endpoints under `/api/platform/feed/**` mirror the page tree per `admin-routing/SKILL.md` § API mirroring.

### `GET /api/platform/feed`

```
GET /api/platform/feed?state=open&category=system&priority=critical,high&type=system.&cursor=…
```

| Param | Notes |
|---|---|
| `state` | `open` (default) | `snoozed` | `resolved` | `dismissed` | `any` |
| `category` | comma-separated subset of `knowledge`, `system`, `security` |
| `priority` | comma-separated subset of `critical`, `high`, `normal`, `low` |
| `type` | exact type, OR a prefix ending with `.` (e.g. `chat.`, `security.`). Server treats trailing `.` as `$regex: '^prefix\\.'` |
| `org` | `organization_id` filter; pass literal `null` to filter platform-wide items only |
| `cursor` | opaque cursor encoding `last_seen_at` + `_id` (same shape as `admin-chat`'s cursor) |

Response:

```ts
{
  items: IFeedItem[],            // page size 50
  nextCursor: string | null,
  stats: {
    total_open: number,
    by_category: { knowledge: number; system: number; security: number },
    by_priority: { critical: number; high: number; normal: number; low: number },
  } | null                       // null on cursor follow-ups (see § Stats)
}
```

### `PATCH /api/platform/feed/[id]`

```
PATCH /api/platform/feed/{id}
body: { state: 'resolved' | 'dismissed' | 'open', snoozed_until?: ISO string }
```

- `state: 'resolved'` requires no body; sets `resolved_by = session.user_id`, `resolved_at = now`.
- `state: 'snoozed'` requires `snoozed_until` (ISO date in the future). Reject past dates with 400.
- `state: 'dismissed'` is identical to resolved at the data layer but distinguishes "I looked at this and decided not to act" from "I looked and acted." Both leave the row out of the default `state=open` filter.
- `state: 'open'` reopens — used by the snooze cron, and by the operator's "undo" affordance on a freshly-dismissed row.

### `POST /api/platform/feed/bulk`

```
POST /api/platform/feed/bulk
body: { filter: { type?: string; category?: FeedCategory }, action: 'resolve' | 'dismiss' | 'snooze', snoozed_until?: ISO }
```

For "mark all unviewed chats as reviewed." Operates on `state: 'open'` rows matching the filter. Returns `{ updated: number }`.

The bulk filter is intentionally narrow — `type` and `category` only. Allowing arbitrary filters opens a footgun where an operator with a slightly-wrong filter resolves the wrong N rows in one click.

### Snooze cron

A periodic worker (interval 60s) flips `{ state: 'snoozed', snoozed_until: { $lte: now } }` to `state: 'open'`. Either a real cron, a pg/mongo-backed scheduled task, or a server-startup interval timer in single-instance deploys — the recipe doesn't pick one; whichever the host project's `stack` already provides.

---

## Page Layout

Standard Notus page shell. Header (gradient background, page title "Feed", subtitle "Your attention queue"). Below the header:

1. **Stats strip** — three tiles: open count by category. Click a tile → filters the list to that category (writes the URL hash).
2. **Filter bar** — three controls in a row:
   - Category multi-select (`knowledge`, `system`, `security`)
   - Priority multi-select (`critical`, `high`, `normal`, `low`)
   - State select (`open` default, plus `snoozed`, `resolved`, `dismissed`, `any`)
3. **List** — vertical stack of feed-item rows, NOT a table. Each row is a card.

### Row anatomy

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ● [icon] [TITLE]                                  [×3]    [⏱ snooze] [✓] │
│         preview text truncated to one line                          [✕]  │
│         category · priority · age · org-name                             │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Left dot** is the priority pip (red `critical`, orange `high`, blue `normal`, gray `low`). Same paired Notus color tokens as `admin-chat`.
- **Icon** is a per-category FontAwesome glyph: `comment-alt` for `knowledge`, `bug` for `system`, `shield-alt` for `security`.
- **Title** is the row's primary affordance — the row is a button, click anywhere except the trailing controls navigates to `link`.
- **Count chip** `×N` only renders when `count > 1`.
- **Trailing controls** (right-aligned):
  - Snooze (`⏱`) opens a one-click 24h / 1w / custom menu.
  - Resolve (`✓`) flips state to `resolved` optimistically.
  - Dismiss (`✕`) flips state to `dismissed` optimistically.
- **Meta line** (small, gray) shows category, priority, age (`12m ago`), and org name when `organization_id !== null`.

### Empty state

When the open list is empty, render a centered card: `<icon: check-circle> All clear. No items need attention.` This is the *desired* state; make it look like a reward, not an error.

### Loading state must be visually distinct from "no results"

Same rule as `admin-chat`: a header spinner is the freshness signal during refetch; an empty list with no spinner means actually-zero. Don't hide the list during refetch — keep prior rows visible so the operator can keep working while filters re-query.

---

## Detail Panels

Clicking a `system.exception` row should expand the row into a detail panel with the full stack and the linked `system_exceptions` doc. Modeled the same way `admin-chat` row-expand works: clicking the row toggles `expanded` state; the panel renders below. For `chat.unviewed`, clicking navigates to `/platform/chat?org=…` (no inline expand — the chat review is a separate surface). For security events, clicking navigates to `/admin/users/{id}` or `/platform/audit/{id}` per the `link`.

The rule: **if the row has anywhere meaningful to navigate to, navigate. If the row's payload is best viewed inline (raw stack), expand inline.** `system.exception` is the only basic-recipe type that expands; the others navigate.

---

## Hash Routing

Per `admin-routing/SKILL.md` § Hash Hook. The feed page uses the hash for:

- Filter state (`#open/system` = `state=open`, `category=system`)
- Per-row deep links FROM other pages (`/platform/feed#exception-{id}` opens the page with that exception's row pre-expanded)

Filter changes write `replaceState`; expansion writes `pushState` so Back closes the panel. Same modal-back semantics as `admin-chat`.

---

## File Map

| File | Purpose |
|---|---|
| `app/(app)/platform/feed/index.tsx` | Page shell — stats strip, filter bar, list, row component |
| `app/api/platform/feed+api.ts` | `GET` — list, filter, paginate, stats |
| `app/api/platform/feed/[id]+api.ts` | `PATCH` — state transitions |
| `app/api/platform/feed/bulk+api.ts` | `POST` — bulk action |
| `lib/adminFeed/types.ts` | `IFeedItem`, `FeedCategory`, `FeedPriority`, `FeedState`, `EmitFeedItemArgs` |
| `lib/adminFeed/emit.ts` | `emitFeedItem`, `resolveFeedItemsBySource` |
| `lib/adminFeed/recordException.ts` | `recordException(err, request)` — fingerprint + dual-write to `system_exceptions` and `feed_items` |
| `lib/adminFeed/snoozeCron.ts` | Periodic unsnoozer |
| `models/FeedItem.ts` | Type definitions for the collection |
| `models/SystemException.ts` | Type definitions for the companion collection |
| `components/FeedRow.tsx` | One row card |
| `components/FeedFilterBar.tsx` | Filter bar |
| `components/FeedStatsStrip.tsx` | Three-tile stats strip |

---

## Fit-to-Project

- **Sidebar wiring**: the host project's nav file (e.g. `app/(app)/_layout.tsx` for the Goliath stack) gets one new entry under the platform section — `{ label: 'Feed', icon: 'stream', href: '/platform/feed', adminOnly: true }`. Place it before the existing entries so it's the operator's first stop.
- **Audit log producer**: `security.audit_anomaly` requires the `audit_log` collection, owned by `admin-user-crud`. If the host doesn't have one yet, install `admin-user-crud` first (the dependency is implicit through the audit log; a host that doesn't have one simply doesn't emit `security.audit_anomaly`).
- **Auth failure tracking**: `security.failed_login_burst` requires the auth handler to count failures per email. The default for `otp-auth` is in-memory; multi-instance deploys need a tiny `auth_failures` collection with a TTL index (`expireAfterSeconds: 600`) keyed on `email`. The recipe doesn't pick — use whatever the existing auth code uses for rate limiting.
- **Background worker**: the snooze cron needs a 60s tick. If `admin-prompt-queue` is installed, reuse its worker loop for one extra tick. Otherwise, a `setInterval` in the API server's startup is fine for single-instance deploys.
- **Default page size**: 50 items. Tuned for a desk operator scanning a list, not a table viewer.
- **Snooze presets**: 24h, 1 week. If your operator cadence is different (e.g. weekly review only), change them at the page level — they're a UI choice, not a data choice.

---

## Anti-Patterns

- **One collection per producer (`chat_unviewed_items`, `system_exception_items`, …)** — the whole point of the feed is one ranked queue. Per-producer collections force the page to N-way merge on every render, force every new producer to ship its own page, and undo the "one helper, every producer" property. One `feed_items` collection.
- **Producers reaching past `emitFeedItem` to insert directly into `feed_items`** — every producer must go through the helper. Direct inserts skip the dedup race, the `count` bump, the `category` mapping, and the type-vocabulary discipline. If `emitFeedItem` doesn't fit a use case, change the helper, not the call site.
- **Storing absolute URLs in `link`** — the row click prepends the host implicitly via the router. Absolute URLs work locally and break in deploys with a different `BASE_URL`. Store relative paths only.
- **`dedupe_key` keyed on the source row's `_id`** — defeats the point of dedup. The key must identify the *bucket* the operator cares about (one entry per org for unviewed chats, one entry per fingerprint for exceptions, one entry per email for failed logins), not the individual source row.
- **Coalescing on category/type/source mutations** — `emitFeedItem` updates `count`, `last_seen_at`, `title`, `preview`, `priority`, `link` on dedupe-hit. Updating `category` or `type` on coalesce means the same row morphs identity over time, and aggregations stop being meaningful. Identity fields are write-once.
- **Forgetting the partial filter `dedupe_key: { $type: 'string' }` on the unique index** — null-keyed items collide on the unique index after the first one is open. Producers that opt out of dedup need to be free to emit unboundedly.
- **Auto-resolving on dismiss** — `dismissed` is the operator's explicit "stop showing me this." A subsequent source resolution must NOT undo dismiss; otherwise the operator can't permanently silence a known-noisy producer.
- **Auto-resolving exceptions on the next clean request** — clears active incidents the moment one good request lands, hiding ongoing intermittent bugs. Exceptions resolve only on operator action.
- **Bulk endpoint accepting arbitrary filter shape** — restrict to `type` and `category`. Allowing `priority` or `org` opens a footgun where one slightly-wrong filter resolves the wrong N rows in one click.
- **Snooze cron run inline in `GET /api/platform/feed`** — looks tempting (lazy unsnooze on read), but means a fresh page load runs the unsnoozer with one user's session and one user's racing concurrent reads. The cron is a worker, not a request side-effect.
- **Listing snoozed items in the default `open` view** — the snooze affordance is meaningless if snoozed items still show. Default filter is `state: 'open'`; snoozed items appear only in the explicit `state=snoozed` filter and after the cron flips them back to `open`.
- **Using `find().toArray()` then in-memory filter for stats** — the stats strip is loaded on every page open. Use a single `$facet` aggregation against `feed_items` so the three counts come back in one round trip, keyed on `state: 'open'`.
- **Putting the page under `/admin/feed`** — the page is platform-staff-only and operates on cross-org signals. Per `admin-routing` § Two trees, that's `/platform/feed`. An org owner has no business resolving someone else's failed-login burst.
- **One row per chat message for `chat.unviewed`** — without bucket-level dedup, a busy day floods the feed and drowns the system/security signals. One open item per (org, public-chat-bucket); `count` carries the volume.
- **`link` pointing into a modal hash that the destination doesn't register** — deep links go stale. The destination page must render a "Not found" inside the modal slot when the hash names a deleted entity, never crash.
- **Snoozing past `snoozed_until` without an explicit `state: 'snoozed'`** — the cron's predicate is `{ state: 'snoozed', snoozed_until: { $lte: now } }`. A row in `state: 'open'` with a stale `snoozed_until` value is unreachable to the cron and to the filter; clear `snoozed_until` to `null` whenever state transitions away from `snoozed`.
- **Letting `emitFeedItem` be `await`-blocking on the request hot path** — chat writes, login attempts, and exception handlers don't want to wait on a Mongo write to return a response. Either fire-and-forget with a logged catch, or move the emit into a background queue. The emitter itself is fast; the handler should not be coupled to the feed write's latency.
- **Logging the full exception stack into `feed_items.preview`** — the preview is one row in a list. Stacks live in `system_exceptions`, the feed row links to the doc, the row expands to show it. Stuffing it into `preview` blows out the row layout and bloats the index.

---

## Logging

- Log every `emitFeedItem` call at info: `{ msg: 'feed.emit', type, category, priority, dedupe_key, coalesced, organization_id }`. The `coalesced` boolean is what tells you why the page count grew without new rows appearing.
- Log every state transition at info: `{ msg: 'feed.transition', _id, from, to, by: session.user_id }`. Without this, "who dismissed this row" is unanswerable.
- Log the snooze-cron tick at debug: `{ msg: 'feed.cron.unsnooze', flipped: number }`. Info-level on tick is too chatty; debug for normal runs, warn if `flipped > 100` (signal that a snooze burst happened).
- Do NOT log `feed_items.preview` or `system_exceptions.error_message` — both can carry user input or sensitive payloads. The `_id` and `dedupe_key` are enough to find the row.
