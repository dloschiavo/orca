---
name: sitemap
description: >
  Use when adding a public XML sitemap + robots.txt to a Goliath public site
  (landing-marketing-site, Next.js App Router, optionally backed by `cms`).
  Covers the file layout (app/sitemap.ts + app/robots.ts at the route root,
  not inside a route group), prime-slug-only derivation from a CMS
  `slugs[]` array, tag-derived category routes with the `page` tag
  excluded, `force-dynamic` to avoid build-time caching, robots.txt
  allow/disallow set, and the explicit decision to NOT auto-submit to
  Google Search Console (manual UI step takes 30s, scripting it costs
  hours).
dependencies:
  capabilities:
    public-page: landing-marketing-site
    cms: cms
---

# Public Sitemap & Robots.txt

Public-facing `/sitemap.xml` + `/robots.txt` for a Next.js App Router site that mixes a small set of static marketing routes with a CMS-driven content set. The whole thing is two short files in `app/` — no extra package, no build step, no cron. The load-bearing rules are: only canonical (prime) slugs go in, only published+non-deleted CMS rows, no admin/auth/api routes, and the sitemap file must live at the *route* root (`app/sitemap.ts`), not inside a route group like `app/(public)/sitemap.ts`.

Reference implementation: `goliathdynamics.com/web/src/app/`:
- `sitemap.ts` — Next.js `MetadataRoute.Sitemap` generator
- `robots.ts` — `MetadataRoute.Robots` generator
- `(public)/[slug]/page.tsx`, `(public)/category/[category]/page.tsx` — the routes the sitemap enumerates
- `lib/cms.ts` — `listPublishedItems()` source of truth

## File Placement

Both files go at `app/sitemap.ts` and `app/robots.ts` — the *route* root. Next.js maps them to `/sitemap.xml` and `/robots.txt` based on their position in the App Router tree, and **route groups don't count as path segments**. If your public routes live under `app/(public)/...`, the sitemap still goes at `app/sitemap.ts`, not `app/(public)/sitemap.ts`. Putting it inside the route group will either serve at the wrong path or not at all depending on Next version, and the framework gives no warning.

If the project has no root `app/layout.tsx` (each route group owns its own layout), that's fine — sitemap.ts and robots.ts are metadata routes and don't need a layout.

## Sitemap Composition

The sitemap is three concatenated arrays:

```ts
return [...staticEntries, ...cmsEntries, ...categoryEntries];
```

### 1. Static entries

A hand-maintained list of marketing routes. Keep it small — anything dynamic should come from the CMS or the tag derivation, not be added here:

```ts
const STATIC_PATHS = [
  { path: "",         changeFrequency: "weekly",  priority: 1.0 },
  { path: "/about",   changeFrequency: "monthly", priority: 0.8 },
  { path: "/services",changeFrequency: "monthly", priority: 0.8 },
  { path: "/careers", changeFrequency: "weekly",  priority: 0.7 },
  { path: "/blog",    changeFrequency: "daily",   priority: 0.9 },
];
```

The homepage path is `""` (empty), not `"/"`. The base URL already carries the host; appending `/` produces a double-slash URL that Search Console flags.

### 2. CMS entries — prime slugs only

The CMS stores each item with a `slugs: string[]` where `slugs[0]` is canonical and `slugs[1..]` are 301-redirect aliases. **The sitemap includes only `slugs[0]`.** Including aliases creates duplicate-content URLs that Google de-ranks. The resolver already 301s aliases to prime, so a crawler that lands on an alias gets redirected anyway — but a sitemap that *advertises* the alias is signaling "this is a distinct page."

Filter at the source:

```ts
const items = await listPublishedItems(); // published: true, deleted_at: not set
const cmsEntries = items.map((item) => {
  const isPage = item.tags?.includes("page");
  return {
    url: `${base}/${item.slugs[0]}`,
    lastModified: new Date(item.updated_at ?? item.created_at),
    changeFrequency: isPage ? "monthly" : "weekly",
    priority: isPage ? 0.6 : 0.7,
  };
});
```

`listPublishedItems()` (or whatever the project's equivalent is) must already filter `published: true` and `deleted_at: { $exists: false }`. Don't re-filter in the sitemap — single source of truth.

### 3. Category entries — derived from tags, `page` excluded

Categories aren't a separate collection; they're a deduped set of tags across published items. Build it from the items you already fetched:

```ts
const tagSet = new Set<string>();
for (const item of items) {
  for (const tag of item.tags ?? []) {
    if (tag !== "page") tagSet.add(tag);
  }
}
const categoryEntries = Array.from(tagSet).map((tag) => ({
  url: `${base}/category/${encodeURIComponent(tag)}`,
  lastModified: now,
  changeFrequency: "weekly",
  priority: 0.5,
}));
```

`encodeURIComponent` matters — tags with slashes, spaces, or unicode silently produce invalid URLs otherwise.

**Why exclude `page`:** items tagged `page` are evergreen non-article pages (legal, IR, privacy). A `/category/page` route would list "all pages" which is meaningless. Mirror the same exclusion that the `[slug]` route already uses to decide whether to show "Related articles" and the "← All Articles" link.

## Caching

```ts
export const dynamic = "force-dynamic";
```

Without this, Next.js statically generates the sitemap at build time and serves stale content forever. CMS content changes; sitemap must reflect that. The sitemap is one DB query — there's no performance argument for caching it.

## Base URL

Read from `NEXT_PUBLIC_SITE_URL` with a hardcoded prod fallback. Strip trailing slash so `${base}${path}` doesn't double-slash:

```ts
const base = (process.env.NEXT_PUBLIC_SITE_URL || "https://www.example.com").replace(/\/$/, "");
```

In dev the env points at `http://localhost:3001` (or wherever) — that's fine for local verification. Production gets the canonical host from `.env.prod`.

## robots.txt

```ts
export default function robots(): MetadataRoute.Robots {
  const base = (process.env.NEXT_PUBLIC_SITE_URL || "https://www.example.com").replace(/\/$/, "");
  return {
    rules: [{
      userAgent: "*",
      allow: "/",
      disallow: ["/admin", "/auth", "/login", "/api"],
    }],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
```

The disallow list mirrors the project's auth-gated route prefixes — admin shell, auth/login pages, all API routes. **Why disallow `/api` even though API responses aren't usually indexed:** some API routes return HTML on error (Next default `_error` page) or render contact-form acknowledgements that look like indexable content. Block at the path level once and forget.

## Verifying Locally

Start the dev server and curl both:

```sh
curl -sS http://localhost:3000/sitemap.xml | head -40
curl -sS http://localhost:3000/robots.txt
```

Check:
- URL count = static + CMS prime slugs + unique tags (excluding `page`)
- No alias slugs (`grep` for a known alias and confirm absence)
- No admin/auth/api/login paths
- `lastmod` dates look right (CMS rows reflect `updated_at`)

## Google Search Console — Manual, Not Scripted

**Submit the sitemap via the Search Console UI:** Property → Sitemaps → Add new sitemap → `sitemap.xml` → Submit. Takes 30 seconds.

**Do not script this.** The Search Console API requires:
1. User-account OAuth (service accounts don't work without delegation)
2. The `https://www.googleapis.com/auth/webmasters` scope, which gcloud's default ADC doesn't include
3. A "quota project" header where the Search Console API is enabled
4. Periodic interactive reauth (`invalid_rapt`) that breaks any unattended script

Each of those is solvable, but together they cost more time than the manual click ever will, and re-break every few months. The skill is to recognize the trap and not enter it.

If automation is genuinely required (e.g. you're submitting one sitemap per tenant across hundreds of tenants), use a verified service account with domain-wide delegation and a dedicated GCP project with `searchconsole.googleapis.com` enabled — but that's a separate skill and probably not what this is.

## Fit-to-Project

Before implementing:
- **Framework**: this skill assumes Next.js App Router. Pages Router needs `pages/sitemap.xml.ts` and a different signature.
- **CMS source**: is there a `listPublishedItems()` equivalent that already filters `published` + `deleted_at`? Reuse it; don't duplicate the filter logic.
- **Slug shape**: this skill assumes a multi-slug array with `slugs[0]` canonical. If slugs are scalar, just use `item.slug`. If slugs live on a separate redirects collection, the prime-only rule still applies — just enumerate from the items table, not redirects.
- **Category surface**: only include `/category/<tag>` entries if the project actually has a category page. If categories are a future feature, omit that block — don't sitemap routes that 404.
- **Auth-gated prefixes**: tailor the robots disallow list to your project's real prefixes. `/admin`, `/auth`, `/login`, `/api` are common; `/platform`, `/dashboard`, `/internal` may apply.
- **Localized routes**: this skill doesn't cover i18n alternates (`<xhtml:link rel="alternate" hreflang=...>`). If the site has multiple locales, add `alternates: { languages: { ... } }` per entry.

## Anti-Patterns

- **Including alias slugs alongside prime** — every redirect target shows up as a distinct URL in Search Console and gets flagged as duplicate content. Always emit `slugs[0]` only.
- **Putting `sitemap.ts` inside a route group** — `app/(public)/sitemap.ts` either serves at the wrong path or not at all. Route groups don't carry into the URL. Always at `app/sitemap.ts`.
- **Omitting `force-dynamic`** — Next.js statically generates the sitemap at build time by default. New CMS posts never appear until the next deploy. The performance "saving" is meaningless for a query that runs once per crawler request.
- **Hardcoding the site URL** — `https://www.example.com` baked into the source breaks dev and breaks every other deployment. Always read `NEXT_PUBLIC_SITE_URL` with a prod fallback.
- **Including admin/auth/api in the sitemap** — secondary leakage: a sitemap is itself crawled, so anything you list there is *promoted* to crawlers even if the page 401s. Filter at composition, not by hoping `noindex` headers catch it.
- **Building the sitemap from a hardcoded URL list** — a hardcoded list rots the moment someone publishes a new article. The sitemap must derive from the same data the routes do.
- **Hardcoding category tags** — same rot. Derive from the published items' tags every request.
- **Re-filtering published/deleted in the sitemap** — duplicates logic that's already in `listPublishedItems()` and drifts the moment that function changes. Trust the source.
- **Trying to programmatically submit to Search Console** — every path (ADC, gcloud auth, service account) costs hours of OAuth-scope and quota-project debugging. The UI click is 30s. Document the URL and stop.
- **Including the `page` tag in `/category/` routes** — `/category/page` is meaningless and confuses both users and the listing UI. Whatever tag the project uses for evergreen non-article pages gets excluded from the category derivation.
- **Forgetting `encodeURIComponent` on tag URLs** — a tag with a slash, space, or unicode char silently produces a malformed URL that the route can't match.
- **Trailing slash on the base URL** — `https://example.com/` + `/about` = `https://example.com//about`. Strip with `.replace(/\/$/, "")` once.

## Logging

The sitemap has no runtime logging — it's a single request handler that runs the same DB query as the blog index. If a deployed sitemap looks empty or stale:

1. Hit `/sitemap.xml` on the deployed host and count `<loc>` entries.
2. Compare to `db.content_items.countDocuments({ published: true, deleted_at: { $exists: false } })`.
3. If they disagree, the CMS query in `sitemap.ts` has drifted from `listPublishedItems()` — refactor to share one helper.
