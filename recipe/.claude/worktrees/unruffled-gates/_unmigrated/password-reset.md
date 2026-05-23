---
name: Password Reset
description: Password reset flow for email+password auth (Phase 2)
type: enhancement
requires: recipes/otp.md
env_vars: (none — uses existing SES email config)
---

# Password Reset

Password reset flow for email+password authentication. User requests reset → email with reset token → validate token → new password form → update. Uses existing email infrastructure. Time-limited tokens (1 hour), rate limited (3 requests per email per hour).

**Note:** This is a Phase 2 feature, only relevant if email+password auth is added. If the app uses OAuth or passwordless OTP only, this recipe is not needed.

---

## Overview

Users can reset a forgotten password via email-based token verification. Flow:

1. User lands on "Forgot Password" page
2. Enters email address
3. Receives email with reset link containing a token
4. Clicks link; token is validated server-side
5. If valid, shows password entry form
6. User submits new password
7. Password is hashed and stored; all existing sessions are revoked

This is separate from the OTP flow (`otp.md`) and applies only to users who log in with email+password, not email OTP.

---

## Data Model

New table: `password_reset_tokens`

```
PasswordResetToken {
  id:           auto-generated primary key
  user_id:      string (FK users.user_id)
  email:        string (denormalized for querying without join)
  token:        string (unique) // random 32-byte hex
  token_hash:   string          // SHA-256(token) — never store plaintext
  expires_at:   datetime        // 1 hour from creation
  used_at:      datetime | null // timestamp when token was consumed
  created_at:   datetime
}
```

**Indexes:**
- Unique index on `token_hash` — fast lookup by token
- Index on `user_id` — find all reset tokens for a user
- TTL/cleanup on `expires_at` — auto-delete expired tokens

---

## API Routes

### POST `/api/auth/forgot-password`

Request password reset email.

**Request:**
```
{
  email: string  // must exist in users table
}
```

**Validation:**
- Email must be valid format
- Rate limit: 3 requests per email per hour
- If email not found, return 200 (do not reveal whether email exists, for security)

**Response:**
```
{
  status: 'reset_email_sent',
  message: 'If this email exists, a reset link has been sent'
}
```

**Email body:**
```
Dear User,

Click the link below to reset your password:
https://app.example.com/reset-password?token=<TOKEN>

This link expires in 1 hour.

If you didn't request a password reset, ignore this email.
```

Store the token in `password_reset_tokens` table with 1-hour expiry.

### GET `/api/auth/reset-password/verify-token`

Validate a reset token (before showing password form).

**Request:**
```
{
  token: string (from URL param)
}
```

**Response:**
```
{
  valid: boolean
  email?: string (masked: "user@exam***")
  expires_in_seconds?: number
}
```

**Validation:**
- Lookup token by token_hash
- Verify not yet used (`used_at` is null)
- Verify not expired (`expires_at > now`)
- Return 200 with `valid: false` if not found or expired (do not leak token status)

### POST `/api/auth/reset-password`

Submit new password.

**Request:**
```
{
  token: string
  new_password: string  // must meet password requirements (8+ chars, etc.)
}
```

**Validation:**
- Same token validation as `verify-token`
- Check password strength (8+ chars, entropy > 40 bits, no common patterns)
- Do NOT allow reuse of last 3 passwords (if keeping history)

**Response:**
```
{
  status: 'password_reset',
  message: 'Password updated. Redirecting to login...'
}
```

**Side effects:**
- Hash new password with bcrypt (12+ rounds) or Argon2
- Update `users.password_hash`
- Mark token as used: `token.used_at = now`
- Revoke all existing sessions for this user (logout all devices)
- Log password reset event (for audit trail)

**Errors:**
- 400: Token expired or invalid
- 400: Password too weak

### DELETE `/api/auth/reset-password/cancel`

User can cancel pending reset tokens (optional, for security).

**Request:**
```
{
  token: string
}
```

**Response:**
```
{
  status: 'token_revoked'
}
```

**Side effects:**
- Mark token as used (`token.used_at = now`) to prevent future use

---

## UI Spec

### Forgot Password Page

```
[Heading: "Forgot Password?"]

[Email input: "Enter your email address"]
[Submit button: "Send Reset Link"]

[Info text: "We'll send you a link to reset your password.
If you don't see it, check your spam folder."]
```

After submit:

```
[Success message: "Check your email for a reset link.
The link expires in 1 hour."]
```

### Reset Password Page

After clicking email link, user lands on `/reset-password?token=...`:

```
[Heading: "Set New Password"]

[Password input: "New password" (type=password)]
[Password strength indicator] (visual bar showing entropy)
[Password input: "Confirm password" (type=password)]

[Requirements checklist]:
  ✓ At least 8 characters
  ○ Mix of uppercase and lowercase
  ○ At least one number
  ○ At least one special character

[Submit button: "Update Password"]
```

Validation feedback:
- On blur: Show which requirements are met/unmet
- On submit: Show all errors before allowing submit

Error states:
- Expired token: "This link has expired. Request a new one."
- Invalid token: "Invalid reset link. Request a new one."
- Password mismatch: "Passwords don't match."
- Weak password: "Password doesn't meet requirements."

After successful reset:

```
[Success page with auto-redirect countdown]
"Password updated successfully.
Redirecting to login in 5 seconds..."

[Login button: "Go to Login Now"]
```

---

## Security Notes

### 1. Token Leakage via Referrer

Do NOT include the reset token in a query parameter unless absolutely necessary. Better pattern:

```
// BETTER: token in URL param (user clicks link in email client)
GET /reset-password?token=...
// Token leaks to referrer headers and browser history, but:
// - Used only once (consumed on POST)
// - 1-hour expiry limits window
// - Attacker must intercept email or access history to use it

// ALTERNATIVE: token in POST body instead of URL
POST /reset-password with { token: ... }
// Requires extra form submission; less convenient but safer
```

Current design uses token in URL (standard pattern). The 1-hour expiry and single-use enforcement mitigate referrer leakage.

### 2. Email Enumeration Attack

Attacker can discover which emails have accounts by requesting resets for a list of emails and seeing which ones trigger rate limiting sooner (or by timing response delays).

**Mitigation:** Always return 200 with generic success message, regardless of whether email exists:

```pseudocode
POST /api/auth/forgot-password:
  if (db.users.findOne({ email })):
    createResetToken()
    sendEmail()
  // else: do nothing (silently)

  return 200 { status: 'reset_email_sent', message: '...' }
```

Response time may still leak info (DB lookup for real email vs non-existent email). Accept this trade-off; email enumeration is low-risk.

### 3. Session Revocation

When password is reset, immediately revoke all active sessions for that user. This logs the user out everywhere, forcing re-login with new password. Important if the old password was compromised.

```pseudocode
function resetPassword(userId, newPasswordHash):
  db.users.update({ user_id: userId }, {
    password_hash: newPasswordHash,
    updated_at: now
  })
  db.sessions.deleteMany({ user_id: userId, status: 'active' })
  logAuditEvent('password_reset', userId)
```

### 4. Password History (Optional)

Prevent users from reusing recent passwords:

```
PasswordHistory {
  user_id:      string (FK users.user_id)
  password_hash: string  // hash of old password
  set_at:       datetime
}
```

On password reset, check if `newPassword` hashes to any of the last 3 entries in PasswordHistory. If so, reject the reset.

---

## Implementation Details

### Rate Limiting

Store rate limit state in `password_reset_tokens` table or a separate `rate_limit` table:

```pseudocode
POST /api/auth/forgot-password:
  email = request.body.email

  // Check rate limit: 3 resets per email per hour
  recentTokens = db.password_reset_tokens.find({
    email: email,
    created_at: { $gte: now - 1 hour }
  })

  if (recentTokens.length >= 3):
    return 429 { message: 'Too many reset requests. Try again later.' }

  // Rate limit passed; proceed
  if (db.users.findOne({ email })):
    createAndSendToken()

  return 200 { message: '...' }
```

### Email Template

Use the same email template system as `otp.md` (via SES). Example template name: `password_reset_token.html`

Include:
- User's display name or email
- Reset link with token
- Expiry time and date
- Security note: "If you didn't request this, you can ignore it"
- Support link if reset link doesn't work

### Password Hashing

Use industry-standard algorithms:
- **bcrypt:** 12+ rounds (cost factor)
- **Argon2:** memory=65536, time=3, parallelism=4 (or sensible defaults for your stack)

Bcrypt example:
```pseudocode
salt = bcrypt.genSalt(12)
hashedPassword = bcrypt.hash(newPassword, salt)
db.users.update({ user_id }, { password_hash: hashedPassword })
```

---

## Gotchas

### 1. Token Reuse Prevention

Once a token is used to set a new password, it must not be reusable, even if submitted again within the 1-hour window:

```pseudocode
// WRONG: only checks expiry
if (token.expires_at > now):
  acceptPasswordReset()

// RIGHT: checks both expiry and used status
if (token.expires_at > now and token.used_at is null):
  acceptPasswordReset()
```

### 2. Browser Password Manager Confusion

If user has a saved password in their browser password manager, they may accidentally submit the old password instead of the new one. Browsers often auto-fill password fields.

Mitigation:
- Use `autocomplete="new-password"` on the new password input (signals to browsers: don't auto-fill this)
- Show clear labels: "New password" (not just "password")

```html
<input type="password" autocomplete="new-password" />
```

### 3. Multiple Tokens Per User

A user might request multiple resets before using the first token. Each request creates a new token. All tokens should remain valid (use same hash), and using ANY token should consume all tokens for that user:

```pseudocode
POST /api/auth/reset-password:
  token = findTokenByHash(request.token)
  if (!token or token.used_at or token.expires_at < now):
    return 400

  // Hash new password
  newHash = hashPassword(request.new_password)

  // Update user password
  db.users.update({ user_id: token.user_id }, {
    password_hash: newHash
  })

  // Invalidate ALL reset tokens for this user (not just this one)
  db.password_reset_tokens.updateMany(
    { user_id: token.user_id },
    { used_at: now }
  )

  // Revoke all sessions
  db.sessions.deleteMany({ user_id: token.user_id, status: 'active' })
```

### 4. Expired Email Link UX

If user clicks reset link after 1 hour (expired), they see "Invalid link" but might not know why. Provide a clear path to request a new link:

```
This reset link has expired. [Request new link] button
```

The button should navigate to `/forgot-password`, not auto-submit (requires explicit action to avoid confusion).

### 5. Timing Attacks

Comparing tokens naively (string equality) can leak token length via timing. Use constant-time comparison:

```pseudocode
function tokenMatches(submittedToken, storedTokenHash):
  return constantTimeCompare(
    sha256(submittedToken),
    storedTokenHash
  )
```

Most modern languages have built-in functions for this (e.g., `crypto.timingSafeEqual` in Node.js).

