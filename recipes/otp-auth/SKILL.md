---
name: otp-auth
description: >
  Use when implementing passwordless email-OTP authentication. No passwords, no
  OAuth — verified email + persistent session is the only identity primitive.
  Covers the data model, API routes, magic-link bot protection, session
  promotion pattern, auto-join orgs by domain, and the LOCALHOST_AUTH_BYPASS
  dev bypass that lets engineers skip OTP entirely on localhost.
provides: [auth]
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
  user_id:       string;       // opaque random hex, minted on first login (NOT derived from email)
  email:         string;       // unique index; mutable from admin tools
  display_name:  string;       // defaults to email local part on first login
  role:          string;       // 'user' | 'admin' | 'superadmin' | custom slug
  email_health:  "ok" | "bounced" | "unresponsive";
  status?:       "active" | "suspended";
  created_at:    Date;
  updated_at:    Date;
}
```

**Indexes:**
- `{ email: 1 }` unique — login lookup is by email; uniqueness is the only thing that prevents two users colliding on the same address
- `{ user_id: 1 }` unique — internal references (chat senders, audit log resource_ids, FK columns) all key on this

#### Identity vs. contact: keep them decoupled

`user_id` is an **opaque random hex** (`crypto.randomBytes(32).toString("hex")`) minted once on first login. It is NEVER derived from email. Email is the *contact method*; user_id is the *identity primitive*. Conflating them — e.g. `user_id = sha256(USER_ID_SEED + email)` — looks clever but quietly makes "change my email" indistinguishable from "create a new account, abandon the old one's chat history / org memberships / audit trail." That is the wrong default.

The lookup pattern in `promoteSession` is: find user by `email`; if missing, mint a fresh `user_id`; if present, reuse the existing `user_id`. Email becomes a mutable contact column behind a unique index, and the admin user-CRUD UI can edit it without breaking anything downstream.

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
// Blocks suspended users (user.status === "suspended") and soft-deleted users
// (user.deleted_at set — field added by the admin-user-crud skill).
async function getSession(request: Request): Promise<AuthSession | null>;

// Throws Error("Unauthorized") if no session
async function requireSession(request: Request): Promise<AuthSession>;

// Throws Error("Unauthorized") or Error("Forbidden")
async function requireAdmin(request: Request): Promise<AuthSession>;

// Permission slug check — implicit for system roles, DB lookup for everything else.
// See admin-roles-crud/SKILL.md for the permissions catalog and roles collection shape.
async function hasPermission(session: AuthSession, slug: string): Promise<boolean>;
async function requirePermission(request: Request, slug: string): Promise<AuthSession>;

// Maps Error("Unauthorized") -> 401, Error("Forbidden") -> 403, else 500
function authError(err: any): Response;
```

`hasPermission` resolves system roles implicitly (no DB read needed):

```ts
async function hasPermission(session, slug) {
  if (session.role === "superadmin") return true;
  if (session.role === "admin") return !slug.includes("superadmin");
  const roleDoc = await db.collection("roles").findOne({ name: session.role });
  return !!roleDoc?.permissions?.includes(slug);
}
```

The implicit branch means superadmin/admin documents store **empty** `permissions` arrays — see `admin-roles-crud/SKILL.md` for the seeding pattern. Storing explicit perms on system roles creates stale snapshots when the catalog changes.

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

## LOCALHOST_AUTH_BYPASS — Dev Bypass

In development, requiring OTP just to reach an admin page is friction that adds nothing — the local DB is already isolated. A single env var opens **the admin gate** on dev machines. **It is a gate-only flag**: it does NOT fabricate a user identity. When set, an unauthenticated request is still unauthenticated — it's just allowed past the admin gate (server-side `requireSession`/`requireAdmin` and the client-side admin/platform layouts). The public site, `useAuth`, and `/api/auth/me` continue to report "no session" until you actually log in.

```ts
// Only the literal string "true" enables the bypass. Any other value — missing,
// empty, "false", "1", "yes", typos — keeps auth enforced. This is the whole
// point: if the variable ever drops out of the environment on a production
// deploy (forgotten --set-env-vars flag, rotated config, etc.), the service
// fails CLOSED to "auth required" instead of open to "bypass on."
const LOCALHOST_BYPASS = process.env.LOCALHOST_AUTH_BYPASS === "true";

// Synthetic session attached ONLY to admin-gated server handlers, so they have
// SOMETHING to attribute writes to in dev. It is never returned by getSession
// and never reaches the client — see /api/auth/me below.
const BYPASS_SESSION: AuthSession = {
  user_id:      "localhost",
  email:        "localhost@localhost",
  display_name: "Localhost",
  role:         "admin",
};

// getSession does NOT bypass. It reflects real session state only. /api/auth/me
// calls this — so an unauthenticated visitor on a dev machine shows as logged
// out everywhere (public site, profile page, useAuth), which is what you want
// for testing logged-out UX.
export async function getSession(request: Request): Promise<AuthSession | null> {
  // ...normal token extraction, DB lookup, rolling expiry...
}

// requireSession/requireAdmin DO bypass. They are the server-side gate for
// /api/admin/** and /api/platform/** handlers — the bypass lets those routes
// answer 200 in dev without an OTP login. The synthetic session is attached
// so handler code still has session.user_id / session.role to read.
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

### `/api/auth/me` — bypass flag, not bypass user

`/api/auth/me` calls `getSession` (which does NOT bypass). When there is no real session AND the bypass is on, it returns a sentinel `{ user: null, bypass: true }` so the client knows the admin gate is open in dev. The client uses this in `useAuth` and the admin/platform layouts; it never displays the synthetic user.

```ts
export async function GET(request: Request) {
  const session = await getSession(request);
  if (!session) {
    if (process.env.LOCALHOST_AUTH_BYPASS === "true") {
      return Response.json({ user: null, bypass: true });
    }
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  // ...normal: load user doc, return { user }
}
```

```ts
// lib/useAuth.ts
interface MeResponse { user: AuthUser | null; bypass?: boolean }

export function useAuth() {
  const { data, ... } = useSWR<MeResponse>("/api/auth/me", fetcher, ...);
  return { user: data?.user ?? null, bypass: !!data?.bypass, ... };
}
```

The admin/platform layouts then read both flags (`admin-routing/SKILL.md` § LOCALHOST_AUTH_BYPASS passthrough):

```tsx
const { user, bypass, isLoading } = useAuth();
if (isLoading) return null;
if (!user) {
  if (bypass) return <Slot />;       // gate open in dev, no fabricated identity
  return <Redirect href="/login?redirect=..." />;
}
```

**Behavior when active:**
- Server-side `requireSession` / `requireAdmin` return `BYPASS_SESSION` so /api/admin/** and /api/platform/** answer 200 without a real session.
- `getSession` and `/api/auth/me` are NOT bypassed when there is a real cookie present, and return `{ user: null, bypass: true }` (not the synthetic user) when there isn't.
- `useAuth` returns `user: null, bypass: true` on a dev machine with no real session — the public site and `/profile` show logged-out UX, which is the whole reason this is gate-only.
- Admin/platform client layouts treat `bypass` as "allow through without a user." Per-page admin chrome (avatar, "Signed in as", etc.) should render gracefully against `user: null` — it's a dev convenience, not a logged-in state.
- The OTP endpoints stay real, with one dev affordance: `request-otp` is untouched, and `verify-otp` runs the full flow but **skips only the hash comparison** — any 6-digit code is accepted (see § verify-otp code validity below). Real login still creates a real session, after which `user` is non-null and the bypass flag is irrelevant.
- DB writes from /api/admin/** in bypass mode are attributed to `user_id: "localhost"` so test data is identifiable. **Do not** invent a `users` row for `localhost` — the synthetic session exists only in memory.

### verify-otp code validity — any 6-digit code passes in dev

The gate-only bypass carries no user identity, so anything that needs a REAL user (org membership, invitations, role-specific UI) still requires an actual login. To remove the read-the-email step from that loop, `verify-otp` honors the same flag by **skipping only the hash comparison**:

```ts
// Inside POST /api/auth/verify-otp, manual-entry path — AFTER the pending
// session is found, unexpired, and under the attempts cap:
//
// In dev with the localhost bypass on, accept ANY 6-digit code so you can log
// in as a real pending user without reading the console/email. Only the literal
// "true" enables it (fail-secure, dev-only). The pending session must still
// exist + be unexpired; we only skip the hash comparison.
const bypassOtp =
  process.env.LOCALHOST_AUTH_BYPASS === "true" && /^\d{6}$/.test(otp);
if (!bypassOtp && sha256(otp) !== pending.otp_hash) {
  await sessions.updateOne({ _id: pending._id }, { $inc: { attempts: 1 } });
  return Response.json({ error: "Incorrect code", ... }, { status: 400 });
}
```

What this deliberately does NOT relax: the pending session must exist (you still `request-otp` first — no session is fabricated), expiry and the attempts cap still apply, the submitted value must still be a well-formed 6-digit code, and promotion runs the normal path (real session, real user, auto-join, redirect). The magic-link path (`link_token`) is untouched — it has no code to compare. Dev loop: request a code for any real user, type `000000`, you're them.

**Setting up:**
- Dev `.env.local`: `LOCALHOST_AUTH_BYPASS=true` (opt-in to skip OTP for admin pages).
- Production: omit the variable entirely (preferred), or set `LOCALHOST_AUTH_BYPASS=false`. Either way, real auth is required.

**Fail-secure orientation is the whole point.** An earlier iteration used the inverted `LOCALHOST_AUTH_REQUIRED=false` to enable the bypass. That's "fail open" — if the var gets dropped from a deploy pipeline (wrong flag, config drift, CI rewrite), auth silently disappears in production. The current `LOCALHOST_AUTH_BYPASS === "true"` check inverts the polarity so the dangerous state requires an explicit opt-in. Default behavior (absent variable, typo, empty string, `false`, `1`, `yes`) is always *auth enforced*.

**The env var IS the only guard.** There is no IP-based localhost detection. This is intentional — in production, the env var is absent, and the bypass is dead code.

**Functions NOT bypassed:** `getSession` (already), plus any helper that records pageview / analytics context — so traffic on a production server with a misconfigured env var doesn't all attribute to "localhost". E.g. a `getSessionContext()` used purely for pageview attribution should not check `LOCALHOST_BYPASS`.

### Anti-patterns

- **Bypassing inside `getSession`.** It makes every page using `useAuth` (public site, profile, search) show a fake "Localhost" user that doesn't exist in the DB. `getSession` reflects reality; the bypass lives in the gate helpers and the `/api/auth/me` sentinel.
- **Inventing a `users` row for the bypass user.** The synthetic identity exists in memory for one request. Persisting it produces a real-looking but unowned row that other code (avatar lookups, audit log, "who edited this") then trusts.
- **Returning the synthetic session from `/api/auth/me`.** Even when the bypass is on, the response is `{ user: null, bypass: true }` — not `{ user: BYPASS_SESSION }`. Returning the synthetic user re-introduces the "logged in everywhere" bug this section exists to prevent.
- **Short-circuiting the OTP endpoints beyond the hash skip.** The ONLY sanctioned relaxation is the hash-comparison skip in § verify-otp code validity — the pending-session requirement, expiry, attempts cap, code format, and the full promotion path all still run. Fabricating a session without a pending row (or auto-verifying without a `request-otp`) stops exercising the real login path in dev and invents users that never went through provisioning.

## Bootstrap Superadmin Seed

Every Goliath install seeds **`david@goliathdynamics.com`** as a `superadmin` on first DB connect. Without this, a fresh database has no admins, and the only way to bootstrap one is to log in as a regular user and then hand-edit the `users` collection — exactly the kind of out-of-band step that gets skipped, forgotten, or done wrong on a stressful day.

The seed lives in `lib/db.ts` (or `lib/db.py`), runs **once per process** behind a module-level guard, and is idempotent — re-running it on an already-seeded DB is a no-op.

```ts
// lib/db.ts
const SUPERADMIN_EMAIL = "david@goliathdynamics.com";
let seeded = false;

export async function getDb() {
  const db = await connect();
  if (!seeded) {
    seeded = true;          // set BEFORE the await so concurrent callers don't double-seed
    await ensureSuperadmin(db);
  }
  return db;
}

async function ensureSuperadmin(db) {
  const users = db.collection("users");
  const existing = await users.findOne({ email: SUPERADMIN_EMAIL });
  const now = new Date();

  if (!existing) {
    await users.insertOne({
      user_id:      crypto.randomBytes(32).toString("hex"),  // opaque hex, NOT derived from email
      email:        SUPERADMIN_EMAIL,
      display_name: "David",
      role:         "superadmin",
      email_health: "ok",
      status:       "active",
      created_at:   now,
      updated_at:   now,
    });
    return;
  }

  // Idempotent self-heal: if the row exists but was demoted (test fixture, manual edit,
  // restored backup), promote it back. Don't touch user_id, email, or created_at.
  if (existing.role !== "superadmin" || existing.status === "suspended" || existing.deleted_at) {
    await users.updateOne(
      { email: SUPERADMIN_EMAIL },
      {
        $set: { role: "superadmin", status: "active", updated_at: now },
        $unset: { deleted_at: "", deleted_by: "" },
      },
    );
  }
}
```

**Why lazy-on-connect, not a separate `npm run seed` step.** A migration-style seed script is a second thing developers have to remember to run after `git pull`, after `mongo restore`, after wiping a test DB. Wiring the seed into `getDb()` means **every code path that touches the DB also guarantees the superadmin exists** — first API request, first admin route, first test setup, all of it. The guard is a module-level boolean, not a DB lookup, so the cost after the first call is one branch.

**Set `seeded = true` *before* the `await`**, not after. If two requests race the first connect, both pass the `if (!seeded)` check; only flag-before-await prevents both from racing the insert. The `existing` check inside `ensureSuperadmin` is the second line of defense.

**Self-heal on demotion is intentional.** Test fixtures often reset `users.role` to `"user"` for assertion clarity, and restored backups can predate a role change. Auto-promoting `david@goliathdynamics.com` back to `superadmin` on next boot means there is exactly one source of truth for the bootstrap account, and it lives in the seed function — not in tribal knowledge about "remember to re-grant David after a restore."

**Don't seed any other accounts here.** Bootstrap is one row. Test users belong in test fixtures; staff accounts belong in `POST /api/admin/users` invoked by an admin who is already logged in.

**The dev bypass session (`localhost@localhost`) is NOT a real user.** It exists only inside `LOCALHOST_BYPASS` and is never written to the `users` collection. The seed creates `david@goliathdynamics.com` as a real, durable superadmin row that survives turning the bypass off and logging in for real via OTP.

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

### Dev OTP delivery: log the code to the server console

In dev, the email transport (SES, Postmark, Resend) is usually not configured — SMTP creds are prod-only. Without a delivery channel, the OTP is unreachable and the login flow can't be tested at all unless you bypass auth entirely (which defeats the point of testing the *real* flow). The fix is to write the plaintext OTP to the server console:

```python
# inside request-otp, after generating the OTP and inserting the pending session
print(f"[OTP] {email} → {otp}  (link: {magic_link})")
```

```ts
// or in TS — unmistakable banner so the code is easy to spot in a busy log
console.log(
  `\n========================================\n[DEV OTP] ${email}\n  code:  ${otp}\n  link:  ${magicLink}\n========================================\n`,
);
```

Use a visually distinct banner, not a JSON log line. In a busy dev terminal with Metro output, DB index notices, and SWR polling logs, a one-line `{ level: "info", otp: "123456", ... }` vanishes into the stream and developers complain "I don't see the code anywhere". The `====` separator + line breaks makes the code impossible to miss when you tab back to the terminal.

### Warn when the email transport isn't configured

In dev, the OTP only reaches the developer through the console banner above. If someone pulls the project fresh, hasn't set the `AMAZON_SES_*` vars yet, and also doesn't know to look at the terminal, they end up clicking "Send Code" and staring at a blank input wondering why no email arrived. Surface an explicit warning when the provider is unconfigured and only attempt the send when all required vars are present:

```ts
import { isSesConfigured, sendEmail } from "@/lib/ses";

if (!isSesConfigured()) {
  console.warn(
    "[auth/request-otp] SES not configured — OTP will only be printed to the server console. " +
    "Set AMAZON_SES_ACCESS_KEY_ID, AMAZON_SES_SECRET_ACCESS_KEY, and AMAZON_SES_FROM to enable email delivery.",
  );
} else {
  try {
    await sendEmail({ to: email, subject, text, html });
    console.log(`[auth/request-otp] SES send ok → ${email}`);
  } catch (err) {
    console.error("[auth/request-otp] SES send failed:", err);
  }
}
```

The warning is named so engineers can grep for it (`SES not configured`). Without it, the silent "no email arrives" state is indistinguishable from the rate-limit and bot-path states, and the developer has no signal pointing at the actual cause.

**Log the silent-success and silent-early-return paths too.** The outer route always returns `{ ok: true }` (no-leak rule), which means every failure mode — rate limit hit, invalid email body, SES accepted-but-silent, SES rejected — produces the same HTTP response. Without logs, "no email arrived" is indistinguishable from any of them. Emit a line at each branch:

```ts
// invalid/missing email
console.warn("[auth/request-otp] missing or invalid email in body — no-op");

// rate-limit early return
console.warn(
  `[auth/request-otp] rate limit hit for ${email} (${prevCount}/${RATE_LIMIT_PER_HOUR} in last hour) — silent no-op`,
);

// SES success — confirms the send call returned without throwing
console.log(`[auth/request-otp] SES send ok → ${email}`);
```

A SES `200` from the SDK is not proof of delivery (could be suppressed, bounced, or blocked by a config set the IAM user can't use), but it IS proof the request left your server. When a user reports "no email arrived," the presence/absence of `SES send ok` is the fastest way to bisect *your* side vs. AWS's side.

Engineers tail the dev server log, copy the 6 digits into the verify form, and exercise the real request-otp / verify-otp paths end-to-end. The plaintext OTP is *also* persisted on the pending session doc as `otp` (alongside `otp_hash`) so a quick `db.sessions.findOne({ email })` works as a fallback when the log scrolled past.

**Guardrails:**

- **Gate the log on `NODE_ENV !== "production"`** (or the equivalent Python check). Production logs are aggregated, archived, and indexed by services that are not always trusted with auth secrets. A stray prod log line containing a live OTP plus the email it belongs to is a credential leak.
- **The plaintext `otp` field on the session doc is also dev-only.** Verification reads `otp_hash`, never the plaintext. If the project is security-sensitive, drop the `otp` field from the insert and rely on log-only delivery; verification still works because `sha256(submitted) === otp_hash` is the source of truth.
- **Don't log the `link_token`** unless you also log the magic link URL. The token alone is useless without the verify endpoint shape; the URL is what's actually copy-pastable.
- **Email transport failure in dev should be silent.** If SES is misconfigured and the send call throws, the request-otp handler still returns `{ ok: true }` (per the no-leak rule above) — but the engineer needs to know the code is in the log, not in their inbox. The console.log is the *primary* delivery channel in dev, not a fallback.

**This pattern is intentionally not behind `LOCALHOST_AUTH_BYPASS=true`.** That bypass opens the admin gate and (per § verify-otp code validity) waves any 6-digit code past the hash check. The dev console log is for the case where you *want* to test the real code comparison (e.g. you're debugging the IP check, the rate limiter, or the redirect-survives-promotion path) without needing prod email creds — so it must work with the bypass OFF.

### `POST /api/auth/verify-otp`

Body is one of: `{ link_token: string }` (magic link) or `{ email, otp }` (manual entry).

**Magic link mode:**
1. `sessions.findOne({ link_token, status: "pending" })`. Not found or expired → `{ error: "Invalid or expired link" }` (400).
2. **Pending cookie check (primary bot protection):** if `getPendingTokenFromRequest(request) === body.link_token`, skip the IP check entirely and proceed to `promoteSession()`. A scanner bot cannot possess the `HttpOnly; SameSite=Strict` pending cookie — only the real browser session that requested the OTP has it.
3. **IP check (fallback for cookie-less cases):** only when the pending cookie is absent or mismatched, compare `getRequestIp(request)` to `pending.request_ip`.
   - Match → call `promoteSession()`
   - Mismatch → return `{ needs_otp: true, email: pending.email }` (200)
4. On success: set `Set-Cookie: makeSessionCookie(session_token)` AND `clearPendingCookie()`. Return `{ user, redirect }`.

**Code entry mode:**
1. Normalize email.
2. Prefer lookup by pending cookie: `sessions.findOne({ link_token: pendingCookieToken, email, status: "pending" })`. Fall back to `{ email, status: "pending" }` if pending cookie is absent.
3. Not found or expired → `{ error: "Code expired. Request a new one." }` (400).
4. `attempts >= 5` → `{ error: "Too many attempts. Request a new code." }` (400).
5. `sha256(otp) !== pending.otp_hash` → `$inc: { attempts: 1 }`, return `{ error: "Incorrect code", remaining: 5 - (attempts + 1) }` (400).
6. Success → `promoteSession()`, set cookies, return `{ user, redirect }`.

### Bot protection: pending cookie first, IP check as fallback

Email security scanners (corporate antivirus, antispam services) click every link in incoming emails for malware preview. Without protection, the scanner clicks the magic link from a server IP, the OTP gets consumed, and the user can't log in.

**The primary guard is the pending cookie**, not the IP. When `verify-otp` receives a magic link request, it first checks whether `getPendingTokenFromRequest(request)` matches `body.link_token`. If it does, the request is definitely from the same browser session that requested the OTP — the `HttpOnly; SameSite=Strict` cookie is inaccessible to scanner bots and cannot be forged via cross-site requests. Auto-verify immediately.

**IP check is the fallback** for when the pending cookie is absent (e.g., user clicked the link on a different device than where they requested OTP). Only in that case compare `getRequestIp(request)` to `pending.request_ip`. Mismatch → `{ needs_otp: true, email }` → client falls back to manual code entry.

**Do not use IP check as the primary guard.** IP-only bot protection causes 100% failure in common legitimate scenarios: IPv4 vs IPv6 loopback inconsistency in dev servers, corporate proxies that change the client IP between requests, and email clients opening links in different browser contexts. The pending cookie is a cryptographically-tied session proof; the IP is a network address that can vary for entirely legitimate reasons.

### `promoteSession()` — in-place promotion

```ts
async function promoteSession(db, pending) {
  const session_token = randomToken();
  const now = new Date();
  const expires_at = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const email = pending.email.toLowerCase().trim();

  // Lookup by email — the stable contact identifier.
  // Existing user: reuse their user_id (opaque hex, decoupled from email).
  // New user: mint a fresh random user_id with no relation to the email.
  const existing = await users.findOne({ email });
  if (existing?.deleted_at) {
    await sessions.deleteOne({ _id: pending._id });
    throw new Error("AccountDeleted");
  }
  if (existing?.status === "suspended") {
    await sessions.deleteOne({ _id: pending._id });
    throw new Error("AccountSuspended");
  }

  let user_id;
  if (existing) {
    user_id = existing.user_id;
    await users.updateOne({ user_id }, { $set: { updated_at: now } });
  } else {
    user_id = randomToken();   // crypto.randomBytes(32).toString("hex")
    await users.insertOne({
      user_id,
      email,
      display_name: email.split("@")[0],
      role: "user",
      email_health: "ok",
      status: "active",
      created_at: now,
      updated_at: now,
    });
  }

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

**`verify-otp` error mapping for blocked accounts.** Catch `AccountDeleted` / `AccountSuspended` from `promoteSession` and return `400 { error: "This account is no longer active." }` — same generic message for both, so the response does not reveal whether the account was soft-deleted or suspended. The pending session has already been deleted inside `promoteSession`, so the code/link cannot be retried.

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

## Magic Link Expiry — Redirect to Email Step, Not a Dead Spinner

When the `/auth/verify` page receives an expired or invalid link token, it calls `verify-otp` and gets back `{ error: "Invalid or expired link" }` (no `user`, no `needs_otp`). The wrong response is to display the error message on the verify page while leaving the `ActivityIndicator` spinning — the user sees a spinner + error and has no path forward.

**The right behavior: redirect immediately to `/login` with the error surfaced on the email input screen.**

```tsx
// verify.tsx — all error paths redirect to /login with error param
useEffect(() => {
  if (!link_token) {
    router.replace(`/login?error=${encodeURIComponent("Invalid link.")}` as any);
    return;
  }

  fetch("/api/auth/verify-otp", { method: "POST", ... })
    .then((r) => r.json())
    .then((data) => {
      if (data.needs_otp) {
        // IP mismatch — redirect to login with email pre-filled (existing behavior)
        router.replace(`/login?email=${encodeURIComponent(data.email)}` as any);
        return;
      }
      if (data.user) {
        mutate(data.user, { revalidate: false });
        router.replace(data.redirect || "/admin");
      } else {
        // Expired or revoked link — redirect to email step with error
        router.replace(
          `/login?error=${encodeURIComponent("This link has expired. Please request a new one.")}` as any
        );
      }
    })
    .catch(() =>
      router.replace(
        `/login?error=${encodeURIComponent("Something went wrong. Please try again.")}` as any
      )
    );
}, [link_token]);
```

In `login.tsx`, initialize the error state from the query param so the message appears immediately on the email input screen:

```tsx
const { redirect, error: errorParam } = useLocalSearchParams<{ redirect?: string; error?: string }>();
const [error, setError] = useState(errorParam || "");
```

This gives the user an actionable screen — they can immediately enter their email and request a new link — instead of a dead verify page with a perpetual spinner and an unexplained error.

**Anti-pattern:** `setMessage("This link has expired…")` on the verify page. The verify page has no email input, no Send Code button, and no escape hatch. The spinner keeps spinning. The user has to manually navigate to `/login` or hit the back button.

## Don't Swallow `request-otp` Fetch Failures on the Client

The server is designed to always return `{ ok: true }` so an attacker can't probe for valid emails, and the client should treat a 200 response as "move to the code-entry step". But the well-intentioned corollary — "so I'll catch any fetch error and also advance the step" — is wrong:

```ts
// BAD: silently advances even when the server is unreachable
try {
  const res = await fetch("/api/auth/request-otp", { ... });
  await res.json();
  setStep("code");
} catch {
  setStep("code"); // ← the user is now typing a code into a broken form
}
```

A thrown fetch means the request **never reached the server** — dev server down, API route unregistered (see the `stack` skill's `web.output: "server"` gotcha), network blocked by a corporate proxy, CORS misconfigured. The user sees the code input, types six digits, and the verify step also fails with a cryptic error. They have no idea the server isn't running.

Surface the error instead of masking it:

```ts
try {
  const res = await fetch("/api/auth/request-otp", { ... });
  console.log("[login] request-otp →", res.status, res.statusText);
  await res.json();
  setStep("code");
} catch (e) {
  console.error("[login] request-otp failed", e);
  setError(
    "Couldn't reach the server — check that the dev server is running and the API route is registered.",
  );
  return; // stay on the email step
}
```

The `console.log` with the response status is useful during development because it gives you a second data point: if you see `request-otp → 200` but no OTP in the terminal, the route exists but the handler threw after responding; if you see the `failed` log, the route itself is unreachable. Keep both in dev builds — strip or downgrade for prod.

## Login Form Copy — Don't Advertise Silent Sign-Up

Because the same `/login` route handles both sign-in and sign-up silently (the server upserts a user on first successful OTP), there's a tempting hint copy: "No account? One will be created automatically." **Don't ship it.** It reads as nuts to users — they expect "sign up" and "log in" to be separate concepts, not a casual byline on a login form. If they typed the wrong email, a surprise new account is worse than a friction point. The silent upsert is an implementation detail; the UI shouldn't explain it.

For the same reason, don't put "Use a different email" under the code input either. If the user mistyped the email, they reload the page. Adding a link that resets state to the email step is a feature nobody asks for, and it clutters the form with editorial voice that a login screen doesn't need.

Minimal copy on the OTP form:

- Header: "Sign in"
- Email input + Send Code button
- Code input + Verify button (auto-submits on sixth digit; see below)
- Error messages only when there's an actual error

That's it. No helper text explaining what the form does.

## Auto-Submit on Sixth Digit

The code input auto-fires `verify-otp` the moment the user types (or pastes) the sixth character. Users should not have to click a Verify button after typing six digits; it's a universally expected pattern and anything less feels broken.

```tsx
async function verifyOtp(overrideCode?: string) {
  const otpValue = (overrideCode ?? code).trim();
  if (!otpValue) return;
  // ...fetch /api/auth/verify-otp with otpValue...
}

<TextInput
  value={code}
  maxLength={6}
  keyboardType="number-pad"
  autoFocus
  onChangeText={(val) => {
    setCode(val);
    if (val.length === 6) verifyOtp(val);
  }}
  onSubmitEditing={() => verifyOtp()}
/>
```

Two gotchas:

1. **Pass the raw `val` into `verifyOtp(val)`, don't rely on reading `code` from state.** `setCode` is async — on the same tick `code` is still the 5-character previous value and the request goes out with a short OTP that fails verification. The override argument exists precisely to bypass the stale-state read.
2. **Guard against empty submissions** (`if (!otpValue) return`) because `onSubmitEditing` fires on hardware keyboard Enter even when the field is empty. Without the guard, Enter on an empty code input triggers a failed verify and wastes an `attempts` counter.

The manual Verify button is still useful as a fallback (paste a 5-character code, edit the last digit, stuck on a platform where `onChangeText` misfires) — keep it, but it shouldn't be the primary path.

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

## Amazon SES Email Transport

The email transport is Amazon SES via the v2 SDK (`@aws-sdk/client-sesv2`). Keep the provider behind a thin wrapper so `request-otp` never imports the SDK directly — that lets other transactional emails (contact-form replies, welcome mails, admin notifications) share one code path and one set of credentials.

### Install

```
npm install @aws-sdk/client-sesv2
```

`@aws-sdk/client-ses` (v1) also works but SES v2 is the current API; v1 is in maintenance mode. New code should use v2.

### Mailer wrapper (`lib/ses.ts`)

```ts
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

let cachedClient: SESv2Client | null = null;

function getClient(): SESv2Client | null {
  const accessKeyId     = process.env.AMAZON_SES_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AMAZON_SES_SECRET_ACCESS_KEY;
  const region          = process.env.AMAZON_SES_REGION ?? "us-east-1";
  if (!accessKeyId || !secretAccessKey) return null;
  if (cachedClient) return cachedClient;
  cachedClient = new SESv2Client({
    region,
    credentials: { accessKeyId, secretAccessKey },
  });
  return cachedClient;
}

export interface SendEmailArgs {
  to:      string;
  subject: string;
  html:    string;
  text:    string;
}

export async function sendEmail(args: SendEmailArgs): Promise<void> {
  const client = getClient();
  const from   = process.env.AMAZON_SES_FROM;
  if (!client || !from) {
    throw new Error("SES not configured: AMAZON_SES_* env vars missing");
  }
  await client.send(new SendEmailCommand({
    FromEmailAddress: from,
    Destination: { ToAddresses: [args.to] },
    Content: {
      Simple: {
        Subject: { Data: args.subject, Charset: "UTF-8" },
        Body: {
          Html: { Data: args.html, Charset: "UTF-8" },
          Text: { Data: args.text, Charset: "UTF-8" },
        },
      },
    },
  }));
}

export function isSesConfigured(): boolean {
  return Boolean(
    process.env.AMAZON_SES_ACCESS_KEY_ID &&
    process.env.AMAZON_SES_SECRET_ACCESS_KEY &&
    process.env.AMAZON_SES_FROM,
  );
}
```

**Why `AMAZON_SES_*` prefix, not `AWS_*`.** The AWS SDK auto-reads `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` from the environment if they exist. Using `AWS_*` means that whatever other credentials happen to be on the host (CI runner creds, Cloud Run default SA keys, a developer's personal `~/.aws/credentials`) silently leak into the SES client. Prefixing with `AMAZON_SES_*` and passing them *explicitly* into `new SESv2Client({ credentials })` makes this impossible — the client only ever uses the creds you handed it.

**Pass credentials explicitly, always.** Do not rely on the SDK's default credential chain for SES. The explicit `credentials: { accessKeyId, secretAccessKey }` parameter is the guard.

**Module-level client cache.** `SESv2Client` is HTTP-keep-alive-friendly — reuse it across requests. The `cachedClient` closure means the first request pays the TLS handshake cost; subsequent requests reuse the connection. Don't instantiate inside `sendEmail`.

**Deliver both HTML and text parts.** SES will pick whichever the recipient's client prefers; corporate antispam scanners penalize HTML-only sends. The wrapper forces both parameters to be provided.

### Email template — OTP mail

Inline all CSS — email clients strip `<style>` blocks unpredictably, and most strip external stylesheets entirely. Table-based layout is the only reliably-rendering structure across Gmail, Outlook, Apple Mail.

```tsx
function renderOtpEmail({ otp, magicLink }: { otp: string; magicLink: string }): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:32px 16px;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1d1d1f;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;">
      <tr><td style="padding:32px 32px 16px 32px;">
        <h1 style="margin:0 0 8px 0;font-size:20px;font-weight:600;">Your sign-in code</h1>
        <p style="margin:0 0 24px 0;color:#6e6e73;font-size:14px;">Use this code to finish signing in.</p>
        <div style="font-size:32px;font-weight:700;letter-spacing:8px;text-align:center;padding:16px;background:#f5f5f7;border-radius:8px;margin-bottom:24px;">${otp}</div>
        <p style="margin:0 0 8px 0;font-size:14px;">Or click to sign in:</p>
        <p style="margin:0 0 24px 0;"><a href="${magicLink}" style="color:#0071e3;word-break:break-all;">${magicLink}</a></p>
        <p style="margin:0;color:#86868b;font-size:12px;">This code and link expire in 1 hour. If you didn't request this, you can safely ignore this email.</p>
      </td></tr>
    </table>
  </body>
</html>`;
}
```

**Put the OTP code in the subject line too** (`Your sign-in code: 123456`). Most mobile mail clients render the subject on the lock-screen notification; users can read the code without even opening the email. Mail clients that auto-detect OTPs from subjects (iOS, some Android) will offer one-tap autofill.

**Always include a plain-text part.** Corporate antispam scanners score multipart-with-text higher than HTML-only, and accessibility tools require it. The `text` parameter on the wrapper is mandatory, not optional.

### AWS-side prerequisites

SES needs three things set up on the AWS side before the code path works. Each is a separate failure mode with a distinct error message:

1. **Verified sending identity.** Either a verified domain (with DKIM CNAMEs in DNS) or a single verified sender email. Unverified → `MessageRejected: Email address is not verified`.
2. **Out of sandbox.** New SES accounts can only send to verified recipients until production access is requested and granted. In sandbox → silent delivery failure to real users. Check: SES Console → Account dashboard.
3. **IAM policy permitting `ses:SendEmail` / `ses:SendRawEmail` on the identity** (and the configuration set, if one is attached — see below). Missing → `AccessDeniedException: User ... is not authorized to perform 'ses:SendEmail' on resource ...`.

### IAM policy for the SES user

Create an IAM user with programmatic access, attach this inline policy, and use those keys as `AMAZON_SES_ACCESS_KEY_ID` / `AMAZON_SES_SECRET_ACCESS_KEY`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ses:SendEmail", "ses:SendRawEmail"],
      "Resource": [
        "arn:aws:ses:<region>:<account-id>:identity/<domain-or-email>",
        "arn:aws:ses:<region>:<account-id>:configuration-set/<config-set-name>"
      ]
    }
  ]
}
```

**Include the configuration set ARN if one is attached as the identity's default.** SES attaches a default configuration set to identities for bounce/complaint tracking, dedicated IPs, or event publishing. If present, *every* send against that identity uses it, and the IAM user needs permission on both the identity AND the configuration set. Omitting the config set resource produces a misleading error: the first attempt returns "not authorized on identity/...", and after fixing that, the next attempt returns "not authorized on configuration-set/..." — two separate IAM errors for the same underlying gap.

If the config set isn't doing anything useful, detach it (SES Console → Identities → identity → Configuration set → Edit → remove default) rather than carrying the ARN in the policy.

### GCP Secret Manager — mounting credentials in production

The three sensitive values live in GCP Secret Manager (matching how other prod secrets are managed — see `mongo-uri`, `gemini-api-key`). Use kebab-case secret names:

- `amazon-ses-access-key-id`
- `amazon-ses-secret-access-key`
- `amazon-ses-from` — the full `Name <email>` string

The region (`AMAZON_SES_REGION`) is not a secret; pass it as a plain env var.

**Create the secrets:**
```bash
printf 'AKIA...'             | gcloud secrets create amazon-ses-access-key-id     --replication-policy=automatic --data-file=-
printf '<secret>'             | gcloud secrets create amazon-ses-secret-access-key --replication-policy=automatic --data-file=-
printf 'App Name <noreply@x>' | gcloud secrets create amazon-ses-from              --replication-policy=automatic --data-file=-
```

`--data-file=-` + `printf` (no trailing newline) is the right pattern — `echo` adds a newline, and AWS will interpret that as part of the key/secret. `gcloud secrets create --data` (inline) leaks the value into shell history.

**Grant the runtime SA access** (same SA used for other secrets in the project):
```bash
for s in amazon-ses-access-key-id amazon-ses-secret-access-key amazon-ses-from; do
  gcloud secrets add-iam-policy-binding "$s" \
    --member=serviceAccount:<PROJECT_NUMBER>-compute@developer.gserviceaccount.com \
    --role=roles/secretmanager.secretAccessor
done
```

**Mount on Cloud Run deploy:**
```
--set-secrets=AMAZON_SES_ACCESS_KEY_ID=amazon-ses-access-key-id:latest,\
AMAZON_SES_SECRET_ACCESS_KEY=amazon-ses-secret-access-key:latest,\
AMAZON_SES_FROM=amazon-ses-from:latest
--set-env-vars=AMAZON_SES_REGION=us-east-1
```

The `:latest` pin means rotating a secret (adding a new version) takes effect on the next Cloud Run revision without redeploy-time edits. If you want immutable pins for auditability, use explicit version numbers instead.

## Environment Variables

```
MONGO_URI=<connection string>
LOCALHOST_AUTH_BYPASS=true       # dev only — any non-"true" value (missing, empty, false, typo) enforces auth
NODE_ENV=production              # controls Secure cookie flag and magic link protocol

# Amazon SES — see § Amazon SES Email Transport
AMAZON_SES_ACCESS_KEY_ID=<iam-access-key>
AMAZON_SES_SECRET_ACCESS_KEY=<iam-secret>
AMAZON_SES_REGION=us-east-1
AMAZON_SES_FROM=App Name <noreply@example.com>
```

In production, the three `AMAZON_SES_*` secret values come from Secret Manager; `AMAZON_SES_REGION` is a plain env var.

## Fit-to-Project

- **DB driver:** native MongoDB driver only for auth collections. If the rest of the project uses Mongoose, that's fine — just keep `sessions` and `users` on the native driver.
- **Email transport:** default is Amazon SES via `@aws-sdk/client-sesv2` behind the `lib/ses.ts` wrapper described above. Match the project's existing transactional email provider if one is already wired — the wrapper interface (`sendEmail({ to, subject, html, text })` + `isSesConfigured()`) is provider-agnostic enough to swap Postmark, Resend, etc. without changing the `request-otp` call site.
- **Cookie name prefix:** use the app's slug (e.g. `docpost_session`, `filament_session`) so multiple apps on the same parent domain don't collide
- **Roles:** `role` is a plain string column. If the project has a `roles` collection or RBAC service, integrate the lookup in `requireAdmin` / `hasPermission`.
- **Session middleware:** in framework-specific apps (Next.js, Expo Router, etc.), wrap the existing layout/middleware pattern — don't introduce a new auth library

## FastAPI / Python Variant

When the backend is FastAPI + Motor instead of Expo Router `+api.ts`, the same auth model applies with these adaptations. Collections, cookie format, session lifecycle, and dev bypass are identical.

Reference implementation: `influencer-studio/twp.react/api/lib/auth.py` and `api/routers/auth.py`.

### Auth Helpers (`lib/auth.py`)

```python
from dataclasses import dataclass

@dataclass
class AuthSession:
    user_id: str
    email: str
    display_name: str
    role: str

BYPASS_SESSION = AuthSession(
    user_id="localhost", email="localhost@localhost",
    display_name="Localhost", role="admin",
)

async def get_session(request) -> Optional[AuthSession]:
    """Returns AuthSession or None. Rolls expiry forward."""
    if LOCALHOST_BYPASS: return BYPASS_SESSION
    # ... parse cookie, lookup session, check expiry, lookup user ...

async def require_session(request) -> AuthSession:
    if LOCALHOST_BYPASS: return BYPASS_SESSION
    session = await get_session(request)
    if not session: raise PermissionError("Unauthorized")
    return session

async def require_admin(request) -> AuthSession:
    if LOCALHOST_BYPASS: return BYPASS_SESSION
    session = await require_session(request)
    if session.role not in ("admin", "superadmin"):
        raise PermissionError("Forbidden")
    return session

def auth_error_response(err):
    """Map PermissionError to HTTP status codes."""
    from fastapi.responses import JSONResponse
    msg = str(err)
    if msg == "Unauthorized": return JSONResponse({"error": "Unauthorized"}, status_code=401)
    if msg == "Forbidden": return JSONResponse({"error": "Forbidden"}, status_code=403)
    return JSONResponse({"error": "Internal server error"}, status_code=500)
```

**Route handler pattern:** each endpoint wraps the session call in try/except:

```python
@router.get("/me")
async def get_me(request: Request):
    try:
        session = await get_session(request)
        if not session:
            return JSONResponse({"error": "Unauthorized"}, status_code=401)
        return {"user": {...}}
    except Exception as e:
        return auth_error_response(e)
```

### Granular RBAC (`has_permission` / `require_permission`)

The Python variant adds permission-level checks beyond role-level `require_admin`:

```python
async def has_permission(session: AuthSession, slug: str) -> bool:
    if session.role == "superadmin": return True
    if session.role == "admin": return "superadmin" not in slug
    # Custom roles: lookup permissions array from roles collection
    role_doc = await db["roles"].find_one({"name": session.role})
    return slug in (role_doc.get("permissions") or [])

async def require_permission(request, slug: str) -> AuthSession:
    session = await require_session(request)
    if not await has_permission(session, slug):
        raise PermissionError("Forbidden")
    return session
```

### Router file (`routers/auth.py`)

All auth endpoints in one `APIRouter(prefix="/auth")`:

```python
router = APIRouter(prefix="/auth", tags=["auth"])

@router.post("/request-otp")   # OTP issuance
@router.post("/verify-otp")    # Magic link + code entry
@router.get("/me")             # Current user
@router.patch("/me")           # Update display_name, chat_language, etc.
@router.post("/logout")        # Session deletion
```

Cookies are set via `response.headers["Set-Cookie"]` (manual, not FastAPI's `response.set_cookie`) to maintain exact parity with the TS implementation's cookie format.

### Session promotion (Python)

Same in-place `$set` / `$unset` pattern. The Python variant uses `random_token()` for new user_ids (decoupled from email) rather than `derive_user_id(email)`:

```python
async def promote_session(pending: dict) -> dict:
    user = await users.find_one({"email": email})
    if user:
        user_id = user["user_id"]  # reuse existing
    else:
        user_id = random_token()   # new users get random, not email-derived
    # ... same $set/$unset pattern as TS ...
```

### Key differences from TS

| Concern | Expo Router (TS) | FastAPI (Python) |
|---------|-------------------|-------------------|
| Error type | `throw new Error("Unauthorized")` | `raise PermissionError("Unauthorized")` |
| Session type | `interface AuthSession` | `@dataclass AuthSession` |
| Cookie API | `response.headers.set("Set-Cookie", ...)` | `response.headers["Set-Cookie"] = ...` |
| Permission checks | Role-level only (`requireAdmin`) | Role + permission slugs (`require_permission(request, "users.edit")`) |
| New user_id | `crypto.randomBytes(32).toString("hex")` — opaque, decoupled from email | `random_token()` — opaque, decoupled from email |
| Config source | `process.env` | `os.environ.get()` |

## Anti-Patterns

- **Mongoose for sessions/users** — silent field stripping has caused production redirect bugs. Use the native driver.
- **`doc.field = undefined; doc.save()`** to remove a field — does not work in Mongoose. Always use `updateOne({ $unset: { field: "" } })`.
- **Delete-and-insert on session promotion** — loses `redirect` and any other state. Always update in place.
- **Revealing rate limits or invalid emails** — `request-otp` must always return `{ ok: true }`, even on internal error or rate limit hit.
- **Storing OTP or redirect in the magic link URL** — only store `link_token`. The OTP is for manual fallback; the redirect is in the DB.
- **Using IP check as the primary (or only) magic link bot guard** — IP comparison fails in common legitimate cases: IPv4 vs IPv6 loopback in dev (`::1` vs `127.0.0.1`), corporate proxies, email clients in different network contexts. The result is 100% failure of the magic link flow. Use the pending cookie as the primary guard: if `getPendingTokenFromRequest(request) === body.link_token`, auto-verify without any IP check. Fall back to IP only when the cookie is absent.
- **No `attempts` cap** — without a limit, brute-forcing a 6-digit OTP succeeds in ~500k tries.
- **`SameSite=Lax` instead of `Strict`** — opens CSRF on cookie-bearing requests.
- **Deriving user_id from email** (e.g. `sha256(seed + email)`) — looks stable, breaks the moment a user wants to change their email. The hash output is identity, the email is contact, and conflating them turns "edit my email" into "abandon the old account." Mint user_id as opaque hex on first login; look up by email; let the email column be mutable behind a unique index.
- **Deriving user_id from session token** — session tokens rotate, user_id must not. Mint as opaque hex once, never recompute.
- **Fail-open dev bypass** — naming the env var `LOCALHOST_AUTH_REQUIRED=false` to turn the bypass on (so `true` or absent means "auth required") is fail-open. If the variable ever drops out of a deploy (wrong flag, config drift, CI rewrite), auth silently disappears. Use `LOCALHOST_AUTH_BYPASS === "true"` so the dangerous state requires an explicit opt-in and everything else — absent, empty, `false`, `1`, `yes`, typos — is auth enforced.
- **Bypassing analytics/pageview helpers with LOCALHOST_BYPASS** — those should always require a real session token so production traffic isn't mis-attributed to "localhost".
- **Requiring a manual Verify click after six digits are entered** — auto-submit on `val.length === 6` is universally expected from OTP inputs and anything less feels broken. Keep the button as a fallback.
- **Calling `verifyOtp()` with no argument after `setCode(val)`** in the `onChangeText` handler — `setCode` is async, so `code` is still the 5-character previous value on the same tick and the request sends a truncated OTP. Accept an optional `overrideCode` argument and pass `val` directly.
- **No empty-string guard in `verifyOtp`** — hardware-keyboard Enter fires `onSubmitEditing` on an empty input, triggers a failed verify, and burns an `attempts` counter. Early-return on `!otpValue`.
- **A Login/Sign In CTA in the auth navbar on the login screen itself** — the user is already on the login screen; the button navigates to the page they're already on. Drop the right-side cluster on auth-screen navbars entirely; keep only the brand/home link.
- **`catch { setStep("code") }` on the client `request-otp` call** — a silent advance masks "the dev server isn't running" and "the API route 404s" as "the server accepted your email". The user ends up typing OTP codes into a dead form. Surface the error and stay on the email step.
- **No SES-missing warning when provider env vars are absent** — the silent "no email arrives" state becomes indistinguishable from rate limit, bot path, and normal operation. Emit a grep-able warning (`SES not configured`) when the key check fails in the request-otp handler.
- **Using `AWS_*` env var names for SES credentials** — the AWS SDK's default credential chain will silently pick up whatever `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` are on the host (CI runner creds, Cloud Run default SA, a developer's `~/.aws/credentials`). Prefix with `AMAZON_SES_*` and pass them *explicitly* into `new SESv2Client({ credentials })` so the only creds used are the ones you handed over.
- **Instantiating `SESv2Client` inside the send function** — throws away TLS keep-alive across requests. Cache the client in a module-level `let` and reuse it.
- **Missing the `configuration-set/*` ARN in the SES IAM policy** — when the identity has a default config set attached (common for bounce/complaint tracking), `ses:SendEmail` needs permission on both the identity AND the config set. Omitting it produces a two-stage IAM error: you fix the identity resource, retry, and a new error appears for the config set. Include both ARNs up front, or detach the config set if it isn't earning its keep.
- **Logging only the SES failure path, not the success path** — because `request-otp` always returns `{ ok: true }`, a missing `SES send ok → <email>` log is the only signal that the send never actually left your server. Log both branches.
- **No plain-text MIME part in OTP emails** — HTML-only sends get downranked by corporate antispam, fail accessibility requirements, and deliver worse to mail-client dark-mode rendering. The `sendEmail` wrapper takes `text` and `html` both as required arguments, not one-or-the-other.
- **Storing the OTP only in the email body, not the subject line** — mobile lock-screen notifications render the subject; users can read the code without opening the email, and iOS/Android autofill can one-tap it into the form. Subject: `Your sign-in code: 123456`.
- **Committing `AMAZON_SES_SECRET_ACCESS_KEY` to the repo** — even a `.env.prod` committed to a private repo leaks the keys to anyone with repo access (contractors, future team rotation, a stolen laptop). In production, always resolve secrets from Secret Manager via `--set-secrets`, and keep a matching `.env.local.example` in the repo with placeholders so new developers know which vars to populate locally.
- **JSON-line dev OTP log instead of a visible banner** — one-line structured logs vanish into Metro / DB / SWR output in a busy terminal. Use `====` separators and line breaks so the code is impossible to miss when you tab back to the terminal.
- **"No account? One will be created automatically." hint text on the login form** — reads as nuts to users. The silent upsert on first OTP is an implementation detail, not user-facing copy. Ditto "Use a different email" — if they mistyped, they reload; it's not worth the editorial voice.
- **Showing the expired-link error on the `/auth/verify` page** — the verify page has no email input and no Send Code button; showing an error there leaves the user stranded with a spinning `ActivityIndicator` and no path forward. Instead, redirect immediately to `/login?error=<message>` and initialize the login form's error state from that query param so the message appears on the email input screen, where the user can act on it.

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
