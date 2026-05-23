---
name: admin-routing
description: >
  Use when adding any admin or platform page to a Goliath Expo Router app.
  Canonical rules for the URL shape: there are TWO admin trees — `/admin/**`
  for org-level admin (visible to org owners and platform staff) and
  `/platform/**` for platform-wide admin (superadmin/admin only). Both follow
  the same conventions: dashboard at the tree root (`/admin/`, `/platform/`),
  directory-style `{tree}/{page}/` (never flat-file `admin-{page}`), CRUD
  detail at `{tree}/{page}/{id}`, tabbed pages carry the active tab as
  `#{tab}`, open modals carry their key as `#{modal}` and reopen on cold load,
  and every route under either tree is gated by a layout-level auth guard
  (`{tree}/_layout.tsx`) that redirects unauthenticated visitors to the login
  screen unless `LOCALHOST_AUTH_BYPASS=true` is opting in to the dev bypass.
  This is the prerequisite every other `admin-*` skill depends on.
dependencies:
  capabilities:
    auth: otp-auth
provides: [admin-routing]
---

# Admin Routing

The baseline URL + auth-gate contract every admin page in a Goliath app obeys. Admin surfaces are implemented across many skills (`admin-user-crud`, `admin-chat`, `admin-prompt-queue`, ...), and without a shared routing convention they drift into flat-files, one-off auth guards, ad-hoc tab query params, and modals that can't be linked to. This skill pins the shape down so new admin pages snap into a consistent URL grammar and a single auth guard.

The insight: every piece of UI state that a user might want to share, bookmark, reload, or hit "back" into — the page, the entity, the active tab, the open modal — lives **in the URL**, and the auth gate lives in **one layout per tree**, not in each route.

Reference implementation: `docpost-app/app/(app)/admin/_layout.tsx` and `docpost-app/app/(app)/platform/_layout.tsx` (auth gates), `docpost-app/app/(app)/admin/users/index.tsx` (tab + modal hash pattern), `docpost-app/app/(app)/platform/plans/[id].tsx` (platform-tree CRUD detail with tab/modal hashes).

## Two trees: `/admin/**` and `/platform/**`

Goliath apps that consume `multi-tenant` have two distinct admin surfaces and **the URL prefix encodes which audience** so a sidebar, breadcrumbs, and a route cache can disambiguate without a per-page lookup:

| Tree | Audience | Layout gate | Examples |
|---|---|---|---|
| `/admin/**` | Org-level admin. Org owners (per `multi-tenant`'s `OrgRole === "owner"`) plus platform `admin`/`superadmin`. The owner uses these pages to manage **their own org** — its members, its child orgs, its billing. | `app/(app)/admin/_layout.tsx` accepts `role ∈ {admin, superadmin}` OR a session that owns at least one org. | `/admin/`, `/admin/users`, `/admin/orgs`, `/admin/orgs/{id}` |
| `/platform/**` | Platform-level admin. Platform staff only — `role ∈ {admin, superadmin}`. Org owners can NOT see this tree. The pages here operate on the platform as a whole: every org, every plan, every prompt template, every chat message, the deploy pipeline, the host-org pin. | `app/(app)/platform/_layout.tsx` accepts `role ∈ {admin, superadmin}` only. | `/platform/`, `/platform/plans`, `/platform/plans/{id}`, `/platform/chat`, `/platform/prompts`, `/platform/deploy`, `/platform/settings` |

**Why two trees and not one.** A single `/admin/**` tree forces every page to either widen its gate (and leak platform-level surfaces to org owners) or grow per-page role checks (which is exactly what the layout-gate rule was supposed to eliminate). Splitting the prefix means **the route itself encodes the audience**, the gate in `_layout.tsx` makes one decision, and every link in a sidebar can be filtered with one prefix string instead of a role lookup.

**Mapping rule for "where does this page live":**

- Does the page operate on a single org's resources (its members, its child orgs, its billing)? → `/admin/{page}` and `/admin/{page}/{id}`.
- Does the page operate on platform-wide resources (the full plans catalog, every chat across every org, the deploy pipeline, host-org settings, every prompt template)? → `/platform/{page}` and `/platform/{page}/{id}`.

When in doubt, ask: *would an org owner ever need to see this page?* If no, it's `/platform/**`.

**API mirroring.** Routes under `/api/admin/**` mirror `/admin/**` and use `requireOrgMember`-style guards (or `requireAdmin` for cross-org admin tools that also serve owners). Routes under `/api/platform/**` mirror `/platform/**` and use `requireAdmin` (admin or superadmin) — they never accept org-owner sessions. **Do not** put platform-level API routes under `/api/admin/**` — the URL prefix mirrors the page tree on purpose.

**Anti-pattern:** putting platform-level pages under `/admin/**` "because they're admin." That's exactly the drift this split prevents — a chat-analysis page or a deploy console that organically lands at `/admin/chat` or `/admin/deploy` will eventually need a per-page `if (role !== "superadmin") redirect("/")` check, undoing the layout-gate single-source-of-truth rule. Put it under `/platform/**` from the start.

**Anti-pattern:** the inverse — putting an org-owner-relevant page under `/platform/**` because "an admin would also use it." Org owners cannot reach `/platform/**`, so any flow that needs both audiences (e.g. an "edit my org's members" page that admins also use) belongs under `/admin/orgs/{id}` where the gate accepts both.

## URL Grammar

The grammar is identical for both trees — substitute `{tree}` with `admin` or `platform`:

```
/{tree}                        — dashboard (index page)
/{tree}/{page}                 — list / landing for a single surface
/{tree}/{page}/{id}            — detail / edit for one entity in that surface
/{tree}/{page}#{tab}           — tabbed page with active tab in the fragment
/{tree}/{page}/{id}#{tab}      — tabbed detail page
/{tree}/{page}#{modal}         — list page with a modal open on mount
/{tree}/{page}/{id}#{modal}    — detail page with a modal open on mount
/{tree}/{page}/{id}#{tab}/{modal}  — both: active tab + modal open on mount
```

Rules:

1. **The dashboard is `/{tree}/`, not `/{tree}/dashboard` or `/dashboard`.** It is the index file of the tree: `app/(app)/admin/index.tsx`, `app/(app)/platform/index.tsx`. If the app has a public landing page that also wants to live at `/`, gate the admin/platform shells at their respective prefixes and keep the marketing site outside their layouts. **Why:** "dashboard" is what the page *is*, not where it lives — nesting it one level deeper than every other admin page creates an odd redirect chain (`/admin` → `/admin/dashboard`) and makes the sidebar "Dashboard" item the only one that points one level deeper than the rest.

2. **Directory-style only — never flat-file.** `app/(app)/admin/users/index.tsx`, not `app/(app)/admin-users.tsx`. Do not mix the two schemes anywhere in the tree; pick directory-style and delete any flat-file siblings that predate this rule. **Why:** the two schemes drift breadcrumbs, sidebar active-route matching, API path mirroring (`app/api/admin/users/...`), and the recipe library's canonical-path tables. A single mixed file forces every consumer to special-case it.

3. **CRUD is `admin/{page}/{id}`, not a query param.** New-entity creation happens inside the list page (via a modal — see below) or on a dedicated `new` route (`admin/{page}/new`) if the form is large enough to warrant its own page. Edit is `admin/{page}/{id}`. **Why:** the entity ID in the path is the single source of truth for which entity the page is for — if it lived in a `?id=` query param, layout breadcrumbs and deep links would have to reach into `searchParams`, and the route cache couldn't key on it.

4. **Tabs are in the URL fragment as `#{tab-key}`.** Clicking a tab updates the hash with `replaceState` (no history entry per click). Opening the page with `#{tab-key}` activates that tab on mount. The default tab has no hash — `/admin/chat` means "whatever the default tab is". **Why:** tab state that only lives in React state cannot be shared, bookmarked, or survived on reload — users who send a teammate "look at the Public tab" end up sending a link to the In-app tab.

5. **Modals are in the URL fragment as `#{modal-key}`.** Opening a modal pushes a hash (via `pushState` so Back closes the modal). Closing the modal pops the hash. Opening the page with a hash that matches a registered modal opens it on mount. **Why:** same as tabs plus one more — browser Back expects to close a modal, not navigate the route. Driving modals through the URL makes Back work correctly for free.

6. **Tab keys and modal keys share one hash slot per page and must not collide.** A page with tabs AND modals uses the convention `#{tab}/{modal}` — tab first, modal second, slash-joined. `#active` means "tab=active, no modal". `#active/edit-abc` means "tab=active, modal=edit-abc". `#/edit-abc` (leading slash) means "default tab, modal=edit-abc". **Why:** a single hash slot keeps URL parsing trivial (split on `/`, at most two segments) and sidesteps the ambiguity of multiple `;`- or `&`-joined fragments. Collisions between a tab key and a modal key on the same page are a registration bug — enforce at the page level with a dev-time assertion.

## Auth Gate — one layout per tree, not per-route

Each tree has exactly one auth gate, in `_layout.tsx` at the tree root. Individual pages do NOT re-check auth.

### `/admin/**` — org owner OR platform staff

```tsx
// app/(app)/admin/_layout.tsx
import { Redirect, Slot, usePathname } from "expo-router";
import { useAuth } from "@/lib/useAuth";
import { useOrgs } from "@/lib/useOrgs";

export default function AdminLayout() {
  const { user, bypass, isLoading } = useAuth();
  const { orgs, isLoading: orgsLoading } = useOrgs();
  const pathname = usePathname();

  if (isLoading || orgsLoading) return null;  // never flash content

  if (!user) {
    if (bypass) return <Slot />;              // dev gate-open, no user identity
    const redirect = encodeURIComponent(pathname);
    return <Redirect href={`/login?redirect=${redirect}`} />;
  }

  const isPlatformStaff = user.role === "admin" || user.role === "superadmin";
  const isOrgOwner = orgs.some((o) => o.member_role === "owner");

  if (!isPlatformStaff && !isOrgOwner) {
    return <Redirect href="/" />;             // logged in but neither
  }

  return <Slot />;
}
```

The gate accepts owners because every page under `/admin/**` is org-scoped — owners use it to manage their own org. The org-scoping enforcement on each page is via `requireOrgMember` server-side, not via the layout's role check. The layout is just "are you allowed in this neighborhood at all."

### `/platform/**` — platform staff only

```tsx
// app/(app)/platform/_layout.tsx
import { Redirect, Slot, usePathname } from "expo-router";
import { useAuth } from "@/lib/useAuth";

export default function PlatformLayout() {
  const { user, bypass, isLoading } = useAuth();
  const pathname = usePathname();

  if (isLoading) return null;

  if (!user) {
    if (bypass) return <Slot />;              // dev gate-open, no user identity
    const redirect = encodeURIComponent(pathname);
    return <Redirect href={`/login?redirect=${redirect}`} />;
  }

  if (user.role !== "admin" && user.role !== "superadmin") {
    return <Redirect href="/" />;             // owners do not see platform pages
  }

  return <Slot />;
}
```

Mirror this gate on the API side: every `/api/platform/**` handler wraps in `try { const session = await requireAdmin(request); ... } catch (err) { return authError(err); }`. The role check is once per request, not duplicated in the page component.

- `useAuth` is the client-side hook that wraps the `GET /api/auth/me` SWR call and returns `{ user, bypass, isLoading, ... }`. The server-side gate (`requireAdmin` / `requireSession` in `lib/auth.ts`) honors `LOCALHOST_AUTH_BYPASS` directly; the client gate above honors it via the `bypass` flag the server sets on `/api/auth/me` when no real session is present — see `otp-auth/SKILL.md` § LOCALHOST_AUTH_BYPASS.
- **Never render admin UI behind a loading spinner that assumes the user exists.** `isLoading` must resolve before the auth check, otherwise a sign-out leaves the previous admin UI on screen while the redirect races.
- **The redirect path is `pathname`, not `request.url` and not `pathname + search + hash`.** Query + hash make the redirect brittle (URL encoding across servers, hash not sent to server) and usually aren't load-bearing for "take me back where I was" — if the target needs them, the destination page will rehydrate them from its own state.

### LOCALHOST_AUTH_BYPASS passthrough

`LOCALHOST_AUTH_BYPASS=true` is a **gate-only** flag — it opens the admin/platform gate in dev, it does NOT fabricate a logged-in user. `useAuth` exposes a `bypass` boolean alongside `user`. When `user` is null but `bypass` is true, the layout above renders `<Slot />` (open the gate); when both are null/false, it redirects to `/login` as normal.

The flag is honored in exactly two places:
1. **Server**, in `lib/auth.ts` — `requireSession` and `requireAdmin` return a synthetic admin session so /api/admin/** handlers answer 200 in dev.
2. **Client**, in this layout — the `if (!user && bypass) return <Slot />` branch above.

`getSession` and `/api/auth/me` are NOT bypassed: `useAuth().user` is null in dev unless you actually log in, and the public site, profile page, and avatar chrome all show logged-out UX. That is intentional — see `otp-auth/SKILL.md` § LOCALHOST_AUTH_BYPASS for the why.

Variable is fail-secure by construction: only the literal string `"true"` enables the bypass, so absent/empty/`false`/typo all leave auth enforced. See `otp-auth/SKILL.md` § LOCALHOST_AUTH_BYPASS for the rationale.

### Login screen contract

The login route is `/login?redirect=<encoded-path>`. After successful verify-otp, the login page reads the `redirect` query + any `redirect` returned by the verify-otp response body, falls back to `/admin`, and `router.replace()`s there. This matches `otp-auth/SKILL.md` § Redirect After Login — do not invent a separate post-login flow for admin users.

## Hash Hook — `useHashRoute`

A single shared hook reads and writes the hash. Every admin page uses it; no page parses `window.location.hash` directly.

```ts
// lib/useHashRoute.ts
import { useEffect, useState } from "react";

export interface HashRoute {
  tab: string | null;     // first segment, or null
  modal: string | null;   // second segment, or null
  raw: string;            // everything after the `#`, no leading `#`
}

function parse(hash: string): HashRoute {
  const raw = hash.replace(/^#/, "");
  const [tab, modal] = raw.split("/");
  return { tab: tab || null, modal: modal || null, raw };
}

export function useHashRoute(): [HashRoute, (next: Partial<HashRoute>, opts?: { push?: boolean }) => void] {
  const [route, setRoute] = useState<HashRoute>(() =>
    typeof window === "undefined" ? { tab: null, modal: null, raw: "" } : parse(window.location.hash),
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onChange = () => setRoute(parse(window.location.hash));
    window.addEventListener("hashchange", onChange);
    window.addEventListener("popstate", onChange);
    return () => {
      window.removeEventListener("hashchange", onChange);
      window.removeEventListener("popstate", onChange);
    };
  }, []);

  const write = (next: Partial<HashRoute>, opts?: { push?: boolean }) => {
    const merged = { ...route, ...next };
    const segments = [merged.tab ?? "", merged.modal ?? ""].join("/").replace(/\/+$/, "");
    const target = segments ? `#${segments}` : window.location.pathname + window.location.search;
    const method = opts?.push ? "pushState" : "replaceState";
    window.history[method](null, "", target);
    setRoute(parse(segments ? `#${segments}` : ""));
  };

  return [route, write];
}
```

- **Tab changes use `replaceState`** (default). Tabs are view filters; users don't expect Back to undo a tab click.
- **Modal open uses `pushState`** (`{ push: true }`). Users expect Back to close a modal.
- **Modal close uses `replaceState`** of the current tab hash — do NOT `history.back()` to close, because that also unwinds the original modal-open push if the user then goes Back again.
- SSR guard: every `window` access is behind a `typeof window === "undefined"` check because the `stack` skill's Expo Router routes are rendered on the server on first load.

## Page Patterns

### Tabbed page

```tsx
// app/(app)/admin/chat/index.tsx
const TABS = ["chat", "contact"] as const;
const DEFAULT_TAB = "chat";

export default function AdminChat() {
  const [route, setHash] = useHashRoute();
  const active = (TABS as readonly string[]).includes(route.tab ?? "") ? (route.tab as string) : DEFAULT_TAB;
  return (
    <TabBar
      tabs={TABS}
      active={active}
      onChange={(tab) => setHash({ tab: tab === DEFAULT_TAB ? null : tab, modal: null })}
    />
    /* ... */
  );
}
```

- Unknown tab keys fall back to the default silently (never throw on a stale bookmark).
- Switching tabs clears any open modal — the modal belongs to the tab it was opened under.
- Setting the default tab writes `null`, not the default tab key. **Why:** the canonical URL for a page's default state is the page with no hash at all. If the default has a hash, `/admin/chat` and `/admin/chat#chat` become two URLs for the same view and caches, analytics, and link-dedup all treat them as distinct.

### Modal-on-mount

```tsx
// app/(app)/admin/users/index.tsx
const MODALS = { new: NewUserModal, "edit-*": EditUserModal } as const;

export default function AdminUsers() {
  const [route, setHash] = useHashRoute();
  const modal = route.modal;

  const open = (key: string) => setHash({ modal: key }, { push: true });
  const close = () => setHash({ modal: null });

  return (
    <>
      <Button onPress={() => open("new")}>+ New User</Button>
      {modal === "new" && <NewUserModal onClose={close} />}
      {modal?.startsWith("edit-") && <EditUserModal userId={modal.slice(5)} onClose={close} />}
    </>
  );
}
```

- Modals can be parameterized via their key — `edit-{id}` carries the target entity ID. Prefer this over stuffing entity state into a separate query param; the modal key IS the state.
- A modal-on-mount with a missing entity (e.g. `#edit-deleted-id`) should render a "Not found" state inside the modal, not 500 the page — deep links go stale.

### CRUD new-entity

Two acceptable shapes:

- **Modal on the list page** (`/admin/{page}#new`) — for simple forms (≤5 fields). The list stays visible behind the modal.
- **Dedicated route** (`/admin/{page}/new`) — for multi-step or long forms. The `new` slug is reserved; an entity with `id = "new"` is ambiguous. If the entity ID space could contain `"new"`, disambiguate with a prefix (e.g. `usr_new`) at the data layer.

Pick one per surface; do not offer both on the same page.

## Fit-to-Project

- **Router:** assumes Expo Router with the `app/(app)/...` group for authenticated surfaces. If the project uses Next.js App Router instead, the layout file is `app/admin/layout.tsx` and the redirect is `redirect("/login?redirect=...")` from `next/navigation`. Every other rule applies unchanged.
- **Native caveat:** `window.location.hash` is web-only. On native admin (rare), the same state lives in route params (`useLocalSearchParams`) — the hook interface stays the same but the implementation switches. Web-admin-only apps can ignore this.
- **Auth hook source:** the layout imports `useAuth` from wherever the project's SWR wrapper lives (`lib/useAuth`, `hooks/useAuth`, `@/lib/auth-client`, etc.). Do not create a second hook inside this skill.
- **Dashboard shell:** the `/admin` index page itself is out of scope here — `admin-dashboard` owns its content. This skill only guarantees the URL.

## Anti-Patterns

- **Auth-checking inside each admin page component** — drift is guaranteed: one page checks `user.role === "admin"`, another checks `!!user`, a third forgets entirely. Single layout gate, no exceptions.
- **Mixing `admin-{page}.tsx` and `admin/{page}/index.tsx` in the same tree** — sidebar matching, breadcrumbs, and recipe tables all assume directory-style. A stray flat file breaks all three silently.
- **Dashboard at `/admin/dashboard` with `/admin` redirecting there** — one extra redirect on every admin page load, a "Dashboard" sidebar item that points one level deeper than every sibling, and two URLs for the same view. Make `/admin/` the dashboard directly.
- **Tab state in React state only** — "send me a link to the flagged-messages tab" stops working. Every tab click must touch the URL.
- **Tab state in a `?tab=` query param instead of the hash** — query params are server-visible and invalidate the SWR cache for every tab toggle; the hash is client-only and cheap. Reserve query params for filters the server reads.
- **Modals using `pushState` for open AND `history.back()` for close** — one Back after a clean modal-open/modal-close cycle unwinds the modal-open push and takes the user off the page. Close with `replaceState` of the pre-modal hash.
- **Tab key colliding with a modal key on the same page** — silent bug: opening the "new" modal also activates a "new" tab (or vice versa). Enforce disjoint keys in a dev assertion on the page's registered keys.
- **Entity ID `"new"` in the route space** — `/admin/users/new` is ambiguous if a user could have id `"new"`. Reserve it at the data layer or use a prefix.
- **Hash encoding entity state beyond the key** — `#edit-123?full_name=x&email=y` is not a URL. If a modal has draft state, keep it in local component state and lose it on navigate — that's correct behavior. The hash carries identity, not form contents.
- **Fabricating a logged-in user from LOCALHOST_AUTH_BYPASS** — the flag is gate-only. If `getSession` or `/api/auth/me` returns a synthetic `localhost@localhost` user, every page using `useAuth` (public site, profile, header avatar) shows a fake "logged in" identity that has no DB row behind it. Keep the bypass branch in `requireSession`/`requireAdmin` server-side and in the `if (!user && bypass)` line of this layout client-side; nowhere else.
- **Fail-open dev bypass variable** — using `LOCALHOST_AUTH_REQUIRED=false` (or any scheme where the bypass turns on when the var is "disabled" or absent) silently drops auth if the var ever vanishes from a deploy. Use `LOCALHOST_AUTH_BYPASS === "true"` so only an explicit opt-in enables bypass. See `otp-auth/SKILL.md` § LOCALHOST_AUTH_BYPASS.
- **Rendering admin UI before `isLoading` resolves** — a fresh tab with a valid cookie briefly has `user: null` while `/api/auth/me` is in flight. Returning `null` (or a skeleton) during `isLoading` prevents the redirect-flicker.
- **Redirect target includes query + hash** — `pathname + search + hash` makes the round-trip fragile (hash isn't sent to the server anyway). Use `pathname` alone; destination pages rehydrate secondary state from their own local storage or defaults.

## Logging

- Log the admin-layout redirect once per session with the user's resolved state: `log({ level: "info", msg: "admin gate", path, has_session: !!user, role: user?.role })`. Missing this makes "I was kicked out of /admin" tickets unreproducible — you can't tell whether the cookie expired, the role changed, or the layout is buggy.
- Do NOT log the hash. Hashes can carry entity IDs and modal keys that may reveal internal IDs to log aggregators; they also change on every click and drown out real signal.
- Log `redirect=` param on the login route at info level so you can see where users are bouncing off to — this also makes open-redirect probes visible if anyone ever passes a non-`/`-prefixed value and the guard rejects it.
