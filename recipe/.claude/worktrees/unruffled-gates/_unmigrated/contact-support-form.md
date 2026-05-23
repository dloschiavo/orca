---
name: Contact & Support Form
description: Reusable contact/support form component with submission handling, spam prevention, and integration hooks
type: project
---

# Contact & Support Form Recipe

A stack-agnostic, reusable contact/support form system with database persistence, spam prevention, external integrations, and admin management capabilities.

## Core Architecture

### Form Component Spec

**Layout & Fields**

```
[Contact Form]
  Name (text input, required)
  Email (email input, required, pre-filled for authenticated users)
  Category (dropdown, required, app-configured options)
  Subject (text input, max 200 chars, required)
  Message (textarea, max 5000 chars, required)
  File Attachment (optional, file input)
  [Honeypot Field - hidden from UI]
  [reCAPTCHA/custom challenge - optional per app]
  [Submit Button] [Reset Button]
```

**Validation Rules**

- Name: non-empty, 2–100 characters, no script tags
- Email: valid RFC 5322 format, must be reachable domain
- Category: must match app-configured enum
- Subject: non-empty, 5–200 characters
- Message: non-empty, 10–5000 characters, stripped of leading/trailing whitespace
- File attachment: optional, max 10 MB, whitelist of safe types (PDF, PNG, JPG, GIF, DOCX)
- Honeypot field: must be empty (catches bots)

**Responsive Behavior**

- Mobile: single-column stack, full-width inputs, touch-friendly spacing
- Tablet & desktop: optional two-column for name/email, full-width message
- Textarea auto-grows with content (max 400px height, then scroll)
- File input styled consistently across browsers
- Submit button full-width on mobile, auto-width on desktop
- Error messages display inline below affected field, color-coded red

**Accessibility**

- All form fields have associated `<label>` elements
- Required fields marked with `*` and `aria-required="true"`
- Error messages linked to inputs via `aria-describedby`
- Focus management: first invalid field receives focus on submission attempt
- Keyboard navigation: Tab through fields, Enter to submit, Escape to reset
- Screen reader: announce form errors immediately and on page load
- Contrast ratio: text/background meets WCAG AA (4.5:1 for labels)
- Form wrapper has `role="form"` or `<form>` element

---

## Submission Data Model

**Collection Schema (Submissions)**

```
submission {
  id: UUID (primary key)
  user_id: UUID | null (links to authenticated user, null for anonymous)
  name: string (2-100 chars)
  email: string (validated email)
  category: enum ['bug_report', 'feature_request', 'billing', 'account', 'other']
  subject: string (5-200 chars)
  message: string (10-5000 chars, sanitized HTML stripped)
  attachment_id: UUID | null (foreign key to file storage)
  attachment_filename: string | null
  attachment_size: integer | null (bytes)
  ip_address: string (hashed for privacy, used for rate limiting)
  user_agent: string (optional, for debugging duplicate submissions)
  status: enum ['new', 'in_progress', 'resolved', 'closed']
  admin_notes: string | null (internal notes, not visible to user)
  assigned_to: UUID | null (admin user ID)
  created_at: timestamp (UTC)
  updated_at: timestamp (UTC)
  replied_at: timestamp | null (when admin first replied)
  closed_at: timestamp | null (when status changed to closed)
}
```

**Status Lifecycle**

- `new`: submission just received, no admin action yet
- `in_progress`: admin has acknowledged and is working
- `resolved`: issue resolved, awaiting user confirmation
- `closed`: conversation ended, archived

---

## API Routes

### POST /api/support/submit

**Purpose**: Accept and store support submission

**Request Body**

```
{
  name: string
  email: string
  category: string (enum)
  subject: string
  message: string
  attachment_id: UUID | null (pre-uploaded via separate endpoint)
  honeypot_field: string (must be empty)
  user_id: UUID | null (from session, if authenticated)
}
```

**Response (201 Created)**

```
{
  success: true
  submission_id: UUID
  confirmation_email_sent: boolean
  message: "Thank you for contacting us. We'll get back to you soon."
}
```

**Response (400 Bad Request)**

```
{
  success: false
  errors: {
    email: "Invalid email format"
    message: "Message must be at least 10 characters"
  }
}
```

**Response (429 Too Many Requests)**

```
{
  success: false
  message: "Too many submissions from this IP. Try again in 1 hour."
  retry_after_seconds: 3600
}
```

**Behavior**

1. Validate all fields (see validation rules above)
2. Check honeypot field — reject if filled
3. Check rate limit by IP: max 5 submissions per hour, return 429 if exceeded
4. Sanitize message field (strip HTML tags, allow plain text only)
5. Store submission in database with `status='new'`, `created_at=now`
6. If authenticated user: attach `user_id`, pre-populate confirmation email address
7. Queue confirmation email to submitter (async)
8. **Optionally** trigger external integration hook (forward to email, Zendesk, Intercom, etc.)
9. Return success response with submission ID

---

### GET /api/admin/support

**Purpose**: List all submissions with filtering and pagination

**Query Parameters**

```
category: string | null (filter by category, e.g. ?category=bug_report)
status: string | null (filter by status, e.g. ?status=new)
page: integer (default 1, 1-indexed)
page_size: integer (default 20, max 100)
sort_by: string (default 'created_at', allowed: created_at, status, category)
sort_order: string (default 'desc', allowed: asc, desc)
```

**Response (200 OK)**

```
{
  success: true
  submissions: [
    {
      id: UUID
      user_id: UUID | null
      name: string
      email: string
      category: string
      subject: string
      status: enum
      created_at: timestamp
      updated_at: timestamp
      assigned_to: UUID | null
      admin_notes: string | null
      has_attachment: boolean
    }
    ...
  ]
  pagination: {
    page: integer
    page_size: integer
    total_count: integer
    total_pages: integer
  }
}
```

**Access Control**: Admin only (check user role in session)

**Behavior**

1. Verify user is authenticated and has admin role
2. Apply filters (category, status) if provided
3. Sort by specified field and order
4. Paginate results
5. Do not return sensitive fields (IP address hashed, user agent redacted)
6. Return count of unread submissions separately for dashboard

---

### PATCH /api/admin/support/:id

**Purpose**: Update submission status and admin notes

**Request Body**

```
{
  status: enum ['new', 'in_progress', 'resolved', 'closed'] | null
  admin_notes: string | null
  assigned_to: UUID | null
}
```

**Response (200 OK)**

```
{
  success: true
  submission: { ...updated submission object }
}
```

**Response (404 Not Found)**

```
{
  success: false
  message: "Submission not found"
}
```

**Access Control**: Admin only

**Behavior**

1. Verify user is authenticated and has admin role
2. Fetch submission by ID
3. Update fields: status, admin_notes, assigned_to, updated_at
4. If status changes from 'new' to 'in_progress' or 'resolved', update replied_at timestamp
5. If status changes to 'closed', set closed_at timestamp
6. Log change in audit trail (optional: for compliance/debugging)
7. Return updated submission

---

### POST /api/support/upload-attachment

**Purpose**: Pre-upload file attachment before form submission

**Request**: multipart/form-data with file

**Response (200 OK)**

```
{
  success: true
  attachment_id: UUID
  filename: string
  size: integer (bytes)
}
```

**Response (413 Payload Too Large)**

```
{
  success: false
  message: "File exceeds 10 MB limit"
}
```

**Response (415 Unsupported Media Type)**

```
{
  success: false
  message: "File type not allowed. Allowed: PDF, PNG, JPG, GIF, DOCX"
}
```

**Behavior**

1. Check file size, reject if > 10 MB
2. Check MIME type / file extension against whitelist
3. Generate UUID for attachment
4. Store file in secure location (cloud storage or encrypted local storage)
5. Return attachment_id to client for form submission
6. Attachment ID expires after 24 hours if not linked to a submission (cleanup job)

---

## Spam Prevention

### Honeypot Field Technique

```
<!-- Hidden from real users via CSS display:none or opacity:0 -->
<input
  type="text"
  name="website_url"
  style="display: none;"
  aria-hidden="true"
  tabindex="-1"
  aria-label="hidden field"
/>
```

**Logic**

- If honeypot field is filled, reject submission silently (don't return error, just log and discard)
- Bots that auto-fill all fields will trip this trap
- Real users never see the field, so they won't fill it

### Rate Limiting

```
rate_limit_key = hash(ip_address)

per_hour_submissions = get_submission_count(rate_limit_key, last_60_minutes)
if per_hour_submissions >= 5:
  return 429 error with retry_after header
else:
  process_submission()
  increment_counter(rate_limit_key)
```

**Implementation Notes**

- Use Redis or in-memory cache with TTL for rate limit tracking
- Hash IP address before storing (GDPR-friendly, still serves rate limiting)
- Key format: `support_submissions:{hashed_ip}:{hour}`
- Value: counter of submissions in that hour
- TTL: 61 minutes (account for clock skew)

### Input Sanitization

```
message_sanitized = strip_html_tags(message)
message_sanitized = trim_whitespace(message_sanitized)
message_sanitized = truncate(message_sanitized, 5000)
```

**Allowlist Approach**

- Accept only plain text and line breaks in message field
- Strip all HTML tags (no `<script>`, `<img onerror>`, etc.)
- Escape any remaining special characters for safe database storage and display

---

## Integration Hooks

### External System Forwarding Interface

Define an adapter interface for sending submissions to external systems:

```
interface SubmissionForwarder {
  send(submission: Submission, attachment?: File): Promise<{
    success: boolean
    external_ticket_id?: string
    error?: string
  }>
}
```

**Email Forwarder (Example)**

```
EmailForwarder implements SubmissionForwarder {
  constructor(smtp_config, recipient_email) { }

  send(submission, attachment) {
    email_body = format_submission_as_html(submission)
    send_email(
      to: recipient_email,
      subject: `Support: ${submission.subject}`,
      html: email_body,
      attachment: attachment
    )
    return { success: true }
  }
}
```

**Zendesk Integration (Example)**

```
ZendeskForwarder implements SubmissionForwarder {
  constructor(api_key, zendesk_domain) { }

  send(submission, attachment) {
    category_mapping = {
      'bug_report': 'Bug Report',
      'feature_request': 'Feature Request',
      ...
    }

    ticket = {
      subject: submission.subject,
      description: submission.message,
      requester: { email: submission.email, name: submission.name },
      custom_fields: {
        category: category_mapping[submission.category]
      }
    }

    response = post('https://{domain}.zendesk.com/api/v2/tickets', ticket)
    return {
      success: response.status === 201,
      external_ticket_id: response.ticket.id,
      error: response.error
    }
  }
}
```

**Implementation**

```
forwarders = [
  new EmailForwarder(config.smtp, config.support_email),
  new ZendeskForwarder(config.zendesk_api_key, config.zendesk_domain)
]

on_submission_created(submission, attachment):
  for forwarder in forwarders:
    try:
      result = await forwarder.send(submission, attachment)
      log_integration_result(submission.id, forwarder.name, result)
    catch error:
      log_integration_error(submission.id, forwarder.name, error)
      // Do NOT fail submission if integration fails
      // DB storage is the source of truth
```

**Key Design Principle**

- Integrations are **best-effort**, not blocking
- If Zendesk is down, submission still saves to database
- Retry logic happens asynchronously (separate scheduled job)
- Admin can manually trigger resend to external system if needed

---

## Confirmation Flow

### Inline Success Message

```
[Submission successful!]
Thank you, {name}. We've received your message and will get back to
you as soon as possible. You can reference ticket #{submission_id}
in future correspondence.

[← Back to Form] [View Status]
```

**Behavior**

- Display immediately after successful POST response
- Clear form fields
- Scroll to message
- Optional: collapsible "View Status" link that shows submission ID (allows user to reference later)
- Auto-dismiss after 5 seconds (optional) or keep visible

### Confirmation Email Template

**To**: submission.email

**Subject**: "We received your support request — Reference #[ID]"

**HTML Body**

```
Dear {name},

Thank you for contacting us. We have received your support request:

Reference Number: {submission_id}
Category: {category}
Subject: {subject}

We will review your message and get back to you as soon as possible,
typically within 24 business hours.

Your Message:
---
{message}
---

If you need to add more information, reply to this email with your
reference number in the subject line.

Best regards,
Support Team
```

**Implementation Notes**

- Send from verified domain (e.g., support@myapp.com)
- Include plain-text + HTML versions
- Add `List-Unsubscribe` header (optional, for compliance)
- Use transactional email service (SendGrid, Mailgun, AWS SES) for reliability
- Queue asynchronously; don't block form submission response
- Retry failed sends (exponential backoff, max 3 times over 24 hours)
- Log delivery status to database

---

## Admin View

### Submission List Interface

**Layout**

```
[Filter by Category ▼] [Filter by Status ▼] [Search by name/email/ID]

[Submissions Table]
| ID | Name | Email | Category | Status | Created | Actions |
|----|------|-------|----------|--------|---------|---------|
| #123 | John Doe | john@example.com | Bug Report | new | 2 hrs ago | [View] |
| #122 | Jane Smith | jane@example.com | Feature Request | in_progress | 1 day ago | [View] |
| ... |

Page 1 of 5 | [< Prev] [Next >]

Unread: 3 submissions
```

**Column Details**

- ID: submission UUID (shortened for display, full ID in detail view)
- Name: submitter name
- Email: submitter email (clickable to reply)
- Category: app-configured category
- Status: badge with color (new=blue, in_progress=yellow, resolved=green, closed=gray)
- Created: human-readable relative time (e.g., "2 hours ago")
- Actions: [View Details] button

**Filters**

- Category: dropdown, multi-select optional
- Status: dropdown, multi-select optional
- Search: text input, searches name, email, subject, message
- Date range: optional from/to date pickers
- Assigned to: dropdown to filter by assigned admin user

### Submission Detail View

```
[← Back to List]

SUBMISSION #123
Status: in_progress | Change to: [▼] | Assigned to: [Admin Name ▼] | [Assign to Me]

Name: John Doe
Email: john@example.com
Category: Bug Report
Subject: Login fails with special characters
Message:
  When I try to log in with an email containing a plus sign
  (e.g., john+test@example.com), I get an error message...

[Attachment: screenshot.png (2.3 MB)] [Download]

---
ADMIN NOTES
[Edit]
Initial investigation: Likely input validation issue in login form.
Dev team has been assigned.
---

[Mark as Resolved] [Close] [Delete] [Forward to...] [Reply]
```

**Capabilities**

- Change status with dropdown
- Assign to admin user (or reassign)
- Edit admin-only notes
- View full message with preserved formatting
- Download attachment
- Reply to submitter (triggers confirmation email)
- Forward to external system manually (re-trigger integration)
- Delete submission (soft-delete, keeps audit trail)

### Reply Capability

**Reply Modal**

```
[Send Reply to john@example.com]

Message:
[textarea for admin response]

[Preview] [Send] [Cancel]
```

**Behavior**

- Admin writes response
- Email sent to submitter with same header info (reference ID, etc.)
- Reply marked in database with replied_at timestamp
- Submission status changes to 'in_progress' automatically
- Auto-append reply to submission history/thread (show in detail view)

---

## File Attachment Handling

### Upload Flow

1. User selects file in form
2. Client calls POST /api/support/upload-attachment
3. Server validates size (max 10 MB) and MIME type
4. Server stores file in secure location, generates UUID
5. Client receives attachment_id, stores in form state
6. On form submit, attachment_id sent with submission data
7. Server links attachment to submission record

### Storage Strategy

**Option A: Cloud Storage (Recommended)**

```
- Store in S3-compatible service (AWS S3, Cloudflare R2, DigitalOcean Spaces)
- Filename: {submission_id}/{uuid}/{original_filename}
- Set private ACL (authenticated access only)
- Generate signed URLs for admin download (expires after 1 hour)
- Automatic cleanup: delete after 30 days of closed submission
```

**Option B: Encrypted Local Storage**

```
- Store in dedicated directory outside web root
- Encrypt file at rest using AES-256
- Serve via authenticated endpoint that decrypts on-the-fly
- Backup regularly (data loss = lost submissions)
```

### Whitelist & Size Limits

```
allowed_types = {
  'application/pdf': ['.pdf'],
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/gif': ['.gif'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx']
}

max_size_bytes = 10 * 1024 * 1024  // 10 MB
```

### Cleanup

```
scheduled_job (daily, 2 AM):
  stale_attachments = select * from attachments
    where created_at < now() - 24 hours
    AND submission_id IS NULL

  for each stale_attachment:
    delete file from storage
    delete record from database
```

---

## Accessibility Deep Dive

### Form Labels

```
<form>
  <label for="name">Name *</label>
  <input id="name" name="name" required aria-required="true" />

  <label for="email">Email *</label>
  <input id="email" name="email" type="email" required aria-required="true" />

  <label for="message">Message *</label>
  <textarea id="message" name="message" required aria-required="true"></textarea>
</form>
```

### Error Display

```
<div role="alert" id="form-errors">
  <h2>Please fix these errors:</h2>
  <ul>
    <li><a href="#email">Email format is invalid</a></li>
    <li><a href="#message">Message must be at least 10 characters</a></li>
  </ul>
</div>

<input
  id="email"
  aria-invalid="true"
  aria-describedby="email-error"
/>
<span id="email-error" role="alert">
  Invalid email format
</span>
```

### Focus Management

```
on_form_submit_fail():
  invalid_fields = get_invalid_fields()
  first_invalid = invalid_fields[0]

  announce_to_screen_reader(
    "Form has errors. Please review the errors below."
  )

  scroll_to(first_invalid)
  first_invalid.focus()
```

### Keyboard Navigation

```
- Tab: move to next form field
- Shift+Tab: move to previous form field
- Enter (on button): submit or reset
- Escape: optionally reset form (depends on UX decision)
- Arrow keys: navigate dropdown options
```

**Implementation**: Native HTML form elements handle this automatically; only override if using custom components.

### Screen Reader Announcements

```
on_success():
  announce(
    "Your support request has been submitted successfully. "
    "Reference number is " + submission_id,
    politeness="polite"
  )
```

---

## Gotchas & Security Considerations

### XSS in Message Field

**Problem**: Admin views message in admin panel. If message contains unescaped HTML/JavaScript, it could execute.

**Solution**:

```
// During storage
message_sanitized = strip_html_tags(message)
store(message_sanitized)

// During retrieval/display
display_text = escape_html(message_sanitized)
// or use framework's auto-escaping
```

**Never** render user-submitted content as raw HTML. Always escape or sanitize.

### Large File Uploads

**Problem**: 10 MB files can consume server bandwidth and storage.

**Solutions**:

- Enforce size limit at client AND server
- Use chunked upload for files > 5 MB (resume on failure)
- Store in CDN/cloud (S3) with bandwidth cap
- Monitor storage growth; archive old submissions quarterly
- Set disk quota alerts

### Email Deliverability

**Problem**: Confirmation emails might end up in spam or fail to send.

**Solutions**:

- Use dedicated transactional email service (SendGrid, Mailgun)
- Set up SPF, DKIM, DMARC records on domain
- Include Unsubscribe link (optional, for compliance)
- Monitor bounce rate; remove invalid emails
- Test email templates in Litmus or similar tool
- Add fallback: if email fails, display message "Check your spam folder"

### GDPR / Data Privacy

**Problem**: Storing user submissions and attachment files creates data liability.

**Solutions**:

- Add "Privacy Policy" link in form, disclose data usage
- Implement data retention policy (auto-delete after 6/12 months)
- Offer users ability to request data deletion
- Encrypt sensitive data at rest
- Hash IP addresses before storage
- Restrict admin access (log who views which submission)

### Rate Limiting Edge Cases

**Problem**: Legitimate users on same IP (office, university) hit rate limit.

**Solutions**:

- Use IP + user_id combination if authenticated (user ID takes precedence)
- Offer whitelist option for known IPs
- Allow admins to manually clear rate limit for a user
- Implement exponential backoff (5 per hour → 3 per hour if abused)

### Attachment Virus Scanning

**Optional Enhancement**: Scan uploaded files with ClamAV or VirusTotal API before accepting.

```
on_attachment_upload():
  scan_result = virus_scan_api.scan(file)
  if scan_result.infected:
    reject_upload("File contains potential malware")
  else:
    accept_attachment()
```

### Database Indexing

**Create indexes** for query performance:

```
CREATE INDEX idx_submissions_status ON submissions(status);
CREATE INDEX idx_submissions_created_at ON submissions(created_at DESC);
CREATE INDEX idx_submissions_category ON submissions(category);
CREATE INDEX idx_submissions_assigned_to ON submissions(assigned_to);
```

### Audit Trail

**Log all admin actions** for compliance:

```
audit_log {
  id: UUID
  submission_id: UUID
  admin_user_id: UUID
  action: enum ['view', 'update_status', 'add_notes', 'reply', 'delete']
  old_value: string | null
  new_value: string | null
  timestamp: UTC
}
```

---

## Implementation Checklist

- [ ] Design and style form component
- [ ] Implement field validation (client + server)
- [ ] Build honeypot field and rate limiting logic
- [ ] Create submission database schema and migrations
- [ ] Implement POST /api/support/submit endpoint
- [ ] Set up email service and confirmation email template
- [ ] Build admin list view and detail view UI
- [ ] Implement GET /api/admin/support and PATCH endpoints
- [ ] Add file upload endpoint and attachment storage
- [ ] Create integration interfaces (email, Zendesk, Intercom, etc.)
- [ ] Test spam prevention (honeypot, rate limit, sanitization)
- [ ] Test accessibility (keyboard nav, screen reader, color contrast)
- [ ] Set up data retention and cleanup jobs
- [ ] Add admin reply capability
- [ ] Create monitoring/alerting for submission failures
- [ ] Document configuration options per app
- [ ] Security review (XSS, CSRF, injection attacks)
- [ ] Load test file uploads and high-volume submissions
