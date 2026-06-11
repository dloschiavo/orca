---
name: Support Enhancements
description: Bug report widget, in-app feedback modal, status page integration
type: enhancement
requires: recipes/contact-support-form.md, recipes/app-config-theming.md
env_vars: FILE_STORAGE_PROVIDER (optional), STATUS_PAGE_URL (optional), ENABLE_IN_APP_FEEDBACK (boolean, default: true), STATUS_PAGE_POLLING_INTERVAL (integer, default: 300000)
---

# Support Enhancements

## Overview

Enhance user support with three integrated systems:
1. **Bug Report Widget** — Floating button that opens form to report bugs with automatic context capture (screenshots, console errors, device info)
2. **In-App Feedback Modal** — Programmatic or persistent UI to collect user feedback, feature requests, and ratings
3. **Status Page Integration** — Live status indicator in app footer showing operational status, synced with external status page API

All feedback and bug reports go to the same support system as `contact-support-form.md`.

---

## Part 1: Bug Report Widget

### Overview

Floating widget (bottom-right) for users to report bugs. Captures:
- User description of the bug
- Steps to reproduce
- Expected vs actual behavior
- Severity level (critical, high, medium, low)
- Automatic context: screenshot (browser API), last 20 console errors, current URL, browser/device info, authenticated user ID

Submissions integrated with existing support system from `contact-support-form.md`.

### Data Model

```
BugReport {
  id:                  string (auto-generated UUID)
  title:               string (required)
  description:         string (required)
  steps_to_reproduce:  string (optional)
  expected_behavior:   string (optional)
  actual_behavior:     string (optional)
  severity:            "critical" | "high" | "medium" | "low" (default: "medium")

  // Automatic context
  screenshot:          string (URL or base64-encoded image, optional)
  console_errors:      array of string (last 20 console errors)
  current_url:         string
  browser_info:        BrowserInfo (see below)
  device_info:         DeviceInfo (see below)
  user_id:             string (if authenticated, null otherwise)
  user_email:          string (if authenticated)

  // Attachments
  attachments:         array of Attachment (if FILE_STORAGE_PROVIDER configured)

  // Status
  created_at:          datetime
  updated_at:          datetime
  status:              "open" | "in_progress" | "resolved" | "wontfix"
  assigned_to:         string (admin user_id, optional)
  response:            string (admin response, optional)
}

BrowserInfo {
  name:                string (e.g., "Chrome", "Firefox", "Safari")
  version:             string
  user_agent:          string
  locale:              string (e.g., "en-US")
  language:            string
  cookies_enabled:     boolean
  storage_available:   object { local: bytes, session: bytes, indexed_db: boolean }
}

DeviceInfo {
  type:                "desktop" | "tablet" | "mobile"
  os:                  string (e.g., "Windows 10", "iOS 15")
  screen_size:         { width: integer, height: integer }
  viewport_size:       { width: integer, height: integer }
  pixel_ratio:         number
  timezone:            string
  memory_available:    integer (MB)
  connection:          { type: string, speed: string } (optional)
}

Attachment {
  id:                  string
  filename:            string
  size:                integer (bytes)
  mime_type:           string
  url:                 string (storage provider URL)
  uploaded_at:         datetime
}
```

### API Routes

#### POST `/api/bug-reports`

Submit a bug report.

**Request:**
```
{
  title:               string (required)
  description:         string (required)
  steps_to_reproduce:  string (optional)
  expected_behavior:   string (optional)
  actual_behavior:     string (optional)
  severity:            "critical" | "high" | "medium" | "low"
  screenshot:          File (optional, multipart upload)
  attachments:         [File] (optional, multipart upload)
}
```

**Response:**
```
{
  id:            string
  status:        "open"
  created_at:    datetime
  message:       "Thank you for the bug report! We'll look into it."
}
```

**Side effects:**
- Generate screenshot from browser if user permits
- Capture last 20 console errors
- Store browser/device info
- Log submission: "bug_report_submitted" with report_id
- Send email notification to support team
- (Optional) Create ticket in external issue tracker (Jira, Linear, etc.)

#### GET `/api/bug-reports/:reportId`

Retrieve bug report status (user can check via link in email).

**Response:**
```
{
  id:          string
  title:       string
  status:      "open" | "in_progress" | "resolved" | "wontfix"
  created_at:  datetime
  updated_at:  datetime
  response:    string (admin message, if any)
  assigned_to: string (admin name, if any)
}
```

#### GET `/admin/api/bug-reports`

List all bug reports (admin only). Searchable, filterable, paginated.

**Query params:**
```
status:    "open" | "in_progress" | "resolved" | "wontfix" (optional)
severity:  "critical" | "high" | "medium" | "low" (optional)
search:    string (search in title + description)
assigned:  string (filter by assignee user_id, optional)
from_date: datetime (optional)
to_date:   datetime (optional)
page:      integer (default: 1)
limit:     integer (default: 20)
```

**Response:**
```
{
  reports: [
    {
      id:              string
      title:           string
      description:     string
      severity:        string
      status:          string
      user_id:         string
      user_email:      string
      created_at:      datetime
      updated_at:      datetime
      assigned_to:     string
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

#### PATCH `/admin/api/bug-reports/:reportId`

Update bug report (admin only).

**Request:**
```
{
  status:      "open" | "in_progress" | "resolved" | "wontfix"
  assigned_to: string (admin user_id, optional)
  response:    string (admin message)
}
```

**Response:**
```
{
  id:     string
  status: string
  updated_at: datetime
}
```

**Side effects:**
- Log event: "bug_report_updated" with report_id and admin user_id
- Send email to reporter if status changes or response added

### Component Implementation

#### Bug Report Widget (Floating Button)

```pseudocode
component BugReportWidget() {
  let [isOpen, setIsOpen] = useState(false)
  let [isMinimized, setIsMinimized] = useState(false)

  return (
    <div class="bug-report-widget" style={isMinimized ? { width: "50px" } : {}}>
      {!isOpen ? (
        <button
          class="bug-report-button"
          onClick={() => setIsOpen(true)}
          title="Report a bug"
        >
          🐛  {!isMinimized && "Report Bug"}
        </button>
      ) : (
        <BugReportForm
          onClose={() => setIsOpen(false)}
          onMinimize={() => setIsMinimized(!isMinimized)}
        />
      )}
    </div>
  )
}

// CSS positioning (bottom-right, fixed)
.bug-report-widget {
  position: fixed
  bottom: 20px
  right: 20px
  width: 400px
  max-width: 90vw
  z-index: 9999
  font-family: var(--font-family)
  box-shadow: 0 4px 12px rgba(0,0,0,0.15)
  border-radius: 8px
  background: white

  @media (max-width: 640px) {
    width: 90vw
    bottom: 10px
    right: 10px
  }
}

.bug-report-button {
  width: 100%
  padding: 12px 16px
  background: #f44747  // red for bug icon
  color: white
  border: none
  border-radius: 8px
  font-size: 14px
  font-weight: 600
  cursor: pointer
  transition: background 200ms ease

  &:hover {
    background: #e63946
  }
}
```

#### Bug Report Form Component

```pseudocode
component BugReportForm({ onClose, onMinimize }) {
  let [formData, setFormData] = useState({
    title: "",
    description: "",
    steps_to_reproduce: "",
    expected_behavior: "",
    actual_behavior: "",
    severity: "medium",
    include_screenshot: true,
    include_console_errors: true,
    attachments: []
  })

  let [submitting, setSubmitting] = useState(false)
  let [submitted, setSubmitted] = useState(false)
  let [error, setError] = useState(null)
  let [preview, setPreview] = useState(null)

  async function handleSubmit() {
    // Validate required fields
    if (!formData.title || !formData.description) {
      setError("Title and description are required")
      return
    }

    setSubmitting(true)
    setError(null)

    try {
      // Capture automatic context
      let context = await captureContext(formData)

      // Submit
      let response = await fetch("/api/bug-reports", {
        method: "POST",
        body: context.formData  // multipart with attachments
      })

      if (!response.ok) {
        throw new Error(await response.text())
      }

      let result = await response.json()

      setSubmitted(true)

      // Show success message with link to check status
      setTimeout(() => {
        onClose()
      }, 3000)

    } catch (err) {
      setError(err.message || "Failed to submit report")
    }

    setSubmitting(false)
  }

  async function captureContext(data) {
    let formData = new FormData()

    // Add form fields
    formData.append("title", data.title)
    formData.append("description", data.description)
    formData.append("steps_to_reproduce", data.steps_to_reproduce)
    formData.append("expected_behavior", data.expected_behavior)
    formData.append("actual_behavior", data.actual_behavior)
    formData.append("severity", data.severity)

    // Capture screenshot
    if (data.include_screenshot) {
      try {
        let screenshot = await takeScreenshot()
        formData.append("screenshot", screenshot, "screenshot.png")
      } catch (err) {
        console.warn("Failed to capture screenshot:", err)
      }
    }

    // Capture console errors
    if (data.include_console_errors) {
      let consoleErrors = getConsoleErrors()
      formData.append("console_errors", JSON.stringify(consoleErrors))
    }

    // Add user attachments
    for each file in data.attachments:
      formData.append("attachments", file)

    // Add context (automatic)
    formData.append("context", JSON.stringify({
      url: window.location.href,
      browser: getBrowserInfo(),
      device: getDeviceInfo(),
      user_id: getCurrentUser()?.id,
      user_email: getCurrentUser()?.email
    }))

    return formData
  }

  if (submitted) {
    return (
      <div class="bug-report-success">
        <h3>✓ Thank you!</h3>
        <p>Your bug report has been submitted. We'll look into it.</p>
        <p class="small">You can check the status via the email we sent you.</p>
        <button onClick={onClose}>Close</button>
      </div>
    )
  }

  return (
    <form class="bug-report-form" onSubmit={(e) => { e.preventDefault(); handleSubmit() }}>
      <div class="bug-report-header">
        <h3>Report a Bug</h3>
        <div class="controls">
          <button type="button" onClick={onMinimize} class="minimize-btn" title="Minimize">_</button>
          <button type="button" onClick={onClose} class="close-btn" title="Close">✕</button>
        </div>
      </div>

      <div class="bug-report-body">
        {error && <div class="error-message">{error}</div>}

        <div class="form-group">
          <label htmlFor="title">Title *</label>
          <input
            id="title"
            type="text"
            placeholder="Brief summary of the bug"
            value={formData.title}
            onChange={(e) => setFormData({ ...formData, title: e.target.value })}
            maxLength={200}
            disabled={submitting}
          />
        </div>

        <div class="form-group">
          <label htmlFor="description">Description *</label>
          <textarea
            id="description"
            placeholder="Detailed description of the issue"
            value={formData.description}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            rows={4}
            disabled={submitting}
          />
        </div>

        <div class="form-group">
          <label htmlFor="steps">Steps to Reproduce</label>
          <textarea
            id="steps"
            placeholder="1. Click X\n2. Enter Y\n3. See Z"
            value={formData.steps_to_reproduce}
            onChange={(e) => setFormData({ ...formData, steps_to_reproduce: e.target.value })}
            rows={3}
            disabled={submitting}
          />
        </div>

        <div class="form-row">
          <div class="form-group">
            <label htmlFor="expected">Expected Behavior</label>
            <textarea
              id="expected"
              placeholder="What should happen"
              value={formData.expected_behavior}
              onChange={(e) => setFormData({ ...formData, expected_behavior: e.target.value })}
              rows={2}
              disabled={submitting}
            />
          </div>

          <div class="form-group">
            <label htmlFor="actual">Actual Behavior</label>
            <textarea
              id="actual"
              placeholder="What actually happened"
              value={formData.actual_behavior}
              onChange={(e) => setFormData({ ...formData, actual_behavior: e.target.value })}
              rows={2}
              disabled={submitting}
            />
          </div>
        </div>

        <div class="form-group">
          <label htmlFor="severity">Severity</label>
          <select
            id="severity"
            value={formData.severity}
            onChange={(e) => setFormData({ ...formData, severity: e.target.value })}
            disabled={submitting}
          >
            <option value="low">Low - Minor inconvenience</option>
            <option value="medium">Medium - Affects normal usage</option>
            <option value="high">High - Major issue</option>
            <option value="critical">Critical - App is broken</option>
          </select>
        </div>

        <div class="form-group checkbox">
          <input
            id="include-screenshot"
            type="checkbox"
            checked={formData.include_screenshot}
            onChange={(e) => setFormData({ ...formData, include_screenshot: e.target.checked })}
            disabled={submitting}
          />
          <label htmlFor="include-screenshot">Include screenshot</label>
        </div>

        <div class="form-group checkbox">
          <input
            id="include-console"
            type="checkbox"
            checked={formData.include_console_errors}
            onChange={(e) => setFormData({ ...formData, include_console_errors: e.target.checked })}
            disabled={submitting}
          />
          <label htmlFor="include-console">Include console errors</label>
        </div>

        {FILE_STORAGE_PROVIDER && (
          <div class="form-group">
            <label htmlFor="attachments">Attachments (optional)</label>
            <input
              id="attachments"
              type="file"
              multiple
              onChange={(e) => setFormData({ ...formData, attachments: Array.from(e.target.files) })}
              disabled={submitting}
              accept="image/*,.pdf,.txt"
            />
            <small>Max 5 files, 5MB each</small>
          </div>
        )}

        <div class="privacy-notice">
          <small>
            We'll collect your browser and device info to help us debug the issue.
            <a href="/privacy" target="_blank">Privacy Policy</a>
          </small>
        </div>
      </div>

      <div class="bug-report-footer">
        <button type="button" onClick={onClose} disabled={submitting}>
          Cancel
        </button>
        <button type="submit" class="primary" disabled={submitting}>
          {submitting ? "Submitting..." : "Send Report"}
        </button>
      </div>
    </form>
  )
}
```

#### Context Capture Utilities

```pseudocode
function getBrowserInfo() {
  let ua = navigator.userAgent
  let browser = parseBrowserFromUA(ua)

  return {
    name: browser.name,
    version: browser.version,
    user_agent: ua,
    locale: navigator.language,
    language: navigator.languages[0],
    cookies_enabled: navigator.cookieEnabled,
    storage_available: {
      local: getStorageSize("localStorage"),
      session: getStorageSize("sessionStorage"),
      indexed_db: !!window.indexedDB
    }
  }
}

function getDeviceInfo() {
  return {
    type: getDeviceType(),
    os: getOperatingSystem(),
    screen_size: {
      width: window.screen.width,
      height: window.screen.height
    },
    viewport_size: {
      width: window.innerWidth,
      height: window.innerHeight
    },
    pixel_ratio: window.devicePixelRatio,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    memory_available: navigator.deviceMemory || null,
    connection: navigator.connection ? {
      type: navigator.connection.effectiveType,
      speed: navigator.connection.downlink
    } : null
  }
}

function getConsoleErrors() {
  // Intercept console.error and store last 20
  // (Implement via console error hook)
  return window.__consoleErrors || []
}

async function takeScreenshot() {
  // Use html2canvas or Canvas API to screenshot current viewport
  try {
    let canvas = await html2canvas(document.body, {
      allowTaint: true,
      useCORS: true,
      scale: 1
    })
    return canvas.toBlob(blob => blob)
  } catch (err) {
    console.warn("Screenshot failed:", err)
    return null
  }
}

// Hook console errors globally
function setupConsoleErrorTracking() {
  window.__consoleErrors = []

  let originalError = console.error
  console.error = function(...args) {
    window.__consoleErrors.push({
      timestamp: new Date().toISOString(),
      message: args.join(" ")
    })

    // Keep last 20
    if (window.__consoleErrors.length > 20) {
      window.__consoleErrors.shift()
    }

    originalError.apply(console, args)
  }
}
```

---

## Part 2: In-App Feedback Modal

### Overview

Collect user feedback programmatically or via persistent UI. Types:
- **General Feedback**: Open-ended comments
- **Feature Request**: Suggestion for new feature
- **Rating**: 1-5 stars with optional comment

Stored in database with user context. Admin panel for viewing/responding. Optional NPS-style trigger (after N days or N actions).

### Data Model

```
Feedback {
  id:                 string (auto-generated UUID)
  type:               "general" | "feature_request" | "rating"
  user_id:            string (if authenticated)
  user_email:         string (if authenticated)
  user_context:       FeedbackUserContext (see below)

  // Content
  title:              string (optional, for feature requests)
  message:            string (required)
  rating:             integer (1-5, only for rating type)

  // Screenshots
  include_screenshot: boolean
  screenshot:         string (URL or base64)

  // Status
  created_at:         datetime
  status:             "new" | "seen" | "responded" | "archived"
  response:           string (admin response)
  responded_by:       string (admin user_id)
  responded_at:       datetime

  // Tracking
  page_url:           string
  app_version:        string
  tags:               array of string (admin-assigned)
}

FeedbackUserContext {
  days_active:        integer (days since user joined)
  session_count:      integer (number of sessions)
  feature_usage:      object (which features user has used)
  subscription_plan:  string (if applicable)
  nps_score:          integer (1-10, optional)
}
```

### API Routes

#### POST `/api/feedback`

Submit feedback.

**Request:**
```
{
  type:                "general" | "feature_request" | "rating"
  title:               string (optional, required for feature_request)
  message:             string (required)
  rating:              integer (1-5, required for rating type)
  include_screenshot:  boolean (default: false)
  screenshot:          File (optional, if include_screenshot=true)
}
```

**Response:**
```
{
  id:        string
  status:    "new"
  created_at: datetime
  message:   "Thank you for your feedback!"
}
```

#### GET `/admin/api/feedback`

List all feedback (admin only). Searchable, filterable, paginated.

**Query params:**
```
type:       "general" | "feature_request" | "rating" (optional)
status:     "new" | "seen" | "responded" | "archived" (optional)
search:     string
from_date:  datetime
to_date:    datetime
page:       integer
limit:      integer
```

**Response:**
```
{
  feedback: [
    {
      id:              string
      type:            string
      user_email:      string
      message:         string
      rating:          integer
      status:          string
      created_at:      datetime
      responded_at:    datetime
    },
    ...
  ],
  pagination: { ... }
}
```

#### PATCH `/admin/api/feedback/:feedbackId`

Respond to feedback (admin only).

**Request:**
```
{
  status:   "new" | "seen" | "responded" | "archived"
  response: string (admin message)
}
```

### Component Implementation

#### Feedback Modal Trigger

```pseudocode
component FeedbackTrigger() {
  let [isOpen, setIsOpen] = useState(false)
  let [showPersistentTab, setShowPersistentTab] = useState(true)

  // Optional: Show NPS-style trigger after N days or N actions
  useEffect(() => {
    let userDaysActive = getUserDaysActive()
    let sessionCount = getSessionCount()

    if (userDaysActive >= 7 && sessionCount >= 10) {
      // Show feedback prompt
      setTimeout(() => {
        showFeedbackPrompt()
      }, 2000)
    }
  }, [])

  return (
    <>
      {showPersistentTab && (
        <div class="feedback-tab" onClick={() => setIsOpen(true)}>
          💬 Feedback
        </div>
      )}

      {isOpen && (
        <FeedbackModal onClose={() => setIsOpen(false)} />
      )}
    </>
  )
}

// CSS for persistent tab (side of screen)
.feedback-tab {
  position: fixed
  right: 0
  top: 50%
  transform: translateY(-50%) translateX(50%)
  background: var(--primary-color, #007bff)
  color: white
  padding: 12px 8px
  border-radius: 8px 0 0 8px
  cursor: pointer
  font-weight: 600
  z-index: 9998
  writing-mode: vertical-rl
  text-orientation: mixed
  transition: transform 200ms ease

  &:hover {
    transform: translateY(-50%) translateX(0)
  }
}
```

#### Feedback Modal Component

```pseudocode
component FeedbackModal({ onClose }) {
  let [type, setType] = useState("general")
  let [formData, setFormData] = useState({
    title: "",
    message: "",
    rating: 5,
    include_screenshot: false
  })

  let [submitting, setSubmitting] = useState(false)
  let [submitted, setSubmitted] = useState(false)
  let [error, setError] = useState(null)

  async function handleSubmit() {
    if (!formData.message) {
      setError("Please enter your feedback")
      return
    }

    if (type === "feature_request" && !formData.title) {
      setError("Please enter a title for your feature request")
      return
    }

    setSubmitting(true)
    setError(null)

    try {
      let data = new FormData()
      data.append("type", type)
      data.append("message", formData.message)

      if (type === "feature_request") {
        data.append("title", formData.title)
      }

      if (type === "rating") {
        data.append("rating", formData.rating)
      }

      if (formData.include_screenshot) {
        // Optionally capture screenshot
        let screenshot = await takeScreenshot()
        if (screenshot) {
          data.append("screenshot", screenshot, "feedback-screenshot.png")
        }
      }

      let response = await fetch("/api/feedback", {
        method: "POST",
        body: data
      })

      if (!response.ok) {
        throw new Error(await response.text())
      }

      setSubmitted(true)

      setTimeout(() => {
        onClose()
      }, 2000)

    } catch (err) {
      setError(err.message || "Failed to submit feedback")
    }

    setSubmitting(false)
  }

  if (submitted) {
    return (
      <div class="feedback-success">
        <h3>✓ Thank you!</h3>
        <p>We appreciate your feedback and will use it to improve the app.</p>
        <button onClick={onClose}>Close</button>
      </div>
    )
  }

  return (
    <div class="feedback-modal-overlay" onClick={onClose}>
      <div class="feedback-modal" onClick={(e) => e.stopPropagation()}>
        <div class="feedback-header">
          <h3>Send Us Your Feedback</h3>
          <button class="close-btn" onClick={onClose}>✕</button>
        </div>

        <div class="feedback-body">
          {error && <div class="error-message">{error}</div>}

          <div class="feedback-type-selector">
            {["general", "feature_request", "rating"].map(t => (
              <button
                key={t}
                class={`type-btn ${type === t ? "active" : ""}`}
                onClick={() => setType(t)}
                disabled={submitting}
              >
                {t === "general" && "💬 General"}
                {t === "feature_request" && "⭐ Feature Request"}
                {t === "rating" && "⭐ Rate Us"}
              </button>
            ))}
          </div>

          {type === "feature_request" && (
            <div class="form-group">
              <label htmlFor="title">Feature Title</label>
              <input
                id="title"
                type="text"
                placeholder="What feature would you like?"
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                disabled={submitting}
              />
            </div>
          )}

          {type === "rating" && (
            <div class="form-group">
              <label htmlFor="rating">How would you rate the app?</label>
              <div class="rating-selector">
                {[1, 2, 3, 4, 5].map(r => (
                  <button
                    key={r}
                    class={`rating-star ${formData.rating >= r ? "filled" : ""}`}
                    onClick={() => setFormData({ ...formData, rating: r })}
                    disabled={submitting}
                  >
                    ★
                  </button>
                ))}
              </div>
            </div>
          )}

          <div class="form-group">
            <label htmlFor="message">
              {type === "rating" ? "What could we improve?" : "Your feedback"}
            </label>
            <textarea
              id="message"
              placeholder={
                type === "feature_request"
                  ? "Describe your feature idea..."
                  : "Tell us what you think..."
              }
              value={formData.message}
              onChange={(e) => setFormData({ ...formData, message: e.target.value })}
              rows={4}
              disabled={submitting}
            />
          </div>

          <div class="form-group checkbox">
            <input
              id="screenshot"
              type="checkbox"
              checked={formData.include_screenshot}
              onChange={(e) => setFormData({ ...formData, include_screenshot: e.target.checked })}
              disabled={submitting}
            />
            <label htmlFor="screenshot">Include screenshot</label>
          </div>

          <div class="privacy-notice">
            <small>
              Your feedback helps us improve. View our <a href="/privacy" target="_blank">Privacy Policy</a>
            </small>
          </div>
        </div>

        <div class="feedback-footer">
          <button onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button class="primary" onClick={handleSubmit} disabled={submitting}>
            {submitting ? "Sending..." : "Send Feedback"}
          </button>
        </div>
      </div>
    </div>
  )
}

.feedback-modal-overlay {
  position: fixed
  top: 0
  left: 0
  right: 0
  bottom: 0
  background: rgba(0,0,0,0.5)
  display: flex
  align-items: center
  justify-content: center
  z-index: 10000
}

.feedback-modal {
  background: white
  border-radius: 12px
  box-shadow: 0 10px 40px rgba(0,0,0,0.2)
  max-width: 500px
  width: 90vw
  max-height: 90vh
  overflow-y: auto
}

.rating-selector {
  display: flex
  gap: 8px
}

.rating-star {
  font-size: 32px
  background: none
  border: none
  cursor: pointer
  opacity: 0.3
  transition: opacity 200ms ease

  &.filled {
    opacity: 1
    color: #ffc107
  }
}
```

#### NPS Trigger (Optional)

```pseudocode
component NPSTrigger() {
  let [showNPS, setShowNPS] = useState(false)
  let [npsScore, setNpsScore] = useState(null)

  // Show NPS after user has been active for 7+ days and 10+ sessions
  useEffect(() => {
    let shouldShowNPS = () => {
      let userDaysActive = getUserDaysActive()
      let sessionCount = getSessionCount()
      let lastNPSShow = localStorage.getItem("lastNPSShow")
      let daysSinceLastShow = lastNPSShow ?
        (Date.now() - parseInt(lastNPSShow)) / (1000 * 60 * 60 * 24) : 999

      return (
        userDaysActive >= 7 &&
        sessionCount >= 10 &&
        daysSinceLastShow >= 90  // Don't show more than once per 90 days
      )
    }

    if (shouldShowNPS()) {
      setTimeout(() => {
        setShowNPS(true)
        localStorage.setItem("lastNPSShow", Date.now().toString())
      }, 3000)
    }
  }, [])

  if (!showNPS) {
    return null
  }

  return (
    <div class="nps-modal">
      <h3>How likely are you to recommend us?</h3>
      <div class="nps-scale">
        {Array.from({ length: 11 }, (_, i) => (
          <button
            key={i}
            class={`nps-score ${npsScore === i ? "selected" : ""}`}
            onClick={() => {
              setNpsScore(i)
              recordNPS(i)
              setTimeout(() => setShowNPS(false), 500)
            }}
          >
            {i}
          </button>
        ))}
      </div>
      <div class="nps-labels">
        <span>Not likely</span>
        <span>Very likely</span>
      </div>
      <button onClick={() => setShowNPS(false)}>Close</button>
    </div>
  )
}
```

---

## Part 3: Status Page Integration

### Overview

Live status indicator in app footer/nav showing operational status. Integrated with external status page (Statuspage.io, Instatus, or custom). Polls status page API and displays indicator (green = operational, yellow = degraded, red = outage).

### Data Model

```
StatusIndicator {
  status:         "operational" | "degraded" | "maintenance" | "outage"
  status_page:    string (URL to status page)
  components:     array of StatusComponent
  updated_at:     datetime
  maintenance_windows: array of MaintenanceWindow
}

StatusComponent {
  id:             string
  name:           string
  description:    string
  status:         "operational" | "degraded" | "outage" | "maintenance"
  last_updated:   datetime
}

MaintenanceWindow {
  id:             string
  name:           string
  scheduled_for:  datetime
  duration:       integer (minutes)
  components:     array of string (affected component IDs)
}
```

### API Routes

#### GET `/api/status`

Get current app status (public endpoint).

**Response:**
```
{
  status:          "operational" | "degraded" | "maintenance" | "outage"
  message:         string (description)
  status_page_url: string
  components: [
    {
      name:       string
      status:     string
      description: string
    }
  ],
  last_updated:    datetime,
  next_update:     datetime
}
```

### Component Implementation

#### Status Indicator (Footer)

```pseudocode
component StatusIndicator() {
  let [status, setStatus] = useState("operational")
  let [details, setDetails] = useState(null)
  let [isOpen, setIsOpen] = useState(false)
  let [updateTime, setUpdateTime] = useState(null)

  useEffect(() => {
    // Fetch status on mount
    fetchStatus()

    // Poll for updates
    let interval = setInterval(fetchStatus, STATUS_PAGE_POLLING_INTERVAL || 300000)

    return () => clearInterval(interval)
  }, [])

  async function fetchStatus() {
    try {
      let response = await fetch("/api/status")
      let data = await response.json()

      setStatus(data.status)
      setDetails(data)
      setUpdateTime(new Date())
    } catch (err) {
      console.warn("Failed to fetch status:", err)
    }
  }

  let statusColor = {
    operational: "#27ae60",
    degraded: "#f39c12",
    maintenance: "#3498db",
    outage: "#e74c3c"
  }

  let statusLabel = {
    operational: "All Systems Operational",
    degraded: "Degraded Service",
    maintenance: "Maintenance",
    outage: "Service Outage"
  }

  return (
    <div class="status-indicator">
      <button
        class={`status-button status-${status}`}
        onClick={() => setIsOpen(!isOpen)}
        title={statusLabel[status]}
      >
        <span class="status-dot" style={{ backgroundColor: statusColor[status] }}></span>
        <span class="status-text">{statusLabel[status]}</span>
      </button>

      {isOpen && (
        <div class="status-popover">
          <h4>System Status</h4>

          {details && (
            <>
              <p class="status-message">{details.message}</p>

              {details.components && details.components.length > 0 && (
                <div class="components-list">
                  <h5>Components</h5>
                  {details.components.map(comp => (
                    <div key={comp.name} class={`component-item component-${comp.status}`}>
                      <span class="component-name">{comp.name}</span>
                      <span class="component-status">{comp.status}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {details?.status_page_url && (
            <a href={details.status_page_url} target="_blank" class="view-status-page">
              View Full Status Page →
            </a>
          )}

          {updateTime && (
            <div class="update-time">
              Last updated: {formatTime(updateTime)}
            </div>
          )}

          <button onClick={() => setIsOpen(false)}>Close</button>
        </div>
      )}
    </div>
  )
}

.status-indicator {
  position: relative
}

.status-button {
  display: flex
  align-items: center
  gap: 8px
  padding: 8px 12px
  background: none
  border: 1px solid #ddd
  border-radius: 4px
  cursor: pointer
  font-size: 12px
  font-weight: 600
  color: #333

  &:hover {
    background: #f9f9f9
  }
}

.status-dot {
  width: 8px
  height: 8px
  border-radius: 50%
  animation: pulse 2s infinite
}

@keyframes pulse {
  0%, 100% {
    opacity: 1
  }
  50% {
    opacity: 0.6
  }
}

.status-popover {
  position: absolute
  bottom: 100%
  right: 0
  background: white
  border: 1px solid #ddd
  border-radius: 8px
  padding: 16px
  box-shadow: 0 4px 12px rgba(0,0,0,0.15)
  min-width: 300px
  z-index: 9999
  margin-bottom: 8px

  h4 {
    margin-top: 0
  }

  .components-list {
    margin-top: 12px
  }

  .component-item {
    display: flex
    justify-content: space-between
    padding: 8px 0
    border-bottom: 1px solid #eee
    font-size: 13px

    &.component-operational {
      .component-status {
        color: #27ae60
      }
    }

    &.component-degraded {
      .component-status {
        color: #f39c12
      }
    }

    &.component-outage {
      .component-status {
        color: #e74c3c
      }
    }
  }
}
```

#### Backend: Status Page Poller

```pseudocode
class StatusPagePoller {
  private statusPageUrl: string
  private cacheTTL: integer = 300  // 5 minutes

  constructor(statusPageUrl: string) {
    this.statusPageUrl = statusPageUrl
  }

  async fetchStatus() {
    // Check cache first
    let cached = await cache.get("app_status")
    if (cached) {
      return cached
    }

    try {
      let response = await fetch(this.statusPageUrl)
      let data = await response.json()

      let status = this.parseStatusPageResponse(data)

      // Cache the result
      await cache.set("app_status", status, this.cacheTTL)

      return status
    } catch (err) {
      console.error("Failed to fetch status:", err)

      // Return fallback if fetch fails
      return {
        status: "unknown",
        message: "Unable to fetch status page",
        components: [],
        last_updated: new Date()
      }
    }
  }

  private parseStatusPageResponse(data: object) {
    // Parse response from Statuspage.io, Instatus, or custom format
    // Example: Statuspage.io format
    let overallStatus = "operational"

    for each incident in data.incidents:
      if (incident.status === "investigating") {
        overallStatus = "degraded"
        break
      }
      if (incident.impact === "critical") {
        overallStatus = "outage"
        break
      }

    return {
      status: overallStatus,
      message: data.status?.description || "All systems operational",
      components: (data.components || []).map(comp => ({
        name: comp.name,
        status: comp.status,
        description: comp.description
      })),
      last_updated: new Date(data.updated_at || Date.now()),
      maintenance_windows: (data.maintenance_windows || []).map(maint => ({
        name: maint.name,
        scheduled_for: new Date(maint.scheduled_for),
        duration: maint.duration
      }))
    }
  }
}

// API endpoint
export async function getStatusHandler(request, response) {
  if (!STATUS_PAGE_URL) {
    // If no status page configured, return operational
    return response.json({
      status: "operational",
      message: "All systems operational",
      status_page_url: null,
      components: [],
      last_updated: new Date()
    })
  }

  let poller = new StatusPagePoller(STATUS_PAGE_URL)
  let status = await poller.fetchStatus()

  return response.json(status)
}
```

---

## Configuration Examples

### Example 1: All Features Enabled

```env
ENABLE_IN_APP_FEEDBACK=true
FILE_STORAGE_PROVIDER="aws-s3"  # For bug report attachments
STATUS_PAGE_URL="https://status.example.com/api/v2/status.json"
STATUS_PAGE_POLLING_INTERVAL=300000  # 5 minutes
```

### Example 2: Bug Reports + Feedback, No Status Page

```env
ENABLE_IN_APP_FEEDBACK=true
FILE_STORAGE_PROVIDER="local"  # Store in uploads folder
STATUS_PAGE_URL=""  # No status page
```

### Example 3: Status Page Only

```env
ENABLE_IN_APP_FEEDBACK=false
STATUS_PAGE_URL="https://status.example.com/api/v2/status.json"
```

---

## Gotchas & Edge Cases

### 1. Screenshot Capture Permission

**Problem**: Browser doesn't grant permission to take screenshot.

**Solution**: Handle gracefully, continue submission without screenshot:

```pseudocode
let screenshot = null
try {
  screenshot = await takeScreenshot()
} catch (err) {
  console.warn("Screenshot not available:", err)
}

formData.append("screenshot", screenshot)  // null is OK
```

### 2. Large Attachments

**Problem**: User uploads 100MB file; submission hangs or fails.

**Solution**: Validate file size before upload:

```pseudocode
function validateAttachments(files: File[]) {
  const MAX_FILE_SIZE = 5 * 1024 * 1024  // 5MB
  const MAX_TOTAL = 50 * 1024 * 1024      // 50MB

  let total = 0
  for each file in files:
    if (file.size > MAX_FILE_SIZE) {
      throw new Error(`File too large: ${file.name}`)
    }
    total += file.size

  if (total > MAX_TOTAL) {
    throw new Error("Total attachments exceed 50MB limit")
  }
}
```

### 3. Status Page API Rate Limiting

**Problem**: Status page API rate-limits polling; frequent requests get blocked.

**Solution**: Implement caching and backoff:

```pseudocode
class StatusPagePoller {
  private lastFetchTime: datetime = null
  private minFetchInterval: integer = 60000  // 1 minute minimum

  async fetchStatus() {
    let now = Date.now()

    if (this.lastFetchTime && (now - this.lastFetchTime) < this.minFetchInterval) {
      return cache.get("app_status")
    }

    // Fetch with exponential backoff on errors
    let retries = 3
    while (retries > 0) {
      try {
        let status = await pollStatusAPI()
        this.lastFetchTime = now
        return status
      } catch (err) {
        retries--
        if (retries === 0) throw err
        await sleep(1000 * (4 - retries))  // 1s, 2s, 3s backoff
      }
    }
  }
}
```

### 4. Console Error Capture Privacy

**Problem**: Console might contain sensitive info (tokens, user data).

**Solution**: Sanitize before sending:

```pseudocode
function sanitizeConsoleError(message: string) {
  // Remove common sensitive patterns
  let sanitized = message
    .replace(/authorization: [\w-]+/gi, "authorization: [REDACTED]")
    .replace(/bearer [\w-]+/gi, "bearer [REDACTED]")
    .replace(/token=[\w-]+/gi, "token=[REDACTED]")
    .replace(/password[\w]*[=:]\s*[\S]+/gi, "password=[REDACTED]")

  return sanitized
}
```

### 5. Feedback Modal Not Dismissible

**Problem**: User opens feedback modal but can't close it; feels trapped.

**Solution**: Multiple ways to close:

```
- Click close button (✕)
- Click outside modal (overlay click)
- Press Escape key
- Auto-close after successful submission
```

### 6. Status Indicator Always Shows "Loading"

**Problem**: Status page API is slow; indicator never updates.

**Solution**: Show cached status while fetching:

```pseudocode
component StatusIndicator() {
  let [status, setStatus] = useState(cache.get("app_status") || "operational")
  let [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    fetchStatus()
      .then(status => setStatus(status))
      .finally(() => setIsLoading(false))
  }, [])

  return (
    <div class="status-indicator">
      {/* Show status immediately, even if loading */}
      <span class={`status-badge status-${status}`}>
        {status}
        {isLoading && <spinner />}
      </span>
    </div>
  )
}
```

---

## Summary: Support Enhancements Checklist

- [ ] **Bug Report Widget**: Floating button (bottom-right), captures context (screenshot, console errors, device info)
- [ ] **Bug Report Form**: Title, description, steps, expected/actual behavior, severity
- [ ] **Automatic Context**: Browser info, device info, console errors, authenticated user ID
- [ ] **Attachments**: Conditional on FILE_STORAGE_PROVIDER; max 5 files, 5MB each
- [ ] **Admin Panel**: View all bug reports, filter by status/severity, assign, respond
- [ ] **Feedback Modal**: General, feature request, rating types
- [ ] **NPS Trigger**: Optional, shows after 7+ days active and 10+ sessions
- [ ] **Admin Feedback View**: Search, filter, respond to feedback
- [ ] **Status Page Integration**: Polls external API, caches response, displays indicator
- [ ] **Status Indicator**: Footer/nav button, shows operational/degraded/outage status
- [ ] **Status Popover**: Shows components, maintenance windows, link to status page
- [ ] **Caching**: Status page responses cached with TTL
- [ ] **Error Handling**: Graceful fallbacks for API failures, permissions, rate limiting
- [ ] **Privacy**: Console error sanitization, screenshot opt-in, privacy notice
