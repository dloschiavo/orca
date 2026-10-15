---
name: llm-providers
description: >
  Use when a project's prompt-queue LLM calls must run on operator-chosen
  providers/keys with quota failover, configured on a superadmin page with no
  deploy. Covers the 12-provider table on 3 wire drivers, AES-256-GCM sealed
  keys in one settings row with env keys shown read-only, model-list discovery
  (on add/rotate AND on page load for never-checked/day-old keys), and the
  "Priority" page: one ordered list of tiers (provider + model + keys),
  keys round-robin within a tier, classified fallthrough with per-model vs
  key-wide cooldowns, and per-job routing records.
dependencies:
  requires: [admin-prompt-queue, admin-routing]
  capabilities:
    auth: otp-auth
    design-system: admin-design-system
provides: [llm-routing]
---

# LLM Providers (API keys + Priority)

Every LLM call a project makes goes through ONE runner that decides, at fire
time, which provider, model and key serve the job, and what takes over when a
key runs out of quota. The operator sets it on one superadmin page (`/platform/llm`,
sidebar "LLM Providers") and it takes effect within seconds without a deploy.
The key insight: **callers never name a provider model. They name the queue's
default model constant (`FULL_MODEL`), and the runner maps that to an ordered
list of tiers.** So swapping Gemini for Claude, adding a second key to pool
quota, or putting a cheaper model behind the primary is a page edit, not a code
change.

Reference implementation: diplomat `web/` — `lib/llm/{providers,secretBox,settings,chain,run,drivers,pricing,admin}.ts`,
`app/api/platform/llm/route.ts`, `app/platform/llm/page.tsx`, spec `docs/prd-llm-providers.md`,
tests `lib/llm/{chain,run,settings}.test.ts`. Diplomat also carries a second
"Economy" list that its per-org budget ladder routes to; that is Diplomat-only,
so don't port it. Siblings sharing the provider
table: docpost `docpost-app/lib/llm/` + `app/(app)/platform/llm.tsx` (the
original template) and Thopter `packages/core/src/drivers/providers.ts`.

## Data model

One row in the project's platform-settings store, `key: "llm"` (unique-indexed).
Never a collection per key.

```ts
interface LlmSettings {
  keys: StoredKey[];                         // operator-added keys
  env_models: Record<string, ModelCache>;    // model lists fetched with an env key, by provider
  chain: StoredTier[];                       // the Priority list, in order
}
interface ModelCache { models: LlmModelInfo[]; models_fetched_at: string | null; models_error: string | null }
interface StoredKey extends ModelCache {
  id: string; provider: string; label: string;
  api_key_enc: string | null;   // AES-256-GCM "v1:<iv>:<tag>:<ct>" (base64 parts)
  key_hint: string | null;      // "••••abcd" — the only form the page ever sees
  base_url: string | null;      // null = provider default; set for a proxy/gateway/remote Ollama
  created_at: string; updated_at: string;
}
interface StoredTier {
  id: string; provider: string; model: string;
  key_ids: string[];                         // [] = EVERY key the provider holds, present and future
  price: { input: number; output: number } | null;  // USD / 1M tokens, only for models pricing.ts doesn't know
}
interface LlmModelInfo { id: string; name: string; context_window: number | null; max_output: number | null }
```

Reads go through a pure `projectLlmSettings(raw)` that drops unknown providers,
dangling key refs, env-prefixed ids in `keys`, and half-set prices. **Why:** the
row is hand-editable and outlives provider-table edits; the runner must never
crash on a stale shape.

The process caches the parsed row for **15 s** (pinned on `globalThis`, see
Anti-patterns), so a save reaches every instance's worker within 15 s. Writes
and every mutation read `{ fresh: true }`.

## Providers

`LLM_PROVIDERS` is an isomorphic table (no secrets, no I/O) with
`{ id, name, wire, baseUrl, keyRequired, keysUrl, isLocal }`. Copy the
reference list verbatim: Google Gemini, Anthropic, OpenAI, OpenRouter, xAI,
Mistral, DeepSeek, Groq, Together AI, Fireworks AI, Ollama (local), LM Studio (local).
It is Thopter's API table **minus terminal harnesses** (Claude Code, Codex,
Gemini CLI). They drive a shell, not a prompt, so a queue can't use them.

Three wires, three drivers:
- `gemini`: `@google/genai` generateContent (the queue's native request shape).
- `anthropic`: Messages API, **streamed** and read to the end, because long generations outlive a non-streaming request.
- `openai-compat`: `/chat/completions`, which every other provider speaks.

Every driver takes the ONE composed request the queue already builds
(`{ model, systemInstruction, contents, config }`) and answers in ONE shape:
text, `finish_reason` in Gemini's vocabulary (`STOP`/`MAX_TOKENS`/`SAFETY`,
which callers already branch on), and usage. Nothing downstream changes.
Driver quirks to keep: current Claude models (5.x, Fable, Opus 4.7+) reject
`temperature` with a 400; OpenAI reasoning models (o-series, GPT-5) take only
the default temperature; non-Gemini JSON mode may fence its output, so unfence
before callers `JSON.parse`. Clamp `maxOutputTokens` to the model's known `max_output`.

Environment keys sit alongside stored keys as read-only key ids `env:<provider>`:
`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`.
Stored keys come first, then the env key. **Why:** an unconfigured deploy keeps
running exactly as before the feature existed.

## Key sealing

`LLM_KEY_ENCRYPTION_KEY`: 32 bytes, hex or base64, **per environment**. AES-256-GCM
with a 12-byte random IV. `canSeal()` drives a page warning ("keys cannot be
stored on this deploy") instead of a 500 on add. A stored key that won't open
(rotated master key) is a config fault on THAT key only. The runner records it
as `key rejected` and moves on.

## Model discovery

Each key's model list is fetched live from the provider:
- Anthropic: `GET /v1/models`, paged with `after_id`. Use `display_name`, `max_input_tokens`, `max_tokens`.
- Gemini: `GET /v1beta/models`, paged with `pageToken`. Keep only models whose `supportedGenerationMethods` includes `generateContent`, and strip the `models/` prefix.
- openai-compat: `GET {base}/models`. Together returns a bare array; the rest wrap it in `{data}`. Read the context and output limits from whichever field the provider uses.

Cap paging at 10 pages and each fetch at 20 s.

A list loads at three points:
1. **Add key**, or a change to its **secret or base URL**. That change also clears the cached list and the key's cooldowns (`forgetKey`), because a different key or server sees different models.
2. **"Refresh models"** in the key's kebab menu.
3. **Every page load (GET)**, for any key that was **never checked, or last checked more than 24 h ago** (`refreshStaleModelLists`). Fetch in parallel, then write the results one after another to the single row. Skip a key whose last check FAILED until someone clicks "Refresh models".

**Why #3 exists:** env keys never pass through "add key". Without it the
Gemini env key showed 0 models in prod, never checked, so every tier's Model
field fell back to a blank "Model id" text box. It shipped broken and got
caught in QA (2026-10-13). **Why failed keys are skipped:** a dead base URL
would otherwise stall every page load for 20 s.

A failed fetch stores a human reason on the row: "did not answer within 20
seconds", "Couldn't reach <url> (ECONNREFUSED) — is the server running?", or
the provider's message. The key row's status badge is one of: cooldown
badge(s) with "until <time>", **Check failed** + reason, **Ready** (title = checked
timestamp), or **Not checked**.

## Priority (the chain)

The page section is titled **Priority**. Never "Fallback Chains": the
operator renamed it, and code alone keeps the word "chain". It is ONE ordered
list of tiers, and it serves every caller naming `FULL_MODEL`. Page copy names
what it serves in the project's own words, e.g. "Every chat turn,
knowledge-base job and scheduled prompt."

`planJobChain(settings, callerModel)` is THE ONLY answer to "what does this
job run on". The queue handler calls it at fire time and nothing else decides:

```text
FULL_MODEL      → Priority   | empty → built-in: Gemini FULL_MODEL on every Google key
any other model → that Gemini model on every Google key ("pinned": a manual run, an eval), then Priority
```

A tier resolves to concrete key ids: `key_ids` filtered to keys that still
exist, or every provider key when `key_ids` is empty.

Saving replaces the whole list in one call (one dirty-state Save button + Cmd+S).
Server validation names the place: "Tier 2: choose a model", "…: a
selected key is not a Google Gemini key", "…: Google Gemini has no keys",
"…: set both the input and output price". The client catches half-set prices
before the round trip. Success copy: **"Saved. New prompts follow this priority within 15 seconds."**

Removing a key drops it from every tier that named it. A tier left with
**none** of its named keys is deleted, never widened to "every key".

### Tier row UI
- Drag grip reorders. Label "Tier N". ✕ removes.
- Provider: a native select. Providers with no keys are disabled and suffixed " — no keys". Changing the provider resets model, keys and price.
- Model: a native `<select>` over the union of the spend keys' model lists, labelled `Name (id)`. A saved model missing from the list stays as its own option. Fall back to a free-text "Model id" input ONLY when no spend key has a list.
- Keys: checkbox **"All keys for this provider, including ones added later"** (default, `key_ids: []`). Unchecking reveals per-key checkboxes with their `••••` hints. With 2+ spend keys show "N keys take turns; when one runs out of quota the next takes over."
- Price: shown when the model has no known price (OpenRouter counts as priced because it reports billed cost). Warning: "Diplomat doesn't know this model's price. Until you set one, spend on this tier doesn't count toward org LLM budgets." Swap in the project name.

## Execution (`runOnChain`)

1. Plan the tiers. If no tier has any key, throw an error that **names `GEMINI_API_KEY`** (dev tooling matches on it).
2. `orderAttempts`: tiers in order. Within a tier, keys start at a rotating cursor (keyed by provider|model|keyIds), so consecutive jobs spread across keys and n keys pool their quota. Keys still cooling are skipped and reported.
3. Before each attempt, persist the request-as-sent (and on Gemini the `cachedContent` it pinned), so a timeout still leaves a faithful record.
4. Success clears that key's cooldowns. Failure: `classifyFallthrough(err)` decides.

```ts
// reason            cooldown                          scope
// out of credits    1 h   (402, "credit balance", "insufficient_quota"…)   key-wide
// quota exhausted   1 h   (429/quota text mentioning per-day/daily)        per model
// rate limited      Retry-After or Gemini "retryDelay", clamp 15 s–1 h, default 1 min   per model
// key rejected      1 h   (401/403, "api key not valid"…)                  key-wide
// overloaded        30 s  (500/502/503/529, "overloaded")                  per model
// context too long  0     (job can't run here; key is fine)                —
// unreachable       1 min (no status + fetch failed/ECONNREFUSED/ENOTFOUND) key-wide
// anything else → null: the request itself is bad (400, safety) → FAIL THE JOB, no fallthrough
```

5. If every attempt fails over: when any reason is passing (rate limit, quota, overloaded, unreachable), throw a message containing "rate limit" so the queue's transient retry re-queues with backoff. Otherwise throw a permanent config error. Both list every provider/model/key/reason, and when each cooling key comes back.
6. Return `routing = { tier, provider, model, key (label), fallbacks[] }` on the job response. The served model is `routing.model`, not `inputs.model`.

Cooldowns and cursors live in process memory, pinned on `globalThis`. They are
per instance: each instance learns a key is spent from its own 429, which
costs one rejected call. That trade is accepted. Don't build cross-instance
sharing until it's asked for.

## Cost

`pricing.ts`: exact-id Gemini prices and longest-prefix Anthropic prices
(dated snapshots share the family price). Unknown → `null`, so the UI shows
"—" and never a wrong number. The precedence is the tier's own price, then
the known price, then null. OpenRouter reports billed cost. This table is
**margin-load-bearing**, because it feeds any per-org LLM budget the project meters.
Understating a price silently erodes margin.

## API

`GET /api/platform/llm` (superadmin): refresh stale model lists, then return the
view: providers, keys (hint only, never a secret, with live cooldowns on this
instance), chain, `can_store_keys`. `PATCH` takes one op per request:
`add_key` / `update_key` / `remove_key` / `refresh_models` / `save_chain`.
Every op except refresh writes an audit row (`llm_key_added`, `llm_key_updated`
with changed field names but never values, `llm_key_removed`, `llm_chain_saved`
with `provider/model` per tier). Config errors are 400s carrying the message.

## Fit-to-Project

- Does the project route LLM work through `admin-prompt-queue`? This recipe plugs in as the handler body. Any direct provider SDK call elsewhere must move onto the queue first, or it bypasses priority, rotation and metering.
- What is the project's default model constant (`FULL_MODEL`)? Every caller that should follow Priority names it. Any call site naming a concrete model is either a deliberate pin or a bug.
- Where does the platform-settings row live (Postgres via lib/pgdb, Mongo, Firestore-compat)? It's a single indexed point read every 15 s per instance, safe on Firestore-compat.
- Does the queue already compose a Gemini-shaped request? If it's another shape, pick that as the canonical one and translate from it in each driver instead.
- Which env keys does the deploy already set? Add them to `LLM_ENV_KEYS`. Provision `LLM_KEY_ENCRYPTION_KEY` in Secret Manager per environment, and exclude it from any "push local env to prod" helper.
- Does the project's audit helper accept `{ actor, action, resource_type, resource_id, metadata }`?

## Anti-Patterns

- **Model lists only on add-key.** Env keys never take that path, so their tiers show a blank text box instead of a model picker. This shipped broken to prod. Load never-checked and day-old lists on GET.
- **Re-checking failed keys on every page load.** A dead local server or proxy makes every page view wait 20 s. A failed check waits for an explicit "Refresh models".
- **Calling the section "Fallback Chains".** The operator renamed it **Priority**. Every user-facing string (heading, save message, server validation like "Priority must be a list") says priority. Only identifiers say chain.
- **Callers naming provider models.** `model: "claude-sonnet-…"` at a call site bypasses Priority. Callers name `FULL_MODEL`, and only a deliberate pin (manual run, eval) names a concrete Gemini model.
- **Falling through on every error.** A 400 or a safety block would fail identically on every provider, so spraying it costs n× and buries the real error. Only the classified reasons fall through.
- **One cooldown scope.** Benching a whole key for one model's rate limit wastes its other models' quota. Spent credits, a rejected key or a dead server must bench the whole key, or every model on it burns a failed call.
- **Widening a pruned tier.** If removing a key leaves a tier that named specific keys with none, delete the tier. Turning it into "every key" silently starts spending a key the operator excluded.
- **Module-level `Map`s for cooldowns, cursors and the settings snapshot.** Each Next bundle evaluates its own copy of the module (route vs instrumentation worker). Without `globalThis` pinning, a save in the API route is invisible to the worker and cooldowns never meet.
- **Returning secrets to the client, even "just for the edit form".** The page sees `••••last4` only. Edit takes a new secret or nothing.
- **Copying dev's `LLM_KEY_ENCRYPTION_KEY` to prod.** It's per environment. Rotating it makes every stored key unreadable, and the runner then reports them `key rejected`.
- **Inventing a price for an unknown model.** Return null and show "—", and let the tier carry an operator-entered price. A guessed price is a silent margin bug.
- **A chain-exhausted error without "rate limit" when waiting would help.** The queue's transient-retry matcher won't re-queue it, and jobs die during a 60-second burst.

## Logging

- `[llm] <provider>/<model> (<key label>) <reason> — trying the next key/tier` (warn) on each fallthrough.
- `[llm] Priority served by <provider>/<model> (<label>) after N fallback(s)` when a job needed failover.
- Per job: `response.routing` (tier, provider, model, key label, `fallbacks[]` with clipped 300-char errors) and the per-attempt request-as-sent. These answer "why did this run on Claude" without logs.
- Exhausted-chain error text lists every attempt and every cooling key with its `until` ISO time.
