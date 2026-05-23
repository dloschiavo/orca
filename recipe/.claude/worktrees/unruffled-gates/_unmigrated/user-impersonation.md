---
name: User Impersonation (for Support Debugging)
description: Admins can view the app as a specific user without knowing their credentials
type: enhancement
requires: recipes/admin-dashboard.md
env_vars: (none)
---

# User Impersonation (for Support Debugging)

Admin-only feature allowing support staff and admins to view the app as a specific user without needing the user's credentials. Useful for debugging user-specific issues. All impersonation sessions are time-limited and fully audited.

---

## Overview

Admins can click an "Impersonate" button on a user's profile in the admin panel. This creates a special session token that authenticates the admin as if they were the target user.

Flow:
1. Admin navigates to user detail page in admin dashboard
2. Admin clicks "Impersonate [user_email]"
3. App creates an impersonation session linking original_admin_id to impersonated_user_id
4. Admin is logged in as the user and sees their data
5. Persistent banner at top: "You are viewing as {user_email} — End impersonation"
6. All actions are logged with both admin_id and user_id
7. Certain destructive actions are blocked during impersonation
8. Session auto-expires after 1 hour
9. Admin can manually end impersonation

---

## Data Model

Extend `sessions` table with impersonation fields:

```
Session {
  // ... existing fields ...

  impersonation: {
    is_impersonation: boolean,
    original_admin_id: string | null,     // admin who initiated impersonation
    impersonated_user_id: string | null,  // the user being viewed
    impersonation_started_at: datetime | null,
    impersonation_expires_at: datetime | null  // 1 hour from start
  }
}
```

New table: `impersonation_audit_log` (immutable, append-only)

```
ImpersonationAuditLog {
  id:                      auto-generated primary key
  admin_id:                string (FK users.user_id)
  impersonated_user_id:    string (FK users.user_id)
  action:                  string  // 'impersonation_started', 'impersonation_ended', 'action_taken'
  resource_type:           string | null  // 'user', 'settings', 'data'
  resource_id:             string | null
  http_method:             string  // GET, POST, PATCH, DELETE
  endpoint:                string
  ip_address:              string
  started_at:              datetime
  ended_at:                datetime | null
}
```

**Indexes:**
- Index on `admin_id` — find all impersonations by this admin
- Index on `impersonated_user_id` — find all impersonations of this user
- Index on `started_at` — find impersonations in a date range
- Index on `admin_id, started_at` — efficient audit queries

---

## API Routes

### POST `/api/admin/impersonate`

Start an impersonation session.

**Request:**
```
{
  user_id: string  // user to impersonate
}
```

**Validation:**
- Requester must be an admin (`requireAdmin()`)
- Cannot impersonate another admin (only admins can impersonate, and they cannot impersonate other admins to prevent privilege escalation)
- Cannot impersonate the same admin making the request
- Target user must exist
- Admin can only have one active impersonation at a time (revoke previous if exists)

**Response:**
```
{
  status: 'impersonation_started',
  session_token: string,
  impersonated_user: {
    user_id: string,
    email: string,
    display_name: string
  },
  expires_at: datetime,  // 1 hour from now
  message: 'You are now viewing as {user_email}'
}
```

**Side effects:**
- Create new session record with impersonation flags
- Revoke any previous impersonation session for this admin
- Log to `impersonation_audit_log`: `impersonation_started` action
- Send email to admin (optional but recommended): "Impersonation started for {user_email} at {time} from IP {ip}"
- Send email to user (optional): "An admin has accessed your account to debug an issue. Contact support if this was not authorized."

### DELETE `/api/admin/impersonate`

End the current impersonation session.

**Request:** (empty)

**Validation:**
- Requester must be in an active impersonation session

**Response:**
```
{
  status: 'impersonation_ended',
  message: 'Impersonation ended. You are back to admin view.'
}
```

**Side effects:**
- Mark session as ended
- Log to `impersonation_audit_log`: `impersonation_ended` action with duration
- Optionally send email to admin: "Impersonation session ended"

### GET `/api/admin/impersonations`

List all active impersonations (admins only, for oversight).

**Query params:**
- `admin_id?: string` — filter by admin
- `user_id?: string` — filter by impersonated user
- `limit?: integer` — default 50
- `offset?: integer` — default 0

**Response:**
```
{
  impersonations: [
    {
      id: string,
      admin_id: string,
      admin_email: string,
      impersonated_user_id: string,
      impersonated_user_email: string,
      started_at: datetime,
      expires_at: datetime,
      ip_address: string
    }
  ],
  total: integer
}
```

---

## Session Behavior During Impersonation

### Auth Checks

During impersonation, all `requireAuth()` middleware should return the impersonated user:

```pseudocode
function getCurrentUser(session):
  if (session.impersonation.is_impersonation):
    return db.users.findOne({ user_id: session.impersonation.impersonated_user_id })
  else:
    return db.users.findOne({ user_id: session.user_id })
```

### API Authorization

API responses should return impersonated user's data:

```pseudocode
GET /api/user/profile:
  session = requireSession(request)
  user = getCurrentUser(session)
  return user.profile  // impersonated user's profile
```

### Blocked Actions During Impersonation

The following actions are BLOCKED while impersonating:

```
POST   /api/auth/change-password         (403 Forbidden)
PATCH  /api/user/email                   (403 Forbidden)
DELETE /api/account                      (403 Forbidden)
PATCH  /api/billing/payment-method       (403 Forbidden)
POST   /api/billing/cancel-subscription  (403 Forbidden)
DELETE /api/user/sessions                (403 Forbidden) — except impersonation session itself
```

Return:
```
{
  error: 'action_blocked_during_impersonation',
  message: 'This action cannot be performed while impersonating a user'
}
```

**Rationale:** Prevent admins from accidentally changing user data, canceling subscriptions, or deleting accounts.

---

## UI Spec

### Impersonation Banner

Display at top of page when impersonating:

```
[Fixed banner, red/warning background]
[Icon: warning]
You are viewing as [user_email]. Your actions are logged.
[End impersonation button] [X to dismiss (but banner stays)]
```

Styling:
- High z-index (above modals, popovers)
- Fixed position at top of viewport
- Non-dismissible (user must click "End impersonation" to close)
- Red/orange color to make it obvious this is not normal mode
- Shows admin's own email/name in corner for reference

### Admin User Detail Page

Add "Impersonate" button on user profile:

```
[User Profile Header]
  Name: John Doe
  Email: john@example.com
  User ID: user_123
  Created: 2 months ago

  [Buttons]:
    [Impersonate] (red/danger)
    [Edit user]
    [Revoke sessions]
    [Reset email health]
    [Delete user]
```

### Impersonation Session Modal

When clicking "Impersonate", show confirmation:

```
[Modal: "Start Impersonation"]

You are about to view the app as john@example.com.

This action will:
- Show you their data and settings
- Create an audit log entry
- Expire after 1 hour
- Send them a notification (optional)

[Cancel] [Impersonate (red)]
```

---

## Audit Logging

Every action taken during impersonation is logged:

```pseudocode
function logImpersonationAction(session, request, response):
  if (!session.impersonation.is_impersonation):
    return

  log = {
    admin_id: session.impersonation.original_admin_id,
    impersonated_user_id: session.impersonation.impersonated_user_id,
    action: 'action_taken',
    resource_type: getResourceType(request.url),
    resource_id: getResourceId(request.url),
    http_method: request.method,
    endpoint: request.path,
    ip_address: request.ip,
    request_body: sanitize(request.body),  // remove sensitive data
    response_status: response.status,
    timestamp: now
  }

  db.impersonation_audit_log.insert(log)
```

### Audit Log Queries

Admins can review impersonation history:

```
GET /admin/api/impersonation-logs?admin_id=admin_123&limit=100
GET /admin/api/impersonation-logs?impersonated_user_id=user_456&limit=100
```

---

## Email Notifications

### To Admin (on impersonation start)

```
Subject: Impersonation session started

An impersonation session has been started:

Admin: [admin_email]
User: [target_user_email]
Time: [timestamp]
IP: [ip_address]
Browser: [user_agent]

This session will expire in 1 hour.
Session ID: [session_id]

If this was not you, contact security@example.com immediately.
```

### To User (on impersonation start, optional)

```
Subject: Admin access to your account

An authorized admin has accessed your account to assist with support.

Time: [timestamp]
Admin: [admin_email] ([admin_name])
Reason: Support debugging

If you did not authorize this, please contact support@example.com immediately.

Your data and privacy are protected. The admin's actions are fully audited.
```

---

## Security & Compliance Notes

### 1. Admin-Only Feature

Only users with `role = 'admin'` can start impersonations:

```pseudocode
POST /api/admin/impersonate:
  admin = requireAdmin(request)  // returns 403 if not admin
  user = getTargetUser(request.body.user_id)
  startImpersonation(admin.user_id, user.user_id)
```

### 2. Cannot Impersonate Admins

Prevent privilege escalation: admins cannot impersonate other admins.

```pseudocode
POST /api/admin/impersonate:
  targetUser = db.users.findOne({ user_id: request.body.user_id })
  if (targetUser.role == 'admin'):
    return 403 { error: 'cannot_impersonate_admin' }
```

### 3. One Impersonation Per Admin

An admin can only have one active impersonation session at a time:

```pseudocode
POST /api/admin/impersonate:
  // revoke previous impersonation if exists
  previousSession = db.sessions.findOne({
    user_id: admin.user_id,
    'impersonation.is_impersonation': true,
    'impersonation.impersonation_expires_at': { $gt: now }
  })

  if (previousSession):
    previousSession.revoked_at = now
    previousSession.save()
```

### 4. Session Expiry

Impersonation sessions have a hard 1-hour expiry. After that, the admin is automatically logged out:

```pseudocode
middleware checkImpersonationExpiry(request, response, next):
  session = getSessionFromCookie(request)

  if (session.impersonation.is_impersonation):
    if (session.impersonation.impersonation_expires_at < now):
      // Impersonation has expired
      deleteSession(session.id)
      return 401 { error: 'impersonation_expired' }

  next()
```

### 5. Immutable Audit Log

The `impersonation_audit_log` table should be append-only (no updates/deletes):

```
CREATE TABLE impersonation_audit_log (
  id BIGINT PRIMARY KEY,
  admin_id STRING,
  impersonated_user_id STRING,
  ... other fields ...
  CONSTRAINT no_updates CHECK (TRUE)  -- prevent updates
)
```

### 6. IP Logging

Log the IP address of the admin for later investigation if needed:

```pseudocode
logImpersonationAction(session, request):
  log.ip_address = request.headers['x-forwarded-for'] || request.ip
```

---

## Gotchas

### 1. Two-Session Problem

When an admin impersonates a user, they have two identities:
- The session token (has impersonation flag)
- The user data returned from API (the impersonated user)

If you mix these up, you might return the wrong data. Always check `session.impersonation.is_impersonation` first:

```pseudocode
// WRONG: uses session.user_id instead of impersonated user_id
GET /api/user/profile:
  return db.users.findOne({ user_id: session.user_id })

// RIGHT: checks impersonation flag
GET /api/user/profile:
  if (session.impersonation.is_impersonation):
    return db.users.findOne({
      user_id: session.impersonation.impersonated_user_id
    })
  else:
    return db.users.findOne({ user_id: session.user_id })
```

### 2. Notifications May Stress Users

Sending a notification to the user that an admin is viewing their account can cause panic, especially if they don't understand the purpose. Consider:
- Making the notification optional (admin can suppress it)
- Or sending it only to paid accounts (not free tier)
- Or only to accounts with prior support tickets

### 3. Impersonation Showing Sensitive Data

If the user has PII or sensitive data in their account, the admin sees it all. This is intentional but document it in your privacy policy:

"Our support team may view your account to assist with issues. All access is logged and audited."

### 4. Blocked Actions Not Obvious

When an admin tries a blocked action (e.g., changing the user's password), the error "action_blocked_during_impersonation" might be confusing. Explain it clearly in UI:

```
[Error modal]
Action Not Allowed During Impersonation

You cannot perform this action while impersonating a user.
This is a safety feature to prevent accidental data changes.

End impersonation to perform this action, or ask the user to make the change themselves.

[End impersonation button] [Close]
```

### 5. Cookie-Based Session Tokens

If impersonation flag is stored in a cookie and the admin clicks "inspect" in the browser dev tools, they might be able to remove the impersonation flag. Always validate server-side:

```pseudocode
// Server: always re-validate impersonation state
middleware authenticateRequest(request):
  session = db.sessions.findOne({ token: request.cookies.sessionToken })

  if (!session):
    return 401

  if (session.impersonation.is_impersonation):
    if (session.impersonation.impersonation_expires_at < now):
      return 401  // expired
    if (!session.impersonation.original_admin_id):
      return 401  // tampered

  request.session = session
```

### 6. Impersonation During Data Export

If a user requests a data export while an admin is impersonating them, whose data is exported? The impersonated user's data is correct. But the audit log should show:

```
{
  event: 'data_export_requested',
  triggered_by: 'impersonation',  // not the user
  admin_id: 'admin_123',
  impersonated_user_id: 'user_456',
  timestamp: now
}
```

### 7. Race Condition: User Logs In During Impersonation

If admin starts impersonating a user, and that user opens the app in another browser, the user's real session is separate from the impersonation session. The user sees the app normally, the admin sees the user's data. This is correct behavior but document it.

If you want to prevent the user from using the app while being impersonated, revoke their other sessions:

```pseudocode
POST /api/admin/impersonate:
  // optional: log out the user on other devices
  // revokeUserSessions(targetUserId, except=[newImpersonationSessionId])
```

### 8. Impersonation of Recently Deleted Users

If a user was recently deleted but their data is in an archive table, attempting to impersonate them should fail gracefully:

```pseudocode
POST /api/admin/impersonate:
  user = db.users.findOne({ user_id: request.body.user_id })

  if (!user):
    // Check if user was recently deleted
    archive = db.user_archives.findOne({ user_id })
    if (archive and archive.deleted_at > now - 30.days):
      return 410 {
        error: 'user_deleted',
        message: 'User was deleted 5 days ago. Cannot impersonate.'
      }
    else:
      return 404

  startImpersonation(admin.user_id, user.user_id)
```

