---
name: GDPR Data Export & Deletion Endpoints
description: Machine-readable data export and right-to-erasure endpoints
type: enhancement
requires: recipes/otp.md, recipes/account-deletion.md
env_vars: (none)
---

# GDPR Data Export & Deletion Endpoints

Two GDPR compliance endpoints: GET `/api/account/export` returns JSON archive of all user data; DELETE `/api/account` triggers the deletion flow. Export is async for large datasets (queued job, email link when ready). Covers what data to include, what to redact, and retention logging.

---

## Overview

Implement two GDPR-required endpoints that give users control of their data:

1. **Right to Data Portability** (GDPR Article 20): User can export all data as machine-readable JSON
2. **Right to Erasure** (GDPR Article 17): User can request permanent deletion

Both endpoints require authentication and are user-initiated. This recipe works with `account-deletion.md` for the deletion flow and adds export functionality.

---

## Data Model

New table: `data_exports` (tracks export tasks)

```
DataExport {
  id:              auto-generated primary key
  user_id:         string (FK users.user_id)
  requested_at:    datetime
  started_at:      datetime | null
  completed_at:    datetime | null
  status:          enum('pending', 'processing', 'ready', 'failed')
  file_path:       string | null  // path to exported file
  file_size:       integer | null // bytes
  expires_at:      datetime | null
  error_message:   string | null
  expiry_policy:   string  // 'auto_delete_7_days' or similar
}
```

**Indexes:**
- Index on `user_id` — find exports for a user
- Index on `status` — find pending/ready exports
- TTL on `expires_at` — auto-delete old export files

---

## API Routes

### GET `/api/account/export`

Request a data export.

**Request:** (empty)

**Response (Immediate, < 1 MB):**
```
{
  status: 'export_ready',
  data: {
    user: { ... },
    sessions: [ ... ],
    notifications: [ ... ],
    // ... all user data
  },
  download_url: null,
  expires_at: null
}
```

**Response (Async, > 1 MB):**
```
{
  status: 'export_queued',
  task_id: string,
  estimated_completion_at: datetime,
  message: 'Your data export is being prepared. We\'ll email you a download link.'
}
```

**Validation:**
- User must be authenticated
- Rate limit: 1 export request per 24 hours per user (exports are expensive)
- If an export is already in progress, return current status instead of queuing another

**Side effects:**
- If small: return immediately
- If large: queue async job, return task_id
- Log export request (for compliance)

### GET `/api/account/export/:task_id`

Check status of async export.

**Response:**
```
{
  task_id: string,
  status: enum('pending', 'processing', 'ready', 'failed'),
  progress_percent?: integer,  // e.g., 45
  download_url?: string,       // signed URL if ready
  expires_at?: datetime,
  error_message?: string       // if failed
}
```

### DELETE `/api/account`

Trigger account deletion (delegated to `account-deletion.md` recipe).

**Request:**
```
{
  confirm_delete: boolean
}
```

**Response:**
```
{
  status: 'deletion_scheduled',
  scheduled_at: datetime,
  grace_period_days: 7,
  message: 'Check your email to confirm deletion'
}
```

This is the same endpoint as in `account-deletion.md`; no duplicate documentation needed.

---

## Export Data Structure

### Full Export Format

```json
{
  "export_meta": {
    "generated_at": "2025-03-26T14:30:00Z",
    "version": "1.0",
    "user_id_redacted": true,
    "pii_redacted": ["password_hash", "session_tokens"],
    "data_categories": [
      "user_profile",
      "sessions",
      "notifications",
      "preferences"
    ]
  },
  "user": {
    "user_id": "sha256(seed+email)",
    "email": "user@example.com",
    "display_name": "John Doe",
    "role": "user",
    "created_at": "2024-01-15T10:00:00Z",
    "updated_at": "2025-03-26T12:00:00Z"
  },
  "sessions": [
    {
      "id": "session_abc123",
      "status": "active",
      "email": "user@example.com",
      "created_at": "2025-03-20T08:30:00Z",
      "expires_at": "2025-04-20T08:30:00Z",
      "last_used_at": "2025-03-26T14:00:00Z"
    }
  ],
  "notifications": [
    {
      "id": "notif_xyz789",
      "type": "password_reset",
      "title": "Password Updated",
      "message": "Your password was successfully changed",
      "read_at": "2025-03-26T10:00:00Z",
      "created_at": "2025-03-26T09:50:00Z"
    }
  ],
  "preferences": {
    "notify_password_reset": true,
    "notify_account_deletion": true,
    "push_enabled": false
  }
}
```

### What to Include

Include all data the user generated or that is directly linked to them:
- User profile (user_id, email, display_name, role, timestamps)
- Sessions (but NOT session tokens in plaintext; see redaction below)
- Notifications (all notifications they received)
- User preferences (notification settings, theme, etc.)
- Any app-specific data (alerts, reviews, purchases, etc.)

### What to Redact / Exclude

**Never export:**
- `session_token` (even if hashed) — user could use it to hijack sessions
- `password_hash` — never useful to user
- `otp_hash` — expired OTPs are useless; current ones are security risk
- `link_token` — expired magic links are useless
- API keys or secrets (if user has any)
- IP addresses from sessions (privacy)
- User-agent strings (privacy)

**Redact/hash:**
- Phone numbers (if stored): show last 4 digits only, e.g., "****5678"
- Payment information (if stored): show last 4 digits only
- OAuth provider user IDs: exclude entirely (third-party data)

---

## Async Export Implementation

### Job: Generate Export

For large exports, run async job:

```pseudocode
async function generateDataExport(userId, taskId):
  dataExport = db.data_exports.findOne({ id: taskId })

  try:
    dataExport.status = 'processing'
    dataExport.started_at = now
    dataExport.save()

    // Fetch data in batches (stream to avoid memory issues)
    userData = fetchUserData(userId)
    sessionData = fetchSessions(userId, limit=1000)  // paginate
    notificationData = fetchNotifications(userId, limit=1000)
    preferencesData = fetchPreferences(userId)

    // Aggregate into export object
    exportData = {
      export_meta: {...},
      user: userData,
      sessions: sessionData,
      notifications: notificationData,
      preferences: preferencesData,
      // ... other tables
    }

    // Convert to JSON (pretty-printed for readability)
    jsonString = JSON.stringify(exportData, null, 2)

    // Compress for storage
    compressed = gzip(jsonString)

    // Store file securely
    fileKey = 'exports/' + userId + '/' + taskId + '.json.gz'
    fileUrl = storage.upload(fileKey, compressed, {
      contentType: 'application/gzip',
      metadata: {
        user_id: userId,
        expires_at: (now + 7 days).toISOString()
      }
    })

    // Update task
    dataExport.status = 'ready'
    dataExport.completed_at = now
    dataExport.file_path = fileKey
    dataExport.file_size = compressed.length
    dataExport.expires_at = now + 7 days
    dataExport.save()

    // Email download link to user
    downloadToken = generateSignedToken(userId, taskId, expires=7days)
    downloadUrl = 'https://app.example.com/download/export/' + downloadToken
    sendExportReadyEmail(userId, downloadUrl)

    log('export_generated', userId, taskId)

  catch (error):
    dataExport.status = 'failed'
    dataExport.error_message = error.message
    dataExport.save()
    log('export_failed', userId, taskId, error)
    sendExportFailedEmail(userId)
```

### Cleanup: Delete Old Exports

Background job (daily):

```pseudocode
job deleteExpiredExports():
  expiredExports = db.data_exports.find({
    status: 'ready',
    expires_at: { $lte: now }
  })

  for dataExport in expiredExports:
    try:
      storage.delete(dataExport.file_path)
      dataExport.delete()  // remove from DB
      log('export_deleted', dataExport.user_id, dataExport.id)
    catch (error):
      log('error_deleting_export', dataExport.id, error)
```

---

## Download Endpoint

### GET `/download/export/:token`

Public endpoint (no auth required) to download an export using a signed token.

**Token format:** JWT or HMAC-signed token containing:
```
{
  user_id: string,
  task_id: string,
  exp: timestamp,
  type: 'export_download'
}
```

**Response:**
- Validate token (signature, expiry)
- Fetch file from storage
- Return file with `Content-Disposition: attachment` header
- Log download event

```pseudocode
GET /download/export/:token:
  try:
    payload = verifySignedToken(token)
    if (payload.type != 'export_download' or payload.exp < now):
      return 401

    taskId = payload.task_id
    dataExport = db.data_exports.findOne({ id: taskId })
    if (!dataExport or dataExport.status != 'ready'):
      return 404

    // Fetch file
    fileBuffer = storage.download(dataExport.file_path)

    // Return with headers
    response.setHeader('Content-Type', 'application/gzip')
    response.setHeader('Content-Disposition', 'attachment; filename=data-export.json.gz')
    response.setHeader('Content-Length', dataExport.file_size)
    response.send(fileBuffer)

    log('export_downloaded', payload.user_id, taskId)

  catch (error):
    return 404
```

---

## Email Template

### Export Ready Email

```
Subject: Your data export is ready

Dear [user_name],

Your data export has been generated and is ready for download.

[Download link with expiry notice: expires in 7 days]

[Alternative]: If the link above doesn't work, visit:
https://app.example.com/account/export-history
and find "Export from [date]" with a download button.

This file contains all your personal data in JSON format.
For security, download links expire after 7 days.

If you have any questions, contact privacy@example.com
```

### Export Failed Email

```
Subject: Your data export failed

Dear [user_name],

We attempted to generate your data export, but encountered an error:
[error_message]

Please try again:
https://app.example.com/account/settings/export

If the problem persists, contact privacy@example.com
```

---

## Security & Compliance Notes

### 1. File Encryption

Export files should be encrypted at rest in storage:

- Use storage backend's built-in encryption (S3 server-side encryption, GCS encryption)
- OR use application-level encryption: `AES-256-GCM` with random IVs
- Signed URLs should be HTTPS-only

### 2. Signed Download URLs

Don't use predictable URLs like `/download/export/123`. Use cryptographically signed tokens:

```pseudocode
function generateSignedToken(userId, taskId, expiresIn=7*24*60*60):
  payload = {
    user_id: userId,
    task_id: taskId,
    exp: now + expiresIn,
    type: 'export_download'
  }
  token = signJwt(payload, secret=APP_SECRET)
  return token
```

### 3. Rate Limiting

Exports are resource-intensive. Limit to 1 per 24 hours per user.

### 4. Audit Logging

Log all export requests and downloads for compliance:

```
export_requested: user_id, timestamp
export_generated: user_id, file_size, timestamp
export_downloaded: user_id, timestamp, ip_address
export_expired: user_id, task_id, timestamp
```

### 5. Data Consistency

If deletion happens before export completes, the async export job will fail (user deleted mid-export). Handle gracefully:

```pseudocode
// In deleteExpiredAccounts() job from account-deletion.md:
// Before hard-deleting user, cancel any pending exports

pendingExports = db.data_exports.find({
  user_id: userId,
  status: { $in: ['pending', 'processing'] }
})

for dataExport in pendingExports:
  dataExport.status = 'cancelled'
  dataExport.save()
```

---

## Gotchas

### 1. Export Size Explosion

If user has millions of notifications or records, the JSON file becomes huge (hundreds of MB). Pagination and streaming are essential:

```pseudocode
// WRONG: load all data into memory
allNotifications = db.notifications.find({ user_id })
data.notifications = allNotifications

// RIGHT: stream data to file
writeStream = createWriteStream(filepath)
writeStream.write('[')

batchSize = 1000
offset = 0
first = true
while true:
  batch = db.notifications.find({ user_id }).limit(batchSize).skip(offset)
  if batch.empty: break
  if not first:
    writeStream.write(',')
  writeStream.write(JSON.stringify(batch))
  first = false
  offset += batchSize

writeStream.write(']')
```

### 2. Circular References

If related data is included (e.g., user → sessions → user_id), avoid circular references in JSON:

```
// WRONG: user contains session object that contains user object
{
  user: { user_id, session: { user_id, session: {...} } }
}

// RIGHT: flatten or use references
{
  user: { user_id, ... },
  sessions: [ { user_id, ... } ]
}
```

### 3. Sensitive Data in Related Records

When exporting related records, check each one for sensitive data. E.g., if exporting "support tickets", don't include password resets or payment info:

```pseudocode
function exportUserData(userId):
  user = db.users.findOne({ user_id: userId })
  data.user = redact(user, ['password_hash'])

  sessions = db.sessions.find({ user_id: userId })
  data.sessions = sessions.map(s => redact(s, ['session_token', 'otp_hash']))

  notifications = db.notifications.find({ user_id: userId })
  data.notifications = notifications  // OK to export as-is

  return data
```

### 4. Export Leaking User Existence

If you log export requests with user_id, and an attacker gains access to logs, they can enumerate user IDs. Use hashed user_ids in logs:

```
export_requested: user_id_hash, timestamp
// not:
export_requested: user_id (plaintext), timestamp
```

### 5. Download Link Reuse

A signed token used to download an export is valid until it expires. If the link is shared or leaked, anyone can download the export. Mitigate by:

- Short expiry (7 days max)
- One-time tokens (if truly critical): mark token as used after first download

```pseudocode
GET /download/export/:token:
  payload = verifyToken(token)
  usedToken = db.export_tokens.findOne({ token })
  if (usedToken):
    return 403 { message: 'Download link already used' }

  // Log as used
  db.export_tokens.insert({ token, used_at: now })

  // Return file...
```

### 6. Incomplete Exports

If an export job crashes partway through, the file is incomplete. Add a file integrity check:

```json
{
  "export_meta": {
    "status": "complete",
    "total_records": 12345
  },
  ...
  "data": [...]
  // If file is cut off mid-JSON, it's incomplete
}
```

On download, validate JSON is parseable before serving.

