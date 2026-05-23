---
name: otp-auth
description: >
  Use when implementing passwordless email-OTP authentication. No passwords, no
  OAuth — verified email + persistent session is the only identity primitive.
  Covers the data model, API routes, magic-link bot protection, session
  promotion pattern, auto-join orgs by domain, and the LOCALHOST_AUTH_REQUIRED
  dev bypass that lets engineers skip OTP entirely on localhost.
---

# OTP Authentication

Passwordless email OTP. A verified email tied to a persistent server session is the single identity primitive. There is no separate "register" step — completing the OTP flow IS registration.

## Critical: Don't Use ORMs for Auth Collections

Use the native MongoDB driver (`mongodb` package, `MongoClient`) for `sessions` and `users`. Mongoose and similar ORMs cache models and silently strip unrecognized fields — this has caused production bugs where `redirect` was dropped from session documents and post-login redirects broke.

The native driver stores exactly what you pass. For auth, that predictability matters more than convenience.

**Also:** `doc.field = undefined; doc.save()` does NOT remove a field in Mongoose. Only `updateOne({ $unset: { field: "" } })` reliably removes fields. Use the native driver and `$unset` everywhere — including in session promotion (see below).

## Data Models

### `sessions` collection — pending and active in one collection

A `status` field discriminates pending (pre-verification) from active (post-verification) sessions. **Pending sessions are promoted in-place to active — never delete and recreate.** Deleting and re-inserting loses fields like `redirect` that need to survive promotion.

```ts
interface ISession {
  status:        "pending" | "active";
  email:         string;
  expires_at:    Date;
  created_at:    Date;
  redirect?:     string;       // stored at request-otp time, returned in verify response

  // pending-only — $unset on promotion to active
  otp?:          string;       // plaintext OTP (dev convenience for console.log)
  otp_hash?:     string;       // sha256(otp) — used for verification
  link_token?:   string;       // 32-byte hex; in magic link URL
  request_ip?:   string;       // IP at request-otp time; used for bot check
  attempts?:     number;       // wrong OTP guesses; reject after 5
  request_count?: number;      // OTPs issued in current rate window
  rate_window_start?: Date;

  // active-only — set on promotion
  user_id?:       string;
  session_token?: string;      // 32-byte hex; stored in cookie
  last_used_at?:  Date;
}
```

**Indexes:**
- `{ expires_at: 1 }` with TTL `expireAfterSeconds: 0` — auto-deletes expired pending and active sessions
- `{ email: 1 }` — pending lookup by email
- `{ link_token: 1 }` sparse — magic link lookup
- `{ session_token: 1 }` unique sparse — primary session lookup

**Lifetimes:**
- Pending OTP: 1 hour
- Active session: 30-day rolling. `expires_at` is extended on every authenticated request. Cookie `Max-Age` is 400 days (longer than the rolling window so the cookie never outlives the DB record's authority).

Multiple concurrent sessions per user are supported (phone + laptop). New login does not invalidate other sessions.

### `users` collection — one document per user, upserted on first login

```ts
interface IUser {
  user_id:       string;       // sha256(USER_ID_SEED + email.toLowerCase())
  email:         string;
  display_name:  string;       // defaults to email local part on first login
  role:          string;       // 'user' | 'admin' | 'superadmin' | custom slug
  email_health:  "ok" | "bounced" | "unresponsive";
  status?:       "active" | "suspended";
  created_at:    Date;
  updated_at:    Date;
}
```

`user_id = sha256(USER_ID_SEED + email.toLowerCase())` — stable, anonymous, derived from the verified email. Consistent across sessions and devices. Changing the `USER_ID_SEED` env var invalidates all existing user_ids.

`role` is a plain string, not a union — lookup against a `roles` collection allows custom role slugs.

## Auth Helpers (`lib/auth.ts`)

```ts
interface AuthSession {
  user_id:      string;
  email:        string;
  display_name: string;
  role:         string;
}

// Returns AuthSession or null. Rolls expiry 30 days forward on every call.
// Blocks suspended users (user.status === "suspended").
async function getSession(request: Request): Promise<AuthSession | null>;

// Throws Error("Unauthorized") if no session
async function requireSession(request: Request): Promise<AuthSession>;

// Throws Error("Unauthorized") or Error("Forbidden")
async function requireAdmin(request: Request): Promise<AuthSession>;

// Maps Error("Unauthorized") -> 401, Error("Forbidden") -> 403, else 500
function authError(err: any): Response;
```

Cookie helpers:
```ts
const COOKIE_NAME = "<app>_session";
const PENDING_COOKIE_NAME = "<app>_pending";

// Session cookie — 400-day Max-Age, longer than the 30-day DB rolling window
function makeSessionCookie(token: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/${secure}; Max-Age=${COOKIE_MAX_AGE}`;
}

// Pending cookie — 1-hour Max-Age, matches OTP expiry
function makePendingCookie(token: string): string;
function clearPendingCookie(): string;
```

All cookies: `HttpOnly; SameSite=Strict; Path=/` + `Secure` in production. Parse the `Cookie` header manually — no library needed.

`getRequestIp(request)`: read `X-Forwarded-For` (first IP in comma-separated list), then `X-Real-IP`, then fall back to `127.0.0.1`. Works for both load-balanced production and direct local dev.

## LOCALHOST_AUTH_REQUIRED — Dev Bypass

Reference: `filament.is/app/lib/auth.ts`.

In development, requiring OTP for every page reload is friction that adds nothing — the local DB is already isolated. A single env var bypasses auth entirely on dev machines.

```ts
const LOCALHOST_BYPASS = process.env.LOCALHOST_AUTH_REQUIRED === "false";

const BYPASS_SESSION: AuthSession = {
  user_id:      "localhost",
  email:        "localhost@localhost",
  display_name: "Localhost",
  role:         "admin",
};

export async function getSession(request: Request): Promise<AuthSession | null> {
  if (LOCALHOST_BYPASS) return BYPASS_SESSION;
  // ...normal token extraction, DB lookup, rolling expiry...
}

export async function requireSession(request: Request): Promise<AuthSession> {
  if (LOCALHOST_BYPASS) return BYPASS_SESSION;
  const session = await getSession(request);
  if (!session) throw new Error("Unauthorized");
  return session;
}

export async function requireAdmin(request: Request): Promise<AuthSession> {
  if (LOCALHOST_BYPASS) return BYPASS_SESSION;
  const session = await requireSession(request);
  if (session.role !== "admin" && session.role !== "superadmin") {
    throw new Error("Forbidden");
  }
  return session;
}
```

**Behavior when active:**
- All three core helpers (`getSession`, `requireSession`, `requireAdmin`) return the bypass session before doing any work
- The bypass session is hardcoded as an admin so admin pages also work
- The OTP request/verify endpoints are not bypassed — they still work normally if you want to test the real flow
- DB writes are still attributed to `user_id: "localhost"`, so test data is identifiable

**Setting up:**
- `.env`: `LOCALHOST_AUTH_REQUIRED=false` (default in dev)
- Production: `LOCALHOST_AUTH_REQUIRED=true` (or omit — anything other than the literal string `"false"` enables real auth)

**The env var IS the only guard.** There is no IP-based localhost detection. This is intentional — in production, the env var is absent or set to `true`, and the bypass is dead code.

**Functions NOT bypassed:** any helper that records pageview / analytics context should still require a real session token, so traffic on a production server with a misconfigured env var doesn't all attribute to "localhost". E.g. a `getSessionContext()` used purely for pageview attribution should not check `LOCALHOST_BYPASS`.

## API Routes

### `POST /api/auth/request-otp`

Body: `{ email: string, redirect?: string }`

1. Normalize email: `String(rawEmail).toLowerCase().trim()`. Validate `includes("@")`.
2. Validate `redirect`: only accept if `startsWith("/")`. Reject full URLs to prevent open-redirect attacks.
3. **Rate limit:** max 3 requests per email per hour, tracked via `request_count` + `rate_window_start` on the pending session.
   - If in-window and `request_count >= 3` → return `{ ok: true }` silently (do not reveal rate limiting)
   - Otherwise carry over `request_count + 1` to the new session
4. Generate OTP: `String(randomInt(0, 1_000_000)).padStart(6, "0")` — uniform 6-digit string with leading zeros preserved.
5. Generate `link_token = crypto.randomBytes(32).toString("hex")`.
6. Capture `request_ip = getRequestIp(request)`.
7. Build `magicLink = ${proto}://${host}/auth/verify?t=${link_token}` — no OTP, no redirect in URL.
8. Insert pending session document with `otp_hash: sha256(otp)`.
9. Send OTP email (subject contains the code; body has code + magic link + expiry).
10. Return `{ ok: true }` with `Set-Cookie: makePendingCookie(link_token)`.

**Always returns `{ ok: true }` — never leaks** whether the email exists, whether rate-limited, or details of any internal error. The outer try/catch returns `{ ok: true }` even on exception.

**The pending cookie** lets `verify-otp` code-entry mode look up the pending session by `link_token` (exact match) rather than just by email. More reliable across server restarts and multi-server deployments.

### `POST /api/auth/verify-otp`

Body is one of: `{ link_token: string }` (magic link) or `{ email, otp }` (manual entry).

**Magic link mode:**
1. `sessions.findOne({ link_token, status: "pending" })`. Not found or expired → `{ error: "Invalid or expired link" }` (400).
2. **IP check (bot protection):** compare `getRequestIp(request)` to `pending.request_ip`.
   - Match → call `promoteSession()`
   - Mismatch → return `{ needs_otp: true, email: pending.email }` (200)
3. On success: set `Set-Cookie: makeSessionCookie(session_token)` AND `clearPendingCookie()`. Return `{ user, redirect }`.

**Code entry mode:**
1. Normalize email.
2. Prefer lookup by pending cookie: `sessions.findOne({ link_token: pendingCookieToken, email, status: "pending" })`. Fall back to `{ email, status: "pending" }` if pending cookie is absent.
3. Not found or expired → `{ error: "Code expired. Request a new one." }` (400).
4. `attempts >= 5` → `{ error: "Too many attempts. Request a new code." }` (400).
5. `sha256(otp) !== pending.otp_hash` → `$inc: { attempts: 1 }`, return `{ error: "Incorrect code", remaining: 5 - (attempts + 1) }` (400).
6. Success → `promoteSession()`, set cookies, return `{ user, redirect }`.

### Bot protection: why the IP check matters

Email security scanners (corporate antivirus, antispam services) click every link in incoming emails for malware preview. Without the IP check, the scanner clicks the magic link from a server IP, the OTP gets consumed, and the user can't log in. The IP comparison makes scanner clicks fall back to the manual OTP form instead of failing outright.

### `promoteSession()` — in-place promotion

```ts
async function promoteSession(db, pending) {
  const user_id = deriveUserId(pending.email);
  const session_token = randomToken();
  const now = new Date();
  const expires_at = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  // Critical: in-place update, NOT delete-and-insert
  await sessions.updateOne(
    { _id: pending._id },
    {
      $set: {
        status: "active",
        user_id,
        session_token,
        last_used_at: now,
        expires_at,
      },
      $unset: {
        otp_hash: "",
        link_token: "",
        request_ip: "",
        attempts: "",
        request_count: "",
        rate_window_start: "",
        // NOTE: redirect is NOT in $unset — it survives so verify-otp can return it
      },
    },
  );

  // Upsert user — $setOnInsert preserves existing display_name and role
  await users.updateOne(
    { user_id },
    {
      $setOnInsert: {
        user_id,
        email: pending.email,
        display_name: pending.email.split("@")[0],
        role: "user",
        email_health: "ok",
        created_at: now,
      },
      $set: { updated_at: now },
    },
    { upsert: true },
  );

  // Auto-join orgs (see below)
  await autoJoinOrgs(db, user_id, pending.email);

  const user = await users.findOne({ user_id });
  return {
    user: { user_id, email: user.email, display_name: user.display_name, role: user.role },
    redirect: pending.redirect,
    cookie: makeSessionCookie(session_token),
  };
}
```

### Auto-join orgs by domain (inside `promoteSession`)

If the email domain matches an org's `domains` array entry with `auto_join: true`, add the user as a `viewer` member. Domain validation guard: at least one existing member must have a verified email on the same domain — this prevents an empty org from auto-joining strangers off the internet.

```ts
const emailDomain = email.split("@")[1];
const autoJoinOrgs = await orgs.find({
  "domains.domain": emailDomain,
  "domains.auto_join": true,
}).toArray();

for (const org of autoJoinOrgs) {
  // Re-check the specific entry — array query can match loosely
  const entry = org.domains.find(d => d.domain === emailDomain && d.auto_join);
  if (!entry) continue;

  // Skip if already a member
  if (org.members.some(m => m.user_id === user_id)) continue;

  // Domain validation guard
  const validated = org.members.some(
    m => m.email.split("@")[1]?.toLowerCase() === emailDomain
  );
  if (!validated) continue;

  await orgs.updateOne(
    { _id: org._id },
    {
      $push: { members: { user_id, email, display_name, role: "viewer", joined_at: new Date() } },
      $set: { updated_at: new Date() },
    },
  );
}
```

### `GET /api/auth/me` and `PATCH /api/auth/me`

- `GET`: calls `getSession`, 401 if null, returns `{ user: { ...session, ...extendedFields } }`
- `PATCH`: calls `requireSession`, accepts `display_name`, `chat_language`, `push_notifications_enabled`, etc. Returns updated user.

### `POST /api/auth/logout`

Reads session token, deletes session document, clears the session cookie. Returns `{ ok: true }`.

## Client SWR Race Condition (important)

After `verify-otp` returns successfully, **populate the SWR cache before navigating**. Otherwise the destination layout mounts, calls `useAuth()`, sees `user: null`, and redirects back to login.

```ts
// In login.tsx after verify-otp:
mutate(data.user, { revalidate: false });    // populate cache without refetch
const dest = data.redirect || redirect || "/dashboard";
router.replace(dest);
```

Do NOT call `mutate()` with revalidation and then immediately `router.replace()` — the destination page mounts during the refetch and sees stale `null`.

## Redirect After Login

- Stored in DB on the pending session (`redirect` field), NOT in the URL
- Returned by `verify-otp` in the response body
- Client uses: `data.redirect || redirect_from_url || "/dashboard"`
- Only relative paths accepted: `redirect.startsWith("/")` guard in `request-otp`
- Server-rendered routes that redirect to login should pass `pathname + search`, not `request.url`, to avoid storing a full URL:
  ```ts
  const { pathname, search } = new URL(request.url);
  const redirectUrl = `/login?redirect=${encodeURIComponent(pathname + search)}`;
  ```

## Environment Variables

```
MONGO_URI=<connection string>
USER_ID_SEED=<random string — changing invalidates all user_ids>
LOCALHOST_AUTH_REQUIRED=false   # dev bypass; set to true (or omit) in production
NODE_ENV=production              # controls Secure cookie flag and magic link protocol
SES_FROM_EMAIL=noreply@<host>
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=<key>
AWS_SECRET_ACCESS_KEY=<secret>
```

## Fit-to-Project

- **DB driver:** native MongoDB driver only for auth collections. If the rest of the project uses Mongoose, that's fine — just keep `sessions` and `users` on the native driver.
- **Email transport:** match the project's existing transactional email (SES, Postmark, Resend, etc.)
- **Cookie name prefix:** use the app's slug (e.g. `docpost_session`, `filament_session`) so multiple apps on the same parent domain don't collide
- **Roles:** `role` is a plain string column. If the project has a `roles` collection or RBAC service, integrate the lookup in `requireAdmin` / `hasPermission`.
- **Session middleware:** in framework-specific apps (Next.js, Expo Router, etc.), wrap the existing layout/middleware pattern — don't introduce a new auth library

## Anti-Patterns

- **Mongoose for sessions/users** — silent field stripping has caused production redirect bugs. Use the native driver.
- **`doc.field = undefined; doc.save()`** to remove a field — does not work in Mongoose. Always use `updateOne({ $unset: { field: "" } })`.
- **Delete-and-insert on session promotion** — loses `redirect` and any other state. Always update in place.
- **Revealing rate limits or invalid emails** — `request-otp` must always return `{ ok: true }`, even on internal error or rate limit hit.
- **Storing OTP or redirect in the magic link URL** — only store `link_token`. The OTP is for manual fallback; the redirect is in the DB.
- **Skipping the IP check on magic links** — email scanner bots will burn every magic link before users see it.
- **No `attempts` cap** — without a limit, brute-forcing a 6-digit OTP succeeds in ~500k tries.
- **`SameSite=Lax` instead of `Strict`** — opens CSRF on cookie-bearing requests.
- **Deriving user_id from session token instead of email** — session_id rotates; user_id must be stable. Hash the email with a seed.
- **Forgetting LOCALHOST_AUTH_REQUIRED in production** — if the env var defaults to `"false"` and someone forgets to set it on prod, every request bypasses auth. Default behavior (env var absent) MUST require real auth.
- **Bypassing analytics/pageview helpers with LOCALHOST_BYPASS** — those should always require a real session token so production traffic isn't mis-attributed to "localhost".

## Security Notes

- OTPs stored as `sha256(otp)` for verification. Plaintext `otp` is optional — if present, only used for dev `console.log`. Strip it from `$unset` if security-sensitive.
- Session tokens: `crypto.randomBytes(32).toString("hex")` — 256 bits of entropy.
- `HttpOnly` prevents XSS token theft on web.
- Rate limit: 3 OTP requests/hour per email. Silent.
- 5-attempt lockout on OTP verification.
- `SameSite=Strict` prevents CSRF.
- Magic link URL has no OTP, no redirect path.
- IP check on magic link blocks email scanner bots.
- Suspended users (`user.status === "suspended"`) are blocked at `getSession` — existing cookies are rejected.
- All `request-otp` errors are swallowed — always returns `{ ok: true }`.
