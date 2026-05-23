---
name: public-contact-chat
description: >
  Use when building an unauthenticated public-facing contact chat widget with a
  persona-driven AI agent. Covers monthly collection rotation, fingerprint-based
  bot detection with no-LLM fallback path, inline (separate-table-free) rate
  limiting, session-based visitor grouping, 30-second idle re-engagement frames,
  pre-generated welcome bubbles (no LLM hit on drawer open), typing indicator
  delay tuning, lazy prompt seeding, floating-drawer vs right-rail sidebar
  shell variants, click-outside-to-close, focus-textarea-on-open, brand-color
  theming, and the AgentIdentity header (avatar + name + title + timestamp).
  Wires the Public tab into the shared `admin-chat` review surface (with
  Amelia's `amelia-compiler` Compile KB config), and uses `admin-prompt-queue`
  for the LLM job and the KB compilation worker.
dependencies:
  requires: [admin-chat, admin-prompt-queue]
  capabilities:
    public-page: landing-marketing-site
    auth: otp-auth
    fingerprint: visitor-fingerprint
---

# Public Contact Chat

A floating contact widget that lets an anonymous website visitor chat with a branded AI persona without signing up, logging in, or filling out a form. The key insight is that **three response paths** share one collection — real visitor → LLM, no-fingerprint → canned bot reply, rate-limited → canned bot reply — so suspected bots never touch your LLM budget, and the LLM path still feels human through small delays, pre-generated openers, and idle re-engagement.

Reference implementations:
- **Server + hook + floating drawer variant:** `docpost-app/app/api/contact/messages+api.ts`, `docpost-app/lib/usePublicChat.ts`, `docpost-app/components/PublicChat.tsx`.
- **Right-rail sidebar variant (brand-themed, click-outside, focus-on-open, AgentIdentity):** `influencer-studio/twp.react/app/components/PublicChat.jsx`.

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

## Prompt Source — Flat File at `web/prompts/amelia-chat.md`

The prompt template lives as a flat file at `web/prompts/amelia-chat.md` inside the deploy unit, loaded through `loadPrompt('amelia-chat')` from `admin-prompt-queue`'s shared loader. Git is the VCS for the prompt body — there is no separate seeding step, no DB upsert, no in-code `PROMPT_SEED` constant to keep in sync. A fresh deploy works because the file ships in the repo; the very first visitor reads it from disk, and the loader's 5-second TTL cache covers warm-path traffic.

**Why this beats the older "DB collection + lazy upsert" shape:** the `prompts` collection that earlier revisions of this recipe described tried to serve two masters — admin editing through a UI *and* a deploy-time guarantee that something was on disk. The seed-then-upsert dance papered over the gap, but it left two artifacts that could disagree (the in-code constant and the eventually-edited DB row), and on a fresh deploy the first visitor's request had to wait on the seed-then-read round trip. Flat files collapse all of that to "the file IS the prompt." See `admin-prompt-queue` § 4 for the full story.

The template uses the `[SYSTEM]` / `[MAIN]` scaffold (see `admin-prompt-queue` § 5.1). Inside `[MAIN]`, Amelia's chat template declares nested `[HISTORY]` and `[USER]` markers because each chat turn changes only the per-turn content; pinning `[SYSTEM]` (persona + rules + KB) at the cache boundary lets repeat calls hit Gemini's context cache.

## Amelia's Structured-Reply Envelope

The `amelia-chat` system instruction asks Gemini to return a JSON envelope, not free-form prose:

```json
{
  "reply": "the visitor-visible message",
  "flags": ["sensitive" | "deflection" | "jailbreak" | "knowledge_gap"],
  "sentiment": "frustrated" | "neutral" | "positive",
  "flag_reason": "string or null — why a flag was raised",
  "expects_followup": true | false,
  "identities": [{ email?, name?, title?, business? }]
}
```

The handler's `onJobComplete` parses the envelope and routes the fields onto the agent message doc:

- `reply` → `content` (what the visitor sees in the drawer)
- `flags` → `flags[]` on the message (LLM self-flagging; admin's flagged-tab partial index already covers it)
- `sentiment` → `sentiment` (drives the per-message sentiment badge in `admin-chat`)
- `flag_reason` → `flag_reason` (admin sees it expanded in the flagged tab)
- `expects_followup` → stored verbatim; future hook for "Amelia is waiting for an answer" indicators
- `identities[]` → stored verbatim; future hook for visitor-profile enrichment

**Tolerant parsing is mandatory.** Real models drift. The parser:

1. Strips ` ```json ` / ` ``` ` fences if present (Gemini sometimes wraps JSON output even when told not to).
2. Tries `JSON.parse`. On failure, retries after stripping trailing commas (`,(\s*[}\]])` → `$1`) — the prompt example in `amelia-chat.md` has a trailing comma the model will sometimes copy.
3. Validates `flags[]` against the allowed set; drops unknown values.
4. Validates `sentiment` against the allowed set; nulls it on mismatch.
5. Drops `identities[]` entries with no usable fields.
6. On any parse failure, or on a parsed envelope with empty `reply`, stores the raw text as `content` and adds `parse_error` to `flags[]` with a `parse_error` sibling field describing what went wrong. The visitor sees the raw text (better than a confusing fallback message); the admin sees the parse_error flag on the row and can diagnose.

**Fallback strings skip parsing.** When the handler hits a no-key / empty-response / SDK-error path it returns a plain canned message with `finish_reason` starting with `fallback_`. The on-complete recognizes that prefix and stores the canned message verbatim — never attempts to JSON-parse it.

**Why JSON, not plain prose.** Plain prose forced every downstream consumer (sentiment badges, flag chips, identity capture) to re-derive the same signals from the visitor-visible text — sometimes by re-running another LLM call, sometimes by regex. The model already produced the structured information while writing the reply; capturing it in one envelope is cheaper, more accurate, and survives prompt-rewording without coupling to specific phrasing in the reply.

**Why not constrain Gemini's `responseMimeType: "application/json"` at request time?** Forcing strict JSON output at the request layer changes the request hash and would invalidate the cached `systemInstruction`. The tolerant parser covers realistic drift without giving up the cache hit. If a project measures unacceptable parse failures, that's the time to add request-side schema enforcement *and* re-key the cache.

**Deliverables:**

- **reply.a** The handler responsible for `amelia-chat` completions parses `job.response.text` as a JSON envelope (after fence stripping and trailing-comma-tolerant retry) before writing the agent message.
- **reply.b** The agent message doc carries `content` (= `reply`), `flags`, `sentiment`, `flag_reason`, `expects_followup`, `identities`, and `parse_error` (null when the parse succeeded).
- **reply.c** Invalid `flags[]` and `sentiment` values are filtered/nulled rather than stored verbatim — the schema's allowed-value contract holds even if the model invents new ones.
- **reply.d** Parse failures (non-JSON, missing `reply`, empty `reply`) write the raw text as `content` and set `flags: ["parse_error"]` with a `parse_error` field describing the failure mode. The pipeline never throws on a malformed envelope.
- **reply.e** Handler-side fallback strings (`finish_reason` starting with `fallback_`) bypass JSON parsing and pass through verbatim as `content`.

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

## Idle Frame (30-Second Re-Engagement) — STRICTLY One Nudge Per Silence

After each LLM-path send, schedule a fire-once timer. If 30 seconds pass with no new user input and the drawer is still open, POST a `trigger: 'idle_frame'` request to the same endpoint. The server skips the visitor-message insert, re-renders the prompt with an injected system note (`[System: 30+ seconds have elapsed...]`), and enqueues a new LLM job. The persona's system prompt has a `TAKE FRAME` directive describing when to proactively follow up.

**The one-nudge-per-silence rule.** A visitor silence gets *at most one* idle-frame nudge. Not two, not one-every-thirty-seconds — exactly one. The counter resets only when the **visitor** sends a new message. If the visitor doesn't respond to the nudge, they receive silence back, not a second nudge.

This is easy to get wrong. The classic bug: the poll loop that delivers Amelia's replies calls `scheduleIdleFrame()` after any agent message arrives. Amelia's nudge is itself an agent message, so the poll re-schedules another idle timer, fires another nudge 30 seconds later, and the loop runs until the LLM budget is gone or the visitor closes the tab. Don't do that.

**Correct shape:**

```ts
const nudgeSentRef = useRef(false) // one nudge per silence period

const scheduleIdleFrame = useCallback(() => {
  if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
  if (nudgeSentRef.current) return // already nudged this silence — stop
  idleTimerRef.current = setTimeout(async () => {
    if (
      !openRef.current ||
      !newestIdRef.current ||
      pendingAmeliaRef.current ||
      nudgeSentRef.current
    ) return
    pendingAmeliaRef.current = true
    nudgeSentRef.current = true  // set BEFORE the POST — no second nudge
    setAmeliaTyping(true)
    await fetch("/api/contact/messages", {
      method: "POST",
      body: JSON.stringify({ session_id: sid, trigger: "idle_frame" }),
    })
  }, 30_000)
}, [getSessionId])

// sendMessage (visitor broke the silence) — re-arm the one-shot.
async function sendMessage() {
  if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
  nudgeSentRef.current = false   // next silence gets its own single nudge
  // ...POST the visitor message, etc.
}
```

Call `scheduleIdleFrame()` after every agent reply arrives via the poll — that's fine, because `nudgeSentRef` short-circuits the reschedule while a silence is already "spent." The only thing that re-arms the nudge is the visitor explicitly sending.

**Stale closure trap:** the timer callback needs to check the drawer's `open` state without freezing it at schedule time. Mirror it into a ref:

```ts
const openRef = useRef(false)
useEffect(() => { openRef.current = open }, [open])
// Inside the setTimeout callback:
if (!openRef.current || !newestIdRef.current || pendingAmeliaRef.current) return
```

The idle frame request still goes through the rate-limit check server-side, so a hostile bot can't loop trigger='idle_frame' to drain tokens.

**Deliverables:**

- **idle.a** Exactly one idle-frame POST fires per visitor-silence period. A silence that receives a nudge but no visitor reply does NOT trigger a second nudge.
- **idle.b** A `nudgeSentRef` (or equivalently-named) ref guards `scheduleIdleFrame`: the scheduler short-circuits when the flag is true, AND the timer callback re-checks the flag before POSTing (defends against concurrent schedules).
- **idle.c** The flag is set to `true` before the idle-frame POST is dispatched, not after — if the POST is slow and the poll delivers the reply while we wait, the next scheduleIdleFrame call must still be short-circuited.
- **idle.d** The flag is reset to `false` only inside the visitor-message send path (`sendMessage` or equivalent). No other code path clears it.
- **idle.e** The poll loop that delivers agent messages may still call `scheduleIdleFrame()` after any agent reply — the flag makes that call a no-op during an already-nudged silence. Do NOT remove the call from the poll loop and rely solely on sendMessage, because visitor-triggered LLM replies arrive asynchronously and the scheduler needs them as its anchor point.

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
  const nudgeSentRef = useRef(false)                      // one-nudge-per-silence guard
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

## Drawer Shell Variants

The same hook drives two visual shells. Pick one per project — don't ship both.

### Floating drawer (original)

Bottom-right FAB → opens a small rounded card pinned near the bottom-right corner. Good for support widgets on dense product UIs where the host content must stay interactive behind the drawer.

### Right-rail sidebar (marketing variant)

Full-height right rail, ~420px wide, flush to the viewport edge. Good for marketing/landing sites where the chat is positioned as "Contact Us" and the host page can be visually pushed aside.

```jsx
<View
  ref={sidebarRef}
  style={{
    position: 'fixed',
    top: 0, right: 0, bottom: 0,
    width: 420, maxWidth: '100vw',
    zIndex: 9999,
    backgroundColor: '#fff',
    borderLeftWidth: 1, borderLeftColor: '#e5e7eb',
    shadowOffset: { width: -4, height: 0 },
    shadowOpacity: 0.15, shadowRadius: 24,
    display: 'flex', flexDirection: 'column',
  }}
>
```

The header row for the sidebar variant reads **"Contact Us"** rather than "Chat" — it frames the widget as a contact channel, not a bot. The host site header's right-side CTAs should use `marginLeft: 'auto'` (no `maxWidth: 1200` container) so they sit under the sidebar when it opens; otherwise the Sign In / Contact buttons float in the middle of the viewport while the rail hangs off to the right.

## Brand-Color Theming

The persona avatar and typing dots read as "that blue bubble chat thing" if you hard-code tailwind `sky-*`/`#0284c7`. On a non-blue brand site it looks like an embedded third-party widget. Extract the accent into a single constant and wire it into: FAB background, header background, user-message bubble background, send button background.

```jsx
const ACCENT = '#f44336'; // match host-site primary CTA
```

Keep agent bubbles neutral (`slate-200` / `#e2e8f0`) regardless of brand — tinted agent bubbles read as UI chrome, not a person.

## Persona Constants Module

Centralize the persona's display name, title, and avatar asset in a single module (e.g., `lib/amelia.ts`) and import from there everywhere — `PublicChat`, the prompt renderer, any footer/header references. Do not hardcode the name or title inline in `AgentIdentity`, do not let the title drift between the component and the system prompt, and never invent a new title when wiring up a new surface.

```ts
// lib/amelia.ts
export const AMELIA_DISPLAY_NAME = 'Amelia Weber';
export const AMELIA_TITLE = 'Inbound Support Specialist';
export const AMELIA_AVATAR = require('../assets/team/amelia-weber-avatar.png');
```

Note the `require()` — the avatar is a **bundled asset**, not an external URL string. A tempting shortcut is `AMELIA_AVATAR = 'https://yourcdn.com/amelia.png'` because it works in both `<img src>` and `<Image source={{ uri }}>`, but it couples the chat widget's first paint to an external DNS + TLS + HTTP round-trip on every page load. When the CDN is slow, the avatar pops in a full second after the welcome bubble; when the CDN is down, the avatar never loads at all and the widget reads as broken. Bundle the headshot.

```tsx
// components/PublicChat.tsx
import { AMELIA_DISPLAY_NAME, AMELIA_TITLE, AMELIA_AVATAR } from '@/lib/amelia';
// ...
<AgentIdentity name={AMELIA_DISPLAY_NAME} title={AMELIA_TITLE} timestamp={welcomeTime} />
```

The title is part of the persona's identity and must match what the system prompt claims the agent is. If the prompt says "you are Amelia Weber, Inbound Support Specialist" but the UI renders "Client Relations", returning visitors notice the drift and the widget loses credibility. One source of truth — the constants module — is the fix.

**The avatar must be a real bundled image file**, not an initial-in-a-colored-circle fallback. The initial-in-circle pattern reads immediately as a bot/placeholder even when the brand color matches; a real headshot of a plausible human is what sells "contact channel, not AI widget". Source the asset from the same persona library that authenticated products use (`amelia-weber-avatar.png` — a ~36px-optimized version, not the full 466K headshot) and bundle it via `require()`.

## AgentIdentity Header

Every agent message (and the welcome bubble) gets a small identity row above the bubble: **avatar + name + timestamp on one line, title on the line below**. Don't put the title inline with the name — it looks like a middle name.

```jsx
function AgentIdentity({ name, title, timestamp }) {
  return (
    <View className="flex-row items-start gap-2 mb-1.5">
      <Image source={avatar} style={{ width: 36, height: 36, borderRadius: 18, marginTop: 2 }} />
      <View className="flex-1">
        <View className="flex-row items-center gap-2 flex-wrap">
          <Text className="font-semibold text-sm">{name}</Text>
          {timestamp && <Text className="text-xs text-slate-400">{formatTime(timestamp)}</Text>}
        </View>
        <Text className="text-xs text-slate-500">{title}</Text>
      </View>
    </View>
  );
}
```

Two layout rules this pins down:

1. **Agent message bubbles get `marginLeft: 44`** (36px avatar + 8px gap) so the bubble body lines up under the name, not under the avatar. Without this offset the conversation looks ragged.
2. **`welcomeTime` is captured once via `useMemo(() => new Date(), [])`**. If you compute it inline on each render, the displayed timestamp drifts as the component re-renders, which readers notice subliminally even though they don't know why it feels off.

`formatTime(value)` is a 6-line helper that takes a Date or ISO string and returns `"2:34 PM"` — don't reach for date-fns or dayjs for one format.

## Click-Outside-To-Close

Any drawer the user can open from multiple entry points (FAB, header CTA, footer link, hero CTA) needs to close when they click back into the page. Use a document `mousedown` listener + a ref to the sidebar node.

```jsx
const sidebarRef = useRef(null);

useEffect(() => {
  if (!open || Platform.OS !== 'web') return;
  const handler = (e) => {
    const node = sidebarRef.current;
    // react-native-web refs may be a host node or a wrapper — unwrap.
    const dom = node && (node.nodeType ? node : node._node || node);
    if (dom && dom.contains && dom.contains(e.target)) return;
    setOpen(false);
  };
  // Defer one tick so the same click that opened the drawer doesn't
  // immediately close it.
  const attachT = setTimeout(() => {
    document.addEventListener('mousedown', handler);
  }, 0);
  return () => {
    clearTimeout(attachT);
    document.removeEventListener('mousedown', handler);
  };
}, [open, setOpen]);
```

Two non-obvious details:

- **`node._node || node` unwrap.** React Native Web sometimes gives you a wrapper object whose `_node` is the actual DOM element; sometimes it gives you the element directly. Unwrap defensively — if you don't, `.contains()` throws and the click-outside silently stops working.
- **`setTimeout(0)` before `addEventListener`.** The click that opens the drawer bubbles up to `document` *after* the drawer mounts, so without a deferred attach the handler sees the opening click as an outside click and closes immediately. You'll spend 20 minutes confused before you think of this.

## Focus Textarea On Open

A blinking cursor in the input on open makes the drawer feel "live". Without it, users click the FAB, see the drawer, then have to click again into the input — the second click is enough friction that some bounce.

```jsx
const inputRef = useRef(null);
useEffect(() => {
  if (!open || Platform.OS !== 'web') return;
  const t = setTimeout(() => inputRef.current?.focus?.(), 50);
  return () => clearTimeout(t);
}, [open]);
```

The 50ms delay gives the drawer's mount animation time to finish; focusing at exact open-time can scroll the page weirdly in Safari.

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

## Admin Chat Tab Registration

The admin review of flagged public-contact messages lives in the `admin-chat` recipe (single page at `/platform/chat`, two tabs). This recipe contributes the **Public tab** to its registry. Do not build a separate admin page for contact messages — `admin-chat` is the single review surface.

```ts
// lib/contact/adminTab.ts — registered in lib/adminChat/tabs.ts
import type { AdminChatTab } from '@/lib/adminChat/types'
import { contactSchemaAdapter } from './contactSchemaAdapter'
import { invalidatePromptCache } from '@/lib/promptLoader'
import fs from 'fs/promises'

export const CONTACT_TAB: AdminChatTab = {
  key: 'contact',
  label: 'Public',
  collectionPrefix: 'contact_',
  schema: contactSchemaAdapter,
  filters: [
    { kind: 'text', key: 'session_id',  label: 'Session ID' },
    { kind: 'text', key: 'fpjs_prefix', label: 'Fingerprint prefix' },
  ],
  kbCompile: {
    promptSlug: 'amelia-compiler',
    outputPath: 'rag/amelia-knowledge.md',
    onComplete: async ({ content }) => {
      await fs.writeFile('rag/amelia-knowledge.md', content)
      await invalidatePromptCache('amelia-chat')
    },
  },
}
```

The schema adapter (`contactSchemaAdapter`) maps an `IPublicContact` document into the `FlaggedRow` shape `admin-chat`'s table consumes:

- `sender_label` → `'Visitor (fpjs:{first8}…)'` for `sender_type === 'visitor'`, the persona display name (e.g. `'Amelia Weber'`) for the agent
- `buildQuery(filters)` → matches `session_id` exact, `fpjs_prefix` as `{ fpjs: { $regex: '^' + prefix } }`, plus the shared flag/sentiment/resolved/date filters
- `resolveTarget(rowId)` → derives `contact_YYYY_MM` from the ObjectId timestamp via `collectionNameFromId(rowId)` (already in this recipe)

Amelia's KB (`rag/amelia-knowledge.md`) is compiled by the **`amelia-compiler`** prompt, run as a job through `admin-prompt-queue`. The Compile KB button in the right side of the Public tab header on `/platform/chat` is rendered by `admin-chat`; this recipe just supplies the `kbCompile` config and registers the `onJobComplete('amelia-compiler', …)` handler with `admin-prompt-queue` at install time.

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
- **Rescheduling the idle timer after every agent reply** — the classic nudge-loop bug. The poll loop sees Amelia's reply arrive and calls `scheduleIdleFrame()`. Amelia's own idle-frame nudge IS an agent reply, so the poll schedules another timer, another nudge fires 30 seconds later, ad infinitum. The visitor sees "still there?" every 30–60 seconds until they close the tab or the LLM budget runs out. Fix: guard `scheduleIdleFrame` with a `nudgeSentRef` that is set true when a nudge is dispatched and reset false ONLY when the visitor sends a new message. One nudge per silence period. See the "STRICTLY One Nudge Per Silence" section for the correct shape.
- **Absolute timestamps in `{chat_recent}`** — leaks timezone and doesn't help the LLM reason about pacing. Use relative-from-first-message instead.
- **Mixing visitor session_id and server-side auth user_id** — the public chat is explicitly anonymous. If your persona needs to address the visitor by name, collect it in-conversation, never from a session cookie.
- **Hard-coded sky-blue theme on a non-blue brand site** — the widget instantly reads as a third-party embed. Pull the accent into one constant and match the host primary CTA. Agent bubbles stay neutral.
- **Agent bubble flush-left with no avatar offset** — the bubble should indent under the name, not the avatar. Use `marginLeft: 44` on non-mine bubbles (36px avatar + 8px gap).
- **Inline `new Date()` for the welcome bubble timestamp** — it drifts on every re-render. Freeze it once with `useMemo(() => new Date(), [])` at mount.
- **Title next to the name on the same line** — reads as a last name ("Amelia Weber Goliath Influence Group"). Put the title on its own line under the name.
- **No click-outside-to-close** — a drawer opened from the header CTA should close when the user clicks back into the page. Document `mousedown` + ref-based containment check, attached via `setTimeout(0)` so the opening click doesn't immediately close it.
- **Registering the mousedown handler synchronously on open** — the same click that opened the drawer bubbles to document *after* your effect runs, so you see it as outside-click and close immediately. Defer attach by one tick.
- **Forgetting to unwrap `ref._node` on RN Web** — RNW refs can be a wrapper object or a host DOM node; `.contains()` throws on the wrapper. Unwrap with `node.nodeType ? node : node._node || node` before the containment check.
- **No focus-on-open for the input** — first click opens the drawer, second click focuses the input, and some users bounce between those two. `useEffect` on `open` + `setTimeout(50)` + `inputRef.focus()`.
- **Header CTAs constrained to a centered `maxWidth: 1200` container** — when a right-rail sidebar opens, the header's Sign In / Contact buttons sit in the middle of the viewport instead of tucking under the rail. Drop the container and use `marginLeft: 'auto'` on the right cluster so it hugs the viewport edge and gets covered by the sidebar.
- **Hardcoding the persona's name or title inline in `AgentIdentity`** — it drifts from the system prompt and from footer/header references. Centralize in `lib/<persona>.ts` and import.
- **Inventing a persona title when wiring a new surface** — the title is part of the persona's identity and must match the system prompt's self-description verbatim. If you don't remember it, read `lib/<persona>.ts`, don't guess.
- **Initial-in-a-colored-circle avatar placeholder** — reads as a bot on sight even when the brand color matches. Bundle a real headshot image (`require('../assets/team/amelia-weber-avatar.png')`) and render with `<Image>`. This sells "contact channel, not widget" in a way a CSS circle never will.
- **External-URL avatar string in the persona constants module** (`AMELIA_AVATAR = 'https://cdn.example.com/amelia.png'`) — couples widget first paint to a third-party DNS + TLS + HTTP round-trip, and pops in the avatar a beat after the welcome bubble. Bundle the asset with `require()` so it ships with the JS chunk.
- **Defining the avatar constant inline in `PublicChat.tsx` instead of `lib/<persona>.ts`** — shadows the module export, so the next surface that imports `AMELIA_AVATAR` gets a different value (or the old URL string) and the persona drifts surface-by-surface. One source of truth, always — even when it feels like a one-line shortcut.
- **"Chat" as the sidebar header title on a marketing site** — feels like a support ticket. Use "Contact Us" — it reframes the widget as a contact channel, not a bot.

## Logging

- Log `[contact/messages POST]` and `[contact/messages GET]` with the error on any caught exception. The public endpoint is the one most likely to 500 on a new deploy (fpjs parsing, prompt not seeded, index missing) and the hardest to debug without logs.
- Don't log the message content — too noisy and PII-adjacent. Log the fpjs prefix, the sender_type, and the response path taken (`bot_no_fpjs`, `bot_rate_limit`, `llm_queued`, `sensitive_blocked`).
- Log idle-frame triggers separately — they're the thing most likely to surprise-spike your LLM usage if the threshold is mis-tuned.
