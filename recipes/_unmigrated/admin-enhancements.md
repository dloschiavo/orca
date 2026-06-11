---
name: Admin Enhancements
description: Admin crawler for link validation and SEO checks, audit log viewer with search and export
type: enhancement
requires: recipes/admin-user-crud.md, recipes/devops-enhancements.md, recipes/seo-enhancements.md
env_vars: ADMIN_CRAWLER_ENABLED (boolean, default: false), ADMIN_CRAWLER_INTERVAL (integer, default: 86400), ADMIN_CRAWLER_MAX_PAGES (integer, default: 1000), AUDIT_LOG_RETENTION_DAYS (integer, default: 90)
---

# Admin Enhancements

## Overview

Empower admins with diagnostic and monitoring tools:
1. **Admin Crawler** — Background job that crawls the app's own pages to detect issues (broken links, missing meta tags, slow pages, console errors); results stored and viewable in admin UI
2. **Audit Log Viewer** — Search, filter, and export system event logs with detailed information (user, action, resource, timestamp, IP address)

---

## Part 1: Admin Crawler

### Overview

The Admin Crawler automatically crawls the app's pages to detect SEO and performance issues:
- Broken internal/external links (404, 500, timeout)
- Missing meta tags (title, description, canonical)
- Slow page loads (>3s)
- Console errors during page load
- Broken images
- Accessibility issues (missing alt text)
- Redirect chains

Runs as a background job on a schedule (daily by default). Results stored in database with severity levels (error/warning/info). Admin UI displays results, filtered by page, issue type, severity. Linked to `seo-enhancements.md` and error handling recipes.

### Data Model

```
CrawlResult {
  id:               string (auto-generated UUID)
  crawl_id:         string (groups results from same crawl run)
  run_at:           datetime
  duration_ms:      integer

  // Page details
  url:              string (the page that was crawled)
  path:             string (e.g., "/products/123")
  status_code:      integer (200, 404, 500, etc.)
  load_time_ms:     integer (time to fully load)
  title_tag:        string (HTML <title> content)
  meta_description: string
  canonical_url:    string (if present)
  robots_meta:      string (e.g., "index, follow")

  // Issues found
  issues: [CrawlIssue]

  // Performance metrics
  fcp_ms:           integer (First Contentful Paint)
  lcp_ms:           integer (Largest Contentful Paint)
  cls_score:        number (Cumulative Layout Shift 0-1)
  redirects:        integer (number of redirects before final page)
  redirect_chain:   array of string (list of redirect URLs)

  // Screenshots & context
  screenshot_url:   string (optional, for pages with rendering errors)
  console_errors:   array of string (JS errors that occurred)
  console_warnings: array of string (JS warnings)
}

CrawlIssue {
  type:             "broken_link" | "missing_meta" | "slow_load" | "console_error" | "broken_image" | "accessibility" | "redirect_chain"
  severity:         "error" | "warning" | "info"
  element:          string (e.g., "<a href='/broken'>", "<img alt='' />")
  message:          string (human-readable description)
  suggested_fix:    string (e.g., "Add alt text to image", "Fix link destination")
  found_at:         string (CSS selector or location in page)
}

CrawlRun {
  id:               string
  started_at:       datetime
  completed_at:     datetime | null
  status:           "pending" | "in_progress" | "completed" | "failed"
  pages_crawled:    integer
  pages_with_issues: integer
  total_issues:     integer
  errors:           array of string (any crawl errors/exceptions)
  configuration: {
    max_pages:      integer
    excluded_paths: array of string
    crawl_frequency: string (cron)
  }
}

CrawlConfiguration {
  enabled:          boolean (default: ADMIN_CRAWLER_ENABLED env var)
  frequency:        string (cron expression, default: "0 2 * * *" = 2 AM daily)
  max_pages:        integer (default: ADMIN_CRAWLER_MAX_PAGES)
  timeout_per_page: integer (seconds, default: 30)
  excluded_paths:   array of string (e.g., ["/admin/*", "/api/*"])
  check_external_links: boolean (default: true)
  check_images:     boolean (default: true)
  check_accessibility: boolean (default: true)
  take_screenshots: boolean (default: false)  // For pages with errors
}
```

Example issue:

```
CrawlIssue {
  type: "broken_link",
  severity: "error",
  element: "<a href='/products/nonexistent'>View product</a>",
  message: "Link points to /products/nonexistent which returns 404",
  suggested_fix: "Update link destination or remove if product no longer exists",
  found_at: "div.product-card > a"
}

CrawlIssue {
  type: "missing_meta",
  severity: "warning",
  element: "page",
  message: "Meta description is missing",
  suggested_fix: "Add meta description tag: <meta name='description' content='...'>",
  found_at: "<head>"
}

CrawlIssue {
  type: "slow_load",
  severity: "warning",
  element: "page",
  message: "Page took 4.2s to load (threshold: 3s)",
  suggested_fix: "Optimize images, reduce JavaScript bundle size, use caching",
  found_at: "overall"
}
```

### API Routes

#### POST `/admin/api/crawler/run`

Trigger a crawl immediately (admin only).

**Request:**
```
{
  max_pages: integer (optional, override default),
  excluded_paths: array of string (optional)
}
```

**Response:**
```
{
  crawl_id:   string
  status:     "pending"
  started_at: datetime
  message:    "Crawl started. Results will appear in dashboard."
}
```

#### GET `/admin/api/crawler/runs`

List past crawl runs (admin only). Paginated, newest first.

**Query params:**
```
status:      "pending" | "in_progress" | "completed" | "failed" (optional)
limit:       integer (default: 20)
offset:      integer (default: 0)
```

**Response:**
```
{
  runs: [
    {
      id:               string
      started_at:       datetime
      completed_at:     datetime
      status:           string
      pages_crawled:    integer
      pages_with_issues: integer
      total_issues:     integer
    },
    ...
  ],
  total: integer
}
```

#### GET `/admin/api/crawler/runs/:crawlId/results`

Get results from a specific crawl (admin only). Filterable by severity, issue type, path.

**Query params:**
```
severity:    "error" | "warning" | "info" (optional)
type:        "broken_link" | "missing_meta" | "slow_load" | "console_error" | ... (optional)
path:        string (filter by URL path, optional)
limit:       integer (default: 50)
offset:      integer (default: 0)
```

**Response:**
```
{
  crawl_id:       string
  started_at:     datetime
  completed_at:   datetime
  status:         string
  results: [
    {
      id:               string
      url:              string
      path:             string
      status_code:      integer
      load_time_ms:     integer
      issues: [
        {
          type:           string
          severity:       string
          message:        string
          suggested_fix:  string
        },
        ...
      ],
      fcp_ms:           integer
      lcp_ms:           integer
      cls_score:        number
    },
    ...
  ],
  pagination: {
    offset:  integer
    limit:   integer
    total:   integer
  },
  summary: {
    total_issues:      integer
    errors:            integer
    warnings:          integer
    info:              integer
    avg_load_time_ms:  integer
    pages_with_issues: integer
  }
}
```

#### GET `/admin/api/crawler/config`

Get current crawler configuration (admin only).

**Response:**
```
{
  enabled:           boolean
  frequency:         string (cron)
  max_pages:         integer
  timeout_per_page:  integer
  excluded_paths:    array of string
  check_external_links: boolean
  check_images:      boolean
  check_accessibility: boolean
  take_screenshots:  boolean
  last_run_at:       datetime
  next_scheduled_run: datetime
}
```

#### PATCH `/admin/api/crawler/config`

Update crawler configuration (admin only).

**Request:**
```
{
  enabled:           boolean (optional)
  frequency:         string (optional)
  max_pages:         integer (optional)
  excluded_paths:    array of string (optional)
  check_external_links: boolean (optional)
  check_images:      boolean (optional)
  check_accessibility: boolean (optional)
}
```

**Response:**
```
{
  status: "updated",
  config: { ... }
}
```

### Implementation

#### Crawler Engine

```pseudocode
class AdminCrawler {
  constructor(config: CrawlConfiguration) {
    this.config = config
  }

  async runCrawl() {
    let crawlId = generateUUID()
    let crawlRun = await db.crawl_runs.insert({
      id: crawlId,
      started_at: now(),
      status: "in_progress",
      configuration: this.config
    })

    let pages = await this.discoverPages()

    if (pages.length > this.config.max_pages) {
      pages = pages.slice(0, this.config.max_pages)
    }

    let results = []
    let errors = []

    for each page in pages:
      try {
        let result = await this.crawlPage(page, crawlId)
        results.push(result)

        // Save result immediately
        await db.crawl_results.insert(result)

        // Log progress
        console.log(`[Crawler] Crawled ${page.path}`)

      } catch (err) {
        errors.push(`${page.path}: ${err.message}`)
        console.error(`[Crawler] Error crawling ${page.path}:`, err)
      }

      // Rate limiting: wait 500ms between requests
      await sleep(500)
    }

    // Complete crawl run
    let pagesWithIssues = await db.crawl_results
      .find({ crawl_id: crawlId, issues: { $ne: [] } })
      .count()

    let totalIssues = await db.crawl_results
      .aggregate([
        { $match: { crawl_id: crawlId } },
        { $group: { _id: null, count: { $sum: { $size: "$issues" } } } }
      ])

    await db.crawl_runs.update(
      { id: crawlId },
      {
        completed_at: now(),
        status: "completed",
        pages_crawled: pages.length,
        pages_with_issues: pagesWithIssues,
        total_issues: totalIssues?.count || 0,
        errors: errors
      }
    )

    return crawlRun
  }

  private async crawlPage(page: { path: string, url: string }, crawlId: string) {
    let startTime = Date.now()
    let result = {
      id: generateUUID(),
      crawl_id: crawlId,
      run_at: now(),
      url: page.url,
      path: page.path,
      issues: [],
      console_errors: [],
      console_warnings: [],
      redirects: 0,
      redirect_chain: []
    }

    try {
      // Fetch page with Puppeteer/Playwright to execute JavaScript
      let browser = await this.openBrowser()
      let page = await browser.newPage()

      // Intercept requests to detect broken links, images
      let resourceErrors = []
      page.on("requestfailed", (request) => {
        resourceErrors.push({
          url: request.url(),
          error: request.failure().errorText
        })
      })

      // Capture console messages
      page.on("console", (msg) => {
        if (msg.type() === "error") {
          result.console_errors.push(msg.text())
        } else if (msg.type() === "warning") {
          result.console_warnings.push(msg.text())
        }
      })

      // Navigate to page
      let response = await page.goto(page.url, {
        waitUntil: "networkidle2",
        timeout: this.config.timeout_per_page * 1000
      })

      result.status_code = response.status()
      result.load_time_ms = Date.now() - startTime

      // Check for redirects
      let redirectChain = response.request().redirectChain()
      result.redirects = redirectChain.length
      result.redirect_chain = redirectChain.map(r => r.url())

      // Extract metadata
      result.title_tag = await page.$eval("title", el => el.textContent).catch(() => null)
      result.meta_description = await page.$eval(
        "meta[name='description']",
        el => el.getAttribute("content")
      ).catch(() => null)

      result.canonical_url = await page.$eval(
        "link[rel='canonical']",
        el => el.getAttribute("href")
      ).catch(() => null)

      result.robots_meta = await page.$eval(
        "meta[name='robots']",
        el => el.getAttribute("content")
      ).catch(() => null)

      // Check performance metrics
      let metrics = await page.metrics()
      result.fcp_ms = metrics.FirstContentfulPaint || null
      result.lcp_ms = metrics.LargestContentfulPaint || null

      let cls = await page.evaluate(() => {
        return new PerformanceObserver((list) => {
          let sum = 0
          for (const entry of list.getEntries()) {
            if (!entry.hadRecentInput) {
              sum += entry.value
            }
          }
          return sum
        }).observe({ entryTypes: ["layout-shift"] })
      }).catch(() => 0)
      result.cls_score = cls

      // Check for issues
      await this.checkIssues(page, result)

      // Check resource errors
      for each error in resourceErrors:
        result.issues.push({
          type: "broken_link",
          severity: "error",
          element: error.url,
          message: `Resource failed to load: ${error.error}`,
          found_at: error.url
        })

      await page.close()
      await browser.close()

    } catch (err) {
      result.status_code = 0
      result.issues.push({
        type: "crawl_error",
        severity: "error",
        message: err.message,
        element: page.url,
        found_at: "overall"
      })
    }

    return result
  }

  private async checkIssues(page, result) {
    // Check page load time
    if (result.load_time_ms > 3000) {
      result.issues.push({
        type: "slow_load",
        severity: "warning",
        message: `Page took ${result.load_time_ms}ms to load (threshold: 3000ms)`,
        suggested_fix: "Optimize images, reduce JavaScript, enable caching",
        element: "overall",
        found_at: "page"
      })
    }

    // Check meta tags
    if (!result.title_tag) {
      result.issues.push({
        type: "missing_meta",
        severity: "warning",
        message: "Missing <title> tag",
        suggested_fix: "Add: <title>Page Title</title>",
        found_at: "<head>"
      })
    }

    if (!result.meta_description) {
      result.issues.push({
        type: "missing_meta",
        severity: "warning",
        message: "Missing meta description",
        suggested_fix: "Add: <meta name='description' content='...'>",
        found_at: "<head>"
      })
    }

    // Check redirect chains
    if (result.redirects > 1) {
      result.issues.push({
        type: "redirect_chain",
        severity: "warning",
        message: `Redirect chain of ${result.redirects} hops detected`,
        suggested_fix: "Update links to point directly to final destination",
        element: result.redirect_chain.join(" → "),
        found_at: "page"
      })
    }

    if (this.config.check_images) {
      // Check for images without alt text
      let imagesWithoutAlt = await page.$$eval(
        "img:not([alt])",
        (els) => els.map(el => el.src)
      ).catch(() => [])

      for each img in imagesWithoutAlt:
        result.issues.push({
          type: "accessibility",
          severity: "warning",
          message: "Image missing alt text",
          suggested_fix: "Add alt attribute: <img src='...' alt='description'>",
          element: img,
          found_at: "img[src='" + img + "']"
        })
    }

    // Check for console errors
    if (result.console_errors.length > 0) {
      for each error in result.console_errors.slice(0, 5):  // Limit to 5
        result.issues.push({
          type: "console_error",
          severity: "error",
          message: error.substring(0, 200),  // Truncate long errors
          element: "console",
          found_at: "browser console"
        })
    }

    // Check response status
    if (result.status_code >= 400) {
      result.issues.push({
        type: "broken_page",
        severity: "error",
        message: `Page returned ${result.status_code}`,
        suggested_fix: "Check page exists and is accessible",
        element: result.url,
        found_at: "overall"
      })
    }
  }

  private async discoverPages() {
    // Get all registered routes from RouteRegistry
    let routes = getRouteRegistry().all()
    let pages = []

    for each route in routes:
      if (this.isExcludedPath(route.path)) {
        continue
      }

      // For dynamic routes like /users/:id, use sample values
      let url = this.interpolatePath(route.path)

      pages.push({
        path: route.path,
        url: url,
        render: route.render
      })

    return pages
  }

  private isExcludedPath(path: string) {
    for each pattern in this.config.excluded_paths:
      if (this.pathMatches(path, pattern)) {
        return true
      }
    return false
  }

  private pathMatches(path: string, pattern: string) {
    // Simple glob matching: /admin/* matches /admin, /admin/users, etc.
    if (pattern.endsWith("/*")) {
      let prefix = pattern.substring(0, pattern.length - 2)
      return path.startsWith(prefix)
    }
    return path === pattern
  }

  private interpolatePath(path: string) {
    // /users/:id → /users/sample-user-id
    return path.replace(/:(\w+)/g, (match, param) => {
      let samples = {
        id: "sample-id",
        userId: "sample-user-id",
        productId: "sample-product-id"
      }
      return samples[param] || "sample-" + param
    })
  }
}
```

#### Scheduled Crawler Job

```pseudocode
job AdminCrawlerJob {
  async run() {
    let config = await db.crawl_configurations.findOne({})

    if (!config || !config.enabled) {
      console.log("[Crawler] Crawler disabled")
      return
    }

    console.log("[Crawler] Starting crawl job")

    let crawler = new AdminCrawler(config)

    try {
      await crawler.runCrawl()
      console.log("[Crawler] Crawl completed successfully")
    } catch (err) {
      console.error("[Crawler] Crawl failed:", err)

      // Log failure
      await db.crawl_runs.insert({
        id: generateUUID(),
        started_at: now(),
        completed_at: now(),
        status: "failed",
        errors: [err.message]
      })
    }

    // Clean up old crawl results (older than 90 days)
    let cutoff = new Date(Date.now() - 90 * 86400000)
    await db.crawl_results.deleteMany({ run_at: { $lt: cutoff } })
    await db.crawl_runs.deleteMany({ started_at: { $lt: cutoff } })
  }
}

// Schedule based on config (default: 2 AM daily)
schedule(AdminCrawlerJob, "0 2 * * *")
```

### Admin UI

#### Crawler Dashboard

```pseudocode
component AdminCrawlerDashboard() {
  let [runs, setRuns] = useState([])
  let [selectedRun, setSelectedRun] = useState(null)
  let [results, setResults] = useState([])
  let [loading, setLoading] = useState(true)
  let [running, setRunning] = useState(false)

  useEffect(() => {
    fetchRuns()
    // Poll for new runs every 30s if one is in progress
    let interval = setInterval(fetchRuns, 30000)
    return () => clearInterval(interval)
  }, [])

  async function fetchRuns() {
    let response = await fetch("/admin/api/crawler/runs")
    let data = await response.json()
    setRuns(data.runs)
    setLoading(false)

    // Auto-select latest run
    if (data.runs.length > 0 && !selectedRun) {
      setSelectedRun(data.runs[0].id)
    }
  }

  async function fetchResults(crawlId) {
    let response = await fetch(`/admin/api/crawler/runs/${crawlId}/results`)
    let data = await response.json()
    setResults(data.results)
  }

  async function triggerCrawl() {
    setRunning(true)
    try {
      let response = await fetch("/admin/api/crawler/run", { method: "POST" })
      let data = await response.json()
      setSelectedRun(data.crawl_id)
      fetchRuns()
    } finally {
      setRunning(false)
    }
  }

  return (
    <div class="crawler-dashboard">
      <h2>Admin Crawler</h2>

      <div class="crawler-controls">
        <button onClick={triggerCrawl} disabled={running}>
          {running ? "Crawl running..." : "Run Crawl Now"}
        </button>
        <a href="/admin/crawler/config" class="link-button">Configure</a>
      </div>

      <div class="crawler-runs">
        <h3>Recent Crawls</h3>
        {loading ? (
          <Spinner />
        ) : runs.length === 0 ? (
          <p>No crawls yet</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Duration</th>
                <th>Pages</th>
                <th>Issues</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {runs.map(run => (
                <tr key={run.id}>
                  <td>{formatDate(run.started_at)}</td>
                  <td>{run.completed_at ? Math.round((new Date(run.completed_at) - new Date(run.started_at)) / 1000) + "s" : "-"}</td>
                  <td>{run.pages_crawled}</td>
                  <td>
                    <span class={`badge badge-${run.total_issues === 0 ? "success" : "danger"}`}>
                      {run.total_issues}
                    </span>
                  </td>
                  <td>{run.status}</td>
                  <td>
                    <button onClick={() => {
                      setSelectedRun(run.id)
                      fetchResults(run.id)
                    }}>
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selectedRun && (
        <CrawlerResults crawlId={selectedRun} results={results} />
      )}
    </div>
  )
}

component CrawlerResults({ crawlId, results }) {
  let [filters, setFilters] = useState({
    severity: null,
    type: null,
    path: null
  })

  let filtered = results.filter(r => {
    if (filters.path && !r.path.includes(filters.path)) return false
    if (filters.severity && !r.issues.some(i => i.severity === filters.severity)) return false
    if (filters.type && !r.issues.some(i => i.type === filters.type)) return false
    return true
  })

  return (
    <div class="crawler-results">
      <h3>Results</h3>

      <div class="result-filters">
        <input
          type="text"
          placeholder="Filter by path"
          value={filters.path || ""}
          onChange={(e) => setFilters({ ...filters, path: e.target.value })}
        />
        <select
          value={filters.severity || ""}
          onChange={(e) => setFilters({ ...filters, severity: e.target.value })}
        >
          <option value="">All severities</option>
          <option value="error">Errors</option>
          <option value="warning">Warnings</option>
          <option value="info">Info</option>
        </select>
      </div>

      <div class="results-table">
        {filtered.map(result => (
          <div key={result.id} class="result-card">
            <h4>{result.path}</h4>
            <div class="result-meta">
              <span class={`status status-${result.status_code}`}>{result.status_code}</span>
              <span class="load-time">{result.load_time_ms}ms</span>
            </div>

            {result.issues.length > 0 ? (
              <div class="issues-list">
                {result.issues.map((issue, i) => (
                  <div key={i} class={`issue issue-${issue.severity}`}>
                    <div class="issue-header">
                      <span class="issue-type">{issue.type}</span>
                      <span class={`issue-severity severity-${issue.severity}`}>{issue.severity}</span>
                    </div>
                    <p class="issue-message">{issue.message}</p>
                    <p class="issue-fix">{issue.suggested_fix}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p class="no-issues">✓ No issues found</p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
```

---

## Part 2: Audit Log Viewer

### Overview

Admin page showing searchable, filterable log of all system events:
- User login/logout
- Resource creation/update/deletion
- Admin actions (role changes, bulk operations)
- Permission changes
- API access
- Data exports

Columns: timestamp, user, action, resource, details, IP address. Paginated, with CSV export. Configurable retention policy.

### Data Model

```
AuditLog {
  id:              string (auto-generated UUID)
  timestamp:       datetime
  user_id:         string (who performed the action)
  user_email:      string (for easy reference)
  action:          string (e.g., "user_created", "file_deleted", "role_changed")
  resource_type:   string (e.g., "User", "Product", "File")
  resource_id:     string (ID of the affected resource)
  resource_name:   string (human-readable, e.g., "John Doe", "Product ABC")
  changes:         object (before/after values if update)
  details:         string (additional context)
  ip_address:      string
  user_agent:      string
  session_id:      string
  status:          "success" | "failure"
  error_message:   string (if status = failure)
}
```

Example entries:

```
AuditLog {
  timestamp: "2025-03-26T10:30:00Z",
  user_id: "admin-1",
  user_email: "admin@example.com",
  action: "user_created",
  resource_type: "User",
  resource_id: "user-123",
  resource_name: "John Doe",
  changes: null,
  details: "Created user via admin panel",
  ip_address: "192.168.1.100",
  status: "success"
}

AuditLog {
  timestamp: "2025-03-26T10:31:00Z",
  user_id: "admin-1",
  user_email: "admin@example.com",
  action: "role_changed",
  resource_type: "User",
  resource_id: "user-456",
  resource_name: "Jane Smith",
  changes: {
    before: { role: "user" },
    after: { role: "admin" }
  },
  details: "Promoted to admin",
  ip_address: "192.168.1.100",
  status: "success"
}

AuditLog {
  timestamp: "2025-03-26T10:32:00Z",
  user_id: "user-789",
  user_email: "john@example.com",
  action: "login",
  resource_type: "Session",
  resource_id: "session-abc",
  resource_name: null,
  changes: null,
  details: "Login via email",
  ip_address: "203.0.113.42",
  status: "success"
}

AuditLog {
  timestamp: "2025-03-26T10:33:00Z",
  user_id: "user-789",
  user_email: "john@example.com",
  action: "file_download",
  resource_type: "File",
  resource_id: "file-xyz",
  resource_name: "Report-2025-Q1.pdf",
  details: "Downloaded via API",
  ip_address: "203.0.113.42",
  status: "success"
}
```

### API Routes

#### GET `/admin/api/audit-logs`

List audit logs (admin only). Searchable, filterable, paginated.

**Query params:**
```
action:      string (filter by action type, optional)
user_id:     string (filter by user, optional)
resource_type: string (filter by resource type, optional)
from_date:   datetime (start of date range, optional)
to_date:     datetime (end of date range, optional)
search:      string (full-text search in details/resource_name, optional)
status:      "success" | "failure" (optional)
page:        integer (default: 1)
limit:       integer (default: 50)
```

**Response:**
```
{
  logs: [
    {
      id:              string
      timestamp:       datetime
      user_email:      string
      action:          string
      resource_type:   string
      resource_name:   string
      details:         string
      ip_address:      string
      status:          string
    },
    ...
  ],
  pagination: {
    page:       integer
    limit:      integer
    total:      integer
    pages:      integer
  }
}
```

#### POST `/admin/api/audit-logs/export`

Export audit logs to CSV (admin only).

**Request:**
```
{
  format:      "csv" (required)
  from_date:   datetime (optional)
  to_date:     datetime (optional)
  filters:     object (same as GET params)
}
```

**Response:**
```
CSV file download
timestamp,user_email,action,resource_type,resource_name,details,ip_address,status
...
```

#### GET `/admin/api/audit-logs/config`

Get audit log configuration (admin only).

**Response:**
```
{
  retention_days:  integer
  sample_actions:  array of string (common action types)
  sample_resources: array of string (common resource types)
}
```

### Global Audit Logging Middleware

Every action that modifies state should log an audit entry:

```pseudocode
middleware auditMiddleware(request, response, next) {
  let originalSend = response.send
  let originalJson = response.json

  // Intercept response to see if mutation succeeded
  response.send = function(data) {
    if (request.method !== "GET" && response.statusCode < 400) {
      logAuditEntry(request, response, data)
    }
    return originalSend.call(this, data)
  }

  response.json = function(data) {
    if (request.method !== "GET" && response.statusCode < 400) {
      logAuditEntry(request, response, data)
    }
    return originalJson.call(this, data)
  }

  next()
}

function logAuditEntry(request, response, responseData) {
  let action = determineAction(request.method, request.path)
  let resourceInfo = parseResourceFromRequest(request)

  let logEntry = {
    id: generateUUID(),
    timestamp: now(),
    user_id: request.user?.id,
    user_email: request.user?.email,
    action: action,
    resource_type: resourceInfo.type,
    resource_id: resourceInfo.id,
    resource_name: resourceInfo.name,
    details: request.body?.description || `${request.method} ${request.path}`,
    ip_address: request.ip,
    user_agent: request.headers["user-agent"],
    session_id: request.session?.id,
    status: "success",
    changes: request.body  // Store what was sent
  }

  db.audit_logs.insert(logEntry)
}

function determineAction(method, path) {
  if (method === "POST" && path.includes("/users")) return "user_created"
  if (method === "PATCH" && path.includes("/users")) return "user_updated"
  if (method === "DELETE" && path.includes("/users")) return "user_deleted"
  if (method === "POST" && path.includes("/roles")) return "role_assigned"
  if (method === "DELETE" && path.includes("/roles")) return "role_removed"
  if (method === "POST" && path.includes("/login")) return "login"
  if (method === "POST" && path.includes("/logout")) return "logout"
  // ... more mappings
  return `${method.toLowerCase()}_${path.replace(/[^a-z0-9_]/gi, "_")}`
}
```

### Admin UI

#### Audit Log Viewer

```pseudocode
component AuditLogViewer() {
  let [logs, setLogs] = useState([])
  let [loading, setLoading] = useState(true)
  let [page, setPage] = useState(1)
  let [total, setTotal] = useState(0)
  let [filters, setFilters] = useState({
    action: null,
    user_id: null,
    from_date: null,
    to_date: null,
    search: null
  })
  let [exporting, setExporting] = useState(false)

  useEffect(() => {
    fetchLogs()
  }, [page, filters])

  async function fetchLogs() {
    setLoading(true)

    let params = new URLSearchParams()
    params.append("page", page)
    params.append("limit", 50)

    for each [key, value] in filters:
      if (value) params.append(key, value)

    let response = await fetch(`/admin/api/audit-logs?${params}`)
    let data = await response.json()

    setLogs(data.logs)
    setTotal(data.pagination.total)
    setLoading(false)
  }

  async function handleExport() {
    setExporting(true)

    try {
      let response = await fetch("/admin/api/audit-logs/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          format: "csv",
          filters: filters
        })
      })

      let blob = await response.blob()
      let url = URL.createObjectURL(blob)
      let a = document.createElement("a")
      a.href = url
      a.download = `audit-logs-${formatDate(now())}.csv`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div class="audit-log-viewer">
      <h2>Audit Logs</h2>

      <div class="audit-controls">
        <div class="filter-group">
          <input
            type="text"
            placeholder="Search by user, action, details..."
            value={filters.search || ""}
            onChange={(e) => {
              setFilters({ ...filters, search: e.target.value })
              setPage(1)
            }}
          />

          <input
            type="date"
            value={filters.from_date || ""}
            onChange={(e) => {
              setFilters({ ...filters, from_date: e.target.value })
              setPage(1)
            }}
          />

          <input
            type="date"
            value={filters.to_date || ""}
            onChange={(e) => {
              setFilters({ ...filters, to_date: e.target.value })
              setPage(1)
            }}
          />

          <button onClick={() => {
            setFilters({
              action: null,
              user_id: null,
              from_date: null,
              to_date: null,
              search: null
            })
            setPage(1)
          }}>
            Clear Filters
          </button>
        </div>

        <button onClick={handleExport} disabled={exporting}>
          {exporting ? "Exporting..." : "Export CSV"}
        </button>
      </div>

      {loading ? (
        <Spinner />
      ) : logs.length === 0 ? (
        <p>No audit logs found</p>
      ) : (
        <>
          <table class="audit-table">
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>User</th>
                <th>Action</th>
                <th>Resource</th>
                <th>Details</th>
                <th>IP Address</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {logs.map(log => (
                <tr key={log.id} class={`status-${log.status}`}>
                  <td>{formatDateTime(log.timestamp)}</td>
                  <td>{log.user_email || "(system)"}</td>
                  <td><code>{log.action}</code></td>
                  <td>{log.resource_type}: {log.resource_name}</td>
                  <td class="details-cell">{log.details}</td>
                  <td><code>{log.ip_address}</code></td>
                  <td>
                    <span class={`badge status-${log.status}`}>
                      {log.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <Pagination
            page={page}
            total={total}
            limit={50}
            onChange={(p) => setPage(p)}
          />
        </>
      )}
    </div>
  )
}

.audit-table {
  width: 100%
  border-collapse: collapse
  font-size: 13px

  td, th {
    padding: 8px
    border-bottom: 1px solid #ddd
    text-align: left
  }

  th {
    background: #f5f5f5
    font-weight: 600
    position: sticky
    top: 0
  }

  tr.status-failure {
    background: #fff5f5
  }

  .details-cell {
    max-width: 300px
    overflow: hidden
    text-overflow: ellipsis
    white-space: nowrap
  }

  code {
    background: #f5f5f5
    padding: 2px 4px
    border-radius: 3px
    font-family: monospace
    font-size: 12px
  }
}
```

---

## Gotchas & Edge Cases

### Crawler Gotchas

#### 1. Dynamic Routes Have No Real Data

**Problem**: Route `/products/:productId` can't be crawled without real product IDs.

**Solution**: Use sample/test data for crawling, or skip dynamic routes:

```pseudocode
private shouldCrawlRoute(route: RouteConfig) {
  // Skip auth-required routes (would get 401)
  if (route.auth !== "public") return false

  // Skip highly dynamic routes
  if (route.path.includes("/:")) return false

  return true
}
```

#### 2. Crawler Blocks Server While Running

**Problem**: Crawler uses real HTTP requests; if it runs during high traffic, it competes with real users.

**Solution**: Run crawler during low-traffic hours (2 AM), use separate crawl user agent to identify it:

```
User-Agent: MyApp-AdminCrawler/1.0
```

Then rate-limit it in middleware:

```pseudocode
if (request.headers["user-agent"].includes("AdminCrawler")) {
  // Rate limit crawler to 1 request per second
  await rateLimit(request.ip, { limit: 1, window: 1000 })
}
```

#### 3. Screenshots Consume Disk Space

**Problem**: Taking screenshots of 1000 pages uses lots of storage.

**Solution**: Only take screenshots for pages with errors, or disable entirely:

```
take_screenshots: false  // Default
```

#### 4. External Link Checking is Slow

**Problem**: Checking external links (links to other sites) can be slow if external site is slow.

**Solution**: Add timeout, or skip external links:

```pseudocode
check_external_links: false  // Default, only check internal links
```

### Audit Log Gotchas

#### 1. Audit Log Table Grows Unbounded

**Problem**: Audit logs grow indefinitely; storage usage increases.

**Solution**: Set retention policy and auto-delete old logs:

```pseudocode
// Run daily
job PruneAuditLogsJob {
  let cutoff = new Date(Date.now() - AUDIT_LOG_RETENTION_DAYS * 86400000)
  await db.audit_logs.deleteMany({ timestamp: { $lt: cutoff } })
}
```

#### 2. PII in Audit Logs

**Problem**: Audit logs might contain sensitive data (passwords, API keys in request body).

**Solution**: Sanitize request body before logging:

```pseudocode
function sanitizeBody(body: object) {
  let sensitive = ["password", "token", "api_key", "secret", "credit_card"]

  let sanitized = { ...body }
  for each field in sensitive:
    if (field in sanitized) {
      sanitized[field] = "[REDACTED]"
    }

  return sanitized
}
```

#### 3. Audit Log Search is Slow

**Problem**: Full-text search on large audit log table is slow.

**Solution**: Add indexes:

```pseudocode
db.audit_logs.createIndex({ timestamp: -1 })
db.audit_logs.createIndex({ user_id: 1 })
db.audit_logs.createIndex({ action: 1 })
db.audit_logs.createIndex({ resource_type: 1, resource_id: 1 })
```

#### 4. User Deletes Their Account; Audit Logs Reference Deleted User

**Problem**: Foreign key constraint violated when user is deleted.

**Solution**: Don't delete audit logs; keep them but mark user as deleted:

```pseudocode
// When deleting user, don't cascade delete audit logs
// Instead, just set user_id to null and keep user_email for reference

AuditLog {
  user_id: null  // User deleted
  user_email: "john@example.com"  // Keep for reference
}
```

---

## Summary: Admin Enhancements Checklist

- [ ] **Crawler Job**: Runs on schedule (default: daily at 2 AM)
- [ ] **Crawler Config**: Allowed routes, excluded paths, max pages, timeouts
- [ ] **Crawler Issues**: Broken links, missing meta, slow loads, console errors, accessibility
- [ ] **Crawler Admin UI**: List crawl runs, view results, filter by severity/type/path
- [ ] **Crawl Trigger**: Manual "Run Now" button in admin panel
- [ ] **Audit Logging**: Middleware logs all mutations (POST, PATCH, DELETE)
- [ ] **Audit Actions**: user_created, user_deleted, role_changed, login, logout, etc.
- [ ] **Audit Search**: Full-text search in details, resource name
- [ ] **Audit Filters**: By user, action type, date range, status
- [ ] **Audit Export**: CSV download with all columns
- [ ] **Audit Retention**: Old logs auto-deleted after retention period (default: 90 days)
- [ ] **Audit Indexes**: DB indexes on timestamp, user_id, action, resource_type for query performance
- [ ] **Sensitive Data**: Request bodies sanitized (passwords, tokens redacted) before logging
- [ ] **User Deletion**: Audit logs preserved even if user deleted
