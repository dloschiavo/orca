---
name: Rendering Enhancements
description: Loading/skeleton states per rendering mode, deep linking for native and web, auth-gated redirects
type: enhancement
requires: recipes/rendering-routing.md, recipes/otp.md
env_vars: ENABLE_SKELETON_SHIMMER (boolean, default: true), DEEP_LINK_REDIRECT_TIMEOUT (integer, default: 5000)
---

# Rendering Enhancements

## Overview

Enhance rendering across SSR, SSG, and SPA modes with:
1. **Loading/Skeleton States** — Context-aware skeleton screens that match actual layout dimensions, prevent layout shift, and handle errors
2. **Deep Linking (Native + Web)** — Universal links (iOS), App Links (Android), and web URL mapping; deferred deep links for users without the app
3. **Auth-Gated Deep Links** — Redirect unauthenticated users to login, then to the intended destination after auth succeeds

---

## Part 1: Loading & Skeleton States

### Overview

Skeleton screens provide visual feedback while content loads. Different rendering modes show skeletons differently:
- **SSR**: Server renders full page; skeleton only for client-fetched data within the page (e.g., secondary content)
- **SPA**: Initial load shows full-page skeleton; route transitions show partial skeletons for new content
- **SSG**: Pre-rendered content shows immediately; secondary data fetches show skeleton

Skeletons must:
- Match actual layout dimensions to prevent layout shift (Cumulative Layout Shift = 0)
- Have consistent animation (shimmer effect)
- Support multiple content types (list, card, profile, table, form)
- Fall back to error state if data fetch fails

### Data Model: Skeleton Configuration

```
SkeletonConfig {
  id:               string (unique identifier)
  name:             string (e.g., "UserCardSkeleton", "ProductListSkeleton")
  type:             "list" | "card" | "profile" | "table" | "form" | "custom"

  // Layout dimensions (must match actual content)
  width:            string (e.g., "100%", "400px")
  height:           string (e.g., "200px")
  gap:              integer (pixels between items, for list/table)

  // Shimmer animation
  shimmerEnabled:   boolean (default: true)
  shimmerColor:     string (hex color or CSS var)
  shimmerSpeed:     integer (milliseconds, default: 1500)

  // Items configuration
  itemCount:        integer (how many skeleton items to show)
  itemHeight:       string (height per item, for list/table)
  itemWidth:        string (width per item)

  // Error state fallback
  errorFallback:    "text" | "icon" | "button" (what to show if data fails)
  errorMessage:     string (custom error text)

  // Visibility control
  minimumLoadTime:  integer (ms; keep skeleton visible for at least this long)
  showImmediately:  boolean (show skeleton before first render)
}
```

Example configurations:

```pseudocode
SkeletonConfig CARD_SKELETON = {
  type: "card",
  width: "100%",
  height: "280px",
  shimmerEnabled: true,
  shimmerColor: "#e0e0e0",
  shimmerSpeed: 1500,
  itemCount: 1,
  errorFallback: "icon",
  minimumLoadTime: 300,
  showImmediately: true
}

SkeletonConfig LIST_SKELETON = {
  type: "list",
  width: "100%",
  height: "auto",
  gap: 12,
  shimmerEnabled: true,
  shimmerSpeed: 1500,
  itemCount: 5,
  itemHeight: "60px",
  itemWidth: "100%",
  errorFallback: "text",
  errorMessage: "Failed to load items. Please try again.",
  minimumLoadTime: 500,
  showImmediately: true
}

SkeletonConfig PROFILE_SKELETON = {
  type: "profile",
  width: "100%",
  height: "400px",
  shimmerEnabled: true,
  shimmerSpeed: 1500,
  itemCount: 1,
  errorFallback: "button",
  minimumLoadTime: 400
}

SkeletonConfig TABLE_SKELETON = {
  type: "table",
  width: "100%",
  height: "auto",
  gap: 0,
  shimmerEnabled: true,
  itemCount: 10,
  itemHeight: "40px",
  itemWidth: "100%",
  minimumLoadTime: 600
}

SkeletonConfig FORM_SKELETON = {
  type: "form",
  width: "100%",
  height: "auto",
  gap: 16,
  shimmerEnabled: true,
  itemCount: 4,  // 4 form fields
  itemHeight: "48px",
  itemWidth: "100%",
  minimumLoadTime: 200
}
```

### API Routes

#### GET `/api/skeleton-config/:type`

Retrieve skeleton config by type (or list all available configs).

**Response:**
```
{
  skeletons: [
    {
      type: "card",
      width: "100%",
      height: "280px",
      shimmerEnabled: true,
      shimmerColor: "#e0e0e0",
      shimmerSpeed: 1500,
      ...
    },
    ...
  ]
}
```

### Component Implementation

#### Universal Skeleton Component

Works across SSR, SSG, and SPA:

```pseudocode
component Skeleton({
  type: "card" | "list" | "profile" | "table" | "form" | "custom",
  count: integer = 1,
  width: string = "100%",
  height: string,
  gap: integer = 0,
  shimmerEnabled: boolean = true,
  shimmerColor: string = "#e0e0e0",
  minimumLoadTime: integer = 300,
  errorState: boolean = false,
  errorMessage: string = null,
  children: ReactNode = null
}) {

  let [isVisible, setIsVisible] = useState(true)
  let minimumLoadTimeRef = useRef(null)

  // Enforce minimum load time before hiding skeleton
  useEffect(() => {
    minimumLoadTimeRef.current = setTimeout(() => {
      // Skeleton can be hidden after minimum time
    }, minimumLoadTime)

    return () => clearTimeout(minimumLoadTimeRef.current)
  }, [minimumLoadTime])

  // Determine what to render
  if (errorState) {
    return (
      <ErrorFallback
        type={type}
        message={errorMessage}
      />
    )
  }

  // If custom content provided (post-load), hide skeleton
  if (children && !isVisible) {
    return children
  }

  // Render skeleton
  return (
    <div
      class="skeleton-container"
      style={{
        width: width,
        height: height,
        gap: `${gap}px`,
        display: type === "list" ? "flex" : "block",
        flexDirection: type === "list" ? "column" : undefined
      }}
    >
      {renderSkeletonItems(type, count, shimmerEnabled, shimmerColor)}
    </div>
  )
}

// Shimmer animation CSS
@keyframes shimmer {
  0% {
    backgroundPosition: -1000px 0
  }
  100% {
    backgroundPosition: 1000px 0
  }
}

.skeleton-item {
  background: linear-gradient(
    90deg,
    {shimmerColor} 25%,
    rgba(255,255,255,0.2) 50%,
    {shimmerColor} 75%
  )
  backgroundSize: 1000px 100%

  if (shimmerEnabled) {
    animation: shimmer 1.5s infinite
  }
}

function renderSkeletonItems(type, count, shimmerEnabled, shimmerColor) {
  if (type === "list") {
    return Array(count).fill(0).map((_, i) => (
      <div key={i} class="skeleton-item skeleton-list-item" />
    ))
  }

  if (type === "card") {
    return (
      <div class="skeleton-card">
        <div class="skeleton-item skeleton-card-image" />
        <div class="skeleton-item skeleton-card-title" />
        <div class="skeleton-item skeleton-card-text" />
      </div>
    )
  }

  if (type === "profile") {
    return (
      <div class="skeleton-profile">
        <div class="skeleton-item skeleton-avatar" />
        <div class="skeleton-item skeleton-profile-name" />
        <div class="skeleton-item skeleton-profile-bio" />
      </div>
    )
  }

  if (type === "table") {
    return (
      <div class="skeleton-table">
        <div class="skeleton-table-header">
          {Array(4).fill(0).map((_, i) => (
            <div key={i} class="skeleton-item skeleton-table-cell" />
          ))}
        </div>
        {Array(count).fill(0).map((_, row) => (
          <div key={row} class="skeleton-table-row">
            {Array(4).fill(0).map((_, col) => (
              <div key={col} class="skeleton-item skeleton-table-cell" />
            ))}
          </div>
        ))}
      </div>
    )
  }

  if (type === "form") {
    return (
      <div class="skeleton-form">
        {Array(count).fill(0).map((_, i) => (
          <div key={i} class="skeleton-form-field">
            <div class="skeleton-item skeleton-label" />
            <div class="skeleton-item skeleton-input" />
          </div>
        ))}
      </div>
    )
  }
}

component ErrorFallback({ type, message }) {
  return (
    <div class="skeleton-error">
      <Icon name="error" />
      <p>{message || "Failed to load content"}</p>
      <button onClick={() => window.location.reload()}>
        Retry
      </button>
    </div>
  )
}
```

#### Usage Examples

**SSR Page with Client-Fetched Secondary Content:**

```pseudocode
// Page rendered on server
export async function getServerData(context) {
  let primaryData = await fetchPrimaryContent()
  return { props: { primaryData } }
}

export function Page({ primaryData }) {
  let [secondaryData, setSecondaryData] = useState(null)
  let [loading, setLoading] = useState(true)
  let [error, setError] = useState(null)

  useEffect(() => {
    fetchSecondaryContent()
      .then(data => {
        setSecondaryData(data)
        setLoading(false)
      })
      .catch(err => {
        setError(err)
        setLoading(false)
      })
  }, [])

  return (
    <div>
      {/* Primary content (from server, no skeleton needed) */}
      <PrimaryContent data={primaryData} />

      {/* Secondary content (fetched on client, shows skeleton while loading) */}
      <div>
        {loading ? (
          <Skeleton type="list" count={5} minimumLoadTime={300} />
        ) : error ? (
          <Skeleton
            type="list"
            errorState={true}
            errorMessage="Could not load recommendations"
          />
        ) : (
          <SecondaryContent data={secondaryData} />
        )}
      </div>
    </div>
  )
}
```

**SPA Route with Full-Page Skeleton:**

```pseudocode
export function DashboardSPA() {
  let [data, setData] = useState(null)
  let [loading, setLoading] = useState(true)
  let [error, setError] = useState(null)

  useEffect(() => {
    fetchDashboardData()
      .then(data => {
        setData(data)
        setLoading(false)
      })
      .catch(err => {
        setError(err)
        setLoading(false)
      })
  }, [])

  if (loading) {
    return (
      <div class="dashboard-layout">
        <Skeleton type="card" width="100%" height="200px" />
        <Skeleton type="list" count={3} gap={16} minimumLoadTime={500} />
        <Skeleton type="table" count={10} gap={0} />
      </div>
    )
  }

  if (error) {
    return (
      <Skeleton
        type="card"
        errorState={true}
        errorMessage="Failed to load dashboard"
      />
    )
  }

  return <DashboardContent data={data} />
}
```

**Preventing Layout Shift:**

All skeleton dimensions must match actual content:

```pseudocode
component UserCardSkeleton() {
  return (
    <div style={{ width: "400px", height: "320px" }}>
      <Skeleton
        type="card"
        width="400px"
        height="320px"
        shimmerEnabled={true}
      />
    </div>
  )
}

component UserCard({ user }) {
  // MUST have same dimensions as skeleton
  return (
    <div style={{ width: "400px", height: "320px" }}>
      <img src={user.image} style={{ width: "100%", height: "200px" }} />
      <h3>{user.name}</h3>
      <p>{user.bio}</p>
    </div>
  )
}

// Usage
{isLoading ? <UserCardSkeleton /> : <UserCard user={user} />}
```

### Configuration Examples

#### Example 1: E-Commerce Product Listing

```pseudocode
// SSR page renders products on server
export async function getServerData(context) {
  let products = await fetchProducts()
  return { props: { products } }
}

export function ProductsPage({ products }) {
  let [relatedProducts, setRelatedProducts] = useState(null)
  let [loading, setLoading] = useState(true)

  useEffect(() => {
    // Fetch "related" products on client
    fetchRelatedProducts()
      .then(data => {
        setRelatedProducts(data)
        setLoading(false)
      })
  }, [])

  return (
    <div>
      {/* Rendered on server */}
      <ProductGrid products={products} />

      {/* Fetched on client */}
      <section>
        <h2>Related Products</h2>
        {loading ? (
          <Skeleton
            type="list"
            count={6}
            gap={16}
            minimumLoadTime={400}
            shimmerEnabled={true}
          />
        ) : (
          <ProductGrid products={relatedProducts} />
        )}
      </section>
    </div>
  )
}
```

#### Example 2: SPA Dashboard with Multiple Sections

```pseudocode
export function Dashboard() {
  let [stats, setStats] = useState(null)
  let [statsLoading, setStatsLoading] = useState(true)

  let [charts, setCharts] = useState(null)
  let [chartsLoading, setChartsLoading] = useState(true)

  let [table, setTable] = useState(null)
  let [tableLoading, setTableLoading] = useState(true)

  useEffect(() => {
    fetchStats().then(data => {
      setStats(data)
      setStatsLoading(false)
    })

    fetchCharts().then(data => {
      setCharts(data)
      setChartsLoading(false)
    })

    fetchTableData().then(data => {
      setTable(data)
      setTableLoading(false)
    })
  }, [])

  return (
    <div class="dashboard">
      {statsLoading ? (
        <Skeleton type="card" count={4} gap={16} height="150px" />
      ) : (
        <StatsGrid data={stats} />
      )}

      {chartsLoading ? (
        <Skeleton type="card" height="400px" />
      ) : (
        <ChartsPanel data={charts} />
      )}

      {tableLoading ? (
        <Skeleton type="table" count={15} />
      ) : (
        <DataTable data={table} />
      )}
    </div>
  )
}
```

---

## Part 2: Deep Linking (Native + Web)

### Overview

Deep links allow users to navigate directly to specific app screens via:
- **Web URLs**: `https://app.example.com/dashboard/users/123`
- **Native App Links** (Android): `https://app.example.com/dashboard/users/123` → opens Android app to that screen
- **Universal Links** (iOS): `https://app.example.com/dashboard/users/123` → opens iOS app to that screen
- **Deferred Deep Links**: User taps link but doesn't have app installed → shows web version, then prompts to install app, then opens correct screen

All links resolve to the same route tree (shared between web and native).

### Data Model: Route Configuration

Deep links require explicit route registration (see `rendering-routing.md` for full config):

```
DeepLinkConfig extends RouteConfig {
  // Base configuration (from rendering-routing.md)
  path:             string (e.g., "/dashboard/users/:userId")
  render:           "ssr" | "ssg" | "spa"
  auth:             "public" | "user" | "admin"
  layoutGroup:      string

  // Deep linking specifics
  deepLinkEnabled:  boolean (default: true)

  // Mobile app routing (maps web path to native screen)
  nativeScreen:     string (e.g., "UserProfile" in native code)
  nativeParams:     Map<string, string> (e.g., { userId: "id" })

  // Deferred deep link handling
  deferredDeepLink: {
    appStoreUrl:    string (iOS App Store link)
    playStoreUrl:   string (Google Play Store link)
    fallbackUrl:    string (if app not installed)
  }

  // Deep link sharing
  shareTitle:       string (title for social sharing)
  shareDescription: string (description for social sharing)
  shareImage:       string (image URL for social sharing)
}
```

Example configurations:

```pseudocode
DeepLinkConfig USER_PROFILE_CONFIG = {
  path: "/dashboard/users/:userId",
  render: "spa",
  auth: "user",
  layoutGroup: "dashboard",
  deepLinkEnabled: true,

  nativeScreen: "UserProfile",
  nativeParams: {
    userId: "id"
  },

  deferredDeepLink: {
    appStoreUrl: "https://apps.apple.com/app/myapp",
    playStoreUrl: "https://play.google.com/store/apps/details?id=com.myapp",
    fallbackUrl: "https://app.example.com/dashboard/users/:userId"
  },

  shareTitle: "Check out this user profile",
  shareDescription: "View {user.name}'s profile on MyApp",
  shareImage: "{user.avatarUrl}"
}

DeepLinkConfig HOME_CONFIG = {
  path: "/",
  render: "ssr",
  auth: "public",
  layoutGroup: "marketing",
  deepLinkEnabled: true,
  nativeScreen: "Home",
  nativeParams: {}
}
```

### API Routes

#### POST `/api/deep-link/generate`

Generate a shareable deep link (tracks it for deferred deep linking):

**Request:**
```
{
  path:       string (e.g., "/dashboard/users/123")
  params:     object (e.g., { userId: "123" })
  native:     boolean (default: false; true = prefer native app)
  ttl:        integer (seconds until link expires, default: 2592000 = 30 days)
}
```

**Response:**
```
{
  web_url:           string (https://app.example.com/dashboard/users/123)
  deep_link_url:     string (https://app.example.com/dl/abc123)
  native_app_link:   string (myapp://dashboard/users/123)
  expires_at:        datetime
}
```

#### GET `/dl/:token`

Handle deferred deep link (user doesn't have app installed yet):

**Response:**
```html
<!DOCTYPE html>
<html>
<head>
  <meta name="apple-app-site-association" content="..." />
</head>
<body>
  <script>
    // Detect if app is installed
    let appInstalled = checkIfAppInstalled()

    if (appInstalled) {
      // Open app with deep link
      window.location = "myapp://dashboard/users/123"
    } else {
      // Show "Get App" button
      document.body.innerHTML = `
        <div class="deferred-link">
          <p>Get the app for a better experience</p>
          <a href="https://apps.apple.com/...">Download for iOS</a>
          <a href="https://play.google.com/...">Download for Android</a>
          <p>Or continue on <a href="/dashboard/users/123">web</a></p>
        </div>
      `
    }
  </script>
</body>
</html>
```

#### GET `/api/deep-link/validate/:token`

Validate a deep link token (used by native app after install):

**Response:**
```
{
  valid:      boolean
  destination: string (e.g., "/dashboard/users/123")
  params:     object
  expires_at: datetime
}
```

### Implementation

#### Deep Link Registry (Runtime)

```pseudocode
class DeepLinkRegistry {
  private routes: Map<string, DeepLinkConfig> = new Map()

  // Load all .config.ts files and register routes
  loadRoutes(routesDir: string) {
    for each file matching "**/*.config.ts" in routesDir:
      let config = import(file).default

      if (config.deepLinkEnabled) {
        this.routes.set(config.path, config)
      }
  }

  // Resolve web path → native screen
  resolveNativeScreen(webPath: string, params: object) {
    let config = this.routes.get(webPath)

    if (!config || !config.nativeScreen) {
      return null
    }

    // Map params: { userId: "123" } → { id: "123" }
    let nativeParams = {}
    for each [webParam, nativeParam] in config.nativeParams:
      nativeParams[nativeParam] = params[webParam]

    return {
      screen: config.nativeScreen,
      params: nativeParams
    }
  }

  // Resolve native screen → web path
  resolveWebPath(nativeScreen: string, params: object) {
    for each [path, config] in this.routes:
      if (config.nativeScreen === nativeScreen) {
        // Reverse param mapping
        let webParams = {}
        for each [webParam, nativeParam] in config.nativeParams:
          webParams[webParam] = params[nativeParam]

        return this.interpolatePath(path, webParams)
      }

    return null
  }

  private interpolatePath(path: string, params: object) {
    // /dashboard/users/:userId with { userId: "123" } → /dashboard/users/123
    return path.replace(/:(\w+)/g, (match, param) => params[param] || match)
  }
}
```

#### Deep Link Handler (Web)

```pseudocode
class DeepLinkHandler {
  constructor(private registry: DeepLinkRegistry) {}

  // Parse incoming deep link, validate auth, redirect
  async handleDeepLink(url: string) {
    let parsed = new URL(url)
    let path = parsed.pathname
    let params = Object.fromEntries(parsed.searchParams)

    // Validate token if deferred link
    if (path.startsWith("/dl/")) {
      let token = path.split("/").pop()
      let validation = await validateDeferredLink(token)

      if (!validation.valid) {
        return { error: "Link expired or invalid" }
      }

      path = validation.destination
      params = validation.params
    }

    // Find route config
    let config = this.registry.routes.get(path)
    if (!config || !config.deepLinkEnabled) {
      return { error: "Route not found or deep linking disabled" }
    }

    // Check auth requirement (handle via redirect system from otp.md)
    if (config.auth === "user" && !currentUser) {
      // Redirect to login, then to deep link destination
      return {
        redirect: `/login?redirect=${encodeURIComponent(path)}?${new URLSearchParams(params)}`
      }
    }

    if (config.auth === "admin" && currentUser?.role !== "admin") {
      return { error: "Unauthorized" }
    }

    // Deep link is valid
    return {
      path: path,
      params: params,
      config: config
    }
  }

  // Generate a shareable deep link
  async generateDeepLink(path: string, params: object, options = {}) {
    let config = this.registry.routes.get(path)

    if (!config || !config.deepLinkEnabled) {
      throw new Error("Route not found or deep linking disabled")
    }

    // Create deferred deep link token
    let token = generateSecureToken()
    let expiresAt = new Date(Date.now() + (options.ttl || 2592000) * 1000)

    // Store token in database
    await db.deferred_deep_links.insert({
      token: token,
      web_path: path,
      params: params,
      created_by: currentUser?.id,
      created_at: new Date(),
      expires_at: expiresAt
    })

    // Generate URLs
    let webUrl = buildURL(path, params)
    let deferredUrl = buildURL("/dl/" + token)
    let nativeScreen = this.registry.resolveNativeScreen(path, params)
    let nativeUrl = buildNativeDeepLink(nativeScreen)

    return {
      web_url: webUrl,
      deep_link_url: deferredUrl,
      native_app_link: nativeUrl,
      expires_at: expiresAt
    }
  }
}
```

#### Deep Link Utility Functions

```pseudocode
// Generate a shareable link component
component ShareLink({ path, params }) {
  let deepLinkHandler = useDeepLinkHandler()
  let [link, setLink] = useState(null)
  let [loading, setLoading] = useState(false)

  async function generateLink() {
    setLoading(true)
    try {
      let result = await deepLinkHandler.generateDeepLink(path, params)
      setLink(result)
    } catch (err) {
      console.error("Failed to generate link:", err)
    }
    setLoading(false)
  }

  return (
    <div class="share-link">
      {!link ? (
        <button onClick={generateLink} disabled={loading}>
          {loading ? "Generating..." : "Share"}
        </button>
      ) : (
        <div>
          <p>Share this link:</p>
          <input type="text" value={link.web_url} readOnly />
          <CopyButton text={link.web_url} />

          {/* Show social share options */}
          <ShareButtons
            url={link.deep_link_url}
            title={params.shareTitle}
            description={params.shareDescription}
          />
        </div>
      )}
    </div>
  )
}

// Handle incoming deep link on app start
function onAppLaunch(url: string) {
  let handler = new DeepLinkHandler(registry)
  let result = await handler.handleDeepLink(url)

  if (result.error) {
    showError(result.error)
    return
  }

  if (result.redirect) {
    navigate(result.redirect)
    return
  }

  // Navigate to destination
  navigate(result.path, { params: result.params })
}

// Native app integration: convert web path to native screen
function bridgeDeepLink(webPath: string, params: object) {
  let nativeScreen = registry.resolveNativeScreen(webPath, params)

  if (!nativeScreen) {
    return { error: "Unknown route" }
  }

  // Call native code to open screen
  nativeApp.openScreen(nativeScreen.screen, nativeScreen.params)
}

// Android App Links configuration
function generateAppLinksJSON() {
  let relations = []

  for each [path, config] in registry.routes:
    if (config.deepLinkEnabled) {
      relations.push({
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "web",
          host: "app.example.com",
          path: path
        }
      })

  // Save to /.well-known/assetlinks.json
  return {
    relation: relations.map(r => r.relation),
    target: {
      namespace: "android_app",
      package_name: "com.myapp",
      sha256_cert_fingerprints: [ANDROID_SIGNING_CERT_HASH]
    }
  }
}

// iOS Universal Links configuration
function generateAppleAppSiteAssociation() {
  let applinks = []
  let webcredentials = []

  for each [path, config] in registry.routes:
    if (config.deepLinkEnabled) {
      applinks.push({
        appID: "TEAM_ID.com.myapp",
        paths: [config.path]
      })

  // Save to /.well-known/apple-app-site-association
  return {
    applinks: applinks,
    webcredentials: {
      apps: ["TEAM_ID.com.myapp"]
    }
  }
}
```

### Configuration Examples

#### Example 1: User Profile Deep Link

```pseudocode
DeepLinkConfig USER_PROFILE = {
  path: "/profile/:userId",
  render: "spa",
  auth: "user",

  deepLinkEnabled: true,
  nativeScreen: "UserProfile",
  nativeParams: { userId: "id" },

  deferredDeepLink: {
    appStoreUrl: "https://apps.apple.com/app/myapp/id123456789",
    playStoreUrl: "https://play.google.com/store/apps/details?id=com.myapp",
    fallbackUrl: "/profile/:userId"
  },

  shareTitle: "Check out {user.name}'s profile",
  shareDescription: "View {user.name} on MyApp",
  shareImage: "{user.avatarUrl}"
}

// Usage
let result = await deepLinkHandler.generateDeepLink("/profile/456", { userId: "456" })
// → https://app.example.com/profile/456
// → https://app.example.com/dl/abc123 (deferred link)
// → myapp://profile/456 (native)
```

#### Example 2: Product Details Deep Link

```pseudocode
DeepLinkConfig PRODUCT_DETAILS = {
  path: "/products/:productId",
  render: "ssr",
  auth: "public",

  deepLinkEnabled: true,
  nativeScreen: "ProductDetails",
  nativeParams: { productId: "id" },

  shareTitle: "{product.name}",
  shareDescription: "{product.description}",
  shareImage: "{product.imageUrl}"
}
```

---

## Part 3: Auth-Gated Deep Links

### Overview

Some deep links require authentication. Flow:
1. User taps deep link but is not logged in
2. Redirect to login page with `redirect=<deep_link_destination>`
3. User logs in
4. After auth succeeds, redirect to original deep link destination

Integration with `otp.md` redirect system.

### Implementation

```pseudocode
class AuthGatedDeepLinkHandler {
  async handleAuthGatedDeepLink(deepLink: string, user: User | null) {
    let result = await deepLinkHandler.handleDeepLink(deepLink)

    if (result.error) {
      return { error: result.error }
    }

    let config = result.config

    // Check if auth is required
    if (config.auth === "public") {
      // No auth required, navigate directly
      return { navigate: result.path, params: result.params }
    }

    if (config.auth === "user" && !user) {
      // Redirect to login, then to deep link
      // (See otp.md for redirect system)
      let loginUrl = `/login?redirect=${encodeURIComponent(result.path)}`
      return { redirect: loginUrl }
    }

    if (config.auth === "admin" && user?.role !== "admin") {
      // User is logged in but not admin
      return { error: "Unauthorized: admin access required" }
    }

    // Auth passed
    return { navigate: result.path, params: result.params }
  }
}

// On login completion (from otp.md)
export async function completeLogin(user: User, loginMethod: string) {
  // Standard login flow (see otp.md)
  await loginUser(user)

  // Check for redirect query param
  let redirectUrl = getQueryParam("redirect")

  if (redirectUrl) {
    // Validate that redirect is a safe internal URL
    if (isSafeInternalURL(redirectUrl)) {
      // Navigate to the requested destination
      navigate(redirectUrl)
    } else {
      // Default to dashboard
      navigate("/dashboard")
    }
  } else {
    navigate("/dashboard")
  }
}

// On app start: check for deep link and handle auth
function onAppLaunch(launchURL: string) {
  let user = getCurrentUser()
  let handler = new AuthGatedDeepLinkHandler()

  let result = await handler.handleAuthGatedDeepLink(launchURL, user)

  if (result.error) {
    showError(result.error)
    return
  }

  if (result.redirect) {
    navigate(result.redirect)
    return
  }

  if (result.navigate) {
    navigate(result.navigate, { params: result.params })
    return
  }
}

// Helper: validate redirect is safe
function isSafeInternalURL(url: string) {
  // Only allow relative paths or same-origin URLs
  let parsed = new URL(url, window.location.origin)

  return parsed.origin === window.location.origin &&
         parsed.pathname.startsWith("/") &&
         !parsed.pathname.includes("//")
}
```

---

## Gotchas & Edge Cases

### 1. Layout Shift During Skeleton → Content Transition

**Problem**: Skeleton dimensions don't match actual content; content loads and causes layout shift.

**Solution**: Measure actual content dimensions and hardcode them in skeleton:

```pseudocode
// ❌ Wrong: skeleton width not specified
<Skeleton type="card" />
<Card data={data} />  // Card is 400px wide

// ✓ Correct: skeleton width matches card width
<Skeleton type="card" width="400px" height="300px" />
<Card data={data} width="400px" height="300px" />
```

### 2. Skeleton Shows Too Long or Too Short

**Problem**: Minimum load time is too long (skeleton shows even for fast requests) or too short (no time to render).

**Solution**: Set minimum load time based on typical network conditions:

```
minimumLoadTime: 300ms  // 3G/4G
minimumLoadTime: 500ms  // Slower networks
minimumLoadTime: 100ms  // Local SPA
```

### 3. Deep Link with Missing Route Param

**Problem**: Deep link is `/products/123` but route expects `productId` param.

**Solution**: Validate params match route schema during generation:

```pseudocode
function generateDeepLink(path: string, params: object) {
  let config = this.routes.get(path)

  // Extract required params from path
  let requiredParams = extractPathParams(path)

  for each required in requiredParams:
    if (!params[required]) {
      throw new Error(`Missing required param: ${required}`)
    }
}
```

### 4. Deep Link Expires Before Validation

**Problem**: Deferred deep link token expires before user installs app and opens it.

**Solution**: Use long TTL (30 days), but allow extension:

```pseudocode
{
  ttl: 2592000,  // 30 days
  extendable: true
}

// If user tries to open expired link, show "Link expired, try again"
```

### 5. Native App Param Mapping Mismatch

**Problem**: Web uses `userId` but native uses `id`; deep link loses data.

**Solution**: Validate mapping during route registration:

```pseudocode
DeepLinkConfig {
  path: "/users/:userId",
  nativeScreen: "UserProfile",
  nativeParams: {
    userId: "id"  // userId (web) ↔ id (native)
  }
}

// Validate that all path params have a native mapping
function validateNativeParamMapping(config) {
  let pathParams = extractPathParams(config.path)

  for each param in pathParams:
    if (!config.nativeParams[param]) {
      throw new Error(`No native mapping for param: ${param}`)
    }
}
```

### 6. Deep Link to Auth-Protected Route for Guest User

**Problem**: User gets deep link to `/admin` but is not admin; redirect to login confuses users.

**Solution**: Show error page instead of redirect:

```pseudocode
if (config.auth === "admin" && user?.role !== "admin") {
  return showError("This link requires admin access")
  // Don't redirect to login; that's confusing
}
```

### 7. Deferred Deep Link Never Opens App

**Problem**: User installs app but the deferred link is lost; no way to navigate to intended screen.

**Solution**: Store deferred link data in `localStorage` or deep link cache:

```pseudocode
// On web, before showing "Get App" button
function storeDeferredDeepLink(token: string, destination: string) {
  localStorage.setItem("pendingDeepLink", JSON.stringify({
    token: token,
    destination: destination,
    timestamp: Date.now()
  }))
}

// Native app on first launch
function onNativeAppFirstLaunch() {
  let deferred = JSON.parse(localStorage.getItem("pendingDeepLink"))

  if (deferred && Date.now() - deferred.timestamp < 30 * 86400000) {
    // Navigate to deferred destination
    navigate(deferred.destination)
  }
}
```

### 8. Deep Link with Special Characters in Params

**Problem**: Deep link to user with email `john+work@example.com` breaks URL encoding.

**Solution**: Always URL-encode params:

```pseudocode
function buildURL(path: string, params: object) {
  let query = new URLSearchParams()

  for each [key, value] in params:
    query.set(key, value)  // Automatically URL-encodes

  return `${path}?${query.toString()}`
}

// On receive, decode automatically
let decodedParams = Object.fromEntries(new URLSearchParams(location.search))
```

### 9. Shimmer Animation Performance

**Problem**: Shimmer animation causes jank on low-end devices.

**Solution**: Make shimmer animation GPU-accelerated:

```css
@keyframes shimmer {
  0% {
    backgroundPosition: -1000px 0
  }
  100% {
    backgroundPosition: 1000px 0
  }
}

.skeleton-item {
  animation: shimmer 1.5s infinite;
  will-change: background-position;  /* Promote to GPU layer */
  transform: translateZ(0);           /* Enable hardware acceleration */
}
```

Or disable shimmer on low-end devices:

```pseudocode
let isLowEnd = matchMedia("(max-width: 480px)").matches &&
               navigator.hardwareConcurrency <= 2

<Skeleton shimmerEnabled={!isLowEnd} />
```

### 10. Cross-Domain Deep Links

**Problem**: Deep link points to different domain (e.g., `https://api.example.com/user/123`).

**Solution**: Only allow same-origin deep links:

```pseudocode
function isSafeDeepLink(url: string) {
  let parsed = new URL(url, window.location.origin)
  return parsed.origin === window.location.origin
}
```

---

## Summary: Rendering Enhancements Checklist

- [ ] **Skeleton States**: Configured for all content types (list, card, profile, table, form)
- [ ] **Layout Dimensions**: Skeletons match actual content dimensions exactly
- [ ] **Shimmer Animation**: GPU-accelerated, configurable
- [ ] **Error Fallbacks**: Skeleton error state shows when data fetch fails
- [ ] **Deep Link Registry**: All routes with `deepLinkEnabled: true` registered
- [ ] **Native Screen Mapping**: Web paths ↔ native screens with param mapping
- [ ] **Deferred Deep Links**: Handled via token system, tokens stored in DB with TTL
- [ ] **Auth Gating**: Auth-required deep links redirect to login, then to destination
- [ ] **Sharing Utility**: `generateDeepLink()` function creates shareable links
- [ ] **Apple/Android Config**: `.well-known/apple-app-site-association` and `assetlinks.json` generated
- [ ] **Layout Shift Prevention**: CLS = 0; skeletons and content have identical dimensions
