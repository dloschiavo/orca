---
name: admin-roles-crud
description: >
  Use when building an admin interface for managing RBAC roles and the permission
  catalog they reference. Covers the `roles` collection, hardcoded permission
  catalog with prefix-based grouping, system-role seeding with implicit permissions
  for superadmin/admin, role list with create modal, role detail page with a
  two-column checkbox grid grouped by namespace, mandatory delete-with-migration
  cascade across `users.role` and `org_members.role`, and the integration points
  with `otp-auth`'s `has_permission` helper. Consumes `otp-auth`; pairs with
  `admin-user-crud`.
dependencies:
  requires: [admin-routing]
  capabilities:
    auth: otp-auth
    user-admin: admin-user-crud
    design-system: admin-only-notus
provides: [rbac]
---

# Admin CRUD of Roles & Permissions

Administrative UI for managing the `roles` collection and the permission catalog it references. Admins list, inspect, create, edit, and delete custom roles, and check or uncheck individual permissions. Every mutation lands in the same `audit_log` collection defined by `admin-user-crud`.

This skill is a consumer of `otp-auth` (it relies on `has_permission` and the `users.role` field) and pairs naturally with `admin-user-crud` (which lets admins assign roles to users). If you are implementing all three, read `otp-auth/SKILL.md` and `admin-user-crud/SKILL.md` first.

## Why this exists as a separate skill

Splitting RBAC out of user-CRUD keeps each surface coherent: the user list edits per-user role assignments, the roles UI edits the role definitions themselves. The two share the `audit_log` collection but no UI. Without this split, you end up either dumping a giant permission grid into the user-edit form (unusable) or hardcoding role names in routes (unmaintainable).

## Permission Catalog

The catalog is **hardcoded in source**, not in the database. A `lib/permissions.py` (or `.ts`) file declares every slug the project knows about, and every code path that gates on permissions imports from there. The DB only stores *which* slugs each role grants — not what slugs exist.

```python
# lib/permissions.py
from typing import List, TypedDict

class Permission(TypedDict):
    slug: str        # canonical id, e.g. "platform.role.edit"
    name: str        # short label for the UI
    description: str # one-sentence explanation for the editor

class PermissionGroup(TypedDict):
    prefix: str      # slug prefix that buckets perms together
    label: str       # UI section header

ALL_PERMISSIONS: List[Permission] = [
    {"slug": "platform.role.superadmin.edit", "name": "Edit superadmin role",
     "description": "Modify the superadmin role's stored fields."},
    {"slug": "platform.role.edit", "name": "Edit roles",
     "description": "Create, rename, and delete custom roles."},
    {"slug": "platform.user.edit", "name": "Edit users",
     "description": "Modify any user's display name, role, or status."},
    {"slug": "org.member.invite", "name": "Invite members",
     "description": "Send invitations to join an organization."},
    # ... full list ...
]

# Order matters: longest-prefix wins so "platform.role.superadmin" buckets
# under its specific group before falling through to "platform.role".
GROUP_ORDER: List[PermissionGroup] = [
    {"prefix": "platform.role.superadmin", "label": "Superadmin"},
    {"prefix": "platform.role",            "label": "Roles"},
    {"prefix": "platform.user",            "label": "Users"},
    {"prefix": "org.member",               "label": "Members"},
    # ... full list ...
]

ALL_PERMISSION_SLUGS = frozenset(p["slug"] for p in ALL_PERMISSIONS)
```

### Why hardcoded, not table-driven

A DB-driven catalog is the canonical anti-pattern here. It looks flexible until you realize:

- New permissions are introduced by code changes, not by admins clicking around. The slug appears in a route gate before it can be assigned, so the catalog has to ship with the code.
- A DB-driven catalog requires a seeding step on every install, and rename refactors become a multi-step migration instead of a find-and-replace.
- The validator (`is_valid_slug`) becomes async + cached + stale, instead of `slug in ALL_PERMISSION_SLUGS`.

The catalog *is* code. Treat it that way.

### Slug naming convention

Dot-namespaced. Two top-level scopes by default — adjust to fit:

- `platform.*` — system-wide actions (managing users, roles, billing settings)
- `org.*` — actions scoped to an organization (inviting members, editing org settings)

Group prefixes are matched **longest-first** so `platform.role.superadmin` shadows `platform.role`. The bucket sort is one line:

```python
ordered_groups = sorted(GROUP_ORDER, key=lambda g: len(g["prefix"]), reverse=True)
match = next((g for g in ordered_groups if perm["slug"].startswith(g["prefix"])), None)
```

## Data Model

### `roles` collection

```ts
interface IRole {
  _id:          ObjectId;
  name:         string;       // machine name, lowercase, NAME_RE: /^[a-z][a-z0-9_]*$/
  label:        string;       // human display label
  permissions:  string[];     // catalog slugs; ALWAYS empty for system roles
  is_system:    boolean;      // superadmin / admin / user
  created_at:   Date;
  updated_at:   Date;
}
```

**Indexes:**
- `{ name: 1 }` unique — `name` is the lookup key (URLs, audit `resource_id`, foreign references in `users.role`)

**System roles store empty `permissions` arrays.** Superadmin and admin get every permission *implicitly*, computed at request time by `has_permission` (see `otp-auth/SKILL.md`). If you store explicit arrays for system roles, you create stale snapshots the moment the catalog grows: a new permission is added in code, every existing admin role is missing it, and the only fix is a migration. With implicit permissions there is no stale state.

### Seeding system roles

Idempotent on every list-roles call:

```python
SYSTEM_ROLES = [
    {"name": "user",       "label": "User"},
    {"name": "admin",      "label": "Admin"},
    {"name": "superadmin", "label": "Super Admin"},
]

async def _seed_system_roles(col):
    now = datetime.now(timezone.utc)
    for role in SYSTEM_ROLES:
        await col.update_one(
            {"name": role["name"]},
            {
                "$setOnInsert": {
                    "name": role["name"],
                    "label": role["label"],
                    "is_system": True,
                    "created_at": now,
                },
                # Reconcile existing rows back to empty perms — handles dev DBs
                # that were seeded under the old (explicit) scheme.
                "$set": {
                    "permissions": [],
                    "is_system": True,
                    "updated_at": now,
                },
            },
            upsert=True,
        )
```

`$setOnInsert` preserves `created_at` and the original label on existing rows; `$set` reconciles `permissions` to empty so a previous installation that stored `["read", "write"]` is corrected on next list. **Run on every list-roles call**, not at startup — startup-only seeding misses fresh databases mounted into a running server, which catches everyone the first time.

## Route Layout

**Canonical path scheme.** The roles editor and permissions catalog are platform-wide concerns (every org shares one role catalog), so they live under `/platform/**` per `admin-routing/SKILL.md` § Two trees. Pages use directory-style routing (`app/(app)/platform/{name}/index.tsx`) with single-noun sidebar labels — never flat-file as `platform-roles.tsx`. See sibling skills for surrounding context:

| Path | Sidebar label | Recipe |
|---|---|---|
| `/admin/users` | Users | `admin-user-crud` |
| `/admin/orgs` | Organizations | `multi-tenant` |
| `/platform/roles` | Roles | this skill |
| `/platform/chat` | Chat | `admin-chat` |
| `/platform/prompts` | Prompts | `admin-prompt-queue` |

```
app/(app)/platform/roles/index.tsx             List + create form + delete-with-migration modal
app/(app)/platform/roles/[name]/index.tsx      Detail: info, label edit, permissions grid, danger zone

app/api/platform/permissions+api.ts            GET catalog
app/api/platform/roles/index+api.ts            GET list (with seed), POST create
app/api/platform/roles/[name]/index+api.ts     GET detail, PATCH update, DELETE (with migrate_to)
```

Every handler starts with the same guard:

```python
try:
    admin = await require_admin(request)
except Exception as e:
    return auth_error_response(e)
```

If the project enforces "only superadmin can edit roles," wrap PATCH/POST/DELETE with `require_permission(request, "platform.role.edit")` instead. Don't scatter that decision across handlers.

## Routes

### `GET /api/platform/permissions`

Returns the static catalog. No auth-scoping — all admins see the full catalog because they need it to read existing role assignments.

```ts
{
  permissions: Permission[];        // ALL_PERMISSIONS verbatim
  groups:      PermissionGroup[];   // GROUP_ORDER verbatim, in display order
}
```

### `GET /api/platform/roles`

```ts
{
  roles: Array<{
    name:        string;
    label:       string;
    permissions: string[];          // empty for system roles
    is_system:   boolean;
    created_at:  Date;
    updated_at:  Date;
  }>;
}
```

Calls `_seed_system_roles()` first, then returns all roles sorted by `name`.

### `GET /api/platform/roles/:name`

Single role document. 404 if not found.

### `POST /api/platform/roles`

```ts
Body: {
  name:        string;              // required, must match NAME_RE
  label:       string;              // required
  permissions: string[];            // catalog slugs; can be empty
}
```

**Validation order:**

1. `NAME_RE.test(body.name)` — lowercase alphanumeric + underscores, must start with a letter. Reject otherwise.
2. `_validate_permissions(body.permissions)` — each slug must be in `ALL_PERMISSION_SLUGS`. Returns the deduplicated, catalog-ordered list (so audit diffs stay stable across reorderings).
3. `roles.findOne({ name })` exists → 409 `role_name_exists`.

The freshly created role always has `is_system: false`. Audit row: `action: "role_created"`, `metadata: { label, permissions }`.

The recommended UX is to create with `permissions: []` and immediately route to the detail page so the admin picks permissions in the full grid — see UI Spec below. Cramming a CSV permissions input into the create modal is the wrong move; the catalog has dozens of slugs and admins need the description text to choose correctly.

### `PATCH /api/platform/roles/:name`

```ts
Body: {                             // both optional
  label?:       string;
  permissions?: string[];
}
```

**Guards:**

- **Renaming a system role.** `target.is_system && body.label !== target.label` → 403 `cannot_rename_system_role`. (System role labels are part of the implicit-permission story — admins navigating to "Admin" expect to see admin perms, not "Senior Editor.")
- **Editing system role permissions.** `target.is_system && body.permissions !== undefined` → 403 `system_role_permissions_implicit`. The seeder will reconcile any write back to empty anyway, so this is a guard against silently-ignored writes.
- `_validate_permissions` runs again here.

Build the update from changed fields only — empty `changes` map → 400 `no_changes`. Audit row: `action: "role_updated"`, `changes: { label?: { old, new }, permissions?: { old, new } }`.

### `DELETE /api/platform/roles/:name?migrate_to=<other_role>`

**Mandatory cascade.** Deleting a role that any user or org member holds would orphan them with an unknown role string, breaking `has_permission` checks across the app. The fix is not "soft-delete the role" or "block delete if anyone holds it" — both push the migration burden onto the admin without giving them tooling. The fix is a mandatory migration parameter:

```python
@router.delete("/roles/{name}")
async def delete_role(
    name: str,
    request: Request,
    migrate_to: str = Query(..., description="Target role name to reassign affected holders"),
):
    # ... auth, lookup ...
    if target.get("is_system"):
        return JSONResponse({"error": "Cannot delete system roles"}, status_code=403)
    if migrate_to == name:
        return JSONResponse({"error": "migrate_to must be a different role"}, status_code=400)
    if not await col.find_one({"name": migrate_to}):
        return JSONResponse({"error": "Migration role not found"}, status_code=404)

    users_result = await db["users"].update_many(
        {"role": name},
        {"$set": {"role": migrate_to, "updated_at": datetime.now(timezone.utc)}},
    )
    members_result = await db["org_members"].update_many(
        {"role": name},
        {"$set": {"role": migrate_to}},
    )
    await col.delete_one({"name": name})

    await write_audit_log(
        actor_id=admin.user_id, actor_email=admin.email,
        action="role_deleted", resource_type="role", resource_id=name,
        metadata={
            "migrated_to": migrate_to,
            "users_migrated": users_result.modified_count,
            "members_migrated": members_result.modified_count,
        },
    )
    return {"status": "deleted", "name": name, "migrated_to": migrate_to,
            "users_migrated": users_result.modified_count,
            "members_migrated": members_result.modified_count}
```

**Cascade list to extend per project:** any collection that stores a role string. Common ones beyond `users` and `org_members`: `invitations.role`, `api_keys.scope_role`, `audit_log` actor snapshots (DON'T migrate these — historical audit rows must reflect the role at the time of action).

**Order: migrate first, delete the role last.** If migration fails partway, the role still exists and a retry with the same `migrate_to` is safe (no-op for already-migrated rows). If you delete the role first, partial migration leaves orphans referencing a role that no longer exists.

## Audit Action Vocabulary (extends admin-user-crud)

| action | resource_type | changes | metadata |
|---|---|---|---|
| `role_created` | `role` | — | `{ label, permissions }` |
| `role_updated` | `role` | fields that actually changed | — |
| `role_deleted` | `role` | — | `{ migrated_to, users_migrated, members_migrated }` |

## UI Spec

### `/platform/roles` — List page

- Header: "Roles (N)", "Create Role" button toggles an inline create form (modal works too — inline saves a click).
- Table columns: name (mono), label, permissions cell, system badge, actions.
- **Permissions cell rendering:**
  - System role with `name === "superadmin"` → `"All permissions (implicit)"`
  - System role with `name === "admin"` → `"All except superadmin (implicit)"`
  - Other system role → `"Implicit"`
  - Custom role with permissions → `"N permissions"` (just the count — pills don't fit and an admin who needs the full list clicks through to the detail page)
  - Custom role with no permissions → `"No permissions"`
- Row click → detail page. Trash icon on custom roles only — opens the **delete-with-migration modal** described below. Pencil icon as a no-op shortcut to the same detail page.
- **Create form is intentionally minimal**: name (with regex enforcement on input), label, and a help line that says "After creating the role, you'll be taken to the detail page to assign permissions." Then `router.push(/platform/roles/${created.name})`. Do NOT put a CSV permissions input here.

### `/platform/roles/:name` — Detail page

Three regions stacked vertically:

1. **Top row: two columns side by side.**
   - Left: read-only Role Info card (name, system flag, created, updated) above an editable form (label only — perms live below).
   - Right: Danger Zone card with the Delete Role button. Hidden entirely for system roles. The narrow column on the right is the natural home for destructive actions; a full-width Delete button on a wide layout looks like a primary CTA.
2. **Permissions card — full width** below the top row. Two columns of permission groups: org permissions on the left, platform permissions on the right. Each group is a bordered section header (`label.toUpperCase()`) followed by `PermissionRow` checkboxes.
3. **Delete-with-migration modal** — overlay rendered last so it sits above everything.

#### `PermissionRow`

Checkbox + name (medium weight) + description (small grey) + slug (mono micro). Checkbox bg is sky-blue when checked, slate-grey when checked-and-disabled (system role view).

```tsx
function PermissionRow({ perm, checked, disabled, onToggle }) { /* ... */ }
```

#### Effective permissions for system roles

The detail page reads system roles in **read-only** mode showing the implicit set, computed client-side from the catalog so the UI matches `has_permission`'s behavior:

```js
function effectivePermissions(role, allPerms) {
  if (role.name === "superadmin") return new Set(allPerms.map(p => p.slug));
  if (role.name === "admin") return new Set(allPerms.filter(p => !p.slug.includes("superadmin")).map(p => p.slug));
  return new Set(role.permissions || []);
}
```

A banner at the top of the Permissions card explains what's going on:

> Superadmin gets every permission automatically. Permissions for system roles are computed at request time and cannot be edited.

#### Group bucketing (client-side)

Same longest-prefix-wins logic as the server, applied to the catalog returned from `GET /api/platform/permissions`:

```js
function groupPermissions(perms, groupOrder) {
  const orderedGroups = [...groupOrder].sort((a, b) => b.prefix.length - a.prefix.length);
  const buckets = new Map();
  const order = [];
  for (const perm of perms) {
    const match = orderedGroups.find(g => perm.slug.startsWith(g.prefix));
    const label = match?.label ?? "Other";
    if (!buckets.has(label)) { buckets.set(label, []); order.push(label); }
    buckets.get(label).push(perm);
  }
  return order.map(label => ({ label, perms: buckets.get(label) }));
}
```

The "Other" bucket catches anything the catalog doesn't explicitly place. If "Other" ever appears in production, it's a sign that a new top-level namespace was added without a matching `GROUP_ORDER` entry.

#### Save dirty-state

Snapshot on load: `{ label, selected: [...selectedSet].sort().join("|") }`. `isDirty` compares the current label and the sorted-joined selected set against the snapshot. Save sends only changed fields. After save, refetch and reset the snapshot.

### Delete-with-migration modal

Rendered from **both** the list-page trash icon AND the detail-page Danger Zone button. Each entry point is otherwise easy to forget to wire up — admins find the entry point they don't expect first.

```
┌─ Delete Role ──────────────────────────────────┐
│ Before deleting <name>, choose a role to       │
│ reassign all users and org members who         │
│ currently hold it.                             │
│                                                │
│ MIGRATE TO                                     │
│ [ Editor ]  [ Viewer ]  [ Admin ]              │
│                                                │
│              [ Cancel ]  [ Delete & Migrate ]  │
└────────────────────────────────────────────────┘
```

- The role list is `allRoles.filter(r => r.name !== currentName)` — exclude self.
- Pills are tap-to-select, single-select, sky-blue when active.
- "Delete & Migrate" is disabled until `migrateTo` is set; loading state during the request.
- On success: refetch the roles list (list page) or `router.replace('/platform/roles')` (detail page).
- "No other roles available" empty state if there's only one role total. (Happens on the very first install if someone immediately tries to delete the user role.)

## Integrations

### `admin-user-crud`

The user-edit form's role dropdown should be populated from `GET /api/platform/roles` rather than hardcoded. When a custom role is renamed (via PATCH here) the dropdown picks up the new label automatically — but **renaming is currently disallowed for system roles AND custom roles use `name` as their stable id**, so a rename of a custom role's label is fine; renaming the `name` is not supported in v1. If you ever add it, run a cascade migration on `users.role` and `org_members.role` the same way the delete cascade does.

### `otp-auth`

`has_permission(session, slug)` lives in `otp-auth/lib/auth.py` and reads from this skill's `roles` collection. The contract is:

```python
async def has_permission(session, slug):
    if session.role == "superadmin": return True
    if session.role == "admin": return "superadmin" not in slug
    role_doc = await db["roles"].find_one({"name": session.role})
    return slug in (role_doc.get("permissions") or [])
```

This is the only consumer of `roles.permissions`. Every other code path goes through `require_permission(request, slug)`. If you find code reading `roles` directly outside of `lib/auth` or this skill's routers, that's a leak — fold it into `has_permission`.

## Anti-Patterns

- **Database-driven permission catalog.** Looks flexible, breaks the moment a route gates on a slug that doesn't exist yet, and turns rename refactors into multi-step migrations. Hardcode `ALL_PERMISSIONS` in source.
- **Storing explicit permissions on system roles.** Stale the moment the catalog grows. System roles get implicit permissions at request time; their stored array is always empty, and the seeder reconciles legacy data on every list call.
- **Letting role delete orphan holders.** A user with `role: "editor"` after `editor` is deleted has *some* role string that doesn't match anything — `has_permission` falls through to "no role doc found, deny everything" and they can't load the dashboard. Mandatory `migrate_to` is the only sane default.
- **Migrate-first-then-delete in the wrong order.** Delete the role last. If migration fails partway, retry is safe; if delete happens first, you have orphan rows pointing at a vanished role.
- **CSV permissions input in the create form.** Slugs are not memorable, the help text is in the catalog, and admins picking from a dropdown of dozens via "type the slug" is friction theater. Create with empty perms, then route to the detail page's full grid.
- **Skipping the permissions banner on system role detail pages.** An admin who clicks "Admin" and sees an editable-looking checkbox grid will tick a box, hit save, get a confusing 403 error, and assume the page is broken. Show the implicit-permissions banner up front and disable the checkboxes visually.
- **Showing permission pills in the list table.** Twenty pills wrap onto four lines per row, the table becomes unreadable, and the count is what admins actually want at a glance. Use the count + the implicit-roles labels.
- **Prefix-grouping by `startsWith` without longest-first sort.** `platform.role.superadmin.edit` gets bucketed under "Roles" instead of "Superadmin" because the matcher hits `platform.role` first. Always sort `GROUP_ORDER` by descending prefix length before iterating.
- **Wiring the delete modal on only one entry point.** The list-page trash icon and the detail-page Danger Zone are both natural spots; admins find the one you forgot first. Wire both, share the modal component if you can.
- **Seeding system roles at app startup only.** Misses fresh databases mounted into a running server (dev resets, test isolation, multi-tenant per-DB installs). Seed inside `GET /api/platform/roles` so the first visit always gets a clean slate.
- **Validating slugs against the DB.** Slow, async, and turns the validator into a cache that goes stale. Use `slug in ALL_PERMISSION_SLUGS` — it's a frozenset literal lookup.

## File Map

| File | Purpose |
|------|---------|
| `lib/permissions.py` (or `.ts`) | `ALL_PERMISSIONS`, `GROUP_ORDER`, `ALL_PERMISSION_SLUGS`, `is_valid_slug` |
| `routers/platform_roles.py` (or `app/api/platform/roles/+api.ts`) | List/seed, get, create, update, delete-with-migration |
| `routers/platform_roles.py` `GET /platform/permissions` | Catalog endpoint — sibling route under the same prefix |
| `app/(app)/platform/roles/index.tsx` | List page + create form + delete-with-migration modal (canonical Expo Router path) |
| `app/(app)/platform/roles/[name]/index.tsx` | Detail page: read-only info, label edit, permissions grid, danger zone |
| `lib/auth.py` `has_permission` | Reads `roles.permissions` — owned by `otp-auth` |
