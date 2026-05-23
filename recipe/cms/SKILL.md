---
name: cms
description: >
  Use when building a lightweight CMS for content items — multi-slug 301-redirect
  chains, dirty-state save + publish toggle, and a WYSIWYG editor that emits
  CommonMark (tables excluded) with S3/local image upload. Covers the data model,
  slug promotion contract, image storage abstraction, the editor UI mounted at
  `/platform/cms`, and the public article view's sticky table-of-contents sidebar
  with scroll-spy active-section highlighting.
dependencies:
  capabilities:
    auth: otp-auth
    design-system: admin-only-notus
provides: [cms]
---

# CMS (Content Items)

A lightweight CMS for creating and publishing content items. Each item owns a `slugs` array where index 0 is the canonical URL; any other entry 301-redirects to it. The editor is a WYSIWYG that saves CommonMark markdown (all formats except tables). A dirty-state Save button and a Publish toggle are the two primary actions. The editor mounts at **`/platform/cms`** in the target app (sidebar label "CMS"). The public side is a catch-all **`/{slug}`** route that renders the article inside the site's standard header and footer — see Public Routing & Rendering below.

## ❗ Hard Rule

**100% of this recipe is binding.** Every section below — data model, editor surface, API contract, public routing, anti-patterns, prose UX rules — is a deliverable. None are "recommended" or "optional." See `recipes/_index.md` rules 1–10 for the universal recipe contract.

**The most-skipped section in past installs is Public Routing & Rendering** (the catch-all `/{slug}` route). Before declaring this recipe done, you MUST have implemented:
- a public catch-all `/{slug}` handler (mounted *last* in the public route table),
- backed by `GET /api/cms/resolve/:slug`,
- with this exact behavior: prime slug → render the article inside the site's standard header/footer (HTTP 200); non-prime slug → HTTP 301 to `/<slugs[0]>`; missing/unpublished/soft-deleted → HTTP 404 (the site's standard 404, not a CMS one).

The catch-all is **read-only**. It does not create new articles, fall back to placeholder content, or invent anything when the resolver returns 404 — it returns 404. Inventing content is an automatic fail.

Read the full Public Routing & Rendering section below before starting. Do not skip past it.

## Data Model

MongoDB with the native driver (`MongoClient`), not Mongoose.

```typescript
export interface IContentItem {
  item_id: string        // random stable ID (randomToken()); never changes
  slugs: string[]        // index 0 = prime (canonical); all others → 301 to prime
  title: string
  description: string    // meta description; empty string triggers auto-pop at save time
  body: string           // CommonMark markdown (see Body section)
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

Slugs are globally unique across every position in every item's `slugs` array (prime and non-prime alike).

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

Immediate on click, no confirmation, no modal. The promotion is applied to the in-memory `slugs` array and becomes permanent only when the author clicks Save — dirty state is the guard.

### Adding a slug

New slugs are appended (`push`) — they start non-prime. Validate against slug rules before write; reject the entire write if any proposed slug conflicts with an existing one.

**Auto-generation on first save:** derive prime slug from title — lowercase, collapse whitespace to hyphens, strip non-`[a-z0-9-]`, collapse consecutive dashes, trim leading/trailing dashes. Author can override before saving. After first save, slug is never auto-regenerated on title change — renames require explicit action via the slug editor / promotion UI.

### Slug conflict response

```typescript
// HTTP 422
{ error: 'slug_conflict', slug: '<conflicting slug>', existing_item_id: '<id>', proposed: '<suggested-alternate-slug>' }
```

`proposed` is the UI's one-click recovery: a server-generated alternate (e.g. append `-2`, or append a short random suffix) that is guaranteed conflict-free at time of generation.

No partial write: if any slug in a batch conflicts, the entire write fails.

## Fields

### Title

Plain text, single line, required, no markdown. Trim on save. Cap around 500 chars.

### Description

Used as `<meta name="description">`. Stored in `description`. If empty at save time, auto-populated from body:

1. Strip markdown markers: `**`, `*`, `_`, list prefixes (`- `, `* `, `1. `), link syntax (`[…](…)`).
2. Collapse whitespace (newlines → spaces, runs → one space). Trim.
3. Hard limit: 160 characters.
4. Prefer sentence boundary (`.`, `!`, `?` + space or end) within the last 40 chars of the window. Fallback: word boundary. Fallback: hard cut.
5. Append `…` if truncated.

**Why compute at save time and store:** the auto-description is visible to the editor on next load, so the author can see and override it. Render-time computation hides it from the UI and re-runs on every page load.

If the author has typed a non-empty `description`, never overwrite it on subsequent saves.

### Body

CommonMark, all formats except tables. No HTML passthrough.

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

Tables are the only excluded format. No application-level body length cap — the MongoDB BSON document limit (16 MB) is the only ceiling.

**Link rendering:** links are stored verbatim. No editor-side link type distinction. At render time, a link is treated as same-tab (crosslink) if ANY of:
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

**Paste behavior:** standard browser paste. No interception, no stripping, no transformation. Accept whatever the browser's default paste event delivers.

**WYSIWYG / Raw markdown tabs:** the editor has two views toggled by a tab or switch:
- **WYSIWYG** (default on load) — rendered, interactive editing
- **Raw** — plain markdown text editing

Both views are editable. Changes in one sync to the other in real time (or on tab switch — specify sync timing before implementing). WYSIWYG is always the default view on load.

### Images

Image upload is in scope. Triggers: clipboard paste of image blobs, and drag-and-drop anywhere on the editor surface (entire editor viewport is a drop target — no designated drop zone).

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

## API Routes

All write routes and reads of unpublished items require auth. Public reads of published items are unauthenticated. Gate protected routes behind a permission guard that already escalates admin roles — do not hand-roll a role OR check.

```typescript
// At the top of every protected CMS route handler
try {
  const session = await requirePermission(request, 'cms_editor')
  // session is AuthSession; proceed
} catch (err) {
  return authError(err)  // converts to 401/403/500
}
```

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
Auth required. Soft delete: sets `deleted_at: new Date()`. Item is excluded from all public listings and search. Slugs on the deleted item return 404 — no redirect-on-delete. Does not physically remove the document. Orphaned-path redirects are a separate concern — use a dedicated 404 redirector system for those.

### `GET /api/cms/resolve/:slug` (public)
Used by the public `/{slug}` route handler.
- `slugs` contains `:slug` AND `slugs[0] === slug` AND `published: true` AND `deleted_at` absent → return item
- `slugs` contains `:slug` AND `slugs[0] !== slug` AND `deleted_at` absent → `{ redirect: '/<slugs[0]>' }` (caller issues 301)
- `slugs` contains `:slug` AND `deleted_at` present → 404
- Not found, unpublished, or deleted → 404

## Public Routing & Rendering

The public layer is a single catch-all route at `/{slug}` that calls `GET /api/cms/resolve/:slug` and acts on the response. CMS articles render inside the same site chrome (header, footer, global styles, fonts) as every other public page on the marketing site — a CMS article is just another page on the site, not a styled-differently embed.

Mount the catch-all *last* in the public route table so it doesn't shadow real routes (`/`, `/about`, `/admin/*`, `/platform/*`, asset paths). Reserved slug prefixes — at minimum `admin`, `platform`, `api`, `static`, `_next` (or framework-equivalent) — must be rejected by slug validation so an author cannot create a CMS item that collides with a real route.

### Route handler

```typescript
// Catch-all handler — exact form depends on the framework (Next app router,
// Express wildcard, Astro [...slug], etc.). Logic is the same.
async function handleSlug(slug: string, res: Response) {
  const r = await fetch(`${INTERNAL_API_BASE}/api/cms/resolve/${encodeURIComponent(slug)}`)
  if (r.status === 404) return render404(res)

  const data = await r.json()
  if ('redirect' in data) {
    res.statusCode = 301
    res.setHeader('Location', data.redirect)
    res.setHeader('Cache-Control', 'public, max-age=300')
    return res.end()
  }
  return renderArticle(res, data.item)
}
```

**Always 301, never 302/307** for slug aliases. Browsers and search engines cache 301s and pass SEO weight; a 302 keeps the old slug alive in indexes and forces every visit to re-resolve.

Do not put a CDN / edge cache between the resolver and the public read with a TTL longer than a few seconds. Publish and unpublish need to be visible to the author immediately after the click, and the editor has no cache-purge step.

### Page template

The public article page renders inside the site's standard chrome:

- **Header** — the same component the marketing site uses on every other public page. Do not build a CMS-specific header.
- **Footer** — same component, same.
- **Body** — render `item.body` through `markdown-it` with `{ html: false }`. Wrap the output in the same typography container the marketing site uses for prose (`<article class="prose">` or equivalent) so headings, lists, blockquotes, and code blocks pick up the site's existing styles automatically.
- **Title** — render `item.title` as the page's `<h1>` at the top of the article body, above the rendered markdown.
- **Table-of-contents sidebar** — see Table of Contents Sidebar below. Required on every article view, not optional.
- **No edit affordances** on the public page. The author UI lives at `/platform/cms`. The public render must not leak edit links, draft banners, or item IDs into the DOM.

### Table of Contents Sidebar

Every article view renders a sticky table-of-contents sidebar that lists the article's H2 and H3 headings and highlights the section the reader is currently viewing. This is a deliverable, not a nice-to-have — the catch-all article page is incomplete without it.

**Build the TOC at render time, in the same pass as the markdown HTML.** The renderer returns both the rendered HTML and a `TocItem[]`:

```typescript
export type TocItem = { id: string; text: string; level: number }  // level ∈ {2, 3}

export function renderMarkdown(body: string): { html: string; toc: TocItem[] }
```

Inside the renderer:

1. Walk the markdown-it token stream. For every `heading_open` token where `level` is 2 or 3, derive an `id` (slugify the heading text: lowercase, strip non-letter/number/space/hyphen, collapse whitespace to `-`, trim leading/trailing `-`). Set the `id` attribute on the heading token via `token.attrSet('id', id)` so the rendered `<h2>` / `<h3>` carries it. Push `{ id, text, level }` onto the TOC array.
2. Support an explicit anchor override syntax: `## Heading {#custom-anchor}` — when matched, use `custom-anchor` as the id and strip `{#…}` from both the heading text and the rendered output.
3. De-duplicate ids by appending `-2`, `-3`, … to collisions in document order.
4. Strip a leading `N. ` numeric prefix from the TOC display text only (the rendered heading itself keeps the number). This keeps a TOC like "Overview / Setup / Deployment" readable when the article uses "1. Overview", "2. Setup", "3. Deployment".
5. H1 is excluded from the TOC because the `<h1>` is the page title, rendered above the body. H4–H6 are excluded — they nest too deep to be useful in a sidebar.

**Layout.** On `lg+` viewports, the article page becomes a three-column grid: `[200px TOC] [1fr article body] [260px related-articles aside]`. When the article has no headings (`toc.length === 0`), the TOC column collapses and the grid drops to two columns. Below `lg`, the TOC is hidden (`hidden lg:block`) — mobile users get the article body only.

**Stickiness.** The TOC sits in a `<aside>` with `position: sticky; top: 6rem` (matching the header offset) and `max-height: calc(100vh - 8rem)` with `overflow-y: auto`, so a long TOC scrolls within itself while the rest of the page scrolls normally.

**Active section highlighting.** Use `IntersectionObserver`, not raw scroll listeners. Scroll listeners fire dozens of times per second and force layout reads — the observer is the right primitive.

```typescript
"use client";
import { useEffect, useState } from "react";

export default function TableOfContents({ items }: { items: TocItem[] }) {
  const [activeId, setActiveId] = useState<string>("");

  useEffect(() => {
    if (items.length === 0) return;
    const headings = items
      .map((i) => document.getElementById(i.id))
      .filter((el): el is HTMLElement => el !== null);
    if (headings.length === 0) return;

    const visible = new Map<string, number>();  // id → boundingClientRect.top
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.set(entry.target.id, entry.boundingClientRect.top);
          else visible.delete(entry.target.id);
        }
        if (visible.size > 0) {
          // Topmost heading inside the active zone wins
          const topmost = [...visible.entries()].sort((a, b) => a[1] - b[1])[0];
          setActiveId(topmost[0]);
          return;
        }
        // Active zone empty → fall back to the last heading scrolled past
        const scrollY = window.scrollY + 100;
        let current = "";
        for (const h of headings) {
          if (h.offsetTop <= scrollY) current = h.id;
          else break;
        }
        if (current) setActiveId(current);
      },
      { rootMargin: "-80px 0px -70% 0px", threshold: 0 },
    );
    headings.forEach((h) => observer.observe(h));
    return () => observer.disconnect();
  }, [items]);

  if (items.length === 0) return null;
  // Render <nav> with one <a href={`#${item.id}`}> per item;
  // active item gets the accent color + accent left border.
}
```

Key behaviors of the highlighter:

- **`rootMargin: "-80px 0px -70% 0px"`** defines the "active zone" — a horizontal band roughly 80px below the top of the viewport down to ~30% of viewport height. A heading is "active" while it sits inside this band. The exact numbers track the sticky header height; if the header height changes, update the top margin.
- **Topmost-wins tiebreak.** When multiple headings are inside the active zone simultaneously (long, dense articles), pick the one closest to the top — that's the section the reader is reading, not the next one peeking in.
- **Fallback for the gap between sections.** When no heading is inside the active zone (the reader is mid-section, all headings are above or below the band), fall back to "the last heading the reader scrolled past" by comparing each heading's `offsetTop` to `scrollY + 100`. Without this, the highlight blanks out between every heading transition, which looks broken.
- **Heading scroll offset.** Apply `scroll-margin-top: 6rem` (or equivalent) to every rendered heading so that clicking a TOC link or landing on `#anchor` doesn't bury the target heading under the sticky header. With Tailwind: `prose-headings:scroll-mt-24`.
- **Anchor-link clicks.** TOC items are plain `<a href="#id">` — let the browser handle the jump natively. Do not intercept with `scrollIntoView` or `preventDefault` unless adding smooth scroll, which is optional.

**Visual treatment.** The active item is the only one in the accent color with an accent-colored left border; inactive items use muted text with a transparent left border (so the active state is a color change, not a layout shift). The whole list sits inside a single thin left border that the active marker visually rides on.

**Anti-patterns specific to the TOC sidebar:**

- **Computing the TOC client-side after render.** Walking the DOM in `useEffect` to find headings re-runs on every navigation, races against hydration, and ships unnecessary JavaScript. Compute the TOC during the same `markdown-it` parse pass that produces the HTML, then pass `toc: TocItem[]` to the client component.
- **Driving the highlighter with a `scroll` event listener.** Scroll handlers fire dozens of times per second and force layout reads on every tick. Use `IntersectionObserver` for the in-zone tracking and only fall back to a one-shot `scrollY` read when the zone is empty.
- **Highlighting only on exact heading intersection.** A reader sitting mid-section has no heading on screen — the highlight goes blank and the sidebar looks broken. The "last heading scrolled past" fallback is required.
- **Including H1 in the TOC.** The page `<h1>` is the title rendered above the article body; it's redundant inside an "On this page" list and pushes real sections down.
- **Forgetting `scroll-margin-top` on rendered headings.** Without it, every TOC click and every direct `#anchor` visit lands with the heading hidden under the sticky header.
- **Leaving the TOC column reserved when the article has no headings.** A 200px-wide empty gutter is worse than a missing column. Switch the grid template to two columns when `toc.length === 0`.

### Meta tags

Set in the rendered page's `<head>`:

```html
<title>{item.title}</title>
<meta name="description" content={item.description} />
<link rel="canonical" href={`https://${siteHost}/${item.slugs[0]}`} />
<meta property="og:title" content={item.title} />
<meta property="og:description" content={item.description} />
<meta property="og:url" content={`https://${siteHost}/${item.slugs[0]}`} />
<meta property="og:type" content="article" />
<meta name="twitter:card" content="summary_large_image" />
```

`canonical` always points to the prime slug, even when the request URL itself is the prime slug. This protects against duplicate-content competition from tracking params, trailing slashes, and case variants of the same URL.

`siteHost` is the same config constant used by the link-rendering helper in the Body section — share one source of truth.

### HTTP status table

| Resolver result | Public response |
|---|---|
| Prime slug match, published, not deleted | `200` + rendered page |
| Non-prime slug match, not deleted | `301` + `Location: /<prime>` |
| Slug present on a deleted item | `404` |
| Slug not in any item, or item unpublished | `404` |

The 404 page should be the site's standard 404, not a CMS-specific one.

## Fit-to-Project

**Recommended defaults** (commit to these; swap only if project constraints require):

- **Markdown renderer: `markdown-it`** — handles CommonMark reliably, has a mature plugin ecosystem, and disables HTML passthrough via `{ html: false }` by default, which eliminates the XSS surface without extra configuration. `marked` is viable but needs more manual sanitization setup. The editor serializer must emit exactly what `markdown-it` expects — configure both together.
- **WYSIWYG editor: Tiptap** — built on ProseMirror, has first-class CommonMark serialization, and supports all required marks (bold, italic, headings, lists, blockquotes, code, images, links) via official extensions. Custom marks for the link rendering logic are straightforward. ProseMirror alone is lower-level and requires more boilerplate. Hand-rolled is not recommended given the format breadth.

**Before implementing, check:**

- **Storage** — MongoDB + native driver is the default. If the project uses a different storage layer, adapt the data model (slugs array, dirty state, publish state, `deleted_at` soft delete) while preserving the logical model.
- **Auth guard** — wire CMS routes to a `requirePermission(request, 'cms_editor')`-style helper. If the project's permission system already escalates `admin` / `superadmin` automatically, do not add a manual OR check.
- **Image storage** — AWS credentials (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET`) trigger S3 mode; absence falls back to local filesystem. Ensure the local path is under a publicly served static directory.
- **Image upload handler details** — resolve before shipping: (a) alt text UX (prompt on upload vs. empty alt), (b) max file size (10 MB is a reasonable default), (c) allowed MIME types (`image/jpeg`, `image/png`, `image/gif`, `image/webp`; exclude SVG for XSS), (d) resize / web-safe conversion server-side.
- **Slug validation** — default regex `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, 3–200 chars. Confirm against existing URL conventions in the project.
- **Content types** — is there one flat collection or multiple typed items (page, post, guide)? Does type affect public routing? Default is flat.
- **Link host detection** — `siteHost` must be available to the renderer as an env var or config constant (e.g. `example.com`). The `isInternalLink` helper above uses it for subdomain matching, and the public page template uses it for the `canonical` and `og:url` meta tags.
- **Public catch-all wiring** — confirm where `/{slug}` mounts in the framework's route table and that it sits *after* every static, `/admin/**`, and `/platform/**` route. Reserved slug prefixes (`admin`, `platform`, `api`, `static`, framework-internal) must be in the slug validator's denylist before launch; missing this lets an author publish an item at `/admin` or `/platform` and break the editor.
- **Header/footer source** — identify the existing layout component the marketing site already uses for public pages and reuse it directly. If no shared layout exists yet, extract one *before* shipping the public CMS route — do not fork a "CMS layout" that drifts.

## Anti-Patterns

- **Dropping the old prime on slug promotion** — when promoting a non-prime slug to prime, removing the previous `slugs[0]` from the array breaks every inbound link and cached 301 that pointed at it. Always keep all slugs in the array; only reorder.
- **Storing `published` state outside the document** — a separate `published_items` collection or a join lookup introduces race conditions on publish/unpublish. The `published` boolean lives on `IContentItem` and is updated in the same write as the content.
- **Computing auto-description at render time only** — the author can't see or override a render-time auto-description; they don't know what will appear in search results. Compute at save time, store in `description`, show in the editor.
- **Allowing HTML passthrough in the markdown body** — storing `<script>`, `<iframe>`, or arbitrary `<style>` in a markdown body field creates XSS surface. The renderer must reject or strip all HTML. The editor must not emit it.
- **Using Mongoose for this collection** — Mongoose caches models and silently strips unrecognized fields on `.save()`. Use the native MongoDB driver (`MongoClient`) directly.
- **Checking `HTTP 200` alone for slug conflict** — the unique index on `slugs` raises a MongoDB duplicate key error that must be caught and converted to a 422 with a meaningful message. An unhandled unique violation returns a 500 and exposes DB internals.
- **Naive dirty-state check on `slugs` array** — `current.slugs !== saved.slugs` is always `true` (different array references). Stringify both sides or compare element-by-element.
- **Publish without implicit save** — if Publish is a separate write from Save, it's possible to publish a stale version (user edits body → clicks Publish without clicking Save → old body goes live). Publish must write the current in-memory state, not just flip the `published` flag.
- **Auto-regenerating prime slug on title change** — once the first save has happened, a title rename must not silently change the URL. That breaks every inbound link. Renames require explicit promotion.
- **Redirect-on-delete** — a soft-deleted item's old slugs must return 404, not redirect somewhere. Orphaned-path redirects belong in a separate 404 redirector system; mixing them into the CMS couples deletion to routing surface area.
- **Absolute URLs in stored image markdown** — writing `s3://bucket/...` or `https://cdn.example.com/...` into the body locks the content to one backend. Keep stored paths relative (`/cms/images/...`); resolve to an absolute URL at render time if needed.
- **SVG image uploads** — SVG can carry inline `<script>`, so treating it like any other image is an XSS vector. Exclude it from the allowed MIME list.
- **302/307 instead of 301 for slug aliases** — non-301 redirects don't transfer SEO weight and keep the old slug "live" in search indexes and browser caches. The alias path must always be a permanent redirect.
- **CMS-specific page chrome** — building a separate header/footer/layout for CMS articles (because "it's a different system") creates two layouts to keep in sync and makes CMS pages visibly distinct from the rest of the site. Reuse the marketing site's existing public layout components directly.
- **Omitting the canonical link tag** — without `<link rel="canonical">` on the public page, tracking params (`?utm_source=…`), trailing slashes, and case variants register as duplicate pages competing for the same article. Always emit a canonical pointing at the prime slug.
- **Caching the resolve endpoint at the edge** — a CDN/edge cache between the public route and `/api/cms/resolve/:slug` makes publish, unpublish, and slug promotion appear delayed in the editor (the author clicks Publish, the page is still 404 / still old). Keep that path uncached or set TTL ≤ a few seconds.
- **Mounting the `/{slug}` catch-all before other public routes** — a permissive catch-all registered first will swallow `/about`, `/pricing`, asset paths, and admin routes. The catch-all is mounted last; reserved slug prefixes are blocked at the validator.
- **Leaking author-only data into the public render** — embedding `item_id`, `created_by`, draft state, or "edit" links into the public page DOM exposes internal IDs and confuses public visitors. The public page sees `title`, `description`, `body`, `slugs[0]` only.

## Logging

- On every `POST /api/cms/items` and `PATCH`: log `item_id`, `updated_by`, which fields changed, and `published` state transition (`false → true` or `true → false`).
- On slug conflict: log the conflicting slug, the requesting `user_id`, and the `existing_item_id`.
- On slug promotion: log `item_id`, promoted slug, previous prime slug, and `updated_by`.
- On `DELETE`: log `item_id`, all slugs (for post-mortem analysis; slugs become 404s after deletion), and `deleted_by`.
