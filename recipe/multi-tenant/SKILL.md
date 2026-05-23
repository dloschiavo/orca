---
name: multi-tenant
description: >
  Use when building a multi-tenant SaaS where users belong to one or more
  organizations and almost every resource is scoped under an org. Covers the
  organizations collection with embedded members, the URL-as-active-org
  pattern (no server-side "current org" — orgId is a route parameter on every
  request), the requireOrgMember helper with rank-based role gating
  (owner/operator/viewer), per-org domain auto-join wired into otp-auth, the
  org switcher in the navbar, the platform settings page with a "host org"
  dropdown, and the bootstrap seed for the Goliath Dynamics Inc. host org with
  david@goliathdynamics.com as the founding owner. Reference implementation:
  docpost-app.
dependencies:
  capabilities:
    auth: otp-auth
    design-system: admin-only-notus
provides: [tenancy]
---

# Multi-Tenant Organizations

A multi-tenant model where every business resource (documents, signature requests, chat rooms, billing rows, …) lives under exactly one **organization**, and access is gated by membership in that org. Consumes `otp-auth` for the user identity and the auto-join-by-domain hook.

This skill defines:

- The `organizations` collection (with members embedded as an array, not a separate collection)
- The `platform_settings` collection (single-doc-per-key config, owned by superadmins)
- `requireOrgMember(request, orgId, minRole)` — the authorization primitive every org-scoped route uses
- The org switcher UI in the navbar / sidebar and the localStorage-backed "current org" client-side hint
- A `/platform/settings` page that lets a superadmin pick the **host org** from a searchable dropdown
- A bootstrap seed that creates **Goliath Dynamics Inc.** (slug `gdi`) as an org, adds **david@goliathdynamics.com** as its owner, and pins it as the host org

Reference implementation: `docpost-app/`. Quote it freely when in doubt — it has the most production miles on this pattern.

## Critical: The Active Org Lives in the URL, Not the Session

**There is no `active_org_id` field on the user, the session, or anywhere on the server.** The org a request is operating against is communicated **as a route parameter on every API call** — `/api/orgs/[orgId]/documents`, `/api/orgs/[orgId]/members`, etc. The server *re-checks membership on every request* via `requireOrgMember`; nothing is cached across requests.

This is a deliberate departure from the more common "active_org_id on the session" pattern. Reasons:

1. **Org switching has zero server cost.** The client just changes the URL it's hitting. No `POST /api/auth/switch-org` round trip, no session row mutation, no race window where two tabs disagree about which org is active.
2. **Multiple tabs can be in different orgs simultaneously.** Tab A is in `/orgs/acme/documents`, tab B is in `/orgs/globex/documents`, and both work without one stepping on the other. A session-stored active org breaks this immediately.
3. **The auth check is the membership check.** `requireOrgMember(request, orgId)` reads `orgId` from the URL params, looks up the org, scans `org.members[]` for the caller's `user_id`, and rejects 403 if not found. There is exactly one place in the codebase where "is this user allowed to act on this org" is decided. No drift between session and reality.
4. **Crafted-URL attempts are caught by the same primitive.** A user pasting another org's ID into the URL bar hits the same `requireOrgMember` check and gets 403. There is no UI-only gate to bypass.

The client *does* keep a `localStorage["app:current_org_id"]` hint so the navbar's org switcher remembers your last selection across reloads, and so deep links default to "the org you were in last time." But that value is never trusted by the server — it only seeds the UI's initial state and decides which org-scoped pages to redirect to after login. See § Org Switcher and `useOrgs` hook below.

**Anti-pattern:** storing `active_organization_id` on the `users` doc, then reading it inside route handlers to decide what to fetch. The moment you do this, every two-tab user files a bug because tab A's switch wins and tab B silently shows the wrong data. Don't.

## Data Models

### `organizations` collection

Embed members as an array on the org doc — do **not** create a separate `org_members` collection. The denormalization is intentional (see § Why members are embedded below).

```ts
interface IOrganization {
  _id:           ObjectId;                              // default Mongo _id
  name:          string;                                // display name, e.g. "Goliath Dynamics Inc."
  slug:          string;                                // URL-friendly, lowercase, unique; e.g. "gdi"
  plan:          string;                                // FK to plans.slug (see § Plans). The recipe defines exactly one plan slug — `"host"` — used for the bootstrap org. Every other plan is project-defined in the `plans` collection.
  status:        "active" | "suspended" | "archived";  // archived hides from normal listings
  parent_id?:    string;                                // set on child / location orgs only
  domains?:      IOrgDomain[];                          // see Auto-Join below
  members:       IOrgMember[];                          // embedded array; see below
  created_at:    Date;
  updated_at:    Date;
  deleted_at?:   Date;                                  // soft-delete; matches admin-user-crud convention
  deleted_by?:   string;                                // admin user_id
}

interface IOrgMember {
  user_id:       string;                                // FK to users.user_id (opaque hex from otp-auth)
  email:         string;                                // denormalized for the members UI
  display_name:  string;                                // denormalized for the members UI
  role:          OrgRole;                               // "owner" | "operator" | "viewer" | custom slug
  joined_at:     Date;
}

interface IOrgDomain {
  domain:        string;                                // lowercased, e.g. "goliathdynamics.com"
  auto_join:     boolean;                               // matching email domain → auto-add as viewer
  added_at:      Date;
  added_by:      string;                                // user_id of the org owner who added it
}
```

**Indexes:**

- `{ slug: 1 }` unique — slug is the human-readable identifier in URLs (`/orgs/gdi/documents` reads better than `/orgs/507f.../documents`); uniqueness is enforced at the index, not in code
- `{ "members.user_id": 1 }` — multikey index on the embedded array. Powers `GET /api/user/orgs` (list orgs for current user) without scanning the whole collection. **This is the index that makes the embed-vs-separate-collection decision viable at scale.**
- `{ "domains.domain": 1 }` sparse — auto-join lookup hot path
- `{ parent_id: 1 }` sparse — child-org listings
- `{ status: 1, deleted_at: 1 }` — list filters

**Why `slug` is mandatory.** Mongo `_id` ObjectIds are opaque hex blobs. Routing to `/orgs/507f1f77bcf86cd799439011/documents` makes URLs unshareable, untypeable, and unloggable. A slug field gives every org a stable URL identity from day one. Generate the slug from the name on create (lowercase, strip non-alphanumeric, dedupe with a numeric suffix on collision), and let owners edit it from org settings.

### Why members are embedded, not a separate `org_members` collection

The first instinct is to model membership as a join table:

```
organizations    org_members(org_id, user_id, role)    users
```

This is the relational-DB reflex, and on Mongo it is wrong by default. Embedding members as an array on the org doc has three concrete wins:

1. **`requireOrgMember` is one query.** With the embedded model, "is this user a member of this org" is a single `findOne({ _id: orgId })` followed by `org.members.find(m => m.user_id === uid)`. With a join collection it's two queries (org + membership) or one aggregation, both of which are slower and noisier in logs.
2. **Org-scoped pages render in one round trip.** The page already has the full member list as a side effect of loading the org for permission checks. No second fetch for the members panel.
3. **Cascading delete is trivial.** Removing an org removes its members atomically as part of the same document. No orphan rows, no FK cascades to forget.

**The cost** is that updates to a single member (role change, last_active touch) bump the entire org doc. This is fine up to ~5,000 members per org. Past that, you have a B2B-with-massive-customers shape that needs different ergonomics anyway — at which point split it out, but **only then.** Don't pre-optimize for the customer you don't have yet.

The multikey index on `members.user_id` is the load-bearing piece. Without it, "list all orgs for this user" scans the collection. With it, it's a normal index seek. Add the index in the same migration that creates the collection — it is not optional.

### `plans` collection

Plans are **project-defined billing tiers** owned by the platform staff. The recipe enumerates exactly one plan slug — `"host"` — used to mark the bootstrap host org. Every customer-facing plan (`solo_practice`, `mid_law`, `startup`, `enterprise`, …) is created and edited by superadmins through `/platform/plans`. The recipe makes no assumptions about which other plan slugs exist; consumers MUST NOT hardcode `"free"`, `"standard"`, or any other tier into seed defaults, fallback paths, or revert logic.

```ts
interface IPlanFeature {
  slug:  string;                              // e.g. "max_users"
  name:  string;                              // human-readable in the editor
  value: number | boolean | string;
}

interface IPlan {
  _id:            ObjectId;
  slug:           string;                     // e.g. "host", "solo_practice", "mid_law"
  name:           string;                     // display label, e.g. "Solo Practice"
  price_monthly:  number;
  price_yearly:   number;
  features:       IPlanFeature[];
  is_active:      boolean;                    // false hides the plan from new-org dropdowns but does not migrate existing orgs off it
  created_at:     Date;
  updated_at:     Date;
}
```

**Indexes:**

- `{ slug: 1 }` unique — slug is the FK target from `organizations.plan`.

**Why only `"host"` is recipe-defined.** Every other plan is a business decision the platform owner makes (and changes — pricing changes, plans get renamed, plans get deprecated). Hardcoding even a single "free tier" into the recipe creates the exact bug fixed in this revision: code paths defaulted to `plan: "free"`, the project's actual plans collection contained no such slug, and orgs ended up with broken FK references to a plan that did not exist. The only plan slug the recipe is allowed to assume exists is `"host"`, because the recipe itself owns the seed that creates it (see § Bootstrap Seed below).

### `platform_settings` collection — single-key-per-doc

```ts
interface IPlatformSetting {
  _id:    ObjectId;
  key:    string;          // e.g. "host_org_id"
  value:  unknown;         // type depends on key; stringly-typed by intent
}
```

**Index:** `{ key: 1 }` unique.

**Why one doc per key, not one doc with many fields.** A single global config doc is tempting, but it makes every settings change a write that races with every other settings change, and concurrent superadmins editing different settings overwrite each other. One doc per key means each setting is independently upsertable with `findOneAndUpdate({ key }, { $set: { value } }, { upsert: true })`, which is race-safe.

Keys defined by this skill:

- `host_org_id` — the ObjectId (as string) of the org designated as the platform "host." See § Platform Settings Page.

Other skills can append their own keys (`stripe_account_id`, `support_email`, `feature_flag.X`, …) without re-declaring the collection.

### `invitations` collection

```ts
interface IInvitation {
  _id:           ObjectId;
  org_id:        string;                                // ObjectId as string
  email:         string;                                // normalized lowercase
  role:          OrgRole;                               // role to grant on accept
  display_name?: string;                                // pre-filled if the inviter knew the name
  token:         string;                                // 32-byte hex; appears in the invite URL
  invited_by:    string;                                // user_id of the org owner
  invited_at:    Date;
  expires_at:    Date;                                  // TTL: 7 days
  accepted_at?:  Date;                                  // set on acceptance
  accepted_by?:  string;                                // user_id who accepted
}
```

**Indexes:**

- `{ token: 1 }` unique — accept-invitation lookup
- `{ org_id: 1, email: 1 }` — "is there a pending invite for this address" check
- `{ expires_at: 1 }` TTL `expireAfterSeconds: 0` — auto-purge expired invites

**Token is plaintext, not hashed.** Invitations are time-bound and single-use; the threat model is "someone forwards their invitation email" (which is fine — the inviter can always revoke), not "an attacker dumps the DB and replays tokens." Hashing buys nothing and breaks "look at the URL in the email to debug why the invite isn't working."

## Authorization — `lib/tenant.ts`

This is the smallest, most-quoted file in the skill. Get it right and the rest of the skill is mechanical.

```ts
// lib/tenant.ts
import { ObjectId } from "mongodb";
import { getDb } from "./db";
import { getSession, type AuthSession } from "./auth";

export type OrgRole = "owner" | "operator" | "viewer" | string;

const ROLE_RANK: Record<string, number> = {
  owner:    3,
  operator: 2,
  viewer:   1,
};

// Custom org role slugs (created via admin-roles-crud) fall back to viewer rank
// for access-control purposes. A custom role named "admin" does NOT grant admin
// access — only the system slugs above have privilege weight.
export function roleAtLeast(actual: OrgRole, required: OrgRole): boolean {
  const a = ROLE_RANK[actual] ?? 1;
  const r = ROLE_RANK[required] ?? 1;
  return a >= r;
}

export interface OrgContext {
  session:    AuthSession;
  org:        IOrganization;
  memberRole: OrgRole;
}

export async function requireOrgMember(
  request: Request,
  orgId: string,
  minRole: OrgRole = "viewer",
): Promise<OrgContext> {
  const session = await getSession(request);
  if (!session) throw Object.assign(new Error("Unauthorized"), { status: 401 });

  const db = await getDb();
  const org = await db.collection<IOrganization>("organizations").findOne(
    ObjectId.isValid(orgId) ? { _id: new ObjectId(orgId) } : { slug: orgId },
  );
  if (!org) throw Object.assign(new Error("Organization not found"), { status: 404 });
  if (org.deleted_at) throw Object.assign(new Error("Organization not found"), { status: 404 });
  if (org.status === "suspended") {
    throw Object.assign(new Error("Organization suspended"), { status: 403 });
  }

  // Superadmin bypass: a superadmin (per otp-auth's role field) can act on any org
  // without being a member. This is what makes /admin/orgs/[id] work for support staff.
  if (session.role === "superadmin") {
    return { session, org, memberRole: "owner" };
  }

  const member = org.members.find((m) => m.user_id === session.user_id);
  if (!member) throw Object.assign(new Error("Forbidden"), { status: 403 });
  if (!roleAtLeast(member.role, minRole)) {
    throw Object.assign(new Error("Forbidden"), { status: 403 });
  }

  return { session, org, memberRole: member.role };
}

export async function requireOrgOperator(request: Request, orgId: string) {
  return requireOrgMember(request, orgId, "operator");
}
export async function requireOrgOwner(request: Request, orgId: string) {
  return requireOrgMember(request, orgId, "owner");
}
```

**Accept slug OR ObjectId in the lookup.** The route param `[orgId]` may be either, depending on which page sent the user — the org switcher writes slugs into URLs (`/orgs/gdi`), but the admin tools use ObjectIds (`/admin/orgs/507f...`). One helper, one lookup, no caller branches.

**Throw with `status` on the error object**, not custom error classes. The route handler's `authError(err)` (from `otp-auth`) reads `err.status` and maps to the appropriate Response. This stays consistent with `requireSession` / `requireAdmin` from `otp-auth` and keeps every route's catch block to one line.

**Superadmin bypasses membership entirely.** A superadmin acting via the admin tools must be able to inspect any org without first becoming a member. The bypass returns `memberRole: "owner"` so downstream code that checks "can this caller invite users" Just Works without a special "is superadmin" branch in every handler.

**Anti-pattern:** grafting an `is_org_admin` boolean onto the `users` doc as a fast path. The membership array already answers this question per-org; a second source of truth invites drift. Trust the array.

## Routes

### User-facing org routes (`/api/orgs/...`)

```
GET    /api/orgs                         List orgs the caller belongs to
POST   /api/orgs                         Create a new org (caller becomes owner)
GET    /api/orgs/[orgId]                 Get one org (membership required)
PATCH  /api/orgs/[orgId]                 Update org (owner)
GET    /api/orgs/[orgId]/members         List members + pending invitations (member)
POST   /api/orgs/[orgId]/invitations     Send invite (owner)
DELETE /api/orgs/[orgId]/members?userId  Remove a member (owner; last-owner guard)
DELETE /api/orgs/[orgId]/members?inviteId  Revoke pending invite (owner)
GET    /api/orgs/[orgId]/domains         List domains (owner)
POST   /api/orgs/[orgId]/domains         Add a domain (owner)
PATCH  /api/orgs/[orgId]/domains         Toggle auto_join on a domain (owner)
DELETE /api/orgs/[orgId]/domains?domain  Remove a domain (owner)
POST   /api/auth/accept-invitation       Accept invite token (any logged-in user)
```

Every handler is one of:

```ts
const { session, org } = await requireOrgMember(request, params.orgId);
// or
const { session, org } = await requireOrgOwner(request, params.orgId);
```

Wrapped in a `try { ... } catch (err) { return authError(err); }` from `otp-auth`. There is no other authorization style in this skill.

### Admin org routes (`/api/admin/orgs/...`)

```
GET    /api/admin/orgs                   Paginated list of all orgs (superadmin/admin)
POST   /api/admin/orgs                   Create org on behalf of someone
GET    /api/admin/orgs/[orgId]           Detail (mirrors user route + audit log)
PATCH  /api/admin/orgs/[orgId]           Edit name/slug/plan/status
DELETE /api/admin/orgs/[orgId]           Soft-delete (sets deleted_at)
POST   /api/admin/orgs/[orgId]/restore   Clear deleted_at
```

These use `requireAdmin` (from `otp-auth`), not `requireOrgMember`. The list route enriches each row with `member_count`, `host_user_count` (members of the host org), and `external_user_count` (everyone else).

### Last-owner guard

`DELETE /api/orgs/[orgId]/members` and `PATCH` (role demotion) both check:

```ts
const owners = org.members.filter(m => m.role === "owner");
if (owners.length === 1 && owners[0].user_id === targetUserId) {
  return Response.json({ error: "cannot_remove_last_owner" }, { status: 400 });
}
```

Without this, an org can lose its last owner and become unreachable from the owners' UI — only admin tools can recover it. The guard runs at delete time, not invite time, because demoting and re-promoting is a legitimate flow that the invite-time check can't anticipate.

### Accept invitation flow

```
POST /api/auth/accept-invitation { token }
```

1. `requireSession(request)` — caller must be logged in. If not, the invite UI redirects to `/login?redirect=/invite/accept?token=X` and the OTP flow returns here after success.
2. `invitations.findOne({ token })`. Not found / expired → 400.
3. `accepted_at` already set → 400 `already_accepted`.
4. **Email match check.** If `invitation.email !== session.email`, return 400 `email_mismatch`. Reason: forwarding the invite email to a friend should not let the friend join; the invite is bound to the original address.
5. `organizations.updateOne({ _id: invitation.org_id }, { $push: { members: { ...newMember } } })`.
6. Mark invite accepted.
7. Return `{ org: { _id, slug, name } }` so the client can switch into the new org.

The client then calls `setCurrentOrg(org.slug)` (see § Org Switcher) and redirects to `/orgs/${org.slug}`. The user lands directly inside their new org — no second click.

## Auto-Join By Domain

This skill defines the *domain shape* and the *enable rules*; the actual `autoJoinOrgs(...)` call lives inside `otp-auth`'s `promoteSession` (see `otp-auth/SKILL.md` § Auto-join orgs by domain). The two skills are co-designed — neither works in isolation:

1. **Adding a domain** (`POST /api/orgs/[orgId]/domains`):
   - Owner-only.
   - Reject **public free-mail providers** (`gmail.com`, `yahoo.com`, `outlook.com`, `hotmail.com`, `icloud.com`, `proton.me`, …) with auto_join=true. Maintain the blocklist as a constant in `lib/tenant.ts` and grow it as new providers cause incidents.
   - Reject domains already claimed (with `auto_join: true`) by another org. A domain can be *listed* on multiple orgs without auto_join, but only one can auto-grant membership.

2. **Toggling auto_join true** (`PATCH /api/orgs/[orgId]/domains`):
   - Validate that **at least one existing org member already has an email on that domain**. This is the cold-start guard: an empty org cannot enable auto_join on `acme.com` and then have strangers from `acme.com` join. Someone from `acme.com` must already be a member through the manual invitation path.
   - The verify-otp auto-join code re-checks this same condition at join time, as a second line of defense.

3. **At login time** (inside `otp-auth promoteSession`): the loop walks orgs with a matching domain entry, re-validates `auto_join: true` and the existing-member guard, skips orgs the user is already in, and pushes a `viewer` membership row. New members are silently added — there is no "you've been added to a new org" notification in v1; the next login lands them in their previous org and the new one shows up in the org switcher.

**Anti-pattern:** verifying domain ownership via DNS TXT records before allowing auto_join. This adds friction (most owners don't know how to edit DNS), shifts the failure mode from "you can't enable auto_join until someone joins manually" to "you can't enable auto_join until your IT department responds to a Jira ticket," and the existing-member guard already prevents the only abuse it would prevent. Do it later if you have an enterprise SKU that demands it; don't do it on day one.

## Client State — `lib/useOrgs.ts`

```ts
import useSWR from "swr";
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "app:current_org_slug";

// External store keeps every useOrgs() consumer in the same tab in lockstep.
// Without this, two components reading from localStorage independently would
// drift after a switch until SWR revalidated.
let listeners: Array<() => void> = [];
function subscribe(cb: () => void) {
  listeners.push(cb);
  return () => { listeners = listeners.filter(l => l !== cb); };
}
function getSnapshot(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(STORAGE_KEY);
}
function getServerSnapshot(): string | null { return null; }

function writeOrgSlug(slug: string | null) {
  if (typeof window === "undefined") return;
  if (slug) window.localStorage.setItem(STORAGE_KEY, slug);
  else window.localStorage.removeItem(STORAGE_KEY);
  listeners.forEach(cb => cb());
}

export function useOrgs() {
  const { data, mutate } = useSWR<{ orgs: IOrganization[] }>("/api/orgs", fetcher, {
    revalidateOnFocus: false,
  });

  const currentOrgSlug = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const orgs = data?.orgs ?? [];
  const currentOrg = orgs.find(o => o.slug === currentOrgSlug) ?? orgs[0] ?? null;

  function setCurrentOrg(slug: string | null) {
    writeOrgSlug(slug);
  }

  return { orgs, currentOrg, currentOrgSlug, setCurrentOrg, refresh: mutate };
}
```

**Why `useSyncExternalStore` and not `useState` + an effect.** A component-local `useState` only updates the component that called `setCurrentOrg`; other components reading the same value via `localStorage.getItem` in their own `useState` initializer will be stale until they re-mount. The external store pattern guarantees that all subscribers re-render synchronously when the value changes, regardless of which component triggered the change. The cost is one tiny module-level closure; the alternative is hours of "the navbar updated but the page didn't" debugging.

**Why slug, not ObjectId, in localStorage.** Same reason it's in URLs: a slug survives a DB reseed (slugs are reproducible from the seed; ObjectIds aren't). After wiping a dev DB, a stale ObjectId in localStorage 404s; a stale slug usually still works because the seed re-creates `gdi`.

**Logout clears it.** `useAuth.logout()` should call `setCurrentOrg(null)` after the session POST resolves. Otherwise the next login lands in the previous user's last org, which is a privacy footgun on shared machines.

## Org Switcher UI

The switcher renders **inside the navbar** (or sidebar — choose one and stay consistent), not inline on every page. It's a focused, authoritative dropdown — the user always knows which org they're in by glancing at the navbar.

Component shape:

```
[OrgSwitcher]
  closed:  ⌂ Goliath Dynamics ▾
  open:    🔍 [filter input]
           ─────────────────
           ✓ Goliath Dynamics    (current — checkmark in cyan)
             Acme Corp
             Globex Inc
           ─────────────────
             + Create organization     (only if user has permission)
```

Behavior:

1. Closed state shows current org name + chevron. Tap → opens.
2. Open state replaces the trigger with an auto-focused search input. Search filters by case-insensitive substring on `org.name`.
3. Dropdown is `position: absolute`, `max-height: 320`, scrolls when long.
4. The current org has a `✓` glyph in the brand cyan; clicking it just closes the dropdown.
5. Clicking another org calls `setCurrentOrg(slug)` and **navigates** to `/orgs/${slug}` (not just updates state — the URL must change so server-side org context updates).
6. **Click-outside-to-close on web only.** Use a `mousedown` listener attached to `document` and removed on close. RN's `Pressable` backdrop doesn't fire on web; the listener does.
7. The component uses `useOrgs()` for state and **never** writes to localStorage directly. All mutations go through `setCurrentOrg`.

**When the user has only one org:** render the org name as static text, not a dropdown. A switcher with one option is visual noise that implies more options exist.

**When the user has zero orgs:** render `+ Create organization` as the entire control. This is the first-run state for users who signed up via OTP without an invitation.

### Superadmin variant — text-search combobox over all orgs

The "list only orgs you're a member of" rule is for regular users. **Superadmins (per `otp-auth`'s `session.role === "superadmin"`) get a different switcher: a text-search combobox that queries every org on the platform.** They are typically members of zero or one orgs (their host org), but they need to navigate into any customer org to investigate, replicate bugs, or take support actions — and the membership-filtered switcher would render static text and strand them.

For superadmins, the trigger always opens into a search input regardless of `orgs.length`. As they type, the dropdown queries `GET /api/admin/orgs?search=<q>&limit=20` (debounced ~200ms — same pattern as the Platform Settings host-org dropdown), populated from the admin route, not from `/api/orgs`. The selected slug still navigates to `/orgs/${slug}`, and the same `requireOrgMember` superadmin bypass on the destination page lets them act inside that org without joining it.

Implementation notes:

- `useOrgs()` continues to return memberships (it is still the right hook for the rest of the app — sidebar org-scoped page links, default landing org after login, etc.). The combobox makes a *parallel* fetch when the user is a superadmin and the search input is non-empty.
- Show membership orgs at the top of the dropdown (with a "Your orgs" group header) and search results below ("All organizations") so the day-to-day path of "switch into my host org" stays one click. Empty search → just memberships, no API call.
- Hide the `+ Create organization` row in the superadmin combobox; superadmins create orgs via `/admin/orgs`, which has the full create form. Keeping it here invites two-flow drift on validation rules.
- The current-org checkmark logic still applies: highlight whichever row matches `currentOrgSlug`, even if it's in the search-results group.

**Anti-pattern:** rendering the org switcher inline at the top of every page instead of in the navbar. Consistency is the entire value — users glance at the navbar to know "where am I"; if the switcher moves around, they lose the anchor and start clicking the wrong thing.

**Anti-pattern:** giving superadmins the same membership-filtered switcher as regular users. Because superadmins typically belong to one org (the host), the `orgs.length === 1` branch fires and the switcher renders as static text — leaving them no way to navigate into customer orgs from the navbar. Detect `session.role === "superadmin"` and render the search combobox instead.

## Platform Settings Page

`/platform/settings` — superadmin-only. Lives in the `/platform/**` tree (see `admin-routing/SKILL.md` § Two trees), gated by `app/(app)/platform/_layout.tsx`. The first-class setting in v1 is the **host org dropdown**.

### What "host org" means

Goliath runs each app as a multi-tenant SaaS, but one of the orgs in every database is the *operator's own org* — the company running the platform. That org's members are "host users" (internal staff); everyone else is an "external user" (customers). The host designation drives:

- **Member classification on the admin org list.** Each org row shows `host_user_count` and `external_user_count`. Without a host org pinned, every member is "external" and the count is meaningless.
- **Future hooks.** Audit log filters, support routing, rate-limit overrides — anything that needs to distinguish "us" from "customers" reads `host_org_id` from `platform_settings`.

`host_org_id` in `platform_settings` is the **single source of truth** for "which org is the host." Do not denormalize this designation into a sentinel plan value (e.g. flipping the host's `plan` to `"host"` and the previous host's plan to `"free"`). The org's `plan` field is its billing tier — orthogonal to host status, and owned by the plans editor (`/platform/plans`). The bootstrap seed below sets `plan: "host"` on the seeded org because `"host"` is a real plan slug owned by this recipe; admins are free to reassign that org to a different plan later via the plans editor without losing host designation.

### Page UX

```
Platform Settings

  Host Organization
  ─────────────────
  The org designated as the platform operator. Members of this org are
  treated as internal staff for analytics, member counts, and support.

  ┌─────────────────────────────────────────────┐
  │ 🔍 Goliath Dynamics Inc.            ▾       │   ← combobox: search-as-you-type
  └─────────────────────────────────────────────┘
       Acme Corp
       Globex Inc
       — None —                                      ← clears the setting

  [ Save changes ]   (disabled until dirty)
```

- The combobox queries `GET /api/admin/orgs?search=...&limit=20` on every keystroke (debounced 200ms). Don't pre-fetch all orgs into a `<select>` — once the platform has 500+ orgs, a native select is unusable.
- The "— None —" option clears `host_org_id`. **Do not touch the previous host org's `plan` field on revert** — plan is the org's billing tier (see § Plans), not a host-designation flag, and there is no recipe-defined "default plan" to fall back to. Operators who want to reassign the previous host org to a customer plan do so explicitly via the plans editor.
- Save is disabled until the selection differs from the loaded value. Same dirty pattern as `cms/SKILL.md` and the user-detail page in `admin-user-crud`.
- On save, the page refetches `GET /api/platform/settings` to re-derive the dirty baseline.

### Routes

```ts
// GET /api/platform/settings
// requireAdmin (admin or superadmin)
// → { host_org_id: string | null }

// PATCH /api/platform/settings
// requireAdmin (superadmin only — host org assignment is platform-level)
// body: { host_org_id: string | null }
// side effect:
//   1. Upsert platform_settings { key: "host_org_id" } with the new value.
//      Do NOT touch any org's `plan` field here. Host designation lives in
//      platform_settings, not on the org's billing tier.
// → { host_org_id }
```

**Why superadmin-only on PATCH but not GET.** Reading the host org id is needed by every admin org list render; gating that on superadmin would force admins to call superadmin endpoints. But *changing* the host org reshapes who counts as internal staff across the entire platform — it is a superadmin-tier action.

## Plans Editor — `/platform/plans` and `/platform/plans/{id}`

Lives in the `/platform/**` tree, superadmin-only via the platform layout gate. The list page is a paginated table of `plans`; the detail page (`/platform/plans/{id}`) is the editor.

### List page

- Columns: name, slug, price (monthly), `org_count` (orgs currently on this plan, computed via aggregation on `organizations.plan`), is_active.
- Create-new is a `#new` modal on the list page (per `admin-routing` § Modal-on-mount). Form takes name; slug is derived (`name.toLowerCase().replace(/\s+/g, "_")`).
- Click a row → navigate to `/platform/plans/{slug}` (slug, not `_id`, in the URL — slugs are stable; `_id` is opaque).

### Detail page — tabs in the URL hash

The detail page is tabbed via `useHashRoute` from `admin-routing`. Tab keys:

- `#details` — name, price_monthly, price_yearly, is_active. Default tab (renders when the hash is empty).
- `#features` — feature list editor (slug + name + value triplets).
- `#orgs` — **organizations on this plan**, with a row per org and a deep link to `/admin/orgs/{org._id}`. Two affordances:
  - **Reassign an org off this plan.** Each row has a "Move to plan…" inline action that opens a small popover with the same plan dropdown used on org create (see § Org Create — Plan Dropdown). Confirming PATCHes `/api/admin/orgs/{orgId}` with the new plan slug.
  - **Add an org to this plan.** A button on the tab opens the `#orgs/add-org` modal (per the `#{tab}/{modal}` shape in `admin-routing`), which is the same searchable org combobox the host-org dropdown uses (`GET /api/admin/orgs?search=...&limit=20`). Selecting an org PATCHes `/api/admin/orgs/{orgId}` with `plan: <currentPlanSlug>`.

The orgs tab is what makes the plans editor a *first-class* tool: a superadmin can rename a plan, change pricing, and migrate every affected org without ever leaving the page or hand-rolling a Mongo update.

**Anti-pattern:** rendering an "Organizations on this plan" sidebar instead of a dedicated tab. The list grows with the platform, and a sidebar competes for vertical space with the feature/details editors. Tab-as-hash means `/platform/plans/big_law#orgs` is shareable in a support ticket — "everyone on the Big Law plan, see attached link."

**Anti-pattern:** building a separate "migrate orgs from plan A to plan B" page. The orgs tab on each plan editor is the migration surface; deleting a plan should refuse if `org_count > 0` and prompt the operator to reassign via this tab first.

### Routes — plan editor

```ts
// GET /api/platform/plans            requireAdmin → { plans: IPlan[] } each with org_count
// POST /api/platform/plans           requireAdmin (superadmin) body: { name }
// GET /api/platform/plans/{slug}     requireAdmin → { plan, orgs: [{_id, slug, name}] }
// PATCH /api/platform/plans/{slug}   requireAdmin (superadmin) body: partial IPlan minus slug
// DELETE /api/platform/plans/{slug}  requireAdmin (superadmin) — refuse if org_count > 0
```

The detail GET enriches with the orgs-on-this-plan list so the `#orgs` tab renders without a second fetch.

## Org Create — Plan Dropdown

The `plan` field on `POST /api/admin/orgs` (and any user-facing org-create form) is **not freeform text**. The form renders a `<select>` (or platform-equivalent dropdown) populated from `GET /api/platform/plans?is_active=true`. The default selection is `"host"` — the only plan slug the recipe defines — and operators must explicitly pick a customer plan for non-host orgs.

```tsx
// inside the admin-create-org modal
const { data } = useSWR<{ plans: IPlan[] }>("/api/platform/plans", fetcher);
const activePlans = (data?.plans ?? []).filter(p => p.is_active);
// <Picker selectedValue={plan} onValueChange={setPlan}>
//   {activePlans.map(p => <Picker.Item key={p.slug} label={p.name} value={p.slug} />)}
// </Picker>
```

**Server-side validation:** `POST /api/admin/orgs` and `PATCH /api/admin/orgs/{id}` MUST reject any `plan` value that does not correspond to an existing row in the `plans` collection. The unique slug index on `plans` makes this check one query: `if (!await plans.findOne({ slug: body.plan })) return 400 invalid_plan`. Skipping this lets the dropdown fall out of sync with the URL, the API, or seed scripts and silently re-introduces the "free tier that does not exist" bug.

**Anti-pattern:** defaulting `plan: "free"` (or any other non-recipe-defined slug) on org create. The only slug the recipe guarantees exists is `"host"`. Project-specific defaults are a project decision — make the field required and let the dropdown enforce it, or default to `"host"` if the form must have a default at all.

## Bootstrap Seed — Goliath Dynamics Inc.

Every Goliath install seeds **Goliath Dynamics Inc.** (slug `gdi`) as an organization, adds **`david@goliathdynamics.com`** as its `owner`, and pins it as the **host org** in `platform_settings`. This complements the superadmin user seed in `otp-auth/SKILL.md` § Bootstrap Superadmin Seed — together they guarantee that a fresh DB has both an identity to log in as and a place to land after login.

Add to the same `lib/db.ts` `getDb()` lazy-seed that owns `ensureSuperadmin`:

```ts
// lib/db.ts (continuing from otp-auth § Bootstrap Superadmin Seed)
const HOST_ORG_SLUG = "gdi";
const HOST_ORG_NAME = "Goliath Dynamics Inc.";
const SUPERADMIN_EMAIL = "david@goliathdynamics.com";

export async function getDb() {
  const db = await connect();
  if (!seeded) {
    seeded = true;                             // race guard before any await
    await ensureSuperadmin(db);                // from otp-auth
    await ensureHostOrg(db);                   // this skill
  }
  return db;
}

async function ensureHostOrg(db) {
  const orgs = db.collection<IOrganization>("organizations");
  const settings = db.collection("platform_settings");
  const users = db.collection("users");
  const now = new Date();

  const superadmin = await users.findOne({ email: SUPERADMIN_EMAIL });
  if (!superadmin) {
    // Should not happen — ensureSuperadmin runs first — but log and bail
    // rather than seed an org with no owner.
    console.error("[seed] superadmin missing; cannot seed host org");
    return;
  }

  // Match an existing host org by slug OR exact name. The name match catches
  // legacy/pre-multi-tenant rows that have the right name but no `slug` field —
  // without it, the seed inserts a second "Goliath Dynamics Inc." every boot
  // because the unique slug index does not constrain documents that lack the
  // field entirely. See § Anti-Patterns: "Inserting a second host org by
  // slug-only check".
  let existing = await orgs.findOne({
    $or: [{ slug: HOST_ORG_SLUG }, { name: HOST_ORG_NAME }],
  });
  let org = existing;

  if (!existing) {
    const insert = await orgs.insertOne({
      name:    HOST_ORG_NAME,
      slug:    HOST_ORG_SLUG,
      plan:    "host",
      status:  "active",
      members: [{
        user_id:      superadmin.user_id,
        email:        superadmin.email,
        display_name: superadmin.display_name,
        role:         "owner",
        joined_at:    now,
      }],
      domains: [{
        domain:    "goliathdynamics.com",
        auto_join: true,                       // safe: David is already a member with that domain
        added_at:  now,
        added_by:  superadmin.user_id,
      }],
      created_at: now,
      updated_at: now,
    });
    org = await orgs.findOne({ _id: insert.insertedId });
  } else {
    // Self-heal: backfill slug if missing (legacy row matched by name), then
    // ensure david is a member+owner, and the org is active with plan "host".
    //
    // If the backfill fails with E11000 on the slug index, another concurrent
    // ensureHostOrg() (or a previous run with the old slug-only check) has
    // already created a doc owning slug="gdi". In that case, we found a *second*
    // legacy duplicate — abandon the slug-backfill on this row, switch
    // `existing` to the canonical gdi row, and continue. Leave the duplicate
    // legacy row in place for ops review rather than destructively merging.
    if (existing.slug !== HOST_ORG_SLUG) {
      try {
        await orgs.updateOne(
          { _id: existing._id },
          { $set: { slug: HOST_ORG_SLUG, name: HOST_ORG_NAME, updated_at: now } },
        );
      } catch (err: any) {
        if (err?.code !== 11000) throw err;
        const canonical = await orgs.findOne({ slug: HOST_ORG_SLUG });
        if (!canonical) throw err;                  // unreachable — code 11000 implies it exists
        console.warn(
          `[seed] legacy host-org duplicate detected — _id=${String(existing._id)} ` +
          `has matching name but slug-backfill conflicts with canonical _id=${String(canonical._id)}; ` +
          `keeping canonical row and leaving the duplicate for ops review.`,
        );
        existing = canonical;
      }
    }
    // Atomic "add if missing" — guarding the push with a query predicate that
    // also requires david NOT to already be a member. Without the predicate,
    // two concurrent ensureHostOrg() calls (e.g. across Expo Router +api.ts
    // route modules whose `_seeded` flags don't share state) both read
    // members=[], both push, and the org ends with duplicate member rows.
    const pushed = await orgs.updateOne(
      {
        _id: existing._id,
        "members.user_id": { $ne: superadmin.user_id },
      },
      {
        $push: {
          members: {
            user_id:      superadmin.user_id,
            email:        superadmin.email,
            display_name: superadmin.display_name,
            role:         "owner",
            joined_at:    now,
          },
        },
        $set: { updated_at: now },
      },
    );
      // Already a member — re-read to check role, and demote-fix to owner if needed.
      const fresh = await orgs.findOne({ _id: existing._id });
      const m = fresh?.members.find(x => x.user_id === superadmin.user_id);
      if (m && m.role !== "owner") {
        await orgs.updateOne(
          { _id: existing._id, "members.user_id": superadmin.user_id },
          { $set: { "members.$.role": "owner", updated_at: now } },
        );
      }
    }
    if (existing.status !== "active" || existing.plan !== "host" || existing.deleted_at) {
      await orgs.updateOne(
        { _id: existing._id },
        {
          $set: { status: "active", plan: "host", updated_at: now },
          $unset: { deleted_at: "", deleted_by: "" },
        },
      );
    }
  }

  // Pin as host org in platform_settings (idempotent upsert).
  await settings.updateOne(
    { key: "host_org_id" },
    { $set: { key: "host_org_id", value: String(org!._id) } },
    { upsert: true },
  );
}
```

**Why the seed lives in `lib/db.ts` and not a separate `seed-platform.js` script.** Same reason as the superadmin seed in `otp-auth`: a script is something a developer has to remember to run. Wiring it into `getDb()` means *every* code path that touches the database also guarantees the host org exists — first request after `git pull`, first request after `mongo restore`, first request inside a test. The cost after the first call is one boolean check on the `seeded` flag.

**Order matters: superadmin first, then host org.** `ensureHostOrg` reads the superadmin's `user_id` to populate the members array. If you run them in parallel or in the wrong order, the host org gets seeded with a missing owner reference and the auto-join domain validation fails because no member matches the `goliathdynamics.com` domain.

**Self-heal on demotion is intentional.** Test fixtures and restored backups can leave David in a non-owner role on the seeded org. Auto-promoting back on next boot means there is exactly one source of truth for the founding owner. Same philosophy as the superadmin seed self-heal in `otp-auth`.

**The domain entry has `auto_join: true` from day one.** This is safe specifically because David (member of `goliathdynamics.com`) is in the members array at insert time, satisfying the existing-member guard. Any other employee logging in via OTP from a `goliathdynamics.com` address will be auto-added as a viewer on first login. This is the intended onboarding path for Goliath staff.

**Don't seed any other orgs here.** Bootstrap is one org. Test orgs belong in test fixtures; customer orgs belong in `POST /api/admin/orgs` invoked by an admin who is already logged in.

## Fit-to-Project

- **Slug generation strategy.** Default: lowercase the name, replace non-alphanumerics with `-`, collapse runs of `-`, trim. On collision append `-2`, `-3`, … Allow owners to edit the slug once on org creation, then lock it (rename means breaking every URL out there, including bookmarks and shared invite links).
- **Custom org roles.** This skill only defines `owner / operator / viewer`. If the project needs finer-grained roles (`accountant`, `support`), define them via `admin-roles-crud` and let `roleAtLeast` fall back to `viewer` rank — i.e. custom roles cannot escalate above viewer for built-in features. Built-in features that need to recognize a custom role have to opt in by checking the role slug directly.
- **Org-scoped collections naming.** When a feature stores data per-org, prefer `documents` (collection) + `org_id` field index over `documents_${orgSlug}` (collection-per-org). Per-org collections look organized but make admin queries impossible without iterating collection names. Keep one collection, index `{ org_id: 1, ... }`.
- **Soft-delete propagation.** When an org is soft-deleted (`admin-user-crud`-style), org-scoped reads on dependent collections must filter `{ deleted_at: { $exists: false } }` on the org join. Audit each collection on install — missed filters are how soft-deletes leak.
- **Multi-region.** Out of scope for v1. If the project expands to per-region DBs, the host org id moves from `platform_settings` to a region-level config. Don't pre-build for it.
- **`requireAdmin` vs `requireOrgMember`.** The platform-admin role from `otp-auth` (`role: "admin" | "superadmin"`) is independent of org membership. An admin can act on any org via the admin tools without joining it. An owner can act on their own org without being a platform admin. Don't conflate.

## Anti-Patterns

- **Storing `active_organization_id` on the user or session.** Multi-tab breaks instantly, the membership check has to re-validate on every read anyway, and the failure mode is "the navbar shows the wrong org and nobody can figure out why." URL is the source of truth.
- **A separate `org_members` collection.** It feels more relational and is wrong for ~95% of B2B Mongo apps. The embedded array is one query, indexes cleanly, cascades on org delete, and scales to thousands of members. Only split it out when you actually exceed those constraints.
- **Treating slug and `_id` as interchangeable everywhere.** They are interchangeable in `requireOrgMember`'s lookup, but URLs always use slug, admin tools always use ObjectId, and DB references (foreign keys) always use ObjectId. Don't store slugs as foreign keys — slugs are mutable.
- **Allowing auto_join on public free-mail providers.** `gmail.com` becomes a free pass into any org that whitelists it. Maintain the blocklist as a constant in `lib/tenant.ts` and reject at validation time. The list is short (~10 entries) and grows by ~1/year.
- **Skipping the existing-member guard on auto_join enable.** Without it, an attacker creates a one-person org, adds `acme.com` with auto_join, and harvests every Acme employee who happens to log in. The guard makes domain claims contingent on already having a stake on that domain.
- **Putting the org switcher on every page header.** Pick one location (navbar) and commit. Sprinkling switchers around the UI confuses users about which one is authoritative.
- **DNS TXT verification for domains in v1.** Friction with no payoff — the existing-member guard already prevents the only abuse it would catch. Add it later if an enterprise customer demands it.
- **Hashing invitation tokens.** They are time-bound and single-use; the threat is "someone forwards their email" (which the email-match check on accept already handles), not "an attacker dumps the DB and replays expired invites." Hashing buys nothing and breaks debuggability.
- **Letting the host org be soft-deleted.** Add a guard in `DELETE /api/admin/orgs/[id]`: if `id === host_org_id`, refuse with `cannot_delete_host_org`. The seed will re-create it on next boot anyway, but the half-second window where the platform has no host org breaks every host_user_count query.
- **Checking only `slug` in `ensureHostOrg`'s existence query.** Pre-multi-tenant rows can carry the right `name` but no `slug` field at all, and a unique index on `slug` does not constrain documents that lack the field — so a slug-only `findOne({ slug: "gdi" })` returns nothing, the seed inserts a second "Goliath Dynamics Inc.", and the org list now has a phantom dupe with empty `members[]`. Match by `{ $or: [{ slug }, { name }] }` and self-heal the missing slug on the legacy row instead of inserting alongside it.
- **Hardcoding plan slugs ("free", "standard", "enterprise") in seeds, defaults, or revert paths.** The `plans` collection is owned by the platform (`/platform/plans`) and project-defined. The only slug this recipe guarantees exists is `"host"`. Any other slug referenced in the recipe or its consumers is a foreign-key claim against a doc that may not exist — and at the moment it doesn't, every org-create / host-revert path silently writes a broken `plan` value. Default to `"host"`, require the caller to pick from the dropdown, or fail closed.
- **Denormalizing host designation into the org's `plan` field.** Forcing the host's `plan` to `"host"` and the previous host's plan to some "default" on host-swap conflates two orthogonal concerns (billing tier vs. host designation), and as soon as the project's plans collection diverges from the recipe's enum guess, the revert writes a non-existent slug. `host_org_id` in `platform_settings` is the single source of truth — read it where you need to know "is this the host."
- **Putting platform-level multi-tenant pages under `/admin/**`.** The host-org pin, the plans editor, the platform settings page, and any cross-org analytics are platform-staff-only — they belong under `/platform/**` per `admin-routing/SKILL.md` § Two trees. Putting them under `/admin/**` either widens the gate (leaking the surfaces to org owners) or grows per-page role checks (the exact drift the layout-gate rule was supposed to prevent).
- **Owner self-demotion.** Already covered by the last-owner guard, but worth restating: an org without an owner is a support ticket. Refuse the demotion, not the rescue.
- **Re-implementing membership checks per route instead of using `requireOrgMember`.** The moment two routes have different "is this user a member" logic, you have two attack surfaces. One helper, every route, no exceptions.
- **Returning the full members array on every org-list endpoint.** `GET /api/orgs` returns just the orgs the user belongs to, with `member_count` rather than the full members array. Returning all members of every org inflates the payload and leaks email addresses across orgs.
- **Forgetting to filter `status === "suspended"` in `requireOrgMember`.** Suspending an org should immediately cut off all access to org-scoped resources. The check is one line; missing it lets a "suspended" org still process API calls.

## Integrations

- **`otp-auth`** — co-required. This skill consumes `getSession`, `requireSession`, `AuthSession`, and the auto-join hook inside `promoteSession`. The bootstrap seed for the host org runs alongside the bootstrap superadmin seed inside `lib/db.ts`'s `getDb()`.
- **`admin-user-crud`** — admin tools for users; the user detail page should show "Member of N orgs" with a tab listing org slug + role + joined_at. When hard-deleting an admin user, cascade-remove their membership from every org's `members` array (audited under `org_member_removed` resource_type).
- **`admin-roles-crud`** — defines the catalog of permission slugs. Org-scoped permissions live under the `org.*` prefix (e.g. `org.invite.send`, `org.billing.edit`). The `OrgRole` slugs (`owner`/`operator`/`viewer`) are system roles and live in the same `roles` collection as the platform roles, distinguished by a `scope: "platform" | "org"` field.
- **`chat-support`** — chat rooms are org-scoped: `chat_YYYY_MM` documents carry an `org_id` field, and `requireOrgMember` gates the message send route. Ashley AI receives the org context in her prompt.
- **`admin-prompt-queue`** — queue jobs may carry `org_id` for org-scoped prompt runs; the queue UI filters by org.
- **`landing-marketing-site`** — public marketing pages are not org-scoped. The login flow lands users in their `currentOrgSlug` (or first org) after OTP success.

## Logging

Beyond the auditable mutations (which write to `admin-user-crud`'s `audit_log` with `resource_type: "org"`), emit structured app logs on every membership change:

```ts
log({
  level: "info",
  msg:   "org_member_added",
  org_id, slug, target_user_id, target_email, role, actor_id,
});
```

Membership churn is the single most useful signal for diagnosing "why can't I see this org" support tickets — it's worth its own log family even though the audit row already exists.
