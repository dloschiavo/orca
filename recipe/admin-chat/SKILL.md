---
name: admin-chat
description: >
  Use when building the admin review surface for flagged chat messages. One
  page at `/platform/chat` with two tabs ("In-app" and "Public") backed by two
  different monthly-rotated collection families (`chat_YYYY_MM` and
  `contact_YYYY_MM`). Covers the cross-month query pattern, filter set
  (flag/sentiment/resolved/date/source-specific), paired Notus flag and
  sentiment badges, row expand + optimistic resolved toggle, the generic
  per-tab Compile KB header button (consumer supplies prompt slug + output
  path + post-completion handler), and the canonical `/platform/chat` directory
  route. Both `chat-support` (Ashley) and `public-contact-chat` (Amelia)
  install this and wire one tab each.
dependencies:
  requires: [admin-prompt-queue, admin-routing]
  capabilities:
    auth: otp-auth
    design-system: admin-only-notus
provides: [admin-chat]
---

# Admin Chat Review

A single admin page at **`/platform/chat`** that reviews flagged messages from every chat surface in the app. Today there are two: the **In-app** authenticated chat (`chat-support` / Ashley, collection family `chat_YYYY_MM`) and the **Public** contact chat (`public-contact-chat` / Amelia, collection family `contact_YYYY_MM`). The page is one URL with two tabs; each tab is bound to one collection family and one consumer-supplied **Compile KB** config.

This recipe is the abstraction that lets a chat producer ship flagged-message review without re-implementing the cross-month query, the filter UI, the badge colors, the resolved toggle, or the KB-compile button each time.

Reference implementation: split out of `chat-support` (`app/(app)/platform/chat/index.tsx`, `app/api/platform/chat+api.ts`).

---

## Canonical Path & Sidebar

- Page: **`/platform/chat`** — directory-style (`app/(app)/platform/chat/index.tsx`), platform-level per `admin-routing/SKILL.md` § Two trees. Sibling pages: `/admin/users`, `/admin/orgs` (org-level), `/platform/prompts` (platform). Never flat-file as `admin-chat.tsx` or `platform-chat.tsx`.
- Sidebar label: **"Chat"**.
- Auth gate: `requireAdmin` on the route + on the API endpoint.

---

## Tab Configuration

The page renders an array of tab descriptors. **Each consumer recipe contributes two tabs per producer**: a **Flagged** tab (review surface, default) and an **All** tab (full message log). The All tab is **mandatory**, not optional — see § All Tab below for the why. Within a producer, Flagged comes first, then All. With two producers installed, ordering is `[<producer>_flagged, <producer>_all]` for each producer in install order.

```ts
export interface AdminChatTab {
  key: string                     // e.g. 'contact' | 'contact_all' — also the API ?source= value
  label: string                   // 'Flagged' | 'All'
  collectionPrefix: string        // 'chat_' | 'contact_'
  schema: AdminChatSchemaAdapter  // see below — Flagged and All use *different* adapters
  filters: FilterDescriptor[]     // tab-specific filters in addition to the shared set
  kbCompile?: KbCompileConfig     // present on Flagged tabs; never on All tabs
}
```

Tabs are registered in a single module (`lib/adminChat/tabs.ts`) that consumer recipes append to. Do **not** import the consumer modules from inside `admin-chat`; the dependency only flows the other way (consumers know about admin-chat, not the reverse).

```ts
// lib/adminChat/tabs.ts
import { CONTACT_TAB, CONTACT_ALL_TAB } from '@/lib/contact/adminTab' // public-contact-chat
// import { CHAT_TAB, CHAT_ALL_TAB } from '@/lib/chat/adminTab'        // chat-support, when installed

export const ADMIN_CHAT_TABS: AdminChatTab[] = [CONTACT_TAB, CONTACT_ALL_TAB]
```

### Schema adapter

The two collections have overlapping but not identical shapes. The adapter normalizes them into a common `FlaggedRow` for the table renderer. Fields the table reads, both sides must provide:

```ts
export interface FlaggedRow {
  _id: string
  created_at: Date
  sender_type: 'visitor' | 'agent' | 'system' | 'unknown'
  sender_label: string         // 'User: alice@x.com (acme)', 'Visitor', 'Amelia', 'System'
  visitor_ip?: string | null   // ONLY when sender_type === 'visitor'; null otherwise
  visitor_fpjs?: string | null // ONLY when sender_type === 'visitor'; null otherwise
  content: string
  flags: ChatFlag[]            // ['sensitive' | 'deflection' | 'jailbreak' | 'knowledge_gap']
  sentiment?: ChatSentiment    // 'frustrated' | 'neutral' | 'positive'
  flag_reason?: string | null
  resolved: boolean
  rate_limited?: boolean
  // raw is preserved for the row-expand panel; the table never reads it
  raw: Record<string, unknown>
}

export interface AdminChatSchemaAdapter {
  toRow(doc: Record<string, unknown>): FlaggedRow
  // Mongo filter built from the admin's filter selections
  buildQuery(filters: AppliedFilters): Record<string, unknown>
  // PATCH/DELETE target. Derived from the ObjectId timestamp via collectionNameFromId.
  resolveTarget(rowId: string): { collection: string, _id: string }
}
```

The schema adapter must zero out `visitor_ip` / `visitor_fpjs` when `sender_type !== 'visitor'`. **Why:** the same document shape sometimes carries those fields server-side (e.g., the visitor's fingerprint travels with their session's agent rows for context). Leaking them onto an agent or system row in the table makes it look like the agent had an IP, which confuses forensic review.

### Tab-specific filters

The shared filter set (always present on every tab):

- Flag category — multi-select: `sensitive`, `deflection`, `jailbreak`, `knowledge_gap`
- Sentiment — multi-select: `frustrated`, `neutral`, `positive`
- Resolved — `any | unresolved | resolved` (default `unresolved`)
- Date range — from / to (UTC), default last 7 days

Tab-specific filters declared per tab. Both the Flagged and All tabs of a given producer share the same tab-specific filter set:

- **chat-support (Ashley) tabs:** `org_search` (debounced 400ms text, matches `organization_id` exact or org slug substring)
- **public-contact-chat (Amelia) tabs:** `session_id` (exact text), `fpjs_prefix` (first 8 chars, exact text)

The `FilterDescriptor` shape is intentionally narrow so the renderer can drive itself from data:

```ts
export type FilterDescriptor =
  | { kind: 'text';   key: string; label: string; debounceMs?: number }
  | { kind: 'select'; key: string; label: string; options: { value: string; label: string }[] }
  | { kind: 'multi';  key: string; label: string; options: { value: string; label: string }[] }
  | { kind: 'date';   key: string; label: string }
```

---

## API Endpoint — `GET /api/platform/chat`

One endpoint serves all tabs, dispatched by `?source=`.

```
GET /api/platform/chat?source=chat&flags=sensitive,jailbreak&resolved=unresolved&from=2026-04-01&to=2026-04-10&cursor=…
```

Query params:

| Param | Notes |
|---|---|
| `source` | **Required.** Tab key (e.g. `contact`, `contact_all`, `chat`, `chat_all`). Selects which `AdminChatTab` to use. |
| `flags` | Comma-separated subset of flag categories. |
| `sentiment` | Comma-separated subset of sentiments. |
| `resolved` | `any | unresolved | resolved`. |
| `from`, `to` | `YYYY-MM-DD`. Parse `from` as `T00:00:00.000Z` and `to` as `T23:59:59.999Z` — `new Date('2026-04-27')` is UTC midnight, which is the right boundary for `from` ($gte start of day) but wrong for `to` ($lte to midnight excludes everything written later that same UTC day, including all of "today"). |
| `cursor` | Opaque next-page cursor (encoded `created_at` + `_id`). |
| (tab-specific) | e.g. `org_search`, `session_id`, `fpjs_prefix`. |

Response:

```ts
{
  rows: FlaggedRow[],            // page size 25
  nextCursor: string | null,
  stats: {
    total_flagged: number,
    by_category: Record<ChatFlag, number>,
    by_sentiment: Record<ChatSentiment, number>,
  }
}
```

The handler must `requireAdmin` and reject any `source` not in `ADMIN_CHAT_TABS.map(t => t.key)`.

### Cross-month query pattern

Both collection families are monthly-rotated. The handler must scan all relevant `*_YYYY_MM` collections, merge in memory, sort newest-first, and slice the page. Two helpers — both **generic over a prefix**, not chat-specific:

```ts
// lib/adminChatCollections.ts (lives in admin-chat, not in chat-support)
export async function listCollectionsByPrefix(db: Db, prefix: string): Promise<string[]> {
  const all = await db.listCollections({ name: { $regex: `^${prefix}\\d{4}_\\d{2}$` } }).toArray()
  return all.map(c => c.name).sort().reverse() // newest first
}

export function collectionNamesInRange(prefix: string, from: Date, to: Date): string[] {
  const out: string[] = []
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1))
  const end    = new Date(Date.UTC(to.getUTCFullYear(),   to.getUTCMonth(),   1))
  while (cursor <= end) {
    const yyyy = cursor.getUTCFullYear()
    const mm   = String(cursor.getUTCMonth() + 1).padStart(2, '0')
    out.push(`${prefix}${yyyy}_${mm}`)
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return out.reverse()
}
```

**Always intersect the range with `listCollectionsByPrefix` before iterating.** `collectionNamesInRange` is a *name generator* — it does not check existence. MongoDB silently auto-creates a namespace on the first write-side operation against it (`createIndex`, `aggregate $out`, `insertOne`, etc.), so iterating the raw range output through any of those will conjure phantom collections. A single typo like `from=0002-04-21` expands to ~24,000 month names; one bad request can leave thousands of empty `*_YYYY_MM` collections behind. The safe shape:

```ts
const existing = await listCollectionsByPrefix(db, tab.collectionPrefix)
let names = existing
if (filters.from || filters.to) {
  const inRange = new Set(
    collectionNamesInRange(
      tab.collectionPrefix,
      filters.from ?? new Date(0),
      filters.to   ?? new Date(),
    ),
  )
  names = existing.filter(n => inRange.has(n))
}
```

Use this `names` list everywhere downstream — `Promise.all` over `find`, the stats `$facet`, and any per-collection `ensureIndexes` call. Run the per-collection `find`s in parallel via `Promise.all`; sequential `await`s in a `for` loop double the round trips for no benefit.

`stats` is built per-collection in a **single `$facet` pipeline** that runs the count, the flag `$group`, and the sentiment `$group` together — three separate aggregations across N collections becomes O(3N) round trips for no benefit; `$facet` collapses them to O(N). Then `Promise.all` across collections and reduce in memory.

**Skip stats on cursor pagination.** Page follow-ups (`?cursor=…`) reuse the stats the user is already looking at; recomputing them per page would re-scan every collection in range for no UI value. Return `stats: null` and have the frontend keep the prior values.

### Indexes

The Flagged-tab default predicate is "any flag is set." Phrased as `flags: { $exists: true, $ne: [] }` the planner can't use any flat index — it sorts in memory after a collection scan. Use a **partial index** keyed on `created_at`, with the partial filter matching the query predicate exactly:

```ts
col.createIndex(
  { created_at: -1 },
  {
    name: 'created_at_flagged_partial',
    partialFilterExpression: { 'flags.0': { $exists: true } },
  },
)
```

The query side must phrase its predicate as `'flags.0': { $exists: true }` (match the `partialFilterExpression` byte-for-byte) for the planner to pick this index. The explicit `name` is required because the key spec collides with the regular `{ created_at: -1 }` index that the consumer also wants for the All-tab query — MongoDB only auto-disambiguates indexes with *different* key specs.

The consumer recipe owns its `ensureIndexes()` function (for `chat-support` and `public-contact-chat` it's also called lazily on visitor write/read paths). `admin-chat` calls it from `GET /api/platform/chat` on the **intersected `names`** so the Flagged tab has its index even on a freshly booted process before any chat-side traffic has run. Safe because `names` is restricted to existing collections — passing a raw `collectionNamesInRange` output would re-introduce the phantom-creation problem.

---

## Page Layout

Standard Notus page shell (see `admin-only-notus`). Header row contains:

1. **Tab strip** — left-aligned, one button per tab. Active tab gets the canonical Notus active-tab styling.
2. **Per-tab header slot** — right-aligned. The active tab's `kbCompile` button (if configured) renders here. Other consumer-defined header actions can also live here in the future.

Below the header: filter bar (the active tab's full filter set including the shared filters), then a stats strip (`total_flagged`, per-category counts, per-sentiment counts), then the table.

Switching tabs **resets the filter state**. Filters from the In-app tab don't make sense on the Public tab and vice versa. Persist nothing in the URL beyond `?tab=`.

### Loading state must be visually distinct from "no results"

A slow query renders identically to "0 matches" if the table just shows blank rows — admins assume the filter is working when it's actually pending. Two indicators:

- **Header spinner** in the right side of the tab strip whenever any fetch is in flight. Use the standard 14×14 `<svg className="animate-spin">` from `JobCard`. Visible regardless of whether the table currently has rows.
- **Centered spinner** inside the table's empty-state slot when there are no rows yet. Replaces (not augments) the "No messages match the current filters." text.

Don't hide the table during refetch. When the user changes a filter, the previous rows should remain visible while the new request runs — the header spinner signals freshness in flight. Hiding the table swaps it for a loading block that visually flashes on every filter change and disorients the admin.

### Debounce typed inputs in the filter bar

`<input type="date">` fires `onChange` on every keystroke. While the user types "2025", intermediate values "0002", "0020", "0202" all fire — and each one expands the cross-month range to thousands of months. Wrap both `from` and `to` in a 500ms local-state debounce (same shape as the `FilterDescriptor.debounceMs` mechanism for tab-specific text fields). Other controls (multi-select buttons, the resolved dropdown) commit immediately — they can't be typed character-by-character.

---

## Compile KB Button (Generic)

The header slot's primary citizen today is a **Compile KB** button, used by both consumers to enqueue a knowledge-base compilation job through `admin-prompt-queue`. The button is **generic** — admin-chat owns the button; the consumer recipe supplies the config.

```ts
export interface KbCompileConfig {
  promptSlug: string                  // e.g. 'ashley-compiler' or 'amelia-compiler'
  outputPath: string                  // e.g. 'rag/ashley-knowledge.md'
  buttonLabel?: string                // default 'Compile KB'
  // Called server-side after the prompt-queue job completes successfully.
  // Implemented by the consumer recipe; admin-chat just registers it.
  onComplete: (result: { content: string }) => Promise<void>
}
```

UX rules (from the original chat-support implementation, preserved here verbatim):

- Button lives in the **right side of the active tab's header**, not in the filter bar.
- POSTs to `/api/prompt-queue/enqueue` with `{ slug: config.promptSlug }`.
- Shows an **inline status message for 5 seconds** after enqueue: "Compiling KB…" → "KB compiled" or "KB compile failed: {error}". The message is anchored to the button row, not a toast.
- The actual compile work is the prompt-queue worker's job — see `admin-prompt-queue`. `admin-chat` does **not** call the LLM directly.
- `onComplete` is registered in the worker via `admin-prompt-queue`'s `onJobComplete(slug, callback)` hook. Each consumer recipe registers its own callback at install time. `admin-chat` does not own the callback registration — it only renders the button and enqueues the job.

### Concrete consumer wiring (for context — these live in the consumer recipes, not here)

```ts
// lib/contact/adminTab.ts (from public-contact-chat) — exports BOTH tabs.

const CONTACT_FILTERS: FilterDescriptor[] = [
  { kind: 'text', key: 'session_id',  label: 'Session ID' },
  { kind: 'text', key: 'fpjs_prefix', label: 'Fingerprint prefix' },
]

export const CONTACT_TAB: AdminChatTab = {
  key: 'contact',
  label: 'Flagged',
  collectionPrefix: 'contact_',
  schema: contactSchemaAdapter,           // flagged-only buildQuery
  filters: CONTACT_FILTERS,
  kbCompile: {
    promptSlug: 'amelia-compiler',
    outputPath: 'rag/amelia-knowledge.md',
    onComplete: async ({ content }) => {
      await fs.mkdir(path.dirname(KB_OUTPUT_PATH), { recursive: true })
      await fs.writeFile(KB_OUTPUT_PATH, content, 'utf-8')
      await invalidatePromptCache('amelia-chat') // bust the public-chat prompt cache
    },
  },
}

export const CONTACT_ALL_TAB: AdminChatTab = {
  key: 'contact_all',
  label: 'All',
  collectionPrefix: 'contact_',
  schema: contactAllSchemaAdapter,        // omits flagged-only predicate, includes system rows
  filters: CONTACT_FILTERS,
  // No kbCompile — KB is compiled from the flagged review surface only.
}
```

The chat-support (Ashley) producer follows the same shape with `CHAT_TAB` (`label: 'Flagged'`, `key: 'chat'`) and `CHAT_ALL_TAB` (`label: 'All'`, `key: 'chat_all'`), both using `collectionPrefix: 'chat_'`.

---

## Badge Colors

Both flag and sentiment badges use **paired Notus classes** (`bg-{color}-100` + `text-{color}-700`). No hex, no inline styles. See `admin-only-notus` for the canonical Badge component.

| Flag | Color |
|---|---|
| `sensitive` | `red` |
| `deflection` | `orange` |
| `jailbreak` | `purple` |
| `knowledge_gap` | `lightBlue` |

| Sentiment | Color |
|---|---|
| `frustrated` | `red` |
| `neutral` | `blueGray` |
| `positive` | `emerald` |

These colors are part of the recipe — do not let consumers override them. Cross-tab consistency is the whole point of having one admin-chat surface.

---

## Row Expand & Resolved Toggle

Each row collapses to: timestamp, sender_label, first 120 chars of content, flag badges, sentiment badge, resolved toggle. Click anywhere on the row (except the toggle) to expand a detail panel showing the full `raw` document — `JSON.stringify(raw, null, 2)` inside a monospace block is sufficient. Different shapes between tabs is fine; the panel is for forensic context, not pretty rendering.

The resolved toggle is **optimistic**:

```
PATCH /api/platform/chat/[id]?source=chat
body: { resolved: true }
```

Handler: derive collection name via the per-tab schema's `resolveTarget(rowId)`, then `updateOne({ _id }, { $set: { resolved } })`. On error, the UI rolls back the optimistic flip and shows a one-line error under the row.

---

## File Map

| File | Purpose |
|------|---------|
| `app/(app)/platform/chat/index.tsx` | Page shell — tab strip, header slot, filter bar, stats strip, table |
| `app/api/platform/chat+api.ts` | `GET` — dispatch on `?source=`, run cross-month query, return rows + stats |
| `app/api/platform/chat/[id]+api.ts` | `PATCH` (flip `resolved`) and `DELETE` (hard-delete with audit log); both use per-tab `resolveTarget` |
| `app/api/platform/chat/tabs+api.ts` | `GET` — projects `ADMIN_CHAT_TABS` to a JSON-safe shape (no closures) for the page to bootstrap from |
| `lib/adminChat/types.ts` | `AdminChatTab`, `FlaggedRow`, `AdminChatSchemaAdapter`, `FilterDescriptor`, `KbCompileConfig` |
| `lib/adminChat/tabs.ts` | `ADMIN_CHAT_TABS` registry — consumer recipes append both their Flagged and All tabs here |
| `lib/adminChat/collections.ts` | `listCollectionsByPrefix`, `collectionNamesInRange`, `collectionNameFromId` (all generic over prefix) |
| `lib/adminChat/badges.ts` | `FLAG_COLOR`, `SENTIMENT_COLOR` constants |
| `lib/adminChat/useHashRoute.ts` | `useHashRoute()` — parses `#<tab>/<modal?>` and writes back; the only place tab/modal state lives |
| `components/AdminChatTable.tsx` | Table renderer that consumes `FlaggedRow[]` — also owns row state, expand panel, optimistic resolved/delete |
| `components/AdminChatFilterBar.tsx` | Filter UI driven by `FilterDescriptor[]` — owns `DebouncedDateField` and `DynamicField` |
| `components/AdminChatRowMenu.tsx` | Three-dot context menu rendered via `createPortal` (delete, future per-row actions) |
| `components/CompileKbButton.tsx` | Header-slot button; reads the active tab's `kbCompile` |

---

## Additional Deliverables

Numbered checklist of behaviors that the prose above implies but a reader may otherwise miss. Every numbered item is binding; sub-items are the concrete obligations.

### 1. DELETE endpoint

1.1 `DELETE /api/platform/chat/[id]?source=<tab>` — `requireAdmin`, validate `source` against `ADMIN_CHAT_TABS`, dispatch through `tab.schema.resolveTarget(id)`, then `deleteOne({ _id })` against the resolved collection.

1.2 Response: `{ ok: true }` on success; `404` when `deletedCount === 0`.

1.3 **Audit log line on every successful delete** — actor admin email, `source` tab key, row id, status code. **Why:** flagged-message rows can contain sensitive user input; deletion is destructive and the page does not gate it behind a confirm dialog. Without an audit line there is no recourse for accidental or malicious removal.

1.4 The All-tab adapter and the Flagged-tab adapter both implement `resolveTarget` — DELETE works from either tab.

### 2. List-tabs endpoint

2.1 `GET /api/platform/chat/tabs` — `requireAdmin`, returns `[{ key, label, filters, kbCompile?: { promptSlug, outputPath, buttonLabel? } }]` projected from `ADMIN_CHAT_TABS`.

2.2 The page boots by fetching this endpoint instead of importing `ADMIN_CHAT_TABS` directly. **Why:** `kbCompile.onComplete` is a server-side closure (filesystem writes, cache invalidations). Pulling `ADMIN_CHAT_TABS` into a client bundle either ships those closures or forces every consumer to split their tab module. The endpoint keeps the schema adapter and `onComplete` server-only and gives the page a serializable view.

### 3. Cursor format and stable pagination

3.1 Cursor shape: `base64url(JSON.stringify({ ts: number, id: string }))` where `ts` is `Date.getTime()` of the boundary row's `created_at` and `id` is its hex ObjectId.

3.2 Cursor predicate (AND-ed onto the base query when present):

```ts
{ $or: [
  { created_at: { $lt: new Date(cursor.ts) } },
  { created_at: new Date(cursor.ts), _id: { $lt: new ObjectId(cursor.id) } },
]}
```

The second branch is the millisecond-tie tiebreaker. **Why:** without it, two rows that share `created_at` to the millisecond can be split across pages or duplicated.

3.3 Per-collection sort: `{ created_at: -1, _id: -1 }`. Same key spec as the cursor predicate so the planner can serve it from the partial index without an in-memory tiebreak sort.

3.4 `hasMore` detection: `find(...).limit(PAGE_SIZE + 1)`. If the merged length exceeds `PAGE_SIZE`, slice and emit `nextCursor` from the last *kept* row. Otherwise `nextCursor: null`.

3.5 Cross-collection in-memory merge: sort by `bTs - aTs`, then `b._id.localeCompare(a._id)` for the same-timestamp tiebreak. Mirror the per-collection sort exactly so a page boundary lands on the same row regardless of which collection produced it.

3.6 Default `PAGE_SIZE = 25`.

### 4. Per-collection error isolation

4.1 Each collection's `find()` runs inside `try { ... } catch { return [] }` before being merged. **Why:** a single corrupted monthly collection (partial index build, transient cluster blip) should not 500 the whole admin page; the operator can still triage every other month in range.

4.2 Log the collection name and the error inside the catch — silently swallowing the error makes "row count looks low" undebuggable.

### 5. Stats response: default-zero shape

5.1 The `by_category` and `by_sentiment` maps must include **every known key** with `0` as the default, not only keys that were observed in the result set. **Why:** the frontend renders a fixed strip of tiles from a hardcoded vocabulary; missing keys render as "not implemented" instead of "zero," producing a broken-looking UI on a low-traffic day.

5.2 Filter unknown categories/sentiments out of the aggregation result before returning. **Why:** if a producer ships a new flag value before this recipe is updated, the page should be invisible-to-the-new-flag, not crash.

### 6. SenderCell layout

6.1 Non-visitor rows (`sender_type !== 'visitor'`): single-line `sender_label`.

6.2 Visitor rows: three lines stacked — `sender_label`, masked IP (`visitor_ip` as-is, no obfuscation; the page is admin-only), fingerprint prefix (first 8 chars of `visitor_fpjs`).

6.3 The full `visitor_fpjs` goes in the prefix line's `title` attribute. **Why:** full FPJS hashes are 32+ chars and would eat the content column's width; the prefix is enough to scan visually, the tooltip is enough for copy/compare.

### 7. Resolved control rendered as paired badge-button

7.1 Resolved state: button using paired Notus state colors (`bg-emerald-900` / `text-emerald-400`), label `"resolved"` (lowercase).

7.2 Open state: paired Notus warn colors (`bg-orange-900` / `text-orange-400`), label `"open"`.

7.3 The control is the badge — there is no separate toggle. A click flips state optimistically (PATCH; on error, roll back and surface the error message under the row).

### 8. Row context menu (three-dot)

8.1 Per-row affordance: a small icon button at the trailing edge of the row, opens a menu. Today's only action: **Delete**. The menu is the canonical extension point for future per-row actions.

8.2 **Positioning rule (load-bearing):** render via `createPortal` to a top-level node, with `position: fixed`, `z-index: 9999`, coordinates computed from `getBoundingClientRect()`. **Why:** rendered as `position: absolute` inside the table, the menu is clipped by the table's `overflow` and is unreachable. (See global feedback memory: `feedback_context_menus.md`.)

8.3 Dismiss triggers: click outside, `Escape` key, **`scroll`**, **`resize`**. **Why:** without scroll/resize listeners, the menu detaches visually from its anchor when the user scrolls the row off-screen or shrinks the window.

8.4 Delete is **optimistic** — set `deleted: true` locally and stop rendering the row. On error, restore the row and surface the error message in the same per-row error slot the resolved toggle uses.

### 9. Schema adapter — Flagged vs All variants

9.1 The Flagged adapter's `buildQuery` defaults to `{ 'flags.0': { $exists: true } }` (bytes-for-byte match for the partial index).

9.2 When the user selects flag categories, the Flagged adapter **deletes** the `'flags.0'` clause and replaces it with `{ flags: { $in: selectedFlags } }`. **Why:** keeping both clauses over-specifies the predicate without changing the result set, and confuses readers who later try to reconcile the predicate with the partial index name.

9.3 The All adapter's `buildQuery` omits the flagged-only predicate entirely.

9.4 The All adapter explicitly **includes `system`-typed rows**. **Why:** Amelia/Ashley's prompt-context builder reads every row matching `session_id`, including the seeded system message. If the All tab hides system rows, the admin can delete every row they can see for a session and still leak ghost context into the next conversation. System rows must be visible and deletable from the same surface.

### 10. ID-to-collection helper

10.1 `collectionNameFromId(rowId: string): string` lives in `lib/adminChat/collections.ts` alongside `listCollectionsByPrefix` and `collectionNamesInRange`. Parses the ObjectId, extracts the timestamp from the leading 4 bytes, and formats `${prefix}${YYYY}_${MM}`.

10.2 Every consumer schema adapter's `resolveTarget` should call this helper rather than re-deriving the collection name. The helper takes the `prefix` so it stays generic.

### 11. All Tab is mandatory (not optional)

11.1 Every consumer producer ships **two** tabs: a Flagged tab (review surface, default) and an All tab (full message log over the same collection prefix).

11.2 The All tab uses a separate schema adapter — never reuse the Flagged adapter with a "showAll" flag. **Why:** the predicates diverge (`'flags.0': $exists` vs no flag predicate), the system-row policy diverges, and the kbCompile policy diverges. A single adapter with branching state encodes too much in one place.

11.3 The All tab does **not** carry a `kbCompile` config. KB is compiled from flagged review only.

11.4 The All tab uses the same tab-specific filters as its Flagged sibling so the admin's mental model is "same data, different filter".

### 12. Hash-route page state

12.1 Page state lives in the URL hash, not the query string: `#<tab>/<modal?>`. Implemented via the `useHashRoute()` hook in `lib/adminChat/useHashRoute.ts`.

12.2 Tab switch behavior: writes `#<newTab>` and **clears** the `modal` segment. Filters reset (already specified above).

12.3 Invalid tab key fallback: if the hash names a tab not in the registry (e.g., a producer was uninstalled mid-session), fall back to the first tab in `ADMIN_CHAT_TABS` rather than rendering an empty page.

12.4 **Why hash, not query string:** in Expo Router and Next.js App Router, query-string changes can trigger route-segment re-renders that wipe local component state mid-interaction (open menus, scroll position, in-flight optimistic edits). Hash changes don't cross that boundary.

### 13. Filter bar implementation

13.1 `FLAG_OPTIONS` and `SENTIMENT_OPTIONS` are defined once in `AdminChatFilterBar.tsx` and shared across all tabs. Consumers cannot override the option list — uniform vocabulary across tabs is part of the value of a single admin surface.

13.2 `DynamicField` (the renderer for tab-specific descriptors) implements `kind: 'text'` only today. `select`, `multi`, and `date` are reserved in the type but no-op; adding a new kind is a recipe-level change, not a consumer-level one. **Why:** lets a consumer declare a future-shape filter without forcing the recipe to grow on its install timeline.

13.3 `DebouncedDateField` keeps a *local* draft value and a `useRef` timer; the timer is cleared on unmount and on every keystroke before being re-armed. Both `from` and `to` go through it.

### 14. Row UX miscellany

14.1 Timestamp column: `new Date(row.created_at).toLocaleString()` — locale-aware, **not** ISO. Admins read these in their own timezone.

14.2 Per-row error line: a single `<div>` rendered between the row grid and the expand panel (when present), showing the failure message from a failed PATCH or DELETE. Auto-clears on the next successful action against that row.

14.3 Table grid template: fixed-width utility columns and a single `fr` content column, top-aligned (`alignItems: start`). **Why:** the multi-line SenderCell would otherwise vertical-center against single-line columns and look misaligned. Fixed widths keep flag/sentiment badges from reflowing as the content column changes.

14.4 Row detail panel: bounded height with internal scroll (`max-h-80 overflow-auto`) inside the canonical Notus dark surface. **Why:** unbounded height pushes subsequent rows off-screen on documents with long `raw` payloads.

### 15. Loading state — single boolean, table stays mounted

15.1 The page-level `loading` boolean is shared by initial fetch and refetch — there is no separate "refreshing" sub-state.

15.2 Header spinner is the only freshness signal during refetch. The table itself stays mounted with the previous result set visible. (Reinforces the existing anti-pattern against hiding the table during refetch.)

### 16. Source validation guards every endpoint

16.1 `GET /api/platform/chat`, `GET /api/platform/chat/tabs`, `PATCH /api/platform/chat/[id]`, and `DELETE /api/platform/chat/[id]` all validate `?source=` against `ADMIN_CHAT_TABS.map(t => t.key)` and return 400 on mismatch *before* invoking the schema adapter. (Reinforces the existing anti-pattern; the recipe must spell out that this includes DELETE.)

---

---

## FastAPI / Python Variant

Same architecture, with these adaptations:

| Concern | Expo Router (TS) | FastAPI (Python) |
|---|---|---|
| API layer | `app/api/platform/chat+api.ts` | `api/routers/platform_chat.py` |
| List-tabs endpoint | `app/api/platform/chat/tabs+api.ts` | `api/routers/platform_chat_tabs.py` |
| PATCH + DELETE handler | `app/api/platform/chat/[id]+api.ts` | `api/routers/platform_chat_id.py` |
| Tab registry | `lib/adminChat/tabs.ts` | `api/lib/platform_chat/tabs.py` |
| Cross-month helpers | `listCollectionsByPrefix`, `collectionNamesInRange`, `collectionNameFromId` | `list_collections_by_prefix`, `collection_names_in_range`, `collection_name_from_id` |
| DB driver | native `mongodb` | Motor (`AsyncIOMotorClient`) |
| Resolved PATCH | optimistic in TS hook | optimistic in JS hook (frontend is unchanged) |
| Audit log on DELETE | `console.log` line | `logger.info` line |

The frontend is identical — it's just an Expo/RN page consuming a JSON endpoint, so the only thing that changes between stacks is the server-side router file and the helper module names.

---

## Anti-Patterns

- **Flat-file pages (`admin-chat.tsx`, `platform-chat.tsx`)** — inconsistent with `admin/users/`, `admin/orgs/`, `platform/prompts/`. Use `app/(app)/platform/chat/index.tsx` (directory-style) and the sidebar label "Chat".
- **One endpoint per source (`/api/platform/chat-messages`, `/api/platform/contact-messages`)** — duplicates the auth, the cross-month query, the stats logic, and the cursor format. One endpoint dispatching on `?source=` is the right shape; the per-tab differences live in the schema adapter.
- **Counts endpoint as a single `countDocuments`** — with monthly collections you need to sum across every `*_YYYY_MM` matching the filter. `Promise.all` in parallel, then reduce. Cache if it ever gets expensive.
- **Loading every flagged message into memory across all months for stats** — the count aggregation runs server-side on each collection (`$match` + `$count` / `$group`), never `find().toArray()` followed by JS reduce.
- **Mixing Ashley-specific or Amelia-specific code into `admin-chat`** — the recipe is generic. If you find yourself writing `if (source === 'chat') compileAshleyKb()`, stop. The consumer wires its own `kbCompile.onComplete` and `admin-chat` calls it through the registry.
- **Importing consumer modules from inside `admin-chat`** — the dependency direction is one-way: consumers depend on `admin-chat`, never the reverse. The tab registry is a list the consumers *append to*; `admin-chat` only reads it.
- **Sharing filter state across tabs** — Flagged and All tabs (and the chat-support / public-contact-chat producers) have different filter sets and shapes. Switching tabs resets filters; do not try to be clever about preserving overlap.
- **Putting Compile KB in the filter bar** — it's a consumer-supplied tab action, not a filter. It belongs in the right side of the **header slot**, anchored to the tab.
- **Toast for the Compile KB status** — too easy to miss. Inline message anchored under the button, 5s auto-dismiss, matches the pattern from the original chat-support implementation.
- **Calling the LLM directly from `admin-chat`** — Compile KB enqueues a job into `admin-prompt-queue` and lets the worker do the work. `admin-chat` is a review surface, not a worker.
- **Hex colors or inline styles for badges** — paired Notus classes only. The flag/sentiment color tables in this recipe are the source of truth across both tabs.
- **Per-tab badge color overrides** — the whole point of one admin surface is uniform visual language. The colors are not configurable.
- **Looking up message-by-id across every monthly collection** — ObjectIds embed the creation timestamp in the first 4 bytes. Each schema adapter's `resolveTarget(id)` derives the exact collection name from the id, then targets it directly. No range scan.
- **Forgetting to gate the API on `requireAdmin`** — flagged messages contain raw user input that is sometimes sensitive. The page gate is not enough; the endpoint must also reject non-admins.
- **Letting an unknown `source` value reach the schema adapter** — validate the param against `ADMIN_CHAT_TABS.map(t => t.key)` at the top of the handler and 400 on mismatch. Otherwise a typo silently scans the wrong collection family or throws deep in the merge step.
- **Driving any per-collection operation off `collectionNamesInRange` without intersecting against `listCollectionsByPrefix`** — `createIndex`, `aggregate`, anything that touches a non-existent namespace can create it. A typo'd date input (`0002-04-21`) expands to 24k month names; one bad request will leave thousands of phantom `*_YYYY_MM` collections behind and take minutes to return. Intersect first, always.
- **Parsing the `to` date param as `new Date(toStr)` directly** — that's UTC midnight of the picked day, used as `$lte`, which excludes the entire picked day. Always extend `to` to `T23:59:59.999Z` before applying it.
- **Date inputs without debouncing** — typing a year fires four cascading requests (`0002`, `0020`, `0202`, `2025`), each potentially a wide cross-month query. 500ms local-state debounce is the minimum.
- **Same loading affordance for "fetching" and "no results"** — admins can't tell whether the query is still in flight or actually returned zero. A slow filter combo gets reported as "filter is broken." Header spinner + distinct empty-state spinner is the fix.
- **Three separate stats aggregations per collection** — fold `$count`, the flag `$group`, and the sentiment `$group` into a single `$facet` per collection. And skip them entirely when `cursor` is set — pagination follow-ups don't change the totals being shown.
- **Using a regular `{ created_at: -1 }` index for the Flagged-tab query** — the predicate `flags: { $exists: true, $ne: [] }` can't use a flat index efficiently. Use a partial index with `partialFilterExpression: { 'flags.0': { $exists: true } }` and phrase the query with the same `'flags.0'` predicate so the planner picks it. Give the partial index an explicit `name` so it can coexist with a plain `{ created_at: -1 }` index for the All-tab query.
- **Shipping a producer with only a Flagged tab** — the All tab is mandatory, not optional. Without it, the admin can clear every flagged row for a session and still leave behind system rows that bleed into the next conversation's prompt context. Both tabs install together or neither does.
- **One adapter with a `showAll: boolean` flag instead of two** — Flagged and All tabs diverge on the predicate, the system-row policy, and the `kbCompile` config. Encoding all that in branching state on a single adapter consolidates three orthogonal decisions into one knob and burns the next reader who has to disentangle them. Two adapters, one tab each.
- **Hard-deleting flagged messages without an audit log line** — DELETE is destructive and the page does not gate it behind a confirm dialog. The handler must emit a single log line with the actor's admin email, source key, row id, and status code. Without it there is no recourse for accidental or malicious removal.
- **Letting one collection's failure bubble out of the cross-month merge** — wrap each per-collection `find` in `try { ... } catch { return [] }` and log the collection + error inside the catch. Otherwise a single corrupted month 500s the entire admin page; with isolation the operator still sees every other month and can investigate the bad one separately.
- **Omitting known-zero keys from the stats response** — `by_category` and `by_sentiment` must default every known key to `0`. The frontend renders a fixed strip of tiles from a hardcoded vocabulary; missing keys render as broken tiles, not as zero, on a low-traffic day.
- **Letting `visitor_ip` or `visitor_fpjs` leak onto non-visitor rows** — the schema adapter's `toRow` must zero them out when `sender_type !== 'visitor'`. Otherwise an agent reply renders with a fingerprint attached, which is a forensic-review trap.
- **Rendering the row context menu with `position: absolute` inside the table** — the menu is clipped by the table's `overflow` and is unreachable. Use `createPortal` to a top-level node, `position: fixed`, `z-9999`, coordinates from `getBoundingClientRect()`. Listen for click-outside, `Escape`, **`scroll`**, and **`resize`** to dismiss; without scroll/resize the menu detaches from its anchor.
- **Storing tab/modal state in the query string** — query-string changes can trigger route-segment re-renders that wipe local component state mid-interaction (open menus, scroll position, in-flight optimistic edits). Hash routing (`#<tab>/<modal?>`) keeps the page stable.
- **Cursor predicate without a same-millisecond tiebreak** — using only `created_at: { $lt: cursor.ts }` will split or duplicate rows that share `created_at` to the millisecond. The cursor predicate must be `{ $or: [{ created_at: { $lt: ts } }, { created_at: ts, _id: { $lt: id } }] }` and the per-collection sort must match it (`{ created_at: -1, _id: -1 }`).
- **Embedding the schema adapter or `kbCompile.onComplete` in the client bundle** — the page must boot from `GET /api/platform/chat/tabs`, not by importing `ADMIN_CHAT_TABS` directly. The adapter and `onComplete` are server-side closures (filesystem writes, cache invalidations); pulling them client-side either ships those closures or forces every consumer to split their tab module.
- **Using ISO timestamps in the table** — admins read these in their own timezone. `toLocaleString()` in the table column; ISO is fine inside the expand panel's raw JSON.
- **Letting the table grid auto-size or center-align rows** — fixed-width utility columns + one `fr` content column + `alignItems: start`. Auto-sizing makes flag/sentiment badges reflow as content varies; center-alignment misaligns the multi-line SenderCell against single-line columns.
