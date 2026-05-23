---
name: Rendering & Routing
description: Per-section rendering strategy (SSR/SSG/SPA), shared layouts across rendering modes, and route configuration conventions
type: project
---

# Rendering & Routing

## Overview

This recipe defines a unified routing and rendering architecture for apps that mix server-side rendering (SSR), static generation (SSG), and client-side rendering (SPA) within a single codebase. A single app instance can have SSR marketing pages alongside SPA dashboard pages, with shared layouts that work correctly across all rendering modes.

**Core principle**: Rendering mode is a per-route decision, not a per-app decision. Each section declares its rendering strategy independently, and the layout system adapts automatically.

---

## Route Configuration Convention

Every route declares its rendering and auth configuration through a **route config object** or metadata. This config is the single source of truth for how a route should be rendered and protected.

### Route Config Schema

```
RouteConfig {
  // Rendering mode for this route
  render: "ssr" | "ssg" | "spa"

  // Authentication requirement
  auth: "public" | "user" | "admin"

  // Which layout group this route belongs to
  // Layout groups share error boundaries, loading states, and context
  layoutGroup: string

  // Cache control for SSR/SSG
  cache: {
    // Browser cache TTL in seconds
    browser: number | "no-cache"
    // CDN/server cache TTL in seconds
    cdn: number | "no-cache"
    // Revalidation strategy for SSG
    revalidate: number | "on-demand" | "never"
  }

  // SEO metadata
  seo: {
    title: string
    description: string
    canonical?: string
  }

  // Optional: path parameters that can trigger revalidation
  revalidateOn?: string[]
}
```

### Convention: Where Route Config Lives

Route configs are declared **alongside route files** in a consistent location:

**File structure**:
```
routes/
  marketing/
    home.config.ts       # Metadata for /
    home.tsx            # Route component
  dashboard/
    overview.config.ts   # Metadata for /dashboard
    overview.tsx        # Route component
    [userId]/
      profile.config.ts  # Metadata for /dashboard/[userId]
      profile.tsx       # Route component
```

**Alternative**: If your framework supports route metadata decorators or frontmatter, embed config at the top of the component file:

```
/**
 * @route {
 *   render: "ssr",
 *   auth: "user",
 *   layoutGroup: "dashboard"
 * }
 */
export default function DashboardPage() { ... }
```

### Config Loading

The build system or route registry **loads all `.config.ts` files** at startup and makes them available to:
- The request handler (to decide SSR vs. SPA)
- The client (to prefetch and optimize navigation)
- The build system (to generate static routes)

```pseudocode
// Pseudo-implementation
function loadRouteConfigs(routesDir: string): Map<string, RouteConfig> {
  let configs = new Map()
  for each file matching "**/*.config.ts" in routesDir:
    let route = pathToRoute(file.path)
    let config = import(file).default
    configs.set(route, config)
  return configs
}
```

---

## Layout Architecture

Layouts compose vertically: **root layout** → **section layout** → **page component**. Each layout is independent and does not re-render when child routes change.

### Root Layout

The root layout wraps every page. It is **always rendered on the server** (for SSR routes) or **hydrated once on the client** (for SPA routes).

```pseudocode
// RootLayout: rendered server-side or hydrated once
// MUST NOT access window/document during initial render
export function RootLayout({ children, context }) {
  let theme = context.theme // From server context
  let user = context.user    // From server context

  return (
    <html>
      <head>
        <meta charset="utf-8" />
        <ThemeTag value={theme} />
      </head>
      <body>
        {/* Global providers: must be hydration-safe */}
        <UserProvider initialUser={user}>
          <ThemeProvider initialTheme={theme}>
            {/* Shared error boundary for all routes */}
            <ErrorBoundary layoutGroup="root">
              {children}
            </ErrorBoundary>
          </ThemeProvider>
        </UserProvider>
      </body>
    </html>
  )
}
```

**Hydration safety checklist**:
- ✓ All initial state comes from props (server context)
- ✓ No `window` or `document` access during render
- ✓ `useEffect` for client-only initialization
- ✓ No randomness or timestamps in initial render

### Section Layouts

Section layouts (e.g., marketing, dashboard, admin) are rendered/hydrated within the root layout. They can be **SSR, SSG, or SPA**, and they group routes that share error boundaries, auth checks, and context.

```pseudocode
// DashboardLayout: SSR/SPA for dashboard routes
export function DashboardLayout({ children, context, renderMode }) {
  // Section-level state/context
  let user = context.user

  // SSR can check auth and redirect; SPA does this in useEffect
  if (renderMode === "ssr" && !user?.authenticated) {
    return redirectResponse("/login")
  }

  return (
    <DashboardProvider initialUser={user}>
      <ErrorBoundary layoutGroup="dashboard">
        <Sidebar user={user} />
        <main>
          {children}
        </main>
      </ErrorBoundary>
    </DashboardProvider>
  )
}
```

### Layout Composition Rules

1. **Layouts are scoped to `layoutGroup`**: Only routes in the same layout group share a layout instance.
2. **Layout props are immutable during page transition**: Navigating from `/dashboard/overview` to `/dashboard/profile` re-renders the page, not the layout.
3. **Nested layouts compose vertically**: A route matches `RootLayout` → `DashboardLayout` → `ProfilePage`.
4. **Layout context is available to all children**: Providers in a layout are available to all nested routes in that group.

---

## Hydration Safety

Hydration mismatches occur when the server renders different HTML than the client expects. This is the **most common gotcha** in mixed-mode rendering.

### Common Pitfalls & Solutions

#### 1. Window/Document Access During Render

**Gotcha**: Server doesn't have `window`, so accessing it during render creates a mismatch.

```pseudocode
// ❌ WRONG: Server-side render differs from client
function Component() {
  let isClient = typeof window !== "undefined"
  return <div>{isClient ? "Client" : "Server"}</div>
}
// Server renders: <div>Server</div>
// Client renders: <div>Client</div>
// Hydration mismatch!

// ✓ CORRECT: Use useEffect for client-only code
function Component() {
  let [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) {
    return <div>Loading...</div> // Matches server render
  }

  return <div>Client</div>
}
```

#### 2. Date & Time Formatting

**Gotcha**: Server renders with server time, client renders with client time (different timezones).

```pseudocode
// ❌ WRONG: Time differs between server and client
function PostDate({ createdAt }) {
  return <time>{new Date(createdAt).toLocaleString()}</time>
}

// ✓ CORRECT: Format on server, pass as string
function PostDate({ createdAt, formattedDate }) {
  // formattedDate is from server, no re-format on client
  return <time dateTime={createdAt}>{formattedDate}</time>
}

// On server:
let formattedDate = new Date(createdAt).toLocaleString()
return renderPage(PostDate, { createdAt, formattedDate })
```

#### 3. Randomness & Unique IDs

**Gotcha**: Math.random() or UUID generation during render differs between server and client.

```pseudocode
// ❌ WRONG: ID differs on server and client
function RandomID() {
  let id = Math.random().toString(36)
  return <div id={id}>{id}</div>
}

// ✓ CORRECT: Generate ID on server, pass as prop
function RandomID({ id }) {
  return <div id={id}>{id}</div>
}

// On server:
let id = generateUUID()
return renderPage(RandomID, { id })
```

#### 4. Conditional Rendering Based on Client State

**Gotcha**: Showing/hiding elements based on client-only state during render.

```pseudocode
// ❌ WRONG: useMediaQuery hook might return different value on server vs. client
function ResponsiveLayout() {
  let isMobile = useMediaQuery("(max-width: 768px)")
  return isMobile ? <MobileLayout /> : <DesktopLayout />
}

// ✓ CORRECT: Server renders default, client hydrates and updates
function ResponsiveLayout() {
  let [isMobile, setIsMobile] = useState(false) // Default

  useEffect(() => {
    let mediaQuery = window.matchMedia("(max-width: 768px)")
    setIsMobile(mediaQuery.matches)

    // Listen for changes
    let listener = (e) => setIsMobile(e.matches)
    mediaQuery.addListener(listener)
    return () => mediaQuery.removeListener(listener)
  }, [])

  return isMobile ? <MobileLayout /> : <DesktopLayout />
}
```

### Hydration Safety Checklist

- [ ] All initial render output is determined by **props only**, not client state
- [ ] No `window` or `document` during render phase
- [ ] No randomness, UUIDs, or timestamps generated during render
- [ ] Conditional rendering that depends on client state uses `useState` + `useEffect`
- [ ] All data from server is passed as props, not fetched on client during initial render
- [ ] Theme/locale values are set via context providers with server-provided initial values

---

## Navigation Patterns

Navigation must work correctly across rendering modes. A navigation action should:
- **SSR routes**: Trigger a server request that renders new HTML
- **SPA routes**: Update client state and replace history without a full page reload
- **Mixed**: Intelligently transition between rendering modes

### Universal Navigation API

```pseudocode
interface Navigator {
  // Navigate to a route
  navigate(path: string, options?: NavigateOptions): void

  // Replace current history entry
  replace(path: string, options?: NavigateOptions): void

  // Go back
  back(): void

  // Go forward
  forward(): void

  // Check if a route can be navigated to (for prefetching, disabling links, etc.)
  canNavigate(path: string): boolean

  // Get current route
  currentRoute(): string
}

interface NavigateOptions {
  // Replace vs push to history
  replace?: boolean

  // Pass state through navigation (client-side only)
  state?: object

  // For programmatic navigation: should we scroll to top?
  scroll?: boolean | ScrollOptions

  // Prefetch data before navigation (SPA only)
  prefetch?: boolean
}
```

### Universal Navigation Component

```pseudocode
// Link component works in both SSR and SPA
export function Link({
  href,
  children,
  disabled = false,
  prefetch = true,
  ...attrs
}) {
  let nav = useNavigator()
  let renderMode = useRenderMode() // "ssr" | "sga" | "spa"

  // On SSR: render as <a href> for crawlers
  if (renderMode === "ssr" && !hasBeenHydrated()) {
    return <a href={href} {...attrs}>{children}</a>
  }

  // On SPA: intercept clicks and navigate client-side
  function handleClick(e) {
    if (disabled || isModifiedClick(e)) {
      return // Let browser handle it
    }
    e.preventDefault()
    nav.navigate(href)
  }

  // Prefetch data for SPA routes
  function handleMouseEnter() {
    if (renderMode === "spa" && prefetch) {
      prefetchData(href)
    }
  }

  return (
    <a
      href={href}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      aria-disabled={disabled}
      {...attrs}
    >
      {children}
    </a>
  )
}

function isModifiedClick(e: MouseEvent): boolean {
  return e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.button !== 0
}
```

### Programmatic Navigation

```pseudocode
// In a component
function LoginForm() {
  let nav = useNavigator()
  let [submitting, setSubmitting] = useState(false)

  async function handleSubmit(formData) {
    setSubmitting(true)
    let result = await loginUser(formData)

    if (result.success) {
      // Navigate after successful login
      // SPA: updates state and route immediately
      // SSR: server redirects on next request
      nav.navigate("/dashboard", {
        replace: true, // Don't show login in back button
        scroll: true   // Scroll to top of new page
      })
    }

    setSubmitting(false)
  }

  return <form onSubmit={handleSubmit}>...</form>
}
```

### Deep Linking

Deep links (web URLs and native app links) must resolve to the same route tree.

```pseudocode
// Route tree is source of truth
const ROUTE_TREE = {
  "/": {
    layoutGroup: "marketing",
    render: "ssr"
  },
  "/dashboard": {
    layoutGroup: "dashboard",
    render: "ssa" (SPA)
  },
  "/dashboard/users/:userId": {
    layoutGroup: "dashboard",
    render: "spa"
  },
  "/admin": {
    layoutGroup: "admin",
    render: "ssr",
    auth: "admin"
  }
}

// Deep link handler (works on web and native)
function resolveDeepLink(url: string | Route) {
  let path = typeof url === "string" ? parseURL(url).pathname : url.path
  let config = ROUTE_TREE[path]

  if (!config) {
    return null // Route not found
  }

  // On web: navigate using Navigator
  // On native: open appropriate screen
  return config
}

// Native deep link example:
// myapp://dashboard/users/123 → resolves to /dashboard/users/123 → same route
```

---

## Loading & Error States Per Rendering Mode

Different rendering modes handle loading and errors differently.

### SSR: Server-Rendered Loading States

SSR routes render completely on the server, so "loading" means waiting for the server response.

```pseudocode
// SSR route: show loading skeleton while server fetches data
export async function getServerData(context) {
  // Server fetches all data before rendering
  let data = await fetchUserData(context.userId)

  if (!data) {
    return { notFound: true } // 404 response
  }

  return { props: { data } }
}

export default function UserProfileSSR({ data }) {
  // Page is rendered with data already present
  return (
    <div>
      <h1>{data.name}</h1>
      <p>{data.bio}</p>
    </div>
  )
}

// If server is slow, show skeleton to user immediately
// (This is typically handled at the framework level)
export function Skeleton() {
  return (
    <div>
      <SkeletonText width="200px" />
      <SkeletonText width="400px" />
    </div>
  )
}
```

### SPA: Client-Side Loading States

SPA routes load data on the client after initial render.

```pseudocode
export default function UserProfileSPA({ userId }) {
  let [data, setData] = useState(null)
  let [loading, setLoading] = useState(true)
  let [error, setError] = useState(null)

  useEffect(() => {
    setLoading(true)

    fetchUserData(userId)
      .then(data => {
        setData(data)
        setLoading(false)
      })
      .catch(err => {
        setError(err)
        setLoading(false)
      })
  }, [userId])

  if (loading) {
    return <LoadingSkeleton />
  }

  if (error) {
    return <ErrorFallback error={error} />
  }

  return (
    <div>
      <h1>{data.name}</h1>
      <p>{data.bio}</p>
    </div>
  )
}
```

### Hybrid: SSR Shell + SPA Updates

Some pages render static content on the server, then hydrate dynamic content on the client.

```pseudocode
export async function getServerData(context) {
  // Fetch only critical data on server
  let staticContent = await fetchStaticContent()

  // Don't fetch user interactions here; load them on client
  return { props: { staticContent } }
}

export default function HybridPage({ staticContent }) {
  let [interactions, setInteractions] = useState(null)
  let [loading, setLoading] = useState(true)

  // Fetch secondary data on client
  useEffect(() => {
    fetchUserInteractions()
      .then(data => {
        setInteractions(data)
        setLoading(false)
      })
  }, [])

  return (
    <div>
      {/* Rendered on server, shows immediately */}
      <article>{staticContent.body}</article>

      {/* Rendered on client, shows after hydration */}
      {loading ? (
        <LoadingSkeleton />
      ) : (
        <InteractionPanel data={interactions} />
      )}
    </div>
  )
}
```

### Error Boundaries Per Layout Group

Error boundaries catch errors in a layout group and prevent the entire app from crashing.

```pseudocode
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    // Log error, send to monitoring service
    reportError(error, errorInfo, this.props.layoutGroup)
  }

  render() {
    if (this.state.hasError) {
      // Render error UI for this layout group
      // Other layout groups are unaffected
      return (
        <ErrorPage
          layoutGroup={this.props.layoutGroup}
          error={this.state.error}
        />
      )
    }

    return this.props.children
  }
}

// In layout:
export function DashboardLayout({ children }) {
  return (
    <ErrorBoundary layoutGroup="dashboard">
      {children}
    </ErrorBoundary>
  )
}
```

---

## Route Guards (Auth Checks)

Route guards enforce authentication/authorization. They work differently on SSR vs. SPA.

### SSR Route Guards

On SSR, auth checks happen on the server before rendering.

```pseudocode
// Middleware runs on every request
export async function authMiddleware(request, response, next) {
  let token = request.cookies.get("auth_token")
  let user = token ? await verifyToken(token) : null

  // Attach user to request context
  request.context = { user }

  next()
}

// In SSR route handler
export async function getServerData(context) {
  let config = ROUTE_CONFIG[context.path]

  // Check auth requirement
  if (config.auth === "user" && !context.user) {
    return { redirect: "/login" }
  }

  if (config.auth === "admin" && context.user?.role !== "admin") {
    return { statusCode: 403 }
  }

  // Auth passed, fetch data and render
  let data = await fetchProtectedData(context.user)
  return { props: { data } }
}
```

### SPA Route Guards

On SPA, auth checks happen on the client in a router guard or layout effect.

```pseudocode
// Route guard hook
export function useAuthGuard(requiredAuth: "public" | "user" | "admin") {
  let [authorized, setAuthorized] = useState(false)
  let [loading, setLoading] = useState(true)
  let user = useUser()
  let nav = useNavigator()

  useEffect(() => {
    // Check auth requirement
    let isAuthorized = requiredAuth === "public"

    if (requiredAuth === "user") {
      isAuthorized = !!user?.authenticated
    }

    if (requiredAuth === "admin") {
      isAuthorized = user?.role === "admin"
    }

    if (!isAuthorized) {
      // Redirect to login
      nav.navigate("/login")
      return
    }

    setAuthorized(true)
    setLoading(false)
  }, [user, requiredAuth, nav])

  return { authorized, loading }
}

// In SPA route
export default function AdminPage() {
  let { authorized, loading } = useAuthGuard("admin")

  if (loading) {
    return <LoadingSpinner />
  }

  if (!authorized) {
    return null // useAuthGuard redirected us
  }

  return <AdminContent />
}
```

### Hybrid Guard

For routes that render on both server and client, apply guards in both places.

```pseudocode
// Server-side guard
export async function getServerData(context) {
  if (context.path === "/dashboard" && !context.user) {
    return { redirect: "/login" }
  }
  return { props: { user: context.user } }
}

// Client-side guard (for SPA navigation)
export default function Dashboard({ user }) {
  let { authorized } = useAuthGuard("user")

  if (!authorized) {
    return null
  }

  return <DashboardContent user={user} />
}
```

---

## Gotchas & Edge Cases

### 1. Hydration Mismatch on Timezone-Dependent Content

**Problem**: Server renders time in server timezone, client renders in user timezone.

```pseudocode
// ❌ Mismatch
function EventTime({ eventTime }) {
  return <div>{eventTime.toLocaleString()}</div>
}

// ✓ Solution: Format on server, pass string
function EventTime({ eventTime, formattedTime }) {
  return <div>{formattedTime}</div>
}

// On server:
let formattedTime = formatTimeForUser(eventTime, userTimezone)
render(EventTime, { eventTime, formattedTime })
```

### 2. router.replace() vs window.location

**Problem**: `router.replace()` on SPA doesn't work like `window.location` on SSR.

```pseudocode
// ❌ Inconsistent behavior
if (someCondition) {
  window.location = "/redirect-path" // Full page reload
}

// ✓ Consistent: use Navigator
let nav = useNavigator()
if (someCondition) {
  nav.replace("/redirect-path") // Works on SPA and SSR
}
```

### 3. SEO Impact of SPA Routes

**Problem**: SPA routes render empty shell on server, crawlers may not see content.

```pseudocode
// For SPA routes that need SEO:
// Option 1: Use SSR for initial render, SPA for interactions
render: "ssr" // Not "spa"

// Option 2: Pre-render on build time (SSG)
render: "ssg"

// Option 3: For SPA routes, provide canonical meta tags and sitemap
export function SPAPage() {
  return (
    <head>
      <meta name="robots" content="noindex" /> // Tell crawlers this is JS-rendered
      <link rel="canonical" href={canonicalURL} />
    </head>
  )
}
```

### 4. Data Refetching on Navigation

**Problem**: Navigating between similar SPA pages doesn't refetch data.

```pseudocode
// ❌ Data not refetched on route param change
function UserProfile({ userId }) {
  let [user, setUser] = useState(null)

  useEffect(() => {
    fetchUser(userId).then(setUser)
  }, []) // Missing userId dependency!
}

// ✓ Refetch when route param changes
function UserProfile({ userId }) {
  let [user, setUser] = useState(null)

  useEffect(() => {
    fetchUser(userId).then(setUser)
  }, [userId]) // Include userId in dependencies
}
```

### 5. Flash of Wrong Content on SPA Transitions

**Problem**: Old content flashes briefly before new content loads.

```pseudocode
// ❌ Flash of old content
function SwitchContent({ id }) {
  let [content, setContent] = useState(initialContent)

  useEffect(() => {
    fetchContent(id).then(setContent)
  }, [id])

  return <div>{content}</div> // Shows old content until fetch completes
}

// ✓ Clear state on navigation to show loading state
function SwitchContent({ id }) {
  let [content, setContent] = useState(null)

  useEffect(() => {
    setContent(null) // Clear on route change
    fetchContent(id).then(setContent)
  }, [id])

  return content ? <div>{content}</div> : <LoadingSkeleton />
}
```

### 6. Browser History & Back Button Behavior

**Problem**: SPA routes don't respect browser history correctly.

```pseudocode
// Router must properly manage browser history
// - On SPA navigation: call history.pushState() or framework equivalent
// - On back/forward: restore state without fetching
// - On refresh: maintain current route

export function Navigator {
  navigate(path, { replace = false } = {}) {
    // Update router state
    this.currentPath = path

    // Update browser history
    if (replace) {
      window.history.replaceState({ path }, "", path)
    } else {
      window.history.pushState({ path }, "", path)
    }

    // Render new route
    this.render()
  }

  // Handle browser back/forward
  window.addEventListener("popstate", (e) => {
    this.currentPath = e.state?.path
    this.render() // Re-render without navigation animation
  })
}
```

### 7. SSG Revalidation & Cache Invalidation

**Problem**: SSG pages are stale until revalidation runs.

```pseudocode
// Route config declares revalidation strategy
{
  render: "ssg",
  cache: {
    revalidate: 3600 // Revalidate every hour
  },
  revalidateOn: ["productId"] // Revalidate when productId changes
}

// On-demand revalidation (e.g., when content changes)
export async function onContentUpdate(productId) {
  // Tell build system to revalidate specific routes
  await revalidateRoute(`/products/${productId}`)
}
```

---

## Summary: Rendering & Routing Checklist

- [ ] **Route config**: Every route declares `render`, `auth`, `layoutGroup`, and `cache`
- [ ] **Shared layouts**: Root + section layouts work across all rendering modes
- [ ] **Hydration safety**: No `window`, consistent initial render, server context in props
- [ ] **Navigation**: Use Navigator API, not `window.location`
- [ ] **Loading states**: SSR shows server content, SPA shows skeleton, hybrid shows partial
- [ ] **Error boundaries**: Per layout group, prevents cascading failures
- [ ] **Auth guards**: Server-side for SSR, client-side for SPA, both for hybrid
- [ ] **Deep linking**: Route tree is source of truth for web and native
- [ ] **SEO**: SSR/SSG for crawled content, SPA for interactive dashboards
- [ ] **History management**: SPA respects back/forward, SSR uses standard links
