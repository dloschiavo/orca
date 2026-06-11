---
name: draft-persistence
description: >
  Use when any form in the app edits data that's persisted server-side and
  the server round-trip can fail. Locally persists unsaved form content to
  localStorage on every keystroke; clears only on a confirmed server ack.
  Recovers edits across tab crashes, dev-server OOM, network outages, and
  deploys. Covers single-string forms, multi-field forms, chat inputs, and
  the list/detail pattern where each item needs its own draft.
dependencies:
  requires: []
  capabilities: {}
provides: [form-drafts]
---

# Draft Persistence

A tiny localStorage-backed store for in-progress form content. The contract: **localStorage holds the user's most recent typed intent; the server holds the last successfully-saved value. Drafts are cleared only by an explicit `clearDraft(key)` call, which a caller should do only after the server acknowledges the save (2xx). Everything else — network blip, 500, tab crash, dev-server OOM, laptop-lid close, deploy — leaves the draft intact for pickup on next load.**

The insight: unsaved work is an invariant the user has already verified (they typed it). The server round-trip is the unreliable part. The correct place to hold the user's intent is the client until the server has proven it accepted the write. Anything else loses work.

Reference implementation: `goliathdynamics.com/web/src/lib/draft.ts` plus three consumers — `web/src/app/(admin)/admin/prompts/page.tsx` (Prompt Manager editor + new-slug input), `web/src/app/(admin)/admin/cms/page.tsx` (CMS list/detail form), `web/src/components/public/PublicChat.tsx` (chat input with failure recovery).

## The Library

Four pure functions. SSR-safe, quota-tolerant, framework-agnostic.

```ts
// lib/draft.ts
export function saveDraft(key: string, value: string): void;
export function loadDraft(key: string): string | null;
export function clearDraft(key: string): void;
export function sweepDrafts(prefix: string, keepSubKeys: Set<string>): void;
```

- Server-side (Node): all four are no-ops / null reads. Safe to call from any component without SSR guards at the call site.
- Quota-tolerant: `setItem` wrapped in try/catch. Full storage, disabled storage, Safari private mode all degrade silently — the feature is best-effort, never throws.
- String-only values. Compound drafts are JSON-stringified by the caller. Keeps the API small and makes draft contents inspectable via DevTools without parsing.

`sweepDrafts` is the garbage-collector — called after a list reload, it drops drafts for entities (slugs, ids) that no longer exist in the current snapshot. Prevents localStorage from accumulating dead keys for deleted items.

## Key Namespacing

Every key follows `draft:<form-id>:<sub-id>` so different forms cannot collide. Examples from the reference implementation:

```
draft:prompt-editor:body:amelia-chat       // per-slug: switching prompts preserves in-flight edits on both
draft:prompt-editor:new-slug                // singleton: the inline "+ New Prompt" input
draft:cms:item:<item_id>                    // per-item, JSON-serialized whole DraftState
draft:cms:new-item                          // singleton new-item form (title + slug as JSON)
draft:public-chat:input:<session_id>        // per-session chat input
```

Sub-ids with a trailing separator (`draft:prompt-editor:body:<slug>`) are the hook `sweepDrafts` uses — pass the prefix including the separator, plus the set of still-alive sub-ids.

## Lifecycle

For each form field you wire:

1. **On every keystroke** — `saveDraft(key, value)`. No debouncing. localStorage writes are synchronous and cheap on modern browsers. Debouncing only introduces a window during which a crash loses the last N ms of typing.
2. **On mount / when the editing target changes** — `loadDraft(key)`. If non-null, apply it as the initial value (overriding the server-fetched value). This is how drafts actually recover: the value the user typed wins over the value the server has, because the user's is newer.
3. **On server ack (2xx)** — `clearDraft(key)`. This is the *only* path that clears a draft. The draft has graduated to server state; the local copy is redundant.
4. **On explicit user discard** — `clearDraft(key)`. E.g., a Cancel button on a new-item form. User-driven discards count as an ack of intent.
5. **On entity delete (2xx DELETE)** — `clearDraft(key)` for that entity.
6. **After list reloads** — `sweepDrafts(prefix, aliveIds)`. Garbage-collects drafts for entities that no longer exist.

### Compound drafts (multi-field forms)

When a single logical draft spans multiple fields (a form with title + description + body + tags), serialize the whole state object to JSON and store under one key. On load, `JSON.parse` inside a try/catch — if malformed, fall back to the server value. This keeps per-keystroke writes atomic (no half-saved drafts where title is old and body is new) and keeps the key count manageable.

### Send-and-forget forms (chat inputs)

Chat message sends don't fit the typical create/update pattern — the server accepts a message and the input is cleared. The failure mode is "send attempted, server failed, message lost because the UI already cleared the input." The fix:

- Persist every keystroke to the draft (same as any other form).
- On submit: optimistically clear the visible input **but do not clear the draft**.
- On 2xx: clear the draft.
- On any other outcome (network error, non-2xx): **restore the text to the input**, re-persist the draft (defensive), and **remove any optimistic bubble** you added to the message list. This lets the user retry by hitting Send again without re-typing and without duplicating the message in the transcript.

## The Critical Bug This Pattern Prevents

The reference implementation captures a real QA round that shipped silently for a while: the chat's `sendMessage` called `setInput("")` *before* the `await fetch(...)`. If the server was down or returned 500, the input was already empty, the user had no visible indication their message hadn't sent, and the typed text was gone. The pattern above fixes this by making "clear the draft" contingent on a server response the code has actually seen.

Any form where `setFieldValue("")` fires before the server responds has this class of bug. The pattern requires you to sequence the clear after the ack, period.

## Fit-to-Project

Before implementing, check:

- **Storage backend.** Default is `window.localStorage`. For anything larger than ~5MB per draft (document editors with embedded images), IndexedDB via a thin wrapper with the same API is a drop-in swap. Don't swap preemptively — most forms are well under the quota.
- **SSR / hydration.** All four functions are SSR-safe (no-op on server). For Next.js / Remix / similar, you can call them from component bodies or event handlers without guards. If the framework renders deterministically on SSR (e.g. generating snapshots), be aware that client-side draft hydration may cause a brief flash as the textarea updates post-mount — acceptable for admin tools, worth wrapping in a `useEffect` if the form lives on a public page.
- **Multi-tab / multi-device.** localStorage is origin-scoped but per-browser. Two tabs editing the same entity on the same origin share a draft — the last writer wins per-keystroke. Across devices: drafts don't sync. If you need cross-device recovery, the write should land server-side as a separate "draft" collection, which is out of scope for this skill.
- **Private / incognito modes.** Safari private mode throws on `setItem`. The library swallows; the feature degrades to "no drafts in private mode." Acceptable default.
- **Legal / compliance.** Persisting drafts locally means partial content survives on the user's machine after logout. For compliance-sensitive forms (PII, legal text), pair with a logout hook that calls `sweepDrafts("draft:")` (or a narrower prefix) to clear all drafts on sign-out.
- **Draft key hygiene.** Every distinct form field needs a unique key. Prefer adding sub-ids over reusing a singleton key across entities — a singleton `draft:editor:body` key for a multi-entity editor will stomp edits when the user switches entities.

## Anti-Patterns

- **Clearing the draft before the server responds.** The original bug this pattern was extracted from. `setValue(""); await fetch(...)` has no answer for "what if fetch fails." The clear must be sequenced *after* a 2xx response. Anything else silently destroys typed work on every failure mode — slow networks, server crashes, 5xx responses — that is not caught by the UI's happy path.

- **One draft key for a list/detail form.** If you have a list of items and you edit one at a time, each item needs its own key (`draft:form:item:<id>`). A singleton key means switching items mid-edit stomps the draft for the first item, and reloading restores the wrong entity's content into the wrong entity's form.

- **Skipping `sweepDrafts` on list reload.** Drafts for deleted entities linger forever without garbage collection. Small at first; over months of use, hundreds of dead keys clutter DevTools and (rarely) hit quota. Run the sweep after every list fetch.

- **Using React state alone instead of localStorage.** React state is lost on reload. Draft persistence is specifically about surviving reload. If the pattern lives only in state, it doesn't protect against tab crashes, deploys, or the browser being closed and reopened — which is the main thing it's for.

- **Debouncing keystroke writes.** Tempting for performance; wrong for safety. localStorage writes are synchronous and sub-millisecond. Debouncing introduces a 200–500ms window where a crash loses the most recent typing — exactly the window the user notices. Write on every keystroke.

- **Writing the server-fetched value back into the draft.** The "draft" is the user's *divergence* from server state. If the draft always equals the server value, it's redundant at best and actively misleading at worst (it prevents `clearDraft`-on-ack from re-loading the server value on next mount, because the draft is always present). Save only when the user's input actually differs, or — simpler and less error-prone — save unconditionally on user input but *never* on fetch-then-initial-populate.

- **No try/catch around localStorage calls.** `setItem` throws in quota-exceeded, Safari private mode, and storage-disabled environments. Un-caught, this takes down the keystroke handler. The library wraps all calls; consumers should never add raw `localStorage.setItem` calls outside the library.

- **Relying on the server draft as a fallback.** A server-side draft collection is a different feature with different trade-offs (cross-device sync, explicit save endpoint, storage cost). It's not a replacement for local draft persistence — local is about round-trip-failure recovery, which is by definition a scenario where the server can't be reached. If you need both, the local draft takes precedence on load; a background sync pushes to the server draft when connectivity is available.

- **Storing non-string drafts without serialization.** The API is string-only by design. If the caller passes an object, it silently coerces to `"[object Object]"` and subsequent loads return that string unchanged — a latent bug that only surfaces when someone tries to use the draft. Consumers with compound state JSON-stringify explicitly.

## Logging

Not applicable at runtime (pure localStorage, no network, no handlers). If a consumer *does* want observability — e.g., a metric for "how often does a restored draft conflict with the server value" — the right place is the consumer, not the library.

For debugging: every draft is visible via DevTools → Application → Local Storage, keyed by the `draft:` prefix. The strings are stored verbatim (not escaped, not encoded), so a complex compound draft looks like formatted JSON when inspected. That's intentional.
