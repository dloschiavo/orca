---
name: cms
description: >
  Lightweight CMS for content items: multi-slug 301-redirect chains (live items),
  save, publish toggle, and a WYSIWYG editor that emits CommonMark (tables excluded)
  with S3/local image upload. Forward-looking PRD — not yet implemented.
---

# CMS (Content Items)

A lightweight CMS for creating and publishing content items. Each item owns a `slugs` array where index 0 is the canonical URL; any other entry 301-redirects to it. The editor is a WYSIWYG that saves CommonMark markdown (all formats except tables). A dirty-state Save button and a Publish toggle are the two primary actions. The public routing layer is out of scope here — this PRD covers the data model, the slug/redirect contract, image upload, and the editor UI.

---

## Open Questions

These need resolution before or during implementation. Each item also appears inline in the relevant section.

1. **[OQ-1] ~~Markdown flavor~~ RESOLVED** — CommonMark, all formats except tables. Supported: bold, italic, headings (all levels), ordered lists, unordered lists, blockquotes, inline code, code blocks, horizontal rules, images, links. Tables are the only exclusion. No HTML passthrough.
2. **[OQ-2] ~~Image support~~ RESOLVED** — In scope. Storage: S3 if AWS credentials present in env, local filesystem fallback otherwise. Upload triggers: clipboard paste (image blobs) and drag-and-drop anywhere on the editor surface. See [Images](#images) section. Sub-questions remain (OQ-2a through OQ-2d).
3. **[OQ-3] Slug validation rules** — Proposed: `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, 3–200 chars.
4. **[OQ-4] ~~Slug uniqueness scope~~ RESOLVED** — Globally unique across every slug in every item's entire `slugs` array (prime and non-prime). On conflict: block save AND return a proposed alternate slug in the error response so the UI can offer it with one click.
5. **[OQ-5] ~~Slug auto-generation~~ RESOLVED** — Auto-generate prime slug from title on first save (standard slugifier: lowercase, collapse whitespace to hyphens, strip non-matching chars). Author can override before saving. After first save, prime slug is never auto-regenerated even if title changes — changing slug requires explicit action via slug editor / promotion UI.
6. **[OQ-6] ~~Cross-link resolution~~ RESOLVED** — Links are stored verbatim (href as typed). No editor-side distinction between internal and external links. Render-time only: compare link host against current site's registrable domain. Same domain or same-domain subdomain → normal `<a href="...">` (same tab). Different domain → `target="_blank" rel="noopener noreferrer"`. No href rewrites.
7. **[OQ-7] ~~Paste behavior~~ RESOLVED** — Standard browser paste. No interception, no stripping, no transformation. The WYSIWYG accepts whatever the browser's default paste event delivers.
8. **[OQ-8] ~~Preview mode~~ RESOLVED** — Live WYSIWYG is the default view. A tab/toggle switches to raw markdown view. Both views are editable; changes sync between them. WYSIWYG is the default on load.
9. **[OQ-9] Content types / categories** — Flat collection or typed items (page, post, guide)? Does type affect routing?
10. **[OQ-10] ~~Storage~~ RESOLVED** — MongoDB confirmed. Use native MongoDB driver (`MongoClient`), not Mongoose, consistent with auth collections in this codebase.
11. **[OQ-11] ~~Auth model~~ RESOLVED** — Use `requirePermission(request, 'cms_editor')` from docpost-amplify's `lib/auth.ts`. Docpost's permission system already escalates `admin` and `superadmin` roles automatically — no custom OR check needed. Reference: `docpost-amplify/lib/auth.ts`.
12. **[OQ-12] Description auto-pop trigger** — Compute at save time and store (stable, visible in editor) vs. compute at render time (always fresh, invisible to editor)?
13. **[OQ-13] ~~Body max length~~ RESOLVED** — No application-level limit. MongoDB BSON document limit (16 MB) is the only ceiling. Do not impose a cap in code.
14. **[OQ-14] ~~Slug promotion UX~~ RESOLVED** — Immediate on click. No modal, no confirmation. Clicking "make prime" swaps the slug into index 0 and demotes the previous prime in place. The dirty-state + Save button is the only guard.
15. **[OQ-15] ~~Deletion~~ RESOLVED** — Soft delete: sets `deleted_at`, hides item from all public listings and search. Slugs on deleted items return 404 — no redirect-on-delete. Orphaned-path redirects are a separate concern handled by the 404 Redirector system (see `_unmigrated/404-redirector.md`).

---

## Data Model

MongoDB confirmed. Native driver (`MongoClient`), not Mongoose. (OQ-10 resolved.)

```typescript
export interface IContentItem {
  item_id: string        // random stable ID (randomToken()); never changes
  slugs: string[]        // index 0 = prime (canonical); all others → 301 to prime
  title: string
  description: string    // meta description; empty string triggers auto-pop at save time
  body: string           // light markdown (see Body section)
  published: boolean     // false by default; unpublished items invisible on public site
  created_at: Date
  updated_at: Date
  created_by: string     // user_id
  updated_by: string     // user_id
  deleted_at?: Date      // set on soft delete; absent means not deleted
}
```

**Indexes:**
- `{ slugs: 1 }` — unique multikey; every slug position in every item is globally unique. Conflict → MongoDB unique violation → surface as HTTP 422.
- `{ item_id: 1 }` — unique; primary lookup
- `{ published: 1, updated_at: -1 }` — list view sort

Slugs are globally unique across every position in every item's `slugs` array (OQ-4 resolved).

---

## Slug Behavior

### Prime slug

`slugs[0]` is the canonical URL. The public router serves the item's content at this path.

### Non-prime slugs

`slugs[1…n]` are aliases. Any request arriving at a non-prime slug → `HTTP 301 Location: /<slugs[0]>`. Old slugs stay in the array forever, so no redirect chain ever breaks.

### Promoting a slug to prime

```typescript
// Promote slugs[i] to prime without discarding previous prime
slugs = [slugs[i], ...slugs.filter((_, j) => j !== i)]
```

The previous `slugs[0]` shifts to index 1 and immediately becomes a redirect entry. All prior slugs survive. **Why:** slug promotions happen when a canonical URL changes (SEO rename, typo fix). Dropping the old prime would break every inbound link and every cached 301.

Immediate on click, no confirmation (OQ-14 resolved). The slug promotion is applied to the in-memory `slugs` array and becomes permanent only when the author clicks Save — dirty state is the guard.

### Adding a slug

New slugs are appended (`push`) — they start non-prime. Validate against slug rules before write; reject the entire write if any proposed slug conflicts with an existing one.

> **[OQ-3]** Proposed regex: `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, 3–200 chars.

Auto-generation (OQ-5 resolved): on first save, derive prime slug from title — lowercase, collapse whitespace to hyphens, strip non-`[a-z0-9-]`, collapse consecutive dashes, trim leading/trailing dashes. Author can override before saving. After first save, slug is never auto-regenerated on title change.

### Slug conflict response

```typescript
// HTTP 422
{ error: 'slug_conflict', slug: '<conflicting slug>', existing_item_id: '<id>', proposed: '<suggested-alternate-slug>' }
```

`proposed` is the UI's one-click recovery: a server-generated alternate (e.g. append `-2`, or append a short random suffix) that is guaranteed conflict-free at time of generation.

No partial write: if any slug in a batch conflicts, the entire write fails.

---

## Fields

### Title

Plain text, single line, required, no markdown. Trim on save. Max 500 chars (proposed).

### Description

Used as `<meta name="description">`. Stored in `description`. If empty at save time, auto-populated from body:

1. Strip markdown markers: `**`, `*`, `_`, list prefixes (`- `, `* `, `1. `), link syntax (`[…](…)`).
2. Collapse whitespace (newlines → spaces, runs → one space). Trim.
3. Hard limit: 160 characters.
4. Prefer sentence boundary (`.`, `!`, `?` + space or end) within the last 40 chars of the window. Fallback: word boundary. Fallback: hard cut.
5. Append `…` if truncated.

**Why compute at save time and store:** the auto-description is visible to the editor on next load, so the author can see and override it. Render-time computation hides it from the UI and re-runs on every page load.

> **[OQ-12]** Confirm: compute-and-store at save time. Alternative is render-time (always fresh, but invisible to editor).

If the author has typed a non-empty `description`, never overwrite it on subsequent saves.

### Body

CommonMark, all formats except tables. No HTML passthrough. (OQ-1 resolved.)

| Format | Toolbar | Markdown emitted |
|---|---|---|
| Bold | **B** | `**text**` |
| Italic | *I* | `*text*` |
| Heading 1–6 | H1…H6 | `# `, `## `, … `###### ` |
| Numbered list | `1.` | `1. item\n2. item` |
| Unnumbered list | `•` | `- item\n- item` |
| Blockquote | `"` | `> text` |
| Inline code | `` ` `` | `` `code` `` |
| Code block | `</>` | ` ```\ncode\n``` ` |
| Horizontal rule | `—` | `---` |
| Image | image icon | `![alt](url)` — see Images section |
| Link | link icon | `[label](href)` — href stored verbatim |

Tables are the only excluded format.

**Link rendering (OQ-6 resolved):** links are stored verbatim. No editor-side link type distinction. At render time, a link is treated as same-tab (crosslink) if ANY of:
1. The href is a relative URL (no host component)
2. The href host is `localhost` (any port) — covers dev environments
3. The href host matches the current site's domain or is a subdomain of the same registrable domain

Everything else renders with `target="_blank" rel="noopener noreferrer"`. No href rewrites.

```typescript
function isInternalLink(href: string, siteHost: string): boolean {
  if (!href.includes('://')) return true                          // relative URL
  try {
    const url = new URL(href)
    if (url.hostname === 'localhost') return true                 // dev environment
    const registrable = (h: string) => h.split('.').slice(-2).join('.')
    return registrable(url.hostname) === registrable(siteHost)   // same registrable domain
  } catch { return false }
}
// Usage: isInternalLink(href, siteHost) ? <a href> : <a href target="_blank" rel="noopener noreferrer">
```

Keyboard shortcuts: `Cmd/Ctrl+B` → bold, `Cmd/Ctrl+I` → italic. Heading shortcuts optional (e.g. `Cmd/Ctrl+1`–`6`).

**Paste behavior (OQ-7 resolved):** Standard browser paste. No interception, no stripping, no transformation. Accept whatever the browser's default paste event delivers.

**WYSIWYG / Raw markdown tabs (OQ-8 resolved):** The editor has two views toggled by a tab or switch:
- **WYSIWYG** (default on load) — rendered, interactive editing
- **Raw** — plain markdown text editing

Both views are editable. Changes in one sync to the other in real time (or on tab switch — specify sync timing before implementing). WYSIWYG is always the default view on load.

### Images

(OQ-2 resolved.) Image upload is in scope. Triggers: clipboard paste of image blobs, and drag-and-drop anywhere on the editor surface (entire editor viewport is a drop target — no designated drop zone).

**Storage abstraction:**

```typescript
// Env detection at startup
const useS3 = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && process.env.AWS_S3_BUCKET)

// S3 path: s3://<bucket>/cms/images/<year>/<month>/<uuid>.<ext>
// Local path: /public/cms/images/<year>/<month>/<uuid>.<ext>  (served statically)
// Returned URL: /cms/images/<year>/<month>/<uuid>.<ext>  (relative, same for both backends)
```

**Why relative URL for stored markdown:** switching from local to S3 later requires only a config change and a file migration, not a body text migration, because the stored `![alt](url)` paths are the same relative path regardless of backend.

**Upload handler** (`POST /api/cms/upload-image`): accepts `multipart/form-data` with one image file. Returns `{ url: string }`. The editor inserts `![](url)` at the cursor on success.

**Open sub-questions (flag before implementing):**
- **[OQ-2a] Alt text UX** — Does the editor prompt for alt text on upload, or insert an empty alt and let the author fill it in? Empty alt (`![]()`) is valid markdown but bad for accessibility.
- **[OQ-2b] Max file size** — No limit specified. Proposed: 10 MB. Confirm.
- **[OQ-2c] Allowed MIME types** — Proposed: `image/jpeg`, `image/png`, `image/gif`, `image/webp`. SVG excluded (XSS risk via inline JS). Confirm.
- **[OQ-2d] Resize / optimization** — Should the upload handler resize large images or convert to a web-safe format server-side, or store originals as-is? Not specified.

---

## Editor UI

### Save button — dirty state

Disabled when no unsaved changes. Enabled as soon as any field (`title`, `description`, `body`, `slugs`) differs from the last saved snapshot.

```typescript
// Snapshot taken on load and reset after every successful save
type Snapshot = { title: string; description: string; body: string; slugs: string[] }
const isDirty = (current: Snapshot, saved: Snapshot) =>
  current.title !== saved.title ||
  current.description !== saved.description ||
  current.body !== saved.body ||
  JSON.stringify(current.slugs) !== JSON.stringify(saved.slugs)
```

Navigating away while dirty: browser-native `beforeunload` confirmation (or app-framework equivalent).

### Publish button

Toggles `published` between `false` (draft, default) and `true` (public). Clicking Publish saves the current document state as part of the operation — implicitly saves and clears dirty state in one step.

- `published: false` → button label "Publish"
- `published: true` → button label "Unpublish"

Unpublished items are invisible on the public-facing site. The public router filters to `{ published: true }`.

No scheduled publish in scope.

---

## API Routes

All write routes and reads of unpublished items require auth. Public reads of published items are unauthenticated. Auth guard uses docpost-amplify's `requirePermission` helper (`lib/auth.ts`). Because docpost's `hasPermission` already grants all non-superadmin permissions to `admin` role and all permissions to `superadmin` role, a single `requirePermission(request, 'cms_editor')` call covers all three cases — no hand-rolled OR check needed.

```typescript
// At the top of every protected CMS route handler
// lib/auth.ts from docpost-amplify — requirePermission throws 'Unauthorized' or 'Forbidden'
import { requirePermission, authError } from '../lib/auth'

try {
  const session = await requirePermission(request, 'cms_editor')
  // session is AuthSession; proceed
} catch (err) {
  return authError(err)  // converts to 401/403/500
}
```

Reference implementation for permissions: `docpost-amplify/lib/auth.ts` → `hasPermission` and `requirePermission`.

### `GET /api/cms/items`
Auth required. Returns list for editor UI.
```typescript
{ items: Pick<IContentItem, 'item_id' | 'slugs' | 'title' | 'published' | 'updated_at'>[] }
```

### `GET /api/cms/items/:item_id`
Auth required. Returns full item.
```typescript
{ item: IContentItem }
```

### `POST /api/cms/items`
Auth required. Body: `{ title, description?, body?, slugs? }`. `published` defaults `false`. Auto-generates prime slug from title if `slugs` absent. Returns `{ item: IContentItem }`.

### `PATCH /api/cms/items/:item_id`
Auth required. Partial update — only provided fields written. Always updates `updated_at` and `updated_by`. Validates slug uniqueness before write. Returns `{ item: IContentItem }`.

### `DELETE /api/cms/items/:item_id`
Auth required. Soft delete: sets `deleted_at: new Date()`. Item is excluded from all public listings and search. Slugs on the deleted item return 404 — no redirect-on-delete. Does not physically remove the document. If the site needs orphaned-path redirects, use the separate 404 Redirector system (`_unmigrated/404-redirector.md`).

### `GET /api/cms/resolve/:slug` (public)
Used by the routing layer.
- `slugs` contains `:slug` AND `slugs[0] === slug` AND `published: true` AND `deleted_at` absent → return item
- `slugs` contains `:slug` AND `slugs[0] !== slug` AND `deleted_at` absent → `{ redirect: '/<slugs[0]>' }` (caller issues 301)
- `slugs` contains `:slug` AND `deleted_at` present → 404
- Not found, unpublished, or deleted → 404

---

## Fit-to-Project

**Recommended defaults** (commit to these; swap only if project constraints require):

- **Markdown renderer: `markdown-it`** — Recommended default. Handles CommonMark reliably, has a mature plugin ecosystem, and disables HTML passthrough via `{ html: false }` by default which eliminates the XSS surface without extra configuration. `marked` is a viable alternative but requires more manual sanitization setup. The editor serializer must emit exactly what `markdown-it` expects — configure both together.
- **WYSIWYG editor: Tiptap** — Recommended default. Built on ProseMirror, has first-class CommonMark serialization, supports all required marks (bold, italic, headings, lists, blockquotes, code, images, links) via official extensions, and custom marks for the link rendering logic are straightforward. ProseMirror alone is lower-level and requires more boilerplate. Hand-rolled is not recommended given the format breadth.

**Before implementing:**

- **Storage** — MongoDB is the default. If the implementing project uses a different storage layer, adapt the data model and collection semantics (slugs array, dirty state, publish state, `deleted_at` soft delete) to fit the existing layer while preserving the logical model.
- **Auth guard** — Wire CMS routes to `requirePermission(request, 'cms_editor')` from docpost-amplify's `lib/auth.ts`. No custom role check needed — docpost's permission system already escalates `admin` and `superadmin` roles automatically.
- **Image storage** — AWS credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET`) trigger S3 mode; absence falls back to local filesystem. Ensure the local path is under a publicly served static directory. Resolve OQ-2a–2d (alt text UX, max size, MIME types, resizing) before implementing the upload handler.
- **Link host detection** — `siteHost` must be available to the renderer as an env var or config constant (e.g. `example.com`). The `isInternalLink` helper in the Body section uses it for subdomain matching.

---

## Anti-Patterns

- **Dropping the old prime on slug promotion** — When promoting a non-prime slug to prime, removing the previous `slugs[0]` from the array breaks every inbound link and cached 301 that pointed at it. Always keep all slugs in the array; only reorder.
- **Storing `published` state outside the document** — A separate `published_items` collection or a join lookup introduces race conditions on publish/unpublish. The `published` boolean lives on `IContentItem` and is updated in the same write as the content.
- **Computing auto-description at render time only** — The author can't see or override a render-time auto-description; they don't know what will appear in search results. Compute at save time, store in `description`, show in the editor.
- **Allowing HTML passthrough in the markdown body** — Storing `<script>`, `<iframe>`, or arbitrary `<style>` in a markdown body field creates XSS surface. The renderer must reject or strip all HTML. The editor must not emit it.
- **Using Mongoose for this collection** — Mongoose caches models and silently strips unrecognized fields on `.save()`. Use the native MongoDB driver (`MongoClient`) directly, as with the auth collections in this codebase.
- **Checking `HTTP 200` alone for slug conflict** — The unique index on `slugs` raises a MongoDB duplicate key error that must be caught and converted to a 422 with a meaningful message. An unhandled unique violation returns a 500 and exposes DB internals.
- **Naive dirty-state check on `slugs` array** — `current.slugs !== saved.slugs` is always `true` (different array references). Stringify both sides or compare element-by-element.
- **Publish without implicit save** — If Publish is a separate write from Save, it's possible to publish a stale version (user edits body → clicks Publish without clicking Save → old body goes live). Publish must write the current in-memory state, not just flip the `published` flag.

---

## Logging

- On every `POST /api/cms/items` and `PATCH`: log `item_id`, `updated_by`, which fields changed, and `published` state transition (`false → true` or `true → false`).
- On slug conflict: log the conflicting slug, the requesting `user_id`, and the `existing_item_id`.
- On slug promotion: log `item_id`, promoted slug, previous prime slug, and `updated_by`.
- On `DELETE`: log `item_id`, all slugs (for post-mortem analysis; slugs become 404s after deletion), and `deleted_by`.

---

## History

- **2026-04-08** — Initial PRD. Fifteen open questions documented for follow-up resolution.
- **2026-04-08** — OQ-1 through OQ-6 resolved. Expanded markdown subset to full CommonMark minus tables; added Images section (S3/local, paste+drag, OQ-2a–2d sub-questions); updated slug conflict response to include `proposed`; locked in auto-generation-on-first-save behavior; replaced ID-based cross-link framing with render-time host comparison.
- **2026-04-08** — OQ-7, 8, 10, 11 resolved. Paste: standard browser default, no interception. Editor: WYSIWYG/Raw tab pair, both editable, WYSIWYG default. Storage: MongoDB native driver confirmed. Auth guard: three-way OR (`super_admin`, `admin`, `cms_editor` permission).
- **2026-04-08** — OQ-13, 14, 15 resolved. No body size cap (BSON limit only). Slug promotion: immediate, no confirmation. Soft delete: `deleted_at` field, slugs return 404 on deletion (no redirect-on-delete). OQ-15a removed — orphaned-path redirects are a separate concern, see `_unmigrated/404-redirector.md`.
- **2026-04-08** — Library recommendations committed: `markdown-it` (renderer) and Tiptap (WYSIWYG). Auth guard simplified to `requirePermission(request, 'cms_editor')` via docpost-amplify's permission system. Link rendering refined: relative URLs, localhost, and same-registrable-domain all treated as internal; `isInternalLink` helper added. Fit-to-Project restructured: recommended defaults separated from must-resolve items. OQ-14 resolved (immediate promotion, no confirmation). Image support confirmed in scope — no residual out-of-scope language.
