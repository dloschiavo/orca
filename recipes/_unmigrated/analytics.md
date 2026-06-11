---
name: Analytics & Event Tracking
description: Multi-context analytics wrapper for server-side and client-side event tracking with provider abstraction
type: project
---

# Analytics & Event Tracking

A stack-agnostic recipe for a unified analytics layer that abstracts away provider details and enables seamless event tracking across client and server with automatic context attachment, consent awareness, and intelligent user identification.

## Overview

Most apps need to track user behavior, feature usage, and business events. However, **landing pages and the authenticated app often use different analytics properties or entirely different platforms** — GA4 for SEO landing pages, PostHog for product analytics, Mixpanel for the app. This recipe provides:

- **Multiple analytics contexts**: landing pages and app can use different providers/properties
- **Single tracking API per context**: one `track(event, properties)` function
- **Provider abstraction**: swap providers via `.env`, zero code changes
- **Unified client + server tracking**: consistent event taxonomy across boundaries
- **Automatic context**: super properties attached to every event
- **User lifecycle**: identification on login, reset on logout
- **Consent integration**: respects user cookie/analytics consent
- **Development experience**: debug mode with console logging, no-op provider for testing

## Multi-Context Architecture

Analytics contexts are named instances, each backed by its own provider and API key. The two default contexts are:

| Context | Env prefix | Used by | Typical provider |
|---|---|---|---|
| `app` | `ANALYTICS_APP_*` | Authenticated SPA sections, admin panel, account pages | PostHog, Mixpanel, Amplitude |
| `landing` | `ANALYTICS_LANDING_*` | Public/marketing pages: landing, pricing, FAQ, blog (SSR) | GA4, PostHog |

Additional contexts can be added by defining `ANALYTICS_{CONTEXT}_PROVIDER` and `ANALYTICS_{CONTEXT}_API_KEY` in `.env`. The wrapper auto-discovers them.

**Why separate contexts:**
1. Landing pages are SSR — GA4's gtag.js snippet works well here and gives you Google Ads integration, Search Console data, etc.
2. The app is SPA — PostHog/Mixpanel give better product analytics (funnels, session replay, feature flags).
3. They often track different user populations (anonymous visitors vs authenticated users).
4. Different teams may own different properties.
5. You may want to turn off app analytics (noop) during dev but keep landing analytics active for marketing.

**Code uses the context name to get the right instance:**

```pseudocode
// In a landing page component (SSR)
getAnalytics("landing").page("pricing")

// In the authenticated app (SPA)
getAnalytics("app").track("feature.used", { feature: "export_csv" })

// Shorthand — defaults to "app" context if no argument
getAnalytics().track("user.logged_in")
```

## Core Architecture

### Analytics Provider Interface

All provider implementations expose a consistent interface:

```pseudocode
interface AnalyticsProvider {
  // Initialize the provider (runs once on app startup)
  async init(config: ProviderConfig) -> void

  // Associate events with a user
  identify(userId: string, traits: { [key: string]: any }) -> void

  // Track an event with optional properties
  track(event: string, properties: { [key: string]: any }) -> void

  // Track a page view (client-side primarily)
  page(name: string, properties: { [key: string]: any }) -> void

  // Dissociate from current user (logout/reset)
  reset() -> void

  // Check if analytics is ready to track
  isReady() -> boolean

  // Flush pending events to server (may be async)
  async flush() -> void

  // Optionally: set properties that attach to all future events
  setSuperProperties(properties: { [key: string]: any }) -> void
}
```

### Multi-Context Wrapper API

The app accesses analytics through a registry of named contexts:

```pseudocode
// Get a specific context (landing, app, or any custom context)
function getAnalytics(context?: string = "app") -> Analytics

// Initialize all contexts from env vars (called once at startup)
async function initializeAllAnalytics() -> void
```

Each context exposes the same `Analytics` interface:

```pseudocode
interface Analytics {
  // Identify the current user
  identify(userId: string, traits: UserTraits) -> void

  // Track an event
  track(event: string, properties?: EventProperties) -> void

  // Track a page view
  page(name: string, properties?: PageProperties) -> void

  // Reset user session
  reset() -> void

  // Set super properties (attached to all events)
  setSuperProperties(properties: SuperProperties) -> void

  // Check readiness
  isReady() -> boolean

  // Flush all pending events
  async flush() -> void
}

type UserTraits = {
  email?: string
  display_name?: string
  plan?: string
  created_at?: string
  [key: string]: any
}

type EventProperties = {
  [key: string]: any
}

type SuperProperties = {
  app_name: string
  app_version: string
  environment: "development" | "staging" | "production"
  platform: "web" | "mobile" | "desktop"
  [key: string]: any
}
```

## Provider Implementations

### 1. PostHog (Recommended Default)

**Why PostHog**: Self-hostable, privacy-respecting, feature flags + analytics in one, good replay features, generous open-source tier.

```pseudocode
class PostHogProvider implements AnalyticsProvider {
  constructor() {
    this.client = null
    this.ready = false
  }

  async init(config: ProviderConfig) {
    // config.apiKey: PostHog API key
    // config.apiHost: PostHog instance URL (https://app.posthog.com or self-hosted)
    // config.platform: "web" or server

    if (config.platform === "web") {
      // Browser: import PostHog SDK
      // window.posthog = PostHog client
      // posthog.init(config.apiKey, {
      //   api_host: config.apiHost,
      //   loaded: () => { this.ready = true }
      // })
      this.client = window.posthog
    } else {
      // Server: use PostHog API via HTTP
      // this.client = HTTP client configured for config.apiHost
      this.ready = true
    }
  }

  identify(userId: string, traits: { [key: string]: any }) {
    if (!this.ready) return

    if (this.client.identify) {
      // Browser
      this.client.identify(userId, traits)
    } else {
      // Server: POST /decide/ or /track/ with distinct_id
      this.client.post({
        url: `${this.apiHost}/api/identify/`,
        body: {
          distinct_id: userId,
          properties: traits
        }
      })
    }
  }

  track(event: string, properties: { [key: string]: any }) {
    if (!this.ready) return

    const payload = {
      event: event,
      properties: properties
    }

    if (this.client.capture) {
      // Browser
      this.client.capture(event, properties)
    } else {
      // Server
      this.client.post({
        url: `${this.apiHost}/api/track/`,
        body: payload
      })
    }
  }

  page(name: string, properties: { [key: string]: any }) {
    // PostHog: track as event with $page_name property
    this.track("$pageview", {
      $page_name: name,
      ...properties
    })
  }

  reset() {
    if (this.ready && this.client.reset) {
      this.client.reset()
    }
  }

  setSuperProperties(properties: { [key: string]: any }) {
    if (this.ready && this.client.register) {
      this.client.register(properties)
    }
  }

  async flush() {
    if (this.ready && this.client.flush) {
      return this.client.flush()
    }
  }

  isReady() {
    return this.ready
  }
}
```

### 2. Mixpanel

```pseudocode
class MixpanelProvider implements AnalyticsProvider {
  constructor() {
    this.client = null
    this.ready = false
  }

  async init(config: ProviderConfig) {
    // config.token: Mixpanel project token
    // config.platform: "web" or server

    if (config.platform === "web") {
      // Browser: import Mixpanel SDK
      // window.mixpanel.init(config.token)
      this.client = window.mixpanel
      this.ready = true
    } else {
      // Server: use Mixpanel HTTP API
      // this.client = HTTP client with Authorization: Bearer token
      this.ready = true
    }
  }

  identify(userId: string, traits: { [key: string]: any }) {
    if (!this.ready) return

    if (this.client.identify) {
      // Browser
      this.client.identify(userId)
      this.client.people.set(traits)
    } else {
      // Server: POST /api/import/
      this.client.post({
        url: "https://api.mixpanel.com/api/import/",
        body: {
          data: base64(JSON.stringify({
            distinct_id: userId,
            $set: traits
          }))
        }
      })
    }
  }

  track(event: string, properties: { [key: string]: any }) {
    if (!this.ready) return

    if (this.client.track) {
      // Browser
      this.client.track(event, properties)
    } else {
      // Server
      this.client.post({
        url: "https://api.mixpanel.com/api/import/",
        body: {
          data: base64(JSON.stringify({
            event: event,
            properties: properties
          }))
        }
      })
    }
  }

  page(name: string, properties: { [key: string]: any }) {
    this.track("$pageview", {
      $page_name: name,
      ...properties
    })
  }

  reset() {
    if (this.ready) {
      if (this.client.reset) {
        this.client.reset()
      } else {
        this.client = null // server-side: clear client state
      }
    }
  }

  setSuperProperties(properties: { [key: string]: any }) {
    if (this.ready && this.client.register) {
      this.client.register(properties)
    }
  }

  async flush() {
    // Mixpanel doesn't have an explicit flush; events are queued and sent
  }

  isReady() {
    return this.ready
  }
}
```

### 3. Amplitude

```pseudocode
class AmplitudeProvider implements AnalyticsProvider {
  constructor() {
    this.client = null
    this.ready = false
  }

  async init(config: ProviderConfig) {
    // config.apiKey: Amplitude API key
    // config.platform: "web" or server

    if (config.platform === "web") {
      // Browser: import Amplitude SDK
      // window.amplitude = Amplitude instance
      this.client = window.amplitude
      this.client.init(config.apiKey, {
        logLevel: "Warn"
      })
      this.ready = true
    } else {
      // Server: use Amplitude HTTP API
      this.apiKey = config.apiKey
      this.ready = true
    }
  }

  identify(userId: string, traits: { [key: string]: any }) {
    if (!this.ready) return

    if (this.client.setUserId) {
      // Browser
      this.client.setUserId(userId)
      this.client.setUserProperties(traits)
    } else {
      // Server: POST /2/users/identify
      this.client.post({
        url: "https://api2.amplitude.com/2/users/identify",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: {
          user_id: userId,
          user_properties: traits
        }
      })
    }
  }

  track(event: string, properties: { [key: string]: any }) {
    if (!this.ready) return

    if (this.client.logEvent) {
      // Browser
      this.client.logEvent(event, properties)
    } else {
      // Server: POST /2/events
      this.client.post({
        url: "https://api2.amplitude.com/2/events",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: {
          events: [{
            event_type: event,
            event_properties: properties
          }]
        }
      })
    }
  }

  page(name: string, properties: { [key: string]: any }) {
    this.track("page_viewed", {
      page_name: name,
      ...properties
    })
  }

  reset() {
    if (this.ready && this.client.reset) {
      this.client.reset()
    }
  }

  setSuperProperties(properties: { [key: string]: any }) {
    if (this.ready && this.client.setUserProperties) {
      this.client.setUserProperties(properties)
    }
  }

  async flush() {
    if (this.ready && this.client.flush) {
      return this.client.flush()
    }
  }

  isReady() {
    return this.ready
  }
}
```

### 4. Google Analytics 4 (GA4)

GA4 is commonly used for landing/marketing pages because of its Google Ads and Search Console integration. It uses a measurement ID (`G-XXXXXXXXXX`) rather than an API key.

```pseudocode
class GA4Provider implements AnalyticsProvider {
  constructor() {
    this.ready = false
    this.measurementId = null
  }

  async init(config: ProviderConfig) {
    // config.measurementId: GA4 measurement ID (e.g., G-XXXXXXXXXX)
    // config.platform: "web" (GA4 is browser-only; server-side uses Measurement Protocol)
    this.measurementId = config.measurementId

    if (config.platform === "web") {
      // Inject gtag.js script tag
      // <script async src="https://www.googletagmanager.com/gtag/js?id={measurementId}">
      // window.dataLayer = window.dataLayer || []
      // function gtag() { dataLayer.push(arguments) }
      // gtag('js', new Date())
      // gtag('config', measurementId, { send_page_view: false })
      //   ↑ disable automatic page views — we control them explicitly
      this.ready = true
    } else {
      // Server-side: use GA4 Measurement Protocol
      // POST https://www.google-analytics.com/mp/collect?measurement_id={id}&api_secret={secret}
      this.ready = true
    }
  }

  identify(userId: string, traits: { [key: string]: any }) {
    if (!this.ready) return
    // GA4: set user_id and user properties
    // gtag('set', { user_id: userId })
    // gtag('set', 'user_properties', traits)
  }

  track(event: string, properties: { [key: string]: any }) {
    if (!this.ready) return
    // GA4 event names: lowercase, underscores, max 40 chars
    // gtag('event', normalizeEventName(event), properties)
  }

  page(name: string, properties: { [key: string]: any }) {
    if (!this.ready) return
    // gtag('event', 'page_view', { page_title: name, page_location: properties.path, ...properties })
  }

  reset() {
    // GA4: no explicit reset — set user_id to null
    // gtag('set', { user_id: null })
  }

  setSuperProperties(properties: { [key: string]: any }) {
    // GA4: use gtag('set', ...) for global parameters
    // gtag('set', properties)
  }

  async flush() {
    // GA4 sends events immediately via gtag; no explicit flush needed
  }

  isReady() {
    return this.ready
  }
}
```

**GA4 gotchas:**
- Event names must be lowercase with underscores, max 40 characters. The provider should normalize `subscription.created` → `subscription_created`.
- GA4 has a limit of 25 custom event parameters per event and 25 user properties.
- Server-side Measurement Protocol requires an `api_secret` (generated in GA4 admin), separate from the measurement ID.
- GA4 does NOT support `identify()` the same way product analytics tools do — `user_id` is set globally via `gtag('set')`, not per-event.

### 5. No-Op Provider (Development / Testing)

```pseudocode
class NoOpProvider implements AnalyticsProvider {
  constructor() {
    this.ready = true
    this.events = []
  }

  async init(config: ProviderConfig) {
    // no-op
  }

  identify(userId: string, traits: { [key: string]: any }) {
    console.log("[Analytics] identify", userId, traits)
    this.events.push({ type: "identify", userId, traits })
  }

  track(event: string, properties: { [key: string]: any }) {
    console.log("[Analytics] track", event, properties)
    this.events.push({ type: "track", event, properties })
  }

  page(name: string, properties: { [key: string]: any }) {
    console.log("[Analytics] page", name, properties)
    this.events.push({ type: "page", name, properties })
  }

  reset() {
    console.log("[Analytics] reset")
    this.events.push({ type: "reset" })
  }

  setSuperProperties(properties: { [key: string]: any }) {
    console.log("[Analytics] setSuperProperties", properties)
  }

  async flush() {
    console.log("[Analytics] flush", this.events)
  }

  isReady() {
    return this.ready
  }
}
```

## Analytics Wrapper

The wrapper manages a registry of named analytics contexts. Each context has its own provider, API key, and super properties.

```pseudocode
// Registry — maps context names to wrapper instances
let contexts: Map<string, AnalyticsWrapper> = new Map()

function getAnalytics(context: string = "app") -> Analytics {
  if (!contexts.has(context)) {
    // Return a no-op instance for unconfigured contexts — never crash
    return new AnalyticsWrapper()  // defaults to NoOpProvider
  }
  return contexts.get(context)
}

// Called once at app startup — auto-discovers all ANALYTICS_{CONTEXT}_* vars
async function initializeAllAnalytics(env, options?) {
  // Discover contexts by scanning env var prefixes
  // e.g., ANALYTICS_APP_PROVIDER, ANALYTICS_LANDING_PROVIDER → ["app", "landing"]
  discoveredContexts = findUniqueContextPrefixes(env, "ANALYTICS_")

  for (contextName of discoveredContexts) {
    prefix = "ANALYTICS_" + contextName.toUpperCase() + "_"
    providerType = env[prefix + "PROVIDER"]
    apiKey = env[prefix + "API_KEY"]
    apiHost = env[prefix + "API_HOST"]
    measurementId = env[prefix + "MEASUREMENT_ID"]  // GA4 only

    if (!providerType || providerType === "noop") {
      contexts.set(contextName, new AnalyticsWrapper())  // no-op
      continue
    }

    wrapper = new AnalyticsWrapper()
    await wrapper.initialize(providerType, {
      apiKey, apiHost, measurementId,
      appName: env.APP_NAME,
      appVersion: env.APP_VERSION,
      environment: env.NODE_ENV,
      platform: determinePlatform(),
      contextName: contextName
    }, options)

    contexts.set(contextName, wrapper)
  }
}
```

Each wrapper instance:

```pseudocode
class AnalyticsWrapper implements Analytics {
  constructor() {
    this.provider = null
    this.superProperties = {}
    this.consentManager = null
    this.isDebug = false
    this.contextName = "unknown"
  }

  async initialize(
    providerType: "posthog" | "mixpanel" | "amplitude" | "ga4" | "noop",
    config: ProviderConfig,
    options?: {
      debug?: boolean
      consentManager?: ConsentManager
    }
  ) {
    this.isDebug = options?.debug ?? false
    this.consentManager = options?.consentManager
    this.contextName = config.contextName || "app"

    // Instantiate the appropriate provider
    switch (providerType) {
      case "posthog":
        this.provider = new PostHogProvider()
        break
      case "mixpanel":
        this.provider = new MixpanelProvider()
        break
      case "amplitude":
        this.provider = new AmplitudeProvider()
        break
      case "ga4":
        this.provider = new GA4Provider()
        break
      case "noop":
      default:
        this.provider = new NoOpProvider()
        break
    }

    await this.provider.init(config)

    // Initialize super properties
    this.setSuperProperties({
      app_name: config.appName,
      app_version: config.appVersion,
      environment: config.environment,
      platform: config.platform,
      analytics_context: this.contextName
    })
  }

  identify(userId: string, traits: UserTraits) {
    if (!this.provider.isReady()) {
      console.warn("[Analytics] Provider not ready for identify")
      return
    }

    if (!this.canTrack()) {
      console.debug("[Analytics] User has not consented to analytics")
      return
    }

    if (this.isDebug) {
      console.log("[Analytics] identify:", userId, traits)
    }

    this.provider.identify(userId, traits)
  }

  track(event: string, properties?: EventProperties) {
    if (!this.provider.isReady()) {
      console.warn("[Analytics] Provider not ready for track")
      return
    }

    if (!this.canTrack()) {
      if (this.isDebug) {
        console.debug("[Analytics] Skipping track (no consent):", event)
      }
      return
    }

    // Merge with super properties
    const fullProperties = {
      ...this.superProperties,
      ...properties
    }

    if (this.isDebug) {
      console.log("[Analytics] track:", event, fullProperties)
    }

    this.provider.track(event, fullProperties)
  }

  page(name: string, properties?: PageProperties) {
    if (!this.provider.isReady()) {
      console.warn("[Analytics] Provider not ready for page")
      return
    }

    if (!this.canTrack()) {
      if (this.isDebug) {
        console.debug("[Analytics] Skipping page (no consent):", name)
      }
      return
    }

    const fullProperties = {
      ...this.superProperties,
      ...properties
    }

    if (this.isDebug) {
      console.log("[Analytics] page:", name, fullProperties)
    }

    this.provider.page(name, fullProperties)
  }

  reset() {
    if (!this.provider.isReady()) {
      return
    }

    if (this.isDebug) {
      console.log("[Analytics] reset")
    }

    this.provider.reset()
  }

  setSuperProperties(properties: SuperProperties) {
    this.superProperties = {
      ...this.superProperties,
      ...properties
    }

    if (this.provider.isReady()) {
      this.provider.setSuperProperties(this.superProperties)
    }

    if (this.isDebug) {
      console.log("[Analytics] setSuperProperties:", this.superProperties)
    }
  }

  async flush() {
    if (!this.provider.isReady()) {
      return
    }

    if (this.isDebug) {
      console.log("[Analytics] flushing events")
    }

    return this.provider.flush()
  }

  isReady() {
    return this.provider && this.provider.isReady()
  }

  private canTrack() {
    // Check consent status
    if (this.consentManager) {
      return this.consentManager.hasConsentedToAnalytics()
    }

    // If no consent manager, assume consent (or configure to be strict)
    return true
  }
}

// Note: getAnalytics() and initializeAllAnalytics() are defined above in the registry.
// There is no singleton — each context is its own instance.
```

## Client-Side Initialization and Lifecycle

### Initialization on App Load

```pseudocode
// In main app entry point (e.g., index.tsx, App.tsx, main.ts)

async function initializeAnalytics() {
  // Discovers all ANALYTICS_{CONTEXT}_* vars and creates a wrapper per context
  await initializeAllAnalytics(process.env, {
    debug: getEnv("NODE_ENV") === "development",
    consentManager: getCookieConsentManager()
  })

  console.log("[Analytics] All contexts initialized")
  // Now getAnalytics("app") and getAnalytics("landing") are ready
}

// Call on app startup
initializeAnalytics()
```

### Which context to use where

```pseudocode
// SSR landing page (pricing.tsx, faq.tsx, etc.)
// → uses "landing" context (typically GA4)
function PricingPage() {
  onMount(() => {
    getAnalytics("landing").page("pricing", { path: "/pricing" })
  })
}

// Authenticated app page (dashboard.tsx, settings.tsx, etc.)
// → uses "app" context (typically PostHog/Mixpanel)
function DashboardPage() {
  onMount(() => {
    getAnalytics("app").page("dashboard")
  })
}

// Shorthand — getAnalytics() defaults to "app"
getAnalytics().track("feature.used", { feature: "export" })
```

### User Identification on Login

```pseudocode
// In authentication/login handler

async function handleLogin(user: User) {
  // ... perform login ...

  const analytics = getAnalytics()
  analytics.identify(user.id, {
    email: user.email,
    display_name: user.displayName,
    plan: user.plan,
    created_at: user.createdAt,
    // Additional custom traits
    is_premium: user.plan !== "free",
    signup_source: getStoredSignupSource() // from localStorage
  })

  // Track login event
  analytics.track("user.logged_in", {
    user_id: user.id,
    plan: user.plan
  })

  // Redirect to app
  navigateTo("/dashboard")
}
```

### Automatic Page View Tracking (SPA)

```pseudocode
// In router/navigation handler (e.g., React Router, Vue Router, Svelte navigation)

function onRouteChange(newRoute: Route, oldRoute?: Route) {
  const analytics = getAnalytics()

  // Skip identifying if already identified in this session
  // (provider handles this internally)

  analytics.page(newRoute.name || newRoute.path, {
    path: newRoute.path,
    params: newRoute.params,
    // Include any custom context
    is_authenticated: isUserLoggedIn(),
    user_plan: getCurrentUser()?.plan
  })
}

// Register route change listener
router.on("change", onRouteChange)

// For React apps:
// useEffect(() => {
//   const route = useLocation()
//   getAnalytics().page(route.pathname, { path: route.pathname })
// }, [location])
```

### User Reset on Logout

```pseudocode
// In authentication/logout handler

async function handleLogout() {
  const analytics = getAnalytics()

  // Track logout event before reset
  analytics.track("user.logged_out")

  // Flush any pending events
  await analytics.flush()

  // Reset user session
  analytics.reset()

  // Redirect to login
  navigateTo("/login")
}
```

## Server-Side Tracking

### API Route Event Tracking

```pseudocode
// In API route handlers (e.g., /api/subscriptions/create)

async function createSubscription(request: Request) {
  const user = request.user // from auth middleware

  try {
    const subscription = await db.subscriptions.create({
      userId: user.id,
      planId: request.body.planId,
      // ... other fields
    })

    // Track server-side event
    const analytics = getServerAnalytics() // different instance for server
    analytics.track("subscription.created", {
      user_id: user.id,
      plan_id: subscription.planId,
      billing_cycle: subscription.billingCycle,
      amount_cents: subscription.amountCents
    })

    return { success: true, subscription }
  } catch (error) {
    // Optionally track errors
    getServerAnalytics().track("subscription.creation_failed", {
      user_id: user.id,
      error: error.code
    })
    throw error
  }
}
```

### Background Job Event Tracking

```pseudocode
// In background job runner (e.g., Celery, Bull, node-resque)

async function processSubscriptionRenewal(jobData: JobData) {
  const { subscriptionId, userId } = jobData
  const analytics = getServerAnalytics()

  try {
    const subscription = await db.subscriptions.findById(subscriptionId)
    const result = await chargeCustomer(subscription)

    analytics.track("subscription.renewed", {
      user_id: userId,
      subscription_id: subscriptionId,
      amount_cents: subscription.amountCents,
      processor: "stripe"
    })

    return { success: true }
  } catch (error) {
    analytics.track("subscription.renewal_failed", {
      user_id: userId,
      subscription_id: subscriptionId,
      error_code: error.code
    })
    throw error
  }
}
```

### Webhook Event Tracking

```pseudocode
// In webhook handler (e.g., Stripe webhook)

async function handleStripeWebhook(event: StripeEvent) {
  const analytics = getServerAnalytics()

  switch (event.type) {
    case "invoice.payment_succeeded":
      const invoice = event.data.object
      const customerId = invoice.customer

      analytics.track("payment.succeeded", {
        user_id: getUserIdFromCustomer(customerId),
        amount_cents: invoice.amount_paid,
        invoice_id: invoice.id,
        source: "stripe_webhook"
      })
      break

    case "invoice.payment_failed":
      analytics.track("payment.failed", {
        user_id: getUserIdFromCustomer(event.data.object.customer),
        amount_cents: event.data.object.amount,
        source: "stripe_webhook"
      })
      break
  }

  return { received: true }
}
```

### Server-Side Analytics Initialization

Server-side uses the same `initializeAllAnalytics()` with `platform: "server"`. Both "app" and "landing" contexts are available server-side — use "app" for API route events and webhooks, "landing" for SSR page view tracking.

```pseudocode
// In server startup
async function initializeServerAnalytics() {
  await initializeAllAnalytics(process.env, {
    debug: process.env.NODE_ENV === "development",
    platformOverride: "server"  // tells providers to use HTTP APIs, not browser SDKs
  })
  console.log("[Analytics] Server contexts initialized")
}

initializeServerAnalytics()

// In API route handler — uses "app" context
getAnalytics("app").track("subscription.created", { user_id, plan_id })

// In SSR page render — uses "landing" context
getAnalytics("landing").page("pricing", { path: "/pricing", referrer })
```

## Standard Event Taxonomy

Define a base set of events using the `noun.verb` naming pattern. This ensures consistency and makes analytics queries predictable.

### User Events

```pseudocode
event: "user.signed_up"
properties: {
  email: string,
  signup_source: string, // "organic", "paid_ad", "referral", etc.
  plan: string
}

event: "user.logged_in"
properties: {
  user_id: string,
  auth_method: string // "email", "google", "github", etc.
}

event: "user.logged_out"
properties: {
  user_id: string,
  session_duration_seconds: number
}

event: "user.profile_updated"
properties: {
  user_id: string,
  fields_changed: string[] // ["email", "display_name"]
}
```

### Subscription Events

```pseudocode
event: "subscription.created"
properties: {
  user_id: string,
  plan: string,
  billing_cycle: string, // "monthly", "annual"
  amount_cents: number
}

event: "subscription.upgraded"
properties: {
  user_id: string,
  from_plan: string,
  to_plan: string,
  amount_difference_cents: number
}

event: "subscription.downgraded"
properties: {
  user_id: string,
  from_plan: string,
  to_plan: string
}

event: "subscription.cancelled"
properties: {
  user_id: string,
  plan: string,
  reason: string, // free-form or enum
  mrr_impact_cents: number
}

event: "subscription.renewed"
properties: {
  user_id: string,
  plan: string,
  amount_cents: number
}
```

### Payment Events

```pseudocode
event: "payment.succeeded"
properties: {
  user_id: string,
  amount_cents: number,
  invoice_id: string,
  processor: string // "stripe", "square", etc.
}

event: "payment.failed"
properties: {
  user_id: string,
  amount_cents: number,
  error_code: string,
  processor: string
}

event: "payment.refunded"
properties: {
  user_id: string,
  amount_cents: number,
  invoice_id: string
}
```

### Feature Usage Events

```pseudocode
event: "feature.used"
properties: {
  user_id: string,
  feature_name: string, // "export_csv", "api_call", etc.
  count: number // how many times in this event
}

event: "api.called"
properties: {
  user_id: string,
  endpoint: string,
  method: string, // "GET", "POST", etc.
  status_code: number,
  response_time_ms: number
}

event: "report.generated"
properties: {
  user_id: string,
  report_type: string,
  row_count: number,
  format: string // "csv", "pdf", etc.
}
```

### Page View Events (Auto-tracked)

```pseudocode
event: "$pageview" (provider-specific, or normalized to "page.viewed")
properties: {
  page_name: string, // from route name or URL
  path: string,
  referrer: string,
  is_authenticated: boolean,
  user_plan: string // if logged in
}
```

### Support / Feedback Events

```pseudocode
event: "support.ticket_created"
properties: {
  user_id: string,
  ticket_id: string,
  category: string,
  priority: string
}

event: "feedback.submitted"
properties: {
  user_id: string,
  type: string, // "bug", "feature_request", "general"
  rating: number // 1-5 if applicable
}
```

### Error Events (Be Selective)

```pseudocode
event: "error.occurred"
properties: {
  user_id: string,
  error_code: string,
  error_message: string, // sanitized, no PII
  stack_trace: string, // only in development
  severity: string, // "warning", "error", "critical"
}
```

## Super Properties

Super properties are automatically attached to every event. Set them once and they persist for the session.

```pseudocode
// Auto-set by wrapper on initialization
{
  app_name: "MyApp",
  app_version: "1.2.3",
  environment: "production",
  platform: "web"
}

// Optionally add these
{
  // Browser / Device
  browser_name: "Chrome",
  browser_version: "120",
  os: "macOS",
  os_version: "14.2",
  device_type: "desktop", // or "mobile"

  // Session
  session_id: "unique-session-id",
  user_id: "user123", // set on identify
  plan: "pro", // set on identify

  // Custom
  ab_test_variant: "variant_a", // if running tests
  feature_flag_enabled: true, // if using feature flags
}
```

### Setting Super Properties

```pseudocode
// On app load
getAnalytics().setSuperProperties({
  session_id: generateSessionId(),
  browser_name: getBrowserName(),
  os: getOS(),
  device_type: isMobile() ? "mobile" : "desktop"
})

// When user logs in
getAnalytics().setSuperProperties({
  user_id: user.id,
  plan: user.plan
})

// When AB test is assigned
getAnalytics().setSuperProperties({
  ab_test_variant: assignedVariant
})

// When feature flag is evaluated
getAnalytics().setSuperProperties({
  feature_flag_new_dashboard: isEnabled("new_dashboard")
})
```

## Consent Integration

Analytics must respect user consent for cookie tracking and data collection.

### Consent Manager Interface

```pseudocode
interface ConsentManager {
  // Check if user has given analytics consent
  hasConsentedToAnalytics(): boolean

  // Listen for consent changes
  onConsentChange(callback: (consent: ConsentState) => void): void
}

type ConsentState = {
  analytics: boolean,
  marketing: boolean,
  functional: boolean
}
```

### Integrating with Consent Manager

```pseudocode
class AnalyticsWrapper implements Analytics {
  private consentManager: ConsentManager

  constructor(consentManager: ConsentManager) {
    this.consentManager = consentManager

    // Listen for consent changes
    consentManager.onConsentChange((consent) => {
      if (consent.analytics) {
        console.log("[Analytics] User consented, starting tracking")
      } else {
        console.log("[Analytics] User revoked consent, stopping tracking")
      }
    })
  }

  private canTrack(): boolean {
    // Check consent before any tracking
    if (!this.consentManager.hasConsentedToAnalytics()) {
      return false
    }
    return true
  }

  track(event: string, properties?: EventProperties) {
    if (!this.canTrack()) {
      if (this.isDebug) {
        console.debug("[Analytics] Skipping (no consent):", event)
      }
      return
    }

    this.provider.track(event, properties)
  }

  identify(userId: string, traits: UserTraits) {
    if (!this.canTrack()) {
      if (this.isDebug) {
        console.debug("[Analytics] Skipping identify (no consent)")
      }
      return
    }

    this.provider.identify(userId, traits)
  }
}
```

### Pre-Consent Event Buffering (Optional)

If you want to track events before consent is given and replay them after:

```pseudocode
class BufferingAnalytics extends AnalyticsWrapper {
  private eventBuffer: Array<{ event: string, properties: any }> = []
  private hasConsent: boolean = false

  constructor(consentManager: ConsentManager) {
    super(consentManager)

    consentManager.onConsentChange((consent) => {
      if (consent.analytics && !this.hasConsent) {
        this.hasConsent = true
        this.flushBuffer()
      }
    })
  }

  track(event: string, properties?: EventProperties) {
    if (this.canTrack()) {
      this.provider.track(event, properties)
    } else {
      // Buffer the event
      this.eventBuffer.push({ event, properties })
    }
  }

  private flushBuffer() {
    for (const { event, properties } of this.eventBuffer) {
      this.provider.track(event, properties)
    }
    this.eventBuffer = []
  }
}
```

## Debug Mode

In development, log all analytics events to the console for visibility.

```pseudocode
// Enable in initialization
await analytics.initialize(providerType, config, {
  debug: process.env.NODE_ENV === "development"
})

// In wrapper:
track(event: string, properties?: EventProperties) {
  if (this.isDebug) {
    console.group(`[Analytics] ${event}`)
    console.log("Properties:", properties)
    console.log("Super Properties:", this.superProperties)
    console.groupEnd()
  }

  this.provider.track(event, properties)
}

identify(userId: string, traits: UserTraits) {
  if (this.isDebug) {
    console.group("[Analytics] identify")
    console.log("User ID:", userId)
    console.log("Traits:", traits)
    console.groupEnd()
  }

  this.provider.identify(userId, traits)
}

page(name: string, properties?: PageProperties) {
  if (this.isDebug) {
    console.group(`[Analytics] page: ${name}`)
    console.log("Properties:", properties)
    console.groupEnd()
  }

  this.provider.page(name, properties)
}
```

## Environment Variables

Analytics uses a naming convention of `ANALYTICS_{CONTEXT}_{FIELD}` to support multiple contexts:

```bash
# --- App analytics (authenticated product) ---
ANALYTICS_APP_PROVIDER=posthog          # posthog, mixpanel, amplitude, ga4, noop
ANALYTICS_APP_API_KEY=phc_xxxxxxxxxxxx
ANALYTICS_APP_API_HOST=https://posthog.example.com  # optional, for self-hosted PostHog

# --- Landing / marketing analytics (public pages) ---
ANALYTICS_LANDING_PROVIDER=ga4          # GA4 for Google Ads / Search Console integration
ANALYTICS_LANDING_MEASUREMENT_ID=G-XXXXXXXXXX
ANALYTICS_LANDING_API_KEY=              # GA4 Measurement Protocol secret (server-side only)

# --- Add more contexts as needed ---
# ANALYTICS_BLOG_PROVIDER=ga4
# ANALYTICS_BLOG_MEASUREMENT_ID=G-YYYYYYYYYY

# --- Global settings ---
APP_NAME=MyApp
APP_VERSION=1.2.3
NODE_ENV=production
ANALYTICS_DEBUG=false
ANALYTICS_REQUIRE_CONSENT=true
```

### Auto-Discovery of Contexts

```pseudocode
function findUniqueContextPrefixes(env, basePrefix) {
  // Scan all env var keys matching ANALYTICS_*_PROVIDER
  // Extract the context name from the middle segment
  // e.g., ANALYTICS_APP_PROVIDER → "app", ANALYTICS_LANDING_PROVIDER → "landing"
  contexts = []
  for key in env:
    if key.startsWith(basePrefix) and key.endsWith("_PROVIDER"):
      middle = key.replace(basePrefix, "").replace("_PROVIDER", "")
      contexts.push(middle.toLowerCase())
  return unique(contexts)
}
```

## Gotchas and Common Pitfalls

### 1. Double-Tracking on SSR + Hydration

**Problem**: Events are tracked both server-side during rendering and client-side on hydration, resulting in duplicate events.

**Solution**:
- Only track client-side page views; don't track on server-side rendering.
- Track user-initiated events (clicks, form submits) only on the client.
- Use server-side tracking only for business events (API calls, webhooks, jobs).

```pseudocode
// Server-side rendering: skip tracking
if (isSSR) {
  // Don't call analytics.page() or analytics.track()
}

// Client-side hydration: track page views
if (isClient && isHydrated) {
  analytics.page(currentRoute.name)
}
```

### 2. Identifying Before Tracking

**Problem**: If you call `track()` before `identify()`, events won't be associated with the user.

**Solution**: Always ensure the user is identified before tracking. On app load, check auth status:

```pseudocode
if (isUserLoggedIn()) {
  analytics.identify(user.id, userTraits)
}

// Now tracking will be associated with the user
analytics.page("dashboard")
analytics.track("feature.used")
```

### 3. PII in Event Properties

**Problem**: Accidentally sending PII (passwords, credit cards, SSNs) in event properties exposes sensitive data.

**Solution**: Explicitly audit events and sanitize properties:

```pseudocode
// BAD: includes password
analytics.track("user.signup", {
  email: user.email,
  password: user.password // DON'T DO THIS
})

// GOOD: only non-sensitive data
analytics.track("user.signup", {
  email: user.email,
  plan: user.plan
})

// BAD: includes full card number
analytics.track("payment.succeeded", {
  card_number: "4111-1111-1111-1111" // DON'T DO THIS
})

// GOOD: masked or omitted
analytics.track("payment.succeeded", {
  processor: "stripe",
  amount_cents: 9999,
  card_last_four: "1111" // only last 4 digits
})
```

### 4. Ad Blockers and Content Security Policy

**Problem**: Ad blockers may block analytics scripts or requests, leading to missing events. CSP restrictions may prevent analytics SDK from loading.

**Solution**:
- Use self-hosted analytics (PostHog) to avoid third-party blocking.
- Configure CSP headers to allow analytics domains.
- Gracefully degrade if analytics fails to load; don't break app functionality.

```pseudocode
async function initializeAnalytics() {
  try {
    const analytics = getAnalytics()
    await analytics.initialize(...)
  } catch (error) {
    console.error("[Analytics] Failed to initialize:", error)
    // App still works, just without tracking
  }
}
```

### 5. Consent-Related Race Conditions

**Problem**: User consents to analytics, but events are tracked before the consent state is updated, or consent state is checked inconsistently.

**Solution**: Ensure consent is checked synchronously and consistently:

```pseudocode
// In consent manager
let consentState = {
  analytics: false
}

function updateConsent(newConsent) {
  consentState = newConsent
  notifyListeners(consentState) // notify analytics wrapper
}

// In analytics wrapper
function canTrack() {
  // Always check current state
  return consentManager.hasConsentedToAnalytics()
}
```

### 6. Missing User Context in Server-Side Events

**Problem**: Server-side events (API routes, webhooks) don't have user context, making it hard to attribute events.

**Solution**: Always extract user ID from auth context or request payload:

```pseudocode
async function handleApiRoute(request) {
  const user = request.user || getCurrentUser(request) // from auth middleware
  const userId = user?.id

  if (!userId) {
    console.warn("[Analytics] Cannot track: no user context")
    return
  }

  analytics.track("api.called", {
    user_id: userId,
    endpoint: request.path,
    status_code: 200
  })
}
```

### 7. Flushing Events Before Page Unload

**Problem**: Events tracked just before page unload (navigation, tab close) may not be sent before the page is destroyed.

**Solution**: Flush events before navigation and on unload:

```pseudocode
// Before navigation
router.beforeEach((to, from, next) => {
  getAnalytics().flush()
  next()
})

// On page unload
window.addEventListener("beforeunload", () => {
  getAnalytics().flush()
})

// On logout
async function logout() {
  analytics.track("user.logged_out")
  await analytics.flush() // wait for flush before navigating
  navigateTo("/login")
}
```

### 8. Event Property Size Limits

**Problem**: Some analytics providers have limits on event payload sizes or property counts. Oversized events are silently dropped or rejected.

**Solution**: Keep events lean; avoid large objects or arrays in properties:

```pseudocode
// BAD: massive properties object
analytics.track("order.created", {
  user_id: user.id,
  items: user.cart.items.map(item => ({ // array of 100+ items
    id: item.id,
    name: item.name,
    description: item.description,
    // ...
  })),
  full_user_object: user // entire user object
})

// GOOD: aggregated properties
analytics.track("order.created", {
  user_id: user.id,
  item_count: user.cart.items.length,
  total_price_cents: user.cart.totalPriceCents,
  categories: user.cart.items.map(i => i.category) // only what you need
})
```

### 9. Session ID Uniqueness

**Problem**: Session IDs collide or are reused, making it impossible to correlate events within a session.

**Solution**: Generate a unique session ID on app load and persist it:

```pseudocode
function initializeSession() {
  let sessionId = sessionStorage.getItem("sessionId")

  if (!sessionId) {
    sessionId = generateUUID()
    sessionStorage.setItem("sessionId", sessionId)
  }

  analytics.setSuperProperties({
    session_id: sessionId
  })
}
```

### 10. Analytics Not Respecting Locale / Timezone

**Problem**: Events don't include locale or timezone info, making it hard to analyze regional data.

**Solution**: Include locale and timezone in super properties:

```pseudocode
analytics.setSuperProperties({
  locale: navigator.language || "en-US",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  utc_offset_hours: new Date().getTimezoneOffset() / -60
})
```
