---
name: admin-routing
description: >
  Use when adding ANY authenticated page to a Goliath app, or when building the
  multi-tenant organization layer those pages ride on. One recipe, two co-designed
  halves. (1) The URL contract — three authenticated trees: org-scoped workspace
  pages live SLUGGED at `/{org-slug}/{page}` (the slug segment IS the active org;
  URL = source of truth, multi-tab safe), cross-org staff tools live at
  `/platform/{page}` (admin/superadmin layout gate; superadmin-only pages
  self-gate), and `/admin/**` is the un-slugged entry tree — the post-login
  landing plus legacy redirect stubs that forward to the slugged URLs, plus the
  un-slugged staff org-CRUD (`/admin/orgs`) with its own in-page guard. Tabs ride
  the URL hash as `#{tab}`, modals as `#{modal}` with cold-load reopen; one
  client-side Shell gate per tree honors LOCALHOST_AUTH_BYPASS. (2) Tenancy —
  the `organizations` collection with embedded `members[]`,
  `requireOrgMember(request, orgId, minRole)` with owner/member roles and
  per-membership suspend, per-org `domains[]` auto-join wired into otp-auth,
  invitations, the `plans` catalog, `platform_settings` with the host-org pin,
  the URL→selector→storage active-org resolver + navbar org switcher, and the
  Goliath Dynamics Inc. (`gdi`) bootstrap seed. Supersedes the old two-tree
  admin-routing recipe and the separate multi-tenant recipe (merged here).
dependencies:
  capabilities:
    auth: otp-auth
    design-system: admin-design-system
provides: [admin-routing, tenancy]
---

# Admin Routing & Multi-Tenant Organizations

The baseline URL + auth-gate contract for every authenticated surface in a Goliath app, fused with the multi-tenant organization layer that contract encodes. The two were separate recipes (`admin-routing`, `multi-tenant`) until the org slug moved into the path — at which point "where does this page live" and "which org is this page acting on" became the same question, answered by the same URL segment. One recipe now.

The insight, in two sentences: every piece of UI state a user might share, bookmark, reload, or hit Back into — **the org, the page, the entity, the tab, the open modal — lives in the URL**, and the auth gate lives in **one shared shell per tree**, not in each route. The org slug in the path is simultaneously the routing prefix and the tenancy claim that `requireOrgMember` verifies server-side on every API call.

Reference implementation: **`diplomat/web`** (Next.js App Router) — `components/admin/Shell.tsx` (the shared gate + sidebar), `app/[slug]/(workspace)/layout.tsx` + `components/admin/WorkspaceFrame.tsx` (slug → active org), `lib/tenant.ts` (authorization), `lib/activeOrg.ts` + `lib/useOrgs.ts` (client resolver), `app/admin/page.tsx` (redirect stub pattern). docpost-app is the Expo Router predecessor with the older un-slugged two-tree shape; quote diplomat, not docpost, for anything in this recipe.

## The Three Authenticated Trees

| Tree | What lives there | Audience | Gate |
|---|---|---|---|
| `/{org-slug}/**` | **The org workspace.** Every surface that operates on ONE org's data: the org dashboard (`/{slug}/admin`), org people management (`/{slug}/users`), org knowledge base, org personas, and each product wing's pages. | Org members (role checked per-surface), platform staff via superadmin bypass | Session-only client Shell; **real enforcement is server-side `requireOrgMember` on every org-scoped API call** |
| `/platform/**` | **Cross-org staff tools.** Platform users, waitlist, plans, settings (host-org pin), feature flags, prompts, platform persona library, chat, CMS, deploy. | Platform staff only (`role ∈ {admin, superadmin}`); some pages superadmin-only | `Shell requireStaff` layout gate; superadmin-only pages self-gate in page + API |
| `/admin/**` | **The un-slugged entry tree.** `/admin` is the post-login landing that forwards to `/{org-slug}/admin`; old org-scoped paths (`/admin/users`, …) are redirect stubs to their slugged homes; plus the staff org-CRUD `/admin/orgs` (+ `/admin/orgs/{orgId}`) and grandfathered utilities (e.g. `/admin/geoip`), each carrying its **own in-page staff guard**. | Mixed — see per-page | Session-only Shell layout; staff pages guard themselves |

Two more authenticated surfaces sit outside the trees: **user-scoped pages** (`/profile`, `/account` — about the *user*, not any org; un-slugged, in an `(account)` route group rendered through the same Shell — see `user-profile`) and the **org home** `/orgs/{slug}` (landing + role hub; links into `/{slug}/admin` and `/{slug}/users`).

**Mapping rule for "where does this new page live":**

1. Does it operate on **one org's data** (its members, its KB, its conversations, its settings)? → `/{org-slug}/{page}`. The slug pins which org.
2. Does it operate **across orgs or on platform-owned resources** (every user, every org's plan, prompt templates, deploy pipeline, feature flags)? → `/platform/{page}`. Staff-only.
3. Is it about the **logged-in user** regardless of org? → un-slugged `(account)` page.
4. **Never add new pages to `/admin/**`.** That tree is the entry/redirect shim plus what history left there. The one deliberate resident is `/admin/orgs` (staff org-CRUD, linked from the Admin sidebar section, in-page staff guard); don't grow the pattern.

When in doubt, ask: *which org's data changes if I click around this page?* Exactly one → slugged. None/all → `/platform`.

**Why a slugged workspace and not "active org in the session."** See § The Active Org Lives in the URL below — multi-tab correctness, zero-cost switching, and one server-side membership check are the payoff. The URL prefix also means a sidebar can build every org-scoped link by string-prefixing the current slug, and a pasted link opens on the org it was copied from, not whatever org the recipient last touched.

**Why `/platform` is its own tree instead of staff pages scattered under `/admin`.** A single tree forces every page to either widen its gate (leaking staff surfaces to org owners) or grow per-page role checks. Splitting the prefix means the route itself encodes the audience, the layout makes one decision, and sidebar sections filter on one prefix string.

**Anti-pattern:** putting a cross-org page under `/{org-slug}/**` "because you're usually in an org anyway." The slug becomes a lie — the page ignores it, two tabs on different orgs show identical content, and the breadcrumb claims an org the data doesn't respect. The moment a page reads across orgs it moves to `/platform/**`.

**Anti-pattern:** the inverse — burying an org-scoped surface under `/platform/**` because staff also use it. Owners can't reach `/platform`; staff reach org surfaces fine via the superadmin bypass on the slugged page.

## The Org Workspace — `/{org-slug}/**` mechanics

In Next.js App Router, the workspace is a **route group nested under the dynamic segment**:

```
app/[slug]/(workspace)/layout.tsx        ← force-dynamic, robots noindex, WorkspaceFrame
app/[slug]/(workspace)/admin/page.tsx    ← org dashboard
app/[slug]/(workspace)/users/page.tsx    ← org people manager
app/[slug]/(workspace)/knowledge-base/…
app/[slug]/(workspace)/personas/…
app/[slug]/(workspace)/{product}/…       ← product wings (own recipes)
app/[slug]/page.tsx                      ← NOT the workspace — see CMS coexistence
```

```tsx
// app/[slug]/(workspace)/layout.tsx
export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function WorkspaceLayout({ children, params }) {
  const { slug } = await params;
  return <WorkspaceFrame slug={slug}>{children}</WorkspaceFrame>;
}
```

```tsx
// components/admin/WorkspaceFrame.tsx — registers the URL slug as the active org
// while any workspace page is mounted (multi-tab safe), then renders the Shell.
"use client";
export default function WorkspaceFrame({ slug, children }) {
  useEffect(() => {
    setActiveOrgFromUrl(slug);
    return () => setActiveOrgFromUrl(null); // off-org surfaces fall back to selector/storage
  }, [slug]);
  return <Shell>{children}</Shell>;
}
```

Rules:

- **`force-dynamic` + noindex on the workspace layout.** Every workspace page is authenticated, per-org, per-user — never static, never indexed. One layout declaration covers the whole tree.
- **CMS coexistence.** Where the `cms` recipe is installed, `app/[slug]/page.tsx` (the bare `/{slug}` URL) is the **CMS article resolver**, not the workspace. The workspace exists only at sub-paths (`/{slug}/users`, `/{slug}/admin`, …) via the `(workspace)` group, so the two share the `[slug]` segment without colliding. The org *home* lives at `/orgs/{slug}` instead.
- **Reserved slugs.** Next resolves static segments before `[slug]`, so an org whose slug equals a static route name (`admin`, `platform`, `orgs`, `login`, `auth`, `invite`, `profile`, `account`, `api`, the product-wing names, …) gets its workspace **shadowed** — unreachable, with no error anywhere. Keep a `RESERVED_SLUGS` set (+ exported `isReservedSlug()`) in `lib/tenant.ts`. **Derive the set by auditing the actual top-level directories under `app/`**, including URLs served from route groups (e.g. `(account)/` serves `/profile` and `/account` — the group name doesn't appear in the URL, the leaf segments do), and anything in the middleware's CMS skip-list / internal-prefix list (where `domain-split` is installed) — same names, keep them in sync. Then guard **every slug write path**, not just generation: (1) `uniqueOrgSlug` treats a reserved candidate as a collision (falls through to `-2`/`-3` suffixing); (2) every PATCH that accepts a direct slug edit — owner `/api/orgs/[orgId]` AND staff `/api/admin/orgs/[orgId]` — rejects reserved values with `409 { error: "slug_reserved" }` (an explicit edit gets rejected, never silently suffixed). Guarding only generation is the classic miss: the edit path re-opens the hole.
- **The page reads org context from the client resolver, not by re-parsing the path.** Workspace pages call `useOrgs()` and get `currentOrg` / `currentOrgSlug` — already URL-pinned by `WorkspaceFrame`. Server-side, the org comes from `requireOrgMember(request, orgId)` on the API route the page calls; the page itself never trusts its own role math for anything but rendering.

## `/admin/**` — the un-slugged entry tree

The admin tree exists because two things can't carry a slug:

1. **The post-login landing.** `otp-auth`'s verify flow falls back to `redirect=/admin` — at login time the server doesn't know which org the user will want. `/admin` resolves the active org client-side and forwards.
2. **Old bookmarks.** Org-scoped pages used to live un-slugged (`/admin/users`); those URLs are out in the wild.

Both are served by one tiny component:

```tsx
// components/admin/OrgRedirect.tsx — resolve active org (selector → storage →
// first-org fallback via useOrgs) and forward to the canonical slugged URL.
"use client";
export default function OrgRedirect({ suffix }: { suffix: string }) {
  const router = useRouter();
  const { currentOrgSlug, loading } = useOrgs();
  useEffect(() => {
    if (loading) return;
    if (currentOrgSlug) router.replace(`/${currentOrgSlug}${suffix}`);
  }, [loading, currentOrgSlug, suffix, router]);
  return null;
}
```

```tsx
// app/admin/page.tsx — and identical stubs for each legacy org-scoped path
export const dynamic = "force-dynamic";
export default function AdminRedirect() {
  return <OrgRedirect suffix="/admin" />;
}
```

Each formerly-un-slugged org page keeps a stub (`/admin/users` → `/{slug}/users`, etc.). Stubs are append-only history — add one when you migrate a page, never delete one (bookmarks don't expire).

**The deliberate un-slugged residents** are the staff org-CRUD — `/admin/orgs` (paginated all-orgs list) and `/admin/orgs/{orgId}` (detail; ObjectId, not slug, because staff tools operate on rows, not workspaces) — plus grandfathered utilities like `/admin/geoip`. The admin layout is session-only (org owners must pass through it to hit the stubs), so **every staff page in this tree carries its own in-page guard**: render an access-denied state unless `role ∈ {admin, superadmin}` (or bypass), and never even fire the staff API call otherwise (`useSWR(isStaff ? url : null, …)`).

## `/platform/**` — cross-org staff tools

Everything platform-owned: `/platform/users` (+ `/{user_id}`), `/platform/waitlist`, `/platform/plans` (+ `/{slug}`), `/platform/settings`, `/platform/feature-flags`, `/platform/prompts`, `/platform/personas`, `/platform/chat`, `/platform/cms`, `/platform/deploy`. The layout is one line of policy:

```tsx
// app/platform/layout.tsx
export default function PlatformLayout({ children }) {
  return <Shell requireStaff>{children}</Shell>;
}
```

Superadmin-only surfaces (plans, settings, feature-flags, deploy) **self-gate in the page and in the API** — the layout only guarantees "staff," the page tightens to superadmin where the action warrants it (same split as `requireAdmin`'s admin-vs-superadmin distinction in `otp-auth`).

## Auth Gates — one Shell, two strictness levels

All three trees render through **one shared client Shell** (`components/admin/Shell.tsx`); the only per-tree policy is the `requireStaff` flag. There is no per-page auth drift because there is no per-page auth.

```tsx
// The gate inside Shell (client component):
const { user, bypass, isLoading } = useAuth();
useEffect(() => {
  if (isLoading) return;
  if (!user && !bypass) {
    router.replace(`/login?redirect=${encodeURIComponent(pathname)}`);
    return;
  }
  if (requireStaff && user && !isStaff(user.role)) router.replace("/");
}, [isLoading, user, bypass, pathname, router, requireStaff]);

if (isLoading) return null;                                   // never flash admin UI
if (!user && !bypass) return null;                            // redirecting to /login
if (requireStaff && user && !isStaff(user.role)) return null; // redirecting home
```

- **The client gate is UX, not security.** Real enforcement is server-side, per request: `requireOrgMember` on every `/api/orgs/**` handler, `requireAdmin` on every `/api/admin/**` and `/api/platform/**` handler. A user who defeats the client gate sees an empty shell over 401s.
- Where the `domain-split` recipe is installed, the **middleware host gate** is the outer wall in prod: the app host 307s every page to `/login` on missing session cookie, and the marketing host 308s the internal trees (`/admin`, `/platform`, `/orgs`, `/login`, `/auth`, `/invite`, `/profile`, `/account`) to the app host. Org-workspace routes (`/{org-slug}/…`) can't be recognized in middleware without a DB lookup — their session gate + `requireOrgMember` covers them.
- **Never render admin UI before `isLoading` resolves** — a fresh tab with a valid cookie briefly has `user: null` while `/api/auth/me` is in flight; returning `null` prevents the redirect-flicker, and a sign-out doesn't leave stale admin UI racing the redirect.
- **Redirect target is `pathname` alone**, not `pathname + search + hash` (hash never reaches the server; query encoding is brittle; destination pages rehydrate secondary state themselves).
- **Login contract:** `/login?redirect=<encoded-path>`; after verify-otp the login page honors the param, falling back to `/admin` — which is exactly the stub that forwards to `/{slug}/admin`. Do not invent a separate post-login flow.

### LOCALHOST_AUTH_BYPASS passthrough

`LOCALHOST_AUTH_BYPASS=true` (only the literal `"true"` — fail-secure) is honored in exactly four places:

1. **Server, `lib/auth.ts`** — `requireSession` / `requireAdmin` fall back to a synthetic superadmin session when no real session exists, so staff APIs answer in dev. `getSession` is NOT bypassed — it reflects real session state only.
2. **Client, the Shell gate** — the `bypass` flag from `/api/auth/me` opens the gate (`!user && bypass` renders children).
3. **`GET /api/orgs`** — because it uses `getSession` (not `requireSession`), a bypassed dev session would see zero orgs and every org-scoped surface would dead-end. The handler therefore has an explicit dev branch: no session + bypass on → **impute the host org (`gdi`) with `my_role: "owner"`** so the switcher and workspace work without an OTP login. Real logins always take precedence.
4. **`POST /api/auth/verify-otp`** — accepts **any 6-digit code** by skipping only the hash comparison, so logging in as a *real* user (org membership, invitations, roles) doesn't require reading the email. The pending session must still exist and be unexpired, the attempts cap still applies, and promotion runs the normal path — see `otp-auth/SKILL.md` § verify-otp code validity.

Everything else (profile, public site, header avatar) correctly shows logged-out UX under bypass — see `otp-auth/SKILL.md` § LOCALHOST_AUTH_BYPASS.

## Sidebar

One sidebar in Shell, three kinds of sections:

- **Product sections** (one per product wing) — shown to every logged-in user; each product's own recipe owns its items.
- **Admin section** — shown when `isAdmin || isOrgOwner`. Org-scoped items link slugged (`/{slug}/admin` Dashboard, `/{slug}/users` Users, `/{slug}/knowledge-base`, `/{slug}/personas`) and are shown to owners + staff; the cross-org **Organizations → `/admin/orgs`** item is `isAdmin`-gated.
- **Platform section** — shown when `isAdmin`; superadmin-only items (Plans, Settings, Feature Flags, Deploy) additionally check `isSuperadmin`.

Until the active slug resolves, org-scoped links **fall back to the legacy un-slugged paths** (`/admin/users`, …) — which redirect once it does — so the nav is never a dead link:

```ts
const op = currentOrgSlug ? `/${currentOrgSlug}` : null;
{ href: op ? `${op}/users` : "/admin/users", label: "Users", show: isAdmin || isOrgOwner }
```

Gate at the section/item level here and **nowhere else in page chrome** — exactly one source of truth per surface for "is this person allowed here."

## URL Grammar — tabs and modals in the hash

Identical for every tree; `{base}` is any page path (`/{slug}/users`, `/platform/plans/{plan}`, `/admin/orgs/{id}`):

```
{base}                 — list / landing
{base}/{id}            — detail / edit for one entity
{base}#{tab}           — tabbed page, active tab in the fragment
{base}#{modal}         — modal open on mount
{base}#{tab}/{modal}   — both: tab first, modal second, slash-joined
```

1. **Directory-style routes only, never flat-file.** `app/platform/plans/page.tsx`, not `app/platform-plans.tsx`. Mixed schemes silently break sidebar active-matching, breadcrumbs, and API path mirroring.
2. **The dashboard is the tree index, not `/dashboard`.** The org dashboard is `/{slug}/admin` (the workspace's admin index); don't nest a "Dashboard" item one level deeper than its siblings.
3. **CRUD detail is a path segment** (`/platform/users/{user_id}`), never `?id=`. The path is the single source of truth the route cache and breadcrumbs key on. The `new` slug is reserved; if entity IDs could collide with it, prefix at the data layer.
4. **Tabs ride the hash** (`#{tab}`), written with `replaceState` (no history entry per click). Default tab = no hash at all — never write the default key, or you mint two URLs for one view. Unknown keys fall back silently (stale bookmarks).
5. **Modals ride the hash** (`#{modal}`), opened with `pushState` (Back closes the modal), closed with `replaceState` of the pre-modal hash — never `history.back()`, which double-unwinds. Parameterize via the key (`edit-{id}`); a stale `#edit-{deleted}` renders "Not found" inside the modal, never a 500.
6. **One hash slot, slash-joined, keys disjoint.** `#active/edit-abc` = tab `active`, modal `edit-abc`; `#/edit-abc` = default tab + modal. A tab key colliding with a modal key on one page is a registration bug — assert disjoint in dev.

All hash access goes through one shared hook — no page touches `window.location.hash` directly:

```ts
// lib/useHashRoute.ts
export interface HashRoute { tab: string | null; modal: string | null; raw: string }

function parse(hash: string): HashRoute {
  const raw = hash.replace(/^#/, "");
  const [tab, modal] = raw.split("/");
  return { tab: tab || null, modal: modal || null, raw };
}

export function useHashRoute(): [HashRoute, (next: Partial<HashRoute>, opts?: { push?: boolean }) => void] {
  const [route, setRoute] = useState<HashRoute>(() =>
    typeof window === "undefined" ? { tab: null, modal: null, raw: "" } : parse(window.location.hash));

  useEffect(() => {
    const onChange = () => setRoute(parse(window.location.hash));
    window.addEventListener("hashchange", onChange);
    window.addEventListener("popstate", onChange);
    return () => { window.removeEventListener("hashchange", onChange); window.removeEventListener("popstate", onChange); };
  }, []);

  const write = (next: Partial<HashRoute>, opts?: { push?: boolean }) => {
    const merged = { ...route, ...next };
    const segments = [merged.tab ?? "", merged.modal ?? ""].join("/").replace(/\/+$/, "");
    const target = segments ? `#${segments}` : window.location.pathname + window.location.search;
    window.history[opts?.push ? "pushState" : "replaceState"](null, "", target);
    setRoute(parse(segments ? `#${segments}` : ""));
  };

  return [route, write];
}
```

(SSR guard matters: workspace pages are server-rendered on first load.) **Why hash, not `?tab=`:** query params are server-visible and bust the SWR cache on every toggle; the hash is client-only and free. Reserve query params for filters the server reads.

## API Mirroring — three API trees

| API prefix | Mirrors | Guard |
|---|---|---|
| `/api/orgs/[orgId]/**` | the org workspace | `requireOrgMember` / `requireOrgOwner` — orgId accepts slug OR ObjectId |
| `/api/admin/**` | `/admin/**` staff pages (org CRUD, geoip) | `requireAdmin` |
| `/api/platform/**` | `/platform/**` | `requireAdmin`; superadmin-only mutations check `session.role` |

Do not put platform-level API routes under `/api/admin/**` or vice versa — the prefix mirrors the page tree on purpose. Product-wing APIs (`/api/kb/**`, `/api/inbound/**`, …) are org-scoped by payload/session and gate through the same `requireOrgMember` primitive; their shapes live in their own recipes.

---

# Tenancy

## Critical: The Active Org Lives in the URL, Not the Session

**There is no `active_org_id` on the user, the session, or anywhere server-side.** The org a request operates on arrives as a route parameter — the `/{org-slug}` page segment, the `[orgId]` API segment — and the server re-checks membership on every request via `requireOrgMember`. Nothing is cached across requests.

1. **Org switching costs nothing server-side.** The client changes the URL it hits. No switch-org round trip, no session mutation, no race between tabs.
2. **Multiple tabs in different orgs just work.** Tab A on `/acme/users`, tab B on `/globex/users`, simultaneously. A session-stored active org breaks this immediately.
3. **The auth check IS the membership check.** One place in the codebase decides "may this user act on this org."
4. **Crafted URLs hit the same primitive.** Pasting another org's slug gets a 403 from `requireOrgMember`; there is no UI-only gate to bypass.

The client keeps a `localStorage` hint so the switcher remembers your last org across reloads — but the server never trusts it; it only seeds UI state and the `/admin` redirect stubs. See § Client State.

**Anti-pattern:** storing `active_organization_id` on the user doc and reading it in route handlers. Every two-tab user files a bug because tab A's switch silently wins in tab B.

## Data Models

### `organizations` — members embedded, not a join collection

```ts
interface IOrganization {
  _id:         ObjectId;
  name:        string;                               // "Goliath Dynamics Inc."
  slug:        string;                               // URL identity; lowercase, unique; "gdi"
  plan:        string;                               // FK to plans.slug — only "host" is recipe-defined
  status:      "active" | "suspended" | "archived";
  parent_id?:  string;                               // child / location orgs only
  domains?:    IOrgDomain[];                         // § Auto-Join
  members:     IOrgMember[];                         // embedded array
  created_at:  Date;
  updated_at:  Date;
  deleted_at?: Date;                                 // soft-delete
  deleted_by?: string;
}

interface IOrgMember {
  user_id:      string;                              // FK to users.user_id (otp-auth)
  email:        string;                              // denormalized for members UI
  display_name: string;
  role:         OrgRole;                             // "owner" | "member" | custom slug
  status?:      "active" | "suspended";              // per-membership suspend; absent ≡ active.
                                                     // Independent of users.status (platform-wide).
  joined_at:    Date;
}

interface IOrgDomain {
  domain:    string;                                 // lowercased
  auto_join: boolean;                                // matching email domain → auto-add as member
  added_at:  Date;
  added_by:  string;
}
```

**Indexes:** `{ slug: 1 }` unique · `{ "members.user_id": 1 }` multikey (powers "list my orgs" without a scan — **this index is what makes the embed viable; not optional**) · `{ "domains.domain": 1 }` sparse · `{ parent_id: 1 }` sparse · `{ status: 1, deleted_at: 1 }`.

**Why embedded members, not an `org_members` join collection.** (1) `requireOrgMember` is one `findOne` + an array scan — one query, every request. (2) Org pages render in one round trip; the member list is already loaded. (3) Cascade on delete is atomic and free. The cost — whole-doc bumps on member updates — is fine to ~5,000 members/org; split it out only when you actually have that customer.

**Why `slug` is mandatory.** ObjectIds make URLs unshareable and unloggable. Generate via `slugify` (lowercase, non-alphanumerics → `-`, collapse, trim) + `uniqueOrgSlug` (appends `-2`, `-3` on collision; checks soft-deleted rows too so a restore never collides on the unique index; skips `RESERVED_SLUGS` — § The Org Workspace). URLs always use slug; staff tools use ObjectId; stored FKs always use ObjectId (slugs are mutable).

### `plans`

```ts
interface IPlan {
  _id: ObjectId;
  slug: string;                  // "host", project-defined tiers…
  name: string;
  price_monthly: number;
  price_yearly:  number;
  features: { slug: string; name: string; value: number | boolean | string }[];
  is_active: boolean;            // false hides from new-org dropdowns; never migrates existing orgs
  created_at: Date;
  updated_at: Date;
}
```

**Index:** `{ slug: 1 }` unique (FK target of `organizations.plan`).

**The only recipe-defined plan slug is `"host"`** — the recipe owns its seed. Every customer-facing plan is created by superadmins in `/platform/plans`. Consumers MUST NOT hardcode `"free"`, `"standard"`, or any other tier into defaults, seeds, or revert paths — that is a foreign-key claim against a doc that may not exist, and it has shipped broken orgs before.

### `platform_settings` — single key per doc

```ts
interface IPlatformSetting { _id: ObjectId; key: string; value: unknown }
```

**Index:** `{ key: 1 }` unique. One doc per key (not one doc with many fields) so each setting upserts race-free via `findOneAndUpdate({ key }, { $set: { value } }, { upsert: true })`. This recipe defines `host_org_id`; other recipes append their own keys without re-declaring the collection.

### `invitations`

```ts
interface IInvitation {
  _id: ObjectId;
  org_id: string;                // ObjectId as string
  email: string;                 // normalized lowercase
  role: OrgRole;                 // granted on accept
  display_name?: string;
  token: string;                 // 32-byte hex; appears in the invite URL
  invited_by: string;
  invited_at: Date;
  expires_at: Date;              // TTL: 7 days
  accepted_at?: Date;
  accepted_by?: string;
}
```

**Indexes:** `{ token: 1 }` unique · `{ org_id: 1, email: 1 }` · `{ expires_at: 1 }` TTL `expireAfterSeconds: 0`.

**Token is plaintext, not hashed.** Time-bound, single-use, revocable; the threat is "someone forwards the email" (handled by the email-match check on accept), not DB-dump replay. Hashing buys nothing and breaks debuggability.

## Authorization — `lib/tenant.ts`

The smallest, most-quoted file in the recipe. Get it right and the rest is mechanical.

```ts
import { ObjectId } from "mongodb";
import { getDb } from "./db";
import { getSession, type AuthSession } from "./auth";

export type OrgRole = "owner" | "member" | string;

// Two canonical roles: `owner` (org administration) and `member` (full use).
// `operator`/`viewer` are LEGACY rank keys only — kept so older deployments work
// until a data migration rewrites them to `member`. Never offer them in UI.
const ROLE_RANK: Record<string, number> = {
  owner: 3,
  member: 2,
  operator: 2,   // legacy alias for the write tier
  viewer: 1,     // legacy/custom-slug read-only floor
};

// Custom slugs (admin-roles-crud) floor at read-only. A custom role named
// "admin" does NOT grant admin access — keep the `?? 1` fallback; never promote
// unknown slugs to the write tier.
export function roleAtLeast(actual: OrgRole, required: OrgRole): boolean {
  return (ROLE_RANK[actual] ?? 1) >= (ROLE_RANK[required] ?? 1);
}

export function normalizeRole(role: string): OrgRole {
  if (role === "owner") return "owner";
  if (role === "member" || role === "operator" || role === "viewer") return "member";
  return role;  // unknown custom slugs pass through; roleAtLeast floors them
}

export interface OrgContext {
  session: AuthSession;
  org: IOrganization;
  memberRole: OrgRole;
}

export async function requireOrgMember(
  request: Request,
  orgId: string,
  minRole: OrgRole = "viewer",   // floor rank = "any member at all"
): Promise<OrgContext> {
  const session = await getSession(request);
  if (!session) throw Object.assign(new Error("Unauthorized"), { status: 401 });

  const db = await getDb();
  const org = await db.collection<IOrganization>("organizations").findOne(
    ObjectId.isValid(orgId) ? { _id: new ObjectId(orgId) } : { slug: orgId },
  );
  if (!org || org.deleted_at) throw Object.assign(new Error("Organization not found"), { status: 404 });
  if (org.status === "suspended") throw Object.assign(new Error("Organization suspended"), { status: 403 });

  // Superadmin bypass: support staff act on any org without joining it. Returns
  // memberRole "owner" so downstream "can this caller invite" checks Just Work.
  if (session.role === "superadmin") return { session, org, memberRole: "owner" };

  const member = org.members.find((m) => m.user_id === session.user_id);
  if (!member) throw Object.assign(new Error("Forbidden"), { status: 403 });
  // Per-membership suspend blocks THIS org only (orthogonal to users.status).
  // One line; missing it lets a suspended member keep hitting org routes.
  if (member.status === "suspended") throw Object.assign(new Error("Forbidden"), { status: 403 });
  if (!roleAtLeast(member.role, minRole)) throw Object.assign(new Error("Forbidden"), { status: 403 });

  return { session, org, memberRole: member.role };
}

// Write-tier gate, named for back-compat with existing call sites; new code can
// call requireOrgMember(request, orgId, "member") directly.
export async function requireOrgOperator(request: Request, orgId: string) {
  return requireOrgMember(request, orgId, "member");
}
export async function requireOrgOwner(request: Request, orgId: string) {
  return requireOrgMember(request, orgId, "owner");
}
```

- **Accept slug OR ObjectId** — the switcher writes slugs into URLs, staff tools use ObjectIds. One helper, one lookup, no caller branches.
- **Throw with `status` on the error**, mapped by `otp-auth`'s `authError(err)` — every route's catch block stays one line.
- **Note `getSession`, not `requireSession`** — org membership is never satisfied by the dev-bypass synthetic session; the imputed-host-org branch in `GET /api/orgs` (§ LOCALHOST_AUTH_BYPASS) is the only dev affordance.

### Two org roles: `owner` and `member`

**`owner`** administers (members, billing, domains, MFA policy); **`member`** is a full participant — every feature, all writes. No read-only tier: a viewer tier is a support-ticket generator and doesn't match how small B2B orgs operate. Auto-joiners therefore get full write access — intended; the auto-join guards are what keep it safe.

Org roles are **deliberately disjoint from platform roles** (`user`/`admin`/`superadmin` on `users.role`, from `otp-auth`). The vocabularies never share names and never mix: an org `owner` is not a platform `admin`, and the org people manager can never set platform roles.

**Suspend, don't only remove.** Per-membership `status: "suspended"` cuts access to *that* org reversibly, without touching the platform account. Enforced in `requireOrgMember`.

**Migrating a legacy three-role app** (owner/operator/viewer → owner/member): ship the `ROLE_RANK` aliases first, then run an idempotent boot-time migration rewriting `organizations.members[].role` and pending `invitations.role` (`operator`/`viewer` → `member`), backfilling `status: "active"`. Rewrite the **whole members array per org** (read-modify-write), not positional `arrayFilters` — Firestore-in-Mongo-compat doesn't reliably support them, and the collection is small. Former viewers gain write access; that's the accepted outcome.

## Routes

### User-facing org routes — `/api/orgs/**`

```
GET    /api/orgs                          List orgs the caller belongs to
POST   /api/orgs                          Create org (caller becomes owner)
GET    /api/orgs/[orgId]                  Get one org (membership)
PATCH  /api/orgs/[orgId]                  Update org (owner)
GET    /api/orgs/[orgId]/members          Members + pending invitations (member)
PATCH  /api/orgs/[orgId]/members          Change role OR suspend status (owner)
POST   /api/orgs/[orgId]/invitations      Send invite (owner)
DELETE /api/orgs/[orgId]/members?userId   Remove member (owner; last-owner guard)
DELETE /api/orgs/[orgId]/members?inviteId Revoke pending invite (owner)
GET/POST/PATCH/DELETE /api/orgs/[orgId]/domains   Domain CRUD + auto_join toggle (owner)
POST   /api/auth/accept-invitation        Accept token (any logged-in user)
```

Every handler opens with `requireOrgMember` or `requireOrgOwner` inside `try { … } catch (err) { return authError(err); }`. There is no other authorization style. `GET /api/orgs` returns `member_count`, **never the full members array** (which would leak emails across orgs) — see `OrgListItem`.

Where `PATCH /api/orgs/[orgId]` accepts a slug edit: run it through `slugify`, reject reserved names with `409 slug_reserved` (`isReservedSlug` — § The Org Workspace → Reserved slugs), then reject collisions with `409 slug_taken` (explicit edits are rejected, never silently suffixed).

### Staff org routes — `/api/admin/orgs/**`

```
GET/POST   /api/admin/orgs                List all (paginated, search) / create on behalf
GET/PATCH/DELETE /api/admin/orgs/[orgId]  Detail / edit name·slug·plan·status / soft-delete
POST       /api/admin/orgs/[orgId]/restore
```

`requireAdmin`, not `requireOrgMember`. The list enriches rows with `member_count`, `host_user_count`, `external_user_count` (vs. the pinned host org). The staff slug edit takes the same `slug_reserved` + `slug_taken` guards as the owner PATCH — staff are not exempt from route shadowing.

### `PATCH /members` — role / suspend with last-owner guards

Body is `{ user_id, role }` or `{ user_id, status }`. **Validate `role` against the allowlist** (`owner`|`member`; same in `POST /invitations`) — otherwise a typo becomes a stored role. Guards run at mutation time (demote-then-repromote is legitimate):

```ts
// demotion: owner → member
if (member.role === "owner" && role !== "owner") {
  const owners = org.members.filter(m => m.role === "owner");
  if (owners.length === 1) return Response.json({ error: "cannot_remove_last_owner" }, { status: 400 });
}
// suspend: never suspend the last ACTIVE owner
if (status === "suspended" && member.role === "owner") {
  const activeOwners = org.members.filter(m => m.role === "owner" && m.status !== "suspended");
  if (activeOwners.length === 1 && activeOwners[0].user_id === user_id) {
    return Response.json({ error: "cannot_suspend_last_owner" }, { status: 400 });
  }
}
```

`DELETE …?userId` applies the same `cannot_remove_last_owner`. An org without a reachable owner is recoverable only by staff tools.

### Accept invitation

1. `requireSession` — if logged out, the invite UI bounces through `/login?redirect=/invite/accept?token=X`.
2. `findOne({ token })`; missing/expired → 400. Already accepted → 400 `already_accepted`.
3. **Email match:** `invitation.email !== session.email` → 400 `email_mismatch` (forwarding the email must not let a friend join).
4. `$push` the member row, mark accepted, return `{ org: { _id, slug, name } }`.
5. Client calls `setCurrentOrg(org.slug)` and `router.replace(\`/${org.slug}/admin\`)` — the user lands inside their new org's dashboard, no second click.

## Two User-Management Surfaces

Two places a person manages "users"; conflating them is the classic multi-tenant mistake:

| Surface | Route | Scope | Roles it edits | Who opens it |
|---|---|---|---|---|
| **Org users** | `/{org-slug}/users` | that org only | org roles (`owner`/`member`) | org **owner** (+ staff via bypass) |
| **Platform users** | `/platform/users` | every user | platform roles (`user`/`admin`/`superadmin`) | staff |

**`/{org-slug}/users` can never set a platform role, and `/platform/users` is the only place platform roles are edited.** Two axes, two screens, no overlap.

- **`/{org-slug}/users`** — the slug pins the org. In-page guard: render the manager only when `currentOrg.my_role === "owner"` or superadmin; otherwise "Owner access required." Reuses the org endpoints (`/api/orgs/[orgId]/members`, `/invitations`) — **never parallel ones**. Invite / role / suspend / remove / revoke (+ per-member MFA reset where `mfa-totp` is installed) all live here; badge the earliest-joined owner as the account owner. The legacy `/admin/users` path is a redirect stub to this page.
- **`/platform/users`** — `requireAdmin` on every route (`/api/platform/users`, `…/[user_id]`, `…/[user_id]/memberships`). Full user CRUD, platform roles (superadmin-only for creating/modifying admins), per-user org-membership management from the platform side, and the search endpoint other staff tools (superadmin org-switcher combobox, host-org picker) query.

**Anti-pattern:** one "Users" page that flips scope by viewer role. It muddles which roles are edited, leaks the platform list on any guard slip, and turns a route gate into a render-time branch.

## Auto-Join By Domain

The domain shape and enable-rules live here; the `autoJoinOrgs(...)` call itself runs inside `otp-auth`'s `promoteSession` — co-designed, neither works alone.

1. **Adding a domain** (owner-only): reject **public free-mail providers** with `auto_join` (maintain `FREE_MAIL_PROVIDERS` in `lib/tenant.ts` — gmail/googlemail, yahoo/ymail, outlook/hotmail/live/msn, icloud/me/mac, aol, proton/protonmail, gmx, zoho, yandex, mail.com; grow it as incidents demand). Reject domains already claimed with `auto_join: true` by another org (listing without auto_join may overlap; only one org can auto-grant).
2. **Enabling auto_join**: require **at least one existing member with an email on that domain** — the cold-start guard that stops a one-person org from claiming `acme.com` and harvesting Acme logins. Re-checked at join time as a second line of defense.
3. **At login** (`promoteSession`): walk matching orgs, re-validate `auto_join` + existing-member guard, skip orgs already joined, push a `member` row (`status: "active"`). Silent in v1 — the new org just appears in the switcher.

**Anti-pattern:** DNS TXT verification in v1. The existing-member guard already prevents the abuse it would catch; TXT adds an IT-department dependency for zero day-one payoff. Add it only when an enterprise SKU demands it.

## Client State — `lib/activeOrg.ts` + `lib/useOrgs.ts`

The active-org hint has **three sources, priority-ordered: URL → selector → storage**. A plain module holds the resolver (non-React callers need it too); a hook joins it against the SWR org list.

```ts
// lib/activeOrg.ts — module-scoped PER TAB, so two tabs never trample each other
const STORAGE_KEY = "app:current_org_slug";
let urlSlug: string | null = null;       // set by WorkspaceFrame from the [slug] param
let selectorSlug: string | null = null;  // set by the OrgSwitcher on pick
let storageSlug: string | null = null, storageInit = false;

export function getActiveOrg(): string | null {
  if (urlSlug) return urlSlug;            // on an org route the URL wins — multi-tab safe
  if (selectorSlug) return selectorSlug;  // off-org routes: last switcher pick
  if (!storageInit) { storageInit = true; try { storageSlug = localStorage.getItem(STORAGE_KEY); } catch {} }
  return storageSlug;                     // cold load: last-seen org
}

// WorkspaceFrame calls this with the route param; null on unmount. Persists when
// entering an org route (cold load defaults there) but NEVER clears storage on
// leave — last-seen must survive navigation away.
export function setActiveOrgFromUrl(slug: string | null) { /* set urlSlug; persist if non-null; notify */ }
// OrgSwitcher calls this; persists (null on logout clears).
export function setActiveOrgFromSelector(slug: string | null) { /* set selectorSlug; persist; notify */ }
export function useActiveOrg(): string | null { /* useSyncExternalStore over getActiveOrg */ }
```

```ts
// lib/useOrgs.ts
export function useOrgs() {
  const { data, mutate, isLoading } = useSWR<{ orgs: OrgListItem[] }>("/api/orgs", fetcher, { revalidateOnFocus: false });
  const activeSlug = useActiveOrg();
  const orgs = data?.orgs ?? [];
  // Validate against the loaded list — a stale slug (lost access, wrongly
  // persisted) can't outlive a permissions change.
  const currentOrg = (activeSlug ? orgs.find(o => o.slug === activeSlug) : null) ?? orgs[0] ?? null;
  // No explicit pick yet → impute the resolved org's slug (first/only org; under
  // dev bypass that's the host org) so org-scoped UI always has a slug to build links with.
  const currentOrgSlug = activeSlug ?? currentOrg?.slug ?? null;
  return { orgs, currentOrg, currentOrgSlug, setCurrentOrg: setActiveOrgFromSelector,
           refresh: mutate, loading: isLoading || data === undefined };
}
```

- **URL beats storage** because two-tabs-two-orgs is the headline feature; if storage outranked the URL, a second tab on `/globex/...` would still resolve `acme`.
- **`useSyncExternalStore`**, not component-local state — all subscribers re-render on change; kills "the navbar updated but the page didn't."
- **Slug, not ObjectId, in storage** — slugs survive a dev-DB reseed; the join against the live list catches revoked access either way.
- **Logout clears it** (`setActiveOrgFromSelector(null)` after the session POST) — otherwise the next login on a shared machine lands in the previous user's org.

## Org Switcher UI

Lives **in the navbar/topbar** (one location, always — it's the user's "where am I" anchor), rendered from `useOrgs()`; never writes localStorage directly.

- Closed: current org name + chevron. Open: auto-focused filter input over `org.name`; current org gets a ✓; `+ Create organization` row when permitted.
- **Picking an org navigates** — the URL must change so the active org follows the pick:

```ts
function pick(slug: string) {
  setCurrentOrg(slug);
  const segs = pathname.split("/").filter(Boolean);
  if (currentOrgSlug && segs[0] === currentOrgSlug) {
    segs[0] = slug;                       // on an org route: swap the slug segment
    router.push("/" + segs.join("/"));    // in place — "same page, next company"
  } else {
    router.push(`/${slug}/admin`);        // off-org: land on the new org's dashboard
  }
}
```

- **One org + not superadmin:** static text, no dropdown (a one-option switcher implies options that don't exist). **Zero orgs:** the control IS `+ Create organization`.
- **Superadmin variant — search combobox over ALL orgs.** Superadmins are typically members of one org (the host) and the membership-filtered switcher would render static text and strand them. For them, the trigger always opens into a search input; non-empty queries hit `GET /api/admin/orgs?search=<q>&limit=20` (debounced ~200ms). Memberships group on top ("Your orgs"), results below ("All organizations"); the destination page's superadmin bypass lets them act without joining. Hide `+ Create organization` here — staff create orgs in `/admin/orgs`.

## Platform Settings — `/platform/settings` and the Host Org

Superadmin-only page; the first-class v1 setting is the **host org** pin.

**What "host org" means:** one org in every install is the *operator's own* — its members are internal staff, everyone else is a customer. The designation drives `host_user_count`/`external_user_count` on the staff org list and any future "us vs. customers" hook (audit filters, support routing, rate-limit overrides). **`platform_settings.host_org_id` is the single source of truth** — never denormalize host-ness into the org's `plan` field (billing tier and host designation are orthogonal; conflating them is how a host-swap once wrote a nonexistent plan slug).

UX: a search-as-you-type combobox over `GET /api/admin/orgs?search=…&limit=20` (never a pre-fetched `<select>` — unusable past a few hundred orgs), a "— None —" row that clears the setting **without touching any org's plan**, save-disabled-until-dirty, refetch after save.

```
GET   /api/platform/settings   requireAdmin            → { host_org_id: string | null }
PATCH /api/platform/settings   requireAdmin (superadmin) body { host_org_id } — upsert the
                               platform_settings key; touch nothing else
```

GET is admin-tier (the org list render needs it); PATCH is superadmin-tier (it reshapes who counts as staff platform-wide).

## Plans Editor — `/platform/plans` and `/platform/plans/{slug}`

Superadmin-gated in page + API. List: name, slug, monthly price, `org_count`, `is_active`; create via `#new` modal (slug derived from name); rows navigate to `/platform/plans/{slug}` (slug in the URL — stable; `_id` is opaque).

Detail page tabs via `useHashRoute`: `#details` (default — name, prices, is_active), `#features` (slug/name/value triplets), `#orgs` — **organizations on this plan**, with per-row "Move to plan…" (PATCHes `/api/admin/orgs/{orgId}`) and an `#orgs/add-org` modal reusing the org search combobox. The orgs tab is the migration surface: rename, reprice, and migrate every affected org without leaving the page. Delete refuses while `org_count > 0` and points at the tab.

```
GET/POST /api/platform/plans          requireAdmin → list with org_count / create (superadmin)
GET/PATCH/DELETE /api/platform/plans/{slug}   detail (enriched with orgs-on-plan) / edit / delete (superadmin)
```

### Org create — plan dropdown, never freeform

Org-create forms render a dropdown over `GET /api/platform/plans` filtered to `is_active`, defaulting to `"host"` (the only slug the recipe guarantees). **Server-side, `POST`/`PATCH /api/admin/orgs` MUST reject any `plan` not present in the `plans` collection** (`findOne({ slug: body.plan })` — one indexed query). Skipping this silently re-introduces the broken-FK plan bug.

## Bootstrap Seed — Goliath Dynamics Inc.

Every install seeds **Goliath Dynamics Inc.** (slug `gdi`, plan `host`), adds **david@goliathdynamics.com** as founding `owner`, lists `goliathdynamics.com` with `auto_join: true` (safe: David is already a member on that domain at insert time — Goliath staff onboard by just logging in), and pins it as `host_org_id`. Together with `otp-auth`'s superadmin seed, a fresh DB has both an identity to log in as and a place to land.

It lives in `lib/db.ts`'s `getDb()` lazy-seed — not a script someone must remember to run — guarded by a `seeded` flag set **before** any await. **Order matters:** `ensureSuperadmin` first (the org seed reads the superadmin's `user_id` for the members array), then `ensureHostOrg`. The seed is idempotent and self-healing:

- **Match by `$or: [{ slug }, { name }]`**, not slug alone — legacy rows can carry the right name with no `slug` field (which the unique index does not constrain), and a slug-only check inserts a phantom duplicate every boot. Backfill the missing slug on match; if the backfill hits `E11000`, a canonical `gdi` row already exists — switch to it and leave the duplicate for ops review, never destructively merge.
- **Membership add is an atomic guarded update** — `updateOne({ _id, "members.user_id": { $ne: superadmin.user_id } }, { $push: … })` — so concurrent seed calls can't double-push. If already a member at a lesser role, self-heal back to `owner` (test fixtures and restores demote him; next boot restores one source of truth).
- Re-assert `status: "active"`, `plan: "host"`, and clear `deleted_at` on the existing row; finish with the idempotent `host_org_id` upsert.
- **Seed exactly one org.** Test orgs are fixtures; customer orgs come from staff via `/admin/orgs`.

(The full implementation is `ensureHostOrg` in `diplomat/web/lib/db.ts` — copy it rather than re-deriving the concurrency guards.)

## Fit-to-Project

- **Router:** this recipe is written for Next.js App Router. On Expo Router (docpost-era), the trees live under `app/(app)/…` with `_layout.tsx` gates and `<Redirect>`; every URL rule applies unchanged, but prefer the Next shape for new projects.
- **Slug edits:** allow owners to set the slug once at creation, then lock it — renames break every shared URL and invite link.
- **Custom org roles:** define via `admin-roles-crud`; `roleAtLeast` floors unknown slugs at read-only (never promote). Features that recognize a custom role check the slug explicitly. Don't re-offer `operator`/`viewer`.
- **Org-scoped collections:** one collection + `{ org_id: 1, … }` index, never collection-per-org (admin queries become impossible).
- **Soft-delete propagation:** org-scoped reads on dependent collections must filter the org join on `deleted_at` — audit each collection on install.
- **Hash on native:** `window.location.hash` is web-only; native admin (rare) carries the same state in route params behind the same hook interface.
- **`requireAdmin` vs `requireOrgMember`:** platform role and org membership are independent axes. Staff act on any org without joining; owners administer their org without being staff. Never conflate.

## Anti-Patterns

Routing:

- **Auth checks inside page components** instead of the shared Shell + in-page staff guards defined here — drift is guaranteed.
- **New pages under `/admin/**`** — it's the entry/redirect shim. Org-scoped → slugged; cross-org → `/platform`.
- **A slugged page that ignores its slug** (renders the same data for every org) or a cross-org page that demands one.
- **Tab state in React state only, or in `?tab=`** — unshareable, or cache-busting. Hash, always.
- **Modal close via `history.back()`** — unwinds the open-push twice. Close with `replaceState`.
- **Tab key colliding with modal key on one page** — silent mis-open. Assert disjoint in dev.
- **Deleting a legacy redirect stub** because "nobody uses it" — bookmarks outlive your analytics window.
- **Org slugs colliding with static routes** — `uniqueOrgSlug` must skip `RESERVED_SLUGS` or the workspace gets shadowed by the static segment; the slug-edit PATCHes (owner and staff) must reject reserved values too (`409 slug_reserved`), or the edit path re-opens the hole generation closed.
- **Fabricating a logged-in user from LOCALHOST_AUTH_BYPASS** — gate-only, plus the single imputed-host-org branch in `GET /api/orgs`. `getSession` stays honest.
- **Rendering before `isLoading` resolves**, or redirect targets carrying query+hash — flicker and brittleness, respectively.

Tenancy:

- **`active_organization_id` on the user/session** — multi-tab breaks; the URL is the source of truth.
- **A separate `org_members` collection** — wrong by default on Mongo at this scale; the embedded array + multikey index wins until ~5k members/org.
- **Slugs as stored foreign keys** — slugs are mutable; FKs use ObjectId. (URLs use slug; staff tools use ObjectId.)
- **auto_join on free-mail domains, or without the existing-member guard** — both turn a domain entry into an open door.
- **Per-route membership logic instead of `requireOrgMember`** — two implementations are two attack surfaces.
- **Returning full `members[]` from list endpoints** — leaks emails across orgs; return `member_count`.
- **Forgetting the org-suspended / member-suspended checks** — each is one line in `requireOrgMember`; missing either keeps suspended actors live.
- **Hardcoded plan slugs** (`"free"` etc.) anywhere — only `"host"` is guaranteed to exist. Validate `plan` server-side against the collection.
- **Host designation denormalized into `plan`** — `host_org_id` in `platform_settings` is the only truth.
- **Soft-deleting the host org** — guard `DELETE /api/admin/orgs/[id]` with `cannot_delete_host_org`.
- **Last-owner demotion/suspension/removal** — refuse at mutation time; an ownerless org is a support ticket.
- **A switcher that strands superadmins** — membership-filtered static text gives staff no way into customer orgs; give them the search combobox.

## Integrations

- **`otp-auth`** — co-required: `getSession`/`requireSession`/`requireAdmin`/`authError`, the auto-join hook in `promoteSession`, the `/login?redirect=` contract, and the superadmin seed the org seed depends on.
- **`domain-split`** — where installed, the middleware host gate is the outer wall; its internal-prefix list must name `/admin`, `/platform`, `/orgs` and friends (workspace slugs are covered by the session gate instead).
- **`cms`** — shares the `[slug]` segment: bare `/{slug}` resolves articles, the `(workspace)` group owns sub-paths; keep the CMS skip-list and `RESERVED_SLUGS` aligned.
- **`admin-user-crud`** — platform user tools; user detail shows org memberships; hard-delete cascades membership removal from every org's `members[]` (audited as `org_member_removed`).
- **`admin-roles-crud`** — custom role catalog; org-scoped permission slugs under `org.*`; system org roles live in the same `roles` collection with `scope: "org"`.
- **`mfa-totp`** — org MFA policy is owner-administered; per-member MFA reset lives on `/{org-slug}/users`.
- **`user-profile`** — the un-slugged `(account)` pages rendered through the same Shell.
- **Product-wing recipes** — their org surfaces mount under `/{org-slug}/{product}/…` and inherit the workspace layout; their sidebar sections render above Admin/Platform.

## Logging

- Log the Shell redirect once per session with resolved state: `log({ level: "info", msg: "admin gate", path, has_session: !!user, role: user?.role })` — without it, "I was kicked out" tickets are unreproducible.
- Log the `redirect=` param on `/login` at info — shows bounce destinations and makes open-redirect probes visible.
- Do NOT log URL hashes (entity IDs + modal keys, high churn, no signal).
- Emit a structured log on every membership change (`org_member_added` / `_removed` / `_role_changed` / `_suspended` with org_id, slug, target, actor) in addition to the audit row — membership churn is the top signal for "why can't I see this org" tickets.
