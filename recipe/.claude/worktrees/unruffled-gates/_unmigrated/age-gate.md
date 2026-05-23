---
name: Age Gate
description: Configurable age verification gate shown before accessing the app
type: enhancement
requires: (none)
env_vars: AGE_GATE_MINIMUM_AGE, AGE_GATE_ENABLED
---

# Age Gate

Configurable age verification gate to ensure users meet minimum age requirements. Shown before accessing the main app. Verification method is configurable: date picker input, checkbox acknowledgment, or disabled. Widely used for compliance with COPPA (13+), alcohol/gambling (21+), GDPR special category data (16+ in EU).

---

## Overview

Age gate is a compliance feature that restricts app access to users above a minimum age. Flow:

1. Unauthenticated user lands on the app
2. If no age verification cookie exists, show age gate modal
3. User chooses verification method (date picker or checkbox)
4. If verified, set cookie and store verification in DB (if authenticated)
5. User is never shown age gate again (until cookie expires)
6. Authenticated users are never shown age gate after first verification

All routes are blocked except legal pages: `/privacy-policy`, `/terms-of-service`, `/legal`, etc.

---

## Data Model

Extend `users` table with age verification fields:

```
User {
  // ... existing fields ...

  age_verified: boolean,
  age_verified_at: datetime | null,
  age_verification_method: enum('birthday_input', 'checkbox', 'none') | null,
  verified_birth_year: integer | null,  // year only, no PII
  verification_ip_hash: string | null   // SHA256(IP) for fraud detection
}
```

New table: `age_verification_log` (immutable audit log)

```
AgeVerificationLog {
  id:                     auto-generated primary key
  user_id:                string (FK users.user_id) | null  // null if unauth
  fingerprint:            string  // anonymous session ID
  ip_hash:                string  // SHA256(IP)
  verification_method:    enum('birthday_input', 'checkbox')
  age_calculated:         integer | null  // calculated at time of verification
  meets_requirement:      boolean
  minimum_age_required:   integer
  verified_at:            datetime
  user_agent:             string  // browser type
}
```

**Cookie Format:** `ageVerification`

```javascript
{
  verified: boolean,
  verified_at: timestamp,
  expires_at: timestamp,  // configurable, default 365 days
  minimum_age_met: boolean,
  verification_method: string,
  fingerprint: string  // session ID
}
```

**Indexes:**
- Index on `user_id` — find all verifications for a user
- Index on `fingerprint` — find anon session
- Index on `verified_at` — find verifications in date range
- Sparse index on `ip_hash` — fraud detection queries

---

## Configuration

Age gate behavior is controlled by environment variables:

```
AGE_GATE_ENABLED = true | false          // default: true
AGE_GATE_MINIMUM_AGE = integer            // default: 13
AGE_GATE_VERIFICATION_METHOD = 'birthday_input' | 'checkbox' | 'none'
  // default: 'birthday_input'
AGE_GATE_COOKIE_EXPIRY_DAYS = integer     // default: 365
AGE_GATE_ENFORCE_FOR_AUTHENTICATED = boolean  // default: false
```

Example configs:

```
# COPPA compliance (13+)
AGE_GATE_ENABLED=true
AGE_GATE_MINIMUM_AGE=13
AGE_GATE_VERIFICATION_METHOD=birthday_input

# Alcohol app (21+)
AGE_GATE_ENABLED=true
AGE_GATE_MINIMUM_AGE=21
AGE_GATE_VERIFICATION_METHOD=birthday_input

# Disabled (no age gate)
AGE_GATE_ENABLED=false
```

---

## API Routes

### POST `/api/age-verification/verify`

Submit age verification.

**Request:**
```
{
  verification_method: 'birthday_input' | 'checkbox',

  // If birthday_input:
  birth_date?: string,  // ISO 8601 date: YYYY-MM-DD

  // If checkbox:
  age_confirmed?: boolean  // must be true
}
```

**Validation:**
- If `verification_method == 'birthday_input'`:
  - `birth_date` must be valid date
  - Age calculated from birth_date must meet minimum
  - Cannot be future date (no time travelers)
- If `verification_method == 'checkbox'`:
  - `age_confirmed` must be true
- Do not allow bypassing by submitting empty request

**Response:**
```
{
  status: 'age_verified' | 'age_not_met',
  age_calculated?: integer,
  message?: string
}
```

If `age_not_met`:
```
{
  status: 'age_not_met',
  minimum_age_required: 13,
  message: 'You must be 13 or older to access this app.'
}
```

**Side effects:**
- If verified:
  - Set `ageVerification` cookie
  - Log to `age_verification_log` with `meets_requirement: true`
  - If authenticated, update user record: `age_verified=true, age_verified_at=now`
- If not verified:
  - Do not set cookie
  - Log to `age_verification_log` with `meets_requirement: false`
  - Return 403

### GET `/api/age-verification/status`

Check current age verification status (for client-side validation).

**Response:**
```
{
  verified: boolean,
  verified_at: datetime | null,
  expires_at: datetime | null,
  minimum_age_met: boolean,
  minimum_age_required: integer
}
```

Returns from cookie if unauth, or from DB if authenticated.

### POST `/api/age-verification/reset`

Clear age verification (admin only, for testing or compliance).

**Request:**
```
{
  user_id: string
}
```

**Validation:**
- Requester must be admin

**Response:**
```
{
  status: 'verification_cleared'
}
```

**Side effects:**
- Update user record: `age_verified=false, age_verified_at=null`
- Log reset event

---

## Middleware & Route Protection

### Route Protection Middleware

Middleware runs on all routes except legal pages:

```pseudocode
function ageGateMiddleware(request, response, next):
  if (!AGE_GATE_ENABLED):
    return next()  // feature disabled

  // Exception: legal pages always accessible
  publicRoutes = [
    '/privacy-policy',
    '/terms-of-service',
    '/legal',
    '/contact',
    '/help',
    '/api/health',  // health checks always ok
    '/age-gate',    // age gate modal itself
    '/api/age-verification/*'  // age verification endpoints
  ]

  if (isPublicRoute(request.path, publicRoutes)):
    return next()

  // Check if age verified
  session = getSessionOrFingerprint(request)
  verified = checkAgeVerified(session)

  if (!verified):
    // Block access
    if (request.path.startsWith('/api/')):
      return 403 {
        error: 'age_verification_required',
        redirect_to: '/age-gate'
      }
    else:
      // Redirect to age gate page
      return 302 { location: '/age-gate' }

  next()

function checkAgeVerified(session):
  // Check cookie first
  cookie = getCookie('ageVerification')
  if (cookie and cookie.expires_at > now and cookie.verified):
    return true

  // If authenticated, check DB
  if (session.user_id):
    user = db.users.findOne({ user_id: session.user_id })
    if (user.age_verified and AGE_GATE_ENFORCE_FOR_AUTHENTICATED):
      return true
    if (user.age_verified and !AGE_GATE_ENFORCE_FOR_AUTHENTICATED):
      return true  // skip re-verification

  return false
```

---

## UI Spec

### Age Gate Modal (Birthday Input Method)

```
[Modal: "Age Verification"]
[Modal takes full screen, no close button except if 18+]

We need to verify your age to continue.

You must be at least [AGE_GATE_MINIMUM_AGE] years old to access [app_name].

[Heading: "When is your birth date?"]

[Date picker input]
  Placeholder: "Select your date of birth"
  Format: MM/DD/YYYY
  Max date: [today - minimum age]
  Validation: "You must be 13 or older"

[Buttons]:
  [Continue] (disabled until valid date entered)
  [Cancel] (if optional, not shown if mandatory)

[Info]: "We won't store your date of birth. Only your age is verified."
```

### Age Gate Modal (Checkbox Method)

```
[Modal: "Age Confirmation"]

[Heading: "Confirm Your Age"]

By using [app_name], you confirm that you are at least
[AGE_GATE_MINIMUM_AGE] years old.

[Checkbox] I confirm I am [AGE_GATE_MINIMUM_AGE] or older

[Buttons]:
  [Continue] (disabled until checkbox checked)
  [Cancel]
```

### Age Gate Page (Full Page Version)

If using `/age-gate` route:

```
[Full page layout]

[Centered card, max-width 500px]

[Logo/App name]

[Heading: "Age Verification"]

Subheading: "Protecting our community"

We require users to be [AGE_GATE_MINIMUM_AGE]+ to access [app_name].

[Either date picker or checkbox, as above]

[Legal info]:
  Your privacy is important.
  Learn more: [privacy policy link]
```

### Age Not Met Page

If user fails verification:

```
[Page: "/age-not-eligible"]

[Icon: blocked / no entry]

[Heading: "Sorry, you're not eligible"]

You must be at least [AGE_GATE_MINIMUM_AGE] years old to use [app_name].

[Buttons]:
  [Go back] (to home)
  [Contact support] (if appeal mechanism)

[Info]: "If you believe this is an error, contact support@example.com"
```

---

## Client-Side Logic

### Check Age Verification Status

On app load, check if age verification is required:

```pseudocode
async function initializeAgeGate():
  const status = await fetch('/api/age-verification/status').then(r => r.json())

  if (!status.verified):
    // Show age gate modal
    showAgeGateModal()
    // Block app content behind modal (CSS pointer-events: none)
    disableAppContent()
  else:
    // User verified, allow app
    enableAppContent()
```

### Handle Verification Submission

```pseudocode
async function submitAgeVerification(method, data):
  const response = await fetch('/api/age-verification/verify', {
    method: 'POST',
    body: JSON.stringify({
      verification_method: method,
      ...data
    })
  })

  if (response.status === 403):
    // Age not met
    showError('You must be [age] or older')
    return false

  if (response.ok):
    // Age verified
    const data = await response.json()
    // Cookie is already set by server
    hideAgeGateModal()
    enableAppContent()
    return true

  // Other error
  showError('Verification failed. Try again.')
  return false
```

### Persist Verification Client-Side

```javascript
// On successful verification, update localStorage for faster checks
localStorage.setItem('ageVerification', JSON.stringify({
  verified: true,
  verified_at: new Date().toISOString(),
  minimum_age_met: true
}));
```

---

## Compliance Notes

### 1. COPPA (Children's Online Privacy Protection Act)

For apps targeting children under 13:
- Minimum age: 13 (or lower with parental consent)
- Verification method: strict birthday input
- Data minimization: don't store birth date itself
- Parental notice: clearly explain data collection

```
AGE_GATE_MINIMUM_AGE = 13
AGE_GATE_VERIFICATION_METHOD = 'birthday_input'
```

### 2. Alcohol / Tobacco / Gambling (21+)

For age-restricted content in US:
- Minimum age: 21
- Verification method: strict birthday input
- Consider third-party age verification services (AgeCheck API, etc.)
- Do not rely on checkbox alone; use birthday picker

```
AGE_GATE_MINIMUM_AGE = 21
AGE_GATE_VERIFICATION_METHOD = 'birthday_input'
```

### 3. GDPR Special Category Data (16+)

In EU, special rules apply to minors and personal data:
- Parental consent required for users under 16 (varies by country)
- Minimum age: 16 (or 13 with parental consent)
- Verify age at signup and re-verify periodically

```
AGE_GATE_MINIMUM_AGE = 16  // EU
AGE_GATE_MINIMUM_AGE = 13  // US (with parental consent flow)
```

### 4. Don't Store Full Birth Date

Only store the verification year, not full date:

```
// WRONG: stores full PII
{
  verified_birth_date: '1995-03-15'
}

// CORRECT: stores only year, year is derived from verification
{
  verified_birth_year: 1995,  // calculated once at verification
  age_verified: true
}
```

### 5. Audit Trail for Compliance

Maintain immutable log of all age verifications:

```
AgeVerificationLog {
  id: 123,
  user_id: 'user_456' | null,
  verification_method: 'birthday_input',
  age_calculated: 28,
  meets_requirement: true,
  minimum_age_required: 13,
  verified_at: datetime,
  ip_hash: SHA256(ip),  // for fraud detection
  user_agent: 'Chrome/...'  // browser type only
}
```

### 6. Clear Language

Use simple, clear language about age requirements:

"This app is for people aged 13 and older."

Not: "If you're under 13, you cannot access premium features of the service." (confusing)

---

## Gotchas

### 1. Browser Date Picker May Not Support Old Dates

HTML5 `<input type="date">` may struggle with dates from 50+ years ago (old users). Provide fallback:

```javascript
// Use native date picker for recent dates, custom picker for very old dates
const birthYear = new Date().getFullYear();
const minimumYear = birthYear - 100;

if (currentYear - minimumYear > 120) {
  // Show custom picker with year dropdown
  <YearPickerSelect min={minimumYear} max={currentYear} />
} else {
  // Native date picker is fine
  <input type="date" max={maxDate} />
}
```

### 2. Age Calculation Precision

Age verification happens at a specific moment. If a user's birthday is tomorrow, they fail today but pass tomorrow. Consider:
- Rounding down (safe: if unsure, exclude)
- Checking again at app load (cache hit within 24 hours)

```pseudocode
function calculateAge(birthDate):
  today = date.today()
  age = today.year - birthDate.year

  if (birthDate month > today.month):
    age -= 1
  else if (birthDate.month == today.month and birthDate.day > today.day):
    age -= 1

  return age
```

### 3. Cookie Expiry Across Time Zones

If app spans time zones, a cookie expiry "1 year from now" varies by user's time zone. Use server time for expiry, not client time:

```pseudocode
// RIGHT: server calculates expiry
POST /api/age-verification/verify:
  expires_at = now + 365 days  // server time
  cookie.expires_at = expires_at

// WRONG: client calculates expiry
const expiresAt = new Date();
expiresAt.setFullYear(expiresAt.getFullYear() + 1);
```

### 4. Private Browsing / Incognito Mode

Cookies may not persist in private browsing. Age gate will re-appear every session. Inform users or provide fallback:

```javascript
// Detect private browsing
async function isPrivateBrowsing() {
  try {
    const fs = window.requestFileSystem || window.webkitRequestFileSystem;
    return new Promise((resolve) => {
      fs(window.TEMPORARY, 100, () => resolve(false), () => resolve(true));
    });
  } catch {
    return false;  // assume not private
  }
}

// In age gate modal:
if (await isPrivateBrowsing()) {
  showWarning('Age verification in private browsing resets each session');
}
```

### 5. False Positives from Admins Testing

During testing, admins might try old birth dates. Don't fail silently; log it and alert:

```pseudocode
POST /api/age-verification/verify:
  age = calculateAge(birthDate)

  if (age > 120):
    log('suspicious_age_input', { age, user_id, ip_hash })
    // Still reject, but note it

  if (age < minimum_age):
    return 403 { error: 'age_not_met' }
```

### 6. Race Condition: Verification + Sign Up

If user verifies age, then signs up, age_verified flag should carry over:

```pseudocode
POST /api/auth/signup:
  email = request.body.email

  // Check if age already verified
  ageVerifyCookie = getCookie('ageVerification')
  if (ageVerifyCookie and ageVerifyCookie.verified):
    // Pre-fill age_verified in new user record
    user = createUser({
      email: email,
      age_verified: true,
      age_verified_at: ageVerifyCookie.verified_at
    })
  else:
    user = createUser({ email: email, age_verified: false })

  return { user, session }
```

### 7. Jurisdiction-Based Age Requirements

Different countries have different age limits. Detect jurisdiction and adjust:

```pseudocode
function getMinimumAge(userCountry):
  match userCountry:
    case 'DE', 'AT', 'CH': 16  // GDPR
    case 'US': 13  // COPPA
    case 'GB': 16  // UK GDPR
    default: 13
```

However, this is complex and often requires manual geo-blocking. Start with a single global requirement and add jurisdiction logic later if needed.

### 8. Expired Verification Cookie + Stale DB State

If cookie expires but user's DB record still says `age_verified=true`, the user won't see the gate. To be safe, always check cookie first:

```pseudocode
function isAgeVerified(session):
  // Cookie is source of truth
  cookie = getCookie('ageVerification')
  if (cookie and cookie.expires_at > now):
    return true

  // Only if no cookie, check DB
  if (session.user_id):
    user = db.users.findOne({ user_id: session.user_id })
    if (user.age_verified):
      // Restore cookie
      setCookie('ageVerification', { verified: true, ... })
      return true

  return false
```

### 9. Age Gate Modal Not Dismissible

Make sure the modal cannot be bypassed by:
- Clicking outside (disable backdrop close)
- Pressing Escape key (disable Escape handler)
- Inspecting dev tools to remove it (enforce server-side)

```javascript
// WRONG: modal can be closed with X button
<Modal
  title="Age Verification"
  onClose={() => closeModal()}  // ← attacker can close this
  closeButton
>

// RIGHT: modal cannot be closed, only by submitting
<Modal
  title="Age Verification"
  closeButton={false}  // no X
  enableBackdropClose={false}  // can't click outside
  onEscapeKeyDown={(e) => e.preventDefault()}  // no Escape key
>
```

### 10. Bonus: Third-Party Age Verification Services

For high-compliance apps (alcohol, gambling), consider third-party services:
- Socure AgeID
- Vouched
- IDology
- Intellicheck

These use real government IDs and are much more reliable than self-reported birthdays. Integrate via API:

```pseudocode
POST /api/age-verification/verify-id:
  // Integrate with third-party service
  result = thirdPartyAgeVerification({
    upload_id_image: request.file,
    user_name: request.body.name
  })

  if (result.age_verified):
    recordVerification(user_id, method='third_party_id')
  else:
    return 403
```

