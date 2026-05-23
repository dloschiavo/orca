---
name: chat-support
description: >
  Use when building any part of the in-app authenticated chat support system.
  Works with both the Expo Router +api.ts (TypeScript/Gemini) stack and the
  FastAPI/Python (Motor/Claude) variant. Covers the full feature end-to-end:
  org-scoped group chat, Ashley AI agent, Ashley user bootstrap + org membership,
  prompt files and system directive, knowledge base compilation pipeline via prompt
  queue, context caching (Gemini) or inline prompt (Claude), conversation summaries,
  chat drawer UI, floating button with unread badge, participant chips, message
  bubbles with markdown/mention/URL rendering, per-message translation chip
  (show/hide toggle), translator dropdown with country flag emojis, read receipts,
  and push notification fallback jobs. Wires the In-app tab into the shared
  `admin-chat` review surface (with Ashley's `ashley-compiler` Compile KB
  config), and uses `admin-prompt-queue` for the KB compilation worker. Also
  covers the monthly `chat_YYYY_MM` collection rotation, lazy per-collection
  index creation with last-day-of-month proactive pre-creation, and inline
  rate limiting calculated live from messages (no separate `chat_rate_limit`
  table) with `rate_limited: true` stamped on the triggering message. Trigger
  on any mention of chat, messaging, Ashley, translation, translator, language
  selector, chips, knowledge base, or chat rate limiting. For unauthenticated
  public-facing contact chat, see `public-contact-chat`. For the admin
  flagged-message review page itself, see `admin-chat`.
dependencies:
  requires: [admin-chat, admin-prompt-queue]
  capabilities:
    auth: otp-auth
    tenancy: multi-tenant
    design-system: admin-only-notus
---

# Chat Support System

A full in-app chat feature with two layers:

1. **Org Chat** — per-org group chat between all org members, persisted in MongoDB.
2. **Ashley Agent** — AI CSM (Gemini) that lives in the same thread, responds inline.

The admin flagged-message review page is **not** part of this recipe — it lives in `admin-chat`. This recipe registers the **In-app tab** of `admin-chat` (collection prefix `chat_`, schema adapter for `chat_YYYY_MM` documents, org-search filter, and the Ashley `kbCompile` config). The KB-compilation worker is provided by `admin-prompt-queue`.

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

Use this in `feedback+api.ts` and `translate+api.ts` for in-app message updates. (The admin-review side `platform/chat/[id]` resolve PATCH derives the same way, but lives in the `admin-chat` recipe.)

### Admin cross-month listing

The flagged-message review surface lives in the `admin-chat` recipe and uses its generic `listCollectionsByPrefix(db, 'chat_')` and `collectionNamesInRange('chat_', from, to)` helpers. This recipe just needs to make sure `chat_YYYY_MM` is queryable through the schema adapter it contributes to `ADMIN_CHAT_TABS`.

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

## Prompts — DB-Backed via `lib/promptLoader.ts`

**Every prompt the system uses lives in the `prompts` MongoDB collection and is loaded through `loadPrompt(slug)`.** The disk files in `prompts/*.md` are *seed* files only — read once on first miss, upserted into the collection, and never read again. After that, the DB row is authoritative and admins edit it through the Prompts admin page (`/platform/prompts`).

This includes the compiler prompt. There is no special-cased "compiler lives on disk" path — `ashley-compiler` is just another row in the same collection, edited through the same UI, versioned the same way.

### `lib/promptLoader.ts`

```ts
export async function loadPrompt(slug: string): Promise<string>
export function invalidatePromptCache(slug?: string): void
```

- 5-second in-memory TTL cache (slug → body).
- Cache miss → query `prompts` collection.
- DB miss → read seed from `prompts/{slug}.md`, upsert with one initial version, return.
- Neither DB row nor seed file → throws. (A new prompt the system depends on must ship with a seed file.)
- `PUT /api/prompts/[slug]` and `DELETE /api/prompts/[slug]` both call `invalidatePromptCache(slug)` after the write so the next request sees the new body immediately.

**Consumer pattern:**
```ts
// lib/ashleyPrompt.ts
import { loadPrompt } from "@/lib/promptLoader";
export async function buildAshleyPrompt(ctx) {
  const template = await loadPrompt("ashley-chat");
  return template
    .replace("{users}", ctx.users)
    .replace("{documentation}", ctx.documentation)
    // ...
}
```

Every prompt builder is async because of this. Routes that call them must `await`.

### `prompts/ashley-system.md` — static system instruction (seed)

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

### `prompts/ashley-chat.md` — full inline fallback prompt (seed)

Used when Gemini context caching is unavailable. Includes the same persona + rules, plus:
```
{users} | {organization_name} | {organization_plan} | {visitor_current_page}
--- RECENT CHAT ---
{chat_recent}
--- DOCUMENTATION ---
{documentation}
```

### `prompts/ashley-compiler.md` — knowledge base compiler (seed)

Loaded via `loadPrompt("ashley-compiler")` by the enqueue route. **Edit it through the Prompts admin page like everything else** — do not read it from disk, do not special-case it. Used by the prompt queue job to compile PRDs into the customer-facing KB. Takes:
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

**The "Compile KB" button lives on the admin Chat page (`/platform/chat`), not on the Prompts page.** It's the natural follow-up to triaging `knowledge_gap`-flagged messages — admin sees a gap, fixes the PRD, clicks Compile KB right there. Putting it on the queue page would force a context switch every time. The Prompts page is for editing prompt bodies and watching the queue, not for triggering jobs.

**Enqueue endpoint:** `POST /api/prompt-queue/enqueue`
- Reads all `agent/implemented/*.md` files
- Reads current `rag/ashley-knowledge.md` as `{existing_knowledge}`
- Loads the compiler template via `loadPrompt("ashley-compiler")` (DB-backed, lazy-seeds from disk on first deploy)
- Snapshots PRDs + existing KB + rendered prompt at enqueue time
- Worker calls Gemini with the snapshotted `rendered_prompt`
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
5. Input bar — TextInput + send button (paper-plane icon). **MUST use the canonical Notus form input styling — see § Input Bar Styling below.**

### Input Bar Styling — match the rest of the app

**This is the single most-violated rule in the chat skill.** Every prior implementation reached for `rounded-full px-4 py-2` "messenger-style" pills. That is wrong. The chat textarea is a form input like every other input in the app and MUST look like one. If you find yourself styling it differently from the inputs on the admin user form or the org settings page, stop.

**Canonical styling — copy this exactly:**
```tsx
<TextInput
  ref={inputRef}
  value={draft}
  onChangeText={setDraft}
  onSubmitEditing={send}
  placeholder="Type a message…"
  placeholderTextColor="#94a3b8"
  multiline
  className="flex-1 bg-blueGray-50 border border-blueGray-200 rounded px-3 py-2 text-sm text-blueGray-700"
/>
<TouchableOpacity
  onPress={send}
  disabled={!draft.trim() || sending}
  className="bg-lightBlue-500 active:bg-lightBlue-600 rounded px-3 py-2 ml-2"
>
  <FontAwesome5 name="paper-plane" size={14} color="#fff" solid />
</TouchableOpacity>
```

**Required:**
- `bg-blueGray-50` background (NOT white, NOT gray-100)
- `border border-blueGray-200` (NOT borderless, NOT a dark border)
- `rounded` — the standard 4px corner (NOT `rounded-full`, NOT `rounded-lg`, NOT `rounded-2xl`)
- `px-3 py-2` padding (NOT `px-4 py-2`, NOT `px-4 py-3`)
- `text-sm text-blueGray-700` (NOT `text-base`, NOT plain `text-gray-700`)
- `placeholderTextColor="#94a3b8"` — set as a prop, not via Tailwind. RN's `placeholder-*` classes don't reliably take on web.
- Send button uses `bg-lightBlue-500` (the primary button color), `rounded` to match the input, and `<FontAwesome5 name="paper-plane" />` — never an emoji, never a chevron.

**Forbidden:**
- ❌ `rounded-full px-4 py-2` "messenger pill"
- ❌ `bg-white` or `bg-gray-100` background
- ❌ Plain `text-gray-*` (must be `text-blueGray-*`)
- ❌ Hex colors anywhere except `placeholderTextColor`
- ❌ Inline `style={{ ... }}` for padding/border/colors
- ❌ Send button as `<Text>➤</Text>` or any emoji

**Why this matters:** the chat drawer is the most prominent piece of UI in the app. When its input doesn't match the inputs on every other screen, the whole product feels stitched together from different apps. See `admin-only-notus/SKILL.md § Chat Textarea — Stop Reinventing It` for the full design-system rationale.

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

### Drawer UX: click-outside-to-close + focus-on-open

These two refinements apply to any drawer the user can open from multiple entry points (FAB, header, footer link). They are shared with `public-contact-chat`; see that skill for deeper rationale.

**Focus input on open:**
```tsx
const inputRef = useRef<TextInput>(null);
useEffect(() => {
  if (!open || Platform.OS !== 'web') return;
  const t = setTimeout(() => inputRef.current?.focus?.(), 50);
  return () => clearTimeout(t);
}, [open]);
```
Without it, users click the FAB, see the drawer, then click again into the input — the second click is enough friction that some bounce back to what they were doing. 50ms delay lets the mount animation settle so Safari doesn't scroll weirdly.

**Click-outside-to-close:**
```tsx
const drawerRef = useRef<View>(null);
useEffect(() => {
  if (!open || Platform.OS !== 'web') return;
  const handler = (e: MouseEvent) => {
    const node: any = drawerRef.current;
    const dom = node && (node.nodeType ? node : node._node || node);
    if (dom && dom.contains && dom.contains(e.target)) return;
    setOpen(false);
  };
  const attachT = setTimeout(() => document.addEventListener('mousedown', handler), 0);
  return () => {
    clearTimeout(attachT);
    document.removeEventListener('mousedown', handler);
  };
}, [open]);
```

Two non-obvious details (same as public-contact-chat):
- **Unwrap `node._node || node`.** RN Web refs may be a wrapper object or a host DOM element; `.contains()` throws on the wrapper. Unwrap defensively.
- **Defer the `addEventListener` with `setTimeout(0)`.** The click that opened the drawer bubbles to `document` *after* your effect runs, so a synchronously-attached handler sees the opening click as outside-click and closes immediately.

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

### Dropdown clipping inside the drawer (overflow: hidden gotcha)

The drawer uses `overflow: 'hidden'` so its rounded corners and shadow render correctly. That clip propagates: any `position: absolute` child rendered outside the drawer's content rect — including the language dropdown that opens below the header — gets sliced off on the right and bottom.

The reflex fix is to hoist the dropdown into a portal or to drop the drawer's `overflow: hidden`. Both have downsides: RN Web has no first-class portals, and dropping overflow breaks the rounded corners. The cleaner pattern is to render the dropdown with `position: 'fixed'` and measure the trigger to anchor it in viewport coordinates:

```tsx
const triggerRef = useRef(null);
const [anchor, setAnchor] = useState(null);

const handleToggle = () => {
  if (open) { setOpen(false); return; }
  if (Platform.OS === 'web' && triggerRef.current) {
    const rect = triggerRef.current.getBoundingClientRect();
    setAnchor({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
  }
  setOpen(true);
};

// trigger:
<Pressable ref={triggerRef} onPress={handleToggle} ... />

// dropdown — note position: 'fixed' (escapes the clip) + zIndex above the drawer:
{open && anchor && (
  <View style={{ position: 'fixed', top: anchor.top, right: anchor.right, zIndex: 10001, ... }}>
    ...
  </View>
)}
```

The drawer itself sits at `zIndex: 9999`, so the dropdown's backdrop and panel layer at `10000` / `10001` to sit above it. Guard rendering on `open && anchor` so a stale measurement from a previous open doesn't render off-screen after a window resize — the next open re-measures.

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

## Admin Chat Tab Registration

The admin flagged-message review surface is owned by the `admin-chat` recipe. This recipe contributes the **In-app tab** to its registry. All page layout, filter UI, badge colors, cross-month query, row expand, and resolved-toggle behavior is defined by `admin-chat` — do not re-implement any of it here.

```ts
// lib/chat/adminTab.ts — registered in lib/adminChat/tabs.ts
import type { AdminChatTab } from '@/lib/adminChat/types'
import { chatSchemaAdapter } from './chatSchemaAdapter'
import { invalidateCache } from '@/lib/geminiCache'
import fs from 'fs/promises'

export const CHAT_TAB: AdminChatTab = {
  key: 'chat',
  label: 'In-app',
  collectionPrefix: 'chat_',
  schema: chatSchemaAdapter,
  filters: [{ kind: 'text', key: 'org_search', label: 'Org', debounceMs: 400 }],
  kbCompile: {
    promptSlug: 'ashley-compiler',
    outputPath: 'rag/ashley-knowledge.md',
    onComplete: async ({ content }) => {
      await fs.writeFile('rag/ashley-knowledge.md', content)
      await invalidateCache() // Gemini context cache
    },
  },
}
```

The schema adapter (`chatSchemaAdapter`) maps a `chat_YYYY_MM` document into the `FlaggedRow` shape that `admin-chat`'s table consumes:

- `sender_label` → `'User: {email} ({org_slug})'` for `sender_type === 'user'`, `'Ashley'` for the agent
- `buildQuery(filters)` → translates `org_search` into either an exact `organization_id` match or an org-slug lookup, then adds the shared flag/sentiment/resolved/date filters
- `resolveTarget(rowId)` → derives `chat_YYYY_MM` from the ObjectId timestamp via `chatCollectionNameFromId(rowId)`

The KB compile callback registration (the `onComplete` body above) is wired into `admin-prompt-queue`'s `onJobComplete('ashley-compiler', …)` hook at install time.

---

## Knowledge Base Compilation

Ashley's customer-facing knowledge base (`rag/ashley-knowledge.md`) is compiled from PRDs by the **`ashley-compiler`** prompt, run as a job through `admin-prompt-queue`. The queue page itself, the worker (`POST /api/prompt-queue/process+api.ts`), the prompt manager, and the per-entity history view all live in `admin-prompt-queue` — see that recipe for the full pattern.

This recipe contributes:

- The **`ashley-compiler` prompt seed** (`prompts/ashley-compiler.md`) — loaded via `loadPrompt("ashley-compiler")` like every other prompt; not special-cased.
- The **`onJobComplete('ashley-compiler', …)` handler** that writes the result to `rag/ashley-knowledge.md` and calls `invalidateCache()` to bust the Gemini context cache.
- The **`kbCompile` config** registered through `admin-chat`'s `CHAT_TAB.kbCompile` (see § Admin Chat Tab Registration above) — this is what surfaces the **Compile KB** button in the right side of the In-app tab header on `/platform/chat`.

---

## Anti-Patterns

- **Separate `chat_rate_limit` collection with TTL** — looks cleaner, costs you the ability to mark *which specific message* tripped the limit, and leaves abuse review with no audit trail once the TTL fires. Count live from the message collection and stamp `rate_limited: true` on the trigger.
- **Rate-limit check before the insert** — the count has to include the just-sent message, and you want the record on disk even for rate-limited users (abuse pattern forensics). Insert first, check second, stamp-and-return if over limit.
- **Single forever-growing `chat` collection** — fine at 10K messages, slow at 1M, painful to prune. Rotate monthly (`chat_YYYY_MM`), lazy-create indexes per collection, pre-create next month's on the last day.
- **Looking up message-by-id across every monthly collection** — ObjectIds embed the creation timestamp in the first 4 bytes. Parse it client-side (`parseInt(id.slice(0, 8), 16)`) to derive the exact collection name, then target it directly. No need for a range scan.
- **Waiting to create next month's indexes until the 1st** — the first user message after midnight otherwise runs uncovered. `isLastDayOfMonth(now)` check + fire-and-forget `ensureChatIndexes(nextMonth)` on every POST during the final day of the month.
- **Counting only the current month for rate limits** — the hour window straddles the month boundary four times per year. Query current + previous month and sum.
- **Reading prompts from disk in route handlers** — `fs.readFileSync("prompts/ashley-chat.md")` scattered across consumers means admins editing the prompt in the UI don't actually change runtime behavior, and the compiler prompt mysteriously "lives somewhere" that the Prompts page can't see. Funnel everything through `loadPrompt(slug)`. The disk file is a *seed*, not the source of truth.
- **Special-casing the compiler prompt** — there is no reason `ashley-compiler` should live anywhere different from `ashley-chat` or `ashley-system`. Same collection, same loader, same admin UI, same versioning. If you find yourself writing "this prompt is loaded directly from disk because…", stop.
- **Assuming the prompt row exists on a fresh deploy** — first-ever visitor on a brand-new install hits an empty `prompts` collection and the LLM responds to raw user input with no system instructions. `loadPrompt` solves this by lazy-upserting from `prompts/{slug}.md` on the first miss; just make sure every slug the system needs has a seed file in the repo.
- **Forgetting to invalidate the prompt cache on update** — `loadPrompt` has a 5s TTL, so an admin editing a prompt waits up to 5s to see their change take effect *and* every concurrent request in that window still uses the stale body. `PUT /api/prompts/[slug]` and `DELETE /api/prompts/[slug]` must call `invalidatePromptCache(slug)` after the write.
- **Silent rate-limit response** — a user who doesn't see a reply assumes the chat is broken and retries harder. Insert a friendly "I'm a bit swamped right now — I'll circle back shortly!" as an agent message so they see *something*.
- **Rate-limiting by agent replies instead of user messages** — you want to throttle the human spamming the chat, not the cost of Ashley's replies (those are already constrained by the trigger logic). Count `sender_type: "user"` messages.
- **No focus-on-open for the drawer input** — FAB-click-then-input-click is two actions where there should be one. `useEffect` on `open` + `setTimeout(50)` + `inputRef.current.focus()`.
- **Click-outside listener attached synchronously** — the same click that opened the drawer then closes it. Wrap `addEventListener('mousedown', handler)` in `setTimeout(0)` so the opening click has already finished bubbling.
- **`.contains()` throwing on an RN Web ref** — the ref may be a wrapper object, not the DOM node. Unwrap: `node.nodeType ? node : node._node || node`.
- **`position: 'absolute'` dropdown inside a drawer with `overflow: 'hidden'`** — the clip propagates and slices the dropdown off. Don't drop the drawer's overflow (it's there for the rounded corners) and don't reach for portals (RN Web has no first-class portal). Measure the trigger with `getBoundingClientRect()` and render the dropdown `position: 'fixed'` with the resulting top/right.

## File Map (Expo Router / TypeScript)

| File | Purpose |
|------|---------|
| `lib/ashley.ts` | `ASHLEY_USER_ID`, `ensureAshley()`, `ensureAshleyOrgMembership()` |
| `lib/promptLoader.ts` | `loadPrompt(slug)` — DB-backed prompt loader with 5s cache + lazy disk seed; `invalidatePromptCache(slug?)` |
| `lib/ashleyPrompt.ts` | `buildAshleyPrompt()`, `buildDynamicContext()`, `loadSystemInstruction()` — all async, all go through `loadPrompt()` |
| `lib/chatDocs.ts` | `readDocumentation()` — 5-min cached read of `rag/ashley-knowledge.md` |
| `lib/geminiCache.ts` | `getOrCreateCache()`, `invalidateCache()` — Gemini context cache management |
| `lib/sensitiveGate.ts` | Pre-LLM keyword gate (Layer 1) |
| `lib/chatFlags.ts` | `flagForLang(code)` — timezone-aware flag emoji |
| `lib/useChat.ts` | React hook — messages, polling, translations, feedback |
| `components/Chat.tsx` | Full drawer UI: FAB, drawer, bubbles, chips, input |
| `prompts/ashley-system.md` | **Seed** for `prompts` collection slug `ashley-system` — static system instruction (persona + JSON format), used for Gemini caching |
| `prompts/ashley-chat.md` | **Seed** for slug `ashley-chat` — full inline fallback prompt with all vars |
| `prompts/ashley-compiler.md` | **Seed** for slug `ashley-compiler` — KB compiler prompt (PRDs → Q&A knowledge base). Edited via Prompts admin page like every other prompt. |
| `rag/ashley-knowledge.md` | Compiled customer-facing knowledge base (Q&A format) |
| `app/api/chat/messages+api.ts` | GET (load) + POST (send + trigger Ashley) |
| `app/api/chat/read+api.ts` | POST — mark read receipts |
| `app/api/chat/translate+api.ts` | POST — batch translate with cache |
| `app/api/chat/feedback+api.ts` | POST — feedback + admin correctness |
| `app/(app)/account.tsx` | Language preference chip grid |
| `lib/chat/adminTab.ts` | `CHAT_TAB: AdminChatTab` — registered in `lib/adminChat/tabs.ts` |
| `lib/chat/chatSchemaAdapter.ts` | `chatSchemaAdapter` — maps `chat_YYYY_MM` doc → `FlaggedRow` for admin-chat |
| `lib/chat/onCompileComplete.ts` | `onJobComplete('ashley-compiler', …)` registration — writes KB file + busts Gemini cache |
| `lib/chatCollections.ts` | `chatCollectionName(date)`, `chatCollectionNameFromId(id)`, `ensureChatIndexes(db, collName)` (lazy + cached), `maybePreCreateNextMonth(db, now)`, `isLastDayOfMonth(date)`. Cross-month listing helpers live in `admin-chat`. |
| `lib/db.ts` | Global indexes for `chat_read_receipts`, `chat_translations`, `chat_summaries` (message collections are lazy per-month) |

---

## FastAPI / Python Variant

When the backend is FastAPI + Motor (async pymongo) instead of Expo Router `+api.ts`, the same architecture applies with these adaptations. All collection schemas, indexes, monthly rotation, rate limiting, and UI components are identical — only the server-side file layout and runtime patterns change.

Reference implementation: `influencer-studio/twp.react/`.

### Key Differences

| Concern | Expo Router (TS) | FastAPI (Python) |
|---------|-------------------|-------------------|
| API layer | `app/api/chat/*+api.ts` (one file per endpoint) | `api/routers/chat.py` (single router file, all endpoints) |
| Server libs | `lib/*.ts` | `api/lib/*.py` |
| DB driver | native `mongodb` (MongoClient) | Motor (async pymongo) — `AsyncIOMotorClient` |
| LLM | Gemini (`@google/generative-ai`) | Anthropic Claude (`anthropic` Python SDK) |
| Context caching | Gemini `cachedContent` with TTL + hash invalidation | Not applicable — Claude uses inline prompt only |
| Background work | Enqueue to `prompt_queue` + worker process | `FastAPI.BackgroundTasks` — fire-and-forget within the same process |
| Org membership | Embedded `members[]` array in `organizations` doc | Separate `org_members` collection (join by `org_id` + `user_id`) |
| Session middleware | `requireSession(request)` throws `Error("Unauthorized")` | `require_session(request)` raises `PermissionError("Unauthorized")` |
| Auth helpers | `lib/auth.ts` — JS/TS | `api/lib/auth.py` — Python, `@dataclass AuthSession` |

### BackgroundTasks Instead of Worker Queue

FastAPI's `BackgroundTasks` replaces the separate worker process for Ashley's LLM reply. The task runs in the same event loop after the response is sent — lightweight and sufficient for a single-box deployment:

```python
from fastapi import BackgroundTasks

@router.post("/messages")
async def send_message(body: ..., request: Request, bg: BackgroundTasks):
    # ... insert message, check trigger ...
    if should_trigger:
        bg.add_task(_generate_ashley_reply, org_id, message_id, session)
    return {"message": saved_message}

async def _generate_ashley_reply(org_id, trigger_msg_id, session):
    """Runs after the response is sent. No queue, no worker process."""
    await ensure_ashley()
    # ... fetch context, build prompt, call Claude, insert reply ...
```

**When to promote to a real queue:** if you need retry logic, dead-letter inspection, or run on multiple boxes. For a single-box deployment serving <1K messages/day, `BackgroundTasks` is correct.

### Claude Instead of Gemini

No context caching — the full system instruction + knowledge base is always sent inline as the system prompt. This simplifies the architecture (no `geminiCache.ts` equivalent, no cache TTL management) at the cost of slightly higher token usage per request:

```python
import anthropic

client = anthropic.AsyncAnthropic()

response = await client.messages.create(
    model="claude-sonnet-4-20250514",
    max_tokens=1024,
    system=system_prompt,  # full ashley-chat.md with KB inline
    messages=[{"role": "user", "content": chat_recent}],
)
raw = response.content[0].text
parsed = _parse_ashley_response(raw)
```

The `_parse_ashley_response()` function is identical to the TS version: strip markdown fences, parse JSON, validate enum values, fall back to treating raw text as `reply` with no flags.

### Org Membership via Separate Collection

Instead of an embedded `members[]` array on the `organizations` document, the Python variant uses a separate `org_members` collection. This affects Ashley's org membership bootstrap and the org lookup endpoint:

```python
# lib/ashley.py — separate collection, not $push into embedded array
async def ensure_ashley_org_membership(org_id: str):
    db = get_db()
    existing = await db["org_members"].find_one({
        "org_id": org_id, "user_id": ASHLEY_USER_ID,
    })
    if existing:
        return
    await db["org_members"].insert_one({
        "org_id": org_id,
        "user_id": ASHLEY_USER_ID,
        "role": "user",
        "joined_at": datetime.now(timezone.utc),
    })
```

```python
# GET /api/chat/org — discover user's org from org_members
membership = await db["org_members"].find_one({"user_id": session.user_id})
if not membership:
    return JSONResponse({"organization_id": None})
org = await db["organizations"].find_one({"_id": ObjectId(membership["org_id"])})
```

### Motor Async Patterns

Motor is async pymongo — same API surface as pymongo but with `await`. Key patterns that differ from the TS driver:

```python
# Parallel index creation — asyncio.gather, not Promise.all
await asyncio.gather(
    col.create_index([("organization_id", 1), ("created_at", -1)]),
    col.create_index([("sender_id", 1), ("created_at", -1)]),
    col.create_index([("sender_type", 1), ("created_at", -1)]),
)

# Cursor iteration — async for, not .toArray()
messages = []
cursor = col.find(query).sort("created_at", -1).limit(50)
async for doc in cursor:
    messages.append(doc)

# Fire-and-forget task — asyncio.create_task, not void promise
asyncio.create_task(ensure_chat_indexes(next_month_name))

# ObjectId handling — bson.ObjectId, imported from pymongo's bson
from bson import ObjectId
doc = await col.find_one({"_id": ObjectId(message_id)})
```

### Single Router File

All chat endpoints (`GET /messages`, `POST /messages`, `POST /read`, `POST /feedback`, `POST /translate`) live in one `routers/chat.py` with a shared `APIRouter(prefix="/chat")`. The admin flagged-message router (`routers/admin_chat.py`) lives in the `admin-chat` recipe, not here. This is more natural in FastAPI than splitting every endpoint into its own file:

```python
# api/routers/chat.py
router = APIRouter(prefix="/chat", tags=["chat"])

@router.get("/org")
async def get_org(request: Request): ...

@router.get("/messages")
async def get_messages(request: Request, organization_id: str, ...): ...

@router.post("/messages")
async def send_message(body: SendMessageIn, request: Request, bg: BackgroundTasks): ...

@router.post("/read")
async def mark_read(body: MarkReadIn, request: Request): ...

@router.post("/feedback")
async def submit_feedback(body: FeedbackIn, request: Request): ...

@router.post("/translate")
async def translate_messages(body: TranslateIn, request: Request): ...
```

### File Map (FastAPI / Python)

| File | Purpose |
|------|---------|
| `api/lib/ashley.py` | `ASHLEY_USER_ID`, `ensure_ashley()`, `ensure_ashley_org_membership()`, `should_trigger_ashley()` |
| `api/lib/ashley_prompt.py` | `build_ashley_prompt()`, `format_chat_history()`, `load_system_instruction()` |
| `api/lib/chat_docs.py` | `read_documentation()` — 5-min cached read of `rag/ashley-knowledge.md` |
| `api/lib/chat_collections.py` | `chat_collection_name()`, `chat_collection_name_from_id()`, `ensure_chat_indexes()` (lazy + cached), `maybe_precreate_next_month()`. Cross-month listing helpers live in `admin-chat`. |
| `api/lib/sensitive_gate.py` | `check_sensitive()` — pre-LLM regex gate, shared with public-contact-chat |
| `api/lib/chat/admin_tab.py` | `CHAT_TAB: AdminChatTab` registration + `chatSchemaAdapter` for `admin-chat` |
| `api/routers/chat.py` | All chat endpoints: org, messages, read, feedback, translate + `_generate_ashley_reply()` background task |
| `api/database.py` | Motor client singleton + global indexes for `chat_read_receipts`, `chat_translations`, `chat_summaries` |
| `api/main.py` | FastAPI app — includes `chat` router (the `admin_chat` router lives in the `admin-chat` recipe) |
| `prompts/ashley-system.md` | Static system instruction (persona + JSON format) |
| `prompts/ashley-chat.md` | Full inline prompt with all context variables |
| `rag/ashley-knowledge.md` | Compiled customer-facing knowledge base |
| `app/src/lib/chatFlags.js` | `flagForLang(code)` — timezone-aware flag emoji (JS, same as TS version) |
| `app/src/hooks/useChat.js` | React hook — messages, polling, translations, feedback |
| `app/components/Chat.jsx` | Full drawer UI: FAB, drawer, bubbles, chips, input |

### Prompt File Location

In the Expo Router variant, prompt files live under the Expo app directory. In the FastAPI variant they live alongside the `api/` directory at the same level:

```
twp.react/
  api/
    routers/
    lib/
    main.py
  prompts/           ←  prompt markdown files
    ashley-system.md
    ashley-chat.md
  rag/               ←  knowledge base
    ashley-knowledge.md
  app/               ←  Expo frontend (unchanged)
    components/
    src/hooks/
    src/lib/
```

The prompt reader resolves paths relative to the `api/` directory: `os.path.join(os.path.dirname(os.path.dirname(__file__)), "prompts")`.

### Conversation Summary (Python)

Same pattern as TS — rolling summary in `chat_summaries`, updated as a background task when the context window exceeds `MAX_CHAT_CONTEXT_MESSAGES`:

```python
async def _update_conversation_summary(org_id: str, dropped: list[dict], existing: str):
    """Fire-and-forget — extends rolling summary with newly-dropped messages."""
    prompt = f"Extend this conversation summary...\n\nExisting: {existing}\n\nNew messages:\n{format_chat_history(dropped)}"
    response = await client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=512,
        messages=[{"role": "user", "content": prompt}],
    )
    summary = response.content[0].text
    db = get_db()
    await db["chat_summaries"].update_one(
        {"organization_id": org_id},
        {"$set": {"summary": summary, "updated_at": datetime.now(timezone.utc)},
         "$setOnInsert": {"created_at": datetime.now(timezone.utc)}},
        upsert=True,
    )
```
