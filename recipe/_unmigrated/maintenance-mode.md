---
name: Maintenance Mode
description: App-wide maintenance toggle with admin bypass
type: enhancement
requires: recipes/dev-ops.md, recipes/otp.md
env_vars: MAINTENANCE_MODE (boolean, default: false)
---

# Maintenance Mode

App-wide maintenance toggle. When enabled, all routes return a maintenance page except admin-protected routes. Optional scheduled maintenance with start/end times. Health check endpoint always responds. API returns 503 with `Retry-After` header.

---

## Overview

Put the entire app into maintenance mode for:
- Database migrations
- Server upgrades
- Bug fixes requiring restart
- Scheduled maintenance windows

Users see a friendly maintenance page. Admins can still access the app. Health checks remain functional for monitoring.

---

## Data Model

New table: `maintenance_windows` (optional, for scheduled maintenance)

```
MaintenanceWindow {
  id:              auto-generated primary key
  starts_at:       datetime
  ends_at:         datetime | null
  reason:          string  // "Database migration", "Server upgrade", etc.
  notify_users:    boolean // whether to send email notification
  admin_message:   string  // internal note, not shown to users
  created_by:      string  // admin user_id
  created_at:      datetime
}
```

Config in `.env` or database settings:

```
MAINTENANCE_MODE=true|false
MAINTENANCE_REASON="Scheduled maintenance. We'll be back in 1 hour."
```

Or use database flag:

```
SystemSettings {
  maintenance_enabled: boolean
  maintenance_reason: string
  maintenance_until: datetime | null
}
```

---

## API Routes

### GET `/health` (Health Check)

Always accessible, even in maintenance mode. Used by monitoring/load balancers.

**Response:**
```
{
  status: 'ok' | 'degraded' | 'down',
  timestamp: datetime,
  maintenance_mode: boolean,
  checks: {
    database: 'ok' | 'error',
    cache: 'ok' | 'error',
    disk_space: 'ok' | 'error'
  }
}
```

Never return 503 from health check. Return 200 with status field instead.

### GET `/maintenance` (Maintenance Page)

Public endpoint. Shows maintenance page and reason.

**Response:** HTML page

```html
<!DOCTYPE html>
<html>
<head>
  <title>Scheduled Maintenance</title>
  <style>
    body { font-family: sans-serif; text-align: center; padding: 50px; }
    .container { max-width: 600px; margin: 0 auto; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Scheduled Maintenance</h1>
    <p>We're performing scheduled maintenance and will be back shortly.</p>
    <p>Estimated return: [time]</p>
    <p>For questions, email support@example.com</p>
  </div>
</body>
</html>
```

### POST `/admin/api/maintenance/enable`

Enable maintenance mode (admin only).

**Request:**
```
{
  reason: string,
  duration_minutes?: integer  // auto-disable after N minutes
}
```

**Response:**
```
{
  status: 'maintenance_enabled',
  reason: string,
  will_auto_disable_at?: datetime
}
```

**Side effects:**
- Set `MAINTENANCE_MODE=true` or DB flag
- Log event: "maintenance_enabled" with reason and admin user_id
- Send notification to other admins (optional)
- If `duration_minutes` provided, schedule auto-disable

### POST `/admin/api/maintenance/disable`

Disable maintenance mode.

**Response:**
```
{
  status: 'maintenance_disabled'
}
```

**Side effects:**
- Set `MAINTENANCE_MODE=false`
- Log event: "maintenance_disabled" with admin user_id

### GET `/admin/api/maintenance/status`

Check current maintenance status (admin only).

**Response:**
```
{
  maintenance_enabled: boolean,
  reason?: string,
  enabled_at?: datetime,
  scheduled_end?: datetime,
  enabled_by?: string  // admin who enabled it
}
```

---

## Middleware Implementation

### Maintenance Check Middleware

Run early in request pipeline (before routing, auth, etc.):

```pseudocode
middleware maintenanceMiddleware(request, response, next):

  // Health check always passes
  if (request.path == '/health'):
    next()
    return

  // Maintenance mode status page is always accessible
  if (request.path == '/maintenance'):
    next()
    return

  // Check maintenance mode
  maintenanceEnabled = getMaintenanceStatus()
  if (!maintenanceEnabled):
    next()
    return

  // Maintenance mode is enabled

  // Admin bypass: check if user is authenticated admin
  user = getSession(request)
  if (user and user.role == 'admin'):
    next()  // allow admin through
    return

  // For non-admins, return maintenance page

  // If API request, return 503
  if (isApiRequest(request)):
    return response.status(503).json({
      error: 'Service temporarily unavailable',
      message: maintenanceReason || 'Scheduled maintenance in progress'
    }).setHeader('Retry-After', '3600')  // retry after 1 hour

  // If HTML page request, return maintenance HTML
  if (isHtmlRequest(request)):
    return response.status(503).send(renderMaintenancePage(maintenanceReason))
```

### Admin Bypass Logic

```pseudocode
function isAdminSession(request):
  session = getSession(request)
  if (!session):
    return false

  // Load user to check role
  user = db.users.findOne({ user_id: session.user_id })
  return user and user.role == 'admin'
```

---

## Scheduled Auto-Disable

If maintenance has a planned end time, automatically disable it:

```pseudocode
job autoDisableMaintenanceJob():
  maintenanceWindow = db.maintenance_windows.findOne({
    ends_at: { $lte: now },
    status: 'active'
  })

  if (maintenanceWindow):
    disableMaintenance()
    maintenanceWindow.status = 'completed'
    maintenanceWindow.save()
    log('maintenance_auto_disabled', maintenanceWindow.id)
```

Schedule this job to run every minute:
```
* * * * *  (every minute)
```

---

## User Notification

### Email Notification

When maintenance is scheduled, optionally send notification to users:

```pseudocode
POST /admin/api/maintenance/notify-users:
  maintenanceWindow = request.body

  if (maintenanceWindow.notify_users):
    allUsers = db.users.find({})  // paginate for large datasets

    for user in allUsers:
      sendEmail(user.email, template='scheduled_maintenance', {
        starts_at: maintenanceWindow.starts_at,
        ends_at: maintenanceWindow.ends_at,
        reason: maintenanceWindow.reason
      })

    log('maintenance_notification_sent', allUsers.count())
```

### Banner Notification (In-App)

Show a dismissible banner before scheduled maintenance:

```pseudocode
GET /api/maintenance/upcoming:
  now = getCurrentTime()
  window = db.maintenance_windows.findOne({
    starts_at: { $gt: now, $lt: now + 24 hours }
  })

  if (!window):
    return 404

  return {
    maintenance_scheduled: true,
    starts_at: window.starts_at,
    duration_hours: (window.ends_at - window.starts_at) / 3600,
    reason: window.reason
  }
```

Client displays banner:

```javascript
const { maintenance_scheduled, starts_at, duration_hours } =
  await fetch('/api/maintenance/upcoming').then(r => r.json());

if (maintenance_scheduled) {
  showBanner(`Scheduled maintenance on ${new Date(starts_at).toLocaleDateString()}
    for ${duration_hours} hours`);
}
```

---

## UI for Admin

### Admin Dashboard: Maintenance Control

```
[Admin Dashboard]

[Section: "Maintenance Mode"]

Current status: [Enabled / Disabled toggle button]

If enabled:
  Reason: [text display]
  Enabled at: [timestamp]
  Auto-disable at: [timestamp or "Manual only"]
  [Disable now button]

If disabled:
  [Enable maintenance button]

[Scheduled Maintenance]
  [List of upcoming windows]
  [Create new window button]

  [Window item]:
    Scheduled: [date/time]
    Duration: [hours]
    Reason: [text]
    [Edit] [Delete] [Notify users]
```

### Enable Maintenance Form

```
[Modal: "Enable Maintenance Mode"]

Reason: [textarea]
  "Scheduled maintenance. We'll be back in 1 hour."

Auto-disable after: [input]
  Minutes: [30, 60, 120]
  or: [∞ never auto-disable]

Notify users: [checkbox]
  "Send email to all users"

[Enable] [Cancel] buttons
```

---

## API Error Responses

### Web (HTML Request)

```
HTTP/1.1 503 Service Unavailable

<!DOCTYPE html>
<html>
  <head><title>Maintenance</title></head>
  <body>
    <h1>Scheduled Maintenance</h1>
    <p>We're performing maintenance. Back soon!</p>
  </body>
</html>
```

### API (JSON Request)

```
HTTP/1.1 503 Service Unavailable
Retry-After: 3600

{
  "error": "service_unavailable",
  "message": "The app is currently in maintenance mode",
  "maintenance_reason": "Database upgrade in progress",
  "estimated_return_at": "2025-03-26T15:00:00Z"
}
```

---

## Security & Gotchas

### 1. Admin Authentication During Maintenance

If authentication system is broken (e.g., due to DB migration), admins can't log in to disable maintenance. Plan ahead:

- Use a backup authentication method (static token) for critical admin actions
- Document manual override procedure (e.g., editing .env and restarting)
- Test admin access works in maintenance mode before enabling

### 2. Race Condition: Request During Transition

Request arrives just as maintenance is being enabled/disabled. Middleware might see inconsistent state:

```
Thread A: Check MAINTENANCE_MODE → false
Thread B: Enables maintenance mode, sets MAINTENANCE_MODE=true
Thread A: Continues processing (should have been blocked)
```

Mitigate with atomic operations:

```pseudocode
function isMaintenanceModeActive():
  return db.system_settings.findOne({}).maintenance_enabled
  // Always fetch fresh from DB, don't cache
```

Or use a fast cache with short TTL (5 seconds).

### 3. Partial Maintenance

If only part of the app is broken, you might want maintenance mode for specific routes only. This recipe implements app-wide maintenance. For granular control, use feature flags instead (from feature-flags.md).

### 4. Health Check Spamming

If health checks don't bypass maintenance mode, load balancers might get 503 responses and repeatedly cycle servers. Always make `/health` pass.

### 5. Third-Party Services

If your app calls external APIs (Stripe, AWS, etc.), they won't know you're in maintenance mode. Requests to external services may still go through. Document this:

"During maintenance, payment webhooks may still arrive; queue them for processing after maintenance."

### 6. WebSocket Connections

If app uses WebSockets, they won't be disconnected by this middleware (HTTP middleware doesn't handle WebSocket upgrades). Consider:

- Closing WebSocket connections when maintenance starts
- Or checking maintenance status on each WebSocket message

```pseudocode
websocket /api/ws:
  connection = acceptWebSocket(request)

  while (true):
    message = connection.receive()

    if (isMaintenanceModeActive() and not isAdminSession(request)):
      connection.send({ event: 'maintenance_mode_enabled' })
      connection.close()
      break

    // Process message
```

---

## Configuration Examples

### Scenario 1: Quick Maintenance (Manual Toggle)

```env
MAINTENANCE_MODE=false
MAINTENANCE_REASON="Quick server restart"
```

Admin enables maintenance, performs task, disables manually. No scheduled end time.

### Scenario 2: Scheduled Maintenance (Auto-Disable)

```
POST /admin/api/maintenance/enable:
{
  reason: "Database migration v2.5.0",
  duration_minutes: 60  // auto-disable after 1 hour
}
```

Maintenance automatically disables after 60 minutes. If longer, admin can extend.

### Scenario 3: Notification + Scheduled Window

```
POST /admin/api/maintenance/scheduled:
{
  starts_at: "2025-03-27T02:00:00Z",  // 2 AM UTC (low-traffic time)
  ends_at: "2025-03-27T02:30:00Z",    // 30 minutes
  reason: "Quarterly database maintenance",
  notify_users: true
}
```

System sends email 1 day before. Shows in-app banner. Automatically enables/disables.

---

## Gotchas

### 1. Scheduled Maintenance in Wrong Timezone

If you schedule maintenance at "2 AM", clarify timezone. Store all times in UTC; display in user's timezone or explicitly state UTC.

### 2. Maintenance Page Not Branded

Default maintenance page looks generic. Customize with your app's branding, logo, and contact info.

### 3. Search Engines Cache Maintenance Page

If maintenance page is served with 200 status (not 503), search engines might cache it. Always use 503 for maintenance responses.

### 4. Load Balancer Health Checks

Make sure load balancer health check endpoint (`/health`) doesn't timeout during maintenance. If health checks fail, load balancer might kill the server before maintenance completes.

### 5. Client Retry Logic

Clients might immediately retry after getting 503. Consider adding a back-off to `Retry-After` header:

```
Retry-After: 300  (5 minutes for first retry)
```

Or use `Retry-After: Mon, 26 Mar 2025 15:00:00 GMT` (absolute time).

