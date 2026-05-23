---
name: Admin CRUD of Users
description: Full admin interface for managing users - list, detail view, edit, delete
type: enhancement
requires: recipes/admin-dashboard.md, recipes/account-deletion.md
env_vars: (none)
---

# Admin CRUD of Users

Full administrative interface for managing users. Admins can view a paginated, filterable list of all users, inspect individual user details, edit user properties, revoke sessions, reset email health, and delete user accounts. All mutations are logged to audit trail. Integrates with account-deletion and user-impersonation recipes when available.

---

## Overview

The admin user management interface provides:

1. **List View**: Paginated table of all users with search, filters, and sorting
2. **Detail View**: Full user record with related data panels (sessions, subscription info, audit log)
3. **Editable Fields**: Change display name, role, and email health status
4. **Actions**: Change role, revoke sessions, reset email health, send password reset, impersonate, delete user
5. **Audit Trail**: All mutations logged with admin identity
6. **Integrations**: Links to user-impersonation, account-deletion, and subscription recipes

---

## Data Model

The user CRUD feature leverages existing `users` and `sessions` tables. No new tables required, but audit logging uses existing audit infrastructure.

Assumed `users` table schema:

```
User {
  user_id:        string (primary key)
  email:          string (unique)
  display_name:   string
  role:           enum('user', 'admin')
  email_health:   enum('healthy', 'bounced', 'complaint', 'unsubscribed')
  created_at:     datetime
  updated_at:     datetime
}
```

Assumed `sessions` table:

```
Session {
  session_id:     string (primary key)
  user_id:        string (FK users.user_id)
  token:          string
  created_at:     datetime
  last_used_at:   datetime
  revoked_at:     datetime | null
  ip_address:     string
  user_agent:     string
}
```

Optional related tables (if subscriptions enabled):

```
Subscription {
  subscription_id: string
  user_id:        string (FK)
  status:         enum('active', 'cancelled', 'paused')
  plan_id:        string
  created_at:     datetime
  renewed_at:     datetime
  cancels_at:     datetime | null
}
```

Audit trail (shared across app, not user-specific):

```
AuditLog {
  id:             string
  actor_id:       string  // admin user_id
  action:         string  // 'user_updated', 'user_deleted', etc.
  resource_type:  string  // 'user'
  resource_id:    string  // user_id
  changes:        object  // { field: { old, new } }
  timestamp:      datetime
}
```

**Indexes:**
- Index on `email` — lookup by email
- Index on `role` — filter by admin/user
- Index on `created_at` — sort by creation date
- Index on `email_health` — filter by health status
- Composite index on `(role, created_at)` — common query pattern
- Index on AuditLog `(resource_type, resource_id, timestamp)` — find user's audit history

---

## API Routes

All endpoints require `requireAdmin()` middleware.

### GET `/api/admin/users` (List Users)

Fetch paginated list of all users with filtering and sorting.

**Query Parameters:**

```
limit?: integer          // default: 50, max: 200
offset?: integer         // default: 0
sort_by?: string         // default: 'created_at'
sort_order?: 'asc'|'desc'  // default: 'desc'
search?: string          // search email or display_name
role?: 'user'|'admin'    // filter by role
email_health?: enum      // filter by health status
created_after?: datetime // filter by creation date
created_before?: datetime
last_active_after?: datetime
last_active_before?: datetime
```

**Response:**

```
{
  users: [
    {
      user_id: string,
      email: string,
      display_name: string,
      role: string,
      email_health: string,
      created_at: datetime,
      last_active: datetime | null,  // from sessions.last_used_at
      subscription_status?: string,   // if billing enabled
      active_sessions_count: integer
    }
  ],
  pagination: {
    limit: integer,
    offset: integer,
    total: integer,
    has_more: boolean
  }
}
```

**Validation:**
- `limit` must be 1-200
- `offset` must be >= 0
- `sort_by` must be in allowed list: `['user_id', 'email', 'display_name', 'role', 'created_at', 'last_active']`
- `sort_order` must be 'asc' or 'desc'

**Implementation:**

```pseudocode
GET /api/admin/users:
  admin = requireAdmin(request)

  query = buildQuery({
    role: request.query.role,
    email_health: request.query.email_health,
    created_at: {
      $gte: request.query.created_after,
      $lte: request.query.created_before
    }
  })

  if (request.query.search):
    query.$or = [
      { email: { $ilike: '%' + search + '%' } },
      { display_name: { $ilike: '%' + search + '%' } }
    ]

  totalCount = db.users.count(query)

  users = db.users
    .find(query)
    .sort({ [request.query.sort_by]: request.query.sort_order })
    .skip(request.query.offset)
    .limit(request.query.limit)

  // Enrich with session info
  for user in users:
    sessions = db.sessions.find({
      user_id: user.user_id,
      revoked_at: null
    })
    user.active_sessions_count = sessions.length

    lastSession = sessions.max('last_used_at')
    user.last_active = lastSession?.last_used_at

    if (BILLING_ENABLED):
      subscription = db.subscriptions.findOne({
        user_id: user.user_id,
        status: 'active'
      })
      user.subscription_status = subscription?.status || 'none'

  return {
    users: users,
    pagination: {
      limit: request.query.limit,
      offset: request.query.offset,
      total: totalCount,
      has_more: (offset + limit) < totalCount
    }
  }
```

### GET `/api/admin/users/:user_id` (Get User Detail)

Fetch full user record with related data.

**Response:**

```
{
  user: {
    user_id: string,
    email: string,
    display_name: string,
    role: string,
    email_health: string,
    created_at: datetime,
    updated_at: datetime
  },
  sessions: [
    {
      session_id: string,
      created_at: datetime,
      last_used_at: datetime,
      ip_address: string,
      user_agent: string,
      revoked_at: datetime | null
    }
  ],
  subscription?: {
    subscription_id: string,
    status: string,
    plan_id: string,
    created_at: datetime,
    renewed_at: datetime,
    cancels_at: datetime | null
  },
  audit_log: [
    {
      action: string,
      actor_id: string,
      changes: object,
      timestamp: datetime
    }
  ]
}
```

### PATCH `/api/admin/users/:user_id` (Update User)

Update editable user fields.

**Request:**

```
{
  display_name?: string,
  role?: 'user' | 'admin',
  email_health?: 'healthy' | 'bounced' | 'complaint' | 'unsubscribed'
}
```

**Validation:**
- `display_name` must be 1-255 characters
- `role` must be valid enum
- `email_health` must be valid enum
- Cannot change user's own role to 'user' (prevent self-demotion)
- Cannot change email (use separate email change endpoint if needed)

**Response:**

```
{
  status: 'user_updated',
  user: { ... }
}
```

**Side effects:**
- Update user record
- Log to audit trail: `user_updated` with changes
- Broadcast event to analytics/monitoring

```pseudocode
PATCH /api/admin/users/:user_id:
  admin = requireAdmin(request)
  user = db.users.findOne({ user_id })

  if (!user):
    return 404

  // Prevent self-demotion
  if (request.body.role == 'user' and user.user_id == admin.user_id):
    return 400 { error: 'cannot_demote_self' }

  updates = {
    display_name: request.body.display_name,
    role: request.body.role,
    email_health: request.body.email_health,
    updated_at: now
  }

  // Remove null/undefined
  updates = filterEmpty(updates)

  db.users.updateOne({ user_id }, updates)

  logAuditEvent('user_updated', {
    actor_id: admin.user_id,
    resource_id: user_id,
    changes: {
      display_name: { old: user.display_name, new: updates.display_name },
      role: { old: user.role, new: updates.role },
      email_health: { old: user.email_health, new: updates.email_health }
    }
  })

  return { status: 'user_updated', user: updates }
```

### DELETE `/api/admin/users/:user_id` (Delete User)

Hard delete user account and all associated data.

**Request:** (empty)

**Response:**

```
{
  status: 'user_deleted',
  deleted_user_id: string,
  message: 'User account and all associated data has been deleted'
}
```

**Side effects:**
- Hard-delete user record
- Cascade-delete all FK-linked records (sessions, subscriptions, etc.)
- Log deletion event
- Revoke all sessions
- Send notification to user's email (optional)

**Validation:**
- User must exist
- Cannot delete another admin (only same-role deletion or higher)
- Require confirmation flag

```pseudocode
DELETE /api/admin/users/:user_id:
  admin = requireAdmin(request)
  user = db.users.findOne({ user_id })

  if (!user):
    return 404

  // Prevent deleting other admins
  if (user.role == 'admin' and user.user_id != admin.user_id):
    return 403 { error: 'cannot_delete_admin' }

  // Start transaction
  beginTransaction()

  try:
    // Cascade delete related records
    db.sessions.deleteMany({ user_id: user_id })
    db.subscriptions.deleteMany({ user_id: user_id })
    db.alerts.deleteMany({ user_id: user_id })  // app-specific
    // ... delete other FK records ...

    // Delete user
    db.users.deleteOne({ user_id: user_id })

    // Log deletion
    logAuditEvent('user_deleted', {
      actor_id: admin.user_id,
      resource_id: user_id,
      user_email: user.email
    })

    commitTransaction()

    // Optional: send notification email
    sendEmail(user.email, 'Account Deleted',
      'An admin has deleted your account...')

    return {
      status: 'user_deleted',
      deleted_user_id: user_id
    }

  catch (error):
    rollbackTransaction()
    throw error
```

### POST `/api/admin/users/:user_id/revoke-sessions` (Revoke All Sessions)

Force-logout user by revoking all active sessions.

**Request:** (empty)

**Response:**

```
{
  status: 'sessions_revoked',
  revoked_count: integer,
  message: 'User has been logged out on all devices'
}
```

**Side effects:**
- Mark all sessions as revoked (`revoked_at = now`)
- Log audit event
- Notify user (optional)

```pseudocode
POST /api/admin/users/:user_id/revoke-sessions:
  admin = requireAdmin(request)

  sessions = db.sessions.find({
    user_id: user_id,
    revoked_at: null
  })

  db.sessions.updateMany(
    { user_id: user_id, revoked_at: null },
    { revoked_at: now }
  )

  logAuditEvent('sessions_revoked', {
    actor_id: admin.user_id,
    resource_id: user_id,
    revoked_count: sessions.length
  })

  return {
    status: 'sessions_revoked',
    revoked_count: sessions.length
  }
```

### POST `/api/admin/users/:user_id/reset-email-health` (Reset Email Health)

Clear email health status (e.g., after user fixed bouncing email).

**Request:** (empty)

**Response:**

```
{
  status: 'email_health_reset',
  previous_status: string,
  new_status: 'healthy'
}
```

**Side effects:**
- Set `email_health = 'healthy'`
- Log audit event

```pseudocode
POST /api/admin/users/:user_id/reset-email-health:
  admin = requireAdmin(request)
  user = db.users.findOne({ user_id })

  previous = user.email_health

  db.users.updateOne(
    { user_id: user_id },
    { email_health: 'healthy', updated_at: now }
  )

  logAuditEvent('email_health_reset', {
    actor_id: admin.user_id,
    resource_id: user_id,
    changes: { email_health: { old: previous, new: 'healthy' } }
  })

  return {
    status: 'email_health_reset',
    previous_status: previous,
    new_status: 'healthy'
  }
```

### POST `/api/admin/users/:user_id/send-password-reset`

Send password reset email to user (only if password auth enabled).

**Request:** (empty)

**Response:**

```
{
  status: 'password_reset_sent',
  message: 'Password reset email sent to user@example.com'
}
```

**Side effects:**
- Generate reset token
- Send password reset email
- Log audit event

Only available if password authentication is enabled (check `AUTH_METHOD` config).

---

## UI Spec

### User List Page

Path: `/admin/users`

```
[Header]
  "Users Management"
  [Create user button] (optional, if signup disabled)

[Filters Bar]
  [Search box] "Search by email or name"
  [Role dropdown] All | Admins | Users
  [Email health dropdown] All | Healthy | Bounced | Complaint | Unsubscribed
  [Date range] "Created between"
  [Apply filters] [Clear all]

[Table]
  Columns:
    ☐ (select checkbox)
    Email
    Name
    Role
    Email Health
    Last Active
    Sessions
    Subscription (if billing enabled)
    Actions

  Rows (sortable by clicking column header):
    [☐] user@example.com | John Doe | user | healthy | 2 hours ago | 1 | active | [dropdown menu ▼]

[Pagination]
  "Showing 50 of 2,341 users"
  [< Previous] [1] [2] [3] ... [100] [Next >]

[Bulk Actions] (if rows selected)
  [Change role to...] [Revoke all sessions] [Delete]
```

Responsive: On mobile, collapse less-important columns (Sessions, Subscription), show details on row click.

### User Detail Page

Path: `/admin/users/:user_id`

```
[Header]
  [Back link]
  "User Details"
  [Actions dropdown ▼]

[User Card - Read Only Section]
  User ID:     user_123 [copy]
  Email:       user@example.com [copy]
  Created:     2024-01-15 at 10:30 UTC
  Last active: 2 hours ago

[Editable Section]
  Display Name: [text input] "John Doe"
  Role:         [dropdown] user | admin
  Email Health: [dropdown] healthy | bounced | complaint | unsubscribed

  [Save changes] [Discard]

[Actions Panel]
  [Revoke all sessions] (red)
  [Send password reset]
  [Impersonate user] (if user-impersonation enabled)
  [Delete user] (red)

[Tabs/Sections]
  Tabs: Sessions | Subscription | Audit Log

  [Sessions Tab]
    Active Sessions: 1
    [Table]
      Device/Browser | IP | Created | Last Used | [Revoke]
      Chrome 120 | 203.0.113.15 | 2 hours ago | now | [revoke]

  [Subscription Tab] (if billing enabled)
    Status: active
    Plan: Pro
    Created: 2024-01-15
    Next renewal: 2025-01-15
    [View in billing] [Cancel subscription]

  [Audit Log Tab]
    [Table]
      Timestamp | Admin | Action | Changes
      2025-01-20 10:30 | admin@example.com | user_updated | role: user → admin
      2025-01-19 14:15 | admin2@example.com | sessions_revoked | 3 sessions revoked
```

### Delete User Modal

Confirmation before deletion:

```
[Modal: "Delete User?"]

⚠️ This action is permanent and cannot be undone.

Deleting this account will:
- Permanently remove user record
- Delete all sessions and login history
- Cancel any active subscriptions
- Remove all user data (configurable per app)

User email: user@example.com

[Text input to confirm]
Type "DELETE" to confirm: [________]

[Cancel] [Delete permanently] (red, disabled until confirmed)
```

---

## Security & Compliance Notes

### 1. Require Admin Role

All admin endpoints must verify admin status:

```pseudocode
function requireAdmin(request):
  session = getSessionFromRequest(request)
  if (!session):
    return 401

  user = db.users.findOne({ user_id: session.user_id })
  if (user.role != 'admin'):
    return 403 { error: 'admin_required' }

  return user
```

### 2. Audit Logging

All mutations to user records must be logged:

```pseudocode
function logAuditEvent(action, metadata):
  logEntry = {
    id: generateId(),
    actor_id: metadata.actor_id,  // admin user_id
    action: action,               // e.g., 'user_updated'
    resource_type: 'user',
    resource_id: metadata.resource_id,
    changes: metadata.changes,
    timestamp: now
  }

  db.audit_log.insert(logEntry)
```

Admins can view all user-related audit events.

### 3. Prevent Admin Self-Demotion

Don't allow admins to demote themselves to user role:

```pseudocode
PATCH /api/admin/users/:user_id:
  admin = requireAdmin(request)

  if (request.body.role == 'user' and user_id == admin.user_id):
    return 400 { error: 'cannot_demote_self' }
```

### 4. Restrict Deletion of Other Admins

Only same-role admins can delete other admins (or higher hierarchy):

```pseudocode
DELETE /api/admin/users/:user_id:
  admin = requireAdmin(request)
  targetUser = db.users.findOne({ user_id })

  if (targetUser.role == 'admin' and targetUser.user_id != admin.user_id):
    return 403 { error: 'cannot_delete_other_admin' }
```

### 5. Privacy: Don't Log Sensitive User Data

When logging user changes, don't include passwords, API keys, or payment info:

```
// BAD: logs sensitive data
changes: {
  password: { old: 'hashed_but_still_pii', new: '...' },
  stripe_key: { old: 'sk_live_...', new: '...' }
}

// GOOD: redacts sensitive fields
changes: {
  display_name: { old: 'John', new: 'Jane' },
  role: { old: 'user', new: 'admin' }
}
```

---

## Integrations

### With User Impersonation

If user-impersonation recipe is available, add button:

```html
[Button: "Impersonate user"]
onclick -> POST /api/admin/impersonate { user_id }
```

### With Account Deletion

If account-deletion recipe is available, use its flow for soft-delete:

```
DELETE /api/admin/users/:user_id:
  if (SOFT_DELETE_ENABLED):
    // Use account-deletion recipe
    createDeletionRequest(user_id, initiated_by='admin')
    return { status: 'deletion_scheduled' }
  else:
    // Hard delete immediately
    hardDelete(user_id)
    return { status: 'user_deleted' }
```

### With Subscription Billing

If subscription recipe is available, show subscription info in detail view:

```
[Subscription Tab]
  Status: {{ subscription.status }}
  Plan: {{ subscription.plan.name }}
  Next renewal: {{ subscription.renews_at }}

  [View in billing panel]
  [Cancel subscription]
```

---

## Gotchas

### 1. Race Condition: Admin Deletes User While User Is Active

If user has active session and admin deletes them, what happens?
- User's session becomes invalid (user_id no longer exists)
- Next API call fails with 401 (user not found)
- Solution: Revoke all sessions before deleting

```pseudocode
DELETE /api/admin/users/:user_id:
  // Revoke all sessions first
  db.sessions.deleteMany({ user_id })

  // Then delete user
  db.users.deleteOne({ user_id })
```

### 2. Bulk Operations Danger

If admin selects 100 users and clicks "Delete all", this can cascade into disaster. Implement:
- Limit bulk operations to 10-20 at a time
- Require extra confirmation for bulk delete
- Log each deletion separately

### 3. Email Health Status Reset Incorrectly

If admin resets email health for a user whose email actually bounced, they'll continue sending to bad email. Document:

```
Email health should only be reset if:
1. User fixed their email address on the app
2. ISP issue was temporary and is now resolved
3. User explicitly requested to be re-added to list
```

### 4. Password Reset Link in Admin Action

If admin sends password reset email, the link is sent to the user's current email (which might be bounced). Inform admin:

```
[Info box]
Password reset email will be sent to: user@example.com

If this email address is bounced or invalid, the user won't receive the link.
Consider updating their email first, then sending the reset.
```

### 5. Impersonation Not Blocking Delete

If admin impersonates a user, they might accidentally trigger a delete (by inspecting network calls). Prevent:

```pseudocode
DELETE /api/admin/users/:user_id:
  admin = requireAdmin(request)

  // Prevent deleting while impersonating
  if (admin.session.impersonation?.is_impersonation):
    return 403 { error: 'cannot_delete_while_impersonating' }
```

### 6. Audit Log Explosion

If app has millions of users and admin tries to update all of them, audit log grows huge. Implement batch audit logging:

```pseudocode
function batchUpdateUsers(filter, updates):
  count = db.users.updateMany(filter, updates)

  // Single audit entry instead of count entries
  logAuditEvent('users_bulk_updated', {
    actor_id: admin.user_id,
    filter: filter,
    updates: updates,
    affected_count: count
  })
```

### 7. Timezone Issues in Last Active

`last_active` is calculated from `sessions.last_used_at`. If server is in UTC but displays in user's timezone, times might be confusing:

```
Server: 2025-01-20 10:30 UTC
Display: "Last active 2 hours ago" (assumes UTC)
User in PT: "That's 2:30 AM my time, but I was active at 8 PM last night"

Solution: Always display times in server timezone (UTC), or clearly label timezone
```

### 8. Display Name Uniqueness Not Enforced

If two users have the same display name, it's confusing in the admin UI. Consider:

```
Column: Name | Email | Role
John Doe | john@example.com | user
John Doe | john.smith@example.com | user
← which one did the admin mean to delete?

Solution: Show email alongside name, or enforce unique display names
```

### 9. Session Revocation Doesn't Immediately Log Out User

Revoke-sessions marks sessions as revoked, but user's app still has session token. Session becomes invalid on next request, not immediately:

```
Admin: [Click "Revoke sessions"]
User: [Still logged in until they make next API call]
User: [Swipe to refresh, gets 401 "Unauthorized"]

Solution: Send push notification to revoked user, or use WebSocket to force logout
```

### 10. Deleting Last Admin

Prevent app from losing all admins:

```pseudocode
DELETE /api/admin/users/:user_id:
  if (targetUser.role == 'admin'):
    adminCount = db.users.count({ role: 'admin' })
    if (adminCount <= 1):
      return 403 { error: 'cannot_delete_last_admin' }
```
