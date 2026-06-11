---
name: Cache-Control Headers
description: Route-type-aware cache-control strategy for SSR, SSG, SPA, and API responses
type: project
---

# Cache-Control Headers

A stack-agnostic recipe for implementing intelligent cache-control headers across different rendering modes and route types. The strategy ties caching behavior directly to the rendering configuration, eliminating per-route manual header management.

## Core Principle

Cache policy is derived from the **rendering mode** defined in `rendering-routing.md` route config. Middleware applies appropriate `Cache-Control` headers automatically based on route type (SSG, SSR, SPA, API). Developers do not manually set cache headers per route; instead, they declare the rendering mode and optionally override the default cache policy.

---

## Cache Policy Defaults by Route Type

| Route Type | Rendering Mode | Default Cache-Control | Use Case |
|---|---|---|---|
| **Static Pages** | SSG | `public, max-age=3600, s-maxage=86400, stale-while-revalidate=3600` | Pre-built pages, infrequent updates |
| **Dynamic Pages** | SSR | `public, s-maxage=60, stale-while-revalidate=300` | Server-rendered on request, ISR pattern |
| **Client App Pages** | SPA | `no-cache, no-store, must-revalidate` | Dynamic client-side routing, auth-dependent |
| **Public API** | API (public) | `public, s-maxage=300` | Cacheable data endpoints (e.g., `/api/plans`) |
| **Private API** | API (private) | `private, no-cache, no-store` | User-specific or sensitive endpoints |
| **Auth-Gated Pages** | Any | `private, no-store` | Pages requiring authentication, never CDN-cached |
| **Static Assets** | N/A (hashed) | `public, max-age=31536000, immutable` | JS, CSS, images with content hash |

---

## Middleware Implementation

The middleware reads route metadata from the route config and applies the appropriate header before the response is sent.

### Pseudocode: Cache-Control Header Middleware

```pseudocode
middleware cachControlMiddleware(request, response, routeConfig):

  // Extract route metadata
  routeConfig = lookupRouteConfig(request.path)
  renderingMode = routeConfig.renderingMode
  isAuthGated = routeConfig.requiresAuth or routeConfig.authRoles?.length > 0
  isStaticAsset = routeConfig.isStaticAsset or detectContentHash(request.path)
  cachePolicyOverride = routeConfig.cachePolicy  // optional custom policy

  // Determine cache policy
  if (cachePolicyOverride):
    cachePolicy = cachePolicyOverride
  else if (isAuthGated):
    cachePolicy = "private, no-store"
  else if (isStaticAsset):
    cachePolicy = "public, max-age=31536000, immutable"
  else if (renderingMode == "SSG"):
    cachePolicy = "public, max-age=3600, s-maxage=86400, stale-while-revalidate=3600"
  else if (renderingMode == "SSR"):
    cachePolicy = "public, s-maxage=60, stale-while-revalidate=300"
  else if (renderingMode == "SPA"):
    cachePolicy = "no-cache, no-store, must-revalidate"
  else if (renderingMode == "API"):
    if (routeConfig.isPublic):
      cachePolicy = "public, s-maxage=300"
    else:
      cachePolicy = "private, no-cache, no-store"
  else:
    cachePolicy = "no-cache"  // safe default

  // Set headers
  response.setHeader("Cache-Control", cachePolicy)

  // Set ETag if not already present
  if (!response.hasHeader("ETag")):
    etag = computeETag(response.body)
    response.setHeader("ETag", etag)

  // Vary header for content negotiation
  if (isAuthGated or renderingMode == "SPA"):
    response.setHeader("Vary", "Cookie, Authorization")
  else if (supportsContentNegotiation(routeConfig)):
    response.setHeader("Vary", "Accept-Encoding, Accept-Language")

  return response
```

---

## Cache Tiers

Responses can be cached at multiple levels. Each route type defaults to a specific tier strategy.

### Tier 1: CDN (Edge)
- Controlled by `s-maxage` and `public` directives
- Shared across users; must never contain sensitive data
- Respects `Vary` headers for cache key differentiation
- Best for: SSG, public API endpoints

### Tier 2: Browser
- Controlled by `max-age` directive
- Private to the user; safe for auth tokens in cookies
- Reduces server hits from repeat visits
- Best for: SSR, SPA static assets

### Tier 3: None
- `no-cache` or `no-store` prevents caching
- Every request reaches origin or validates freshness
- Best for: Auth-gated pages, private APIs, real-time data

---

## CDN Considerations

### Cache Key Composition

CDN cache keys include:
- Request URL (path + query string)
- `Vary` header values (cookies, accept-encoding, etc.)
- Custom cache key rules (if configured)

**Critical:** When `Vary: Cookie` is set, CDN treats different auth states as separate cache entries. This prevents logged-in content from being served to logged-out users (see [Auth Interaction](#auth-interaction)).

### Vary Headers

Use `Vary` to signal what query parameters or headers affect the response:

```pseudocode
// Only cache by Accept-Encoding (gzip, brotli)
response.setHeader("Vary", "Accept-Encoding")

// Auth-sensitive: vary by Cookie and Authorization header
response.setHeader("Vary", "Cookie, Authorization, Accept-Language")

// Avoid over-varying; each value increases cache misses
```

### Cache Purging Strategy

When content is updated (e.g., after a deploy or content edit), purge affected cache entries:

```pseudocode
purgeCache(pattern):
  // Purge by URL
  cdn.purge("/blog/post-123", method="exact")

  // Purge by tag (requires tagging at response time)
  cdn.purge("tag:blog-post", method="by-tag")

  // Purge all (use sparingly, expensive)
  cdn.purgeAll()
```

Example: After publishing a blog post, tag the response:

```pseudocode
routeConfig for /blog/:slug:
  renderingMode = "SSR"
  cachePolicy = "public, s-maxage=3600"
  cacheTags = ["blog", "blog:" + post.id]

  // On publish, purge the tag
  cdn.purge("tag:blog:" + post.id)
```

---

## Static Asset Caching

Static assets (JS, CSS, images) with content-based hashing should always be cached aggressively.

### Hashed Filename Pattern

Filenames include a content hash:
```
app.a1b2c3d4.js
styles.e5f6g7h8.css
logo.i9j0k1l2.png
```

When content changes, the hash changes, creating a new filename. Old versions remain cached indefinitely.

### Implementation

```pseudocode
middleware cacheStaticAssets(request, response):

  // Detect hashed assets (e.g., *.a1b2c3d4.js)
  if (request.path matches /\.[a-f0-9]{8}\.(js|css|png|jpg|woff2|svg)$/):
    response.setHeader("Cache-Control", "public, max-age=31536000, immutable")
    response.setHeader("ETag", generateETag(fileContent))
    // Optional: set far-future expires
    response.setHeader("Expires", dateInYear(2037))

  return response
```

**Immutable Directive:** Tells caches (browser, CDN) that this asset will never change. The browser skips revalidation even if `max-age` expires.

---

## API Response Caching

### Public Endpoints

Endpoints serving non-sensitive, non-personalized data can be cached:

```pseudocode
routeConfig for /api/plans:
  renderingMode = "API"
  isPublic = true
  cachePolicy = "public, s-maxage=300, max-age=60"

// Cached at CDN for 5 min, browser for 1 min
// Safe because /api/plans is identical for all users
```

### Private Endpoints

Endpoints returning user-specific or sensitive data must never be CDN-cached:

```pseudocode
routeConfig for /api/user/profile:
  renderingMode = "API"
  isPublic = false
  cachePolicy = "private, no-cache, no-store"

// No CDN cache; browser can cache temporarily with revalidation
// If user auth changes, browser revalidates on next request
```

### Cache Busting API Data

Explicitly revalidate API responses when data changes:

```pseudocode
onDataUpdate(resource):
  // Option 1: Purge from CDN
  cdn.purge("/api/plans", method="exact")

  // Option 2: Use ETags for conditional requests
  // Client sends If-None-Match with last ETag
  // Server responds with 304 Not Modified if unchanged
```

---

## Auth Interaction

### Why Auth-Gated Pages Must Never Be CDN-Cached

If a page is gated by authentication, it must never be cached at CDN level with a public cache key. Reason: a logged-out user could receive a logged-in user's cached HTML or API response.

### Implementation: Private, No-Store

```pseudocode
routeConfig for /dashboard (requires auth):
  requiresAuth = true
  cachePolicy = "private, no-store"

// "private" = only browser can cache, not CDN
// "no-store" = browser shouldn't cache either (safest)
```

### Cache Keys and Auth State

CDN cache keys must include auth tokens to prevent collisions:

```pseudocode
// DO: Vary by Cookie and Authorization to separate auth states
response.setHeader("Vary", "Cookie, Authorization")
response.setHeader("Cache-Control", "public, s-maxage=300")

// This creates separate cache entries:
// - /api/user/info (with auth cookie A)
// - /api/user/info (with auth cookie B)
// - /api/user/info (no cookie, anon)

// CDN never mixes these up
```

### Set-Cookie + Cache-Control Conflicts

When a response sets a cookie AND has a `Cache-Control` header, CDN behavior varies:

**Danger Zone:** Setting a cookie and `Cache-Control: public, s-maxage=3600` on the same response means:
- The cookie travels to the user
- The HTML/JSON is cached at CDN
- Next user gets the cached response WITHOUT the cookie

**Solution:**
1. If setting auth cookies, use `Cache-Control: private` or `no-store`
2. Never mix `Set-Cookie` with `public, s-maxage` directives

```pseudocode
// After login, set auth cookie
if (login success):
  response.setHeader("Set-Cookie", "authToken=...; HttpOnly; Secure; SameSite=Lax")
  response.setHeader("Cache-Control", "private, no-store")  // NOT public
```

---

## Override Mechanism

Developers can override default cache policies on a per-route basis without changing the middleware:

### Route Config Override

```pseudocode
routeConfig for /blog/:slug:
  renderingMode = "SSR"              // Default: ISR caching
  cachePolicy = "public, max-age=60, s-maxage=1800"  // Override: longer CDN TTL

// Middleware detects the override and uses it instead of the SSR default
```

### Conditional Overrides

```pseudocode
routeConfig for /api/stock-price:
  renderingMode = "API"
  isPublic = true
  cachePolicy = getPolicy(request):
    if (request.query.symbol == "TSLA"):
      return "public, s-maxage=5"      // Hot stock, shorter TTL
    else:
      return "public, s-maxage=300"    // Cold stock, longer TTL

// Middleware evaluates the function at request time
```

---

## ETag Support

ETags enable conditional requests, reducing bandwidth for unchanged content.

### Generating ETags

```pseudocode
computeETag(content):
  // Option 1: hash-based (strong ETag)
  hash = sha256(content)
  return '"' + hash.substring(0, 16) + '"'

  // Option 2: version-based (weak ETag)
  lastModified = getLastModified(content)
  return 'W/"' + lastModified + '"'

  // Option 3: content-length + timestamp (fast but weaker)
  return '"' + content.length + "-" + lastModified + '"'
```

### Conditional Request Handling

```pseudocode
middleware handleConditionalRequest(request, response, content):

  currentETag = computeETag(content)
  clientETag = request.headers["If-None-Match"]

  if (clientETag == currentETag):
    // Content unchanged; avoid re-sending body
    response.statusCode = 304  // Not Modified
    response.setHeader("ETag", currentETag)
    response.setHeader("Cache-Control", "public, max-age=3600")
    return response  // No body

  // Content changed; send full response
  response.statusCode = 200
  response.setHeader("ETag", currentETag)
  response.body = content
  return response
```

### Browser and CDN Behavior

- Browser caches the response with the ETag
- On next request, browser sends `If-None-Match: {ETag}`
- If unchanged, server responds 304 → browser uses cached version
- If changed, server responds 200 → browser updates cache

---

## Gotchas and Pitfalls

### 1. Logged-In vs Logged-Out Content at Same URL

**Problem:** A page shows different content based on auth state. If CDN caches the logged-in version, logged-out users see it.

**Solution:**
```pseudocode
// Option A: Use Vary: Cookie, Authorization (separates cache entries)
response.setHeader("Vary", "Cookie, Authorization")

// Option B: Don't cache auth-dependent content at CDN
response.setHeader("Cache-Control", "private, no-store")

// Option C: Render static shell, fetch user data via API
// HTML is cached; user data is private and un-cached
```

### 2. Set-Cookie + Cache-Control Conflicts

**Problem:** Setting a cookie on a cacheable response leaks it to other users or loses it entirely depending on CDN.

**Solution:**
- Never combine `Set-Cookie` with `public, s-maxage`
- Always use `private, no-store` with Set-Cookie
- Use separate endpoints: one for auth (sets cookie, no-cache), one for data (cached, no cookie)

### 3. CDN Ignoring Headers

**Problem:** Some CDNs ignore `Cache-Control` headers and cache based on status code or file extension alone.

**Solution:**
- Verify CDN configuration (caching rules, bypassCache rules)
- Use explicit CDN cache directives (e.g., Cloudflare's `Cache-Everything`)
- Set `Cache-Control` AND configure CDN rules to honor it

### 4. stale-while-revalidate Browser Support

**Problem:** `stale-while-revalidate` is not supported in older browsers (IE, early Chrome/Firefox).

**Solution:**
```pseudocode
// Browsers that don't support SWR ignore the directive; they use max-age
// Safe to include; no harm if ignored

// For SSR with ISR:
"public, s-maxage=60, stale-while-revalidate=300"

// Supported browser: CDN serves stale if beyond max-age but within SWR
// Unsupported browser: Uses max-age only, makes fresh request after 60s
```

### 5. Over-Varying Cache Keys

**Problem:** Setting `Vary: Accept-Language, Accept-Encoding, User-Agent, Custom-Header` creates too many cache entries, reducing hit rates.

**Solution:**
- Only vary on headers that actually affect the response
- Use `Vary: Accept-Encoding` for compression (almost always needed)
- Use `Vary: Accept-Language` only if you serve multiple languages
- Avoid varying on User-Agent unless necessary

### 6. Query String Cache Busting Conflicts

**Problem:** Using query strings as cache busters (`?v=123`) bypasses CDN cache if not configured.

**Solution:**
```pseudocode
// DO: Hash-based filenames (immutable strategy)
// Files: app.a1b2c3d4.js, app.e5f6g7h8.js
// Content changes → new filename → new request, old cached forever

// DON'T: Query string versioning
// Files: app.js?v=1, app.js?v=2
// Each version is a separate cache key; original app.js is still served if no query string
```

### 7. Stale-While-Revalidate Resource Leaks

**Problem:** Using SWR with `max-age=60, stale-while-revalidate=3600` means browser serves stale data for 1 hour while revalidating silently. Users don't know the data is stale.

**Solution:**
- Document SWR TTLs in team guidelines
- Add metadata (e.g., `X-Cache-Age: stale`) to revalidation responses
- For real-time data, use shorter SWR windows or WebSocket updates
- Consider adding UI indicator ("showing cached data from 5 min ago")

---

## Summary Table

| Aspect | SSG | SSR | SPA | Public API | Private API | Auth-Gated |
|---|---|---|---|---|---|---|
| Cache-Control | `public, max-age=3600, s-maxage=86400, stale-while-revalidate=3600` | `public, s-maxage=60, stale-while-revalidate=300` | `no-cache, no-store, must-revalidate` | `public, s-maxage=300` | `private, no-cache, no-store` | `private, no-store` |
| CDN Cache? | Yes | Yes (ISR) | No | Yes | No | No |
| Browser Cache? | Yes | Yes | No | Yes | Yes (with revalidation) | No |
| ETag? | Optional | Yes | Yes | Yes | Yes | Yes |
| Vary Header? | Accept-Encoding | Cookie, Authorization, Accept-Language | Cookie, Authorization | Accept-Encoding | Cookie, Authorization | Cookie, Authorization |

---

## Implementation Checklist

- [ ] Define route rendering modes in `rendering-routing.md`
- [ ] Implement cache-control middleware
- [ ] Add ETag generation to response pipeline
- [ ] Configure CDN cache rules (honor Cache-Control, purge strategy)
- [ ] Set Vary headers for auth-sensitive routes
- [ ] Test logged-in vs logged-out cache isolation
- [ ] Verify static assets have content hashes
- [ ] Document cache overrides for developers
- [ ] Monitor cache hit rates (CDN and browser metrics)
- [ ] Set up cache purge triggers (deploys, content updates)
