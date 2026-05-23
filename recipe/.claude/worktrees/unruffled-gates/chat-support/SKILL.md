---
name: chat-support
description: >
  Use when building any part of the in-app authenticated chat support system in this
  Expo Router + MongoDB stack. Covers the full feature end-to-end: org-scoped group chat,
  Ashley AI agent (Gemini-powered CSM), Ashley user bootstrap + org membership, prompt
  files and system directive, knowledge base compilation pipeline via prompt queue,
  Gemini context caching, conversation summaries, chat drawer UI, floating button with
  unread badge, participant chips, message bubbles with markdown/mention/URL rendering,
  per-message translation chip (show/hide toggle), translator dropdown with country flag
  emojis, read receipts, push notification fallback jobs, the admin flagged-message review
  page, and the admin prompt queue. Also covers the monthly `chat_YYYY_MM` collection
  rotation, lazy per-collection index creation with last-day-of-month proactive pre-
  creation, and inline rate limiting calculated live from messages (no separate
  `chat_rate_limit` table) with `rate_limited: true` stamped on the triggering message.
  Trigger on any mention of chat, messaging, Ashley, translation, translator, language
  selector, chips, prompt queue, knowledge base, admin queue, or chat rate limiting.
  For unauthenticated public-facing contact chat, see `public-contact-chat` instead.
---

# Chat Support System

A full in-app chat feature with three layers:

1. **Org Chat** — per-org group chat between all org members, persisted in MongoDB.
2. **Ashley Agent** — AI CSM (Gemini) that lives in the same thread, responds inline.
3. **Admin Surfaces** — flagged-message review page and prompt queue for KB management.

Reference implementation: `/frontend/` of this repo.

---

## Collections & Indexes

### `chat_YYYY_MM` — monthly rotated message collections

Chat messages are partitioned into one collection per month: `chat_2026_04`, `chat_2026_05`, etc. The same pattern the request log uses. One forever-growing `chat` collection works until it doesn't — monthly rotation keeps queries fast, makes old-data cleanup trivial, and confines rate-limit counting to at most two partitions.

```ts
{
  _id: ObjectId,
  organization_id: string,
  sender_type: "user" | "agent",
  sender_id: string,
  sender_name: string,          // snapshot at send time
  content: string,
  mentions?: Array<{ user_id: string; display_name: string }>,
  llm_log_id?: string,          // links agent replies to llm_logs
  feedback_vote?: "up" | "down" | null,
  admin_correctness?: "correct" | "incorrect" | null,
  flags?: Array<"sensitive" | "deflection" | "jailbreak" | "knowledge_gap">,
  sentiment?: "frustrated" | "neutral" | "positive",
  flag_reason?: string | null,
  resolved?: boolean,
  rate_limited?: boolean,       // stamped on the user message that tripped the limit
  created_at: Date,
}
```

Indexes created **lazily per collection**, cached in a `Set<string>` keyed on collection name:
```
{ organization_id: 1, created_at: -1 }
{ sender_id: 1, created_at: -1 }      // needed for rate-limit counting
{ sender_type: 1, created_at: -1 }
{ flags: 1 }
{ sentiment: 1 }
```

### Proactive last-day-of-month pre-creation

On the last UTC day of every month, fire-and-forget create next month's indexes. **Why:** the first message after midnight otherwise runs uncovered by any index, and the lazy race adds latency on a user-visible request.

### Deriving collection name from ObjectId

For single-message updates (feedback, resolve, translate), the collection is derivable from the ObjectId's embedded timestamp — no DB lookup:

```ts
export function chatCollectionNameFromId(id: string): string {
  const timestampSecs = parseInt(id.slice(0, 8), 16)
  return chatCollectionName(new Date(timestampSecs * 1000))
}
```

Use this in `feedback+api.ts`, `translate+api.ts`, `admin/chat/[id]/context+api.ts`, and `admin/chat/[id]/resolve+api.ts`.

### Admin listing across months

The `admin/chat+api.ts` flagged-message view queries multiple collections. Use `listChatCollections(db)` (lists all `chat_YYYY_MM` from `db.listCollections()`) when there's no date filter, or `chatCollectionNamesInRange(from, to)` to narrow the scan when a date range is set. Merge results, sort newest-first in memory, paginate with slice. Fine at admin-panel scale; add a materialized flagged-messages collection if it ever gets slow.

### `chat_read_receipts`
```ts
{ organization_id: string, user_id: string, last_read_message_id: string, updated_at: Date }
```
Index: `{ organization_id: 1, user_id: 1 }` unique

### `chat_translations`
```ts
{ message_id: string, target_language: string, translated_content: string,
  content_hash: string, source_language: string | null, created_at: Date }
```
Index: `{ message_id: 1, target_language: 1 }` unique; `{ content_hash: 1, target_language: 1 }`

### `chat_summaries`
Rolling conversation summary per org — Ashley reads this when the chat history exceeds `MAX_CHAT_CONTEXT_MESSAGES` (20).
```ts
{ organization_id: string, summary: string, updated_at: Date, created_at: Date }
```
Index: `{ organization_id: 1 }` unique

---

## Ashley's User Record (`lib/ashley.ts`)

Ashley is a real `users` document. Her user_id is derived deterministically from her email so it never changes across deploys.

```ts
export const ASHLEY_EMAIL = "ashley@goliathdynamics.com";
export const ASHLEY_DISPLAY_NAME = "Ashley Anderson";
export const ASHLEY_USER_ID = makeUserId(ASHLEY_EMAIL); // same hash fn used for all users
```

### `ensureAshley()` — idempotent upsert

Called lazily before the first LLM reply. Uses `$setOnInsert` so it never clobbers existing data.

```ts
export async function ensureAshley(): Promise<void> {
  const db = await getDb();
  const now = new Date();
  await db.collection("users").updateOne(
    { user_id: ASHLEY_USER_ID },
    {
      $setOnInsert: {
        user_id: ASHLEY_USER_ID,
        email: ASHLEY_EMAIL,
        display_name: ASHLEY_DISPLAY_NAME,
        title: "VP of Customer Success",
        profile_pic: "https://goliathinfluence.com/assets/img/ashley-anderson-thumb.png",
        role: "user",
        created_at: now,
        updated_at: now,
      },
    },
    { upsert: true }
  );
}
```

### GDI Org Membership

Ashley must be a member of Goliath Dynamics Inc. (GDI) — the parent company org. This is done once at bootstrap, not on every request. Query for the org by name and push her into `members[]` if not already present:

```ts
export async function ensureAshleyOrgMembership(): Promise<void> {
  const db = await getDb();
  const gdi = await db.collection("organizations").findOne({ name: "Goliath Dynamics Inc." });
  if (!gdi) return;

  const alreadyMember = (gdi.members || []).some((m: any) => m.user_id === ASHLEY_USER_ID);
  if (alreadyMember) return;

  await db.collection("organizations").updateOne(
    { _id: gdi._id },
    { $push: { members: { user_id: ASHLEY_USER_ID, role: "user" } } }
  );
}
```

Call `ensureAshleyOrgMembership()` from your seed/migration script or from server startup — not on every request.

---

## API Routes

All in `app/api/chat/`, all require `requireSession(request)`.

### `GET /api/chat/messages`
```
?organization_id=X[&before=<_id>][&after=<_id>]
```
- `before`: scroll-up pagination (older messages)
- `after`: polling for new messages
- Returns 50 messages + `read_receipts` + `profile_pics`
- Agent messages enriched with `feedback_vote` / `admin_correctness` from `llm_logs` at read time

### `POST /api/chat/messages`
```ts
Body: { organization_id: string, content: string, current_page?: string }
```
Flow:
1. Insert user message
2. Resolve @mentions via fuzzy match against org members + Ashley
3. Check `shouldTriggerAshley()` (see below)
4. If triggered: run sensitive gate → if blocked insert canned deflection, else call `generateAshleyReply()`
5. Fire-and-forget push notifications for both messages
6. Return `{ message, ashley_reply }`

### `POST /api/chat/read`
Upserts `chat_read_receipts` for the session user.

### `POST /api/chat/feedback`
Updates `feedback_vote` / `admin_correctness` on both `chat` message and linked `llm_logs` doc.

### `POST /api/chat/translate`
Batch translate with `chat_translations` cache. See Translation Chip section.

---

## Ashley Trigger Logic (`shouldTriggerAshley`)

Ashley responds when **any** of:
1. A `@mention` resolves to `ASHLEY_USER_ID`
2. The last Ashley message was flagged `"sensitive"` (re-engage to steer back)
3. Auto-respond: no other human has chatted in the last 5 minutes AND the message looks like a question (ends with `?`, starts with how/what/can/why/where/when/help/is /do )

## Rate Limiting (Live from Messages)

**No separate `chat_rate_limit` collection with TTL.** Calculate the limit inline by counting recent `sender_type: "user"` messages for this `sender_id` across the current + previous monthly collections:

```ts
const hourAgo = new Date(now.getTime() - 3_600_000)
const recentCount = await countRecentUserMessages(db, session.user_id, hourAgo)
if (recentCount >= RATE_LIMIT_PER_HOUR) {
  await db.collection(collName).updateOne(
    { _id: insertResult.insertedId },
    { $set: { rate_limited: true } },
  )
  // Insert Ashley's "I'm a bit swamped right now — I'll circle back shortly!"
  // and skip the LLM call
  return Response.json({ message: { ...savedMessage, rate_limited: true } })
}
```

Default: **20 user messages per hour**. Count spans current + previous month to handle the hour window straddling a month boundary.

### Why stamp `rate_limited: true` on the triggering message?

When reviewing abuse later, you want to see **which exact message tripped the limit**, not just that the user was limited at some point. This makes the abuse flow auditable with one query: `{ rate_limited: true }`. With a separate TTL collection, that signal is gone the moment the hour window lapses.

### Why not a `chat_rate_limit` TTL collection?

It looks cleaner, but:
- You lose the ability to tie the limit event to the specific message
- You have to join across collections to correlate spikes with content
- You maintain a second collection with its own index, backup surface, and cleanup path
- TTL indexes are approximate — messages may linger minutes past their window

Counting live is `O(recent-messages)` with an index on `{ sender_id: 1, created_at: -1 }` — in practice, well under 20 documents per query.

### Order of operations in POST

```
1. Insert the user's message into chat_YYYY_MM (always)
2. Determine if Ashley should respond (mention / auto-respond)
3. Run the sensitive gate — if blocked, insert deflection and return
4. Count recent user messages in current + previous month
5. Over the limit?
   → updateOne on the just-inserted message: $set { rate_limited: true }
   → insert Ashley's canned "swamped" reply
   → return WITHOUT enqueueing the LLM job
6. Otherwise render prompt, enqueue job, fire the worker
```

**Insert the message first, limit-check after.** Two reasons: (a) the count must include the new message, and (b) you want the record even for rate-limited users so abuse is auditable.

---

## Prompt Files (`frontend/prompts/`)

Three files — all portable across projects. The persona is the same; only the knowledge base changes.

### `prompts/ashley-system.md` — static system instruction

Used for Gemini context caching. Contains persona, rules, language handling, and JSON response format. No dynamic variables.

Key persona rules:
- Friendly, concise, professional — speaks like a real person, not a bot
- Never says "I'm an AI" or breaks character
- If she doesn't know: "Let me look into that with the team"
- Background: based in Orlando FL; loves Disney and paddle boarding; grew up in Florianópolis Brazil, speaks Portuguese (Brazilian dialect) and Spanish conversationally
- Topics tagged `[DEFLECT]` in the KB: acknowledge and defer, never commit
- Never promise refunds, credits, or contract concessions
- If recovering after a deflection/redirect, pick up warmly as if nothing happened

### Response JSON format (enforced in both prompt files):
```json
{
  "reply": "Your chat message to the user",
  "flags": [],
  "sentiment": "neutral",
  "flag_reason": null
}
```
- `flags`: zero or more of `"sensitive"`, `"deflection"`, `"jailbreak"`, `"knowledge_gap"`
  - `knowledge_gap` = she deferred because the KB doesn't cover it
- `sentiment`: `"frustrated"` | `"neutral"` | `"positive"` — reflects the **user's** mood
- `parseAshleyResponse()` strips markdown fences, parses JSON, validates enum values, falls back to treating raw text as `reply` with no flags

### `prompts/ashley-chat.md` — full inline fallback prompt

Used when Gemini context caching is unavailable. Includes the same persona + rules, plus:
```
{users} | {organization_name} | {organization_plan} | {visitor_current_page}
--- RECENT CHAT ---
{chat_recent}
--- DOCUMENTATION ---
{documentation}
```

### `prompts/ashley-compiler.md` — knowledge base compiler

Used by the prompt queue job to compile PRDs into the customer-facing KB. Takes:
- `{prds}` — raw internal PRD markdown
- `{existing_knowledge}` — current `rag/ashley-knowledge.md` contents

Rules: Q&A format only, customer perspective, strip internal details (schemas, routes, dev notes), merge duplicates, omit icebox features, preserve `[DEFLECT]` tags verbatim.

---

## Knowledge Base (`rag/ashley-knowledge.md`)

Ashley's only source of truth. Read server-side by `lib/chatDocs.ts` with a 5-minute in-memory TTL cache.

```ts
// lib/chatDocs.ts
export function readDocumentation(): string {
  // Reads rag/ashley-knowledge.md with 5-min TTL cache
  // Returns empty string if file missing (graceful fallback)
}
export function contentHash(content: string): string { /* MD5 */ }
```

### Rebuilding the Knowledge Base

The KB is compiled from the `agent/` PRD files using the compiler prompt. This is the main thing that changes across deployments of this system. The compilation job runs through the **admin prompt queue** — see `_recipes/admin-prompt-queue/SKILL.md` for the full queue pattern.

**Enqueue endpoint:** `POST /api/prompt-queue/enqueue`
- Reads all `agent/implemented/*.md` files
- Reads current `rag/ashley-knowledge.md` as `{existing_knowledge}`
- Snapshots both into `rendered_prompt` at enqueue time
- Worker calls Gemini with `prompts/ashley-compiler.md` template
- On success: writes result to `rag/ashley-knowledge.md` and calls `invalidateCache()`

**`[DEFLECT]` tags:** If an entry in the existing KB has `[DEFLECT]`, the compiler prompt preserves it verbatim. Add `[DEFLECT]` manually to topics that should defer to the team (pricing negotiations, legal questions, unreleased features).

---

## Gemini Context Caching (`lib/geminiCache.ts`)

Caches the static system instruction + knowledge base as a Gemini `cachedContent` resource to reduce token cost on every request.

```ts
export async function getOrCreateCache(systemInstruction: string): Promise<string | null>
```

- Cache TTL: 1 hour. Recreated 1 minute before expiry.
- Invalidated when `contentHash(documentation)` changes (KB was recompiled).
- Falls back gracefully to full inline prompt when caching fails.

Cached path: `buildDynamicContext()` — only org/user/page context + recent chat (small payload).
Fallback path: `buildAshleyPrompt()` — full prompt with KB inline.

Call `invalidateCache()` from `lib/geminiCache.ts` whenever the KB is rewritten.

---

## Conversation Summary (`chat_summaries` collection)

When the org's total message count exceeds `MAX_CHAT_CONTEXT_MESSAGES` (20), older messages fall off the context window. A rolling summary is maintained:

- `getConversationSummary(db, orgId)` — reads from `chat_summaries`
- `updateConversationSummary(db, orgId, droppedMessages, existingSummary)` — fire-and-forget Gemini call that extends the existing summary with newly-dropped messages
- Injected into `buildDynamicContext()` as `{conversation_summary}` between the system instruction and recent chat

---

## `generateAshleyReply` Flow

```
1. ensureAshley() — upsert user record
2. Fetch org (name, plan) + last 20 messages from current + previous month
3. If total messages > 20: load/update chat_summaries
4. Rate limit check: countRecentUserMessages(session.user_id, hourAgo)
   → over limit: stamp rate_limited:true on the user msg, insert canned "swamped", return
5. getOrCreateCache(systemInstruction) → cacheId | null
6. cacheId? → buildDynamicContext() : buildAshleyPrompt() (with full docs)
7. loggedLlmCall({ feature: "ashley-chat", model: "gemini-2.5-flash", ... })
8. parseAshleyResponse(raw) → { reply, flags, sentiment, flag_reason }
9. Insert agent chat message in current chat_YYYY_MM with llm_log_id, flags, sentiment, flag_reason
10. Return inserted message
```

---

## useChat Hook (`lib/useChat.ts`)

```ts
export function useChat({ organizationId, userId, enabled, chatLanguage }) {
  return {
    messages, loading, sending, error,
    hasMore,            // scroll-up pagination
    unreadCount,        // badge on FAB when closed
    unreadMention,      // red vs orange badge
    readReceipts,       // Record<userId, { display_name, last_read_message_id }>
    profilePics,        // Record<userId, avatarUrl>
    translations,       // Record<messageId, translatedText>
    sourceLangs,        // Record<messageId, langCode>
    sendMessage(content, currentPage?),
    loadMore(),
    refetch(),
    updateMessageFeedback(messageId, { feedback_vote?, admin_correctness? }),
  };
}
```

Polling: 5s when drawer open (new messages + read receipts); 5s when closed (unread count only).

---

## Chat Drawer UI (`components/Chat.tsx`)

### Floating Button (FAB)
Fixed bottom-right, `lightBlue500` background, `?` icon. Orange badge for unread; red badge for @mention (red takes priority).

### Drawer Layout (top → bottom)
1. Header row — "Chat" title + `<ChatLanguageSelector />`
2. Participant chip row — `<ParticipantList />` (always includes Ashley)
3. Push permission banner (if not granted)
4. Message list — ScrollView of `<MessageBubble />`, newest at bottom
5. Input bar — TextInput + send button (paper-plane icon)

### Message Bubble
- Current user: right-aligned, `lightBlue500` bg
- Others/Ashley: left-aligned, `blueGray100` bg, sender name above
- Ashley renders identically to human members — no bot indicator
- Agent messages with `llm_log_id`: thumbs up/down row (all users) + ✓/✗ (admin only)
- Translation chip below bubble when translation available

### Markdown rendering in messages
`renderContent()` handles bullet lists (`*`/`-`), **bold**, *italic*, @mention chips (highlighted inline), and tappable URLs.

### Read Receipts
Small avatars of other members who've read up to the current message. Posted via `POST /api/chat/read` on drawer open + foreground detection.

---

## Participant Chips

```tsx
// Always shows: current user + message senders + Ashley (always injected if absent)
// Capped at 8 participants
// Each chip: avatar (photo or initial) + first name
// Style: flexRow, gap 4, paddingH 8, paddingV 4, borderRadius 16, bg blueGray100
```

---

## Translator Dropdown with Flags (`lib/chatFlags.ts`)

```ts
export function flagForLang(code: string): string {
  // Detects visitor timezone once at module load
  // "en": 🇺🇸 for Americas, 🇬🇧 elsewhere
  // "pt": 🇧🇷 for Brazil/Americas, 🇵🇹 elsewhere
  // fallback: 🌐
}
```

14 supported languages: `en es fr de pt it zh ja ko ar hi ru vi tl`

`TRANSLATED_LABEL` — "Translated" in each target language (e.g., `es → "Traducido"`, `fr → "Traduit"`, `zh → "已翻译"`, `ja → "翻訳済み"`)

`ChatLanguageSelector` — in drawer header: flag + code + chevron → dropdown with backdrop Pressable for dismiss. `onChange` calls `PATCH /api/auth/me` with `{ chat_language: code }`.

---

## Translation Chip

Per-message chip below the bubble. Toggles `showOriginal` state.

```ts
const hasTranslation = !isCurrentUser
  && !!translatedContent
  && !!chatLanguage
  && translatedContent !== msg.content; // skip if message already in target language
```

Chip shows `${sourceFlag} ${TRANSLATED_LABEL[chatLanguage]}` (e.g., "🇪🇸 Traducido"). Web only: `title` prop provides native tooltip "Show original" / "Show translation".

Translation API (`POST /api/chat/translate`): check `chat_translations` cache by `(message_id, target_language)` first; then by `(content_hash, target_language)` for identical text with different `_id`; batch uncached messages into one `loggedLlmCall` (feature: `"chat-translation"`); write results with SHA-256 content hash.

---

## Push Notification Fallback

`chat_push_fallback` job created fire-and-forget after every message send. Scheduled 2 minutes out to give the recipient time to see the message without a notification.

```ts
await db.collection("jobs").insertOne({
  type: "chat_push_fallback",
  status: "pending",
  organization_id: orgId,
  scheduled_at: new Date(Date.now() + 2 * 60 * 1000),
  payload: { user_id: targetUserId, message_id: messageId, token: pushToken },
  created_at: new Date(),
});
```

---

## Admin Chat Page (`/admin-chat`)

Filterable review of flagged messages. `GET /api/admin/chat` requires `requireAdmin`.

Filters: flag category, sentiment, resolved, date range, org search (debounced 400ms). Returns 25/page (cursor-based) + `stats: { total_flagged, by_category, by_sentiment }`.

Flag colors: `sensitive` → red500, `deflection` → orange500, `jailbreak` → #7c3aed, `knowledge_gap` → lightBlue500.
Sentiment colors: `frustrated` → red500, `neutral` → blueGray400, `positive` → emerald500.

Row expand shows 5 messages before + flagged message + 5 after. Admins can toggle `resolved` (PATCH, optimistic UI).

---

## Admin Prompt Queue

Use the `admin-prompt-queue` recipe (`_recipes/admin-prompt-queue/SKILL.md`) for the full pattern. The primary use case here is the **knowledge base compilation job**:

- Universal queue page: `/admin-prompt-queue` with All/Active/Completed/Failed tabs and count badges
- Per-entity detail: KB compiler page with PRD list (editor) above compilation history
- `prompt_queue` collection — separate from `jobs` to avoid mixing with push fallback jobs
- Worker: `POST /api/prompt-queue/process+api.ts` protected by `x-job-secret`
- On job completion: write result to `rag/ashley-knowledge.md`, call `invalidateCache()`

---

## Anti-Patterns

- **Separate `chat_rate_limit` collection with TTL** — looks cleaner, costs you the ability to mark *which specific message* tripped the limit, and leaves abuse review with no audit trail once the TTL fires. Count live from the message collection and stamp `rate_limited: true` on the trigger.
- **Rate-limit check before the insert** — the count has to include the just-sent message, and you want the record on disk even for rate-limited users (abuse pattern forensics). Insert first, check second, stamp-and-return if over limit.
- **Single forever-growing `chat` collection** — fine at 10K messages, slow at 1M, painful to prune. Rotate monthly (`chat_YYYY_MM`), lazy-create indexes per collection, pre-create next month's on the last day.
- **Looking up message-by-id across every monthly collection** — ObjectIds embed the creation timestamp in the first 4 bytes. Parse it client-side (`parseInt(id.slice(0, 8), 16)`) to derive the exact collection name, then target it directly. No need for a range scan.
- **Admin counts endpoint as a single `countDocuments`** — with monthly collections you need to sum counts across all `chat_YYYY_MM`. `Promise.all` in parallel, then reduce. Cache if it ever gets expensive.
- **Waiting to create next month's indexes until the 1st** — the first user message after midnight otherwise runs uncovered. `isLastDayOfMonth(now)` check + fire-and-forget `ensureChatIndexes(nextMonth)` on every POST during the final day of the month.
- **Counting only the current month for rate limits** — the hour window straddles the month boundary four times per year. Query current + previous month and sum.
- **Assuming the prompt is pre-seeded in DB** — first-ever visitor on a fresh deploy hits an empty template and the LLM responds to raw user input with no system instructions. Lazy-upsert from an in-code seed constant inside the prompt renderer.
- **Silent rate-limit response** — a user who doesn't see a reply assumes the chat is broken and retries harder. Insert a friendly "I'm a bit swamped right now — I'll circle back shortly!" as an agent message so they see *something*.
- **Rate-limiting by agent replies instead of user messages** — you want to throttle the human spamming the chat, not the cost of Ashley's replies (those are already constrained by the trigger logic). Count `sender_type: "user"` messages.

## File Map

| File | Purpose |
|------|---------|
| `lib/ashley.ts` | `ASHLEY_USER_ID`, `ensureAshley()`, `ensureAshleyOrgMembership()` |
| `lib/ashleyPrompt.ts` | `buildAshleyPrompt()`, `buildDynamicContext()`, `loadSystemInstruction()` |
| `lib/chatDocs.ts` | `readDocumentation()` — 5-min cached read of `rag/ashley-knowledge.md` |
| `lib/geminiCache.ts` | `getOrCreateCache()`, `invalidateCache()` — Gemini context cache management |
| `lib/sensitiveGate.ts` | Pre-LLM keyword gate (Layer 1) |
| `lib/chatFlags.ts` | `flagForLang(code)` — timezone-aware flag emoji |
| `lib/useChat.ts` | React hook — messages, polling, translations, feedback |
| `components/Chat.tsx` | Full drawer UI: FAB, drawer, bubbles, chips, input |
| `prompts/ashley-system.md` | Static system instruction (persona + JSON format) — used for Gemini caching |
| `prompts/ashley-chat.md` | Full inline fallback prompt with all vars |
| `prompts/ashley-compiler.md` | KB compiler prompt (PRDs → Q&A knowledge base) |
| `rag/ashley-knowledge.md` | Compiled customer-facing knowledge base (Q&A format) |
| `app/api/chat/messages+api.ts` | GET (load) + POST (send + trigger Ashley) |
| `app/api/chat/read+api.ts` | POST — mark read receipts |
| `app/api/chat/translate+api.ts` | POST — batch translate with cache |
| `app/api/chat/feedback+api.ts` | POST — feedback + admin correctness |
| `app/api/admin/chat+api.ts` | GET — flagged messages for admin review |
| `app/(app)/admin-chat.tsx` | Admin flagged-message review page |
| `app/(app)/account.tsx` | Language preference chip grid |
| `lib/chatCollections.ts` | `chatCollectionName(date)`, `chatCollectionNameFromId(id)`, `ensureChatIndexes(db, collName)` (lazy + cached), `maybePreCreateNextMonth(db, now)`, `listChatCollections(db)`, `chatCollectionNamesInRange(from, to)`, `isLastDayOfMonth(date)` |
| `lib/db.ts` | Global indexes for `chat_read_receipts`, `chat_translations`, `chat_summaries` (message collections are lazy per-month) |
