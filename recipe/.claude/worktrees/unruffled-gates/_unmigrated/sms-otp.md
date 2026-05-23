---
name: SMS OTP
description: SMS-based OTP delivery as alternative channel to email
type: enhancement
requires: recipes/otp.md
env_vars: SMS_PROVIDER, SMS_API_KEY, SMS_API_SECRET, SMS_FROM_NUMBER
---

# SMS OTP

Adds SMS as an alternative OTP delivery channel. User selects email or SMS at login time. Same OTP flow as `otp.md` but SMS delivery instead of (or in addition to) email. Conditional on `SMS_PROVIDER` environment variable.

---

## Overview

Extend the existing passwordless OTP flow to support SMS delivery. Users can:
- Choose SMS or email when requesting OTP
- Receive 6-digit code via SMS
- Use magic link (for email) or code entry (for SMS)

The OTP verification logic is identical to `otp.md`; only the delivery mechanism changes.

---

## Data Model

Extend the `Session` table from `otp.md` with one additional field:

```
Session {
  // ... all fields from otp.md ...

  delivery_method: enum('email', 'sms')  // how OTP was sent
  phone_number:    string | null          // E.164 format: +1-XXX-XXX-XXXX
}
```

Extend the `User` table from `otp.md`:

```
User {
  // ... all fields from otp.md ...

  phone_number:      string | null  // E.164 format, verified via SMS
  phone_verified_at: datetime | null
}
```

---

## API Routes

### POST `/api/auth/request-otp`

Existing route, enhanced to accept delivery method.

**Request:**
```
{
  email: string
  delivery_method: enum('email', 'sms')   // NEW: defaults to 'email'
  phone_number?: string                    // REQUIRED if delivery_method == 'sms'
}
```

**Validation:**
- If `delivery_method == 'sms'`, require valid E.164 phone number
- If `SMS_PROVIDER` not set in .env, reject `delivery_method == 'sms'` with 400
- Rate limit: 3 OTP requests per phone per hour (SMS is expensive)

**Response:**
```
{
  status: 'otp_sent',
  delivery_method: enum('email', 'sms'),
  masked_target: string  // "+1****5678" for SMS, "user@exam***" for email
}
```

### POST `/api/auth/verify-otp`

Existing route; no changes. Code submission works regardless of delivery method.

---

## Security & SMS Gotchas

### Rate Limiting

SMS delivery is expensive (typically $0.01–0.05 per message). Enforce stricter rate limits than email:

- Max 3 OTP requests per phone number per hour
- Max 5 SMS OTP attempts per session (code entry failures)
- Exponential backoff on repeated failures (1 min, 2 min, 5 min waits)
- Block phone numbers that exceed limits for 24 hours

Track in a `sms_rate_limit` table or in the Session record itself.

### Phone Number Validation

- Accept only E.164 format: `+[country_code][number]` (e.g., `+14155552671`)
- Validate format server-side before sending SMS
- Do not accept SMS for phone numbers on carrier blocklists (if available from provider)

### Message Content

Keep SMS text short (160 characters = 1 SMS unit; multi-part SMSes are expensive):

```
Your authentication code is: 123456
Do not share this code.
```

Do NOT include a magic link in SMS (users must use code entry form).

### Undeliverable Numbers

If SMS provider returns a "delivery failed" status:
- Mark the session as failed
- Suggest user retry with email
- Log the failure (may indicate invalid number or carrier issue)

---

## UI Spec

### Login Page Enhancement

At OTP request form, add delivery method selector:

```
[Email address input]

Delivery method:
○ Email (default)
○ SMS (requires phone number)

[If SMS selected:]
[Phone number input - accept E.164 or user-friendly format]

[Request OTP button]
```

### SMS Delivery Confirmation

After submitting:

```
Code sent to +1****5678 via SMS
Code expires in 10 minutes

[Code entry form: 6 digits]
[Resend Code] (after 30 second cooldown)
[Try Email Instead]
```

---

## Implementation Details

### Conditional Loading

In backend initialization:

```pseudocode
if (env.SMS_PROVIDER):
  initializeSmsProvider(env.SMS_API_KEY, env.SMS_API_SECRET)
  enableSmsFunctionality()
else:
  log("SMS_PROVIDER not configured; SMS delivery disabled")
```

### SMS Provider Interface (Abstraction)

Define a minimal SMS provider abstraction to support multiple providers (Twilio, AWS SNS, etc.):

```pseudocode
interface SmsProvider:
  sendOtp(phoneNumber: string, otpCode: string) → Promise<{
    messageId: string
    deliveryStatus: enum('sent', 'failed')
    errorMessage?: string
  }>
```

Implement provider-specific logic in separate modules:

```
sms/
  provider.ts (abstract interface)
  twilio.ts
  sns.ts
```

### OTP Code Generation

Same 6-digit code as email OTP; no changes needed.

### Resend Logic

```pseudocode
POST /api/auth/resend-otp:
  session = findSessionByEmail(email)
  if (!session or session.status != 'pending'):
    return 400

  // Check resend cooldown (30 seconds)
  if (now - session.last_otp_sent_at < 30 seconds):
    return 429 { message: 'Wait 30 seconds before resending' }

  // Regenerate OTP code (do not reuse same code)
  newOtp = generateOtp()
  session.otp_hash = sha256(newOtp)
  session.last_otp_sent_at = now

  // Send via delivery_method
  if (session.delivery_method == 'sms'):
    sendSmsOtp(session.phone_number, newOtp)
  else:
    sendEmailOtp(session.email, newOtp)

  return { status: 'otp_sent' }
```

---

## Gotchas

### 1. SMS Delivery Delays

SMS is not instant. Delays of 30 seconds to several minutes are normal, especially for some carriers. Document this to users in the UI ("Code may take 1-2 minutes to arrive").

### 2. Multiple Phone Numbers Per Email

A user may request OTP via SMS to multiple phone numbers in quick succession (by accident or to test). The session should allow only ONE pending OTP per email at a time, regardless of phone number:

```pseudocode
// WRONG: allows multiple concurrent SMS OTPs for same email
POST /api/auth/request-otp:
  session = findSessionByEmail(email)
  if (!session):
    createNewSession()
  // sends SMS without checking existing pending OTP

// RIGHT: only one pending OTP per email
POST /api/auth/request-otp:
  session = findSessionByEmail(email)
  if (session and session.status == 'pending'):
    if (now - session.created_at < 60 minutes):  // not expired
      return 409 { message: 'OTP already sent; check your SMS' }
  // create or update single session
```

### 3. Cost Control

Each SMS costs ~$0.01. A malicious actor could generate thousands of OTP requests to drain your budget. Mitigate with aggressive rate limiting (see "Rate Limiting" section above) and monitoring.

### 4. Carrier Issues

Some carriers (e.g., in certain countries) may block or delay SMS from your provider. Test with real phone numbers in target regions before launch.

### 5. Timezone Confusion

When displaying "Code expires in 10 minutes", ensure the expiry countdown is client-side (or synced to server timestamp) so it accounts for network latency. Do NOT hardcode "11:05 PM expires" based on client's system clock — use a Unix timestamp instead.

### 6. Mixed Delivery in Same Session

If a user requests OTP via SMS, then later requests via email on the same email address, the second request should create a NEW session (or update the existing one). Do NOT mix email and SMS in the same session. The `delivery_method` field on Session ensures this is clear.

