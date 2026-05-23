---
name: Analytics Enhancements
description: Four modular analytics enhancements (server-side page views, client-side event tracking, conversion funnels, UTM attribution) built on the base analytics.md multi-context system
type: enhancement
requires: recipes/analytics.md, recipes/rendering-routing.md, recipes/cookie-consent.md
env_vars: ANALYTICS_FUNNEL_CONFIG, ANALYTICS_ATTRIBUTION_MODE
---

# Analytics Enhancements

Four stack-agnostic enhancements built on top of the base `analytics.md` multi-context system. These recipes add:

1. **Server-Side Page Views for SSR Routes** — Track SSR-rendered pages server-side to avoid double-counting
2. **Client-Side Event Tracking for SPA Routes** — Automatic page view tracking and manual event tracking for client-side routes
3. **Conversion Funnel Helpers** — Named funnel definitions with step tracking and drop-off detection
4. **UTM Parameter Capture and Persistence** — Capture and persist UTM parameters across session, attach to events and user records

All features integrate with the existing multi-context analytics system and respect consent settings from `cookie-consent.md`.

---

## 1. Server-Side Page Views for SSR Routes

**Purpose**: Track page views for server-side rendered (SSR) routes without relying on client-side JavaScript, avoiding double-counting with SPA tracking.

### Overview

When a route is rendered on the server (per `rendering-routing.md` config with `render: "ssr"`), emit a `page_view` event via the analytics context. This happens in the server request handler before sending the response to the client.

**Benefits**:
- No client-side JS needed for SSR pages
- Captures all SSR routes (including crawlers and users with JS disabled)
- Avoids double-counting: SPA tracking handles client-side navigation
- Includes server-side context: user agent, referrer, server-side user ID

### Data Captured

Each server-side page view event includes:

```pseudocode
{
  event: "page_view",
  properties: {
    // Page identifiers
    path: string,                      // e.g., "/pricing"
    pathname: string,                  // URL pathname only
    search: string,                    // Query string (if present)

    // Context
    referrer: string | null,           // HTTP Referer header
    user_agent: string,                // Full user agent string

    // User identification
    user_id: string | null,            // If authenticated (from server context)
    session_id: string,                // Server-side session ID

    // Source detection
    is_bot: boolean,                   // Bot detection (see below)
    utm_source: string | null,         // From URL or session storage
    utm_medium: string | null,
    utm_campaign: string | null,
    utm_term: string | null,
    utm_content: string | null,

    // Page metadata
    title: string | null,              // Page title from route config
    render_mode: "ssr",                // Always "ssr" for this type

    // Timing
    server_render_time_ms: number,     // How long render took
    timestamp: datetime                // Server time
  }
}
```

### API / Middleware Spec

#### SSR Request Handler

```pseudocode
// In server request handler (before rendering page)
async function handleSSRRequest(request, response, routeConfig) {
  // 1. Resolve current context (landing, app, etc.)
  let context = resolveContext(routeConfig)

  // 2. Get analytics instance for this context
  let analytics = getAnalytics(context)

  // 3. Check consent before emitting event
  let consentStatus = getConsentCookie(request, response)
  if (!shouldTrackAnalytics(consentStatus)) {
    // User has not consented to analytics; skip tracking
    return renderPage(routeConfig, request)
  }

  // 4. Identify user if authenticated
  let user = request.context.user  // From auth middleware
  if (user?.id) {
    analytics.identify(user.id, {
      email: user.email,
      // ... other traits
    })
  }

  // 5. Check for bot user agent (skip tracking bots)
  let isBot = detectBot(request.headers.get("user-agent"))
  if (isBot) {
    // Emit bot event for tracking separately
    analytics.track("bot_request", {
      user_agent: request.headers.get("user-agent"),
      path: request.url.pathname
    })
    return renderPage(routeConfig, request)
  }

  // 6. Measure render time
  let startTime = now()

  // 7. Render page content
  let html = await renderPage(routeConfig, request)

  let renderTimeMs = now() - startTime

  // 8. Extract referrer from HTTP header
  let referrer = request.headers.get("referer") || null

  // 9. Get session ID (for grouping events)
  let sessionId = getOrCreateSessionId(request, response)

  // 10. Extract UTM params from URL or session (see section 4)
  let utmParams = getUTMParams(request)

  // 11. Emit page_view event
  analytics.track("page_view", {
    path: request.url.pathname,
    pathname: request.url.pathname,
    search: request.url.search || null,
    referrer: referrer,
    user_agent: request.headers.get("user-agent"),
    user_id: user?.id || null,
    session_id: sessionId,
    is_bot: false,
    utm_source: utmParams?.utm_source || null,
    utm_medium: utmParams?.utm_medium || null,
    utm_campaign: utmParams?.utm_campaign || null,
    utm_term: utmParams?.utm_term || null,
    utm_content: utmParams?.utm_content || null,
    title: routeConfig.seo?.title || null,
    render_mode: "ssr",
    server_render_time_ms: renderTimeMs,
    timestamp: now()
  })

  // 12. Send response
  response.setHeader("Content-Type", "text/html")
  return response.send(html)
}
```

#### Bot Detection

```pseudocode
function detectBot(userAgent: string): boolean {
  // List of common bot signatures
  let botPatterns = [
    /googlebot/i,
    /bingbot/i,
    /slurp/i,
    /duckduckbot/i,
    /baiduspider/i,
    /yandexbot/i,
    /facebookexternalhit/i,
    /twitterbot/i,
    /linkedinbot/i,
    /whatsapp/i,
    /telegrambot/i,
    /slotovod/i,
    /curl/i,
    /wget/i,
    /go-http-client/i
  ]

  for pattern in botPatterns:
    if pattern.test(userAgent):
      return true

  return false
}
```

#### Session ID Management

```pseudocode
function getOrCreateSessionId(request, response): string {
  // Check for existing session cookie
  let sessionId = request.cookies.get("_session_id")

  if (!sessionId) {
    // Create new session ID for this visitor
    sessionId = generateUUID()

    // Set cookie: expires when browser closes or after 24 hours
    response.cookies.set("_session_id", sessionId, {
      maxAge: 86400,  // 24 hours
      httpOnly: true,
      secure: true,
      sameSite: "Lax"
    })
  }

  return sessionId
}
```

### Integration with Rendering-Routing Recipe

The `render` field in route config determines whether SSR page view tracking is used:

```pseudocode
// In renderPage() or equivalent:
if (routeConfig.render === "ssr") {
  // Emit page_view server-side
  await handleSSRPageView(request, response, routeConfig)
}
else if (routeConfig.render === "ssg") {
  // SSG: emit page_view on first request only
  // Cache: subsequent requests skip tracking
}
else if (routeConfig.render === "spa") {
  // SPA: skip server-side tracking
  // Client will handle page_view via client-side router
}
```

### Consent Integration

```pseudocode
function shouldTrackAnalytics(consentStatus): boolean {
  if (!consentStatus) {
    // No consent cookie; user hasn't made a choice yet
    // Conservative: don't track
    return false
  }

  let consent = parseJSON(consentStatus)

  // Check if analytics consent is given
  return consent.analytics === true
}
```

---

## 2. Client-Side Event Tracking for SPA Routes

**Purpose**: Automatic page view tracking on client-side route changes, plus manual event tracking helpers for tracking user interactions.

### Overview

For SPA routes (per `rendering-routing.md` config with `render: "spa"`), hook into the router's navigation events to emit `page_view` on every route change. Additionally, provide helpers for:
- Manual event tracking with `track(eventName, properties)`
- Automatic event tracking for common interactions (button clicks, form submissions, scroll depth)
- Time-on-page measurement

### Router Integration

#### Navigation Hook

```pseudocode
// In router initialization (framework-agnostic)
function setupAnalyticsHooks(router) {
  let previousPath = null
  let pageEnterTime = now()

  // Hook: before navigation
  router.onBeforeNavigate((newPath) => {
    // Calculate time spent on previous page
    let timeOnPage = now() - pageEnterTime

    // Store for page_view event
    router.analytics = {
      previousPath: previousPath,
      timeOnPreviousPage: timeOnPage
    }
  })

  // Hook: after navigation
  router.onAfterNavigate((newPath) => {
    // Reset timer for new page
    pageEnterTime = now()
    previousPath = newPath

    // Emit page_view event
    emitPageView(newPath, router.analytics)
  })

  // Hook: on route change error
  router.onNavigateError((error) => {
    // Track navigation errors separately
    let analytics = getAnalytics()
    analytics.track("page_view_error", {
      target_path: error.path,
      error_message: error.message
    })
  })
}

function emitPageView(path, context) {
  let analytics = getAnalytics("app")

  // Check consent before emitting
  let consentStatus = getCookie("consentStatus")
  if (!shouldTrackAnalytics(consentStatus)) {
    return
  }

  // Get current user (if authenticated)
  let user = getCurrentUser()
  if (user?.id) {
    analytics.identify(user.id, {
      email: user.email,
      // ... other traits
    })
  }

  // Emit event
  analytics.track("page_view", {
    path: path,
    pathname: window.location.pathname,
    search: window.location.search || null,
    referrer: document.referrer || null,
    previous_path: context.previousPath,
    time_on_previous_page_ms: context.timeOnPreviousPage,
    user_agent: navigator.userAgent,
    user_id: user?.id || null,
    session_id: getSessionId(),
    render_mode: "spa",
    timestamp: now()
  })
}
```

### Manual Event Tracking API

```pseudocode
// Exported helper for manual tracking in components
function track(eventName: string, properties?: object) {
  let analytics = getAnalytics("app")

  // Check consent
  let consentStatus = getCookie("consentStatus")
  if (!shouldTrackAnalytics(consentStatus)) {
    return
  }

  // Get user context
  let user = getCurrentUser()

  // Emit event with auto-attached context
  analytics.track(eventName, {
    // User-provided properties
    ...properties,

    // Auto-attached context
    page_path: window.location.pathname,
    user_id: user?.id || null,
    session_id: getSessionId(),
    timestamp: now()
  })
}

// Usage in components:
function PricingTable({ plans }) {
  return (
    <div>
      {plans.map(plan => (
        <button key={plan.id} onClick={() => {
          track("pricing_plan_selected", { plan_id: plan.id })
          // ... handle selection
        }}>
          Select {plan.name}
        </button>
      ))}
    </div>
  )
}
```

### Automatic Event Tracking

#### Button Click Tracking (via data attribute)

```pseudocode
// In app initialization
function setupAutoTracking() {
  // Track clicks on elements with data-track attribute
  document.addEventListener("click", (event) => {
    let target = event.target
    let trackAttr = target.closest("[data-track]")

    if (!trackAttr) {
      return
    }

    let eventName = trackAttr.getAttribute("data-track")
    let properties = parseDataAttributes(trackAttr, "track-")

    track(eventName, properties)
  }, true)
}

function parseDataAttributes(element, prefix): object {
  let props = {}

  for each attr in element.attributes:
    if attr.name.startsWith(`data-${prefix}`):
      let key = attr.name.slice(prefix.length + 6)  // Remove "data-track-"
      props[key] = attr.value

  return props
}

// HTML usage:
// <button data-track="export_clicked" data-track-format="csv">
//   Export as CSV
// </button>
```

#### Form Submission Tracking

```pseudocode
function setupFormTracking() {
  document.addEventListener("submit", (event) => {
    let form = event.target

    // Skip if form has data-no-track
    if (form.hasAttribute("data-no-track")) {
      return
    }

    // Get form name or ID for event name
    let formName = form.getAttribute("name") || form.getAttribute("id") || "form"
    let eventName = `${formName}_submitted`

    // Track fields (only if explicitly marked)
    let properties = {}
    for each input in form.querySelectorAll("[data-track-value]"):
      let fieldName = input.getAttribute("data-track-value")
      let value = input.value

      // Sanitize: don't track sensitive fields
      if (!isSensitiveField(fieldName)):
        properties[fieldName] = value

    track(eventName, properties)
  }, true)
}

function isSensitiveField(fieldName): boolean {
  let sensitivePatterns = [
    /password/i,
    /credit.?card/i,
    /cvv/i,
    /ssn/i,
    /secret/i,
    /token/i,
    /api.?key/i
  ]

  for pattern in sensitivePatterns:
    if pattern.test(fieldName):
      return true

  return false
}

// HTML usage:
// <form name="contact">
//   <input name="email" type="email" data-track-value="email" />
//   <input name="message" data-track-value="message" />
//   <button type="submit">Send</button>
// </form>
```

#### Scroll Depth Tracking

```pseudocode
function setupScrollTracking() {
  let scrollDepths = [25, 50, 75, 100]
  let trackedDepths = new Set()

  window.addEventListener("scroll", () => {
    let scrollPercent = (window.scrollY + window.innerHeight) / document.documentElement.scrollHeight * 100

    for depth in scrollDepths:
      if (scrollPercent >= depth && !trackedDepths.has(depth)):
        trackedDepths.add(depth)

        track("scroll_depth", {
          depth_percent: depth,
          page_path: window.location.pathname
        })
  })

  // Reset tracked depths on page change
  router.onAfterNavigate(() => {
    trackedDepths.clear()
  })
}
```

#### Time-on-Page Tracking

```pseudocode
function setupTimeOnPageTracking() {
  let pageEnterTime = now()
  let trackingIntervals = [10, 30, 60, 120, 300]  // seconds
  let trackedIntervals = new Set()

  // Track periodically
  let timer = setInterval(() => {
    let timeOnPage = now() - pageEnterTime

    for interval in trackingIntervals:
      if (timeOnPage >= interval * 1000 && !trackedIntervals.has(interval)):
        trackedIntervals.add(interval)

        track("time_on_page", {
          seconds: interval,
          page_path: window.location.pathname
        })
  }, 1000)

  // Reset on page change
  router.onBeforeNavigate(() => {
    clearInterval(timer)
  })

  router.onAfterNavigate(() => {
    pageEnterTime = now()
    trackedIntervals.clear()
  })
}
```

### Browser Context Attachment

All client-side events automatically include:

```pseudocode
{
  // Always attached
  page_path: string,              // Current URL pathname
  page_url: string,               // Full URL
  user_agent: string,
  session_id: string,
  user_id: string | null,
  timestamp: datetime,

  // Browser capabilities (if available)
  viewport_width: number,
  viewport_height: number,
  screen_width: number,
  screen_height: number,

  // Ad blocker detection (see below)
  ad_blocker_detected: boolean,

  // UTM params (from section 4)
  utm_source: string | null,
  utm_medium: string | null,
  utm_campaign: string | null
}
```

### Ad Blocker Detection

```pseudocode
function detectAdBlocker(): boolean {
  // Common ad blocker detection methods
  // Method 1: Check for common ad blocker properties
  if (window.navigator.brave !== undefined):
    return true

  if (window.chrome?.runtime !== undefined):
    return true

  // Method 2: Try to load a tracking pixel
  let testImg = new Image()
  let adBlockerDetected = false

  testImg.onerror = () => {
    adBlockerDetected = true
  }

  testImg.src = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"

  // Give it 100ms to fail
  await sleep(100)

  return adBlockerDetected
}

// Call once on app init
let AD_BLOCKER_DETECTED = detectAdBlocker()
```

---

## 3. Conversion Funnel Helpers

**Purpose**: Define named conversion funnels and track user progression through them. Track drop-off and completion rates.

### Overview

A **funnel** is a named sequence of steps leading to a goal. For example:
- **Signup funnel**: landing → pricing → signup form → email verification → onboarding

Funnels are defined in app config (not hard-coded), and helpers are provided to track step completion and measure drop-off.

### Funnel Configuration

Config file: `.env` or `config/analytics-funnels.json`

```pseudocode
ANALYTICS_FUNNEL_CONFIG = {
  "funnel_definitions": [
    {
      "name": "signup",
      "label": "User Signup",
      "steps": [
        { "name": "landing", "label": "Landing Page" },
        { "name": "pricing_viewed", "label": "Viewed Pricing" },
        { "name": "signup_form_opened", "label": "Opened Signup Form" },
        { "name": "signup_form_submitted", "label": "Submitted Signup Form" },
        { "name": "email_verified", "label": "Verified Email" },
        { "name": "onboarding_complete", "label": "Completed Onboarding" }
      ]
    },
    {
      "name": "trial_to_paid",
      "label": "Trial to Paid Conversion",
      "steps": [
        { "name": "trial_started", "label": "Started Trial" },
        { "name": "feature_explored", "label": "Explored Features" },
        { "name": "billing_entered", "label": "Entered Billing Info" },
        { "name": "purchase_confirmed", "label": "Confirmed Purchase" }
      ]
    }
  ]
}
```

**Data model**:

```pseudocode
FunnelDefinition {
  name: string,                   // Unique identifier (e.g., "signup")
  label: string,                  // Display name
  steps: [
    {
      name: string,               // Step identifier
      label: string,              // Display name
      optional?: boolean          // If true, not required for completion
    }
  ]
}
```

### Funnel Step Tracking API

```pseudocode
// Main funnel tracking helper
function trackFunnelStep(
  funnelName: string,
  stepName: string,
  properties?: object
) {
  // Validate funnel exists
  let funnelDef = FUNNEL_CONFIG[funnelName]
  if (!funnelDef) {
    console.warn(`Funnel "${funnelName}" not defined`)
    return
  }

  // Validate step exists
  let stepDef = funnelDef.steps.find(s => s.name === stepName)
  if (!stepDef) {
    console.warn(`Step "${stepName}" not found in funnel "${funnelName}"`)
    return
  }

  // Check consent
  let consentStatus = getCookie("consentStatus")
  if (!shouldTrackAnalytics(consentStatus)) {
    return
  }

  // Get step index
  let stepIndex = funnelDef.steps.findIndex(s => s.name === stepName)

  // Get user context
  let user = getCurrentUser()
  let sessionId = getSessionId()

  // Emit event
  let analytics = getAnalytics()
  analytics.track("funnel_step", {
    funnel_name: funnelName,
    funnel_label: funnelDef.label,
    step_name: stepName,
    step_label: stepDef.label,
    step_index: stepIndex,
    total_steps: funnelDef.steps.length,
    user_id: user?.id || null,
    session_id: sessionId,
    timestamp: now(),
    ...properties
  })

  // Update user's funnel progress (in session storage)
  updateFunnelProgress(sessionId, funnelName, stepName, user?.id)
}

// Usage in components:
function PricingPage() {
  useEffect(() => {
    trackFunnelStep("signup", "pricing_viewed", {
      plan_type: "annual"
    })
  }, [])

  return <div>Pricing table...</div>
}

function SignupFormPage() {
  function handleSubmit(formData) {
    // ... submit form
    trackFunnelStep("signup", "signup_form_submitted", {
      form_fields_completed: Object.keys(formData).length
    })
  }

  return <form onSubmit={handleSubmit}>...</form>
}
```

### Funnel Progress Tracking (Session Storage)

```pseudocode
function updateFunnelProgress(
  sessionId: string,
  funnelName: string,
  stepName: string,
  userId?: string
) {
  // Key: sessionId + funnelName
  let progressKey = `_funnel_${funnelName}`

  // Retrieve current progress
  let progress = JSON.parse(sessionStorage.getItem(progressKey)) || {
    funnel_name: funnelName,
    session_id: sessionId,
    user_id: userId,
    steps_completed: [],
    first_step_at: null,
    last_step_at: null,
    duration_ms: null,
    started_at: now()
  }

  // Add step if not already completed
  if (!progress.steps_completed.includes(stepName)) {
    progress.steps_completed.push(stepName)
    progress.last_step_at = now()
    progress.duration_ms = progress.last_step_at - progress.started_at
  }

  // Update session storage
  sessionStorage.setItem(progressKey, JSON.stringify(progress))
}

// Retrieve funnel progress (e.g., for analytics dashboard)
function getFunnelProgress(funnelName: string) {
  let progressKey = `_funnel_${funnelName}`
  return JSON.parse(sessionStorage.getItem(progressKey))
}
```

### Server-Side Funnel Tracking (SSR/Backend)

For server-side events (e.g., email verification), emit funnel steps server-side:

```pseudocode
// On backend (e.g., email verification endpoint)
async function verifyEmail(request, response, emailToken) {
  let user = await verifyEmailToken(emailToken)

  if (!user) {
    return response.status(400).send({ error: "Invalid token" })
  }

  // Track funnel step server-side
  let analytics = getAnalytics("app")
  analytics.identify(user.id, {
    email: user.email,
    verified_at: now()
  })

  analytics.track("funnel_step", {
    funnel_name: "signup",
    step_name: "email_verified",
    step_label: "Verified Email",
    user_id: user.id,
    timestamp: now()
  })

  return response.json({ status: "verified" })
}
```

### Drop-Off Detection

Drop-off is calculated by comparing completions across sequential steps:

```pseudocode
function calculateFunnelDropOff(
  funnelName: string,
  timePeriod: "day" | "week" | "month"
) {
  // Fetch event counts from analytics data store
  let funnelDef = FUNNEL_CONFIG[funnelName]
  let eventCounts = {}

  for each step in funnelDef.steps:
    let count = queryAnalytics(
      "SELECT COUNT(*) FROM events WHERE " +
      "funnel_name = ? AND step_name = ? AND timestamp > ?",
      [funnelName, step.name, getTimePeriodStart(timePeriod)]
    )
    eventCounts[step.name] = count

  // Calculate drop-off between each step
  let dropOff = []
  for i = 0 to funnelDef.steps.length - 2:
    let currentStep = funnelDef.steps[i].name
    let nextStep = funnelDef.steps[i + 1].name

    let currentCount = eventCounts[currentStep]
    let nextCount = eventCounts[nextStep]

    let dropOffPercent = ((currentCount - nextCount) / currentCount) * 100

    dropOff.push({
      from_step: currentStep,
      to_step: nextStep,
      drop_off_percent: dropOffPercent,
      users_lost: currentCount - nextCount
    })

  return {
    funnel_name: funnelName,
    time_period: timePeriod,
    drop_off: dropOff,
    completion_rate: (eventCounts[last_step] / eventCounts[first_step]) * 100
  }
}
```

### Admin Dashboard Visualization (Spec)

```pseudocode
// Endpoint: GET /api/admin/funnels/:funnelName
async function getFunnelMetrics(funnelName: string, range: string) {
  let dropOff = calculateFunnelDropOff(funnelName, range)

  return {
    funnel_name: funnelName,
    funnel_label: FUNNEL_CONFIG[funnelName].label,
    steps: FUNNEL_CONFIG[funnelName].steps,

    // Step-by-step completion counts
    step_counts: [
      { step: "landing", count: 10000, percent: 100 },
      { step: "pricing_viewed", count: 6500, percent: 65 },
      { step: "signup_form_opened", count: 4200, percent: 42 },
      { step: "signup_form_submitted", count: 2100, percent: 21 },
      { step: "email_verified", count: 1890, percent: 18.9 },
      { step: "onboarding_complete", count: 1512, percent: 15.12 }
    ],

    // Drop-off analysis
    drop_off: [
      {
        from_step: "landing",
        to_step: "pricing_viewed",
        drop_off_percent: 35,
        users_lost: 3500
      },
      // ... more steps
    ],

    overall_completion_rate: 15.12,
    time_period: range
  }
}

// UI sketch:
// [Funnel: "User Signup"]
//
// Step 1: Landing Page
//   ████████████████████ 10,000 (100%)
//
// Step 2: Viewed Pricing
//   ██████████████░░░░░░ 6,500 (65%)
//   ↓ 35% drop-off (3,500 users)
//
// Step 3: Opened Signup Form
//   ████████░░░░░░░░░░░░ 4,200 (42%)
//   ↓ 35% drop-off (2,300 users)
//
// ...etc
//
// Completion Rate: 15.12%
```

---

## 4. UTM Parameter Capture and Persistence

**Purpose**: Capture UTM parameters from landing URLs, persist across session, attach to all analytics events, and associate with user records for attribution.

### Overview

UTM parameters (`utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`) are query string parameters used by marketing to track campaign performance. This feature:

1. Captures UTM params on landing (first page view)
2. Persists them in session storage (survives page navigation)
3. Attaches them to all subsequent analytics events
4. Stores them on user record during signup/login (for attribution)
5. Supports first-touch vs. last-touch attribution modes
6. Clears on new UTM params (new campaign)

### Data Model

#### URL with UTM parameters:

```
https://example.com/landing?utm_source=google&utm_medium=cpc&utm_campaign=summer_sale&utm_term=fitness&utm_content=banner_v2
```

#### Session Storage Schema

Key: `_utm_params`

```pseudocode
{
  utm_source: string | null,
  utm_medium: string | null,
  utm_campaign: string | null,
  utm_term: string | null,
  utm_content: string | null,

  // Attribution tracking
  first_touch_at: datetime,        // When first UTM params were captured
  last_touch_at: datetime,         // When UTM params were last updated
  campaign_sessions: [
    {
      utm_source: string,
      utm_medium: string,
      utm_campaign: string,
      utm_term: string,
      utm_content: string,
      entered_at: datetime,
      session_id: string
    }
  ]
}
```

#### User Record Schema

Extend user table with attribution fields:

```pseudocode
UserAttribution {
  user_id: string,

  // First-touch attribution (original campaign)
  first_utm_source: string | null,
  first_utm_medium: string | null,
  first_utm_campaign: string | null,
  first_utm_term: string | null,
  first_utm_content: string | null,
  first_utm_captured_at: datetime | null,

  // Last-touch attribution (final campaign before conversion)
  last_utm_source: string | null,
  last_utm_medium: string | null,
  last_utm_campaign: string | null,
  last_utm_term: string | null,
  last_utm_content: string | null,
  last_utm_captured_at: datetime | null,

  // Attribution mode
  attribution_mode: "first" | "last" | "multi",

  // Source of signup
  signup_source: "organic" | "campaign" | "direct",

  updated_at: datetime
}
```

### Client-Side UTM Capture

```pseudocode
// Initialize on page load (before routing)
function initializeUTMTracking() {
  // Extract UTM params from current URL
  let currentUTMs = getUTMParamsFromURL()

  // Get stored UTMs from session storage
  let storedUTMs = getStoredUTMParams()

  // Decide whether to update
  if (hasNewUTMCampaign(currentUTMs, storedUTMs)) {
    // New campaign; clear previous and store new
    storeUTMParams(currentUTMs)
  } else if (!storedUTMs && currentUTMs) {
    // First time; store
    storeUTMParams(currentUTMs)
  }

  // Attach UTMs to all events
  attachUTMToEvents()
}

function getUTMParamsFromURL(): object {
  let params = new URLSearchParams(window.location.search)

  return {
    utm_source: params.get("utm_source"),
    utm_medium: params.get("utm_medium"),
    utm_campaign: params.get("utm_campaign"),
    utm_term: params.get("utm_term"),
    utm_content: params.get("utm_content")
  }
}

function getStoredUTMParams(): object | null {
  let stored = sessionStorage.getItem("_utm_params")
  return stored ? JSON.parse(stored) : null
}

function hasNewUTMCampaign(current, stored): boolean {
  // If URL has UTM params and they differ from stored
  if (!current || !current.utm_source) {
    return false
  }

  if (!stored) {
    return true
  }

  // Check if any core UTM params changed
  return (
    current.utm_source !== stored.utm_source ||
    current.utm_medium !== stored.utm_medium ||
    current.utm_campaign !== stored.utm_campaign
  )
}

function storeUTMParams(utmParams: object) {
  let stored = {
    utm_source: utmParams.utm_source,
    utm_medium: utmParams.utm_medium,
    utm_campaign: utmParams.utm_campaign,
    utm_term: utmParams.utm_term,
    utm_content: utmParams.utm_content,

    first_touch_at: getStoredUTMParams()?.first_touch_at || now(),
    last_touch_at: now(),

    campaign_sessions: [
      ...(getStoredUTMParams()?.campaign_sessions || []),
      {
        utm_source: utmParams.utm_source,
        utm_medium: utmParams.utm_medium,
        utm_campaign: utmParams.utm_campaign,
        utm_term: utmParams.utm_term,
        utm_content: utmParams.utm_content,
        entered_at: now(),
        session_id: getSessionId()
      }
    ]
  }

  sessionStorage.setItem("_utm_params", JSON.stringify(stored))
}

function attachUTMToEvents() {
  // Hook into track() to auto-attach UTM params
  // (Modify track() function from section 2)

  let originalTrack = getAnalytics().track

  getAnalytics().track = function(eventName, properties = {}) {
    let utms = getStoredUTMParams()

    let enrichedProps = {
      ...properties,
      utm_source: utms?.utm_source || null,
      utm_medium: utms?.utm_medium || null,
      utm_campaign: utms?.utm_campaign || null,
      utm_term: utms?.utm_term || null,
      utm_content: utms?.utm_content || null
    }

    return originalTrack.call(this, eventName, enrichedProps)
  }
}
```

### Server-Side UTM Capture (on Signup/Login)

```pseudocode
// On user signup or account creation
async function handleUserSignup(request, signupData) {
  // Create user record
  let user = await createUser(signupData)

  // Get UTM params from request (via cookie or session)
  let utmParams = getUTMParamsFromRequest(request)
  let attributionMode = getAttributionMode()  // "first" or "last"

  // Determine signup source
  let signupSource = "organic"
  if (utmParams?.utm_source) {
    signupSource = "campaign"
  }

  // Store attribution on user record
  let attribution = {
    user_id: user.id,

    // First-touch: always recorded
    first_utm_source: utmParams?.utm_source || null,
    first_utm_medium: utmParams?.utm_medium || null,
    first_utm_campaign: utmParams?.utm_campaign || null,
    first_utm_term: utmParams?.utm_term || null,
    first_utm_content: utmParams?.utm_content || null,
    first_utm_captured_at: utmParams?.first_captured_at || now(),

    // Last-touch: depends on mode
    last_utm_source: attributionMode === "last" ? utmParams?.utm_source : null,
    last_utm_medium: attributionMode === "last" ? utmParams?.utm_medium : null,
    last_utm_campaign: attributionMode === "last" ? utmParams?.utm_campaign : null,
    last_utm_term: attributionMode === "last" ? utmParams?.utm_term : null,
    last_utm_content: attributionMode === "last" ? utmParams?.utm_content : null,
    last_utm_captured_at: attributionMode === "last" ? now() : null,

    attribution_mode: attributionMode,
    signup_source: signupSource,
    updated_at: now()
  }

  await saveUserAttribution(attribution)

  // Track signup event with UTM params
  let analytics = getAnalytics()
  analytics.identify(user.id, {
    email: user.email,
    utm_source: utmParams?.utm_source,
    utm_campaign: utmParams?.utm_campaign
  })

  analytics.track("user_signed_up", {
    utm_source: utmParams?.utm_source,
    utm_medium: utmParams?.utm_medium,
    utm_campaign: utmParams?.utm_campaign,
    signup_source: signupSource
  })

  return user
}

function getAttributionMode(): "first" | "last" {
  // Read from env or config
  return process.env.ANALYTICS_ATTRIBUTION_MODE || "first"
}

function getUTMParamsFromRequest(request): object | null {
  // Option 1: from URL query string
  let urlParams = new URLSearchParams(request.url.search)
  let utm = {
    utm_source: urlParams.get("utm_source"),
    utm_medium: urlParams.get("utm_medium"),
    utm_campaign: urlParams.get("utm_campaign"),
    utm_term: urlParams.get("utm_term"),
    utm_content: urlParams.get("utm_content")
  }

  if (utm.utm_source) {
    return { ...utm, first_captured_at: now() }
  }

  // Option 2: from cookie (if client sent it)
  let utmCookie = request.cookies.get("_utm_params")
  if (utmCookie) {
    return JSON.parse(utmCookie)
  }

  // Option 3: from referrer analysis (fallback)
  let referrer = request.headers.get("referer")
  if (referrer) {
    return analyzeReferrer(referrer)
  }

  return null
}

function analyzeReferrer(referrer: string): object {
  // Parse referrer URL
  let url = new URL(referrer)
  let host = url.hostname

  // Simple heuristic: identify source from domain
  if (host.includes("google")) {
    return { utm_source: "google", utm_medium: "organic", utm_campaign: null }
  } else if (host.includes("facebook")) {
    return { utm_source: "facebook", utm_medium: "referral", utm_campaign: null }
  }

  return { utm_source: host, utm_medium: "referral", utm_campaign: null }
}
```

### Attribution Mode Configuration

```pseudocode
// .env
ANALYTICS_ATTRIBUTION_MODE=first  // or "last" or "multi"
```

**Modes**:
- `"first"` — Attribute signups to the first campaign the user touched
- `"last"` — Attribute signups to the last campaign before conversion
- `"multi"` — Store both, let analytics tools decide (future-proof)

### Edge Cases & Handling

#### 1. Non-Landing Page with UTM Params

```pseudocode
// User is deep-linked with UTM params (e.g., from email)
// https://example.com/dashboard?utm_campaign=feature_launch

// Behavior:
// - If no session UTMs exist: capture these
// - If different campaign: treat as new campaign, update session
// - If same campaign: ignore (don't update timestamps)

function handleDeepLinkUTM(utmParams) {
  let storedUTMs = getStoredUTMParams()

  if (storedUTMs && isSameCampaign(utmParams, storedUTMs)) {
    // Same campaign; don't update
    return
  }

  // Different campaign or no stored UTMs
  storeUTMParams(utmParams)
}

function isSameCampaign(utm1, utm2): boolean {
  return (
    utm1.utm_source === utm2.utm_source &&
    utm1.utm_medium === utm2.utm_medium &&
    utm1.utm_campaign === utm2.utm_campaign
  )
}
```

#### 2. UTM Params on Non-Marketing Pages

```pseudocode
// User navigates to /dashboard with ?utm_campaign=test in URL
// Behavior: capture if it's a new campaign, but mark as suspicious

function storeUTMParams(utmParams) {
  let stored = {
    ...utmParams,
    first_touch_at: ...,
    last_touch_at: ...,

    // Flag: captured on non-landing page
    captured_on_page: window.location.pathname,
    is_suspicious: window.location.pathname !== "/" && window.location.pathname !== "/landing"
  }

  sessionStorage.setItem("_utm_params", JSON.stringify(stored))
}
```

#### 3. Ad Blocker Blocking UTM Tracking

```pseudocode
// Ad blockers may strip or block UTM param extraction
// Fallback: use referrer for attribution

function getUTMParamsFromURL(): object {
  let params = new URLSearchParams(window.location.search)
  let utms = {
    utm_source: params.get("utm_source"),
    utm_medium: params.get("utm_medium"),
    utm_campaign: params.get("utm_campaign"),
    utm_term: params.get("utm_term"),
    utm_content: params.get("utm_content")
  }

  // If UTMs are missing, try referrer analysis
  if (!utms.utm_source) {
    let referrerUTMs = analyzeReferrer(document.referrer)
    return referrerUTMs
  }

  return utms
}
```

#### 4. Clearing UTMs on New Session

```pseudocode
// If session expires or user manually clears cookies, clear UTMs
window.addEventListener("beforeunload", () => {
  // On new session, UTMs are cleared
  // (Session storage is cleared when tab closes)
})

// Optional: provide manual reset
function clearUTMParams() {
  sessionStorage.removeItem("_utm_params")
}
```

### Attribution Reports (Admin API)

```pseudocode
// Endpoint: GET /api/admin/attribution/report
async function getAttributionReport(range: string, groupBy?: string) {
  // groupBy: "utm_source" | "utm_campaign" | "utm_medium"

  let query = `
    SELECT
      ${groupBy || 'utm_source'} as grouping,
      COUNT(DISTINCT user_id) as signup_count,
      COUNT(DISTINCT CASE WHEN status = 'paid' THEN user_id END) as paid_count,
      AVG(lifetime_value) as avg_ltv
    FROM users_attribution
    WHERE first_utm_captured_at > ?
    GROUP BY ${groupBy || 'utm_source'}
    ORDER BY signup_count DESC
  `

  let results = await db.query(query, [getTimePeriodStart(range)])

  return {
    time_period: range,
    group_by: groupBy || "utm_source",
    attribution_mode: getAttributionMode(),
    data: results.map(row => ({
      name: row.grouping,
      signups: row.signup_count,
      conversions: row.paid_count,
      conversion_rate: row.paid_count / row.signup_count,
      avg_ltv: row.avg_ltv
    }))
  }
}

// Example response:
// {
//   time_period: "month",
//   group_by: "utm_campaign",
//   attribution_mode: "first",
//   data: [
//     {
//       name: "summer_sale",
//       signups: 1200,
//       conversions: 480,
//       conversion_rate: 0.4,
//       avg_ltv: 150
//     },
//     {
//       name: "holiday_promo",
//       signups: 950,
//       conversions: 285,
//       conversion_rate: 0.3,
//       avg_ltv: 120
//     }
//   ]
// }
```

---

## Integration Checklist

- [ ] **Server-side page views**: Integrated into SSR request handler, bot detection enabled
- [ ] **Client-side tracking**: Router hooks configured, auto-tracking enabled (buttons, forms, scroll, time)
- [ ] **Funnel definitions**: Config loaded from env/config, step tracking API working
- [ ] **UTM capture**: Session storage initialized on page load, attached to all events
- [ ] **Consent integration**: All tracking respects `consentStatus` cookie before emitting events
- [ ] **Analytics provider**: Multi-context system (`analytics.md`) initialized and ready
- [ ] **Error handling**: Failed events logged but don't block page; bot requests filtered server-side
- [ ] **Privacy**: Ad blocker detection noted, sensitive form fields not tracked, no PII in properties
- [ ] **Testing**: Consent bypass for dev mode, debug logging of track() calls, manual session ID override

---

## Privacy & Security Notes

### Consent Respect

All tracking (server and client) checks the `consentStatus` cookie before emitting events:

```pseudocode
function shouldTrackAnalytics(consentStatus): boolean {
  if (!consentStatus) return false
  let consent = parseJSON(consentStatus)
  return consent.analytics === true
}
```

### Bot Filtering

Server-side: bot user agents detected and skipped (see `detectBot()` function).

Client-side: ad blocker detection via `detectAdBlocker()` recorded in events (informational only).

### Sensitive Field Protection

Forms: Password, credit card, SSN, API key, and secret fields are NOT tracked even with `data-track-value` attribute.

### No PII in Properties

All properties attached to events must be:
- Anonymized (user ID, not email)
- Non-sensitive (campaign name, not credit card)
- Aggregate (funnel step number, not form field values)

### Ad Blocker Awareness

Events may fail to be emitted if ad blocker blocks analytics endpoints. This is expected and acceptable. Fallback: use referrer-based attribution if UTM params are blocked.
