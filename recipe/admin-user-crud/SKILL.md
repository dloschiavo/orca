---
name: admin-user-crud
description: >
  Use when building an admin interface for managing users — paginated list with
  search/filters, detail view with sessions + audit history, editable role and
  display name, session revocation, email-health reset, and a tiered delete
  policy (soft-delete for users, hard-delete for admins, superadmin
  undeletable). Works directly against the otp-auth `users` / `sessions`
  collections and defines a shared `audit_log` collection usable by other admin
  features.
dependencies:
  requires: [admin-routing]
  capabilities:
    auth: otp-auth
    design-system: admin-only-notus
provides: [user-admin]
---

# Admin CRUD of Users

Administrative UI for managing the `users` and `sessions` collections owned by `otp-auth`. Admins list, inspect, edit, revoke sessions for, reset email health on, and delete user accounts. Every mutation lands in an `audit_log` collection that this skill defines.

This skill does NOT re-declare the `users` / `sessions` schemas — it is a consumer of `otp-auth`. If you are implementing both, read `otp-auth/SKILL.md` first.

## Bootstrap Superadmin

`otp-auth`'s `getDb()` seeds **`david@goliathdynamics.com`** as a `superadmin` on first DB connect (see `otp-auth/SKILL.md` § Bootstrap Superadmin Seed). Do not re-implement that seed here, and do not add a "create initial admin" wizard to this UI — the bootstrap row is guaranteed to exist by the time any admin route is reachable.

The implication for this skill: **list and detail views must always render that row correctly** even before any human has logged in. In particular:

- The "last admin" guards (`cannot_demote_last_admin`, `cannot_delete_last_admin`) protect the seeded row on day one, so a fresh install with one superadmin can't accidentally lock itself out via the admin UI.
- The DELETE handler's `cannot_delete_superadmin` rule applies to David's row exactly like any other superadmin — there is no "founder" exemption to wire in.
- Soft-deleting or suspending the seeded user is pointless: the next process restart re-promotes it (the otp-auth seed self-heals demotions). Don't expose UI affordances that imply otherwise.

## Role Hierarchy

Three roles matter here:

| Role | Can edit others | Can hard-delete | Can be deleted |
|---|---|---|---|
| `user` | no | no | soft-delete only |
| `admin` | yes | yes | hard-delete only (by another admin or superadmin) |
| `superadmin` | yes | yes | **never** |

Custom role slugs from the `roles` collection are treated as `user` for the purposes of this skill unless they explicitly escalate (handled by `requireAdmin` / `requirePermission` in the stack).

Enforcement lives in the route handlers — don't push it into the UI alone.

## Data Model

### Shared collections owned by `otp-auth`

`users` and `sessions` are defined in `otp-auth/SKILL.md`. This skill reads and mutates them; it does not alter their shape. Relevant fields:

```ts
interface IUser {
  user_id:       string;                              // opaque hex; never derived from email
  email:         string;                              // unique index; mutable from this admin UI
  display_name:  string;
  role:          string;                              // "user" | "admin" | "superadmin" | custom
  email_health:  "ok" | "bounced" | "unresponsive";
  status?:       "active" | "suspended";
  created_at:    Date;
  updated_at:    Date;
}

interface ISession {
  status:        "pending" | "active";
  user_id?:      string;                              // active-only
  session_token?: string;                             // active-only
  email:         string;
  expires_at:    Date;                                // TTL index
  last_used_at?: Date;
  // ...see otp-auth/SKILL.md for the full shape
}
```

**Revoking a session = deleting it.** There is no `revoked_at` field. The `sessions` collection has a TTL index on `expires_at`, so any row present is presumed live; removing the document is revocation. This matches how `otp-auth` handles suspension and is the single source of truth — inventing a `revoked_at` flag would leave dangling active sessions whenever TTL fires.

**Email health** uses the `otp-auth` vocabulary (`"ok" | "bounced" | "unresponsive"`). Do not introduce `"healthy"`, `"complaint"`, or `"unsubscribed"` — if the project needs finer-grained states, amend `otp-auth/SKILL.md` first so both skills stay in sync.

### `audit_log` collection (owned by this skill)

```ts
interface IAuditLogEntry {
  _id:            ObjectId;                           // default Mongo _id, not a string
  actor_id:       string;                             // user_id of the acting admin; "localhost" for dev bypass
  actor_email:    string;                             // denormalized for the audit UI (admins get deleted too)
  action:         string;                             // see action vocabulary below
  resource_type:  string;                             // "user" here; other skills use their own
  resource_id:    string;                             // e.g. target user_id
  changes?:       Record<string, { old: any; new: any }>;
  metadata?:      Record<string, any>;                // action-specific extras (revoked_count, target_email on delete, etc.)
  timestamp:      Date;
}
```

**Indexes:**
- `{ resource_type: 1, resource_id: 1, timestamp: -1 }` — per-resource history (the detail page's Audit tab)
- `{ actor_id: 1, timestamp: -1 }` — "what has this admin been doing"
- `{ timestamp: -1 }` — global feed

**No TTL.** Audit log is append-only and permanent. If size becomes a concern, archive offline — don't expire.

**Action vocabulary** (strings, lowercase, snake_case):

| action | resource_type | changes | metadata |
|---|---|---|---|
| `user_created` | `user` | — | `{ email, role, display_name }` |
| `user_updated` | `user` | fields that actually changed (including `email` rename) | — |
| `user_soft_deleted` | `user` | — | `{ target_email }` |
| `user_hard_deleted` | `user` | — | `{ target_email, target_role }` |
| `user_sessions_revoked` | `user` | — | `{ revoked_count }` |
| `user_email_health_reset` | `user` | `{ email_health: { old, new: "ok" } }` | — |

Other admin skills (prompt queue, CMS, chat moderation) are expected to append to this same collection with their own `resource_type` values.

**Redaction.** Never include password hashes, session tokens, OTP hashes, or billing PII in `changes`. The write helper should allow-list fields explicitly:

```ts
const AUDITABLE_USER_FIELDS = new Set(["email", "display_name", "role", "email_health", "status"]);
```

`email` is in the allow-list because admins can edit it from the detail page (see PATCH below). The audit row records `{ old, new }` so account-takeover investigations can see the rename trail.

Anything outside the allow-list is dropped from `changes` before insert.

### Soft-delete representation

Soft-deleted users are marked on the existing `users` document, not moved to a separate collection:

```ts
interface IUser {
  // ...existing fields...
  deleted_at?:    Date;                               // set on soft delete
  deleted_by?:    string;                             // admin user_id
}
```

All reads that back user-facing features must filter `{ deleted_at: { $exists: false } }`. The admin list view has a toggle to include soft-deleted users; the detail view shows the badge and offers a "Restore" action.

Soft delete revokes sessions as a side effect (delete all session docs for that user_id). A soft-deleted user attempting to log in via OTP is rejected inside `otp-auth`'s `promoteSession` — that skill reads `users.deleted_at` and throws `AccountDeleted`, which `verify-otp` surfaces as a generic "This account is no longer active" error. Installing this skill is what activates that code path; without `admin-user-crud`, `deleted_at` is never set and the check is dead code.

## Route Layout

Stack conventions: Expo Router `+api.ts` files, native `mongodb` driver, `requireAdmin` / `authError` from `lib/auth.ts`.

**Canonical admin path scheme.** Every admin page in the project lives at `app/(app)/admin/{name}/index.tsx` with a single-noun sidebar label. Do not flat-file these as `admin-users.tsx` — the mixed scheme drifts breadcrumbs, sidebar matching, and recipe references. Pair this skill with siblings under the same scheme:

| Path | Sidebar label | Recipe |
|---|---|---|
| `/admin/users` | Users | this skill |
| `/admin/orgs` | Organizations | `admin-roles-crud` |
| `/admin/chat` | Chat | `chat-support` |
| `/admin/prompts` | Prompts | `admin-prompt-queue` |

```
app/(app)/admin/users/index.tsx                   List + new-user modal
app/(app)/admin/users/[user_id]/index.tsx         Detail + edit form

app/api/admin/users/index+api.ts                  GET list, POST create
app/api/admin/users/[user_id]/index+api.ts        GET detail, PATCH update, DELETE
app/api/admin/users/[user_id]/restore+api.ts      POST restore (soft-deleted only)
app/api/admin/users/[user_id]/revoke-sessions+api.ts   POST
app/api/admin/users/[user_id]/reset-email-health+api.ts POST
```

Every handler starts with the same guard, exactly as `cms/SKILL.md` uses for write routes:

```ts
try {
  const admin = await requireAdmin(request);
  // ...
} catch (err) {
  return authError(err);
}
```

`requireAdmin` in `otp-auth` accepts both `admin` and `superadmin`. That is the only gate needed for the read routes; mutation routes add role-hierarchy checks on top (see below).

## Routes

### `POST /api/admin/users`

Admin-initiated user creation. The OTP login flow auto-creates accounts on first login, so this endpoint exists for the cases where an admin needs to seed an account before the user ever logs in (org bootstrap, internal staff, support escalation).

**Body:**

```ts
{
  email:         string;                             // required, normalized to lowercase + trimmed
  display_name?: string;                             // defaults to email local part
  role?:         string;                             // defaults to "user"
  email_health?: "ok" | "bounced" | "unresponsive";  // defaults to "ok"
  status?:       "active" | "suspended";             // defaults to "active"
}
```

**Validation order — return the first failure:**

1. Email is present, includes `@`, normalized.
2. **Email collision.** `users.findOne({ email })` exists → 409 `email_already_exists`. Even soft-deleted users count — the `users.email` unique index forbids the second insert anyway, this is just the friendlier error path.
3. **Granting superadmin.** `body.role === "superadmin" && admin.role !== "superadmin"` → 403 `cannot_grant_superadmin`. Same rule as PATCH.

On success: mint a fresh `user_id` (`crypto.randomBytes(32).toString("hex")` — see `otp-auth/SKILL.md` on identity-vs-contact), insert the user, audit `user_created` with `metadata: { email, role, display_name }`. The new user has no sessions; they log in normally via OTP and get reused on first promote (`promoteSession` looks them up by email, finds them, reuses the user_id).

### `GET /api/admin/users`

List users with pagination, search, and filters.

**Query params:**

```
limit            1–200, default 50
offset           >=0, default 0
sort_by          one of: created_at | updated_at | email | display_name | role | last_active
sort_order       asc | desc, default desc
search           substring match against email + display_name (case-insensitive)
role             exact match (any string slug, not just user/admin)
email_health     ok | bounced | unresponsive
status           active | suspended
include_deleted  "true" to include soft-deleted users; default excludes them
created_after    ISO datetime
created_before   ISO datetime
```

**Response:**

```ts
{
  users: Array<{
    user_id:             string;
    email:               string;
    display_name:        string;
    role:                string;
    email_health:        string;
    status?:             string;
    created_at:          Date;
    updated_at:          Date;
    deleted_at?:         Date;
    last_active:         Date | null;     // max(sessions.last_used_at) where status === "active"
    active_sessions_count: number;        // count of sessions with status === "active"
  }>;
  pagination: { limit: number; offset: number; total: number; has_more: boolean };
}
```

**Implementation notes:**

- `search` uses case-insensitive substring match. On MongoDB: `{ $or: [{ email: { $regex: escaped, $options: "i" } }, { display_name: { $regex: escaped, $options: "i" } }] }`. **Escape the input** — regex metacharacters in user-typed search strings are a footgun.
- `last_active` and `active_sessions_count` enrichment: one aggregation pipeline over `sessions` grouped by `user_id`, then merged into the user rows client-side. Do not N+1 with one session query per user — that scales badly on the first admin with 10k users.
- Sorting by `last_active` requires a join-shaped query. Either denormalize `last_active` onto the user doc on session activity, or run a `$lookup` aggregation. Denormalization is simpler; update `users.last_active_at` in the same code path that touches `sessions.last_used_at` in `otp-auth`.
- Soft-deleted users are excluded by default. `include_deleted=true` returns them with the `deleted_at` field present.

### `GET /api/admin/users/:user_id`

Full detail for one user.

```ts
{
  user: IUser;                                       // full doc, including deleted_at if soft-deleted
  sessions: Array<{                                  // active sessions only, sorted by last_used_at desc
    session_token_prefix: string;                    // first 8 chars of session_token; never return the full token
    created_at: Date;
    last_used_at: Date;
    expires_at: Date;
    // note: otp-auth does not currently store ip / user_agent on sessions;
    // add those fields to otp-auth first if the detail UI needs them
  }>;
  audit_log: IAuditLogEntry[];                       // resource_type: "user", resource_id: user_id, limit 100 desc
}
```

**Never return the full `session_token`.** Returning it would let an admin impersonate by copying the token into their own cookie, bypassing the impersonation audit trail that `user-impersonation` (when installed) provides. Return a prefix for display only.

### `PATCH /api/admin/users/:user_id`

Update editable fields.

**Body (all optional):**

```ts
{
  email?:        string;                             // normalized; uniqueness checked
  display_name?: string;                             // 1–255 chars, trimmed
  role?:         string;                             // any role slug
  email_health?: "ok" | "bounced" | "unresponsive";
  status?:       "active" | "suspended";
}
```

**Email change.** Email is editable here precisely because `user_id` is decoupled from email (see `otp-auth/SKILL.md`). The change-email path:

1. Normalize: `String(body.email).toLowerCase().trim()`. Reject if missing `@`.
2. **Collision check.** `users.findOne({ email: newEmail, user_id: { $ne: target.user_id } })` → 409 `email_already_exists`. Without this, the unique index throws a generic Mongo error and the UI surfaces it badly.
3. Update + audit. The audit row records `{ email: { old, new } }` so account-takeover investigations can replay rename history. There is no re-verification step in v1 — admin edit is the trusted path. If the project needs verification-on-change, route through `otp-auth` instead and gate the actual write on a confirm-from-new-address callback.

**Role-change guards** — enforce in this order, return the first failure:

1. **Self-demotion.** An admin or superadmin cannot change their own role to anything non-admin. `admin.user_id === target.user_id && !isAdminRole(body.role)` → 400 `cannot_demote_self`.
2. **Touching a superadmin.** Only a superadmin can modify another superadmin's role (or any other field). `target.role === "superadmin" && admin.role !== "superadmin"` → 403 `cannot_modify_superadmin`.
3. **Promoting to superadmin.** Only a superadmin can grant `superadmin`. `body.role === "superadmin" && admin.role !== "superadmin"` → 403 `cannot_grant_superadmin`.
4. **Last-admin protection.** Demoting the last `admin`/`superadmin` is refused. Compute `adminCount = users.countDocuments({ role: { $in: ["admin", "superadmin"] }, deleted_at: { $exists: false } })`; if `adminCount <= 1 && target is that admin && !isAdminRole(body.role)` → 403 `cannot_demote_last_admin`.

`display_name` is trimmed before write. Reject empty-after-trim.

**On success:** update, then insert an `audit_log` row with `action: "user_updated"` and `changes` populated for only the fields that actually changed (strip no-op updates so the history isn't noisy).

### `DELETE /api/admin/users/:user_id`

Tiered delete. The behavior depends on the target's role.

```
target.role === "superadmin"
  -> 403 cannot_delete_superadmin (always, even for another superadmin)

target.role === "admin"
  -> hard delete (admin or superadmin caller only)
  -> last-admin protection applies: if target is the only admin+superadmin, refuse with cannot_delete_last_admin

target.role otherwise
  -> soft delete: set deleted_at, deleted_by; revoke all sessions; keep the row
```

**Hard delete of an admin:**

1. Delete all session documents for `user_id`.
2. Insert `audit_log` row with `action: "user_hard_deleted"`, `metadata: { target_email, target_role: "admin" }`. **Insert the audit row before deleting the user** — if the user delete succeeds and the audit insert fails, you lose the record; if the audit insert happens first and the user delete fails, you have a harmless orphan audit entry to reconcile.
3. Delete the user document.
4. Cascade deletes for any FK-linked collections the project owns (chat messages, CMS items authored, etc.) are project-specific and should be wired per install — list them explicitly in the install notes, don't enumerate here.

**No MongoDB transactions required for the default install.** The stack assumes a single-node Mongo. If the project runs a replica set and cares about atomicity across collections, wrap the hard-delete path in a session transaction; otherwise the audit-first-then-delete ordering is enough.

**Soft delete of a user:**

1. Revoke sessions (delete all for `user_id`).
2. `users.updateOne({ user_id }, { $set: { deleted_at: now, deleted_by: admin.user_id, updated_at: now } })`.
3. Audit log: `action: "user_soft_deleted"`, `metadata: { target_email }`.

**Impersonation block.** If the admin's current session is an impersonation session (`lib/auth.ts` exposes this when `user-impersonation` is installed), refuse any delete with 403 `cannot_delete_while_impersonating`. Reason: an impersonation session runs as the target; a delete call from within that session is almost always a mistake or an exploit of an audit-trail ambiguity.

### `POST /api/admin/users/:user_id/restore`

Clears `deleted_at` / `deleted_by` on a soft-deleted user. Hard-deleted users cannot be restored — they're gone. Audit log: `action: "user_restored"` (add to vocabulary when implementing). No sessions are recreated; the user must log in again.

### `POST /api/admin/users/:user_id/revoke-sessions`

Deletes all session documents for `user_id` (status `"active"`). Returns `{ status: "sessions_revoked", revoked_count }`. Audit log: `action: "user_sessions_revoked"`, `metadata: { revoked_count }`.

Revocation is not instantaneous from the user's perspective — they stay logged in on the client until the next server round-trip returns 401. Documenting this in the UI ("User will be logged out on next request") is important so admins don't expect an immediate kick.

### `POST /api/admin/users/:user_id/reset-email-health`

Sets `email_health: "ok"` and writes an audit row with the previous value in `changes`. No-op if already `"ok"` — return the current state without writing.

Not a replacement for fixing whatever caused the bounce. Document in the UI:

> Reset email health only if: the user updated their address, a transient ISP issue has cleared, or the user explicitly asked to be re-enabled. Resetting on a genuinely bad address will keep sending bounced mail and hurt sender reputation.

## UI Spec

### `/admin/users` — List page

- Header: "Users", total count, "Include deleted" toggle, **"+ New User" button** that opens a modal posting to `POST /api/admin/users`. Modal handles `email_already_exists` and `cannot_grant_superadmin` errors inline.
- Filters row: search box (email/name), role dropdown, email-health dropdown, status dropdown, created-between date range. All filters drive URL query params — the page is linkable and back-button friendly.
- Table columns: email, display name, role, email health, status, last active (relative, with UTC timestamp in tooltip), active sessions, actions menu.
- Soft-deleted rows render with a muted background and a "Deleted" badge; their actions menu offers Restore instead of Delete.
- Pagination: `offset` + `limit`; "Showing N–M of T". No cursor pagination needed at this scale.
- Row actions dropdown: Open, Revoke sessions, Reset email health, Delete (or Restore). No bulk actions in v1 — bulk deletes are the kind of thing that causes outages and they are out of scope.
- Mobile: collapse role / email-health / sessions columns; show detail on row tap.

### `/admin/users/:user_id` — Detail page

- Header: back link, email as title, role badge, deleted badge if applicable, actions dropdown.
- Read-only card: `user_id` (click to copy), created, last active, status.
- Editable form: **email** (with collision-error handling), display_name, role, email_health, status. Save button disabled until dirty. Dirty-state pattern matches `cms/SKILL.md` (snapshot on load, compare, clear after save).
- Action buttons: Revoke all sessions, Reset email health, Delete user (red), plus optional Impersonate and Send password reset if those skills are installed (see Integrations).
- **Sessions** and **Audit log** render as their own full-width cards stacked below the editable form, **not** as cramped right-rail panels. Both views are tabular and benefit from horizontal space — pushing them into a sidebar makes the columns ellipsize and forces admins to expand row-by-row.
  - **Sessions card.** Table of active sessions. Each row: session_token_prefix, created_at, last_used_at, expires_at.
  - **Audit log card.** Table of `audit_log` rows for `resource_type: "user", resource_id: user_id`. Columns: timestamp (UTC), actor email, action, changes rendered inline.
- All timestamps render in UTC with a "UTC" label. Server timezone consistency is more valuable than local time in an admin tool.

### Delete confirmation

- Two-step: click Delete → modal → type `DELETE` to confirm.
- Modal text differs for soft vs. hard delete:
  - User (soft): "This account will be marked deleted and signed out of all devices. It can be restored later from the deleted-users view."
  - Admin (hard): "This admin account and all associated data will be **permanently** destroyed. This action cannot be undone."
- Modal shows the target's email prominently — display names are not unique, emails are.

## Integrations

Each is opt-in. Detect at install time; do not add UI hooks for recipes that aren't installed.

### `user-impersonation`

If installed, the detail page gains an "Impersonate user" button that calls `POST /api/admin/impersonate { user_id }`. The delete routes also read `admin.session.impersonation?.is_impersonation` to block deletes from within an impersonation context (see Delete section).

### `account-deletion`

If installed and the project wants user self-service deletion to flow through that skill's grace-period pipeline, wire the soft-delete path to call `createDeletionRequest(user_id, { initiated_by: "admin" })` instead of directly setting `deleted_at`. Leave hard-delete of admins on the direct path regardless — the grace period is a user-protection feature, not an admin-on-admin one.

### `subscription-billing`

If installed, add a Subscription tab to the detail page showing current plan, status, renewal date, with a deep link to the billing admin. Do not mutate billing state from this skill — link out.

### Password reset

If `otp-auth` exposes a "send magic link to user" admin action (or a separate password-reset skill is installed), add a "Send login link" button to the actions panel. Show the target email prominently with a warning if `email_health !== "ok"`:

> Email will be sent to user@example.com. This address is currently **bounced** — the user may not receive the link.

## Fit-to-Project

- **Last-active denormalization.** Sorting the list by `last_active` is cheap if you denormalize `users.last_active_at` in the session-activity code path. This is the recommended default. Skip it only if you know the list will stay small.
- **Audit log retention.** Append-only and permanent by default. If the project has a compliance requirement to purge, implement purge as an explicit offline job, not a TTL on the collection.
- **Role hierarchy extensions.** The `user | admin | superadmin` tier is hard-coded in the delete guards. If the project adds custom escalated roles (e.g. `moderator`), update the hierarchy check in `DELETE` and `PATCH` — don't scatter role checks across handlers. Keep the comparison in a single `canActOn(actor, target)` helper.
- **Soft-delete filter.** Every read path — not just admin — must filter `{ deleted_at: { $exists: false } }` on `users`. Audit the stack for user-reading queries when installing this skill; missed filters are how soft-deletes leak.
- **Cascade delete list.** Enumerate per-install which collections reference `user_id` and must be cleaned up in the hard-delete path. Start from `db.listCollections()` and grep each for `user_id` — don't assume.

## Anti-Patterns

- **Inventing `revoked_at` on sessions.** `otp-auth` uses TTL-based session expiry. A parallel `revoked_at` flag creates a second source of truth and leaves zombies when TTL fires first. Revocation = delete.
- **Hard-deleting regular users by default.** Soft-delete is the default because user-facing data almost always has downstream FK references (chat history, content authorship, analytics) that an admin can't enumerate from memory. Soft-delete buys time; hard-delete is reserved for admins because admin rows don't usually have the same footprint.
- **Deleting a superadmin.** Never. Even another superadmin. If removal is genuinely needed, demote first (which requires another superadmin) and then hard-delete as an admin. The two-step forces deliberate intent.
- **Returning the full session token in the detail view.** It's an impersonation bypass — an admin with token copy/paste can masquerade without tripping the impersonation audit trail. Return a prefix for display only.
- **Unescaped user-typed regex.** Search that plugs the query string straight into `$regex` both crashes on invalid regex and lets a malicious admin craft catastrophic-backtracking patterns. Escape before use.
- **N+1 session enrichment.** Querying `sessions` per user in the list route works on a dev seed and dies in production. Use one aggregation, or denormalize.
- **Logging password hashes / tokens / PII into `changes`.** Use an allow-list of auditable fields and drop everything else before insert. "Redact later" never happens.
- **Self-demotion.** Always refuse it. An admin who demotes themselves and then can't undo the change is a support ticket that wastes everyone's time; there's no legitimate reason to allow it.
- **Relying on the UI for role enforcement.** The list page can hide the Delete button for superadmins, but the DELETE handler must independently refuse. Anyone can craft a curl.
- **Skipping the audit row on "small" mutations.** Every mutation route writes one. Email-health reset is the most skipped, because it "feels" minor — and then it's the one you need in an incident review.
- **One transaction per bulk operation.** There is no bulk operation in v1. If you add one later, cap it low (≤20), audit per-row, and confirm twice.
- **Displaying times in the viewer's local tz.** An admin in PT and an admin in UTC comparing notes on "2 hours ago" is a recipe for wrong conclusions. Render UTC everywhere with an explicit label.
- **Forgetting to filter soft-deleted users in non-admin reads.** The soft-delete is useless if the login path, the "who wrote this" lookup, and the org-member list still return the user.
- **Treating email as immutable to "protect identity."** If `user_id = sha256(email)`, then yes, editing email creates a phantom new user. The fix is not to forbid email edits — the fix is to mint `user_id` as opaque hex on first login so email becomes a normal mutable column behind a unique index. See `otp-auth/SKILL.md` § Identity vs. contact.
- **Skipping the email-collision pre-check on PATCH/POST.** Letting the unique index throw works, but the resulting Mongo `E11000` error surfaces as a 500 with a stack trace, not a friendly inline error. Always pre-check `users.findOne({ email, user_id: { $ne: target.user_id } })` before the write.

## Logging

Beyond the `audit_log` collection (which is the durable admin record), also emit structured app logs on every mutation with the same `action`, `actor_id`, `resource_id`, and HTTP status. Routine ops monitoring cares about rate and failure — the audit log is for humans reviewing after the fact.
