---
name: SEO Enhancements
description: Five core SEO features covering meta tags, canonical URLs, sitemaps, robots.txt, and changelog pages with structured data, SSR compatibility, and crawlability optimization
type: project
---

# SEO Enhancements

Stack-agnostic recipe for five foundational SEO features: a reusable `SEOHead` component for meta tags and structured data, canonical URL management, dynamic sitemap generation, configurable robots.txt, and an indexed changelog page with RSS feed. All features are designed for SSR compatibility (server-rendered for crawlers) and integrate with the rendering-routing strategy defined in `rendering-routing.md`.

---

## Overview

These five SEO features work together to maximize search engine crawlability, indexation, and ranking signal:

1. **SEOHead Component**: Renders meta tags, Open Graph, Twitter Card, and JSON-LD structured data in the document head
2. **Canonical URL Management**: Generates and handles canonical URLs consistently across routes
3. **Sitemap Generator**: Auto-discovers routes and generates XML sitemaps with optional pagination
4. **robots.txt Template**: Configurable per-environment rules, disallow patterns, and sitemap references
5. **Changelog / What's New Page**: Renders release notes at `/changelog` with RSS feed and client-side "What's New" badge

All features assume SSR (or SSG) rendering for HTML pages; API endpoints are used for dynamic data. Edge cases, caching, and integration points are documented below.

---

## 1. SEOHead Component

A reusable, composition-friendly component that renders SEO meta tags, Open Graph tags, Twitter Card tags, and JSON-LD structured data. Designed to be included once per page (typically in the root layout or page layout) and server-rendered for crawler access.

### Component Interface

```
COMPONENT SEOHead(props):
  PROPS {
    // Required or config-fallback
    title: string
    description: string
    canonical: string

    // Optional: social sharing metadata
    image: string                    // og:image URL
    imageWidth: number               // og:image:width (default 1200)
    imageHeight: number              // og:image:height (default 630)

    // Optional: structured data type
    type: "article" | "website" | "product"  // default: "website"

    // Optional: custom JSON-LD schema (merged with defaults)
    jsonLdSchema?: object            // custom or full schema override

    // Optional: author metadata (for articles)
    author?: {
      name: string
      url?: string
    }

    // Optional: publish/modify dates (for articles)
    datePublished?: ISO8601 string
    dateModified?: ISO8601 string

    // Optional: locale (hreflang alternatives)
    locale?: string                  // e.g., "en-US"
    alternateLocales?: Array<{
      locale: string
      url: string
    }>

    // Optional: Twitter Card metadata
    twitterCard?: {
      handle: string                 // @username
      site?: string                  // site:@username (different from handle)
    }

    // Optional: robots directives
    robots?: string                  // e.g., "index, follow" or "noindex"
  }

  CONFIG (app-level defaults)
  {
    baseURL: string                  // e.g., "https://example.com"
    siteName: string                 // brand name
    defaultImage: string             // fallback og:image
    defaultLocale: string            // e.g., "en-US"
    twitter?: {
      site: string                   // @handle
      creator?: string               // @handle
    }
    facebook?: {
      appId: string
    }
  }
```

### Rendering Rules

```
FUNCTION SEOHead(props, config):

  // 1. Merge defaults from config
  effectiveTitle = props.title || config.siteName
  effectiveDescription = props.description || ""
  effectiveImage = props.image || config.defaultImage
  effectiveLocale = props.locale || config.defaultLocale
  effectiveCanonical = props.canonical

  // 2. Validate canonical URL: must be absolute and match base domain
  IF NOT isAbsoluteURL(effectiveCanonical):
    effectiveCanonical = config.baseURL + effectiveCanonical
  END IF

  IF NOT effectiveCanonical.startsWith(config.baseURL):
    LOG_WARNING "Canonical URL {effectiveCanonical} does not match base URL {config.baseURL}"
    effectiveCanonical = config.baseURL
  END IF

  // 3. Render head elements
  RENDER:
    <head>
      <!-- Essential meta tags -->
      <title>{effectiveTitle}</title>
      <meta name="description" content="{effectiveDescription}">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta charset="utf-8">

      <!-- Canonical URL -->
      <link rel="canonical" href="{effectiveCanonical}">

      <!-- Alternate locales (if provided) -->
      FOR EACH alternate IN props.alternateLocales OR []:
        <link rel="alternate" hreflang="{alternate.locale}" href="{alternate.url}">
      END FOR
      <link rel="alternate" hreflang="x-default" href="{effectiveCanonical}">

      <!-- Open Graph tags -->
      <meta property="og:type" content="{ogType(props.type)}">
      <meta property="og:title" content="{effectiveTitle}">
      <meta property="og:description" content="{effectiveDescription}">
      <meta property="og:image" content="{effectiveImage}">
      <meta property="og:image:width" content="{props.imageWidth || 1200}">
      <meta property="og:image:height" content="{props.imageHeight || 630}">
      <meta property="og:url" content="{effectiveCanonical}">
      <meta property="og:locale" content="{effectiveLocale}">

      IF config.facebook?.appId:
        <meta property="fb:app_id" content="{config.facebook.appId}">
      END IF

      <!-- Twitter Card tags -->
      IF props.twitterCard OR config.twitter:
        <meta name="twitter:card" content="summary_large_image">
        <meta name="twitter:title" content="{effectiveTitle}">
        <meta name="twitter:description" content="{effectiveDescription}">
        <meta name="twitter:image" content="{effectiveImage}">

        IF props.twitterCard?.handle:
          <meta name="twitter:creator" content="@{props.twitterCard.handle}">
        ELSE IF config.twitter?.creator:
          <meta name="twitter:creator" content="@{config.twitter.creator}">
        END IF

        IF props.twitterCard?.site OR config.twitter?.site:
          <meta name="twitter:site" content="@{props.twitterCard.site || config.twitter.site}">
        END IF
      END IF

      <!-- Robots directive -->
      IF props.robots:
        <meta name="robots" content="{props.robots}">
      END IF

      <!-- JSON-LD Structured Data -->
      <script type="application/ld+json">
        {buildJSONLD(props, config, effectiveCanonical)}
      </script>

    </head>
```

### JSON-LD Schema Builder

```
FUNCTION buildJSONLD(props, config, canonical):

  // Base schema for all pages
  schema = {
    "@context": "https://schema.org",
    "@type": mapType(props.type),
    "name": props.title,
    "description": props.description,
    "url": canonical,
    "image": {
      "@type": "ImageObject",
      "url": props.image || config.defaultImage,
      "width": props.imageWidth || 1200,
      "height": props.imageHeight || 630
    }
  }

  // Add organization info
  schema.publisher = {
    "@type": "Organization",
    "name": config.siteName,
    "image": config.defaultImage,
    "url": config.baseURL
  }

  // Locale info
  IF config.defaultLocale:
    schema.inLanguage = config.defaultLocale
  END IF

  // Author (for articles)
  IF props.type == "article" AND props.author:
    schema.author = {
      "@type": "Person",
      "name": props.author.name,
      "url": props.author.url
    }
  END IF

  // Date published / modified (for articles)
  IF props.type == "article":
    IF props.datePublished:
      schema.datePublished = props.datePublished
    END IF
    IF props.dateModified:
      schema.dateModified = props.dateModified
    END IF
  END IF

  // Merge custom schema
  IF props.jsonLdSchema:
    schema = deepMerge(schema, props.jsonLdSchema)
  END IF

  RETURN JSON.stringify(schema)
```

### Schema Type Mapping

```
FUNCTION mapType(propsType):
  SWITCH propsType:
    CASE "article":
      RETURN "NewsArticle"  // or "BlogPosting" for blogs
    CASE "product":
      RETURN "Product"
    CASE "website":
    DEFAULT:
      RETURN "WebPage"
  END SWITCH
```

### Usage Example (Pseudocode)

```
// On an article page
COMPONENT ArticlePage(props):
  article = fetchArticle(props.slug)

  RENDER:
    <RootLayout>
      <SEOHead
        title="{article.title}"
        description="{article.excerpt}"
        canonical="https://example.com/blog/{article.slug}"
        image="{article.heroImage}"
        type="article"
        author={{ name: article.authorName }}
        datePublished="{article.publishedAt}"
        dateModified="{article.updatedAt}"
      />
      <main>
        {/* Render article content */}
      </main>
    </RootLayout>
```

### Edge Cases & Gotchas

1. **Missing Description Fallback**: If description is not provided, use a truncated excerpt from page content (first 160 characters). Never leave `og:description` empty.

2. **Image Validation**: Verify image URL is absolute and accessible. If image returns 404, log warning and fall back to `defaultImage`.

3. **Canonical URL Duplicates**: If the same page is accessible via multiple URLs (e.g., `/blog/post` and `/blog/post/`), ensure only one canonical is declared. Middleware should enforce trailing slash consistency (see Canonical URL Management below).

4. **SSR-only Rendering**: SEOHead **must be rendered on the server**. If using SPA rendering, this component will not inject meta tags into the HTML. Use SSR for SEO-critical pages.

5. **Hydration Mismatch**: Ensure props passed to SEOHead on server match props on client. Use immutable config; avoid randomization.

---

## 2. Canonical URL Management

A utility function and middleware system that generates canonical URLs for all routes, handles trailing slashes consistently, and strips query parameters that don't affect content.

### Canonical URL Rules

```
// Canonical URL rules (in order of precedence):
1. Absolute HTTP(S) URL (never relative)
2. Matches base domain (never cross-domain)
3. No query parameters (except "canonical-safe" list)
4. Consistent trailing slashes (choose: always trailing or never)
5. Lowercase protocol and domain (case-insensitive)
6. Path and hash components are case-sensitive
7. Works with both SSR and SPA routes
```

### Configuration Schema

```
OBJECT CanonicalURLConfig {
  baseURL: string                 // e.g., "https://example.com"
  trailingSlash: "always" | "never" | "auto"  // default: "never"

  // Query params that don't affect content and are safe to include
  canonicalSafeParams: Array<string>  // e.g., ["ref", "utm_source"]

  // Routes with custom canonical rules
  customCanonical: {
    "/blog": { trailingSlash: "never", stripParams: ["page"] }
    "/products/:id": { stripParams: ["variant"] }
  }
}
```

### Canonical URL Builder Function

```
FUNCTION generateCanonical(
  pathname: string,
  query: object,
  config: CanonicalURLConfig
): string {

  // 1. Start with base URL + pathname
  let url = config.baseURL + normalizePathname(pathname)

  // 2. Handle trailing slash
  let trailingSlashRule =
    config.customCanonical?.[pathname]?.trailingSlash ||
    config.trailingSlash ||
    "never"

  url = applyTrailingSlashRule(url, trailingSlashRule)

  // 3. Filter query parameters
  let safeParams = {}
  FOR EACH param IN Object.keys(query):
    IF param IN config.canonicalSafeParams OR
       param IN config.customCanonical?.[pathname]?.safeParams:
      safeParams[param] = query[param]
    END IF
  END FOR

  // 4. Append safe query params (sorted alphabetically for consistency)
  IF safeParams AND Object.keys(safeParams).length > 0:
    let sortedParams = Object.keys(safeParams).sort()
    let queryString = sortedParams
      .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(safeParams[key])}`)
      .join("&")
    url = url + "?" + queryString
  END IF

  // 5. Return URL
  RETURN url
}

FUNCTION normalizePathname(pathname: string): string {
  // Remove double slashes
  pathname = pathname.replace(/\/+/g, "/")
  // Ensure leading slash
  IF NOT pathname.startsWith("/"):
    pathname = "/" + pathname
  END IF
  RETURN pathname
}

FUNCTION applyTrailingSlashRule(url: string, rule: string): string {
  let hasTrailingSlash = url.endsWith("/") AND url.length > 1

  SWITCH rule:
    CASE "always":
      IF NOT hasTrailingSlash:
        url = url + "/"
      END IF
    CASE "never":
      IF hasTrailingSlash:
        url = url.substring(0, url.length - 1)
      END IF
    CASE "auto":
      // Keep as-is (not recommended for canonical; can cause duplicates)
  END SWITCH

  RETURN url
}
```

### Middleware: Enforce Canonical URL (Redirect)

```
MIDDLEWARE enforceCanonicalURL(request, response, config):

  // If request path doesn't match canonical, redirect
  canonical = generateCanonical(request.pathname, request.query, config)

  // Compare with current request URL
  currentURL =
    config.baseURL +
    request.pathname +
    (Object.keys(request.query).length > 0 ? "?" + queryString(request.query) : "")

  IF currentURL != canonical:
    // Redirect to canonical (301 Moved Permanently for SEO)
    response.redirect(301, canonical)
    RETURN response
  END IF

  // Store canonical URL in request context for SEOHead
  request.canonical = canonical
  RETURN response
```

### Integration with SEOHead

```
// In route handler / page component:
ROUTE /blog/:slug:
  article = fetchArticle(slug)
  canonical = generateCanonical(
    `/blog/${slug}`,
    request.query,
    config.canonicalURL
  )

  RENDER:
    <SEOHead
      canonical="{canonical}"
      title="{article.title}"
      // ... other props
    />
```

### Edge Cases

1. **Trailing Slash Conflict**: If config specifies `trailingSlash: "never"` but SEOHead receives a canonical with trailing slash, middleware enforces the rule. Always standardize in one place.

2. **Dynamic Route Parameters**: For dynamic routes (e.g., `/blog/:slug`), generate canonical from actual resolved slug, not the route pattern.

3. **Query String Pagination**: A common gotcha—many sites use `?page=2` for pagination. Strip this by default or add to safe list. Prefer slug-based pagination (`/blog/:page`) for better SEO.

4. **Subdomain Handling**: If app spans multiple subdomains (e.g., `app.example.com` and `docs.example.com`), configure canonical base URL per section. Never mix subdomains in a single config.

5. **HTTPS Enforcement**: Always use HTTPS in canonical URLs. If request comes via HTTP, canonical should still be HTTPS (enforce in middleware).

---

## 3. Sitemap Generator

An automatic route discovery and XML sitemap generation system. Can run at build time (for static sitemaps) or on-demand (for dynamic routes). Outputs a single sitemap or sitemap index (for 50k+ URLs).

### Route Classification

```
// Routes are classified for sitemap inclusion:
- SSR routes: Always included (crawlable, dynamic)
- SSG routes: Always included (pre-built, static)
- SPA routes: Excluded (not crawlable without JS execution)
- Dynamic routes: Included if slugs are fetchable from DB
- API routes: Excluded (non-HTML content)
- Auth-gated routes: Excluded if "noindex" robots rule applies
```

### Configuration Schema

```
OBJECT SitemapConfig {
  baseURL: string                 // "https://example.com"

  // Route inclusion rules (overrides route type)
  include: Array<{
    pattern: string               // glob or regex, e.g., "/blog/*", "/posts/:id"
    changefreq: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never"
    priority: number              // 0.0 to 1.0, default 0.5
  }>

  exclude: Array<{
    pattern: string               // exclude pattern, e.g., "/admin/*", "/api/*"
  }>

  // Dynamic route slugs (fetch from DB)
  dynamicRoutes: Array<{
    pattern: string               // e.g., "/blog/:slug"
    fetchSlugs: async function()  // returns Array<string>
    changefreq: string
    priority: number
  }>

  // Pagination settings (for large sitemaps)
  maxURLsPerSitemap: number       // default: 50000
  outputPath: string              // default: /sitemap.xml or /sitemaps/

  // Lastmod strategy
  lastmodSource: "build-time" | "file-mtime" | "fetch-from-config"
}
```

### Sitemap Generator Pseudocode

```
ASYNC FUNCTION generateSitemap(config):

  // 1. Discover routes
  let allRoutes = discoverAllRoutes()  // from route registry

  // 2. Filter routes based on rendering mode and rules
  let sitemapRoutes = []

  FOR EACH route IN allRoutes:
    // Exclude SPA routes (not crawlable)
    IF route.renderingMode == "SPA":
      CONTINUE
    END IF

    // Exclude API routes
    IF route.path.startsWith("/api"):
      CONTINUE
    END IF

    // Check exclude patterns
    IF matchesExcludePattern(route.path, config.exclude):
      CONTINUE
    END IF

    // Check include patterns (override defaults)
    let includeRule = findIncludeRule(route.path, config.include)
    IF includeRule:
      sitemapRoutes.push({
        path: route.path,
        changefreq: includeRule.changefreq,
        priority: includeRule.priority,
        lastmod: route.lastModified || buildTime
      })
    ELSE IF route.renderingMode IN ["SSR", "SSG"]:
      // Default: include SSR/SSG routes
      sitemapRoutes.push({
        path: route.path,
        changefreq: "weekly",
        priority: 0.5,
        lastmod: route.lastModified || buildTime
      })
    END IF
  END FOR

  // 3. Fetch dynamic route slugs
  FOR EACH dynamicRoute IN config.dynamicRoutes:
    let slugs = AWAIT dynamicRoute.fetchSlugs()
    FOR EACH slug IN slugs:
      let path = interpolatePattern(dynamicRoute.pattern, { slug: slug })
      sitemapRoutes.push({
        path: path,
        changefreq: dynamicRoute.changefreq,
        priority: dynamicRoute.priority,
        lastmod: NOW()
      })
    END FOR
  END FOR

  // 4. Handle pagination (if > maxURLsPerSitemap)
  IF sitemapRoutes.length > config.maxURLsPerSitemap:
    RETURN generateSitemapIndex(sitemapRoutes, config)
  ELSE:
    RETURN generateSingleSitemap(sitemapRoutes, config)
  END IF
```

### Single Sitemap XML Output

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/</loc>
    <lastmod>2025-03-26</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://example.com/blog</loc>
    <lastmod>2025-03-26</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>https://example.com/blog/post-1</loc>
    <lastmod>2025-03-20</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
  <!-- ... more URLs ... -->
</urlset>
```

### Sitemap Index (for 50k+ URLs)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/sitemaps/sitemap-1.xml</loc>
    <lastmod>2025-03-26</lastmod>
  </sitemap>
  <sitemap>
    <loc>https://example.com/sitemaps/sitemap-2.xml</loc>
    <lastmod>2025-03-26</lastmod>
  </sitemap>
  <!-- ... more sitemaps ... -->
</sitemapindex>
```

### Route Handler for Sitemap Serving

```
ROUTE /sitemap.xml:
  config = loadSitemapConfig()

  // Check if sitemap exists and is fresh
  let cachedSitemap = getFromCache('sitemap.xml')
  IF cachedSitemap AND cachedSitemap.expiresAt > NOW():
    RETURN cachedSitemap.content, { 'Content-Type': 'application/xml' }
  END IF

  // Generate sitemap
  sitemap = AWAIT generateSitemap(config)

  // Cache for 24 hours
  setCache('sitemap.xml', sitemap, ttl=86400)

  RETURN sitemap, {
    'Content-Type': 'application/xml',
    'Cache-Control': 'public, max-age=86400'
  }

ROUTE /sitemaps/:index.xml:
  // For sitemap index; serve individual chunks
  sitemapContent = AWAIT generateSitemapChunk(index, config)
  RETURN sitemapContent, { 'Content-Type': 'application/xml' }
```

### robots.txt Reference

Declare sitemap location in robots.txt:

```
Sitemap: https://example.com/sitemap.xml
```

Or for sitemap index:

```
Sitemap: https://example.com/sitemap-index.xml
```

### Edge Cases

1. **50k+ URLs**: Use sitemap index. Each chunk ≤ 50k URLs, each file ≤ 50MB. Google prefers multiple smaller sitemaps over one huge file.

2. **Dynamic Slugs Fetch Timeout**: If `fetchSlugs()` takes > 10 seconds, cache results and refresh asynchronously. Don't block sitemap generation.

3. **Excluded Routes**: If a route is excluded from sitemap but should be crawlable, add `nofollow` to robots.txt disallow rule instead (crawlers will find it via internal links).

4. **Lastmod Accuracy**: For SSG routes, use file modification time. For SSR routes with dynamic content, use current time. Don't guess.

5. **Test Coverage**: Submit sitemaps to Google Search Console. Use Google's Sitemap Tester to validate before deploy.

---

## 4. robots.txt Template

A configurable, environment-aware robots.txt served at `/robots.txt`. Per-environment rules (e.g., block all in staging, allow in production) and pattern-based disallow rules.

### Configuration Schema

```
OBJECT RobotsConfig {
  environment: "development" | "staging" | "production"

  // Per-environment rules
  rules: {
    production: {
      // Applies to all user-agents
      blockAll: false                     // if true, "Disallow: /"

      // User-agent-specific rules
      userAgents: Array<{
        name: string                      // "Googlebot", "Bingbot", "*" (all)
        disallowPatterns: Array<string>   // e.g., ["/admin/*", "/api/*"]
        allowPatterns?: Array<string>     // explicit allow (overrides disallow)
        crawlDelay?: number               // seconds between requests
        requestRate?: number              // requests per minute
      }>
    }
    staging: {
      blockAll: true
    }
    development: {
      blockAll: true
    }
  }

  // Global settings
  sitemapURL?: string                     // e.g., "https://example.com/sitemap.xml"
  cleanParam?: Array<string>              // e.g., ["utm_source", "utm_campaign"]
}
```

### robots.txt Generator

```
FUNCTION generateRobotsTxt(config):

  let env = config.environment || "production"
  let envRules = config.rules[env]

  IF NOT envRules:
    LOG_ERROR "No robots.txt rules for environment: {env}"
    envRules = config.rules.production || {}
  END IF

  let output = ""

  // Header comment
  output += "# robots.txt\n"
  output += "# Auto-generated for {env} environment\n"
  output += "# Generated: {now()}\n\n"

  // Block all (if applicable)
  IF envRules.blockAll:
    output += "User-agent: *\n"
    output += "Disallow: /\n\n"
  ELSE:
    // Per-user-agent rules
    FOR EACH agent IN envRules.userAgents:
      output += "User-agent: {agent.name}\n"

      // Disallow patterns
      FOR EACH pattern IN agent.disallowPatterns || []:
        output += "Disallow: {pattern}\n"
      END FOR

      // Allow patterns (overrides disallow)
      FOR EACH pattern IN agent.allowPatterns || []:
        output += "Allow: {pattern}\n"
      END FOR

      // Crawl delay
      IF agent.crawlDelay:
        output += "Crawl-delay: {agent.crawlDelay}\n"
      END IF

      // Request rate
      IF agent.requestRate:
        output += "Request-rate: {agent.requestRate}/1m\n"
      END IF

      output += "\n"
    END FOR
  END IF

  // Clean params (query string parameters crawlers should ignore)
  IF config.cleanParam AND config.cleanParam.length > 0:
    output += "Clean-param: "
    output += config.cleanParam.join(" ") + " /\n\n"
  END IF

  // Sitemap URL
  IF config.sitemapURL AND NOT envRules.blockAll:
    output += "Sitemap: {config.sitemapURL}\n"
  END IF

  RETURN output
```

### Route Handler

```
ROUTE /robots.txt:
  config = loadRobotsConfig()
  robotsTxt = generateRobotsTxt(config)

  RETURN robotsTxt, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'public, max-age=86400'
  }
```

### Example Output (Production)

```
# robots.txt
# Auto-generated for production environment
# Generated: 2025-03-26T10:30:00Z

User-agent: Googlebot
Disallow: /admin/
Disallow: /api/
Disallow: /auth/
Allow: /api/public/

User-agent: Bingbot
Disallow: /admin/
Disallow: /api/

User-agent: *
Disallow: /admin/
Disallow: /api/
Disallow: /auth/
Disallow: /internal/
Crawl-delay: 1

Clean-param: utm_source utm_campaign utm_medium /

Sitemap: https://example.com/sitemap.xml
```

### Example Output (Staging - Block All)

```
# robots.txt
# Auto-generated for staging environment
# Generated: 2025-03-26T10:30:00Z

User-agent: *
Disallow: /
```

### Edge Cases

1. **Conflicting Allow/Disallow**: If a URL matches both allow and disallow, most crawlers respect the most specific pattern. For clarity, list allow patterns after disallow.

2. **Sitemap in Blocked Environment**: Don't reference sitemap in staging/dev robots.txt (prevents accidental indexing). Only include in production.

3. **Legacy Parameter Cleanup**: Use `Clean-param` for UTM parameters, affiliate IDs, etc. Helps consolidate duplicate URLs with different tracking params.

4. **Crawl Delay**: Set conservatively (1-5 seconds) for public sites. Higher values slow crawl rate, impacting indexing speed.

5. **robots.txt Caching**: Cache robots.txt for 24 hours. Deploy changes should include robots.txt updates; don't rely on live reloads.

---

## 5. Changelog / What's New Page

A changelog page at `/changelog` that renders release notes from a data source (markdown files, config, or DB). Includes full-page SSR rendering, RSS feed at `/changelog/rss.xml`, and optional client-side "What's New" badge for authenticated users (tracks last-seen version per user).

### Data Model

```
OBJECT ChangelogEntry {
  id: string                      // unique identifier, e.g., "v1.2.3"
  version: string                 // semantic version: "1.2.3"
  date: ISO8601 string            // release date
  title: string                   // headline for release, e.g., "Bug Fixes & Performance"
  body: string                    // markdown content
  category: "feature" | "fix" | "improvement" | "breaking" | "security"
  isPrerelease: boolean           // alpha, beta, rc
  highlight: boolean              // optional flag to feature on top
}

OBJECT ChangelogConfig {
  // Data source: markdown files in directory
  source: "markdown" | "database" | "config"

  // If markdown:
  markdownDir: string             // e.g., "/content/changelog"
  filePattern: string             // e.g., "*.md" (one file per version)

  // If database:
  dbQuery: async function()       // returns Array<ChangelogEntry>

  // If config:
  entries: Array<ChangelogEntry>

  // Rendering
  baseURL: string                 // "https://example.com"
  itemsPerPage: number            // default: 10 (for paginated list)
}
```

### Markdown File Format

If using markdown source, each file represents one release:

```markdown
---
version: 1.2.3
date: 2025-03-20
title: Bug Fixes & Performance Improvements
category: improvement
highlight: false
---

# Version 1.2.3 – March 20, 2025

## Features
- Added dark mode toggle to account settings
- New API endpoint: `/api/user/export`

## Bug Fixes
- Fixed sidebar flickering on mobile
- Resolved memory leak in search component

## Performance
- Improved bundle size by 15%
- Reduced Time to Interactive by 200ms
```

### Changelog Page Component

```
COMPONENT ChangelogPage(props):
  entries = AWAIT loadChangelogEntries(config)

  // Render SSR
  RENDER:
    <RootLayout>
      <SEOHead
        title="Changelog | Product Name"
        description="Recent updates, new features, and improvements"
        canonical="https://example.com/changelog"
        type="website"
      />

      <main class="changelog">
        <header>
          <h1>Changelog</h1>
          <p>Latest updates and improvements to Product Name</p>
          <a href="/changelog/rss.xml" class="rss-link">Subscribe to RSS</a>
        </header>

        <div class="changelog-list">
          FOR EACH entry IN entries:
            <article class="changelog-entry" data-version="{entry.version}">
              <header>
                <h2>{entry.title}</h2>
                <span class="version">v{entry.version}</span>
                <span class="category">{entry.category}</span>
                <time datetime="{entry.date}">{formatDate(entry.date)}</time>
              </header>

              <div class="body">
                {renderMarkdown(entry.body)}  <!-- HTML from markdown parser -->
              </div>
            </article>
          END FOR
        </div>
      </main>
    </RootLayout>
```

### Changelog Data Loader

```
ASYNC FUNCTION loadChangelogEntries(config, page?):

  let entries = []

  IF config.source == "markdown":
    entries = AWAIT loadMarkdownChangelog(config.markdownDir, config.filePattern)
  ELSE IF config.source == "database":
    entries = AWAIT config.dbQuery()
  ELSE IF config.source == "config":
    entries = config.entries
  END IF

  // Sort by date descending (newest first)
  entries.sort((a, b) => parseDate(b.date) - parseDate(a.date))

  // Highlight featured entries at top
  let featured = entries.filter(e => e.highlight)
  let regular = entries.filter(e => !e.highlight)
  entries = [...featured, ...regular]

  RETURN entries
```

### RSS Feed Endpoint

```
ROUTE /changelog/rss.xml:
  entries = AWAIT loadChangelogEntries(config)

  rss = generateRSSFeed({
    title: "Product Name Changelog",
    link: "https://example.com/changelog",
    description: "Recent updates and improvements",
    items: entries.map(entry => ({
      title: `${entry.title} (v${entry.version})`,
      description: entry.body,
      pubDate: entry.date,
      link: `https://example.com/changelog#v${entry.version}`,
      guid: `https://example.com/changelog#v${entry.version}`,
      category: entry.category
    }))
  })

  RETURN rss, { 'Content-Type': 'application/xml' }
```

### RSS Generation Pseudocode

```
FUNCTION generateRSSFeed(config):
  output = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>{config.title}</title>
    <link>{config.link}</link>
    <description>{config.description}</description>
    <lastBuildDate>{now()}</lastBuildDate>
"""

  FOR EACH item IN config.items:
    output += """
    <item>
      <title>{escapeXML(item.title)}</title>
      <description>{escapeXML(item.description)}</description>
      <pubDate>{formatRFC822(item.pubDate)}</pubDate>
      <link>{item.link}</link>
      <guid>{item.guid}</guid>
      <category>{item.category}</category>
    </item>
"""
  END FOR

  output += """
  </channel>
</rss>
"""

  RETURN output
```

### What's New Badge (Client-Side, Auth-Required)

For authenticated users, display a badge indicating unread changelog entries. This requires:

1. **Server-side**: Track last-seen changelog version per user (in user profile or session)
2. **Client-side**: Compare user's last-seen version with latest changelog entry; show badge if unread

#### Data Model

```
OBJECT UserChangelogState {
  userId: string
  lastSeenVersion: string         // e.g., "1.2.3"
  lastSeenDate: ISO8601 string
}
```

#### Badge Component

```
COMPONENT WhatsNewBadge(user):
  // Only show for authenticated users
  IF NOT user?.authenticated:
    RETURN null
  END IF

  latestVersion = AWAIT fetchLatestChangelogVersion()
  userLastSeenVersion = user.lastSeenChangelogVersion || "0.0.0"

  hasUnread = compareVersions(latestVersion, userLastSeenVersion) > 0

  IF NOT hasUnread:
    RETURN null
  END IF

  RENDER:
    <a href="/changelog" class="whats-new-badge" aria-label="What's new">
      <span class="badge-dot"></span>
      <span>What's New</span>
    </a>
```

#### Marking as Viewed

```
ROUTE /changelog:
  user = getAuthenticatedUser()

  IF user:
    latestEntry = (AWAIT loadChangelogEntries())[0]

    // Update user's last-seen version
    AWAIT updateUserChangelogVersion(user.id, {
      lastSeenVersion: latestEntry.version,
      lastSeenDate: NOW()
    })
  END IF

  RENDER ChangelogPage
```

### Route Configuration

```
// In route config:
ROUTE /changelog:
  render: "ssr"                   // Server-render for SEO
  auth: "public"                  // Public page, but badge only for logged-in users
  cache: {
    browser: "no-cache"           // Changelog changes frequently
    cdn: 300                       // 5-minute CDN cache
  }

ROUTE /changelog/rss.xml:
  render: "ssr"
  auth: "public"
  cache: {
    browser: "no-cache"
    cdn: 300
  }
```

### Edge Cases

1. **No Changelog Entries**: If changelog is empty, show a placeholder: "No releases yet. Check back soon."

2. **Markdown Parsing Errors**: If a markdown file fails to parse, log error and skip that entry. Don't break the entire page.

3. **RSS Item Limit**: Cap RSS feed to last 50 entries (Google Reader convention). Older entries are archived but not syndicated.

4. **Date Formatting**: Use ISO 8601 for RFC 822 conversion (RSS spec). Ensure timezone is consistent (recommend UTC).

5. **XSS in Markdown**: Sanitize markdown output (see `seo-marketing-templates.md` for sanitization strategy). Allow only: `<p>`, `<h2>`, `<h3>`, `<ul>`, `<li>`, `<code>`, `<strong>`, `<em>`, `<a>`.

6. **What's New Badge Persistence**: Track last-seen version in user table or session store. If using session store, clear on logout. If using user profile, persist across sessions.

---

## Integration with Rendering-Routing Recipe

All five SEO features integrate with the rendering-routing strategy:

### Route Metadata Requirements

Every page using SEOHead should declare its rendering mode and auth requirement:

```
ROUTE /blog/:slug:
  render: "ssr"                   // Must be SSR or SSG for SEOHead to work
  auth: "public"
  cache: {
    browser: "no-cache"
    cdn: 60                        // Cache blog posts for 1 minute on CDN
  }
  seo: {
    title: "Blog Post"
    description: "Per-post overrides handled by component"
  }
```

### SSR Requirement for SEOHead

- SEOHead renders in document `<head>` on the server.
- For SPA routes, SEOHead will not inject meta tags into HTML sent to crawlers.
- If a page must have SEO meta tags, it must be SSR or SSG.
- Client-side meta tag injection (via `document.head.appendChild()`) is not crawlable.

### Canonical URL & Rendering Mode

Canonical URLs are enforced regardless of rendering mode:
- SSR pages: canonical middleware enforces URL normalization before rendering
- SSG pages: canonical is baked into pre-built HTML; redirect middleware handles mismatches
- SPA pages: canonical can't be crawled, so exclude from sitemap and robots.txt

---

## Build-Time vs Runtime Considerations

### Build-Time (Recommended)

**Sitemap generation**:
- Run at deploy time: discover all SSR/SSG routes, generate sitemap.xml
- Saves runtime overhead; sitemap is static
- Requires async slug fetching for dynamic routes (can be slow; cache results)

**robots.txt**:
- Generate at deploy time; output static file
- Environment-specific: staging robots.txt differs from production
- No dynamic generation needed

### Runtime (For Dynamic Content)

**Changelog page**:
- Render at request time (SSR) so latest entries are always visible
- Cache aggressively (5 minutes) to avoid DB queries on every request
- RSS feed: generate on-demand and cache

**SEOHead component**:
- Render on every page server-side (no persistent caching)
- Props vary per page; component is "stateless" composition wrapper

**Canonical URL**:
- Generate at request time; apply via middleware
- No caching (always fresh)

---

## Caching Strategy

| Feature | Cache Location | TTL | Strategy |
|---------|---|---|---|
| SEOHead | None (SSR-only) | N/A | Render per request |
| Canonical URL | None (middleware) | N/A | Enforce per request |
| Sitemap | CDN + Browser | 24h | Generate at deploy; revalidate on-demand for dynamic routes |
| robots.txt | CDN + Browser | 24h | Generate at deploy; no runtime changes |
| Changelog Page | CDN | 5m | Render on request; short CDN TTL |
| RSS Feed | CDN | 5m | Generate on request; short TTL |
| What's New Badge | Browser | N/A | Fetch latest version via API; no caching |

---

## Validation & Testing Checklist

- [ ] SEOHead renders meta tags in document head (server-render only)
- [ ] Canonical URLs are absolute, match base domain, and resolve correctly
- [ ] Sitemap includes all SSR/SSG routes; excludes SPA and API routes
- [ ] Sitemap index is generated for 50k+ URLs; each chunk ≤ 50k items
- [ ] robots.txt is environment-aware (blocks all in staging, allows in production)
- [ ] robots.txt references sitemap location
- [ ] Changelog page renders via SSR; visible to crawlers
- [ ] Changelog RSS feed is valid XML (test with validator)
- [ ] What's New badge only shows for authenticated users
- [ ] All pages with SEOHead include og:image, og:title, og:description
- [ ] Trailing slash consistency enforced across all routes
- [ ] JSON-LD structured data is valid and complete
- [ ] No duplicate canonical URLs (one per page)
- [ ] Sitemap tested in Google Search Console
- [ ] robots.txt tested with crawler simulator
- [ ] Changelog entries sanitized (no XSS risk)

---

## Summary Table: Five SEO Features

| Feature | Purpose | Render Mode | Cache | Output |
|---------|---------|---|---|---|
| **SEOHead Component** | Meta tags, OG, JSON-LD | SSR-only | None | `<head>` tags |
| **Canonical URLs** | Prevent duplicate content | All | None | HTTP header + `<link>` |
| **Sitemap Generator** | Route discovery for crawlers | Build-time | 24h | `/sitemap.xml` or `/sitemaps/` |
| **robots.txt** | Crawler access control | Build-time | 24h | `/robots.txt` |
| **Changelog Page** | Release notes, RSS, badge | SSR | 5m | `/changelog`, `/changelog/rss.xml` |

