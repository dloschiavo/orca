---
name: admin-prompt-queue
description: >
  Use when building an admin/operator page that combines a prompt editor (top)
  with a queue of past or in-flight prompt runs (bottom). Covers the editor +
  history pattern on a per-entity detail page AND the standalone universal
  queue page that lists every job across the system. Includes the data model,
  background worker with retries, polling strategy, and shared job card UI.
---

# Admin Prompt Queue

A pattern for asynchronous prompt execution with operator visibility. Two complementary surfaces share one data model:

1. **Per-entity detail page** — top of page is the form/editor that defines the prompt inputs; bottom is the generation history for that specific entity. Used by operators iterating on a single prompt.
2. **Universal queue page** — standalone page listing every job across the system, with status tabs and pagination. Used by operators monitoring overall throughput, errors, and backlog.

Both surfaces consume the same `prompt_queue` collection through the same API and render rows with the same `JobCard` component.

Reference implementation: `influencer-studio/twp.react/` — files cited inline below.

## Data Model — `prompt_queue` collection

One document per job. Status discriminates lifecycle. Snapshots of inputs are captured at enqueue time so the rendered prompt is immutable even if the source entity is later edited.

```ts
{
  _id:                            ObjectId,
  entity_id:                      ObjectId,        // FK to the source entity (e.g. scene_id)
  entity_title:                   string,          // denormalized for display
  status:                         "queued" | "processing" | "completed" | "failed",
  queued_at:                      ISO datetime,
  started_at:                     ISO datetime | null,    // null until processing
  completed_at:                   ISO datetime | null,    // null until terminal
  rendered_prompt:                string,                 // full prompt text, immutable snapshot
  active_reference_image_paths:   string[],               // input snapshots, e.g. reference images
  result_image_paths:             string[],               // populated on success
  error:                          string | null,          // error message if failed
  attempt:                        number,                 // 1-based; incremented on transient retries
}
```

**Indexes:**
- `{ status: 1, queued_at: 1 }` — worker claims oldest queued jobs
- `{ entity_id: 1, queued_at: -1 }` — per-entity history lookup
- `{ queued_at: -1 }` — universal queue default sort

## API Endpoints

Reference: `influencer-studio/twp.react/api/routers/queue.py` and `routers/scenes.py`.

### `GET /api/queue` — list jobs (used by both surfaces)

```
GET /api/queue?status=all&entity_id=<id>&page=1&limit=20
```

**Query parameters:**
| Param | Type | Default | Description |
|---|---|---|---|
| `status` | string | `all` | `all` \| `active` (queued+processing) \| `queued` \| `processing` \| `completed` \| `failed` |
| `entity_id` | string | — | Filter to a single entity (used by detail page; omit for universal queue) |
| `page` | number | 1 | 1-based page index |
| `limit` | number | 20 | Page size |

**Response:**
```ts
{
  jobs:  Job[],
  total: number,
  page:  number,
  limit: number,
  pages: number,
}
```

Sort: `queued_at` descending.

### `GET /api/queue/counts` — counts by status (drives tab badges)

```ts
{
  queued: number,
  processing: number,
  completed: number,
  failed: number,
  active: number,    // queued + processing
  total:  number,
}
```

The `active` count is what the polling logic uses to decide whether to keep refreshing.

### `POST /api/<entity>/{id}/queue-generate` — enqueue a new job (returns 202)

This lives on the entity router (not the queue router) because it needs entity-specific context:
1. Fetch entity by id (404 if not found)
2. Render prompt template using current entity fields → `rendered_prompt`
3. Snapshot input arrays (e.g. `active_reference_image_paths`) — resolve any padded/derived paths now so the worker uses exactly what the operator saw
4. Insert job document with `status="queued"`, `attempt=1`, `queued_at=now`
5. Return the inserted job document immediately with HTTP 202 (do not wait for the worker to process it)

The operator sees the new job appear in the history below within one poll cycle.

## Background Worker

Reference: `influencer-studio/twp.react/api/services/prompt_queue_worker.py`.

**Constants:**
- `CONCURRENCY = 3` — max concurrent jobs in flight
- `MAX_ATTEMPTS = 3` — retry limit for transient failures
- `POLL_INTERVAL = 5` (seconds) — how often the worker scans for new queued jobs

**Loop:**
1. Sleep `POLL_INTERVAL` seconds
2. Compute `available = CONCURRENCY - in_flight`. If 0, continue.
3. Atomically claim up to `available` jobs in `status="queued"` ordered by `queued_at` ascending. Set `status="processing"`, `started_at=now`.
4. For each claimed job, spawn a task that runs the actual prompt and updates the job on completion.

**On success:**
- `status="completed"`, `result_image_paths` set, `completed_at=now`
- Optionally write back to the source entity (e.g. merge `result_image_paths` into the scene, set `images_generated_at`)

**On failure — distinguish transient vs permanent:**

```python
TRANSIENT_PATTERNS = [
    "resource exhausted", "quota", "overloaded", "rate limit",
    "try again", "too many requests", "503", "429",
    "service unavailable", "temporarily unavailable", "internal error",
]

def is_transient(error_message: str) -> bool:
    msg = error_message.lower()
    return any(p in msg for p in TRANSIENT_PATTERNS)
```

- **Transient + `attempt < MAX_ATTEMPTS`**: back off `30 * attempt` seconds, set `status="queued"`, `started_at=null`, `attempt += 1`. Worker will pick it up on a future poll.
- **Permanent OR `attempt >= MAX_ATTEMPTS`**: `status="failed"`, `error` set, `completed_at=now`. Stops here.

This split is important — quota/rate-limit errors should retry (the next attempt usually succeeds once capacity frees), but a malformed prompt should not loop forever burning credits.

## Surface 1 — Per-Entity Detail Page (Editor + History)

Reference: `influencer-studio/twp.react/app/app/influencer/scenes/[id].jsx`.

**Layout (top to bottom):**

1. **Form / Editor card** — input fields that compose the prompt. Editing is local; saved on explicit Save action. Track a `dirty` flag.
2. **Rendered prompt preview cards** — show the final prompt text(s) that will be sent when the operator clicks Generate. These are read-only, monospace, scrollable, max-height ~200px. Update live as the form changes (or on Save). Two preview cards is common (e.g. metadata prompt + image prompt).
3. **Generation History card** — list of `JobCard` components for jobs filtered to this entity. Hidden when the list is empty. Hidden entirely on the create-new screen (no entity id yet).

**Data loading:**
```jsx
const [sceneJobs, setSceneJobs] = useState([]);
const pollRef = useRef(null);

const loadJobs = async () => {
  const result = await getQueue({
    entity_id: id,
    status: "all",
    page: 1,
    limit: 100,
  });
  setSceneJobs(result.jobs);
};
```

**Polling — tied to active state, not always-on:**
```jsx
useEffect(() => {
  const hasActive = sceneJobs.some(
    j => j.status === "queued" || j.status === "processing"
  );
  if (hasActive) {
    pollRef.current = setInterval(loadJobs, 5000);
  }
  return () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };
}, [sceneJobs]);
```

When all visible jobs are terminal (completed/failed), polling stops. Resumes when a new job is enqueued.

**Enqueue action:** the Generate button on this page calls `POST /api/<entity>/{id}/queue-generate`, then immediately calls `loadJobs()` to show the new "queued" row. The operator gets instant feedback that the job exists, even before the worker picks it up.

## Surface 2 — Universal Queue Page

Reference: `influencer-studio/twp.react/app/app/universe/queue.jsx`.

**Layout:**
- Header: "Prompt Queue"
- Tab row: All / Active / Completed / Failed — each shows a count badge from `/api/queue/counts`
- Job list: paginated `FlatList` of `JobCard` rows (page size 20)
- Pagination footer: Previous / "Page X of Y" / Next, only shown when `pages > 1`
- Empty state: centered "No jobs found." text

**Tab logic:**
```jsx
const TABS = [
  { key: "all",       label: "All"       },
  { key: "active",    label: "Active"    },
  { key: "completed", label: "Completed" },
  { key: "failed",    label: "Failed"    },
];
```

Switching tabs resets `page` to 1.

**Counts come from a separate endpoint** (`/api/queue/counts`) so the badges stay accurate regardless of which page is currently rendered. Both endpoints are called in parallel on every load.

**Polling — same rule as the detail page:** poll every 5s only when `counts.active > 0`. Stop when there's nothing in flight. This keeps the page cheap when the queue is idle.

```jsx
useEffect(() => {
  const hasActive = (counts.active || 0) > 0;
  if (hasActive) {
    pollRef.current = setInterval(() => load(activeTab, page), 5000);
  }
  return () => {
    if (pollRef.current) clearInterval(pollRef.current);
  };
}, [counts.active, activeTab, page]);
```

## Shared `JobCard` Component

Reference: `influencer-studio/twp.react/app/components/ui/JobCard.jsx`.

Renders one job row. Same component used on both surfaces, controlled by props.

**Props:**
- `job` — the job document
- `showSceneLink` — when true, the entity title is rendered as a link (universal queue); when false, plain text (detail page already on that entity)
- `onImagePress(paths, index)` — optional, opens a lightbox

**Layout (top to bottom inside one card):**
1. **Header row:** entity title (linked or plain) on the left, status badge on the right
2. **Timestamps:** `queued_at` and `completed_at` in local browser time
3. **Error message:** red box, only when `status === "failed"`
4. **Image strip:** generated images and reference images side-by-side as 80×80 tiles. Click opens lightbox.
5. **Rendered prompt:** scrollable monospace text in a bordered box, with an uppercase "PROMPT" label

**Status badge colors:**
| Status | Color |
|---|---|
| queued | slate (#94a3b8) |
| processing | sky/blue (#0ea5e9) + spinner icon |
| completed | green (#10b981) |
| failed | red (#ef4444) |

The spinner on `processing` gives the operator immediate visual confirmation that something is actively running, without needing to check timestamps.

## Fit-to-Project

Before implementing, check:
- **DB layer:** what's the project's collection/table convention? Indexes added in the same place as other collections (e.g. `lib/db.ts`).
- **Worker host:** is there an existing background worker process to attach this to, or does it need its own? In Python projects with FastAPI, the worker often runs as an asyncio task started in `main.py` on app startup.
- **Auth:** the queue API endpoints almost always require admin or authenticated context — match the project's `requireAdmin` / `requireSession` pattern.
- **Polling interval:** 5s is the default; tune up if jobs take minutes (15-30s polling) or down if jobs are sub-second (1-2s).
- **Snapshot vs reference inputs:** if input files can be deleted/replaced after enqueue, snapshot the actual paths at enqueue time so the worker doesn't get a 404 later.

## Anti-Patterns

- **Re-rendering the prompt at worker time** — the prompt must be snapshot at enqueue. If the entity is edited between enqueue and execution, the worker should still run what the operator saw and clicked Generate on.
- **Always-on polling** — drains battery and burns API calls. Only poll when there are active jobs; stop when everything is terminal.
- **Treating all errors as permanent** — quota / rate limit / 503 errors should retry with backoff. Failing immediately wastes the queued work and forces the operator to manually re-enqueue.
- **Treating all errors as transient** — a malformed prompt or invalid input will loop forever, burning credits. Limit `MAX_ATTEMPTS` and only retry on the curated transient pattern list.
- **Synchronous enqueue** — the enqueue endpoint must return 202 immediately with the job document. Do not block on the worker. The UI should show the new "queued" row before any LLM call has been made.
- **Single endpoint for jobs + counts** — keep counts on a separate endpoint so the badges stay accurate regardless of pagination/filter state on the main list.
- **No status discriminator** — using separate "queue" and "history" tables forces awkward joins and breaks atomic status transitions. One table, one status field.
- **Mutating the source entity from the worker without snapshot** — if the worker reads the entity at execution time, you lose the editor's intent. Always snapshot inputs at enqueue.

## Logging

- Log every status transition with job id, entity id, attempt number, and elapsed time
- Log error messages verbatim for failed jobs (so operators can debug from logs without inspecting DB)
- Log "claimed N jobs" / "in flight: M" on each worker poll cycle for capacity visibility
