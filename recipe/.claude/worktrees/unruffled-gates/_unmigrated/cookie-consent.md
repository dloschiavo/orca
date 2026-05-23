---
name: Cookie Consent Banner
description: GDPR/ePrivacy cookie consent with granular opt-in
type: enhancement
requires: recipes/analytics.md, recipes/app-config-theming.md
env_vars: (none — uses existing config)
---

# Cookie Consent Banner

GDPR/ePrivacy-compliant cookie consent banner with granular category opt-in (necessary, analytics, marketing). Consent stored in cookie and DB for audit. Analytics provider initialized only after consent. Simple implementation without external CMP vendor.

---

## Overview

Display a cookie consent banner on first visit. User can:
- Accept all cookies
- Reject all (except necessary)
- Customize consent per category

Consent choices are:
1. **Necessary** (always on) — session, security, fraud prevention
2. **Analytics** (opt-in) — usage tracking, performance metrics
3. **Marketing** (opt-in) — third-party ads, retargeting

Consent is stored in:
- `consentToConjugate` cookie (immediate, client-side state)
- `consent_log` table entry (database, for GDPR audit trail)

Analytics script only loads if user consents.

---

## Data Model

New table: `consent_logs` (audit trail)

```
ConsentLog {
  id:              auto-generated primary key
  fingerprint:     string  // anonymous session identifier
  ip_hash:         string  // SHA-256(IP) — no PII
  consent_state:   object  // JSON: { necessary: true, analytics: bool, marketing: bool }
  choices_mode:    enum('all', 'none', 'custom')
  user_agent:      string  // browser type/version only
  accepted_at:     datetime
  rejected_at?:    datetime  // if user rejected
  updated_at:      datetime
}
```

Do NOT store personally identifiable information (email, user_id) in this table. It's for anonymous audit trail compliance.

---

## Cookie Format

`consentStatus` cookie (stores consent choices):

```javascript
{
  version: 1,              // allow schema evolution
  necessary: true,         // always true
  analytics: boolean,      // user choice
  marketing: boolean,      // user choice
  accepted_at: timestamp,
  expires_at: timestamp    // 1 year from acceptance
}
```

Cookie settings:
- `Max-Age`: 31536000 (1 year)
- `Secure`: true (HTTPS only)
- `HttpOnly`: false (JavaScript needs to read it for analytics consent check)
- `SameSite`: Lax (allows cross-site navigation, prevents CSRF)

**Name:** `consentStatus` (simple, not app-specific since this is typically site-wide)

---

## API Routes

### POST `/api/consent/submit`

Save user consent choices.

**Request:**
```
{
  necessary: boolean,    // always true, but included for completeness
  analytics: boolean,
  marketing: boolean
}
```

**Response:**
```
{
  status: 'consent_saved',
  expires_at: datetime   // when cookie expires
}
```

**Side effects:**
- Set `consentStatus` cookie on response
- Log choice to `consent_logs` table with `accepted_at = now`
- Initialize analytics provider if analytics=true
- Track event: "user_accepted_consent"

### POST `/api/consent/reject`

User clicks "Reject all" button.

**Request:** (empty)

**Response:**
```
{
  status: 'consent_rejected'
}
```

**Side effects:**
- Set `consentStatus` cookie with `{ necessary: true, analytics: false, marketing: false }`
- Log choice to `consent_logs` table with mode='none'
- Do NOT load analytics or marketing scripts

### GET `/api/consent/preferences`

Get current consent state (if cookie is not readable by client for any reason).

**Response:**
```
{
  necessary: boolean,
  analytics: boolean,
  marketing: boolean,
  accepted_at: datetime | null
}
```

Return from cookie value, or { necessary: true, analytics: false, marketing: false } if no cookie.

### POST `/api/consent/update`

User changes consent preferences after initial banner.

**Request:**
```
{
  analytics: boolean,
  marketing: boolean
}
```

**Response:**
```
{
  status: 'preferences_updated'
}
```

**Side effects:**
- Update `consentStatus` cookie
- Log new choice to `consent_logs` with `updated_at = now`
- If analytics changed from false→true, load analytics script
- If analytics changed from true→false, stop sending analytics events (but don't delete historical data)

---

## UI Spec

### Initial Consent Banner

Display on first visit (if no `consentStatus` cookie):

```
[Banner at bottom of page, semi-transparent dark overlay]

We use cookies for essential functionality, analytics, and marketing.

[Buttons]:
  [Accept All] [Reject All] [Customize]
```

Styling:
- Bottom of viewport, fixed position
- 95% width, max-width 600px, centered
- Z-index: high (above all content)
- Dismiss animation: slide down when dismissed

### Customization Modal

When user clicks "Customize":

```
[Modal: "Cookie Preferences"]

We use different cookies for different purposes.

[Section: Necessary Cookies]
  ☑️ (disabled) Session management, security
  These cookies are always active as they're essential for the site to work.

[Section: Analytics Cookies]
  ☐ Track usage patterns, performance metrics
  Your privacy is protected; data is anonymized.
  [Learn more link]

[Section: Marketing Cookies]
  ☐ Display personalized ads
  Allows us to show relevant content on other sites.
  [Learn more link]

[Buttons]:
  [Save Preferences] [Reject All]
```

### Banner After Consent

After user accepts, banner is dismissed. Optional: show small "Manage Preferences" link in footer or account settings.

```
[Footer link]: "Cookie Preferences" → navigates to /cookies
```

### Preferences Page

Optional page for managing consent after initial banner:

```
[Page: "/cookies"]

[Heading: "Your Cookie Preferences"]

[Section: Necessary]
  ☑️ Session & Security
  These are always enabled.

[Section: Analytics]
  ☐ Analytics
  [Toggle switch]

[Section: Marketing]
  ☐ Marketing
  [Toggle switch]

[Save button]

[Info box]:
  Last updated: [date]
  Your preferences will expire on [date]
  [Renew preferences]
```

---

## Analytics Integration

Only initialize analytics if user consents to "analytics" cookies.

### Script Loading

In the HTML `<head>`:

```html
<!-- Do NOT load analytics script immediately -->
<!-- Instead, load it conditionally after consent check -->

<script>
  // Check consent cookie before loading analytics
  function shouldLoadAnalytics() {
    const consentCookie = getCookie('consentStatus');
    if (!consentCookie) {
      return false;  // No consent yet
    }
    const consent = JSON.parse(consentCookie);
    return consent.analytics === true;
  }

  if (shouldLoadAnalytics()) {
    // Load analytics script (e.g., Google Analytics)
    const script = document.createElement('script');
    script.src = 'https://www.googletagmanager.com/gtag/js?id=GA_ID';
    script.async = true;
    document.head.appendChild(script);
  }
</script>
```

### Example: Google Analytics

```javascript
if (shouldLoadAnalytics()) {
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'GA_ID', {
    'anonymize_ip': true,
    'allow_google_signals': false
  });
}
```

### Custom Events

Track custom events only if consent is given:

```javascript
function trackEvent(eventName, data) {
  const consent = getCookie('consentStatus');
  if (consent && JSON.parse(consent).analytics) {
    gtag('event', eventName, data);
  }
}
```

---

## Implementation Details

### Banner Visibility Logic

Show banner if:
1. No `consentStatus` cookie, OR
2. Cookie is expired, OR
3. Analytics configuration changed (new categories added)

```pseudocode
function shouldShowConsentBanner():
  cookie = getCookie('consentStatus')

  if (!cookie):
    return true  // First visit

  consent = parseJSON(cookie)
  if (consent.expires_at < now):
    return true  // Expired

  // Check if new categories were added to config
  configVersion = getAnalyticsConfigVersion()
  if (configVersion > consent.version):
    return true  // Config updated; ask again

  return false
```

### Fingerprinting (Anonymous Session ID)

For audit compliance, create an anonymous session fingerprint (not tied to user_id, which would be PII):

```pseudocode
function getConsentFingerprint():
  // Use browser properties + IP hash to create anonymous ID
  // DO NOT use personally identifiable data
  fingerprint = hash(userAgent + ipAddress + timestamp.date)
  // Store in sessionStorage or cookie
  return fingerprint
```

This allows tracking that "this user accepted consent on this date" without knowing who the user is.

### Jurisdiction Detection (Optional)

Customize banner text based on user's jurisdiction:

```pseudocode
function shouldRequireConsentBanner():
  userCountry = geoIpLookup()

  // GDPR: EU + EEA
  if (userCountry in ['DE', 'FR', 'SE', ...]):
    return true

  // California (CCPA)
  if (userCountry == 'US' and userState == 'CA'):
    return true

  // Most countries benefit from transparent consent, so show by default
  return true
```

---

## Security & Privacy Notes

### 1. No PII in Consent Logs

Consent logs are specifically for compliance audits. They must NOT contain personally identifiable information:

```
// BAD: stores user email
{
  user_id: 'abc123',
  email: 'user@example.com',
  consent_state: {...}
}

// GOOD: anonymous fingerprint
{
  fingerprint: sha256(ip + userAgent),
  ip_hash: sha256(ip),
  consent_state: {...}
}
```

### 2. Cookie Consent itself is NOT a Consent Cookie

The `consentStatus` cookie is exempt from needing consent (it IS the consent mechanism). See EDPB guidelines on "exempt cookies":
- Authentication
- Session management
- Security/CSRF protection
- Consent preferences

### 3. No Preselection

Do NOT pre-check the "Analytics" and "Marketing" checkboxes. GDPR requires explicit consent, not opt-out. User must actively choose to enable them.

```
// WRONG: boxes pre-checked
[☑️] Analytics
[☑️] Marketing

// RIGHT: boxes unchecked
[☐] Analytics
[☐] Marketing
```

### 4. Change of Categories

If you add a new tracking category (e.g., "Social Media Tracking"), you must ask for consent again. Update `version` in the consent schema and re-show the banner.

### 5. Rejecting is as Easy as Accepting

"Reject All" button must be as prominent as "Accept All". Don't hide it or make it less accessible.

---

## Gotchas

### 1. Multiple Scripts Waiting for Consent

If multiple scripts (Google Analytics, Intercom, Mixpanel) all need consent, avoid race conditions. Use a consent event emitter:

```javascript
class ConsentManager extends EventTarget {
  constructor() {
    super();
  }

  grantConsent(category) {
    const event = new CustomEvent('consentGranted', {
      detail: { category }
    });
    this.dispatchEvent(event);
  }
}

const consentManager = new ConsentManager();

// Each script listens for consent
consentManager.addEventListener('consentGranted', (e) => {
  if (e.detail.category === 'analytics') {
    loadGoogleAnalytics();
  } else if (e.detail.category === 'marketing') {
    loadIntercom();
  }
});

// On banner submit, grant all consented categories
function submitConsent(choices) {
  if (choices.analytics) consentManager.grantConsent('analytics');
  if (choices.marketing) consentManager.grantConsent('marketing');
}
```

### 2. Banner Flashing / Layout Shift

If banner loads after content, it can shift page layout and cause "Cumulative Layout Shift" (CLS) metrics. Minimize this:

- Pre-render banner in HTML (not JS)
- Use `height` or `margin-bottom` placeholder before banner loads
- Animate banner in smoothly (no jarring appearance)

### 3. Changing Consent Later

If user initially rejects analytics, then later enables it, historical data is missing. Document this:

"We can't retroactively track events you disabled consent for, but we'll start tracking from now on."

### 4. Cookie Deletion

If user manually clears cookies, the `consentStatus` cookie is deleted. On next visit, banner appears again. This is expected and correct.

### 5. Third-Party Cookies + SameSite=Lax

If you use third-party cookies (e.g., for cross-domain retargeting), `SameSite=Lax` may not allow them. You might need `SameSite=None; Secure`, but this requires explicit consent anyway (don't assume lax is enough for third-party cookies).

### 6. Consent Expiry Too Short

If consent expires every 30 days, users are constantly re-shown the banner. GDPR says consent can last up to 12-24 months for most cases. Set a reasonable TTL (365 days is standard).

### 7. Banner Shown to Admins Too

If you're testing locally or as an admin, the banner is shown to you as well. Create a mechanism to skip it:

```javascript
if (isDevelopmentMode() || isAdmin()) {
  // Auto-accept consent for testing
  submitConsent({ necessary: true, analytics: true, marketing: true });
}
```

Or add a URL flag: `/home?consentBypass=true` (only in dev, remove before shipping).

