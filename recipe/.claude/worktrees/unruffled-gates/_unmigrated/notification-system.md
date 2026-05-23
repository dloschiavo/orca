---
name: In-App Notification System
description: Bell icon, unread count, notification feed, and push notifications
type: enhancement
requires: recipes/otp.md
env_vars: (push requires native setup but no env vars for in-app)
---

# In-App Notification System

In-app notifications with a bell icon, unread badge, notification feed page, and optional push notifications. Supports notification preferences (per-type opt-in/out).

---

## Overview

Add persistent notifications that users can view and manage. Flow:

1. Backend creates notifications (triggered by other features: password reset, account deletion confirmation, etc.)
2. User sees bell icon with unread count
3. Clicking bell opens notification dropdown or navigates to full feed
4. User can mark notifications as read, delete them, manage preferences
5. Optional: Push notifications on native apps (Expo Push Notifications)

Notifications are stored in the database, persisted across sessions, and delivered via WebSocket/SSE or polling.

---

## Data Model

New table: `notifications`

```
Notification {
  id:              auto-generated primary key
  user_id:         string (FK users.user_id)
  type:            string  // 'password_reset', 'account_deletion', 'alert_triggered', etc.
  title:           string
  message:         string
  action_url?:     string | null  // link to related resource
  action_label?:   string | null  // button text
  read_at:         datetime | null
  deleted_at:      datetime | null
  created_at:      datetime
}
```

**Indexes:**
- Index on `(user_id, read_at)` — fetch unread notifications quickly
- Index on `created_at` — chronological ordering
- TTL on `created_at` (configurable) — auto-delete old notifications (e.g., after 90 days)

New table: `notification_preferences`

```
NotificationPreference {
  user_id:         string (FK users.user_id) (primary key)
  notify_password_reset: boolean  // default: true
  notify_account_deletion: boolean
  notify_alert_triggered: boolean
  notify_new_features: boolean
  push_enabled: boolean  // push notifications on native
  // ... add more per notification type as features grow
  updated_at:      datetime
}
```

Insert a default `NotificationPreference` row when user signs up (via otp.md).

---

## API Routes

### GET `/api/notifications`

Fetch notifications for authenticated user.

**Query params:**
- `limit`: default 20
- `offset`: default 0
- `unread_only`: boolean, default false

**Response:**
```
{
  notifications: [
    {
      id: string,
      type: string,
      title: string,
      message: string,
      action_url?: string,
      action_label?: string,
      read_at?: datetime,
      created_at: datetime
    }
  ],
  unread_count: integer,
  has_more: boolean
}
```

**Notes:**
- Only return non-deleted notifications (where `deleted_at` is null)
- Order by `created_at DESC` (newest first)
- Include deleted timestamps in response? No — filter them out entirely

### PATCH `/api/notifications/:notification_id`

Mark a notification as read.

**Request:**
```
{
  read: boolean
}
```

**Response:**
```
{
  id: string,
  read_at: datetime | null
}
```

**Side effects:**
- Update `notifications.read_at`

### DELETE `/api/notifications/:notification_id`

Soft-delete a notification (user hides it).

**Response:**
```
{
  status: 'deleted'
}
```

**Side effects:**
- Update `notifications.deleted_at = now`
- Do NOT hard-delete (keeps audit trail)

### POST `/api/notifications/read-all`

Mark all notifications as read.

**Request:** (empty)

**Response:**
```
{
  status: 'all_marked_read',
  count: integer  // how many marked read
}
```

### GET `/api/notifications/preferences`

Get notification preferences for authenticated user.

**Response:**
```
{
  notify_password_reset: boolean,
  notify_account_deletion: boolean,
  notify_alert_triggered: boolean,
  notify_new_features: boolean,
  push_enabled: boolean
}
```

### PUT `/api/notifications/preferences`

Update notification preferences.

**Request:**
```
{
  notify_password_reset?: boolean,
  notify_account_deletion?: boolean,
  push_enabled?: boolean,
  // ... etc.
}
```

**Response:**
```
{
  status: 'preferences_updated'
}
```

**Side effects:**
- Update `notification_preferences` for user

### POST `/api/notifications/config`

Get notification type metadata (for UI display).

**Response:**
```
{
  types: [
    {
      id: 'password_reset',
      label: 'Password Reset Confirmation',
      description: 'When your password is changed',
      default_enabled: true
    },
    {
      id: 'account_deletion',
      label: 'Account Deletion',
      description: 'Account deletion scheduled and confirmations',
      default_enabled: true
    },
    ...
  ]
}
```

---

## Real-Time Delivery

### Option 1: Server-Sent Events (SSE)

For web, use SSE for real-time notification delivery (simpler than WebSocket):

```pseudocode
GET /api/notifications/stream:
  user = requireSession(request)

  // Set up SSE response
  response.setHeader('Content-Type', 'text/event-stream')
  response.setHeader('Cache-Control', 'no-cache')
  response.setHeader('Connection', 'keep-alive')

  // Send initial unread count
  count = db.notifications.countDocuments({ user_id, read_at: null })
  response.write('event: init\n')
  response.write('data: ' + JSON.stringify({ unread_count: count }) + '\n\n')

  // Keep connection alive; send events when notifications are created
  while (connectionOpen()):
    notification = waitForNotification(user.user_id, timeout=30s)
    if (notification):
      response.write('event: notification\n')
      response.write('data: ' + JSON.stringify(notification) + '\n\n')
    else if (timeoutOccurred()):
      // Heartbeat to keep connection alive
      response.write(': heartbeat\n\n')
```

Client-side:

```javascript
const eventSource = new EventSource('/api/notifications/stream');

eventSource.addEventListener('init', (e) => {
  const { unread_count } = JSON.parse(e.data);
  updateBadge(unread_count);
});

eventSource.addEventListener('notification', (e) => {
  const notification = JSON.parse(e.data);
  showNotification(notification);
  incrementBadge();
});

eventSource.onerror = () => {
  // Reconnect on error (browser handles this automatically)
};
```

### Option 2: Polling (Fallback)

For browsers without SSE support or as fallback:

```javascript
async function pollNotifications() {
  while (true) {
    const response = await fetch('/api/notifications?limit=5');
    const { notifications, unread_count } = await response.json();

    updateBadge(unread_count);
    for (const notif of notifications) {
      if (!notif.read_at) {
        showToast(notif.message);  // brief toast notification
      }
    }

    await sleep(30000);  // poll every 30 seconds
  }
}
```

### Option 3: WebSocket (Advanced)

For full bidirectional communication and lower latency:

```pseudocode
WS /api/notifications/ws:
  user = requireSession(request)
  socket = acceptWebSocket(request)

  // Subscribe user to notifications
  subscribeToNotifications(user.user_id, socket)

  while (socketOpen()):
    message = socket.receive()
    if (message.action == 'mark_read'):
      markAsRead(message.notification_id)
      socket.send({ event: 'marked_read', id: message.notification_id })
```

Choose based on stack and requirements. SSE is simplest for web. WebSocket is better for real-time gaming or collaboration.

---

## Helper: Create Notification

Define a helper function that other features use to create notifications:

```pseudocode
function createNotification(userId, type, title, message, options = {}):
  // Check user preferences
  preferences = db.notification_preferences.findOne({ user_id: userId })
  preferenceKey = 'notify_' + type  // e.g., 'notify_password_reset'

  if (preferences and not preferences[preferenceKey]):
    // User has disabled this notification type
    return  // silently skip

  // Create notification
  notification = db.notifications.insert({
    user_id: userId,
    type: type,
    title: title,
    message: message,
    action_url: options.action_url,
    action_label: options.action_label,
    created_at: now
  })

  // Emit real-time event (via SSE, WebSocket, or queue)
  emitNotificationEvent(userId, notification)

  // Optional: send push if enabled (native apps)
  if (preferences and preferences.push_enabled):
    sendPushNotification(userId, title, message)

  return notification
```

### Example: Used by Password Reset

```pseudocode
// From password-reset.md
POST /api/auth/reset-password:
  // ... validate token, hash password ...
  createNotification(
    user.user_id,
    type='password_reset',
    title='Password Updated',
    message='Your password was successfully changed',
    action_url='/account/security',
    action_label='View Security'
  )
```

---

## UI Spec

### Bell Icon (Header)

```
[Bell icon] [Badge with unread count, e.g., "3"]

On click:
→ [Dropdown menu appears]
  [Recent notifications list (5 items)]
  [... more from 3 days ago]
  [Last from 7 days ago]
  [Mark all as read] [View all]
```

### Notification Dropdown

```
[Header: "Notifications"]

[Notification item 1]
  [Type icon] [Title]
                [Time: "2 hours ago"]
  [Message preview]
  [Action button: "View"] (if action_url)
  [Read indicator: unread = bold, read = gray]

[Notification item 2]
  ...

[Pagination: "Load more" or auto-load]
```

### Full Notification Feed Page

```
[Page: "/notifications"]

[Header: "Notifications" (X count unread)]

[Filters/Tabs]:
  ○ All
  ○ Unread
  ○ By type: Password, Account, Alerts, etc.

[List view]:
  [Notification 1] [Read button] [Delete button]
  [Notification 2]
  ...

[Pagination: "Show more"]
```

### Notification Preferences Page

```
[Page: "/account/notifications"]

[Section: "Email Notifications"]
  ☐ Password reset / security
  ☐ Account deletion / recovery
  ☐ New features / updates
  ☐ Price alert triggered

[Section: "Push Notifications" (native only)]
  ☐ Enable push notifications

[Save button]

[Message: "Preferences saved"]
```

---

## Security & Privacy Notes

### 1. Notification Content Sensitivity

Notifications might be visible on locked screens or in notification centers. Keep content generic:

```
// GOOD:
title: "Password Updated"
message: "Your password was successfully changed"

// BAD:
title: "User jdoe@example.com logged in"
message: "IP: 192.168.1.1, Device: iPhone 12"
```

### 2. User Isolation

Ensure notifications are strictly isolated per user. A user should NOT see other users' notifications.

```pseudocode
GET /api/notifications:
  user = requireSession(request)
  notifications = db.notifications.find({ user_id: user.user_id })
  // Do NOT filter by email or display_name; use user_id only
```

### 3. Notification Deletion = Soft Delete

Do NOT hard-delete notifications. Keep them for audit/compliance. Soft-delete only (mark `deleted_at`).

### 4. Rate Limiting

Prevent notification spam. If a single feature triggers too many notifications, rate-limit it:

```pseudocode
function createNotification(...):
  // Check if duplicate recent notification exists
  recent = db.notifications.findOne({
    user_id: userId,
    type: type,
    created_at: { $gte: now - 5 minutes }
  })

  if (recent):
    return  // Suppress duplicate within 5 minutes

  // Proceed
```

---

## Gotchas

### 1. Unread Count Race Condition

User marks 5 notifications as read rapidly (multiple API calls in parallel). Unread count displayed on badge becomes inconsistent with actual unread count in DB.

**Solution:** Use atomic operations or transactional reads:

```pseudocode
PATCH /api/notifications/:id:
  notification = db.notifications.findOneAndUpdate(
    { id: id, user_id: user.user_id },
    { read_at: now },
    { returnNewDocument: true }
  )

  // Fetch fresh count atomically
  unreadCount = db.notifications.countDocuments({
    user_id: user.user_id,
    read_at: null
  })

  return { notification, unreadCount }
```

Client updates badge immediately:

```javascript
const { unreadCount } = await markAsRead(id);
setBadge(unreadCount);  // use server's count, not client's decrement
```

### 2. SSE Connection Drops

Browser tab is minimized; SSE connection times out (browser closes idle connections). When tab regains focus, user doesn't receive missed notifications.

**Solution:** On reconnect, fetch all unread notifications from the past N minutes:

```javascript
window.addEventListener('focus', async () => {
  const response = await fetch('/api/notifications?unread_only=true&limit=100');
  const { notifications } = await response.json();
  // Re-render missed notifications
});
```

### 3. Preference Updates Race Condition

User disables "password reset" notifications. Seconds later, a password reset notification is created (triggered by concurrent action). The preference check and creation are not atomic.

**Solution:** Check preference at creation time (as shown in `createNotification` helper). If notification was already created before preference update, it will still display, but new notifications will respect the new preference.

### 4. Old Notifications Never Cleaned Up

With TTL on `created_at`, old notifications auto-delete. But if TTL is too long (90 days), users' notification list becomes huge and queries slow.

**Solution:**
- Set reasonable TTL (30–90 days)
- Implement pagination/lazy-loading on notification feed (don't load all at once)
- Add optional "Archive" endpoint to manually clear old notifications

### 5. Notification Delivery Not Guaranteed

If user is offline when notification is created, and they don't log back in for a week, they might miss the notification (past TTL). For critical notifications (password reset), pair with email instead.

```pseudocode
createNotification(userId, 'password_reset', ...)  // in-app
sendEmailOtp(...)  // also email for critical events
```

### 6. Push Notification Token Expiry (Native)

Native apps (Expo) require storing push tokens. Tokens expire or change when user upgrades their app. Ensure tokens are refreshed:

```pseudocode
// On app launch
if (hasNewExpoPushToken()):
  newToken = getExpoPushToken()
  fetch('/api/account/push-token', {
    method: 'POST',
    body: { token: newToken }
  })
```

Store tokens in a separate table:

```
PushToken {
  user_id: string
  token: string
  device_id: string
  created_at: datetime
  last_used_at: datetime
  expires_at: datetime
}
```

