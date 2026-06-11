---
name: Account Deletion (GDPR)
description: User self-service account deletion with data export
type: enhancement
requires: recipes/otp.md
env_vars: (none)
---

# Account Deletion (GDPR)

GDPR-compliant user self-service account deletion with optional data export. Two-step confirmation: user requests deletion → confirmation email with 7-day grace period → hard delete. Admin can cancel pending deletions.

---

## Overview

Users can permanently delete their accounts and all associated data. Flow:

1. User navigates to settings → "Delete Account"
2. Shows warning about permanent data loss; user confirms intent
3. Server sends confirmation email with a cancellation link
4. Grace period: 7 days during which user can cancel
5. After 7 days, account and all FK-linked data are hard-deleted
6. Deletion cascades to all related records (configurable per app)

Optional: Data export endpoint allows users to download JSON archive of all their data before deletion.

---

## Data Model

New table: `account_deletions` (pending deletion requests)

```
AccountDeletion {
  id:              auto-generated primary key
  user_id:         string (FK users.user_id)
  email:           string (denormalized)
  requested_at:    datetime
  scheduled_at:    datetime  // 7 days from requested_at
  cancelled_at:    datetime | null
  deleted_at:      datetime | null
  reason:          string | null  // optional feedback from user
  cancellation_token: string  // random 32-byte hex for cancellation link
}
```

**Indexes:**
- Index on `user_id` — find pending deletion for a user
- Index on `scheduled_at` — cleanup job queries this
- Index on `cancellation_token` (sparse) — cancel deletion via link

---

## API Routes

### POST `/api/account/delete-request`

Request account deletion.

**Request:**
```
{
  confirm_delete: boolean  // user must explicitly pass true
  reason?: string          // optional: why they're leaving
}
```

**Validation:**
- User must be authenticated
- `confirm_delete` must be true (prevents accidental deletion)
- Check if deletion already pending: if so, return 409 (already scheduled)

**Response:**
```
{
  status: 'deletion_scheduled',
  scheduled_at: datetime,  // ISO 8601
  grace_period_days: 7,
  message: 'Check your email to confirm deletion or cancel'
}
```

**Side effects:**
- Create `AccountDeletion` record with `scheduled_at = now + 7 days`
- Generate `cancellation_token`
- Send confirmation email to user
- Log event (for audit)

### POST `/api/account/delete-cancel`

Cancel a pending deletion (within grace period).

**Request:**
```
{
  token: string  // from email link
}
```

**Validation:**
- Lookup `AccountDeletion` by `cancellation_token`
- Verify not yet deleted (`deleted_at` is null)
- Verify within grace period (`scheduled_at > now`)

**Response:**
```
{
  status: 'deletion_cancelled',
  message: 'Your account has been restored'
}
```

**Side effects:**
- Update `account_deletions.cancelled_at = now`
- Log cancellation event
- Send confirmation email to user

### DELETE `/api/account`

Perform account hard deletion (used by scheduled job after grace period, or immediate deletion if admin-triggered).

**Request:** (empty)

**Validation:**
- User must be authenticated
- Verify grace period has elapsed (if called by user directly, not job)
- Or, admin can force immediate deletion via internal endpoint

**Response:**
```
{
  status: 'account_deleted'
}
```

**Side effects:**
- Hard-delete `users` record
- Cascade-delete all FK-linked records (alerts, preferences, sessions, etc.)
- Mark `account_deletions.deleted_at = now`
- Revoke all sessions for this user
- Log deletion event with admin/system as actor
- Write deletion audit log (user_id, email, timestamp) for compliance

### GET `/api/account/export`

Export user data as JSON archive (optional).

**Request:** (empty)

**Validation:**
- User must be authenticated

**Response:** (async)

If small dataset (< 1 MB), return immediately:
```
{
  status: 'export_ready',
  data: {
    user: { user_id, email, display_name, ... },
    sessions: [...],
    [other records by table]
  }
}
```

If large dataset, return async task ID:
```
{
  status: 'export_queued',
  task_id: string,
  expires_at: datetime,  // 7 days
  message: 'Export is being prepared. Check your email when ready'
}
```

**Side effects:**
- Log export request (for compliance)
- Send download link via email when ready
- Store export file securely (encrypted, password-protected or temporary token)
- Auto-delete export files after 7 days

---

## Scheduled Deletion Job

Background job runs daily (or hourly) to hard-delete accounts past grace period:

```pseudocode
job deleteExpiredAccounts():
  pendingDeletions = db.account_deletions.find({
    cancelled_at: null,
    deleted_at: null,
    scheduled_at: { $lte: now }
  })

  for deletion in pendingDeletions:
    try:
      hardDeleteAccount(deletion.user_id)
      deletion.deleted_at = now
      deletion.save()
      log('account_deleted', deletion.user_id)
    catch (error):
      log('error deleting account', deletion.user_id, error)
      alert('Account deletion failed for ' + deletion.user_id)
```

Run on a schedule (cron, cloud scheduler, etc.):
```
0 2 * * *  (2 AM daily)
```

---

## Cascade Deletion Configuration

Apps may have different requirements for what gets deleted. Define cascade rules per app:

```
deletion_cascade:
  - table: 'sessions'
    delete: true        // delete all sessions for this user
  - table: 'alerts'
    delete: true        // delete all price alerts
  - table: 'reviews'
    delete: false       // keep reviews (anonymized separately)
    anonymize: true
      set_user_id: null
      set_display_name: 'Deleted User'
  - table: 'purchases'
    delete: false       // keep purchase history (legal requirement)
    anonymize: true
      set_email: 'deleted@example.com'
      set_user_id: null
```

Implementation:

```pseudocode
function hardDeleteAccount(userId, cascadeRules):
  // Start transaction
  beginTransaction()

  try:
    // Apply cascade rules
    for rule in cascadeRules:
      if (rule.delete):
        db[rule.table].deleteMany({ user_id: userId })
      else if (rule.anonymize):
        db[rule.table].updateMany(
          { user_id: userId },
          rule.anonymize
        )

    // Delete user record itself
    db.users.deleteOne({ user_id: userId })

    // Revoke all sessions
    db.sessions.deleteMany({ user_id: userId })

    // Soft-delete from other tables if needed
    // (some apps want audit trail of deleted users)

    commitTransaction()
    return true

  catch (error):
    rollbackTransaction()
    throw error
```

---

## Email Templates

### Deletion Requested

```
Subject: Confirm account deletion — 7-day grace period

Dear [display_name],

Your account deletion request has been received.

Your account will be permanently deleted on [scheduled_date]
unless you cancel the request.

To cancel deletion and keep your account:
[Cancellation link with token]

To proceed with deletion, do nothing.

If you have questions, contact support@example.com
```

### Deletion Cancelled

```
Subject: Account deletion cancelled

Dear [display_name],

Your account deletion has been cancelled.
Your account is now restored and active.

If you didn't cancel this, please contact support@example.com immediately.
```

### Deletion Completed (Post-Deletion Notification)

Send to email address before user is deleted (if possible):

```
Subject: Your account has been permanently deleted

Dear [email],

Your account has been permanently deleted.
All associated data has been removed.

[Privacy/support contact info]
```

---

## UI Spec

### Account Settings: Danger Zone

```
[Heading: "Delete Account"]
[Warning icon]

This action is permanent and cannot be undone.
All your data will be deleted, including:
- Profile information
- Sessions and login history
- Associated records (alerts, reviews, etc.)

[Export data button] (optional)
[Delete account button] (red/danger styling)
```

### Confirmation Modal

After clicking "Delete Account":

```
[Modal: "Confirm Account Deletion"]

Are you sure? This cannot be undone.

[Checkbox] I understand my account and all data will be deleted

[Reason dropdown] (optional)
  ○ No longer need it
  ○ Privacy concerns
  ○ Switching services
  ○ Other

[Cancel button] [Delete permanently button] (red)
```

### Success Message

```
[Confirmation page]

Account deletion scheduled.

Your account will be deleted on [date].

Check your email for a cancellation link if you change your mind.

[Back to settings button]
```

---

## Security & Compliance Notes

### 1. Right to Erasure (GDPR Article 17)

Users must be able to request deletion without barriers. Implement with:

- One-click access to delete button (not buried in settings)
- Clear explanation of what will be deleted
- Optional data export before deletion
- No cancellation fees or delays (grace period is for user's benefit, not app's)

### 2. Audit Trail

Maintain a deletion audit log for compliance (separate from deleted data):

```
DeletionAuditLog {
  timestamp: datetime
  user_id: string (hashed or removed)
  email: string (hashed)
  initiated_by: enum('user', 'admin', 'automated')
  reason: string | null
  cascaded_tables: [string]  // tables affected
  rows_deleted: integer
}
```

Do NOT include personally identifiable information; log enough for compliance.

### 3. Data Retention Before Deletion

Some jurisdictions require keeping backups for a period (e.g., 30 days post-deletion). Store deleted user records in an archive table or encrypted backup before hard-deleting:

```pseudocode
function hardDeleteAccount(userId):
  // Archive user data (encrypted)
  archiveKey = encrypt(db.users.findOne({ user_id: userId }))
  db.user_archives.insert({
    archived_at: now,
    data: archiveKey,
    user_id_hash: sha256(userId),
    expires_at: now + 30 days
  })

  // Hard delete
  db.users.deleteOne({ user_id: userId })
  // cascade deletes...
```

### 4. Email Confirmation

Require explicit confirmation via email link to prevent accidental deletion. The cancellation link itself acts as confirmation that the email was received.

### 5. No Reactivation

Once deleted, user_id and email cannot be reused. If user tries to sign up with the same email later, create a NEW user_id. This prevents attackers from re-registering a deleted account.

---

## Gotchas

### 1. Race Condition: Delete Request + New Login

User requests deletion, then logs in on another device. Both the delete job and new session creation run concurrently. The session should either:

1. Be prevented (account marked for deletion, login rejected), OR
2. Be kept but deleted shortly after (race condition)

**Solution:** Check deletion status before allowing login:

```pseudocode
POST /api/auth/verify-otp:
  // ... verify OTP ...
  user = db.users.findOne({ email })

  // NEW: check if deletion is pending
  deletion = db.account_deletions.findOne({
    user_id: user.user_id,
    cancelled_at: null,
    deleted_at: null
  })

  if (deletion and deletion.scheduled_at <= now):
    // Grace period expired; account being deleted
    return 403 { message: 'Account has been deleted' }

  if (deletion and deletion.scheduled_at > now):
    // Grace period not yet elapsed; allow login but warn user
    warn('Your account is scheduled for deletion on [date]')
```

### 2. Orphaned Avatar Files

If user has uploaded an avatar (from `avatar-upload.md`), hard-deleting the user leaves avatar files in storage. Clean them up during cascade:

```pseudocode
cascadeDelete(userId):
  // Delete avatar files
  user = db.users.findOne({ user_id: userId })
  if (user.avatar_storage_key):
    storage.delete(user.avatar_storage_key)

  // Delete user record and cascade
```

### 3. Referential Integrity with Cascade

If using a strict database (PostgreSQL with FK constraints), cascading deletes can fail if constraints are set incorrectly. Ensure:

```
users (user_id PRIMARY KEY)
  ↓
sessions (user_id FK → users, ON DELETE CASCADE)
alerts (user_id FK → users, ON DELETE CASCADE)
...
```

Or handle cascade explicitly in application code (safer for NoSQL databases).

### 4. Export Data Size

Exporting large datasets (millions of records) can be memory-intensive. Stream data to avoid loading entire dataset into memory:

```pseudocode
async function* exportUserData(userId):
  yield '{"user": ' + JSON.stringify(user) + ', "records": ['

  batchSize = 1000
  for table in tables:
    offset = 0
    while true:
      records = db[table].find({ user_id: userId })
        .limit(batchSize)
        .offset(offset)
      if (records.empty):
        break
      for record in records:
        yield JSON.stringify(record) + ','
      offset += batchSize

  yield ']}'
```

### 5. Grace Period Too Long

7 days is standard, but some users might wait and forget they requested deletion, then be surprised when deleted. Consider:

- Reminder email at day 3 or 5 ("Your account will delete in 2 days")
- Shorter grace period (24–48 hours) for simpler apps
- Configurable per app

### 6. Admin Override Logging

If admins can force-delete accounts, ensure it's logged with admin identity:

```pseudocode
DELETE /admin/users/:user_id:
  admin = requireAdmin(request)
  hardDeleteAccount(user_id, initiatedBy=admin.user_id)
  logAuditEvent('account_deleted_by_admin', user_id, admin.user_id)
```

