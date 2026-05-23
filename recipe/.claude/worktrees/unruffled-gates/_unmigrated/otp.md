---
name: User Auth
description: Shared authentication infrastructure for email OTP sessions and future full accounts; also admin route protection
type: project
---

# PRD: User Authentication

## Overview

This recipe defines a single shared auth system serving multiple consumers. Build once, use everywhere. Do not build separate OTP flows. "User registration" in this codebase means completing the OTP flow below — there is no separate sign-up step.

---

## Phase 1: Email OTP (Passwordless)

### User flow

1. User enters email address on any protected action (create alert, submit review).
2. If a valid session already exists for that email (cookie present and not expired) → proceed immediately, no OTP step.
3. If no session → send 6-digit OTP to the email along with a magic link.
4. User clicks the magic link. If the IP matches what was used to request the OTP, auto-verify and redirect. Otherwise, show an OTP code entry form. **Do not include the OTP in the magic link URL** — it would leak to advertising/analytics via referrer headers.
5. On success: promote the pending session to active, set an `HttpOnly` session cookie, redirect to original destination.

Email is sent via Amazon SES.

### `user_id`

`user_id` = `sha256(seed + email.toLowerCase())` — stable, anonymous identifier derived from the verified email. Used as a FK in domain-specific tables. Consistent across sessions. Not exposed to the client; used server-side only.

`seed` is a small randomly generated site-wide value defined in `.env` as `USER_ID_SEED`.

---

## Phase 1 Account Features

Once registered, a user's `/account` section provides:

- **Alerts Panel** (`/account/alerts`) — view, edit, pause, delete price alerts (per-app — this is an example consumer).
- **Display name** — editable after first sign-in (either in the OTP modal on first verify or later via `/account`), used as a public-facing name.

## Phase 2: Full Accounts (future)

- Google OAuth and email+password.
- Expanded profile: review history, purchase history.
- `user_id` from Phase 1 (email hash) migrates cleanly — same identifier, just with richer profile data attached.

---

## Data Model

### `sessions` table/collection

One store serves both pending OTPs (pre-verification) and active sessions (post-verification). A `status` field discriminates between the two states. A pending session is **promoted in-place** to active on OTP verification — do not delete and recreate.

```
Session {
  id:                 auto-generated primary key
  status:             enum('pending', 'active')
  email:              string
  expires_at:         datetime
  created_at:         datetime
  redirect:           string | null      // destination path after login; stored in DB only

  // pending-only fields (cleared on promotion to active)
  otp_hash:           string | null      // SHA-256(otp) — never store plaintext
  link_token:         string | null      // random 32-byte hex; in magic link URL
  request_ip:         string | null      // IP at OTP-request time; used for bot check
  attempts:           integer | null     // wrong OTP guesses; reject after 5
  request_count:      integer | null     // OTPs issued in current rate window
  rate_window_start:  datetime | null    // start of current rate window

  // active-only fields (set on promotion)
  user_id:            string | null
  session_token:      string | null      // random 32-byte hex; stored in cookie
  last_used_at:       datetime | null
}
```

**Indexes / constraints:**
- TTL/scheduled cleanup on `expires_at` — auto-deletes both expired pending OTPs and expired sessions. If the database supports TTL indexes, use them. Otherwise, run a periodic cleanup job.
- Index on `email` — look up pending session by email.
- Index on `link_token` (sparse/partial — only where not null) — look up by magic link token.
- Unique index on `session_token` (sparse/partial — only where not null) — primary session lookup.

**Session expiry:**
- Pending OTP: expires 1 hour after creation.
- Active session (default / "remember me"): 30 days rolling / 365 days rolling. Rolling means `expires_at` is extended on every authenticated request.

Multiple concurrent sessions per user are supported (phone + laptop). New login does not invalidate other sessions.

### `users` table/collection

One record per user. Created on first login via upsert (insert-if-not-exists). Profile fields live here, not on sessions.

```
User {
  user_id:       string (primary key)   // sha256(USER_ID_SEED + email)
  email:         string (unique)
  display_name:  string
  role:          enum('user', 'admin')
  email_health:  enum('ok', 'bounced', 'unresponsive')
  created_at:    datetime
  updated_at:    datetime
}
```

Role is set manually via direct DB write. There is no public "become admin" flow.

---

## Database Access Pattern

All auth code accesses the database through a shared connection/client helper. Refer to `stack.md` for the specific database driver and connection pattern used in this project.

```
// Pseudocode — stack.md determines the actual implementation
function getDb():
  return database connection (singleton, lazy-initialized)

function findSessionByToken(token):
  return db.sessions.findOne({ session_token: token, status: 'active' })

function findSessionByEmail(email):
  return db.sessions.findOne({ email: email, status: 'pending' })

function findSessionByLinkToken(linkToken):
  return db.sessions.findOne({ link_token: linkToken, status: 'pending' })
```

---

## Auth Middleware

Three functions provide route protection at different levels:

```
interface AuthSession {
  user_id:      string
  email:        string
  display_name: string
  role:         'user' | 'admin'
}

function getSession(request) → AuthSession | null
function requireSession(request) → AuthSession      // throws 401 if unauthenticated
function requireAdmin(request) → AuthSession         // throws 403 if not admin
```

`getSession` checks the session cookie first, then `Authorization: Bearer <token>` as fallback. On valid session, rolls `expires_at` forward and updates `last_used_at`. Joins the users table to get `display_name` and `role`.

The cookie name should be configurable per app (e.g., `{app_slug}_session`). See `app-config-theming.md` for how the app slug is defined.

---

## Redirect After Login

### Store redirect in the database, never in the URL

The destination path the user was trying to reach is stored on the pending session record in the database (`redirect` field). It is returned by `verify-otp` in the JSON response as `data.redirect`. The client uses `data.redirect || '/'` as the destination.

**Do NOT:**
- Append `&redirect=<path>` to the magic link URL — this exposes admin paths in email (logged by mail servers, visible to email clients, potentially leaked to link scanners).
- Rely on the `?redirect=` URL param surviving email clients — some clients rewrite URLs, strip params, or use link-preview proxies that consume the token before the user clicks.

**Do:**
- Store `redirect` in the DB at OTP-request time.
- Return it from `verify-otp` in the response body.
- On web, use a full page navigation (not client-side routing) for the post-login redirect — this ensures it works for both SPA pages and server-rendered routes.

```
// Pseudocode — use full-page navigation on web, client router on native
function navigate(dest, router):
  if running in browser:
    window.location.replace(dest)      // full navigation — works for SSR + SPA routes
  else:
    router.replace(dest)               // native navigation
```

### Server-side route redirects

When a server-rendered route redirects to login, use `pathname + search` (not the full `request.url`) as the redirect value. `request.url` includes protocol and host, which will fail the relative-path validation in `request-otp`.

```
// Pseudocode
url = parse(request.url)
redirect = url.pathname + url.search
loginUrl = "/login?redirect=" + encodeURIComponent(redirect)
```

---

## Bot Protection: IP Check on Magic Links

Email scanner bots (deployed by corporate mail servers and some email clients) click every link in an incoming email for malware scanning and link-preview generation. Without the IP check, these bots would consume the magic link token before the user clicks, logging the bot in (to nowhere) and leaving the user with an expired token.

**How it works:**
1. At OTP-request time, store the client IP in `request_ip` on the pending session.
2. At magic-link verify time, compare the current request IP to `request_ip`.
3. If they match → auto-verify (user is on the same network they requested from).
4. If they differ → return `{ needs_otp: true, email }` → show OTP code entry form.

**IP resolution order:** `X-Forwarded-For` header first, then `X-Real-IP`, then direct connection IP. This works behind load balancers (which set `X-Forwarded-For`) and in local dev (direct connection).

---

## Session Promotion (pending → active)

On successful OTP verification, promote the pending session in-place. Update the existing record — do not delete and recreate, as deleting loses the `redirect` field and any other pending-session state.

```
// Pseudocode — promote pending session to active
update session where id = pending.id:
  set status = 'active'
  set user_id = computed_user_id
  set session_token = random_hex(32)
  set last_used_at = now
  set expires_at = now + session_max_age
  clear otp_hash
  clear link_token
  clear request_ip
  clear attempts
  clear request_count
  clear rate_window_start
  // do NOT clear redirect — it must survive promotion
```

**Important:** `redirect` is intentionally NOT cleared — it must survive promotion so `verify-otp` can return it in the response.

---

## Client Auth Cache Race Condition

After `verify-otp` returns a session, immediately populate the client-side auth cache before navigating. If using a client-side data fetching library (SWR, React Query, etc.), optimistically set the cached user data so that any layout that checks auth on the destination page sees the user instantly — no loading flash or redirect loop.

```
// Pseudocode
response = await verifyOtp(payload)
setCachedUser(response.user, { skipRevalidation: true })   // populate cache optimistically
navigate(response.redirect || '/', router)
```

Do NOT trigger a revalidation and then immediately navigate — the destination page mounts while the revalidation is still in-flight, sees `user: null`, and redirects back to login.

---

## Session Cookie

- Name: `{app_slug}_session` (configurable per app via `app-config-theming.md`)
- Flags: `HttpOnly; SameSite=Strict; Secure` (Secure only in production)
- Value: the `session_token` (random 32-byte hex)
- Set on OTP verify success, rolling expiry extended on each authenticated request

```
// Pseudocode
function makeSessionCookie(token, rememberMe):
  maxAge = rememberMe ? 365_DAYS_IN_SECONDS : 30_DAYS_IN_SECONDS
  secure = isProduction ? "; Secure" : ""
  return "{app_slug}_session={token}; HttpOnly; SameSite=Strict; Path=/{secure}; Max-Age={maxAge}"
```

Cookie is parsed manually from the `Cookie` header — no cookie-parsing library needed.

---

## API Routes

### `POST /api/auth/request-otp`

Body: `{ email: string, redirect?: string }`

- Normalize email (lowercase, trim).
- Validate `redirect`: only accept relative paths (`startsWith('/')`). Reject full URLs — prevents open-redirect abuse and avoids accidentally storing full URLs that fail the path check.
- Rate limit: max 3 OTP requests per email per hour. Track `request_count` and `rate_window_start` on the pending session. Delete old pending session and create new one on each request (carry over rate window state).
- Generate 6-digit OTP; store `sha256(otp)` — never plaintext.
- Generate `link_token` (random 32-byte hex) for the magic link.
- Magic link URL: `https://<host>/auth/verify?t=<link_token>` — **no redirect in URL**.
- Send OTP email via SES.
- Always return `{ ok: true }` — don't leak whether the email exists.

### `POST /api/auth/verify-otp`

Two modes:

**Magic link mode** — Body: `{ link_token: string }`
1. Look up pending session by `link_token`.
2. Check not expired.
3. Compare request IP to stored `request_ip`.
   - Match → promote session, set cookie, return `{ user, redirect }`.
   - Mismatch → return `{ needs_otp: true, email }` (bot protection fallback).

**Code entry mode** — Body: `{ email: string, otp: string }`
1. Look up pending session by `email`.
2. Check not expired.
3. Check `attempts < 5`.
4. Check `sha256(otp) === otp_hash`.
5. On failure: increment `attempts`, return `{ error, remaining }`.
6. On success: promote session, set cookie, return `{ user, redirect }`.

Both modes upsert the users record (insert-if-not-exists for new users, preserves existing `display_name`/`role`).

### `POST /api/auth/logout`

Deletes the active session record by `session_token`. Clears cookie.

### `GET /api/auth/me`

Returns `{ user: AuthSession }` or 401.

### `PATCH /api/auth/me`

Body: `{ display_name: string }`. Updates users record, returns updated session.

---

## Admin Route Protection

All `/api/admin/*` routes call `requireAdmin(request)` at the top of each handler.

Server-rendered admin routes call `getSession(request)` and redirect to login if unauthenticated:

```
// Pseudocode — server-rendered HTML route protection
session = getSession(request)
if not session:
  url = parse(request.url)
  redirect = "/login?redirect=" + encodeURIComponent(url.pathname + url.search)
  return redirect response to loginUrl

if session.role != 'admin':
  return 403 "admin account required"
```

Client-side admin layouts use the `useAuth()` hook and redirect to `/login?redirect=<pathname>` if `user` is null, or show "admin account required" if authenticated but not admin.

---

## Client-Side Integration

```
// Pseudocode — client-side auth hook
function useAuth():
  returns {
    user: AuthSession | null   // current user or null if unauthenticated
    loading: boolean           // true during initial fetch
    logout: async function     // calls POST /api/auth/logout, clears cache
    mutate: function           // allows optimistic cache population (for post-login flow)
  }
```

Backed by the project's client-side data fetching library (SWR, React Query, etc. — see `stack.md`). Fetches `/api/auth/me`. `mutate` is exposed so the verify flow can optimistically populate the cache before navigation.

---

## Email Templates

**OTP email:**
- Subject: `Your {app_name} sign-in code: {OTP}`
- Body: code + magic link + expiry notice. Plain text for initial implementation.
- Magic link: `https://<host>/auth/verify?t=<link_token>` — no OTP, no redirect path in URL.
- Sent via Amazon SES.

---

## Environment Variables Required

```
DATABASE_URL=<connection string for the project's database — see stack.md>
USER_ID_SEED=<random string — changing this invalidates all user_ids>
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=<key>
AWS_SECRET_ACCESS_KEY=<secret>
SES_FROM_EMAIL=noreply@{app_domain}
```

---

## Security Notes

- OTPs are stored as `sha256(otp)` — never plaintext.
- Session tokens are 32 random bytes (256 bits of entropy), hex-encoded.
- `HttpOnly` cookie prevents XSS token theft on web.
- Rate limiting (3/hr) on OTP requests prevents email-as-spam-vector abuse.
- 5-attempt lockout on OTP verification prevents brute force.
- `SameSite=Strict` cookie prevents CSRF.
- Magic link does not embed OTP or redirect path in URL.
- IP check on magic link blocks email scanner bots from consuming tokens.
- `redirect` field only accepts relative paths — no open-redirect via full URLs.

---

## Email Health Re-verification

When the email provider reports a bounce or a user has received multiple emails with zero clicks, flag `email_health` on the users record:

- **On bounce:** immediately flag `email_health = "bounced"` — next auth-gated action shows an "Update your email address" prompt.
- **On no-click** (≥3 sends, 0 clicks): flag `"unresponsive"` — show soft nudge in account area.

SES bounce/complaint notifications can be received via SNS webhook. See AWS SES documentation for configuration.

---

## Gotchas

1. **Clearing pending-only fields on promotion:** When promoting a session from pending to active, make sure the database actually removes (nullifies) the pending-only fields (`otp_hash`, `link_token`, etc.). Some ORMs silently ignore setting a field to `null` or `undefined` — test this explicitly with your ORM/driver.

2. **Auth cache race on login redirect:** The most common auth bug is navigating before the client-side auth cache is populated. Always set the cache optimistically THEN navigate. See "Client Auth Cache Race Condition" section.

3. **Full URL vs relative path in redirect:** `request.url` in most server frameworks includes protocol and host. Always extract `pathname + search` for the redirect value, not the full URL.

4. **Cookie domain scope:** The session cookie should NOT set a `Domain` attribute — this scopes it to the exact host, which is the most restrictive (and safest) default.

5. **TTL cleanup:** If the database doesn't support TTL indexes natively, implement a scheduled cleanup job that runs hourly and deletes sessions where `expires_at < now`.

---
