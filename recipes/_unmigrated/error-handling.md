---
name: Error Handling & Resilience
description: Error pages, global error boundaries, generic rate limiting middleware, and standardized API error responses
type: project
---

# Error Handling & Resilience

A resilient application handles failures gracefully. This recipe standardizes error responses across the API, implements rate limiting as generic middleware, provides proper error pages for user-facing failures, and includes a global error boundary to catch unexpected client-side errors.

---

## API Error Envelope Specification

All API responses follow a standard envelope. This allows clients to reliably detect success or failure and extract structured error information.

### Success Response

```
{
  ok: true,
  data: <any>
}
```

- `ok: true` indicates the request succeeded.
- `data` contains the response payload (object, array, string, null, or primitive).

### Error Response

```
{
  ok: false,
  error: {
    code: string,           // Namespaced error code
    message: string,        // Human-readable message for display
    details?: object        // Additional context (validation errors, etc.)
  }
}
```

- `ok: false` indicates the request failed.
- `error.code` is a namespaced string: `auth/unauthorized`, `billing/past_due`, `validation/invalid_email`, `rate_limit/exceeded`.
- `error.message` is safe to show to end users.
- `error.details` is optional and provides extra context (e.g., validation field errors).

### HTTP Status Codes

| Status | Envelope | Example |
|--------|----------|---------|
| 200 | `{ ok: true, data: ... }` | Successful request |
| 400 | `{ ok: false, error: { code: "validation/invalid_email", message: "..." } }` | Client error (validation, malformed request) |
| 401 | `{ ok: false, error: { code: "auth/unauthorized", message: "..." } }` | Missing or invalid credentials |
| 403 | `{ ok: false, error: { code: "auth/forbidden", message: "..." } }` | Authenticated but not authorized |
| 404 | `{ ok: false, error: { code: "resource/not_found", message: "..." } }` | Resource does not exist |
| 429 | `{ ok: false, error: { code: "rate_limit/exceeded", message: "..." } }` | Rate limit exceeded |
| 500 | `{ ok: false, error: { code: "internal/server_error", message: "..." } }` | Unhandled server error |
| 503 | `{ ok: false, error: { code: "service/unavailable", message: "..." } }` | Service temporarily unavailable |

---

## Rate Limiting Middleware

Rate limiting prevents abuse and protects the server from overload. This is a **generic** middleware that can be applied to any route, separate from auth-specific rate limiting.

### Data Model

Rate limits are tracked using a **sliding window counter** stored in the database.

```
Table: rate_limit_counters
  id (UUID, PK)
  key (string)             // Unique identifier: "ip:192.0.2.1", "user:12345", or custom
  window_start (timestamp) // Start of current window
  count (integer)          // Requests in current window
  expires_at (timestamp)   // TTL for cleanup
  created_at (timestamp)
  updated_at (timestamp)
  UNIQUE(key, window_start)
```

### Sliding Window Counter Logic

1. **Identify the window**: Calculate `window_start = now - (now % window_duration)` (e.g., 15-minute window aligns to hour boundaries).
2. **Check limit**: Query the counter for the current window and key.
3. **Increment**: If count < max, increment and return. If count >= max, reject.
4. **Cleanup**: Delete expired entries periodically (batch job or on-demand).

### Middleware Interface

```pseudocode
middleware rateLimit(config):
  return (request, response, next):
    key = computeKey(request, config.key)
    window = now - (now % config.window_parsed)

    counter = query rate_limit_counters
      where key=key and window_start=window

    if counter is null:
      counter = create rate_limit_counters {
        key: key,
        window_start: window,
        count: 1,
        expires_at: window + config.window_parsed + 1 hour
      }
    else if counter.count < config.max:
      update rate_limit_counters
        set count = count + 1, updated_at = now
        where id = counter.id
    else:
      reset_at = window + config.window_parsed
      response.status(429)
      response.header("X-RateLimit-Limit", config.max)
      response.header("X-RateLimit-Remaining", 0)
      response.header("X-RateLimit-Reset", reset_at.toUnixTimestamp())
      return response.json({
        ok: false,
        error: {
          code: "rate_limit/exceeded",
          message: format("Rate limit exceeded. Reset at {reset_at}"),
          details: {
            limit: config.max,
            window: config.window,
            reset_at: reset_at
          }
        }
      })

    remaining = max(0, config.max - counter.count)
    reset_at = window + config.window_parsed

    response.header("X-RateLimit-Limit", config.max)
    response.header("X-RateLimit-Remaining", remaining)
    response.header("X-RateLimit-Reset", reset_at.toUnixTimestamp())

    next()
```

### Key Functions

```pseudocode
function computeKey(request, keyConfig):
  if keyConfig == "ip":
    // Use X-Forwarded-For if behind a proxy, else request.ip
    return format("ip:{}", request.header("X-Forwarded-For") || request.ip)

  if keyConfig == "user_id":
    if not request.user:
      return "anonymous"
    return format("user:{}", request.user.id)

  if keyConfig is callable:
    return keyConfig(request)

  throw Error("Invalid key config")

function parseWindow(windowStr):
  // "15m" -> 15 * 60 seconds
  // "1h" -> 3600 seconds
  match windowStr:
    /(\d+)m/ -> return groups[0] * 60
    /(\d+)h/ -> return groups[0] * 3600
    /(\d+)s/ -> return groups[0]
    else -> throw Error("Invalid window format")
```

### Configuration Examples

```pseudocode
// Per-IP rate limiting: 100 requests per 15 minutes
GET /api/search -> [
  rateLimit({ window: "15m", max: 100, key: "ip" }),
  searchHandler
]

// Per-user rate limiting: 1000 requests per hour
POST /api/analyze -> [
  requireAuth(),
  rateLimit({ window: "1h", max: 1000, key: "user_id" }),
  analyzeHandler
]

// Custom key function: rate limit by API key
POST /api/webhook -> [
  rateLimit({
    window: "1h",
    max: 500,
    key: (request) -> format("api_key:{}", request.header("X-API-Key"))
  }),
  webhookHandler
]
```

### Response Headers

Every response includes rate limit information:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 42
X-RateLimit-Reset: 1711468200
```

- `X-RateLimit-Limit`: The maximum requests per window.
- `X-RateLimit-Remaining`: Requests remaining in the current window.
- `X-RateLimit-Reset`: Unix timestamp when the current window resets.

---

## 404 Page (Not Found)

The 404 page is rendered server-side with a proper HTTP 404 status code so search engines understand the resource is missing.

### Layout

```
┌─────────────────────────────────────────┐
│ <header>                                │
│   <nav> (logo, home link, search)       │
│ </header>                               │
├─────────────────────────────────────────┤
│ <main class="error-container">          │
│   <h1>404 — Page Not Found</h1>         │
│   <p class="message">                   │
│     The page you're looking for         │
│     doesn't exist.                      │
│   </p>                                  │
│   <section class="actions">             │
│     <a href="/">Return to Home</a>      │
│     <a href="/search?q=...">            │
│       Search for help                   │
│     </a>                                │
│   </section>                            │
│ </main>                                 │
├─────────────────────────────────────────┤
│ <footer>                                │
└─────────────────────────────────────────┘
```

### SEO Meta Tags

```pseudocode
function render404Page(request):
  requestPath = request.path

  return html({
    head: {
      title: "404 — Page Not Found",
      meta: [
        { name: "viewport", content: "width=device-width, initial-scale=1" },
        { name: "robots", content: "noindex, follow" },
        { property: "og:title", content: "404 — Page Not Found" },
        { property: "og:type", content: "website" }
      ],
      canonicalUrl: null  // No canonical for 404
    },
    body: {
      statusCode: 404,
      content: render(
        <Layout>
          <ErrorContainer>
            <h1>404 — Page Not Found</h1>
            <p>The page at <code>{requestPath}</code> doesn't exist.</p>
            <nav>
              <a href="/">Back to Home</a>
              <a href=format("/search?q={encodeURIComponent(extractKeywords(requestPath))}">
                Search our help docs
              </a>
            </nav>
          </ErrorContainer>
        </Layout>
      )
    }
  })
```

### HTTP Response

```
HTTP/1.1 404 Not Found
Content-Type: text/html; charset=utf-8
Cache-Control: public, max-age=3600

<!DOCTYPE html>
<html>
  ...
</html>
```

---

## 500 Page (Server Error)

The 500 page is a **static HTML file** served when the application crashes or SSR fails. It has no JavaScript dependencies and no external assets.

### File Structure

```
/public/error-500.html
```

### Self-Contained HTML & Styling

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex" />
  <title>Something Went Wrong — 500 Error</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
        "Helvetica Neue", Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #333;
    }

    .container {
      background: white;
      border-radius: 8px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      padding: 40px;
      max-width: 600px;
      text-align: center;
    }

    h1 {
      font-size: 48px;
      font-weight: bold;
      color: #667eea;
      margin-bottom: 16px;
    }

    p {
      font-size: 16px;
      color: #666;
      margin-bottom: 24px;
      line-height: 1.6;
    }

    .actions {
      display: flex;
      gap: 16px;
      justify-content: center;
      flex-wrap: wrap;
    }

    a {
      display: inline-block;
      padding: 12px 24px;
      border-radius: 6px;
      text-decoration: none;
      font-weight: 500;
      transition: all 0.3s ease;
    }

    .btn-primary {
      background: #667eea;
      color: white;
    }

    .btn-primary:hover {
      background: #5568d3;
      box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
    }

    .btn-secondary {
      background: #f0f0f0;
      color: #333;
    }

    .btn-secondary:hover {
      background: #e0e0e0;
    }

    .error-id {
      font-size: 12px;
      color: #999;
      margin-top: 32px;
      font-family: "Courier New", monospace;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>500</h1>
    <p>
      Something went wrong on our end. We've been notified and are working to
      fix it.
    </p>
    <div class="actions">
      <a href="/" class="btn-primary">Return to Home</a>
      <a href="mailto:support@example.com" class="btn-secondary">Contact Support</a>
    </div>
    <div class="error-id">
      Error ID: <span id="error-id">generating...</span>
    </div>
  </div>
  <script>
    // Generate a request ID for error tracking (client-side only, no external calls)
    document.getElementById('error-id').textContent = 'ERR-' +
      Math.random().toString(36).substr(2, 9).toUpperCase();
  </script>
</body>
</html>
```

### Server Configuration

```pseudocode
// Serve static 500 page on SSR failure or unhandled error
app.use(errorHandler):
  (error, request, response, next):
    logger.error("Unhandled error", {
      error: error.message,
      stack: error.stack,
      path: request.path,
      method: request.method
    })

    // Send static 500 page
    response.status(500)
    response.sendFile("/public/error-500.html")
```

---

## Global Error Boundary

The global error boundary catches React render errors and displays a fallback UI. It also reports errors to an external error tracking service.

### Error Boundary Component

```pseudocode
class ErrorBoundary extends React.Component:

  constructor(props):
    super(props)
    this.state = {
      hasError: false,
      error: null,
      errorId: null
    }

  static getDerivedStateFromError(error):
    return { hasError: true, error: error }

  componentDidCatch(error, errorInfo):
    errorId = generateErrorId()
    this.setState({ errorId: errorId })

    // Report to error tracking service (e.g., Sentry)
    reportError({
      errorId: errorId,
      message: error.toString(),
      stack: errorInfo.componentStack,
      context: {
        userAgent: navigator.userAgent,
        url: window.location.href,
        timestamp: new Date().toISOString()
      }
    })

    logger.error("React render error", {
      errorId: errorId,
      error: error.message,
      componentStack: errorInfo.componentStack
    })

  handleReset():
    this.setState({ hasError: false, error: null, errorId: null })
    // Optionally reload the page or navigate to home
    // window.location.href = "/"

  render():
    if this.state.hasError:
      return (
        <ErrorFallback
          error={this.state.error}
          errorId={this.state.errorId}
          onReset={() -> this.handleReset()}
        />
      )

    return this.props.children
```

### Error Fallback UI

```pseudocode
function ErrorFallback({ error, errorId, onReset }):
  return (
    <div class="error-fallback">
      <h1>Oops! Something went wrong</h1>
      <p>We've logged this error and will look into it.</p>
      <details class="error-details">
        <summary>Error details</summary>
        <pre class="error-stack">{error.stack}</pre>
      </details>
      <div class="error-id">
        Error ID: <code>{errorId}</code>
      </div>
      <div class="actions">
        <button onClick={onReset} class="btn-primary">
          Try again
        </button>
        <a href="/" class="btn-secondary">
          Return to Home
        </a>
      </div>
    </div>
  )
```

### Reporting Hook

```pseudocode
hook useErrorReporting():

  function reportError(errorData):
    if ENV === "production":
      // Only include safe, non-sensitive data
      sendToErrorTracker({
        errorId: errorData.errorId,
        message: errorData.message,
        context: {
          url: errorData.context.url,
          timestamp: errorData.context.timestamp
        }
      })
    else:
      console.error("Error reported", errorData)

  return { reportError }

// Usage in error boundary
const { reportError } = useErrorReporting()
reportError({ errorId, message, context })
```

### Application Root Setup

```pseudocode
function App():
  return (
    <ErrorBoundary>
      <Layout>
        <Router>
          <!-- Routes -->
        </Router>
      </Layout>
    </ErrorBoundary>
  )
```

---

## API Route Error Wrapper

Every API route is wrapped in a try/catch that catches unhandled errors, logs them, and returns the standard error envelope.

### Try/Catch Wrapper

```pseudocode
function wrapApiRoute(handler):
  return async (request, response):
    try:
      return await handler(request, response)
    catch error:
      errorId = generateErrorId()

      // Log with full context (not sent to client)
      logger.error("API route error", {
        errorId: errorId,
        error: error.message,
        stack: error.stack,
        path: request.path,
        method: request.method,
        userId: request.user?.id
      })

      // Send to error tracking
      if ENV === "production":
        reportErrorToTracker({ errorId, error, request })

      // Return standard error envelope
      response.status(500)
      response.json({
        ok: false,
        error: {
          code: "internal/server_error",
          message: "An unexpected error occurred. Please try again.",
          details: ENV === "development" ? {
            errorId: errorId,
            message: error.message,
            stack: error.stack
          } : {
            errorId: errorId
          }
        }
      })
```

### Route Definition

```pseudocode
// Wrap all route handlers
POST /api/users -> [
  requireAuth(),
  rateLimit({ window: "1h", max: 10, key: "user_id" }),
  wrapApiRoute(async (request, response):
    user = await createUser(request.body)
    response.json({ ok: true, data: user })
  )
]

// Stack composition: middleware -> handler wrapper
GET /api/profile/:id -> [
  wrapApiRoute(async (request, response):
    user = await getUser(request.params.id)
    if not user:
      response.status(404)
      response.json({
        ok: false,
        error: {
          code: "resource/not_found",
          message: format("User {request.params.id} not found")
        }
      })
      return

    response.json({ ok: true, data: user })
  )
]
```

### Logging Strategy

- **Development**: Log full error stack, request body (redacted passwords), and context.
- **Production**: Log error ID, code path, and user context. Never log stack traces or sensitive data to client. Send detailed logs to a centralized service (e.g., CloudWatch, Datadog).

```pseudocode
function logger.error(message, context):
  logEntry = {
    timestamp: now,
    level: "error",
    message: message,
    ...context
  }

  if ENV === "production":
    // Send to error tracker, redact sensitive fields
    sendToExternalLogger(sanitize(logEntry))
  else:
    console.error(logEntry)
```

---

## Client-Side Error Handling

The client should interpret the standard error envelope and provide user feedback.

### API Client Interceptor

```pseudocode
class ApiClient:

  async request(url, options):
    response = await fetch(url, options)
    data = await response.json()

    // Check standard error envelope
    if not data.ok:
      error = ApiError(
        code: data.error.code,
        message: data.error.message,
        details: data.error.details,
        statusCode: response.status
      )

      // Log and rethrow
      logger.error("API error", {
        code: error.code,
        message: error.message,
        url: url,
        status: response.status
      })

      throw error

    return data.data

// Usage in components
function UserProfile({ userId }):
  const [user, setUser] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() -> {
    const fetchUser = async ():
      try:
        setLoading(true)
        const userData = await apiClient.request(
          format("/api/users/{userId}")
        )
        setUser(userData)
        setError(null)
      catch err:
        setError(err)
        // Show toast/banner with err.message
        showErrorBanner(err.message)

    fetchUser()
  }, [userId])

  if loading:
    return <Spinner />

  if error:
    if error.code === "resource/not_found":
      return <NotFound />

    return <ErrorBanner error={error} />

  return <UserCard user={user} />
```

### Error Banner / Toast

```pseudocode
function ErrorBanner({ error }):
  return (
    <div class="banner banner-error" role="alert">
      <p>{error.message}</p>
      {error.code === "rate_limit/exceeded":
        <p class="hint">
          Please wait a moment and try again.
        </p>
      }
      <button onClick={() -> dismissBanner()}>
        Dismiss
      </button>
    </div>
  )

function showErrorToast(message, options = {}):
  toast({
    type: "error",
    message: message,
    duration: options.duration || 5000,
    action: options.action
  })
```

### Retry Logic

```pseudocode
async function retryWithBackoff(fn, maxAttempts = 3):
  for attempt in range(maxAttempts):
    try:
      return await fn()
    catch error:
      // Don't retry auth or validation errors
      if error.code in ["auth/unauthorized", "validation/*"]:
        throw error

      // Retry on transient errors
      if attempt < maxAttempts - 1:
        delay = exponentialBackoff(attempt)
        await sleep(delay)
        continue

      throw error

// Usage
const userData = await retryWithBackoff(() -> {
  return apiClient.request("/api/profile")
})
```

---

## Gotchas & Edge Cases

### 1. Hydration Errors vs Render Errors

Hydration errors occur when server-rendered HTML doesn't match client-rendered HTML. They are not the same as render errors.

```pseudocode
// Hydration error example:
// Server renders: <div>3:45 PM</div>  (time at render)
// Client renders: <div>3:46 PM</div>  (time updated while hydrating)
// → Mismatch, error thrown

// Solution: Either:
// - Don't render time-dependent content during SSR
// - Use suppressHydrationWarning on dynamic elements
// - Ensure server and client timestamps are consistent
```

### 2. Network Errors vs API Errors

Network errors (no connection, timeout) are different from API errors (error envelope).

```pseudocode
async function apiRequest(url):
  try:
    response = await fetch(url, { timeout: 10000 })

    // Check HTTP status
    if response.status >= 400:
      data = await response.json()
      if data.ok === false:
        // API returned structured error
        throw ApiError(data.error)
      else:
        // HTTP error but no standard envelope
        throw HttpError(response.status, response.statusText)

    return await response.json()

  catch error:
    if error.name === "AbortError":
      throw new NetworkError("Request timed out")
    if error instanceof TypeError:
      throw new NetworkError("Network request failed")
    throw error

// Usage
try:
  await apiRequest("/api/data")
catch error:
  if error instanceof NetworkError:
    showBanner("No internet connection")
  else if error instanceof ApiError:
    if error.code === "rate_limit/exceeded":
      showBanner("You're doing that too fast")
    else:
      showBanner(error.message)
```

### 3. Rate Limit Key Selection for Proxied Traffic

When behind a reverse proxy (Nginx, CloudFlare), `request.ip` is unreliable. Always check `X-Forwarded-For` or configure the proxy to set a standard header.

```pseudocode
// Bad: Only checks request.ip
function getClientIp(request):
  return request.ip  // Returns proxy IP, not client IP

// Good: Checks X-Forwarded-For first
function getClientIp(request):
  forwardedFor = request.header("X-Forwarded-For")
  if forwardedFor:
    // Take the first IP (closest to origin)
    return forwardedFor.split(",")[0].trim()
  return request.ip

// Better: Use a standardized header set by the proxy
function getClientIp(request):
  // CloudFlare: CF-Connecting-IP
  // AWS ALB: X-Forwarded-For
  // Custom proxy: X-Real-IP
  return (
    request.header("CF-Connecting-IP") ||
    request.header("X-Real-IP") ||
    request.header("X-Forwarded-For")?.split(",")[0].trim() ||
    request.ip
  )

// Apply to rate limiting
rateLimit({
  window: "15m",
  max: 100,
  key: (request) -> format("ip:{}", getClientIp(request))
})
```

### 4. Error Boundary Recovery

Error boundaries don't recover automatically. Provide a clear recovery path.

```pseudocode
// Bad: User stuck after error
class ErrorBoundary:
  render():
    if this.state.hasError:
      return <h1>Error</h1>  // No way to recover

// Good: Provides recovery options
class ErrorBoundary:
  render():
    if this.state.hasError:
      return (
        <ErrorFallback
          onReset={() -> this.setState({ hasError: false })}
          onNavigate={() -> navigate("/")}
        />
      )
```

### 5. Sensitive Data in Error Messages

Never expose internal error details (file paths, SQL, API keys) in production.

```pseudocode
// Bad: Leaks internal details
response.json({
  ok: false,
  error: {
    code: "database/error",
    message: "Error in /app/services/user.ts line 42: Connection refused"
  }
})

// Good: Safe, generic message in production
response.json({
  ok: false,
  error: {
    code: "internal/server_error",
    message: "An unexpected error occurred",
    details: ENV === "development" ? {
      actualError: "Connection refused"
    } : {}
  }
})
```

### 6. Rate Limit Headers on Non-Limited Endpoints

Always include rate limit headers even if the endpoint doesn't have a limit, so clients know it's unlimited.

```pseudocode
response.header("X-RateLimit-Limit", "unlimited")
response.header("X-RateLimit-Remaining", "unlimited")
response.header("X-RateLimit-Reset", "0")
```

### 7. Logging PII

Be careful not to log personally identifiable information.

```pseudocode
// Bad: Logs email address
logger.error("User creation failed", {
  email: request.body.email,
  error: error.message
})

// Good: Logs user ID instead
logger.error("User creation failed", {
  userId: request.user.id,
  error: error.message
})
```

---

## Implementation Checklist

- [ ] Define standard error envelope (success and error shapes).
- [ ] Implement rate limiting middleware with sliding window counter.
- [ ] Create 404 page with SSR rendering and SEO meta tags.
- [ ] Create static 500 error page (no JS, no external assets).
- [ ] Implement global error boundary in React (or equivalent).
- [ ] Wrap all API routes in try/catch error handler.
- [ ] Add X-RateLimit-* response headers to all API endpoints.
- [ ] Implement client-side API interceptor for standard error envelope.
- [ ] Create error reporting hook for external tracking (Sentry, etc.).
- [ ] Add error banner/toast component for user-facing errors.
- [ ] Set up centralized logging (CloudWatch, Datadog, etc.).
- [ ] Document error codes for API consumers.
- [ ] Test 404 and 500 pages in production mode.
- [ ] Test rate limiting with load testing tool.
- [ ] Verify error boundary catches render errors (not thrown during render).
- [ ] Audit error messages for sensitive information leakage.
- [ ] Test error recovery flows (retry, reset, navigate home).
- [ ] Test rate limit behavior with proxied traffic (X-Forwarded-For).

---

## Related Recipes

- **OTP & Auth**: Rate limiting specific to authentication endpoints.
- **Monitoring & Logging**: Centralized error tracking and alerting.
- **Data Models**: Database schema for rate_limit_counters table.
