---
name: admin-prompt-queue
description: >
  Use when building an admin/ user page that combines prompt editing with
  a queue of past or in-flight prompt runs. Covers three surfaces — a
  versioned template manager, a per-entity editor + generation history page,
  and a universal queue page — sharing one data model, a pluggable worker
  with handler + onJobComplete callbacks, and a shared JobCard. Includes the
  full-snapshot rule, polling strategy, and UX details.
dependencies:
  requires: [admin-routing, draft-persistence]
  capabilities:
    auth: otp-auth
    design-system: admin-design-system
provides: [prompt-queue]
---

# Admin Prompt Queue

A pattern for asynchronous prompt execution with full user visibility. Three complementary surfaces share one data model:

1. **Prompt Manager** — a CRUD page for prompt templates stored as flat files at `web/prompts/{slug}.md`. users author, save, and (via git) browse history. The version dropdown is gone — git is the VCS.
2. **Per-entity detail page** — top is the form/editor that composes inputs for a specific entity; bottom is the generation history for that entity. Used when iterating on a single prompt.
3. **Universal queue page** — standalone page listing every job across the system, with status tabs and pagination. Used for monitoring throughput, errors, and backlog.

All three consume the same `prompt_queue` collection through the same API and render rows with the same `JobCard` component. The worker is handler-pluggable so the same queue can drive multiple job types (text generation, image generation, etc.).

Reference implementation: `influencer-studio/twp.react/` — files cited inline below.

---

> **Deliverable numbering**
>
> Every concrete deliverable in this recipe carries a number like `1.a`, `5.h`, `23.bb`. Every anti-pattern carries a number like `AP1`, `AP20`. The [Compliance Audit](#compliance-audit--required-completion-artifact) at the end of this file is the binding completion artifact: it must enumerate every numbered item verbatim with a file:line citation. No summaries, no paraphrase, no grouping. See the Compliance Audit section for the exact required format.

---

## 1. Canonical Path Scheme

Prompt templates and the queue surface are platform-wide concerns (every org reads from the same prompt catalog), so this recipe's pages live under `/platform/**` per `admin-routing/SKILL.md` § The Three Authenticated Trees. Pages use directory-style routing with single-noun sidebar labels:

| Path | Sidebar label | Tree |
|---|---|---|
| `/{org-slug}/users` | Users | org-scoped — `admin-routing` (tenancy) |
| `/admin/orgs` | Organizations | staff org-CRUD — `admin-routing` (tenancy) |
| `/platform/chat` | Chat | platform — `admin-chat` |
| `/platform/prompts` | Prompts | platform — this skill |

Do **not** flat-file pages as `platform-prompts.tsx` or `admin-prompt-queue.tsx`. The mixed scheme drifts breadcrumbs, lookups, and recipe references. The universal queue page in this recipe lives at **`/platform/prompts`** (sidebar: **"Prompts"**), not at any `admin-prompt-queue` flat-file.

**Deliverables:**

- **1.a** The universal queue page lives at `app/(app)/platform/prompts/index.tsx` (directory-style route, not a flat file).
- **1.b** The sidebar entry pointing at this page is labelled exactly **"Prompts"** and its `href` is `/platform/prompts`.

## 2. Single Loader for Every Prompt — `lib/promptLoader.ts`

**Every prompt the system uses must flow through one helper.** No `fs.readFileSync` of `prompts/*.md` scattered across route handlers. No special-cased "this prompt is loaded directly from disk" exceptions. The loader is the only place that reads prompt files; consumers go through it so the in-process cache stays consistent and an admin save is reflected by the next call across every code path.

The flat file at `web/prompts/{slug}.md` is the source of truth. The admin Prompt Manager (§ 20) writes the file directly; git is the VCS for history. There is no parallel DB collection that can drift out of sync with disk.

```ts
// lib/promptLoader.ts
import fs from "fs";
import path from "path";

export const PROMPTS_DIR = path.join(process.cwd(), "prompts");
const CACHE_TTL_MS = 5_000;
const cache = new Map<string, { body: string; updated_at: Date; ts: number }>();

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export function isValidSlug(slug: string): boolean { return SLUG_PATTERN.test(slug); }
export function promptPath(slug: string): string {
  if (!isValidSlug(slug)) throw new Error(`Invalid prompt slug: ${slug}`);
  return path.join(PROMPTS_DIR, `${slug}.md`);
}

export interface PromptDoc { slug: string; body: string; updated_at: Date; }

export async function loadPrompt(slug: string): Promise<PromptDoc> {
  const cached = cache.get(slug);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { slug, body: cached.body, updated_at: cached.updated_at };
  }
  const file = promptPath(slug);
  if (!fs.existsSync(file)) {
    throw new Error(`Prompt "${slug}" not found at ${file}`);
  }
  const body = await fs.promises.readFile(file, "utf-8");
  const stat = await fs.promises.stat(file);
  cache.set(slug, { body, updated_at: stat.mtime, ts: Date.now() });
  return { slug, body, updated_at: stat.mtime };
}

export function invalidatePromptCache(slug?: string): void {
  if (slug) cache.delete(slug);
  else cache.clear();
}
```

**Deliverables:**

- **2.a** `lib/promptLoader.ts` exists and exports `loadPrompt(slug): Promise<PromptDoc>` (returning `{ slug, body, updated_at }`) and `invalidatePromptCache(slug?: string): void`.
- **2.b** The loader uses a 5-second TTL cache keyed by slug.
- **2.c** The loader reads from `web/prompts/{slug}.md` (resolved via `path.join(process.cwd(), "prompts")`) and throws if the file does not exist. There is no fallback DB lookup — disk is the only source.
- **2.d** `updated_at` on the returned doc is the file's `mtime`. There is no separate stored `updated_at` field that can drift.
- **2.e** `PUT /api/prompts/[slug]` calls `invalidatePromptCache(slug)` after the write.
- **2.f** `DELETE /api/prompts/[slug]` calls `invalidatePromptCache(slug)` after the delete.
- **2.g** Every prompt consumer in the repo — including the enqueue endpoints — loads templates through `loadPrompt(slug)` (or a sibling helper built on the same cache); no route contains `fs.readFileSync` of a `prompts/*.md` file.
- **2.h** Slugs are validated against `^[a-z0-9][a-z0-9-]*$` before they become file paths. Anything else (path-traversal `../`, whitespace, uppercase, leading hyphens) is rejected at the API layer and inside `promptPath()`.

## 3. Snapshot Rule — Store the Exact Provider Call on Every Job

**The single most important rule:** every job row stores the exact provider SDK call payload on `job.request` and (for cached runs) the cache's own creation payload on `job.request_cache` — these are what actually went over the wire. The stored record is the literal API call, not a reconstructed preview of it. No pointers, no slug-plus-version lookup, no re-resolving templates at worker time, no authoring-time abstractions leaking into the record. The job row is a closed, reproducible, financially auditable, and *truthful* snapshot of what was sent and what came back.

**Prompt text vs query params — the distinction matters.**

The LLM receives two categories of stuff:

1. **Text content** — the system instruction, prior-turn context, and the current user turn. All of this is *content*. It ends up inside `job.request` at specific provider-shaped slots (`systemInstruction` + `contents` for Gemini, `messages` array for OpenAI, etc.). It is **never** stored on `inputs`.
2. **Query parameters** — the provider's non-text knobs: `model`, `temperature`, `max_tokens`/`max_output_tokens`, `timeout_ms`, `cache_ttl_seconds`, response-format flags, tool-selection flags. These go on `inputs`, because they tune *how* the text is run, not *what* the text is.

The single worst sin in this recipe is passing per-turn content as an input param. **`user_message` is not an input param — it is the user turn of the prompt.** It belongs inside `job.request.contents`. The same goes for prior chat history, system-message preambles, injected context — any *text* the LLM sees at inference time.

`{vars}` in templates follow the same rule: they are inline text substitutions, resolved at enqueue, and the *result* flows into `job.request` via the handler's composer. Template variables are never stored back as separate params.

This means:
- **Not** `job.prompt_slug = "review-draft"` + look up the current body later.
- **Not** `{ prompt_slug, prompt_version_id }` + join to a versions table.
- **Not** `{ rendered_prompt: "system text", inputs: { user_message: "Hi" } }` — the user turn is **part of the prompt**, not a param.
- **Not** a flat role-marked string `"[SYSTEM]\n...\n[USER]\n..."` as the "rendered prompt" when the handler actually fired a structured SDK call with `systemInstruction`, `contents`, and `cachedContent` in separate fields. If the handler splits the payload, the stored record shows the split — not the pre-split authoring form.
- **Yes** `job.prompt = { slug, body, updated_at }` — the entire template document as it existed the moment the user clicked Generate (for provenance).
- **Yes** `job.request` = the **exact provider SDK call payload** that was fired — pretty-printable as JSON, includes the model name, the final systemInstruction or cachedContent reference, the contents payload, and the config knobs.
- **Yes** `job.request_cache` = the cache's own creation payload (model, systemInstruction, ttl) when the run used caching indirection (`cachedContent` replaces inline `systemInstruction`). Null for non-cached runs. This is what lets a reader see *what's inside* the cache reference without hunting through the provider's cache-admin API.
- **Yes** `job.inputs` captures the query-level parameters and *only* those: model name (always), `max_tokens` / `max_output_tokens`, `temperature` (when set), `timeout_ms`, `cache_ttl_seconds`, provider-specific tuning flags. Not the user message. Not prior-turn text. Not anything the LLM will parse as content.
- **Yes** `job.response` captures the primary output body (`text` / `artifacts` / equivalent), any `finish_reason` / `stop_reason`, and a `usage` object with per-run token counts (`prompt_tokens`, `output_tokens`, `total_tokens`) plus `estimated_cost_usd`. The **model name lives in `inputs`, not here** — it's what I asked for, not what I got back.

Why: the point of the queue is a durable record of "what was sent, what came back, and what it cost." The moment you introduce a slug-to-current-body lookup, a template edit silently rewrites history. The moment you silo the user turn into `inputs`, the stored "prompt" is a lie — it's only part of what the LLM saw. The moment you store a flat authoring-form preview when the handler actually fired a multi-field structured call, you hide the split (and the caching indirection) from the debugger. With faithful snapshots, every job can be reproduced or replayed by reading one document — no inference required about what really went over the wire.

**Deliverables:**

- **3.a** Every job row stores `job.prompt = { slug, body, updated_at }` captured at enqueue time (not a slug-only pointer, not a FK to a versions table).
- **3.b** Every completed job row stores the full handler response object on `job.response`, including the primary output body (`text` / `artifacts` / equivalent), `finish_reason`, and a `usage` sub-object.
- **3.c** The worker never re-resolves the template body at execution time; the template render happens once, at enqueue, feeding the composer that produces `job.request`.
- **3.d** The rendered template text fed into the composer is fully substituted — it contains no unresolved `{ident}` placeholders. The enqueue helper MUST validate this and fail fast if any placeholder remains (with an explicit escape hatch flag for prompts that legitimately contain literal braces).
- **3.e** `job.request` contains the **exact provider SDK call payload** — model, final systemInstruction (or cachedContent reference), contents, config knobs — in the shape that provider's SDK consumes. It is populated at enqueue time by the handler's registered composer and optionally mutated at execution time when caching indirection applies (see 5.2).
- **3.f** Per-turn text (system instruction, chat history, user turn, assistant turns) lives exclusively inside `job.request.*` content slots — never on `inputs` as a separate field.
- **3.g** `job.inputs` carries query-level parameters only: model name (always), `max_tokens`/`max_output_tokens`, `temperature` (when set), `timeout_ms`, `cache_ttl_seconds`, and any provider-specific non-text knobs. `inputs` does NOT contain `user_message`, chat history, system preamble, or any other text content the LLM will parse. Defaults that the handler would fall back to are written into `inputs` at enqueue, not left implicit.
- **3.h** `job.request_cache` is populated when the run used caching indirection — it captures the cache's own creation payload (model, systemInstruction body, ttl) so a reader can see what's pinned inside the `cachedContent` reference on `job.request`. Null for non-cached runs.
- **3.i** The **model name is stored in `inputs.model`**, not in `job.response`. It is a query parameter, not an output. (Handlers that observe a provider-reported fallback model may add `response.model_used` as a confirmation field, but the *requested* model belongs on the input side.)
- **3.j** `job.response.usage` contains `prompt_tokens`, `output_tokens`, and `total_tokens` for every completed LLM job. When the provider returns additional counters (cache hits, reasoning tokens, tool-call tokens) they are preserved on `usage` verbatim.
- **3.k** `job.response.usage.estimated_cost_usd` is computed from the actual model and the `usage` counts using a per-model pricing table in the handler module. An unknown model returns `null` rather than a fabricated number; a `pricing_per_mtok` sibling captures the rates used so the computation is re-verifiable months later.
- **3.l** On retries (transient failure → requeue), the handler re-composes and re-persists `job.request` (and `job.request_cache`) for each attempt. The stored values reflect the **latest** attempt's payload; per-attempt timestamps for prior retries live in worker logs keyed by job id + attempt number (see § 25).

## 4. Storage — flat files at `web/prompts/{slug}.md` (optional)

Use this storage layer when prompt templates are reused across many jobs and edited over time by users. If each job builds a one-off prompt inline from entity fields, skip storage entirely — the job still snapshots its own prompt at enqueue (see § 3).

```
web/
  prompts/
    amelia-chat.md
    amelia-compiler.md
    review-draft.md
    ...
```

One file per slug. The file is a UTF-8 markdown document whose body is the template (with `[SYSTEM]`/`[MAIN]` scaffolding — see § 5.1) and whose `mtime` is the `updated_at`. Files live inside the deploy unit so they ship with the rest of the app; no separate seeding step, no parallel DB collection, no version array.

**Why flat files, not a DB collection.** The DB-collection-with-`versions[]` shape (older revisions of this recipe) tried to serve two masters: editing through an admin UI *and* preserving history. Doing both inside Mongo meant (a) every deploy needed a seed-then-upsert dance to keep DB in sync with disk, (b) the version array was capped and silently pruned, and (c) the editor's "load older version" UX was a separate write/read path the rest of the system had to learn about. Flat files plus git collapses all of that: the file IS the current body, git log IS the history, `git show <ref>:web/prompts/<slug>.md` IS "load older version", and `cp web/prompts/foo.md backup/foo.md && vim` is the disaster-recovery story. One source of truth, one editing path, no cap.

**Versioning rules:**
- Every save overwrites the file. There is no in-DB version array, no cap, no prune. Git is the VCS.
- "Browse history" means `git log -p web/prompts/<slug>.md` (or any git GUI). The admin UI does **not** render historical versions inline — those tools already exist and are better than what a textarea can show.
- A user who wants to revert an older version uses `git checkout <ref> -- web/prompts/<slug>.md` (or copy-pastes from a git GUI back into the editor). The editor itself only ever writes the current file; it does not present a "reset to N revisions ago" affordance.

**Deliverables:**

- **4.a** Prompt templates live as flat files at `web/prompts/{slug}.md`, one file per slug, inside the same deploy unit (the Next.js app's working directory) as the rest of the server code.
- **4.b** No `prompts` MongoDB collection exists, no `prompts` table exists, no parallel DB record of prompt bodies exists. The file is the only stored form.
- **4.c** Every `PUT /api/prompts/:slug` overwrites the file. There is no append-only version log inside the app; the version log is git history of the prompts directory.
- **4.d** No code path caps, prunes, or summarizes "version count." History capacity is whatever git provides.
- **4.e** The admin editor does not surface historical revisions inline. The UI shows only the current body plus a small "Last saved … — history lives in git" caption (see § 20.f). Historical browsing happens through `git log`/git GUI.

## 5. Data Model — `prompt_queue` collection

One document per job. `status` discriminates lifecycle. Everything needed to reproduce or audit the job is stored on the document itself.

```ts
{
  _id:              ObjectId,
  handler:          string,                // which handler processes this ("gemini", "image-gen", ...)

  entity_id:        ObjectId | null,       // FK to the source entity (nullable for non-entity jobs)
  entity_title:     string | null,         // denormalized for display

  // Full prompt snapshot — taken at enqueue, never mutated.
  prompt: {
    slug:       string,                    // template identifier (for grouping/filtering ONLY — not a live pointer)
    body:       string,                    // template body as it existed at enqueue
    updated_at: ISO datetime,              // file mtime of web/prompts/{slug}.md at enqueue
  },

  // Exact provider SDK call payload. Composed at enqueue by the handler's
  // registered composer, potentially mutated at execution time when caching
  // indirection applies. This is what the LLM actually saw.
  request:          object | null,         // e.g. { model, systemInstruction | cachedContent, contents, config }

  // When the handler swapped inline systemInstruction for a cachedContent
  // reference, this sibling records the cache's own creation payload so
  // readers can see what's pinned inside. Null for non-cached runs.
  request_cache:    object | null,         // e.g. { name, model, ttl_seconds, systemInstruction }

  // Query-level knobs only: model, temperature, max_tokens, timeout_ms,
  // cache_ttl_seconds. NEVER per-turn text.
  inputs:           object,

  // Opaque application data passed through to onJobComplete. The worker does not read this.
  context:          object,                // e.g. { asin } or { scene_id, variant }

  status:           "queued" | "processing" | "completed" | "failed" | "skipped",
  queued_at:        ISO datetime,
  started_at:       ISO datetime | null,
  completed_at:     ISO datetime | null,

  // Full response, captured at completion time. Shape depends on handler.
  response:         object | null,         // e.g. { text, finish_reason, usage: { ... } }
  error:            string | null,         // "Cancelled by user" | "Timed out after 10m" | model error
  attempt:          number,                // 1-based; incremented on transient retries
}
```

**Deliverables (one per field — the model/type declaration must contain every one verbatim):**

- **5.a** `handler: string` field exists.
- **5.b** `entity_id: ObjectId | null` field exists.
- **5.c** `entity_title: string | null` field exists.
- **5.d** `prompt: { slug: string, body: string, updated_at: Date }` snapshot object field exists.
- **5.e** `request: object | null` field exists — the exact provider SDK call payload, composed at enqueue and potentially mutated by the handler at execution time. Replaces the earlier `rendered_prompt: string` field (which is forbidden — see AP28).
- **5.f** `request_cache: object | null` field exists — the cache's own creation payload for runs that used caching indirection; null otherwise.
- **5.g** `inputs: object` field exists (query-level params only, snapshotted at enqueue).
- **5.h** `context: object` field exists (opaque to the worker).
- **5.i** `status: "queued" | "processing" | "completed" | "failed" | "skipped"` discriminator field exists. `"skipped"` is written by the scheduler (§ 26) when a spend-cap check refused the fire — it never reaches the worker.
- **5.j** `queued_at: Date` field exists.
- **5.k** `started_at: Date | null` field exists.
- **5.l** `completed_at: Date | null` field exists.
- **5.m** `response: object | null` field exists.
- **5.n** `error: string | null` field exists.
- **5.o** `attempt: number` (1-based) field exists.

## 5.1. Template Authoring — Role-Marker Scaffolding

The TEMPLATE (the `.md` file on disk / in the `prompts` collection) uses role markers as **authoring scaffolding** — a clean visual shape for "what ends up where" when the handler composes the provider call. The markers are not a stored data format: the flat role-marked string exists only transiently, in memory during enqueue, as the input to the handler's composer. What gets stored on the job is `job.request` — the structured provider SDK payload. See § 5.2 for that.

The top-level scaffold is two markers: `[SYSTEM]` for the stable, cacheable base prompt and `[MAIN]` for the per-call content. `[MAIN]` is a **wrapper**: its body may contain nested `[HISTORY]`, `[USER]`, and `[ASSISTANT]` markers when a chat template needs to keep history separate from the current turn (the cache boundary lives at `[SYSTEM]`, so the split is what makes caching pay off — see AP27); when no nested markers appear, the entire `[MAIN]` body is treated as a single user turn (sufficient for one-shot prompts like a KB compiler whose only dynamic content is the input corpus).

```
[SYSTEM]
<stable, cacheable base prompt — persona / rules / KB>

[MAIN]
[HISTORY]
<per-session volatile context — prior-turn chat, transient system notes>

[USER]
<current user turn>
```

For a one-shot prompt with no chat history, the same scaffold collapses to:

```
[SYSTEM]
<stable instructions — persona / rules / output format>

[MAIN]
<the per-call payload, e.g. {transcripts}>
```

**Why three roles, not two.** Modern LLM providers distinguish a stable *system instruction* from the per-turn *contents* list, and most of them offer a context cache whose boundary sits at the system instruction. Conflating per-session chat history into `[SYSTEM]` defeats the cache because the system instruction changes every turn. The three-role split matches the cache boundary:

| Template role | Gemini mapping | OpenAI mapping | Cacheable? |
|---|---|---|---|
| `[SYSTEM]` | `systemInstruction` | `messages[0]` with `role: "system"` | ✅ Yes — this is the cache boundary |
| `[MAIN]` | (Wrapper — its parsed children become the per-turn `contents`) | (Wrapper — its parsed children become the user-facing `messages`) | ❌ Wrapper only — never the cache boundary |
| `[HISTORY]` (inside `[MAIN]`) | Prepended to the current user `contents` | Earlier `messages` entries (or prepended) | ❌ No — volatile per-turn |
| `[USER]` (inside `[MAIN]`, or as the implicit single turn when `[MAIN]` has no nested markers) | Current `contents` entry | Final `messages` entry with `role: "user"` | ❌ No — the current turn |
| `[ASSISTANT]` (inside `[MAIN]`) | `role: "model"` turn in `contents` | `role: "assistant"` entry | ❌ No |

Handlers implement this mapping when composing the provider call: `[SYSTEM]` goes to the system-instruction slot (where the provider's cache can pin it), `[HISTORY]` is concatenated with `[USER]` to form the user-content payload. Storage uses the flat string form so one field captures the full exact prompt regardless of provider.

**The scaffolding rule (most important).** Every piece of structure and content that ends up in `rendered_prompt` must be traceable to the template body — either as literal text the template writes verbatim, or as a `{placeholder}` the template explicitly declares. Handlers, enqueue helpers, and call sites are FORBIDDEN from appending, prepending, or wrapping content at render time. No "just adding this `[System: ...]` note if it's an idle frame"; no "just wrapping with `[SYSTEM]` markers because the template didn't include them." If a consumer of the template needs to see it, the template must show it — as literal scaffolding or as a named slot whose purpose is obvious from the template.

Consequences:

- **Role markers live in the template body.** The template itself writes `[SYSTEM]`, `[USER]`, and `[ASSISTANT]` literally, on their own lines, as structural scaffolding. Nothing in the enqueue helper or handler injects these markers.
- **Conditional content is a named variable slot.** If the server sometimes injects a contextual note (e.g. `[System: 30+ seconds have elapsed…]` for an idle frame), the template must have a `{idle_frame_note}` (or similarly-named) slot where that note appears. The enqueue call substitutes the literal note string on idle frames and the empty string otherwise. Runtime appending is banned.
- **Per-turn content is a named variable slot.** `{user_message}`, `{chat_recent}`, `{reference_doc}`, etc. live inside the template's role sections. The template reader knows exactly where every bit of dynamic content lands.
- **Caller-side sentinel values (e.g. `[continue]` for an empty user turn) are substituted values for a declared slot, not handler-invented defaults.** If the idle-frame path has no visitor message, the enqueue caller explicitly substitutes `[continue]` (or whatever sentinel the project chooses) into `{user_message}`. The sentinel appears in the stored `rendered_prompt` because it was substituted by a named, auditable code path — not because a handler silently replaced an empty string.

**The scaffolding rule (the most important one in this section).** Every piece of structure and content that ends up in the rendered template text must be traceable to the template body — either as literal text the template writes verbatim, or as a `{placeholder}` the template explicitly declares. Handlers, enqueue helpers, and call sites are FORBIDDEN from appending, prepending, or wrapping content at render time. No "just adding this `[System: 30+ seconds...]` note if it's an idle frame"; no "just wrapping with `[SYSTEM]` markers because the template didn't include them." If a consumer of the template needs to see it, the template must show it — as literal scaffolding or as a named slot whose purpose is obvious from the template.

**The WHETHER-vs-WHAT rule.** When a template slot's purpose is "tell the LLM that some condition fired" (e.g. the session is idle, the visitor is a returning user, the input has been flagged as sensitive), the variable value must be a **signal**, not a sentence. The instruction for what to do in that case lives in the static `[SYSTEM]` section of the template; the variable value is a literal boolean token — `true` or `false` — and the template writes the labeled flag line that contains it (e.g. `idle_frame: {idle_frame}`, which renders as `idle_frame: true` or `idle_frame: false`). Passing a full sentence like `"The visitor has been idle for 30+ seconds, please follow the TAKE FRAME directive above"` as the variable value duplicates instructions that already exist in the template, couples the wording of the instruction to the call site's string literal (inevitable drift over time), and makes the conditional logic invisible to anyone reading the template alone. The template owns the WHAT; the variable owns the WHEN.

Consequences:

- **Role markers live in the template body.** The template itself writes `[SYSTEM]`, `[HISTORY]`, `[USER]`, `[ASSISTANT]` literally, on their own lines. Nothing in the enqueue helper or handler injects these markers.
- **Conditional content is a named variable slot.** If the server sometimes injects a contextual note (e.g. `[System: 30+ seconds have elapsed…]` for an idle frame), the template must have a `{idle_frame_note}` slot inside `[HISTORY]`. The enqueue call substitutes the literal note on idle frames and the empty string otherwise. Runtime appending is banned.
- **Per-turn content is a named variable slot.** `{user_message}`, `{chat_recent}`, `{reference_doc}` live inside their respective role sections. The template reader sees exactly where each bit of dynamic content lands.
- **Caller-side sentinel values (e.g. `[continue]` for an empty user turn) are substituted values for a declared slot, not handler-invented defaults.** If the idle-frame path has no visitor message, the enqueue caller explicitly substitutes `[continue]` into `{user_message}`. The sentinel appears in the stored `rendered_prompt` because it was substituted by a named, auditable code path — not because a handler silently replaced an empty string. Each project chooses its own sentinel and declares it as a named constant at the call site.

Parsing rules:

- Markers are literal `[SYSTEM]`, `[MAIN]`, `[HISTORY]`, `[USER]`, and `[ASSISTANT]`, uppercase, surrounded by square brackets, at the start of a line.
- The top-level scaffold is `[SYSTEM]` followed by `[MAIN]`. `[MAIN]` is a wrapper: when its body contains nested `[HISTORY]`/`[USER]`/`[ASSISTANT]` markers, the parser hoists those nested turns to the top-level turn list (so the composer sees `system` + `history` + `user` as if they were declared directly). When `[MAIN]`'s body contains no nested markers, the entire body becomes a single `[USER]` turn — bare prose inside `[MAIN]` is per-call user content, never system content.
- Text before the first marker is treated as an implicit `[SYSTEM]` turn (backward-compat fallback only; new templates declare `[SYSTEM]` explicitly).
- `{var}` placeholders are resolved inline during the single template-render pass; the deliverable 3.d validator applies to the whole string, so an unresolved placeholder anywhere — in system, main, history, user, or assistant sections — is a fail.
- The handler parses with `parsePromptTurns` and maps turns to the provider's shape: `[SYSTEM]` → provider's system-instruction slot (the cache boundary), `[HISTORY]` concatenated with `[USER]` → user contents. `[ASSISTANT]` turns go into the contents list as model turns. Composers see `[MAIN]` only as a parsing artifact — it never appears in the composed request.
- The enqueue helper `formatPromptTurns(turns)` is retained as a programmatic composition utility (tests, one-off call sites) but the production path is: **template body declares markers + slots → `renderTemplate` substitutes → stored verbatim**. Call sites should NOT compose via `formatPromptTurns` on top of a template that already declares markers — that's double-scaffolding.

A real Amelia-chat template:

```
[SYSTEM]
You are Amelia. <persona, rules, KB — stable content>

[MAIN]
[HISTORY]
{chat_recent}
{idle_frame_note}

[USER]
{user_message}
```

After rendering with `{chat_recent: "CONVERSATION SO FAR:\n[+0s] Visitor: Hi", idle_frame_note: "", user_message: "What are your prices?"}`:

```
[SYSTEM]
You are Amelia. <persona, rules, KB>

[MAIN]
[HISTORY]
CONVERSATION SO FAR:
[+0s] Visitor: Hi


[USER]
What are your prices?
```

On an idle-frame trigger, `idle_frame_note` gets `[System: 30+ seconds have elapsed…]` and `user_message` gets `[continue]`. Every character traces back to a template literal or a substituted slot.

**Deliverables:**

- **5.1.a** Templates use the literal `[SYSTEM]`/`[MAIN]`/`[HISTORY]`/`[USER]`/`[ASSISTANT]` role markers, one per line, at the start of a line. `[SYSTEM]` and `[MAIN]` are the top-level scaffold; `[HISTORY]`/`[USER]`/`[ASSISTANT]` are nested children of `[MAIN]` (or absent, in which case the `[MAIN]` body is a single user turn).
- **5.1.b** Role markers appear in the **template body on disk / in the DB** — not injected at enqueue time by helpers or by the handler. The template is the single source of truth for the structural shape the composer will consume.
- **5.1.c** Every non-literal byte in the rendered template text was produced by substituting a named `{var}` slot that the template declares. Appending, prepending, or wrapping content at runtime — by handlers, enqueue helpers, or call sites — is prohibited (see AP26).
- **5.1.d** Conditional content that only appears in some runs (idle-frame flags, tool-use prefaces, persona overrides) is declared in the template as a named slot and substituted with the empty string on the runs where it does not apply. No `if (isIdleFrame) prompt += "..."` at the call site.
- **5.1.e** Caller-side sentinel substitutions (e.g. `[continue]` for an empty user turn) are defined as named constants in the enqueue call site, passed via the `variables` map, and visible in the rendered output because they were substituted — not because a handler invented them.
- **5.1.f** The template places `[SYSTEM]` content above `[MAIN]` content. Inside `[MAIN]`, when nested markers are present, `[HISTORY]` content sits above `[USER]` content. Stable cacheable material lives in `[SYSTEM]`; per-session volatile material (chat history, transient system notes) lives in `[HISTORY]` (or, for one-shot prompts with no history, directly inside `[MAIN]`). Conflating per-turn material into the `[SYSTEM]` block defeats the provider's context cache and is a bug (see AP27).
- **5.1.g** The handler's composer maps `[SYSTEM]` to the provider's system-instruction slot (Gemini `systemInstruction`, OpenAI `role: "system"` message) and maps `[HISTORY]` + `[USER]` to the user-content payload (Gemini `contents`, OpenAI user messages). Composers do NOT fold `[HISTORY]` text into the system-instruction slot.
- **5.1.h** Text before the first marker is treated as an implicit `[SYSTEM]` turn; a text with no marker at all is treated as a single-turn system prompt (backward-compat fallback only; new templates declare `[SYSTEM]` explicitly).
- **5.1.i** The per-turn text after rendering is fully variable-substituted (§ 3.d) — no `{ident}` tokens survive anywhere in the composer's input.
- **5.1.j** A shared `parsePromptTurns(text)` helper splits the rendered text into `{role, content}` objects for the composer. Composers use it; they do NOT hand-parse the marker syntax.
- **5.1.k** The composer reads per-turn content exclusively from the parsed rendered text, never from `inputs`. An enqueue caller that puts user-turn text into `inputs` is a bug (see AP24).
- **5.1.l** The flat role-marked string is **not stored** on the job document. It exists only transiently in memory during enqueue, as the input to the composer. The stored form is `job.request` (see § 5.2).
- **5.1.m** Conditional-signal variables carry a WHETHER value, not a WHAT sentence. The instruction for what to do when the condition fires lives in the static `[SYSTEM]` section of the template; the variable value is a literal boolean token (`true` / `false`) and the template writes the flag line around it (e.g. `idle_frame: {idle_frame}` renders as `idle_frame: true` or `idle_frame: false`). Passing full-sentence instruction text as a variable value is an anti-pattern (see AP30) — it duplicates instructions that already exist in the template, couples their wording to the call site's string literal, and makes the conditional logic invisible to anyone reading the template alone.
- **5.1.n** `[MAIN]` is a parser-visible wrapper, not a request-shape role. `parsePromptTurns` recognizes it as a top-level marker, recurses into its body to honor nested `[HISTORY]`/`[USER]`/`[ASSISTANT]` markers (and treats a body with no nested markers as a single `[USER]` turn), and the composer sees the hoisted child turns directly. No `[MAIN]` role exists in the composed request; no provider has a `main` slot.

## 5.2. `job.request` — Exact Provider Call Capture

`job.request` is the literal SDK call payload the handler passes to the provider — the authoritative record of what went over the wire. Pretty-printable as JSON. Populated at enqueue by the handler's registered composer; potentially mutated by the handler at execution time to swap inline systemInstruction for a `cachedContent` reference.

### Composer registry

Each handler registers a composer alongside its execute function:

```ts
registerComposer("gemini", composeGeminiRequest);
registerHandler("gemini", handleGeminiJob);

function composeGeminiRequest(rendered: string, inputs: any): object {
  const turns = parsePromptTurns(rendered);
  return {
    model: inputs.model,                                         // required
    systemInstruction: collectTurn(turns, "system"),             // [SYSTEM]
    contents: joinTurns(collectTurn(turns, "history"),
                        collectTurn(turns, "user")),             // [HISTORY] + [USER]
    config: {
      maxOutputTokens: inputs.max_tokens,
      ...(typeof inputs.temperature === "number"
         && { temperature: inputs.temperature }),
    },
  };
}
```

`enqueueJob` calls `composeRequest(handlerName, rendered, inputs)` after rendering the template and stores the result on `job.request`. The job lands in the queue with its request already populated — no "pending, no request yet" intermediate state for a normal enqueue.

### Execution-time mutation (caching indirection)

When `inputs.cache_ttl_seconds > 0`, the handler at execution time:
1. Creates (or reuses) a provider-side cache pinned to `(model, systemInstruction)`.
2. Mutates `request`: removes `systemInstruction`, adds `cachedContent: <cache name>`.
3. Builds `request_cache = { name, model, ttl_seconds, systemInstruction }` — the cache's own creation payload for reader transparency.
4. **`setJobRequest(jobId, request, request_cache)` — persists both to Mongo BEFORE firing the SDK call** so a timeout or crash still leaves a faithful record of what was being attempted.
5. Fires the SDK call with the mutated `request`.

If cache creation fails (system content below the provider's minimum, API error), the handler falls back to inline `systemInstruction` and leaves `request_cache` null. Transparent degradation.

### Retry semantics

On a transient failure the worker requeues the job and re-claims it later with `attempt` incremented. The handler runs again and re-persists `request` and `request_cache` for that attempt. The stored values always reflect the **latest** attempt's payload. Per-attempt timestamps for prior retries live in the worker's stdout logs (see § 25.a, which requires every status transition log line to carry `attempt=N`).

### Deliverables

- **5.2.a** `enqueueJob` calls a handler-specific composer function — registered via `registerComposer(handlerName, fn)` — to turn the rendered template text into the provider SDK call payload, which is stored on `job.request` at enqueue time.
- **5.2.b** The composer is pure: `(rendered: string, inputs: object) => object`. It does not touch the DB, the filesystem, or the network; it does not read the job doc or the `context`; it does not mutate its inputs.
- **5.2.c** `job.request` is populated at enqueue time (not at handler execution) for normal enqueues. A job landing in the queue always has `request` set unless the enqueue path itself failed.
- **5.2.d** Handlers MAY mutate `job.request` at execution time to reflect execution-time indirection (cache reference swap, provider fallback, tool-call injection). When they do, they persist the mutated `request` (and the sibling `request_cache` where applicable) to Mongo **before** firing the provider SDK call — so a failed call still leaves the attempted payload visible.
- **5.2.e** The SDK call fires with **exactly** the object stored on `job.request` at that moment — no hidden config merged in at the call site, no handler-only knobs that don't appear in the stored payload. If it's in the call, it's in the record.
- **5.2.f** For cached runs, `job.request` contains a `cachedContent` reference and no `systemInstruction`; `job.request_cache` contains the cache's creation payload (`name`, `model`, `ttl_seconds`, `systemInstruction`). For non-cached runs, `job.request` contains inline `systemInstruction` and `job.request_cache` is null.
- **5.2.g** On transient retries, the handler re-composes (or re-resolves) and re-persists `job.request` and `job.request_cache` on each attempt. The stored document shows the **latest** attempt's payload; earlier attempts' payloads live only in worker logs.
- **5.2.h** The shape of `job.request` is provider-specific and matches whatever the provider SDK's primary request method accepts. Gemini: `{ model, systemInstruction | cachedContent, contents, config }`. OpenAI: `{ model, messages, ...config }`. Anthropic: `{ model, system, messages, max_tokens, ... }`. Each handler owns its shape.

## 6. Indexes on `prompt_queue`

**Deliverables:**

- **6.a** Index `{ status: 1, queued_at: 1 }` exists (worker claim order).
- **6.b** Index `{ entity_id: 1, queued_at: -1 }` exists (per-entity history lookup).
- **6.c** Index `{ queued_at: -1 }` exists (universal queue default sort).
- **6.d** Index `{ "prompt.slug": 1, queued_at: -1 }` exists (optional template filter). This one may be deferred if the universal queue's `prompt_slug` filter is not yet wired into the UI.

## 7. API Endpoints — Prompts CRUD

Only if the project surfaces an admin Prompt Manager:

| Method | Route | Behavior |
|---|---|---|
| `GET /api/prompts` | — | List prompts. Reads `web/prompts/*.md`, returns `[{ slug, body, updated_at }]` sorted by file mtime desc. No `versions` array — git is the VCS. |
| `POST /api/prompts` | `{ slug, body }` | Create the file `web/prompts/{slug}.md`. 400 if the slug fails the `^[a-z0-9][a-z0-9-]*$` check; 409 if the file already exists. |
| `PUT /api/prompts/:slug` | `{ body }` | Overwrite the file. **Must call `invalidatePromptCache(slug)` after the write.** 404 if the file doesn't exist. |
| `DELETE /api/prompts/:slug` | — | Unlink the file. 404 if not found. **Must call `invalidatePromptCache(slug)` after the delete.** |

**Deliverables:**

- **7.a** `GET /api/prompts` returns all prompts sorted by `updated_at` (file mtime) descending. Each item is `{ slug, body, updated_at }` only — no `versions` array.
- **7.b** `POST /api/prompts` accepts `{ slug, body }`, validates the slug against `^[a-z0-9][a-z0-9-]*$` (400 on mismatch), and returns 409 if the file already exists.
- **7.c** `PUT /api/prompts/:slug` accepts `{ body }`, overwrites the file via `fs.writeFile`, and returns 404 when the file does not exist (the editor never creates new slugs through PUT — POST is the only path that creates).
- **7.d** `DELETE /api/prompts/:slug` unlinks the file and returns 404 if the slug is not found.

## 8. API Endpoint — Queue list (`GET /api/queue`)

```
GET /api/queue?status=all&entity_id=<id>&prompt_slug=<slug>&page=1&limit=20
```

| Param | Type | Default | Description |
|---|---|---|---|
| `status` | string | `all` | `all` \| `active` (queued+processing) \| `queued` \| `processing` \| `completed` \| `failed` |
| `entity_id` | string | — | Filter to a single entity (used by detail page; omit for universal queue) |
| `prompt_slug` | string | — | Optional filter by `prompt.slug` |
| `page` | number | 1 | 1-based |
| `limit` | number | 20 | Page size |

**Response:** `{ jobs, total, page, limit, pages }`. Sort: `queued_at` descending.

**Deliverables:**

- **8.a** Accepts `status` query parameter with values `all`, `active`, `queued`, `processing`, `completed`, `failed`.
- **8.b** Accepts `entity_id` query parameter.
- **8.c** Accepts `prompt_slug` query parameter.
- **8.d** Accepts `page` query parameter (default 1, 1-based).
- **8.e** Accepts `limit` query parameter (default 20).
- **8.f** Response shape is exactly `{ jobs, total, page, limit, pages }`.
- **8.g** Jobs are sorted by `queued_at` descending.

## 9. API Endpoint — Queue counts (`GET /api/queue/counts`)

```ts
{ queued, processing, completed, failed, active, total }
```

`active = queued + processing`. This is what the polling logic watches — stop polling when it hits zero.

**Deliverables:**

- **9.a** Response shape is exactly `{ queued, processing, completed, failed, active, total }`.
- **9.b** `active` is returned as `queued + processing`.

## 10. API Endpoint — Cancel (`POST /api/queue/:id/cancel`)

Aborts a job that is `queued` or `processing`. Returns 200 on success, 404 if the job doesn't exist, 409 if the job is already terminal (`completed` or `failed`).

**Server-side:**
1. Find the job by `_id`. Return 409 if `status` is already `completed` or `failed`.
2. Update: `status = "failed"`, `error = "Cancelled by user"`, `completed_at = now`.
3. Signal the worker's in-flight task registry to abort the task for this job id (see § 15 below).
4. Return the updated job document.

**Why `failed` and not a separate `cancelled` status:** a cancelled job is a terminal failure from the queue's perspective — it will not be retried, it holds no valid response, and it should appear in the Failed tab. Adding a fifth status value complicates every filter, badge, and tab without adding user-visible benefit beyond the error message string.

**Deliverables:**

- **10.a** Returns 200 on a successful cancel.
- **10.b** Returns 404 if the job id does not exist.
- **10.c** Returns 409 if the job is already terminal (`completed` or `failed`).
- **10.d** Sets `status = "failed"`, `error = "Cancelled by user"`, `completed_at = now` on cancel.
- **10.e** Invokes the worker's in-flight registry to abort the live task for this job id.
- **10.f** Returns the updated job document in the 200 response body.

## 11. API Endpoint — Enqueue (`POST /api/<entity>/{id}/queue-generate`)

This lives on the entity router (not the queue router) because it needs entity-specific context. It is the **single place** where prompt rendering and input snapshotting happen.

1. Fetch entity by id (404 if not found).
2. Load the current prompt template via `await loadPrompt(slug)` (never `fs.readFileSync` of `prompts/*.md` directly).
3. **Snapshot the prompt** — copy `{ slug, body, updated_at }` onto the job.
4. **Render** the template with current entity fields → `rendered_prompt`.
5. **Snapshot inputs** — resolve any padded/derived paths now (not at worker time).
6. Insert job with `status="queued"`, `attempt=0`, `queued_at=now`, `handler="<type>"`, `entity_id`, `entity_title`, and any `context` the `onJobComplete` callback will need.
7. Return the inserted job document immediately with HTTP 202.

Do not wait for the worker. The user sees the new "queued" row within one poll cycle.

**Deliverables:**

- **11.a** The endpoint returns HTTP 202 on success.
- **11.b** Fetches the entity by id and returns 404 if not found.
- **11.c** Loads the template via `loadPrompt(slug)` (no direct `fs.readFileSync` of `prompts/*.md`).
- **11.d** Snapshots `{ slug, body, updated_at }` onto the job's `prompt` field at enqueue.
- **11.e** Renders the template against current entity fields and stores the result in `rendered_prompt`.
- **11.f** Snapshots handler-specific inputs (e.g. storage keys, reference paths) into `job.inputs` at enqueue.
- **11.g** Inserts the job with `status="queued"`, `attempt=0`, `queued_at=now`, `handler`, `entity_id`, `entity_title`, and `context`.
- **11.h** Returns the inserted job document in the 202 response body.

## 12. Background Worker — Constants

Reference: `influencer-studio/twp.react/api/services/prompt_queue_worker.py`.

- `CONCURRENCY` — max concurrent jobs in flight. Default 3. Drop to 1 for tight rate limits (e.g. Gemini free tier).
- `MAX_ATTEMPTS = 3` — retry limit for transient failures
- `POLL_INTERVAL = 5` (seconds) — how often the worker scans for new queued jobs
- `TIMEOUT_MS` — per-job execution deadline. Use the LLM client's built-in timeout when one is configurable (e.g. `openai.timeout`, Anthropic `timeout`, Gemini `timeout`). Fall back to `10 * 60 * 1000` (10 minutes) when the client provides no timeout knob. Timeouts are permanent failures — do not retry.

**Deliverables:**

- **12.a** Worker defines a `CONCURRENCY` constant (default 3, or 1 for tight rate limits).
- **12.b** Worker defines `MAX_ATTEMPTS = 3`.
- **12.c** Worker defines `POLL_INTERVAL = 5` seconds (or an equivalent millisecond constant).
- **12.d** Worker defines `TIMEOUT_MS` (default `10 * 60 * 1000`).

## 13. Background Worker — Loop

The worker's main loop:

1. Sleep `POLL_INTERVAL` seconds.
2. **Reaper sweep** — before claiming new work, scan for any job with `status="processing"` and `started_at < now - TIMEOUT_MS`. For each, mark `status="failed"`, `error="Timed out after 10m"`, `completed_at=now`, and remove from the in-flight registry. This handles jobs orphaned by a crashed worker process.
3. Compute `available = CONCURRENCY - in_flight`. If 0, continue.
4. Atomically claim up to `available` jobs in `status="queued"` ordered by `queued_at` ascending. Set `status="processing"`, `started_at=now`, `attempt += 1`.
5. For each claimed job, spawn a task that dispatches to the registered handler and updates the job on completion. Wrap the handler call in the `TIMEOUT_MS` deadline (see § 16 below).

**Deliverables:**

- **13.a** Worker sleeps `POLL_INTERVAL` seconds between cycles (or runs on a `setInterval` at that cadence).
- **13.b** Worker runs the reaper sweep (§ 14) before claiming new work on every cycle.
- **13.c** Worker computes `available = CONCURRENCY - in_flight` before claiming.
- **13.d** Worker atomically claims up to `available` queued jobs, ordered by `queued_at` ascending.
- **13.e** On claim, the worker sets `status="processing"`, `started_at=now`, and increments `attempt` by 1.
- **13.f** Worker dispatches each claimed job to the handler registered for `job.handler`.
- **13.g** Worker wraps each handler invocation in the `TIMEOUT_MS` deadline (via `Promise.race` / `asyncio.wait_for` / equivalent).

## 14. Reaper Sweep

Without the reaper, a worker that claims a job and then crashes leaves that job in `processing` forever.

**Deliverables:**

- **14.a** A reaper function scans for `status="processing"` AND `started_at < now - TIMEOUT_MS`.
- **14.b** For each stuck job, the reaper sets `status="failed"`, `error="Timed out after 10m"` (or the actual limit), `completed_at=now`.
- **14.c** The reaper removes the job's entry from the in-flight registry.

## 15. In-flight Task Registry

The worker maintains a map of job id → live task so the cancel endpoint can abort work in progress:

```ts
// Node / TypeScript
const inFlight = new Map<string, AbortController>();

// When claiming a job:
const controller = new AbortController();
inFlight.set(job._id.toString(), controller);

// Pass signal to handler:
const response = await Promise.race([
  handler(job, controller.signal),
  timeout(TIMEOUT_MS, job._id.toString()),
]);
inFlight.delete(job._id.toString());

// timeout() helper:
function timeout(ms: number, jobId: string): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timed out after ${Math.round(ms / 60000)}m`)), ms)
  );
}
```

```python
# FastAPI / asyncio
in_flight: dict[str, asyncio.Task] = {}

# When claiming a job:
task = asyncio.create_task(run_handler(job))
in_flight[str(job["_id"])] = task

try:
    response = await asyncio.wait_for(task, timeout=TIMEOUT_SECONDS)
finally:
    in_flight.pop(str(job["_id"]), None)
```

The cancel endpoint calls:
```ts
// Node
inFlight.get(jobId)?.abort();       // signals AbortController; handler must respect signal

// Python
in_flight.get(jobId)?.cancel()      # asyncio.Task.cancel(); wait_for raises CancelledError
```

**Deliverables:**

- **15.a** A module-level in-flight registry exists (`Map<string, AbortController>` in Node; `dict[str, asyncio.Task]` in Python).
- **15.b** An entry is added when a job is claimed.
- **15.c** The entry is removed on natural completion, timeout, or cancel.
- **15.d** The cancel endpoint (10.e) calls into this registry via `abort()` / `.cancel()` to terminate the live task.
- **15.e** Handlers propagate the abort signal to the underlying model client call (e.g. `AbortSignal` passed to `fetch`, or `asyncio` task cancellation).

## 16. Timeout

- The `TIMEOUT_MS` deadline applies to the **entire handler execution**, including any retries the model client makes internally.
- Prefer configuring the timeout on the model client itself (so the client cleans up its own TCP connections cleanly) and also race with `Promise.race` / `asyncio.wait_for` as a belt-and-suspenders guard.
- A timeout failure is **permanent** — `attempt` is not incremented, no retry backoff. Set `status="failed"`, `error="Timed out after 10m"` (or the actual limit if non-default), `completed_at=now`.
- The reaper sweep (§ 14) acts as a second line of defence for jobs whose worker process crashed before the in-process timeout could fire.

**Deliverables:**

- **16.a** The `TIMEOUT_MS` deadline is enforced around the entire handler execution (not just one internal call).
- **16.b** A timeout is a permanent failure: `attempt` is NOT incremented further, and the job is NOT re-queued.
- **16.c** On timeout, the worker sets `status="failed"`, `error="Timed out after 10m"` (or the actual limit), `completed_at=now`.
- **16.d** The error message names the actual configured limit in minutes (e.g. `"Timed out after 10m"`, or `"Timed out after 5m"` if `TIMEOUT_MS` is set to 5 minutes).

## 17. Pluggable Handlers

The worker knows nothing about Gemini, image models, or how to write results back to entities. It dispatches on `job.handler`:

```ts
const handlers = {
  "gemini":    handleGeminiJob,
  "image-gen": handleImageGenJob,
};

// Each handler has two halves: a composer (enqueue-time, pure) and an
// execute function (run-time). Both are registered.
registerComposer("gemini", composeGeminiRequest);
registerHandler("gemini", handleGeminiJob);

// Composer: rendered template text → provider SDK call payload.
function composeGeminiRequest(rendered, inputs) {
  if (typeof inputs.model !== "string") {
    throw new Error("gemini composer requires inputs.model");
  }
  const turns = parsePromptTurns(rendered);
  return {
    model: inputs.model,
    systemInstruction: collectTurn(turns, "system"),
    contents: joinTurns(collectTurn(turns, "history"),
                        collectTurn(turns, "user")),
    config: {
      maxOutputTokens: inputs.max_tokens ?? 2000,
      ...(typeof inputs.temperature === "number"
          && { temperature: inputs.temperature }),
    },
  };
}

// Execute: resolve caching indirection, persist the final request, fire.
async function handleGeminiJob(job, signal) {
  if (!job.request) throw new Error("no composed request");

  // Optionally swap inline systemInstruction for a cached reference.
  const { request, request_cache } = await resolveCaching(
    job.request,
    job.inputs,
  );

  // Persist BEFORE the SDK call — on failure, the attempted payload is
  // still visible to the debugger.
  await setJobRequest(job._id, request, request_cache);

  const res = await ai.models.generateContent({
    model: request.model,
    contents: request.contents,
    config: {
      ...(request.cachedContent
         ? { cachedContent: request.cachedContent }
         : { systemInstruction: request.systemInstruction }),
      ...request.config,
      abortSignal: signal,
    },
  });

  const promptTokens = res.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = res.usageMetadata?.candidatesTokenCount ?? 0;
  return {
    text: res.text ?? "",
    // NOTE: no `model` here — model is an input, already on job.inputs.model.
    finish_reason: res.candidates?.[0]?.finishReason ?? null,
    usage: {
      prompt_tokens: promptTokens,
      output_tokens: outputTokens,
      total_tokens: res.usageMetadata?.totalTokenCount ?? promptTokens + outputTokens,
      estimated_cost_usd: estimateCostUsd(request.model, promptTokens, outputTokens),
      pricing_per_mtok: PRICING[request.model] ?? null,
    },
  };
}
```

Keep handlers **pure**: prompt in, response out. No entity writes, no side effects on other collections. The worker assigns the returned object to `job.response` and sets `status="completed"`.

Every LLM handler also maintains a module-level `PRICING` map keyed by model name with `{ input, output }` USD per 1M tokens. The per-run cost is computed from the actual returned `usage` counts and written onto `response.usage.estimated_cost_usd`. Unknown models produce `null`, not a fabricated number. Keeping the pricing table alongside the handler (not in a separate project-wide config) means whoever tunes the handler also tunes the pricing.

**Deliverables:**

- **17.a** The worker dispatches to handlers through a registry keyed by `job.handler` (a map, a `register(name, fn)` function, or equivalent).
- **17.b** Each handler is an `async (job, signal?) => response` function.
- **17.c** Handlers are pure with respect to side effects outside returning the response and mutating `job.request` / `job.request_cache` via `setJobRequest`. No entity writes, no writes to other collections, no filesystem writes.
- **17.d** The worker assigns the handler's returned object to `job.response`.
- **17.e** The worker sets `status="completed"` when a handler returns successfully.
- **17.f** Each LLM handler registers a **composer** via `registerComposer(handlerName, fn)` in the same bootstrap call that registers the handler. The composer turns the rendered template text into the provider SDK call payload that becomes `job.request` at enqueue time (see § 5.2).
- **17.g** LLM composers/handlers require `inputs.model` and throw when it's missing. They do NOT default it silently — every stored job has an explicit model on the input side.
- **17.h** LLM composers derive per-turn content from `parsePromptTurns(rendered)`. They never read per-turn text from `inputs`.
- **17.i** Before firing the provider SDK call, LLM handlers call `setJobRequest(job._id, request, request_cache)` to persist the exact payload they're about to send. A failed SDK call therefore still leaves a truthful record on the job document.
- **17.j** The object passed to the provider SDK is constructed from fields on `job.request` (model, systemInstruction or cachedContent, contents, config). Handlers do NOT add hidden config that isn't represented in `job.request` — if it's on the wire, it's on the record.
- **17.k** Every LLM handler's returned response object includes `finish_reason` and a `usage` sub-object containing `prompt_tokens`, `output_tokens`, and `total_tokens`. It does NOT include `model` (the model lives in `inputs.model`).
- **17.l** Every LLM handler's response includes `usage.estimated_cost_usd` computed from a module-level `PRICING` map of `{ input, output }` USD-per-1M-tokens keyed by model name. Unknown models yield `null` (not a guess); a sibling `usage.pricing_per_mtok` records the rates used for the computation so the number is auditable after the fact.

## 18. `onJobComplete` Callbacks

After the worker marks a job `completed`, it calls an optional per-handler callback that writes results back to the source entity. This is where entity-specific knowledge lives.

```ts
const onComplete = {
  "gemini":    onReviewDraftComplete,
  "image-gen": onSceneImagesComplete,
};

function onReviewDraftComplete(job) {
  if (job.status !== "completed" || !job.response?.text) return;
  const { asin } = job.context;
  // parse title, upsert { review_draft, review_title, draft_quality } to item by asin
}
```

Splitting the handler (pure execution) from the callback (entity writeback) keeps each piece testable: the handler can be run against a recorded job doc in isolation, and the callback can be re-run against a completed job doc to re-apply results without re-calling the model.

**Deliverables:**

- **18.a** An `onJobComplete(key, cb)` registration exists (keyed by handler name or prompt slug).
- **18.b** The worker fires the registered callback only after the job reaches `status="completed"`.
- **18.c** Entity writeback from prompt results lives exclusively in `onJobComplete` callbacks, not inside handlers.
- **18.d** A stored completed job document is sufficient input to re-run the callback without re-calling the model (i.e. the callback reads `job.response` and `job.context`, not live entity state).

## 19. Transient vs Permanent Errors

```python
TRANSIENT_PATTERNS = [
    "resource exhausted", "quota", "overloaded", "rate limit",
    "try again", "too many requests", "503", "429",
    "service unavailable", "temporarily unavailable", "internal error",
]

def is_transient(msg: str) -> bool:
    m = msg.lower()
    return any(p in m for p in TRANSIENT_PATTERNS)
```

- **Transient + `attempt < MAX_ATTEMPTS`:** back off `30 * attempt` seconds, set `status="queued"`, `started_at=null`. Worker re-claims on a future poll.
- **Permanent OR `attempt >= MAX_ATTEMPTS`:** `status="failed"`, `error` set, `completed_at=now`. Stops here.

Quota and rate-limit errors retry; a malformed prompt should not loop forever burning credits.

**Deliverables:**

- **19.a** A transient-pattern classifier exists and matches (case-insensitive): `resource exhausted`, `quota`, `overloaded`, `rate limit`, `try again`, `too many requests`, `503`, `429`, `service unavailable`, `temporarily unavailable`, `internal error`.
- **19.b** On transient failure with `attempt < MAX_ATTEMPTS`, the worker backs off `30 * attempt` seconds, sets `status="queued"`, sets `started_at=null`, and leaves the job for re-claim.
- **19.c** On permanent failure OR `attempt >= MAX_ATTEMPTS`, the worker sets `status="failed"`, sets `error`, and sets `completed_at=now`.

## 20. Surface 1 — Prompt Manager

A single-page `<Card>` for template CRUD. Skip this surface entirely if the project authors prompts only inline (one-off, no shared template directory).

**Layout (two columns inside one card):**

*Left — Editor:*
- Multiline textarea showing the body of the selected prompt.
- On page load, default to the prompt with the most recent `updated_at` (file mtime).

*Right — Controls:*
- **Prompt selector** — native `<select>` listing all slugs. Selecting loads that prompt.
- **"New Prompt" button** — inline slug text input → `POST /api/prompts`.
- **"Last saved …" caption** — small muted line below the prompt selector showing `Last saved <localtime> — history lives in git.` Replaces the old version dropdown. Historical browsing happens through `git log`/git GUI (see § 4).
- **Save button** — `ActionButton` with `C.success` background when editor content differs from the saved body (dirty detection). Calls `PUT /api/prompts/:slug`.
- **Delete button** — `ActionButton variant="danger"`. Calls `DELETE /api/prompts/:slug` after confirmation.

The Prompt Manager does **not** enqueue jobs. Enqueuing happens from per-entity pages where the template is applied to real data. The Prompt Manager is purely for authoring templates.

**Deliverables:**

- **20.a** The Prompt Manager card uses a two-column layout (left = editor, right = controls) on wide viewports; both columns live inside one `<Card>`.
- **20.b** Left column renders a multiline textarea bound to the selected prompt's body.
- **20.c** On initial page load, the prompt with the most recent `updated_at` (file mtime) is selected by default.
- **20.d** Right column contains a native `<select>` Prompt selector listing every slug.
- **20.e** The card **header** (top-right) contains a "+ New Prompt" button. The button does NOT expose a slug input in the default state — clicking it reveals an inline input + "Create" + "Cancel" triplet next to the button, focuses the input, and submits via Enter or the "Create" button. `Escape` cancels and restores the button. The card body contains no "new prompt slug" form row.
- **20.f** Right column shows a small muted caption below the prompt selector reading `Last saved <localtime> — history lives in git.` There is no version dropdown, no historical-version selector, no "load older version" affordance inside the editor. Browsing history is `git log` (or any git GUI) on `web/prompts/<slug>.md`.
- **20.g** Right column contains a Save button (`ActionButton`) whose background flips to `C.success` when the editor content diverges from the saved body; clicking calls `PUT /api/prompts/:slug`.
- **20.h** Right column contains a Delete button (`ActionButton variant="danger"`) that calls `DELETE /api/prompts/:slug` after a confirmation.
- **20.i** The Prompt Manager card contains no Generate/Enqueue/"Run" button. Enqueuing happens only on per-entity pages.
- **20.j** The editor body textarea wires through the `draft-persistence` library (see its SKILL.md). Every keystroke calls `saveDraft(draft:prompt-editor:body:<slug>, value)`; on `selectPrompt(slug)` the initial value is `loadDraft(key) ?? serverBody`; on a successful save (2xx) the handler calls `clearDraft(key)`; on a successful delete (2xx) it likewise clears the draft. After `loadPrompts()` the handler calls `sweepDrafts("draft:prompt-editor:body:", aliveSlugs)` to GC drafts for deleted prompts. Rationale: prompt template edits are the most expensive content to lose in this surface — a single system-instruction block is often thousands of tokens of deliberate wording, and deploys / dev-server restarts / idle-kill watchdogs must never destroy them.
- **20.k** The inline "+ New Prompt" slug input wires through `draft-persistence` with the singleton key `draft:prompt-editor:new-slug`. Restored on mount (and if the draft is non-empty, the inline form is auto-opened so the user sees their in-progress slug). Cleared on successful `POST /api/prompts` (2xx) or on explicit Cancel.
- **20.l** ❌ — superseded by 20.f. The version dropdown was removed when prompts moved to flat files (see § 4). Reverting to an older revision happens through git, not through the editor; there is no "load older version into the editor as a draft" path to wire through `draft-persistence`.

## 21. Surface 2 — Per-Entity Detail Page (Editor + History)

Reference: `influencer-studio/twp.react/app/app/influencer/scenes/[id].jsx`.

> **Conditional surface.** This section applies only if the project has per-entity screens where a user iterates on a single prompt with a visible job history (e.g. a scene editor, a review-draft editor). If the project has no such screens, mark every 21.x as `❌ — no per-entity prompt-iteration screens in this project` in the Compliance Audit with a one-sentence explanation of why (e.g. "document extraction is one-shot; no iteration UI exists"). Do not silently omit.

**Layout (top to bottom):**

1. **Form / Editor card** — input fields that compose the prompt for *this* entity. Editing is local; saved on explicit Save action. Track a `dirty` flag.
2. **Generation History card** — list of `JobCard` components filtered to this entity (`entity_id = id`). Hidden when the list is empty. Hidden entirely on the create-new screen (no entity id yet).

**Data loading:**
```jsx
const [jobs, setJobs] = useState([]);
const pollRef = useRef(null);

const loadJobs = async () => {
  const result = await getQueue({ entity_id: id, status: "all", page: 1, limit: 100 });
  setJobs(result.jobs);
};
```

**Polling — tied to active state, not always-on:**
```jsx
useEffect(() => {
  const hasActive = jobs.some(j => j.status === "queued" || j.status === "processing");
  if (hasActive) pollRef.current = setInterval(loadJobs, 5000);
  return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
}, [jobs]);
```

When all visible jobs are terminal, polling stops. It resumes when a new job is enqueued.

**Enqueue action:** the Generate button calls `POST /api/<entity>/{id}/queue-generate`, then immediately calls `loadJobs()` to show the new "queued" row. Instant feedback before the worker picks anything up.

**Deliverables:**

- **21.a** A per-entity page renders a Form / Editor card at the top whose fields compose the prompt inputs for *this* entity, with a `dirty` flag and an explicit Save action.
- **21.b** A Generation History card renders below the editor, containing a list of `JobCard` components filtered by `entity_id`.
- **21.c** The Generation History card is hidden when its list is empty.
- **21.d** The Generation History card is hidden entirely on the create-new screen (no entity id yet).
- **21.e** The per-entity page polls the queue every 5 seconds only when at least one visible job is `queued` or `processing`.
- **21.f** Polling stops once every visible job is terminal (neither `queued` nor `processing`).
- **21.g** The Generate button calls `POST /api/<entity>/{id}/queue-generate` and then immediately calls `loadJobs()` (or equivalent refresh) to show the new `queued` row without waiting for a poll cycle.

## 22. Surface 3 — Universal Queue Page (`/platform/prompts`)

Reference: `influencer-studio/twp.react/app/app/universe/queue.jsx`. In Expo Router projects this lives at `app/(app)/platform/prompts/index.tsx` with sidebar label **"Prompts"** — see § 1 above.

This page is for **editing prompt templates and watching jobs**, not for triggering them. One-off enqueue actions (like "Compile KB" or "Re-run review draft") belong on the entity-specific page they relate to — the page where the user already has context about *what* they're triggering and *why*. Putting a global "Compile KB" button on the queue page forces a context switch every time. The queue page shows that the click happened; the click itself happens elsewhere.

**Layout:**
- Header: "Prompt Queue" (or just integrated under the page's `AdminNavbar title="Prompts"`)
- Tab row: All / Active / Completed / Failed — each shows a count badge from `/api/queue/counts`
- Job list: paginated `FlatList` of `JobCard` rows (page size 20)
- Pagination footer: Previous / "Page X of Y" / Next, only shown when `pages > 1`
- Empty state: distinguish "no jobs yet" (with guidance about where jobs are created) from tab-specific "no active/completed/failed jobs"

**Tabs:**
```jsx
const TABS = [
  { key: "all",       label: "All"       },
  { key: "active",    label: "Active"    },
  { key: "completed", label: "Completed" },
  { key: "failed",    label: "Failed"    },
];
```

Switching tabs resets `page` to 1.

**Counts come from a separate endpoint** so the badges stay accurate regardless of which page is currently rendered. Call both endpoints in parallel on every load.

**Polling — same rule as Surface 2:** poll every 5s only when `counts.active > 0`. Stop when there's nothing in flight.

```jsx
useEffect(() => {
  if ((counts.active || 0) > 0) {
    pollRef.current = setInterval(() => load(activeTab, page), 5000);
  }
  return () => { if (pollRef.current) clearInterval(pollRef.current); };
}, [counts.active, activeTab, page]);
```

**Deliverables:**

- **22.a** Universal queue page lives at `app/(app)/platform/prompts/index.tsx`.
- **22.b** Page header renders the string "Prompt Queue" (or an `AdminNavbar` with `title="Prompts"`).
- **22.c** Tab row renders four tabs in this order: `all` → "All", `active` → "Active", `completed` → "Completed", `failed` → "Failed".
- **22.d** Each tab displays a count badge sourced from `/api/queue/counts`.
- **22.e** Switching tabs resets the page index to 1.
- **22.f** Job list is paginated with page size 20.
- **22.g** Pagination footer "Previous / Page X of Y / Next" is shown only when `pages > 1`.
- **22.h** Empty state copy for the `all` tab differs from the per-tab empties (distinguishes "no jobs yet" — with guidance about where jobs are enqueued — from "no completed jobs" / "no failed jobs" / "no active jobs").
- **22.i** On every load, the page calls `/api/queue` and `/api/queue/counts` in parallel.
- **22.j** The page polls both endpoints every 5 seconds only while `counts.active > 0`.
- **22.k** The page stops polling as soon as `counts.active === 0`.
- **22.l** The page contains no one-off enqueue buttons (no "Compile KB", no "Regenerate", no "Generate").

## 23. Shared `JobCard` Component

Reference implementation: `goliathdynamics.com/web/src/components/admin/JobCard.tsx`.

One row = one job. The same component is used on every surface, controlled by props.

**Props:**
- `job` — the job document
- `showEntityLink` — accepted for API stability but ignored in the current design; the header shows only the prompt slug and id. Retain the prop on the type so older call sites keep compiling, but do not render it.
- `onCancel(jobId)` — called after a successful `POST /api/queue/:id/cancel`; the parent reloads the job list

**Layout — one card with three zones (no internal borders between them):**

1. **Header (single row, no divider line beneath it):**
   - Left, in order: `job._id.toString()` in a muted monospace font, a `·` separator, `job.prompt.slug` in semibold. When `job.attempt > 1`, a small "attempt N" chip follows inline in the same group.
   - Right, in order: status badge, then the `⋮` context-menu trigger as the farthest-right element.

2. **Error band (conditional):** thin red-tinted box shown only when `status === "failed"`, between the header and the body. Shows `job.error` verbatim.

3. **Body — two columns on ≥768px, stacked on narrow:**
   - **Left column** leads with a small muted line `queued: <localtime>`. Below the timestamp, `job.request` (and optionally `job.request_cache`) is rendered as a **split view**: a compact monospace JSON block for the scalar and structural fields (`model`, `config`, `cachedContent`, `name`, `ttl_seconds`), followed by one dedicated **prose bubble per long-form field** (`systemInstruction`, `contents`, `system`, `messages`, `prompt`, `user_message`, plus any other string value ≥ 200 characters). Each prose bubble has a small uppercase label above it (the field name as it appears on the object) and a proportional-font body rendered with `whitespace-pre-wrap` — the correct shape for reading prose, rather than a JSON-escaped string with `\n` artifacts. When `job.request_cache` is non-null, its split is rendered above the request split under a `cache` label so the reader can distinguish cache-pinned content from the call that referenced it. The `queued:` timestamp above the whole column already implies the request block's meaning, so the request split has no top-level label of its own. When both `request` and `request_cache` are null, render the placeholder `request not yet composed`. **There is no separate "inputs" JSON panel** — `job.request` already carries `model` + `config` + content, so a dedicated inputs panel would duplicate what's in the request block. Anything on `job.inputs` that isn't forwarded to `request` (e.g. `cache_ttl_seconds`) is visible via the presence/absence of `request_cache`, or via raw Mongo for forensic reads.
   - **Right column** leads with `completed: <localtime> · <elapsed>`, then a distinct-background sub-panel rendering `job.response` *minus the `text` field* as pretty-printed JSON (finish_reason, usage with token counts and estimated cost), then `job.response.text` as preformatted text. The output-meta panel stays because it carries data that does NOT duplicate the response text — finish_reason, token usage, cost — all of which are cheaper to scan as structured JSON than to pull out of prose.
   - While the job is in flight the right column's timestamp reads `running…` and both the output-meta panel and the response body are placeholders.
   - All JSON blocks share identical styling — same distinct background, same monospace font, same 2-space indent, same clamp rules. The only visual cue distinguishing the `cache` block from the `request` block is the small label above each.
   - Elapsed is computed as `completed_at − queued_at` and formatted as `Xms`, `Xs`, `Xm`, or `Xm Ys` depending on magnitude.
   - **No `PROMPT` / `RESPONSE` column headers** — the per-column timestamp row is the semantic cue. The inline `cache` / `request` labels on the left column distinguish the two JSON blocks within that column.

**Collapsed vs expanded:**

- **Collapsed:** each column's body is clamped to 3 visual lines via `line-clamp-3` (or equivalent). The entire card wrapper is clickable — clicking anywhere on a collapsed card expands it. A `cursor-pointer` + border-color hover makes the affordance visible. **There is no "Show more" button.**
- **Expanded (asymmetric — intentional):**
  - The **left column's `request` JSON block** caps at `max-h-[65vh]` with internal `overflow-auto`. System instructions, knowledge bases, and long chat histories routinely run thousands of lines; uncapping the prompt side would produce a card that stretches 10+ screens and hides the response below the fold.
  - The **right column's response text** is **uncapped** and flows to its natural height. The response is what the reader expanded the card to read — forcing it into a separate 65vh scroll box alongside an already-scrolling prompt is bad UX. When the response is taller than the prompt's 65vh cap, the grid row grows and the card extends naturally down the page. Page-scroll, not in-card-scroll, is the right affordance for long responses.
  - The grid's default `align-items: stretch` makes the two columns equal-height, so if the response outgrows the prompt's scroll box, the left column simply has trailing empty space below its scroll box — accepted, and preferable to nesting scrollbars.
- **No `onClick` is bound to the wrapper or to either column container while the card is expanded** — this is the text-selection rule (AP20). **There is no floating ✓ tick button.** Collapse happens only via the `⋮` menu's "Collapse" item.

**Status badge colors (literal hex codes — rule 3 of `_index.md` applies; these strings must appear in the diff):**

| Status | Color |
|---|---|
| queued | slate (`#94a3b8`) |
| processing | sky/blue (`#0ea5e9`) + spinner icon |
| completed | green (`#10b981`) |
| failed | red (`#ef4444`) |

The spinner on `processing` gives immediate visual confirmation something is actively running, without needing to read timestamps.

**Context menu (`⋮` button):**

Rendered always. Implemented as a viewport-fixed dropdown — `position: fixed` with coordinates captured via `getBoundingClientRect()` at open time. **Never** `position: absolute` inside an overflow container; that reintroduces the z-index/clipping failure documented in MEMORY.

| Item | Behavior |
|---|---|
| Cancel | `POST /api/queue/:id/cancel` → on 200 call `onCancel(job._id)`. On 409 (already terminal), refresh the card silently. Always rendered but disabled when status is not `queued` or `processing`. |
| Collapse | collapses the expanded card. Always rendered but disabled when the card is not expanded. |

The menu dismisses on any of: (a) click outside (full-screen transparent overlay at `z-9998`); (b) window `scroll` with a capture-phase listener, so nested scroll containers also trigger close; (c) window `resize`. Closing on scroll prevents the menu from drifting away from its trigger button — with `position: fixed` coordinates captured at open time, the trigger moves but the menu wouldn't, so we close instead of repositioning.

The "Cancel" label is plain text with a red (`C.danger`) color. No confirmation dialog — the user sees the result immediately as the card flips to `failed` status on the next poll or on the optimistic refresh from `onCancel`.

Implement cancel optimistically: flip the local job to `{ status: "failed", error: "Cancelled by user", completed_at: new Date().toISOString() }` before the API call resolves so the UI responds instantly. If the API returns anything other than 2xx or 409, revert to the original state.

**Deliverables:**

- **23.a** JobCard declares props `job` and `onCancel`, and accepts `showEntityLink` for API stability (may be ignored; the current design does not render an entity link in the header).
- **23.b** Header is a single row. Left side, in order: `job._id.toString()` in muted monospace, a `·` separator, then `job.prompt.slug` in semibold.
- **23.c** Header right side, in order: status badge, then a `⋮` context-menu trigger as the farthest-right element.
- **23.d** When `job.attempt > 1`, an "attempt N" chip renders inline in the header's left group (not on a separate row below).
- **23.e** There is NO visible divider/border between the header and the body; the card flows from header directly into the body with no horizontal rule.
- **23.f** An error message in a red-tinted box renders between the header and the body only when `job.status === "failed"`.
- **23.g** Body is two columns 50/50 on ≥ 768px viewports and stacked vertically on narrow viewports.
- **23.h** The left column body leads with `queued: <localtime>` on a small muted line above the prompt text.
- **23.i** The right column body leads with `completed: <localtime> · <elapsed>` on a small muted line above the response text, or `running…` while the job is in flight.
- **23.j** Elapsed is computed as `completed_at − queued_at` and formatted as `Xms` (<1s), `Xs` (<60s), `Xm` (whole minutes), or `Xm Ys`.
- **23.k** The left column renders `job.request` as a **split view**: (a) a compact monospace JSON block of the scalar/structural fields (`model`, `config`, `cachedContent`, etc.), followed by (b) one prose bubble per long-form field. Each prose bubble has a small uppercase label above it (the raw field name from the object) and a proportional-font body. When `job.request_cache` is non-null, its split is rendered **above** the request split, under a `cache` label. The request split itself has no top-level label — the `queued: <timestamp>` row above the column already implies it. The flat-string `rendered_prompt` form is NOT rendered — it does not exist on the job.
- **23.l** The right column renders `job.response.text` as preformatted, line-preserving text.
- **23.m** Neither the word "PROMPT" nor "RESPONSE" is rendered as a column header anywhere on the card — the per-column timestamp row is the only semantic cue. The left column has a `cache` label only when `request_cache` is non-null (to distinguish the cache block from the request block below it); the request block itself has no label, because the `queued:` timestamp above it already implies its meaning.
- **23.n** When collapsed, each column's body is clamped to 3 visual lines (`line-clamp-3` or equivalent).
- **23.o** When expanded, the **left column's `request` JSON block** is scrollable with `max-h: 65vh` (persisted to protect against multi-thousand-line system instructions). The **right column's response text is UNCAPPED** — it flows to its natural height, and the grid row grows with it. This asymmetry is intentional (see AP29): the response is what the reader came to read, so it must not be nested inside a scroll box while another scroll box competes next to it.
- **23.p** The collapsed card wrapper is clickable; clicking anywhere on it expands the card. A `cursor-pointer` + hover affordance is visible on the wrapper while collapsed.
- **23.q** When expanded, the card wrapper has no `onClick` handler; neither do the left or right column containers. Text inside remains freely selectable.
- **23.r** No "Show more" button (or equivalent dedicated expand button) is rendered on a collapsed card — click-anywhere on the wrapper is the only expand interaction.
- **23.s** No floating `✓` tick button (or equivalent dedicated collapse button) is rendered on an expanded card — the ⋮ menu's "Collapse" item is the only collapse interaction.
- **23.t** Status badge for `queued` uses the literal hex `#94a3b8` somewhere in the component.
- **23.u** Status badge for `processing` uses the literal hex `#0ea5e9` somewhere in the component AND shows an animated spinner icon.
- **23.v** Status badge for `completed` uses the literal hex `#10b981` somewhere in the component.
- **23.w** Status badge for `failed` uses the literal hex `#ef4444` somewhere in the component.
- **23.x** The `⋮` context menu button is always rendered (including when every menu item would be disabled).
- **23.y** The ⋮ menu's Cancel item is always rendered, and is `disabled` when `job.status` is not `queued` or `processing`.
- **23.z** The ⋮ menu's Collapse item is always rendered, and is `disabled` when the card is not expanded.
- **23.aa** The ⋮ menu is positioned with `position: fixed` and `getBoundingClientRect()` captured at open time — never `position: absolute` inside an overflow container.
- **23.bb** The ⋮ menu dismisses on click-outside (a document-level listener or equivalent).
- **23.cc** The ⋮ menu closes on window `scroll` (capture phase so nested scroll containers also close it) and on window `resize`, so it never drifts away from its trigger button.
- **23.dd** The Cancel label is styled red (`C.danger`).
- **23.ee** Cancel has no confirmation dialog.
- **23.ff** Cancel is optimistic: the JobCard flips the local job to `{status: "failed", error: "Cancelled by user", completed_at: new Date().toISOString()}` before the cancel API call resolves, not after.
- **23.gg** On a response from the cancel call that is neither 2xx nor 409, the JobCard reverts to the job's original state. On 409 it keeps the optimistic state and the parent's poll reconciles silently.
- **23.hh** The left column renders NO separate "inputs" JSON sub-panel. Model, temperature, and max-tokens already appear inside `job.request` (under `model` and `config`); a dedicated inputs box would duplicate that content. Handler-consumed knobs that don't forward into `request` (e.g. `cache_ttl_seconds`) are visible via the presence/absence of `request_cache`; beyond that, the raw Mongo doc is the source of truth.
- **23.ii** The right column renders `job.response` *with the `text` field omitted* as a pretty-printed JSON sub-panel above the response text (2-space indent, monospace) when any remaining keys exist. It stays as a separate panel because its content (finish_reason, usage, cost) does not duplicate the response text prose.
- **23.jj** The output-params JSON on the right column surfaces `finish_reason`, `usage.prompt_tokens`, `usage.output_tokens`, `usage.total_tokens`, and `usage.estimated_cost_usd` — all sourced directly from the stored `job.response` object, with no client-side recomputation. `model` does NOT appear on this side; it lives inside `job.request.model` on the left column.
- **23.kk** The output-params sub-panel clamps to a short height when the card is collapsed (roughly the first 3 JSON lines, truncated cleanly with `overflow-hidden`) and grows to `max-h: 10rem`-ish with `overflow: auto` when the card is expanded.
- **23.ll** The content of the left column's split is derived from `job.request_cache` and `job.request` directly. A field is classified as "prose" (gets its own bubble) if its name is in the known-content whitelist (`systemInstruction`, `contents`, `system`, `messages`, `prompt`, `user_message`) OR if its string value is 200+ characters long. All other top-level fields lump into the compact JSON block. No client-side transformation beyond pretty-printing and field classification; no field hiding; no sorting.
- **23.mm** The `cache` block (when present) appears ABOVE the `request` block in the left column. Order is fixed; it is not user-reorderable. Reason: the reader's cognitive flow is "here's what's pinned in the cache → here's the call that referenced it."
- **23.nn** When both `job.request` and `job.request_cache` are null (legacy jobs predating the current schema, or a failed enqueue), the left column body renders a muted italic placeholder reading `request not yet composed` — NOT an empty block and NOT a reconstruction from any other field.
- **23.pp** Prose bubbles render with a **proportional font** and `whitespace-pre-wrap` — the correct shape for reading long-form prose. The compact JSON block keeps **monospace** because it shows code-like scalar/structural data. Mixing the two (putting prose inside the JSON block) forces the reader to parse escaped `\n`s out of quoted strings and is bad UX.
- **23.qq** Prose-bubble value rendering is pluggable: strings render as preformatted prose; arrays and nested objects currently fall back to JSON inside the bubble body, but the rendering path is structured so multimodal parts (image URIs, file refs, tool-call records) can render as thumbnails or dedicated sub-components when a handler needs them — without changes to the field-splitting layer.

## 24. UX Details

Lessons from building this pattern. Skipping them produces UIs that work but feel broken.

- **Native `<select>` for the prompt picker on web.** Custom TouchableOpacity dropdowns with absolute positioning lose keyboard nav, click-outside-to-close, scroll containment, and focus management. The native select gets all of that for free. Style with `C.inputBg` / `C.textPrimary` / `C.border` and it matches dark mode fine.
- **Monospace is for code only — plus identifiers.** Everything human-prose is proportional font. Monospace is ONLY for code/JSON and for identifiers the user copies to log-correlate — a `job._id` in the JobCard header is monospace; the prose around it is not. Never monospace for rendered markdown, yaml, or editor body text.
- **Cache TTL check before `setLoading(true)`.** Every poll re-fetches data; flipping `loading=true` on each re-fetch flickers the page. Only set loading when the cache is older than a short TTL (~30s) or when the user explicitly navigated.
- **Consistent control-group styling.** Save and Delete must be the same kind of control. If Save is an `ActionButton`, Delete is `ActionButton variant="danger"` — not a bare text+icon button. Mixing styles makes the group look half-finished.
- **Dark-mode scrollbar styling.** Default scrollbars render white against dark cards. Add global `::-webkit-scrollbar` + `scrollbar-color` CSS using `C` tokens via a root-layout `useEffect`.
- **Distinguished empty states.** "No jobs yet" (with guidance about where jobs are created) reads differently from "no failed jobs on this tab." Don't use the same string for both.
- **Dirty-state Save button.** The editor Save button flips to `C.success` background when the editor content diverges from the saved body. users rely on that cue to know whether their edits are persisted.
- **Reverting to an older revision happens in git, not in the editor.** The flat-file model (see § 4) lets `git checkout <ref> -- web/prompts/<slug>.md` (or copy-paste from a git GUI) put any historical body back on disk; the next admin GET reads it through `loadPrompt`. The editor itself only ever writes the current file.
- **Instant "queued" row.** After `POST .../queue-generate`, call `loadJobs()` immediately so the new row appears without waiting for the next poll cycle. users need to see their click had an effect.
- **Job ID in the header, monospace.** Every `JobCard` must display `job._id.toString()` in the header — small, muted, monospace, far left, immediately followed by `·` and the prompt slug. users copy the id into DB queries and log greps; the slug tells them which template ran. The id is the only piece of identifying text for the job; there is no separate "template label" row below the header.
- **Per-column timestamps, not a shared row.** The JobCard's queued timestamp heads the prompt column; the completed timestamp (plus elapsed) heads the response column. No combined timestamp row across the full width. The spatial placement doubles as a label — the reader doesn't need a "PROMPT" / "RESPONSE" banner to know what each column is.
- **Click-anywhere-to-expand, menu-only-to-collapse.** Collapsed JobCards are clickable as a whole — no "Show more" button — and that's the only way to expand. Once expanded, the wrapper and column containers MUST have no click handler so text inside is freely selectable; collapse is reachable only through the ⋮ menu's "Collapse" item. No floating ✓ tick button. Every dedicated expand/collapse button on a card is fluff once this click model exists.
- **Card height caps.** Collapsed: each column clamps to 3 visual lines (`line-clamp-3`). Expanded: each column caps at 65vh with its own scrollbar, so the whole card stays under ~80vh and the queue below remains reachable.
- **Context menu closes on scroll.** Viewport-fixed dropdowns (`position: fixed` + `getBoundingClientRect()`) drift off their trigger the moment the trigger scrolls. Close on scroll (capture phase) and resize rather than trying to reposition — the user's intent was "click that button", not "drag a menu around".
- **Cancel is optimistic, not blocking.** Flip the card to `failed` locally before the API response arrives. users should not see a spinner or wait for a round-trip to know their click registered.
- **Timeout error message names the limit.** `"Timed out after 10m"` is better than a generic `"Job timed out"` because it tells the user exactly what the ceiling was. If `TIMEOUT_MS` is non-default (e.g. configured to 5 minutes), the message must reflect the actual limit.

**Deliverables:**

- **24.a** The Prompt picker on web uses a native HTML `<select>` (not a custom TouchableOpacity dropdown). There is no Version picker — see § 4 / § 20.f.
- **24.b** Monospace fonts are used only for code/JSON/identifiers in the repo's JobCard + Prompt Manager code — not for editor prose, not for rendered markdown, not for body text.
- **24.c** On re-fetches, `setLoading(true)` is gated by a cache TTL (~30s) or an explicit user navigation; not flipped on every poll.
- **24.d** Save and Delete in the Prompt Manager use the same kind of control (both `ActionButton`, one with `variant="danger"`).
- **24.e** Dark-mode scrollbar CSS is installed via a root-layout `useEffect` (or the project has documented that no dark mode is in use and this deliverable is marked ❌ accordingly).
- **24.f** Empty-state strings differ between the `all` tab and the per-tab empties ("no jobs yet" vs "no completed jobs on this tab").
- **24.g** The Prompt Manager's Save button background flips to `C.success` (green) when the editor content diverges from the saved body.
- **24.h** ❌ — superseded by § 4 / 20.f. There is no historical-version selector to load from. Historical revisions are reachable through git (`git show <ref>:web/prompts/<slug>.md` or any git GUI); they do not enter the editor by way of an admin-UI affordance.
- **24.i** Per-entity enqueue flows call `loadJobs()` (or equivalent refresh) immediately after `POST .../queue-generate` so the new `queued` row appears before the next poll cycle. (Conditional on § 21 being applicable; if Surface 2 is ❌, this is also ❌ with the same explanation.)
- **24.j** Every rendered `JobCard` displays `job._id.toString()` in the header, small, muted, monospace, far left — followed by `·` and `job.prompt.slug`.
- **24.k** The cancel flow is optimistic (flip local state before the API resolves) — a non-blocking UX, not a spinner-and-wait.
- **24.l** The timeout error message names the actual configured limit in minutes, not a generic "Job timed out" string.
- **24.m** The JobCard has no separate "template label" row under the header; the prompt slug is inline in the header's left group alongside the id.
- **24.n** The JobCard has no full-width timestamps row; `queued_at` heads the prompt column and `completed_at · <elapsed>` heads the response column.

## 25. Logging

**Deliverables:**

- **25.a** Every status transition is logged with job id, handler, attempt number, and elapsed time.
- **25.b** Error messages are logged verbatim for failed jobs (no truncation, no reformat).
- **25.c** "claimed N jobs / in flight: M" is logged on every worker poll cycle where N > 0.
- **25.d** "cancelled job {id} via user request" is logged when the cancel endpoint aborts an in-flight task.
- **25.e** "timed out job {id} after {elapsed}ms" is logged when the in-process timeout fires.
- **25.f** "reaped stuck job {id} (stuck since {started_at})" is logged at warn level for every job the reaper sweep picks up.

---

## 26. Scheduled Fires and Per-Prompt Spend Caps

Some prompts run on a cadence rather than being enqueued by a user click — a weekly ban/release-notes monitor, a daily competitor digest, a monthly compliance recap. The pattern: an admin creates a `prompt_schedule` that names a prompt slug, a cadence, baked-in inputs/context, and three rolling-window spend caps (daily / weekly / monthly, in USD). A **scheduler** loop ticks once a minute, checks `next_run_at` against `now`, and for each due schedule (a) computes rolling spend on the prompt's slug over each window, (b) skips the fire and writes a `status="skipped"` row to `prompt_queue` if any cap is exceeded, otherwise (c) enqueues a normal job into `prompt_queue` and advances `next_run_at` to the next cadence boundary.

The default cadence is **weekly**. Daily and monthly are equally first-class; a `cron_expr` field is supported for irregular schedules. Anything more exotic (every other Tuesday, twice a quarter) goes through `cron_expr` rather than expanding the cadence enum.

**The scheduler never calls the LLM.** It only inserts rows into `prompt_queue` (either `status="queued"` or `status="skipped"`). The existing worker (§ 13) picks queued rows up next cycle. This separation keeps every existing guarantee — cancel, timeout, reaper, snapshot rule, JobCard rendering — intact for scheduled fires without duplicating any of it.

### 26.1. Data model — `prompt_schedules` collection

```ts
{
  _id:              ObjectId,
  slug:             string,         // template slug to fire (must exist in web/prompts/{slug}.md)
  handler:          string,         // which handler processes the resulting job

  // Cadence
  cadence:          "daily" | "weekly" | "monthly" | "cron",
  cron_expr:        string | null,  // required when cadence === "cron"; ignored otherwise
  next_run_at:      ISO datetime,   // when the scheduler should fire this next

  // Soft pause — flipped by the admin UI; the scheduler honors it but never sets it
  enabled:          boolean,

  // Spend caps in USD. NULL means "no cap for that window" — explicit, not implicit.
  // The create-schedule form pre-fills $1 / $5 / $15; the admin must explicitly
  // clear a field (to null, rendered "no limit") to opt out of that window's cap.
  max_daily_usd:    number | null,
  max_weekly_usd:   number | null,
  max_monthly_usd:  number | null,

  // Baked-in payload passed through every fire. `inputs` is query-level params
  // (model, temperature, max_tokens, etc.); `context` is whatever the handler's
  // `onJobComplete` callback needs.
  inputs:           object,
  context:          object,

  // Audit trail surfaced on the schedules admin tab
  last_run_at:      ISO datetime | null,
  last_skipped_at:  ISO datetime | null,
  last_skip_reason: string | null,    // e.g. "weekly cap $5.02/$5.00 exceeded"

  created_at:       ISO datetime,
  updated_at:       ISO datetime,
}
```

### 26.2. Cadence advancement

After every fire (whether enqueued or skipped), advance `next_run_at` from the **previous** `next_run_at`, not from `now`. Anchoring to `now` slips the schedule forward by however long the scheduler took to notice the fire was due; over a year of monthly fires that's a lost fire (see AP34).

- `cadence === "daily"`: `next_run_at += 1 day`
- `cadence === "weekly"`: `next_run_at += 7 days`
- `cadence === "monthly"`: `next_run_at += 1 month` (calendar month, same day-of-month; clamp Feb 30 → Feb 28/29)
- `cadence === "cron"`: next match of `cron_expr` after the previous `next_run_at` (use a standard cron library)

If after advancement `next_run_at` is still in the past (the scheduler was offline longer than one period), keep advancing until `next_run_at >= now`. **Do not** retroactively fire missed schedules — each missed fire was a missed read of the world, and running it against today's world produces wrong data (see AP36). Just skip past the gap.

### 26.3. Spend-cap check — rolling, post-check, dollar-denominated

**Rolling, not calendar.** A "daily" window is `[now - 24h, now]`, not "today since midnight UTC." Calendar windows let a tight cap fire at 23:59 and 00:01 and double-spend (see AP33). Same for weekly (`[now - 7d, now]`) and monthly (`[now - 30d, now]`).

**Post-check, not pre-check.** Immediately before firing, the scheduler computes:

```
spent_24h = sum(response.usage.estimated_cost_usd)
              over prompt_queue
              where prompt.slug == schedule.slug
                AND status == "completed"
                AND completed_at >= now - 24h
```

(and similarly `spent_7d`, `spent_30d`). If `spent_24h >= schedule.max_daily_usd` (and the cap is non-null), the daily cap is breached. Same for the other two windows.

A single fire may overshoot a cap by at most one call's cost, because we record cost *after* the run completes. This is acceptable: caps are coarse spend ceilings, not micro-budgets. Pre-check with cost estimation requires a per-model price table inside the scheduler that never quite agrees with the handler's actuals, and the disagreement causes false skips at the boundary — not worth the complexity (see AP32).

`null` caps are skipped, not treated as zero. A schedule with `max_daily_usd = null` has no daily cap.

**Cost summation requires `response.usage.estimated_cost_usd` to be populated** by every handler that runs scheduled jobs — already a deliverable (§ 3.k). Handlers that don't write a cost number cannot be put on a schedule with caps; the scheduler should treat their slug's spend as `Infinity` and skip every fire, surfaced as `error: "handler does not report cost; cap cannot be enforced"`.

### 26.4. Skipped fires — write to `prompt_queue` with `status="skipped"`

When any cap is breached, the scheduler does NOT enqueue. Instead it writes a row to `prompt_queue` so the admin sees the skip in context with the runs it skipped over:

```ts
{
  handler:       schedule.handler,
  prompt:        { slug, body, updated_at },   // still snapshot the template body
  request:       null,                          // the model was never called
  request_cache: null,
  response:      null,
  inputs:        schedule.inputs,
  context:       schedule.context,
  status:        "skipped",
  queued_at:     now,
  started_at:    null,
  completed_at:  now,
  error:         "weekly cap $5.02/$5.00 exceeded",  // which window, actual vs limit
  attempt:       0,
}
```

The Universal Queue Page (§ 22) gains a "Skipped" tab. JobCards in the skipped state render the `error` field where the response body would normally go — the row exists precisely so the admin can see why the schedule didn't fire and what cap was hit.

After writing the skip row, the scheduler also updates the schedule document: `last_skipped_at = now`, `last_skip_reason = "<the same error string>"`. This lets the Schedules admin tab show "skipped 3× this week" without scanning `prompt_queue`.

### 26.5. Scheduler loop

A second background process, separate from the LLM worker (§ 13). Recommended layout: a sibling `prompt_scheduler.ts` (or `prompt_scheduler.py`) that runs alongside `prompt_queue_worker.{ts,py}` in the same host process. Both are started together; killing the host kills both.

```
SCHEDULER_INTERVAL = 60     // seconds; cadence boundaries are minute-grained at finest

loop:
  sleep SCHEDULER_INTERVAL
  due = prompt_schedules.find({ enabled: true, next_run_at: { $lte: now } })
  for schedule in due:
    spent_24h = sum_cost(schedule.slug, now - 24h)
    spent_7d  = sum_cost(schedule.slug, now - 7d)
    spent_30d = sum_cost(schedule.slug, now - 30d)

    breached = []
    if schedule.max_daily_usd   != null and spent_24h >= schedule.max_daily_usd:   breached += ("daily",   spent_24h, schedule.max_daily_usd)
    if schedule.max_weekly_usd  != null and spent_7d  >= schedule.max_weekly_usd:  breached += ("weekly",  spent_7d,  schedule.max_weekly_usd)
    if schedule.max_monthly_usd != null and spent_30d >= schedule.max_monthly_usd: breached += ("monthly", spent_30d, schedule.max_monthly_usd)

    if breached:
      reason = formatBreachReason(breached[0])   // first breached window wins the message
      prompt_queue.insert({ status: "skipped", error: reason, ... })   // § 26.4 shape
      schedule.last_skipped_at = now
      schedule.last_skip_reason = reason
    else:
      doc = await loadPrompt(schedule.slug)       // throws if slug missing — let it
      prompt_queue.insert({ status: "queued", prompt: { slug, body, updated_at }, inputs: schedule.inputs, context: schedule.context, handler: schedule.handler, queued_at: now, attempt: 0, ... })
      schedule.last_run_at = now

    schedule.next_run_at = advance(schedule.next_run_at, schedule.cadence, schedule.cron_expr)
    schedule.updated_at = now
    save(schedule)
```

The scheduler never calls a provider SDK. Its only output is rows in `prompt_queue`.

### 26.6. Admin UI — Schedules tab on `/platform/prompts`

The page already hosts the Manager (§ 20) and the Universal Queue (§ 22) as tabs. Add a third: **"Schedules"**. Each row is one schedule, showing:

- `slug` (links to the Prompt Manager editor for that file)
- `cadence` chip (`weekly` / `daily` / `monthly` / `cron: <expr>`)
- `next_run_at` as relative time ("in 2 days")
- The three cap fields, inline-editable
- A 7-day spend sparkline / bar
- `enabled` toggle (Pause / Resume)
- "Fire now" button — inserts an immediate `prompt_queue` row subject to the same cap check (a manual fire is not a cap bypass)
- `last_skipped_at` / `last_skip_reason` as a small muted line under the row when present

The **create-schedule form** defaults to:
- `cadence = "weekly"`
- `max_daily_usd = 1`
- `max_weekly_usd = 5`
- `max_monthly_usd = 15`

The admin can raise these, or explicitly clear a field to `null` (rendered as "no limit"). The form does not offer "unlimited" as a one-click default — the safe default is the path of least resistance.

### 26.7. Deliverables

- **26.a** `prompt_schedules` collection exists with every field in § 26.1: `slug`, `handler`, `cadence`, `cron_expr`, `next_run_at`, `enabled`, `max_daily_usd`, `max_weekly_usd`, `max_monthly_usd`, `inputs`, `context`, `last_run_at`, `last_skipped_at`, `last_skip_reason`, `created_at`, `updated_at`.
- **26.b** `cadence` defaults to `"weekly"` on every code path that creates a schedule (admin UI form, programmatic helpers, fixtures, seed scripts). A schedule created without an explicit cadence is weekly.
- **26.c** `max_daily_usd`, `max_weekly_usd`, `max_monthly_usd` are all surfaced on the create-schedule form pre-filled at `$1` / `$5` / `$15`. Explicit `null` means "no cap for that window" and renders as "no limit"; there is no implicit-unlimited default anywhere in the create flow (see AP37).
- **26.d** `job.status` enum in § 5.i and the data-model code block is extended to `"queued" | "processing" | "completed" | "failed" | "skipped"`.
- **26.e** A scheduler process runs every `SCHEDULER_INTERVAL` seconds (default 60). It is **separate** from the LLM worker (§ 13) and never calls a provider SDK directly — its only output is row inserts into `prompt_queue` (see AP35).
- **26.f** The cap check is computed over **rolling** windows: `[now - 24h, now]`, `[now - 7d, now]`, `[now - 30d, now]`. Calendar windows are forbidden (see AP33).
- **26.g** The cap check is **post-check**: `spent_*` is summed over `status="completed"` jobs only, using `response.usage.estimated_cost_usd`. A single fire may overshoot the cap by at most one call's cost. Pre-check with cost estimation is forbidden (see AP32).
- **26.h** When any cap is breached, the scheduler writes a `prompt_queue` row with `status="skipped"`, `request=null`, `request_cache=null`, `response=null`, `error="<window> cap $X.XX/$Y.YY exceeded"` (naming which window, actual vs limit), `completed_at=now`. It also updates the schedule's `last_skipped_at` and `last_skip_reason`.
- **26.i** When no cap is breached, the scheduler writes a `prompt_queue` row with `status="queued"`, snapshotting `{ slug, body, updated_at }` via `loadPrompt(schedule.slug)`, copying `schedule.inputs` and `schedule.context` onto the job. The existing worker (§ 13) picks it up next cycle — the scheduler does not call the handler itself.
- **26.j** `next_run_at` is advanced from the **previous** `next_run_at`, not from `now` (see AP34). When `next_run_at` is more than one period in the past, the scheduler advances forward to the next boundary `>= now` without enqueuing the intermediate missed fires (see AP36).
- **26.k** The Universal Queue Page (§ 22) has a "Skipped" tab listing rows with `status="skipped"`. The shared `JobCard` (§ 23) renders the `error` field in the right-column response slot for skipped rows (with the prompt body still rendered on the left so the admin can see what was being scheduled).
- **26.l** A "Schedules" tab on `/platform/prompts` lists every schedule with inline cap editing, a Pause/Resume toggle, a "Fire now" button (subject to the same cap check), and last_skipped_at / last_skip_reason rendered as a muted line under the row when present.
- **26.m** Handlers whose `response.usage.estimated_cost_usd` is always `null` (no pricing table) cannot serve a schedule with non-null caps — the scheduler treats their spend as `Infinity` and writes `error: "handler does not report cost; cap cannot be enforced"` skip rows instead of firing. This forces the operator to either add pricing to the handler or clear the schedule's caps to `null` explicitly.

---

## Fit-to-Project

Before implementing, check:
- **DB layer:** what's the project's collection/table convention? Indexes added in the same place as other collections (e.g. `lib/db.ts`).
- **Worker host:** is there an existing background worker process to attach this to, or does it need its own? In FastAPI projects, the worker often runs as an asyncio task started in `main.py` on app startup. In Node/Express, a `setInterval` in `server.js` works.
- **Auth:** queue and prompts endpoints almost always require admin or authenticated context — match the project's `requireAdmin` / `requireSession` pattern.
- **Polling interval:** 5s is the default; tune up if jobs take minutes (15–30s polling) or down if jobs are sub-second (1–2s).
- **Concurrency default:** start at 1 for strict per-key rate limits, bump up once you've measured.
- **Snapshot inputs:** if input files can be deleted/replaced after enqueue, snapshot the actual paths at enqueue time so the worker doesn't get a 404 later.
- **`max_tokens` default:** Gemini 2.5 models spend tokens on internal reasoning *before* emitting visible output, and those tokens count against the output cap. A 300-token cap that looked fine for "1–3 sentence replies" will routinely finish on `MAX_TOKENS` mid-sentence because reasoning consumed most of it. Start at **2000** for conversational chat handlers and tune down only if you've measured and actually hit the ceiling. If token cost is a concern for a chat persona that must stay terse, disable thinking on the SDK call (`thinkingConfig: { thinkingBudget: 0 }`) rather than squeezing `max_tokens`.

(Fit-to-Project is guidance, not a deliverable. It has no numbered items.)

---

## Anti-Patterns

Each is a binding prohibition; the Compliance Audit must call each one out by number with a file:line citation proving your diff does NOT exhibit it.

- **AP1 — Storing `prompt_slug` instead of the full prompt object.** The moment a job row references "the current version of slug X," a template edit rewrites history. Store `{ slug, body, updated_at }` on every job. No lookup tables, no version pointers, no joins — one document per job, closed at enqueue, closed again at completion.

- **AP2 — Bypassing `loadPrompt` with a direct disk read.** `fs.readFileSync("prompts/ashley-compiler.md")` in a route handler skips the in-process cache and the slug validation. Every consumer goes through `loadPrompt(slug)` — no exceptions, no "but this one is different" carve-outs. (Historical note: in the prior DB-backed shape, this anti-pattern was about the DB row and the seed file silently disagreeing; in the current flat-file shape it's purely a cache-coherence and slug-safety rule.)

- **AP3 — Forgetting `invalidatePromptCache` on PUT/DELETE.** The 5-second TTL means an admin saves a prompt, immediately tests it, and gets the old body for up to 5 seconds. Worse, every concurrent in-flight request in that window sees the stale body too. Always invalidate after a write.

- **AP4 — Special-casing "the compiler prompt."** If your codebase has a comment like *"this prompt is loaded directly from disk because…"* alongside another prompt that goes through the loader, that's a smell — every prompt is loaded directly from disk now, but every prompt also goes through `loadPrompt` and lives at `web/prompts/<slug>.md`. The user should not have to know which prompts are editable through the admin UI and which are hidden in module-scope string literals.

- **AP5 — Putting one-off enqueue buttons on the universal queue page.** "Compile KB," "Regenerate captions," etc., belong on the entity page they relate to — that's where the user already has context. The queue page is for monitoring and prompt editing, not for being a button graveyard.

- **AP6 — Flat-file pages.** `admin-prompt-queue.tsx` next to `platform/prompts/index.tsx` produces inconsistent breadcrumbs and sidebars. Every page in this recipe is directory-style under its tree (`app/(app)/platform/{name}/index.tsx` for platform-level, `app/(app)/admin/{name}/index.tsx` for org-level).

- **AP7 — Re-rendering the prompt at worker time.** The rendered prompt must be snapshot at enqueue. If the entity or template is edited between enqueue and execution, the worker still runs exactly what the user saw when they clicked Generate.

- **AP8 — Always-on polling.** Drains battery and burns API calls. Only poll when there are active jobs; stop when everything is terminal.

- **AP9 — Treating all errors as permanent.** Quota / rate limit / 503 errors should retry with backoff. Failing immediately wastes queued work and forces manual re-enqueue.

- **AP10 — Treating all errors as transient.** A malformed prompt or invalid input will loop forever, burning credits. Limit `MAX_ATTEMPTS` and only retry on the curated transient pattern list.

- **AP11 — Synchronous enqueue.** The enqueue endpoint must return 202 immediately with the job document. Do not block on the worker. The UI shows the new "queued" row before any model call has been made.

- **AP12 — Single endpoint for jobs + counts.** Keep counts on a separate endpoint so badges stay accurate regardless of pagination/filter state on the main list.

- **AP13 — No status discriminator.** Separate "queue" and "history" tables force awkward joins and break atomic status transitions. One table, one `status` field.

- **AP14 — Handler writes to source entity directly.** Handlers should return a response object and nothing else. Entity writeback belongs in `onJobComplete`. This keeps handlers pure and testable, and lets you re-apply results from a stored completed job without re-calling the model.

- **AP15 — Mutating the source entity from the worker without snapshot.** If the worker reads the entity at execution time, you lose the editor's intent. Always snapshot inputs at enqueue.

- **AP16 — Hiding the context menu button.** The `⋮` button must show always, even if all buttons in it are disabled.

- **AP17 — Hiding the cancel/collapse buttons when disabled.** Always show these buttons in the menu, even if disabled, so users know the actions exist and why they are unavailable.

- **AP18 — Skipping the reaper sweep.** A worker that claims a job and then crashes leaves that job in `processing` forever. The reaper sweep (run on each poll cycle before claiming new work) is not optional — it is the only mechanism that recovers orphaned jobs. Without it, stuck processing jobs accumulate silently and block the active-job count from ever reaching zero.

- **AP19 — Treating timeout as transient and retrying it.** A timeout means the model took longer than the configured ceiling, not that it was temporarily overloaded. Retrying a timed-out job is likely to time out again and burns quota. Mark it `failed` permanently; the user can re-enqueue with intent.

- **AP20 — Binding `onClick` to the expanded JobCard's wrapper or either column container.** Once a card is expanded, the user is there to read — and very likely to copy-paste — the rendered prompt or the response. A click handler on the wrapper or on the column containers interferes with text selection and stretches a trivial drag into an accidental collapse. The wrapper must have NO `onClick` while the card is in the expanded state; collapse goes through the ⋮ menu's "Collapse" item. (The *collapsed* wrapper IS clickable to expand — that's the required interaction, not an anti-pattern. The rule fires the moment the card enters the expanded state.)

- **AP21 — Adding a "Show more" button on collapsed cards or a floating `✓` tick on expanded cards.** Both are fluff. The collapsed wrapper is the expand target; the ⋮ menu's "Collapse" item is the collapse target. Dedicated expand/collapse buttons duplicate the wrapper click, clutter the card chrome, and the floating ✓ in particular needs z-index + `position: fixed` hacks that misbehave when the card is inside a scrolling queue. Never introduce them.

- **AP22 — Storing the raw template body with unresolved `{ident}` placeholders as `rendered_prompt`.** If the enqueue caller forgot to substitute `{chat_recent}`, the stored `rendered_prompt` is the template — and the handler sent the template to the LLM, with the literal `{chat_recent}` token in its system instruction. That's a silent correctness bug masquerading as a cosmetic one; the model's output is now being shaped by an un-templated placeholder it had to guess at. The enqueue helper MUST validate the final `rendered_prompt` for unresolved placeholders and refuse to insert (see 3.d). A narrow opt-out flag exists for prompts whose final text legitimately contains literal curly braces, and that flag must be explicit — never the default.

- **AP23 — Storing only the response body and dropping the input/output params.** A completed job without model name, token counts, and estimated cost is not an auditable record — it's a blob of text with no provenance. Every LLM handler MUST fold the finish reason, the provider's token usage metadata, and a cost estimate (computed from a handler-local `PRICING` map) into the response object. Every enqueue MUST write the tunables (model, temperature, max_tokens) into `inputs` so the stored record explains itself months later. Dropping either side breaks cost auditing, A/B diffing, and replay.

- **AP24 — Treating per-turn content (user message, chat history, system preamble) as an `inputs` param.** `inputs` is for query-level knobs — model, temperature, max_tokens, timeout. Per-turn *text* belongs in `rendered_prompt`, delimited by role markers. Siloing `user_message: "..."` into `inputs` makes the stored "prompt" a lie: a reader looking at `rendered_prompt` alone cannot see what the LLM actually processed, and a replay has to glue fields back together from two places. If it is text the LLM parses as content, it goes in `rendered_prompt`. If it is a knob the provider SDK takes as a named argument, it goes in `inputs`. No exceptions.

- **AP25 — Storing `model` in `job.response` instead of `job.inputs`.** The model is a *query parameter* — it's what the caller asked the provider to run. It is not an output. Putting it on the response side scrambles the "what I asked for" / "what I got back" dichotomy the JobCard's two columns are built on, forces the UI to hunt across both panels for a single logical identifier, and encourages handlers to silently default the model without writing it back to `inputs` (breaking cost auditing). The model always lives in `inputs.model`. If a handler genuinely observes a provider-reported fallback model that differs from the requested one, it may add `response.model_used` as a *confirmation* field — never as the primary record.

- **AP26 — Runtime-appending content to `rendered_prompt` outside the template.** Things like `if (isIdleFrame) prompt += "[System: ...]"`, or a handler wrapping the system text with `[SYSTEM]...[USER]...` markers the template never declared, or an enqueue helper inserting `"CONVERSATION SO FAR:\n"` before chat history. All of these break the scaffolding rule: the template is no longer a faithful description of what the LLM sees, and a reader looking at the `.md` file can't explain every byte of the stored prompt. Fix: promote the appended content to a named `{placeholder}` slot in the template, have the call site substitute an empty string when it doesn't apply, and do not concatenate or wrap anything outside of `renderTemplate`.

- **AP27 — Baking `[HISTORY]`-class content into the `[SYSTEM]` section (defeating the cache).** Providers like Gemini (`systemInstruction` / `cachedContent`) and Anthropic (system prompt caching) let you pin the stable part of a prompt and pay cache-hit rates on repeat calls. That only works if the stable part doesn't change between calls. Putting `{chat_recent}` inside `[SYSTEM]` means the system instruction mutates every turn; the cache never hits; you pay full input-token price on every message. The split between `[SYSTEM]` (stable, cacheable) and `[MAIN]` (per-call, with optional nested `[HISTORY]` → `[USER]` for chat templates) exists specifically so the template author can't conflate these accidentally. Anything that changes per turn goes below the `[SYSTEM]` marker — i.e., inside `[MAIN]`.

- **AP28 — Storing a flat "rendered prompt" preview when the handler actually fired a structurally-different SDK call.** The stored record must be the call as sent — `systemInstruction` / `cachedContent` / `contents` / `config` as separate fields, one pretty-JSON blob (`job.request`). Storing the pre-split role-marked string and calling it "rendered_prompt" lies to every debugger that opens the record: it shows the authoring form, not the wire form, and hides the structural split *and* any caching indirection the handler applied. If the handler called the SDK with `{ cachedContent, contents, config }`, the stored record must show `{ cachedContent, contents, config }` — not `"[SYSTEM]\n...\n[USER]\n..."`. The flat role-marked string exists only transiently in memory during enqueue, as the input to the composer; it is not stored on the job. Corollary: when caching replaces inline `systemInstruction`, the cache's own creation payload (what's pinned inside the reference) is stored on `job.request_cache` as a separate object and rendered as a separate labeled JSON block — not inlined as an underscore-prefixed sibling on `job.request`, and not hidden entirely.

- **AP29 — Capping the expanded response at a fixed `max-h` while the prompt also has one.** Dual nested scroll boxes for prompt and response next to each other is the worst-of-both-worlds UX: the reader can't pan through either side without losing their place in the other. The response is almost always what the reader expanded the card to read — its container must flow to its natural height and let the page (not the card) handle overflow. The prompt side does stay capped at `max-h-[65vh]` because system instructions and knowledge bases routinely run thousands of lines and an uncapped prompt makes the card unreadable; the grid's default stretch handles the asymmetry cleanly.

- **AP30 — Passing full-sentence instruction text as a template variable value.** A variable slot named `{idle_frame_note}` substituting to `"[System: 30+ seconds have elapsed since the last exchange. The visitor is still on the page. Follow the TAKE FRAME directive above.]"` is instruction duplication, not data. The TAKE FRAME directive already lives in the `[SYSTEM]` section of the template; the variable should tell the LLM only *that* the condition fired, not *what to do about it*. Use a literal boolean token — `true` / `false` — named by convention (`{idle_frame}`, `{returning_visitor}`, `{sensitive_flagged}`) and let the template write the labeled flag line that contains it (e.g. the template literal `idle_frame: {idle_frame}` renders as `idle_frame: true` or `idle_frame: false`). Reasons: (a) the template becomes a complete specification of behavior in one file; (b) the call-site string and the template wording cannot drift apart as one is edited and the other is not; (c) template-rendered output stays legible (a one-token bool is cleaner than a reworded directive appearing mid-prompt); (d) anyone auditing prompts via the admin UI can see the full behavior spec by reading the template alone, without hunting through call sites for variable values. The template owns the WHAT; the variable owns the WHEN.

- **AP31 — Rendering prose payload fields (system instruction, contents, chat history) inside a JSON block.** JSON-encodes prose as a quoted string with `\n` and `\"` escapes. A 2000-token system instruction in that form is unreadable: the reader has to mentally un-escape newlines and quote characters just to see the text. The fix is to split each top-level field of `job.request` (and `job.request_cache`) into two buckets — scalar/structural fields (`model`, `config`, `cachedContent`, `ttl_seconds`) go into a compact monospace JSON block, and long-form content fields (`systemInstruction`, `contents`, or any string ≥ 200 chars) each render as their own labeled bubble with a proportional-font body and `whitespace-pre-wrap`. The JSON block stays monospace because it's code-shaped; the prose bubbles are not. Never put prose in the JSON block.

- **AP32 — Pre-checking caps with a cost estimate.** Predicting the cost of a not-yet-run call requires a per-model price table inside the scheduler that never quite agrees with the handler's actuals, and the disagreement causes false skips at the boundary. Always compute spend from completed jobs' `response.usage.estimated_cost_usd`. A single one-call overshoot is the acceptable cost of post-check simplicity.

- **AP33 — Calendar windows instead of rolling.** "Daily" meaning "since midnight UTC" lets a schedule fire at 23:59 and 00:01 and double-spend the daily cap. The window is `[now - 24h, now]`. Same for weekly (`[now - 7d, now]`) and monthly (`[now - 30d, now]`). Calendar windows also create timezone arguments the recipe deliberately doesn't want to have.

- **AP34 — Advancing `next_run_at` to `now + cadence` instead of `previous_next_run_at + cadence`.** Every restart, every slow scheduler tick, every dropped notification slips the schedule forward by the scheduler's own latency. Over a year of monthly fires you've lost a fire. Always anchor advancement to the previous `next_run_at`.

- **AP35 — Scheduler calling the LLM directly.** The scheduler's job is to insert rows into `prompt_queue`. The worker (§ 13) is the only thing that calls handlers. Mixing the two breaks the cancel/timeout/reaper guarantees the worker provides, sidesteps the snapshot rule (§ 3), and means a scheduled fire and a user-triggered fire of the same slug execute through two different code paths.

- **AP36 — Backfilling missed fires.** If the scheduler was offline for a week of a daily schedule, do not enqueue seven jobs. Each missed fire was a missed read of the world; running them against today's world is wrong (the data they would have surfaced no longer exists or is now stale). Advance `next_run_at` past the gap and resume on the next boundary.

- **AP37 — Implicit-unlimited caps.** A `max_weekly_usd: null` default that the admin never sees is how runaway costs happen. The create-schedule form must pre-fill all three caps with a low explicit value ($1 / $5 / $15) and require the admin to type "no limit" (clearing to `null`) to opt out of a window's cap. "Forgot to set the cap" is not a state this recipe permits as a default.

- **AP38 — Building a parallel scheduler (cron file, `setInterval` in a handler module, OS-level systemd timer) that calls the LLM and bypasses `prompt_queue`.** The whole point of this recipe is that every LLM call — manual or scheduled — appears as a row in `prompt_queue` with the snapshot rule honored. A parallel cron that calls the SDK directly is invisible to the queue page, the cost rollups, the cap checks, and the JobCard. If a scheduled fire is wanted, it goes through `prompt_schedules` + the scheduler in § 26.5. No exceptions.

---

## Compliance Audit — Required Completion Artifact

The **only** acceptable completion signal for this recipe is a Compliance Audit that satisfies every rule below. No narrative summary, no prose wrap-up, no "install complete" message outside this artifact. Rule 1 ("READ THE RECIPE TWICE") and rule 7 ("ALL DELIVERABLES ARE A CHECKLIST") in `_recipes/_index.md` make this binding; this section fixes the exact format.

### What the audit must contain

The audit is a flat numbered list. Each line is one numbered deliverable (1.a … 25.f) or one numbered anti-pattern (AP1 … AP20), **quoted verbatim from this SKILL.md**, followed by a status marker and a file:line citation.

### Required format — per-item rules

1. **Enumerate every numbered deliverable** in sections 1 through 26, **in order**, with its exact number (e.g. `1.a`, `5.n`, `23.bb`, `26.m`). Copy-paste the deliverable text from this SKILL.md verbatim. Do not paraphrase. Do not reorder. Do not group.

2. **Enumerate every numbered anti-pattern** `AP1` through `AP20`, in order, **with its short title quoted verbatim**. Paraphrasing is a failure.

3. **After each item, on the same line or the line immediately below, add exactly one status marker:**
   - `✅ <file>:<line>` — satisfied; citation required and must be a real file:line in the diff.
   - `⚠️ <file>:<line> — <what is missing or partial>` — partially satisfied; citation AND explanation required.
   - `❌ — <why it was skipped>` — intentionally not satisfied; explanation required. (Used for e.g. Surface 2 on projects without per-entity prompt iteration, or artifact handlers on projects without image/file outputs.)

### Required format — global rules

4. **No summaries.** The artifact contains only the enumerated list. No "Summary of changes", no "Key points", no "Highlights". If you want to add context about a single deliverable, put it on that deliverable's line after the citation — not in a separate summary section.

5. **No grouping of deliverables under one citation.** A citation of the form `1.a–c: PromptQueue.ts:7` is a failure. One deliverable number = one citation line. If two deliverables are genuinely satisfied by the same file:line, cite that file:line on both deliverables' lines.

6. **No ✅ without a real, verifiable file:line.** A ✅ without a path and line number, or with a made-up line number, is an audit failure and means the install is INCOMPLETE regardless of implementation state.

7. **Paraphrase is forbidden for the deliverable text.** The recipe's wording must appear verbatim in the audit. Paraphrase is how narrative creep sneaks into verification — do not do it.

8. **Counts must match.** At the top of the audit, report two numbers: the total count of deliverables + anti-patterns in this SKILL.md (count yourself, do not guess), and the total count of lines in your audit that carry a status marker. **If those two numbers do not match, the audit fails and the install is INCOMPLETE.** Do not submit a mismatched audit.

### Forbidden outputs

- A completion message that is not the audit.
- Prose like "Recipe compliance is complete and verified."
- Grouped bullets ("Data model complete: PromptQueue.ts has all required fields").
- A ✅ with no file:line.
- A ✅ with a wrong or fabricated file:line.
- "See above" or "same as X" as a citation.
- Running the recipe without the audit because "the diff is obvious" or "there's no time". There is no exception.

### Minimum output template

```
# Compliance Audit — admin-prompt-queue

Deliverables in SKILL.md: <N>
Anti-patterns in SKILL.md: <M>
Total items: <N+M>
Citation lines in this audit: <should equal N+M>

## Deliverables

1.a <verbatim text> — ✅ <file>:<line>
1.b <verbatim text> — ✅ <file>:<line>
2.a <verbatim text> — ✅ <file>:<line>
...
25.f <verbatim text> — ✅ <file>:<line>

## Anti-patterns

AP1 <verbatim short title> — ✅ <file>:<line> (citation proves absence)
...
AP20 <verbatim short title> — ✅ <file>:<line>
```
