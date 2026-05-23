---
name: public-contact-chat
description: >
  Use when building an unauthenticated public-facing contact chat widget with a
  persona-driven AI agent. Covers monthly collection rotation, fingerprint-based
  bot detection with no-LLM fallback path, inline (separate-table-free) rate
  limiting, session-based visitor grouping, 30-second idle re-engagement frames,
  pre-generated welcome bubbles (no LLM hit on drawer open), typing indicator
  delay tuning, and lazy prompt seeding.
---

# Public Contact Chat

A floating contact widget that lets an anonymous website visitor chat with a branded AI persona without signing up, logging in, or filling out a form. The key insight is that **three response paths** share one collection — real visitor → LLM, no-fingerprint → canned bot reply, rate-limited → canned bot reply — so suspected bots never touch your LLM budget, and the LLM path still feels human through small delays, pre-generated openers, and idle re-engagement.

Reference implementation: `docpost-app/app/api/contact/messages+api.ts`, `docpost-app/lib/usePublicChat.ts`, `docpost-app/components/PublicChat.tsx`.

## Data Model

**One collection per month**, named `contact_YYYY_MM`. Rotating beats a single forever-growing collection: queries stay fast, old data is cheap to drop, and rate limits only ever need to scan one or two partitions.

```ts
interface IPublicContact {
  _id: ObjectId
  fpjs: string | null           // fingerprint cookie; null for bot-path writes
  ip: string | null             // captured for rate-limit counting
  session_id: string            // client-generated, persisted in localStorage
  sender_type: 'visitor' | 'agent'
  sender_name: string           // 'Visitor' or persona display_name
  content: string
  created_at: Date
  prompt_queue_id?: ObjectId    // set on LLM-generated agent messages
  flags: ChatFlag[]             // ['sensitive' | 'deflection' | 'jailbreak' | 'knowledge_gap']
  sentiment?: ChatSentiment     // 'frustrated' | 'neutral' | 'positive'
  flag_reason?: string | null
  resolved: boolean
  rate_limited?: boolean        // set on the message that tripped the limit
}
```

Indexes created **lazily per collection** (cache a `Set<string>` of already-indexed names), not through a global `ensureIndexes`:

```ts
col.createIndex({ fpjs: 1, created_at: -1 })
col.createIndex({ ip: 1, created_at: -1 })
col.createIndex({ session_id: 1 })
col.createIndex({ sender_type: 1, created_at: -1 })
```

### Proactive last-day-of-month pre-creation

On the last UTC day of every month, fire-and-forget create next month's collection + indexes. **Why:** the very first message of the new month otherwise runs uncovered by any index, and the lazy-create race adds latency on the single most visible request.

```ts
if (isLastDayOfMonth(now)) {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  ensureContactIndexes(db, contactCollectionName(next)).catch(console.error)
}
```

### Cross-month reads

For "recent messages" queries (rate limit counting, chat history for the prompt), query **current month + previous month** and merge. The previous-month lookup is skipped when the two collection names are equal (i.e., early in the month but the same year-month). For updates by `_id`, derive the collection name from the ObjectId's embedded timestamp — no lookup needed:

```ts
export function collectionNameFromId(id: string): string {
  const timestampSecs = parseInt(id.slice(0, 8), 16)
  return contactCollectionName(new Date(timestampSecs * 1000))
}
```

## Response Path Discriminator

The POST handler runs in this exact order:

```
1. Parse body → content, session_id, trigger
2. Resolve fpjs (cookie) + ip (headers)
3. Handle trigger === 'idle_frame' early and return (no visitor message to log)
4. Insert the visitor's message into contact_YYYY_MM (always, even for bots)
5. No fpjs?                    → bot path (email check → canned reply)
6. Rate limit exceeded?        → stamp rate_limited:true → bot path
7. Sensitive gate blocks?      → canned deflection as agent message
8. Otherwise                   → render prompt → enqueue LLM job → schedule idle frame
```

**Always log the visitor message first.** You want the record even for rate-limited and sensitive-gated traffic — it's the only way to see spikes and tune filters later.

## Rate Limiting (Calculated Live from Messages)

No separate rate-limit collection. `fpjs` and `ip` are on every message, and the limit check counts recent visitor messages inline:

```ts
const hourAgo = new Date(now.getTime() - 3_600_000)
const { fpjsCount, ipCount } = await countRecentVisitorMessages(db, fpjs, ip, hourAgo)
if (fpjsCount >= LIMIT || ipCount >= LIMIT) {
  await col.updateOne({ _id: inserted._id }, { $set: { rate_limited: true } })
  return botReply(...)
}
```

The limit fires when **either** the fpjs bucket or the ip bucket exceeds the threshold — whichever triggers first wins. Both are tracked because:
- `fpjs` can be null (Safari ITP, private mode, script blockers)
- A shared office IP might legitimately have many fpjs values; the IP cap only catches pathological cases

### Why stamp `rate_limited` on the triggering message?

When reviewing abuse later, you want to see **which exact message crossed the line**, not just that the visitor was limited at some point. This makes the abuse flow auditable in one collection query: `{ rate_limited: true }`.

## Bot Path

Zero-LLM canned responses triggered by either no fingerprint or rate limit. Simple email regex gate determines which of two fixed messages to send:

```ts
const hasEmail = /[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(content)
const reply = hasEmail
  ? "Let me look into that — we'll be in touch through your email. Expected turnaround is 1 business day."
  : "Could you share your email address so we can follow up with you?"
```

Both messages are written as `sender_type: 'agent'` with the persona's `display_name` so they render identically to real LLM replies in the client. The visitor has no way to tell they're on the bot path.

## Lazy Prompt Seeding

The prompt template lives in a `prompts` collection (`slug: 'amelia-chat'`). **Never assume it's been seeded** — the admin might not have loaded the Prompts page yet on a fresh deploy. In the prompt renderer, upsert from an in-code seed constant if missing:

```ts
let promptDoc = await db.collection('prompts').findOne({ slug: 'public-chat' })
if (!promptDoc) {
  await db.collection('prompts').insertOne({
    slug: 'public-chat', body: PROMPT_SEED, updated_at: now,
    versions: [{ body: PROMPT_SEED, saved_at: now }],
  })
  promptDoc = { body: PROMPT_SEED, ... }
}
```

**Why:** if you rely on admin-side seeding, the very first public visitor on a new deploy hits an empty prompt and the LLM responds to pure user input with no system instructions — which is exactly where jailbreaks land.

## Relative Timestamps in `{chat_recent}`

When rendering the chat history into the prompt, prefix each line with **elapsed time from the first message** (not wall clock). This lets the LLM reason about pacing ("the visitor has been waiting 3 minutes") without leaking absolute timestamps or timezone:

```
[+0s] Visitor: hi, do you support SSO?
[+12s] Amelia: Yes — SAML and OIDC...
[+2m 34s] Visitor: what about SCIM?
```

## Welcome Bubble (No LLM Hit on Open)

The first visual message in the drawer is a **pre-generated opener** picked from a static array of ~20 options, rendered as a visual-only bubble that is **not persisted to the database**. Every drawer-open that doesn't lead to a sent message costs zero tokens.

```ts
const OPENERS = ["How can I help you today?", "Welcome! What brings you here?", ...]
const opener = useMemo(() => OPENERS[Math.floor(Math.random() * OPENERS.length)], [])
```

Render as its own component (`<WelcomeBubble />`) before the DB-backed message list. The persona avatar and name appear in a profile row above the bubble so the first impression is "a person greeting you" not "a bot talking at you".

## Typing Indicator Delay Tuning

Showing the typing dots instantly after the user sends feels robotic — real humans take a moment. Use a per-session counter ref:

```ts
const sentCountRef = useRef(0)
// ...in sendMessage, after LLM path:
const isFirst = sentCountRef.current === 0
pendingAmeliaRef.current = true
setTimeout(() => {
  if (pendingAmeliaRef.current) setAmeliaTyping(true)
}, isFirst ? 2500 : 300)
sentCountRef.current += 1
```

First message: **2500ms** (feels like the agent is reading).
Subsequent: **300ms** (feels engaged, not sluggish).

The `pendingAmeliaRef` guard prevents the indicator from flipping on if the agent reply arrived before the timeout fired.

## Idle Frame (30-Second Re-Engagement)

After each LLM-path send, schedule a fire-once timer. If 30 seconds pass with no new user input and the drawer is still open, POST a `trigger: 'idle_frame'` request to the same endpoint. The server skips the visitor-message insert, re-renders the prompt with an injected system note (`[System: 30+ seconds have elapsed...]`), and enqueues a new LLM job. The persona's system prompt has a `TAKE FRAME` directive describing when to proactively follow up.

**Stale closure trap:** the timer callback needs to check the drawer's `open` state without freezing it at schedule time. Mirror it into a ref:

```ts
const openRef = useRef(false)
useEffect(() => { openRef.current = open }, [open])
// Inside the setTimeout callback:
if (!openRef.current || !newestIdRef.current || pendingAmeliaRef.current) return
```

The idle frame request still goes through the rate-limit check server-side, so a hostile bot can't loop trigger='idle_frame' to drain tokens.

## Client State

```ts
export function usePublicChat() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Msg[]>([])
  const [loading, setLoading] = useState(false)
  const [ameliaTyping, setAmeliaTyping] = useState(false)

  const sessionIdRef = useRef<string | null>(null)        // lazy localStorage-backed
  const pollTimerRef = useRef<NodeJS.Timeout | null>(null)
  const newestIdRef = useRef<string | null>(null)         // cursor for polling
  const pendingAmeliaRef = useRef(false)                  // typing indicator guard
  const sentCountRef = useRef(0)                          // first-message delay
  const idleTimerRef = useRef<NodeJS.Timeout | null>(null)
  const openRef = useRef(false)                           // stale-closure mirror
}
```

Poll interval: **5000ms** when drawer is open, using the newest `_id` as cursor. GET failures are **silently treated as empty** — prior history is nice-to-have; the welcome bubble still shows.

### `isMine` check

```ts
isMine = msg.sender_type === 'visitor'
```

**Never** compare `session_id === mySessionId` — agent messages share the visitor's session_id (that's the point of the grouping field), which would flip every reply to the right side of the drawer.

## DOM Event Bridge (Footer Link → Drawer)

The floating button isn't the only entry point. Footer "Contact" links and navbar items should open the same drawer without prop-drilling. Use a DOM CustomEvent:

```ts
// In PublicChat.tsx
useEffect(() => {
  if (Platform.OS !== 'web') return
  const handler = () => setOpen(true)
  window.addEventListener('open-public-chat', handler)
  return () => window.removeEventListener('open-public-chat', handler)
}, [setOpen])

// In the footer component
onPress={() => window.dispatchEvent(new Event('open-public-chat'))}
```

Only works on web. For native, use a module-level EventEmitter or a Zustand store.

## Sensitive Gate

Before every LLM call (not on the bot path), run a keyword + regex gate that checks for jailbreak attempts, off-topic abuse, etc. Same library as the authenticated chat. If the gate blocks, either insert a pre-written deflection as an agent message or silently drop the trigger (no reply at all for the worst class).

**Always log the visitor message even when the gate blocks** — you want to see the attempts.

## Fit-to-Project

Before implementing, check:

- **Fingerprint source.** This skill assumes a `fpjs` cookie set by a client-side FingerprintJS integration. If your stack doesn't have one yet, integrate the `visitor-fingerprint` skill first.
- **Prompt queue infrastructure.** The LLM path relies on a `prompt_queue` collection and `onJobComplete(slug, callback)` worker pattern — see `admin-prompt-queue` skill. If you don't have one, you can run the LLM call inline, but then the client poll loop is your only mechanism for reply delivery.
- **Auth middleware on `/api/contact/*`.** It must be **explicitly unauthenticated**. Double-check your middleware chain doesn't require a session.
- **IP extraction.** `X-Forwarded-For` behind a proxy, `request.ip` behind Cloudflare — whatever your stack exposes. Abstract into a `getRequestIp()` helper so the rate-limit code is portable.
- **Rate limit threshold.** 20 messages/hour/bucket is the default. Tune by traffic: raise it if you see false positives from shared office IPs, lower it if you see abuse.
- **Idle frame window.** 30 seconds is tuned for pre-sales; support triage might want 60 or 90.
- **Opener list size.** 20 is enough that returning visitors rarely see the same one twice; 5 is too few.
- **Knowledge base reader.** Separate from the authenticated-chat KB — the public persona should not be able to answer account-specific questions.

## Anti-Patterns

- **Separate rate-limit collection with TTL indexes** — tempting because it looks cleaner, but you lose the ability to mark which specific message tripped the limit, and you need cross-collection joins to correlate abuse patterns. Store `fpjs` + `ip` on every message and count live.
- **Single forever-growing collection** — fine at 10K messages, slow at 1M, painful to delete old data. Monthly rotation is the same pattern as request logs; reuse the helper.
- **Pre-creating empty collections with `createCollection()`** — MongoDB creates on first insert automatically. Only the *indexes* need an explicit call, and they should be lazy + cached by collection name.
- **Waiting until the 1st to create next month's indexes** — the first visitor after midnight runs uncovered, and you'll see a latency spike on the single most-visible request. Create on the last day of the month, fire-and-forget.
- **Treating no-fingerprint traffic as an error** — cookieless browsers, privacy extensions, Safari ITP, and bots all land here. Always accept the message; fall back to the canned bot-path reply.
- **Welcome bubble as an LLM call** — every drawer-open that doesn't lead to a message wastes tokens. Pre-generate ~20 openers and pick one at mount. It's just a visual — don't persist it.
- **Immediate typing indicator on first send** — feels robotic. Delay 2–3 seconds on the first message, near-immediate after. Use a ref-backed per-session counter, not state.
- **Storing the client session_id but using it for `isMine`** — agent messages share the visitor's session_id on purpose (grouping). Use `sender_type === 'visitor'` to side-switch bubbles.
- **Initial-load errors blocking the UI** — GET `/api/contact/messages` is nice-to-have (prior history). On failure, silently render an empty list; don't show "failed to load". The visitor can still send.
- **Assuming the prompt is pre-seeded in DB** — first-ever deploy hits an empty template and the LLM responds to raw user input. Lazy-upsert from an in-code seed constant in the prompt renderer.
- **Stale closure in the idle timer** — reading `open` directly inside a `setTimeout` captures the value at schedule time. Mirror to a ref via `useEffect(() => { openRef.current = open })`.
- **No `preventDefault()` on Enter inside a multiline TextInput** — the send fires correctly, but a newline also gets inserted into the cleared input, so the next message starts with a blank line.
- **Letting `trigger: 'idle_frame'` skip the rate limit** — a hostile client could loop the trigger and drain your LLM budget. The idle-frame path must still increment and check the same counters.
- **Absolute timestamps in `{chat_recent}`** — leaks timezone and doesn't help the LLM reason about pacing. Use relative-from-first-message instead.
- **Mixing visitor session_id and server-side auth user_id** — the public chat is explicitly anonymous. If your persona needs to address the visitor by name, collect it in-conversation, never from a session cookie.

## Logging

- Log `[contact/messages POST]` and `[contact/messages GET]` with the error on any caught exception. The public endpoint is the one most likely to 500 on a new deploy (fpjs parsing, prompt not seeded, index missing) and the hardest to debug without logs.
- Don't log the message content — too noisy and PII-adjacent. Log the fpjs prefix, the sender_type, and the response path taken (`bot_no_fpjs`, `bot_rate_limit`, `llm_queued`, `sensitive_blocked`).
- Log idle-frame triggers separately — they're the thing most likely to surprise-spike your LLM usage if the threshold is mis-tuned.
