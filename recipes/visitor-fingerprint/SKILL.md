---
name: visitor-fingerprint
description: >
  Use when adding visitor / device fingerprinting to a web app — anonymous
  visitor IDs for analytics, anti-fraud signals on auth/reviews, or
  cross-session correlation. Open-source FingerprintJS, client-only,
  no SSR required, no API keys.
provides: [fingerprint]
---

# Visitor Fingerprint

A pattern for assigning every browser a stable, anonymous visitor ID and using it as an anti-fraud / analytics signal across pageviews, auth, and user-generated content. Three properties are load-bearing:

1. **Client-only.** The fingerprint is computed in the browser. The server only ever receives the resulting string. Nothing here forces SSR, server components, middleware, or any framework-specific data-fetching hook. It works in a plain SPA the same as it works in Next.js or Expo Router.
2. **Cookie-cached for a year.** The library is loaded *once per year per browser*, not on every page. The first call computes the ID; every subsequent call reads it back from a cookie. This keeps the bundle off the critical path on every page.
3. **Lazy-imported, fail-soft.** The library is dynamically imported on first use, and the whole flow swallows errors and falls back to `null`. A broken fingerprint never blocks a pageview, login, or form submit.

Reference implementation: `filament.is/app/` — files cited inline below.

## Library Choice

Use the **open-source** `@fingerprintjs/fingerprintjs` (v5+), not the commercial Fingerprint Pro.

- No API key, no public key, no server-side secret, no env var
- npm install only — no script tag, no CDN account
- Stability is "good enough" for analytics and anti-fraud signals; not for hard identity claims

If you need cross-browser identity or device-graph features, that's where Fingerprint Pro starts to matter — but most projects don't, and the open-source version has no rate limits or billing surface.

```
"@fingerprintjs/fingerprintjs": "^5.1.0"
```

## Client Module

One small file owns the entire client side. Reference: `filament.is/app/lib/fingerprint.ts`.

```ts
const COOKIE_NAME         = 'fp_id'
const COOKIE_MAX_AGE_DAYS = 365

function getCookie(name: string): string | null {
  if (typeof document === 'undefined') return null
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'))
  return match ? decodeURIComponent(match[1]!) : null
}

function setCookie(name: string, value: string, days: number) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString()
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`
}

let _visitorId: string | null | undefined = undefined  // undefined = not yet loaded

export async function getVisitorId(): Promise<string | null> {
  if (_visitorId !== undefined) return _visitorId
  // Cookie first — skips library load entirely on repeat visits
  const cached = getCookie(COOKIE_NAME)
  if (cached) {
    _visitorId = cached
    return _visitorId
  }
  // First visit (or expired cookie): dynamically import and compute
  try {
    const FingerprintJS = await import('@fingerprintjs/fingerprintjs')
    const fp     = await FingerprintJS.load()
    const result = await fp.get()
    _visitorId = result.visitorId
    setCookie(COOKIE_NAME, _visitorId, COOKIE_MAX_AGE_DAYS)
  } catch {
    _visitorId = null
  }
  return _visitorId
}
```

Three caching layers, in order:

1. **Module-level singleton** (`_visitorId`) — same page session never re-checks anything. The `undefined` sentinel distinguishes "not yet asked" from "asked and got null".
2. **Cookie** — survives full page reloads and tab restarts. `SameSite=Lax`, `path=/`, 365 days. **Not HttpOnly** — must be readable from JavaScript so the client can short-circuit.
3. **Dynamic import** — `await import('@fingerprintjs/fingerprintjs')` only runs on the first uncached visit. The library never lands in your main bundle, and it's only fetched once per year per browser.

The `typeof document === 'undefined'` guard in `getCookie` is what makes this safe to *import* in an SSR build — even though the function only does meaningful work in the browser, the module can be loaded server-side without crashing. This is the SSR-compatibility hinge: the file is safe to import everywhere, but only does work in the browser.

## Where to Call It

Call `getVisitorId()` from a single mount-time effect at the top of your app, then send the result with whatever analytics/pageview ping you already have. Reference: `filament.is/app/app/_layout.tsx` (Expo Router; the same shape works in any React tree).

```tsx
function PageviewTracker() {
  const pathname = usePathname()
  useEffect(() => {
    if (typeof window === 'undefined') return       // SSR guard

    getVisitorId().then(fp_id => {
      fetch('/api/pageview', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          fp_id,
          request_uri: window.location.pathname + window.location.search,
          // ...whatever else your pageview ping carries
        }),
      }).catch(() => {})
    }).catch(() => {})
  }, [pathname])
  return null
}
```

Two important details:

- **`if (typeof window === 'undefined') return`** inside the effect. Effects don't run during SSR, but this is a belt-and-braces guard for static-render passes (e.g. Next.js `output: 'export'`, Expo Router static export) where some lifecycles trip during prerendering. Cheap insurance.
- **Effect depends on `pathname`** so the tracker re-fires on client-side navigation. Don't depend on `[]` — you'll only count the first page in an SPA.

The `.catch(() => {})` on the fetch is intentional: this is best-effort telemetry. It must never throw into a render path or block a navigation.

## Server Side

The server receives a plain JSON body. Treat `fp_id` as a tainted, optional string — never blindly trust it, never require it.

```ts
// /api/pageview
const { fp_id, request_uri, ... } = await request.json()
if (!request_uri) return Response.json({ ok: false }, { status: 400 })

const ip              = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
const user_agent      = request.headers.get('user-agent')      ?? null
const accept_language = request.headers.get('accept-language') ?? null

recordPageview({
  fp_id:           typeof fp_id === 'string' ? fp_id.slice(0, 64) : null,
  request_uri:     request_uri.slice(0, 2000),
  ip,
  user_agent,
  accept_language,
  // session_id / user_id, if you have an auth context
})

return Response.json({ ok: true })
```

Rules:

- **Cap the length.** Open-source FingerprintJS returns ~32 hex chars; cap at 64 to absorb future format changes without giving an attacker an unbounded write.
- **Always coerce to `string | null`.** A client can send `{ fp_id: { $ne: null } }` if you don't.
- **Never validate format past length.** Don't regex-check it. The library may change. The fingerprint is a low-trust identifier — your defense is at the read site (sparse indexes, anomaly detection), not at write time.
- **Pageview write is fire-and-forget.** Don't await the DB write inside the response handler. The client doesn't care.

## Data Model

The fingerprint shows up in three places, each playing a different role.

### Pageviews collection (analytics)

Time-partitioned by month so old data ages out cheaply. Reference: `filament.is/app/lib/pageview.ts`.

```ts
// pageviews_YYYY_MM
{
  fp_id:           string | null,
  session_id:      string | null,
  user_id:         string | null,
  request_uri:     string,
  ip:              string | null,
  user_agent:      string | null,
  accept_language: string | null,
  recorded_at:     Date,
}
```

Indexes:

```ts
{ fp_id:      1, recorded_at: -1 }
{ session_id: 1, recorded_at: -1 }   // sparse
{ user_id:    1, recorded_at: -1 }   // sparse
{ ip:         1, recorded_at: -1 }   // sparse
```

The `(fp_id, recorded_at desc)` index lets you reconstruct a visitor's timeline cheaply. The sparse indexes on `session_id`, `user_id`, `ip` keep the index small for the (large) majority of anonymous rows where those are null.

### Sessions collection (auth anti-fraud)

Capture `fp_id` at session creation and again at session activation (OTP verify). Stored on the session document, not as a separate join table.

```ts
{
  status:        'pending' | 'active',
  email:         string,
  // ...
  fp_id?:        string | null,    // visitor at request-OTP time
}
```

Use cases:
- Replay detection: same email + different fp_id in rapid succession → suspicious
- Cross-session correlation: same fp_id across multiple emails → likely the same human
- Click-fraud / bot signals: missing fp_id correlated with other red flags

### User-generated content (review/post anti-fraud)

Snapshot `fp_id` on every draft and submission of UGC (reviews, comments, ratings). Same idea — anonymous identifier you can use to detect sock-puppet farms after the fact.

```ts
{
  // ...review fields
  fp_id?: string | null,
}
```

How to read the visitor ID server-side without trusting the request body — pull it from the cookie the client already set:

```ts
function getVisitorIdFromRequest(request: Request): string | null {
  const cookie = request.headers.get('cookie') ?? ''
  const match  = cookie.match(/(?:^|; )fp_id=([^;]+)/)
  return match ? decodeURIComponent(match[1]).slice(0, 64) : null
}
```

For anti-fraud writes (auth, reviews) prefer this over the request body — it's harder to spoof without also spoofing every other cookie on the request.

## Fit-to-Project

Before implementing, check:
- **Bundler.** The dynamic import (`await import('@fingerprintjs/fingerprintjs')`) needs to produce a separate chunk. Vite, Next.js, Metro, Webpack all do this by default — but verify with a bundle analyzer that the library isn't accidentally getting hoisted into the main bundle by an eager import elsewhere.
- **Cookie reachability.** Set the cookie at `path=/` so every API endpoint sees it. If you're on multiple subdomains, set `domain=.example.com` and verify CORS/credentials handling.
- **CSP.** If you have a strict Content-Security-Policy, FingerprintJS uses canvas / WebGL / audio APIs but does not eval or load remote scripts when imported via npm. Usually no CSP changes needed; double-check `worker-src` if you see warnings.
- **SSR build mode.** This implementation does NOT require SSR. If your app is a pure SPA, the cookie/import guards still work. If your app *is* SSR, the `typeof window === 'undefined'` and `typeof document === 'undefined'` guards keep the module safe to import on the server. **Do not adopt SSR just to add fingerprinting.**
- **Where pageviews live.** Time-partitioned monthly collections are nice for hot-set retention but require an ensure-collection step on each write. If your analytics already lives in a single growing table or a managed analytics product, send the fingerprint there instead of inventing a parallel store.
- **Privacy / consent.** Fingerprinting is treated as tracking under GDPR and similar regimes. If you have a cookie banner, gate `getVisitorId()` behind consent for the relevant region — return `null` until consent is granted. Update your privacy policy.

## Anti-Patterns

- **Eager top-level import** — `import FingerprintJS from '@fingerprintjs/fingerprintjs'` at module top pulls the library into the main bundle and runs it on every page load. Always use `await import()` inside the function.
- **No cookie cache** — recomputing the fingerprint on every page navigation wastes CPU and (worse) makes the resulting ID more sensitive to environment drift. Cache for 365 days; let the library run at most once per year per browser.
- **HttpOnly fingerprint cookie** — defeats the entire short-circuit. The client *needs* to read the cookie to skip the library load. Use `SameSite=Lax`, not HttpOnly.
- **Awaiting fingerprint before render** — never block first paint on `getVisitorId()`. Fire it from an effect, treat the result as best-effort.
- **Throwing on fingerprint failure** — privacy extensions, brave shields, and weird browsers will return nothing or throw. Catch silently and fall through with `fp_id: null`. The pageview / login / review still has to work.
- **Trusting `fp_id` from the request body for security checks** — bodies are trivially spoofable. For auth/UGC anti-fraud, read the cookie server-side instead.
- **Validating the fingerprint format with a regex** — the library's output format is not a stable contract. Cap length, coerce type, store as opaque string. Any "this doesn't look like a fingerprint" check is a future bug.
- **Forcing the app to be SSR for this** — nothing here needs server rendering. If your app is a SPA, keep it a SPA. The pattern works identically in both modes.
- **Storing PII alongside the fingerprint** — the whole point is *anonymous* tracking. Don't denormalize email or name into the pageviews collection; join through `user_id` if you need to.
- **Logging child XHRs as separate page events** — a page load is ONE tracked event. The `fetch('/api/...')` calls that page fires afterward are *consequences* of it, not new user events. Logging them too makes every legitimate page load look like 2–N hits, which double-counts your analytics AND obliterates any bot / rate-limit signal layered on the same log (every normal visit then trips the gate a real burst would). Log the page event exactly once — at whatever owns it (the client pageview ping, or a page-scoped middleware that short-circuits `/api/*`) — and do NOT add per-request logging to API routes that are only ever called by your own frontend. The only API calls that log independently are those made **directly by a non-page client** — a mobile app or external integration with no page event behind it.
- **Using Fingerprint Pro by default** — the open-source library is free, key-less, and good enough for analytics and anti-fraud signals. Only reach for Pro when you've actually hit a limitation you can name.
- **Indexing fp_id non-sparsely on the user-bearing tables** — on the sessions/reviews collections, most rows have an `fp_id` but some don't. Sparse indexes keep the index size honest.
- **Ignoring privacy regulations** — fingerprinting *is* tracking. Gate behind consent in regulated regions and document it in your privacy policy.

## Logging

- Log at the server endpoint: `request_uri`, `fp_id` (or `null`), `session_id`, `user_id`, `ip` — one row per pageview is the log.
- **Count the page event once.** Never *also* log the API/XHR calls a page fires — they're consequences, not events. Only a direct non-page client (mobile / external integration) logs per-request. (See the "Logging child XHRs as separate page events" anti-pattern.)
- Don't log the fingerprint at INFO on the client — it's not interesting per-page and clutters dev consoles.
- Log fingerprint *failures* on the client at WARN (with the error, not the user agent) so you can spot a regression that suddenly drops your fingerprint coverage to 0%.
- Add a periodic metric: `% of pageviews with fp_id != null`. A sudden drop usually means a bundler change broke the dynamic import or a CSP change blocked a worker.
