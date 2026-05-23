# MetaVine 2.0 — Prompt Manager & Queue

**Rendering context:** Localhost frontend (Expo Router on :8082) + Node.js backend (Express on :8443) + MongoDB (`metavine` db)

## Purpose

MetaVine currently has three prompt templates stored as static files in `backend/prompts/` (`review-draft.md`, `ai-tell-phrases.jsonc`, `quality-rules.jsonc`), served by hardcoded `GET /prompts/*` endpoints. The review-drafting flow builds a Gemini prompt in the frontend (`reviews/_layout.tsx` → `buildGeminiPrompt()`) and calls the Gemini API directly from the browser. This has several problems:

1. **No versioning** — editing a prompt template overwrites it; no way to diff or revert.
2. **No audit trail** — no record of which prompt text was sent to the model for a given draft.
3. **No centralized execution** — LLM calls happen in the browser, making it impossible to enforce rate limits, retry on transient errors, or run jobs while the tab is closed.
4. **No visibility** — no dashboard showing pending/completed/failed LLM calls.

This feature replaces the static prompt files and browser-side Gemini calls with:

1. A **`prompts` MongoDB collection** with version history, served by CRUD endpoints.
2. A **`prompt_queue` MongoDB collection** tracking every LLM job through its lifecycle.
3. A **backend worker** (`setInterval` loop in server.js) that executes queued jobs against Gemini.
4. A **`/prompts` frontend page** with two cards: Prompt Manager (top) and Queue (bottom).
5. A **migration of the review-draft flow** — `reviews/_layout.tsx` enqueues a job instead of calling Gemini directly; the worker calls Gemini and the `on_job_complete` callback upserts the draft to the item.

---

## Architecture Principles

- **Snapshot at enqueue.** Every job captures the exact rendered prompt text at enqueue time. Edits to the prompt template after enqueue do not affect in-flight or completed jobs.
- **Single source of truth.** One `prompts` collection, one `prompt_queue` collection. The static `backend/prompts/` directory is removed after migration.
- **Worker handles execution.** The frontend never calls the Gemini API directly. It enqueues a job; the backend worker processes it.
- **Pluggable handler.** The worker delegates to a handler function. Initially there is one handler (`gemini`), but the interface supports adding others.

---

## 1. Prompt Manager (Top Card)

The Prompt Manager is a `<Card>` component on the `/prompts` page. It provides a single-prompt editor with a dropdown selector and full version history.

### 1.1 Layout

**Left half — Editor:**
- `<TextInput multiline>` displaying the body of the currently selected prompt (or a historical version).
- Default on page load: prompt with the most recent `updated_at`.

**Right half — Controls:**
- **Prompt selector** — native `<select>` listing all prompt slugs. Selecting a slug loads that prompt.
- **"New Prompt" button** — `<ActionButton>` that prompts for a slug via a small inline text input, then calls `POST /prompts`.
- **Version selector** — native `<select>` listing all versions by `saved_at` timestamp (most recent first). Selecting a version loads its body into the editor without auto-saving.
- **Save button** — `<ActionButton>` styled with `C.success` background when the editor content differs from the last saved version (dirty detection). Saving calls `PUT /prompts/{slug}`.
- **Delete button** — small `<TouchableOpacity>` with `C.danger` text. Calls `DELETE /prompts/{slug}` after confirmation.

### 1.2 Data Model — `prompts` Collection

| Field | Type | Description |
|---|---|---|
| `slug` | string (unique index) | URL-safe identifier (e.g., `review-draft`, `quality-rules`) |
| `body` | string | Current (latest) prompt text |
| `updated_at` | ISO datetime | Timestamp of last save |
| `versions` | array | Ordered list of `{ body, saved_at }` — append-only. Capped at 100; oldest pruned on save. |

**Indexes:** `{ slug: 1 }` unique.

### 1.3 Seed

On first startup (when `prompts` collection is empty), seed from the existing static files:

| Slug | Source File |
|---|---|
| `review-draft` | `backend/prompts/review-draft.md` |
| `ai-tell-phrases` | `backend/prompts/ai-tell-phrases.jsonc` |
| `quality-rules` | `backend/prompts/quality-rules.jsonc` |

Each seeded prompt gets `updated_at = now`, `versions = [{ body, saved_at: now }]`.

### 1.4 API — Prompts

All routes are under the existing Express app in `server.js`. No `/gdi/` prefix — use `/prompts` to replace the existing static-file endpoints.

| Method | Route | Behavior |
|---|---|---|
| `GET /prompts` | — | Returns all prompts (array), sorted by `updated_at` desc. Seeds defaults if collection is empty. |
| `POST /prompts` | `{ slug, body }` | Creates a new prompt. Returns 409 if slug exists. |
| `PUT /prompts/:slug` | `{ body }` | Updates `body`, appends `{ body, saved_at: now }` to `versions`, sets `updated_at = now`. Prunes versions to most recent 100. |
| `DELETE /prompts/:slug` | — | Deletes the prompt. Returns 404 if not found. |

**Migration note:** The existing `GET /prompts/review-draft`, `GET /prompts/ai-tell-phrases`, and `GET /prompts/quality-rules` endpoints must remain as backward-compatible aliases until the extension and review UI are updated. They should read from the `prompts` collection (by slug) instead of the filesystem.

### 1.5 Version Control Behavior

- Every save appends to `versions` — no version is ever mutated or deleted.
- The frontend loads the full `versions` array and allows browsing any historical version.
- Loading a historical version into the editor does not auto-save; the user must explicitly click Save to create a new version from old content.

---

## 2. Prompt Queue (Bottom Card)

The Queue panel is a second `<Card>` on the `/prompts` page, below the Prompt Manager.

### 2.1 Tabs

Use the same tab pattern as `reviews/_layout.tsx` and `orders/_layout.tsx` — route-level tabs are overkill here since this is a single page with local state filtering. Use in-component state tabs (like ChipRow but styled as tabs):

| Tab | Filter |
|---|---|
| Active | `queued` + `processing` |
| Completed | `completed` |
| Failed | `failed` |
| All | No filter |

Each tab label shows a count badge from `GET /prompt-queue/counts` (e.g., "Active (3)").

### 2.2 Pagination

- 20 jobs per page.
- Simple prev/next `<TouchableOpacity>` buttons with page count display, matching the crawl history pagination pattern.

### 2.3 Auto-Polling

- `setInterval` at 5 seconds when any visible jobs are in `queued` or `processing`.
- Stops polling when all visible jobs are terminal (`completed` or `failed`).
- Uses the same `requestIdRef` stale-response guard pattern as `reviews/_layout.tsx`.

### 2.4 Job Entry Layout

Each job renders as a row within the card (not a separate `<Card>` per job — matches the crawl history and filter-stats flat-list pattern).

**Left side — Request:**

| Element | Description |
|---|---|
| **Queue timestamp** | `queued_at` in local browser time |
| **Prompt slug** | `prompt_slug` as a muted label |
| **Prompt text** | `rendered_prompt` — first 3 lines shown, expandable on tap. `C.textSecondary`. |

**Right side — Response:**

| Element | Description |
|---|---|
| **Status badge** | `queued` → `C.textMuted` bg, `processing` → `C.delivered` bg + `ActivityIndicator`, `completed` → `C.success` bg, `failed` → `C.danger` bg |
| **Result text** | `result_text` shown inline (first 3 lines, expandable). For review drafts this is the generated review text. |
| **Completion timestamp** | `completed_at` in local browser time. Blank until terminal. |
| **Error message** | Shown when `status === 'failed'`. Full string, scrollable, `C.danger` text. |
| **Attempt count** | Badge shown only if `attempt > 1`. |

### 2.5 Ordering

Descending `queued_at`.

---

## 3. Job Document Schema — `prompt_queue` Collection

| Field | Type | Description |
|---|---|---|
| `_id` | ObjectId | Auto-generated |
| `prompt_slug` | string | Which prompt template was used |
| `status` | string | `queued` → `processing` → `completed` \| `failed` |
| `queued_at` | ISO datetime | When enqueued |
| `started_at` | ISO datetime \| null | When worker began processing |
| `completed_at` | ISO datetime \| null | When job reached terminal state |
| `rendered_prompt` | string | Fully-rendered prompt text, frozen at enqueue time |
| `result_text` | string \| null | Text response from the model (primary result for MetaVine's text-generation use case) |
| `result_artifacts` | array of strings | Paths/URLs to any output files (empty for text-only jobs) |
| `error` | string \| null | Error message if `status === 'failed'` |
| `attempt` | integer | Attempt count (1-based). Set to 1 on first pickup; incremented on retry. |
| `context` | object \| null | Opaque application-specific data passed through at enqueue time. For review-draft jobs: `{ asin }`. The worker does not read this — it's for the `on_job_complete` callback. |

**Indexes:** `{ status: 1, queued_at: 1 }` for worker polling, `{ queued_at: -1 }` for UI listing.

### Snapshot Strategy

`rendered_prompt` is captured at enqueue time. The calling code (review UI or any future consumer) resolves template variables and builds the final prompt text before calling `POST /prompt-queue`. The queue is a dumb pipe.

---

## 4. API — Queue

| Method | Route | Behavior |
|---|---|---|
| `GET /prompt-queue` | Query: `status` (all \| active \| queued \| processing \| completed \| failed), `page` (default 1), `limit` (default 20) | Returns `{ jobs, total, page, limit, pages }`. `active` = queued + processing. Sort: `queued_at` desc. |
| `GET /prompt-queue/counts` | — | Returns `{ queued, processing, completed, failed, active, total }`. |
| `POST /prompt-queue` | `{ prompt_slug, rendered_prompt, context? }` | Enqueues a job. Sets `status: 'queued'`, `queued_at: now`, `attempt: 0`, `result_text: null`, `result_artifacts: []`, `error: null`. Returns the inserted doc (HTTP 202). |

---

## 5. Worker

The worker runs inside `server.js` as a `setInterval` loop, consistent with how the backend already operates (single-process, no external task runner).

### 5.1 Configuration

Constants at the top of `server.js` (or in a dedicated section):

| Constant | Default | Description |
|---|---|---|
| `QUEUE_CONCURRENCY` | 1 | Max concurrent jobs. Start at 1 — Gemini rate limits are tight. |
| `QUEUE_MAX_ATTEMPTS` | 3 | Total attempts before permanent failure |
| `QUEUE_POLL_INTERVAL` | 5000 | ms between queue polls |
| `QUEUE_BACKOFF_BASE` | 30000 | ms base for exponential backoff |

### 5.2 Processing Loop

1. Every `QUEUE_POLL_INTERVAL` ms, query `prompt_queue` for `{ status: 'queued' }` ordered by `queued_at` asc, limit `QUEUE_CONCURRENCY - activeJobs`.
2. For each claimed job:
   a. `updateOne({ _id }, { $set: { status: 'processing', started_at: new Date().toISOString(), attempt: doc.attempt + 1 } })`.
   b. Call the handler: `await handleJob(job)`.
   c. **On success:** `updateOne({ _id }, { $set: { status: 'completed', completed_at: now, result_text, result_artifacts } })`. Call `onJobComplete(job)` if registered.
   d. **On transient error:** If `attempt < QUEUE_MAX_ATTEMPTS`, `updateOne({ _id }, { $set: { status: 'queued', error: msg } })` (re-queued for retry after backoff). Else mark `failed`.
   e. **On permanent error:** Mark `failed` immediately.

### 5.3 Transient Error Detection

Match error message or HTTP status against: `resource exhausted`, `quota`, `overloaded`, `rate limit`, `try again`, `too many requests`, `503`, `429`, `service unavailable`, `temporarily unavailable`, `internal error`.

All other errors → permanent.

### 5.4 Handler — Gemini

The initial (and currently only) handler:

```
async function handleGeminiJob(job) → { result_text, result_artifacts }
```

- Reads Gemini API key from `config.json` (same as the current review UI does via `api.config()`).
- Calls `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent` with `job.rendered_prompt`.
- Returns `{ result_text: <model output>, result_artifacts: [] }`.
- Throws on HTTP error (worker classifies transient vs permanent).

### 5.5 Post-Completion Callback — Review Draft

For review-draft jobs, register an `onJobComplete` callback:

```
function onReviewDraftComplete(job) {
  if (job.status !== 'completed' || !job.result_text) return;
  const { asin } = job.context;
  // Parse title from first line (same logic as current buildGeminiPrompt consumer)
  // Upsert { asin, review_draft, review_title, draft_quality } to items collection
}
```

This replaces the post-Gemini upsert logic currently in `ReviewItem.runDraft()`.

### 5.6 Logging

Worker logs to stdout (visible in terminal). No separate log files — the backend already logs to stdout and this keeps it consistent.

---

## 6. Review-Draft Migration

The existing review-drafting flow changes:

### Before (Current)

1. `ReviewItem` → `buildGeminiPrompt(item, notes)` → prompt string
2. `callGemini(prompt, key, altKey)` → response text
3. Parse title, upsert to items collection
4. All in the browser (`reviews/_layout.tsx`)

### After

1. `ReviewItem` → `buildGeminiPrompt(item, notes)` → prompt string (this function stays in the frontend, unchanged)
2. `api.enqueuePromptJob({ prompt_slug: 'review-draft', rendered_prompt: prompt, context: { asin: item.asin } })` → job doc
3. UI shows "Queued" status on the item
4. Worker picks up job → calls Gemini → `onReviewDraftComplete` upserts `review_draft` + `review_title` + `draft_quality` to item
5. Next poll/refresh of the reviews page shows the draft

**Changes to `reviews/_layout.tsx`:**
- Remove `callGemini()` function
- Remove direct Gemini API call in `runDraft()`
- Replace with `api.enqueuePromptJob()` call
- Remove `geminiKeys` state and the config fetch — the backend handles API keys
- Add polling or refresh to detect when the draft arrives (poll item by ASIN, or poll queue job status)
- Keep `buildGeminiPrompt()` — it still runs in the frontend to render the template with item-specific context

**Changes to `api.ts`:**
- Remove `promptReviewDraft()` (replaced by `prompts()`)
- Remove `promptAiTellPhrases()` (read from `prompts` collection via slug)
- Add: `prompts()`, `createPrompt()`, `updatePrompt()`, `deletePrompt()`
- Add: `promptQueue()`, `promptQueueCounts()`, `enqueuePromptJob()`

---

## 7. Frontend — `/prompts` Page

### 7.1 Files

| File | Purpose |
|---|---|
| `frontend/app/(tabs)/prompts.tsx` | Single-file page with PromptManager (top card) + QueuePanel (bottom card) |

No sub-routes needed — tabs are local state, not URL-routed.

### 7.2 Sidebar Entry

Add to `frontend/lib/routes.ts` → `NAV_ROUTES`:

```
{ href: '/prompts', label: 'Prompts', icon: 'code-slash-outline' }
```

Position: after Filter Stats, before Crawl Status.

### 7.3 Component Structure

All in `prompts.tsx` — no separate component files unless the file exceeds ~500 lines, in which case extract `PromptEditor` and `QueuePanel` to `frontend/components/`.

### 7.4 Styling

- Use `C` color tokens throughout
- `Card` component for both sections
- Tab styling matches `reviews/_layout.tsx` tab pattern
- Editor textarea: `C.inputBg` background, `C.textPrimary` text, default (proportional) font
- Status badges: `queued` → `C.textMuted`, `processing` → `C.delivered`, `completed` → `C.success`, `failed` → `C.danger`
- Dirty-save button: `C.success` when dirty, `C.inputBg` when clean
- `webCursor` on all interactive elements

---

## 8. Out of Scope

- Cancellation of in-flight jobs.
- Bulk operations (clear all failed, retry all failed).
- Real-time WebSocket push (polling is sufficient).
- Multi-model support (Gemini only for now; handler interface supports future models).
- `reference_attachments` — MetaVine's current LLM use case is text-only. The schema includes `result_artifacts` for forward compatibility but `reference_attachments` is omitted from the enqueue payload and job schema to keep things simple. Add it when an image/file use case arrives.
- Prompt template variable schema enforcement — the calling code handles substitution.
- Auto-draft trigger migration — the `useEffect` auto-draft logic in `ReviewItem` stays but calls `enqueuePromptJob` instead of `callGemini`. No changes to the trigger conditions themselves.

---

## Implementation Checklist

### Backend — `prompts` collection & endpoints (server.js)

- [ ] **`prompts` collection seed** — on startup, if collection is empty, seed from `backend/prompts/review-draft.md`, `ai-tell-phrases.jsonc`, `quality-rules.jsonc`
- [ ] **`GET /prompts`** — returns all prompts sorted by `updated_at` desc; seeds defaults if empty
- [ ] **`POST /prompts`** — creates new prompt; 409 if slug exists
- [ ] **`PUT /prompts/:slug`** — updates body, appends version, prunes to 100
- [ ] **`DELETE /prompts/:slug`** — deletes prompt; 404 if not found
- [ ] **Backward-compatible aliases** — existing `GET /prompts/review-draft`, `/ai-tell-phrases`, `/quality-rules` read from `prompts` collection by slug

### Backend — `prompt_queue` collection & worker (server.js)

- [ ] **`prompt_queue` collection** — schema per Section 3; indexes on `{ status, queued_at }` and `{ queued_at: -1 }`
- [ ] **`GET /prompt-queue`** — paginated query with status filter; returns `{ jobs, total, page, limit, pages }`
- [ ] **`GET /prompt-queue/counts`** — returns `{ queued, processing, completed, failed, active, total }`
- [ ] **`POST /prompt-queue`** — enqueues job; returns 202
- [ ] **Worker loop** — `setInterval` at `QUEUE_POLL_INTERVAL`; claims jobs, delegates to handler, retries transient errors with backoff
- [ ] **Gemini handler** — `handleGeminiJob(job)` calling Gemini API; reads key from `config.json`
- [ ] **`onReviewDraftComplete` callback** — parses title, upserts `review_draft` + `review_title` + `draft_quality` to items collection

### Frontend — `/prompts` page (prompts.tsx)

- [ ] **Prompt Manager card** — editor textarea (left), controls (right) with slug dropdown, save, version arrows, delete
- [ ] **Queue card** — tabs (Active/Completed/Failed/All) with count badges, paginated job rows, auto-polling
- [ ] **Sidebar entry** — add to `lib/routes.ts` NAV_ROUTES

### Frontend API (api.ts)

- [ ] **Prompt CRUD** — `api.prompts()`, `api.createPrompt()`, `api.updatePrompt()`, `api.deletePrompt()`
- [ ] **Queue methods** — `api.promptQueue()`, `api.promptQueueCounts()`, `api.enqueuePromptJob()`
- [ ] **Remove legacy** — legacy `api.promptReviewDraft()` and `api.promptAiTellPhrases()` kept as backward-compatible aliases (still used by `loadPromptTemplate()` and `loadTellPhrases()` in reviews); backend aliases now read from `prompts` collection

### Review-Draft Migration (reviews/_layout.tsx)

- [ ] **Replace `callGemini()`** — `runDraft()` calls `api.enqueuePromptJob()` instead of Gemini directly
- [ ] **Remove `geminiKeys` state** — backend handles API keys
- [ ] **Add draft polling** — poll item by ASIN or queue job status to detect when draft arrives

---

## Bugs

- [ ] **Prompt selector and version picker are custom-built TouchableOpacity dropdowns — replaced with native `<select>` elements.** The current implementation builds dropdown selectors out of TouchableOpacity lists with absolute positioning. This produces poor UX: no keyboard navigation, no native scroll containment, no click-outside-to-close, no focus management, and visually inconsistent with the platform. Both the prompt slug selector and the version picker must be replaced with native HTML `<select>` elements (on `Platform.OS === 'web'`) styled with the app's dark-mode tokens (`C.inputBg` background, `C.textPrimary` text, `C.border` border). Native selects handle all overlay/dismiss/keyboard behavior for free.

- [ ] **Queue empty state is vague.** Fixed: distinguishes "no jobs yet" (with guidance about Reviews page) from tab-specific "no active/completed/failed jobs" messages.

- [ ] **Page load flicker: cache re-fetched with setLoading(true) even when cache is valid.** Fixed: added 30-second TTL check (`cacheFresh`) that skips `setLoading(true)` when cache is fresh.

- [ ] **Delete button is bare text+icon while Save is an ActionButton — inconsistent control group.** Fixed: replaced Delete with `ActionButton variant='danger'`.

- [ ] **Prompt editor textarea uses monospace font — prompts are prose, not code.** Fixed: removed `fontFamily: 'monospace'`; uses default proportional font.

- [ ] **Scrollbars not styled for dark mode.** Fixed: global dark-mode scrollbar CSS added via `_layout.tsx useEffect` (`::-webkit-scrollbar` + `scrollbar-color` with C tokens).
