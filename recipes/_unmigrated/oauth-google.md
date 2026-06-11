---
name: OAuth — Google
description: Google OAuth login as an enhancement to the base OTP auth system
type: enhancement
requires: recipes/otp.md
env_vars: OAUTH_GOOGLE_CLIENT_ID, OAUTH_GOOGLE_CLIENT_SECRET
---

# OAuth — Google

Add Google as an additional login method alongside email OTP. This recipe integrates with the existing session and user management from `recipes/otp.md` — no parallel auth system, no separate user tables.

## Overview

**Authorization Code Flow:** Users click "Continue with Google" → redirected to Google consent screen → redirected back to your app with authorization code → server exchanges code for tokens (client never sees access token) → user is logged in via existing session mechanism.

**User Linking:** On successful Google auth, look up user by email. If a user already exists from OTP login (same email), link the Google account. Single user_id, multiple auth methods.

**Conditional Feature:** Only enabled if `OAUTH_GOOGLE_CLIENT_ID` is set in `.env`. If not set, the Google login UI is hidden and the callback returns 404.

**Profile Picture:** Store the Google profile picture URL but do not download or cache the image. Display it via the URL.

---

## Core Data Model

No new tables. Extend the `users` table (from otp.md) with:

```pseudocode
ALTER TABLE users ADD COLUMN (
  google_id STRING UNIQUE,            // Sub claim from Google ID token
  google_picture_url STRING,          // https://lh3.googleusercontent.com/...
  oauth_linked_at TIMESTAMP           // When Google was linked to this user
)

// users table schema (existing):
// - id (PK)
// - email (UNIQUE)
// - phone (optional)
// - name
// - role (default: 'user')
// - created_at
// - updated_at
// - [NEW] google_id
// - [NEW] google_picture_url
// - [NEW] oauth_linked_at
```

No separate OAuth tokens table. Access tokens are ephemeral; ID tokens are validated once and discarded. Store refresh tokens in a secure, http-only cookie if implementing token refresh (optional; many apps don't refresh during a session).

---

## OAuth Flow (Web)

### 1. Initiate Flow: GET /api/auth/google

```pseudocode
endpoint GET /api/auth/google

  // Feature flag check
  IF OAUTH_GOOGLE_CLIENT_ID is not set
    RETURN 404

  // Generate CSRF state (prevents CSRF attacks)
  state = secureRandomString(32)
  STORE state in session or signed cookie with 5-min expiry

  // Generate nonce (prevents replay attacks)
  nonce = secureRandomString(32)
  STORE nonce in session or signed cookie with 5-min expiry

  // Build Google authorization URL
  auth_url = "https://accounts.google.com/o/oauth2/v2/auth?"
    + "client_id=" + OAUTH_GOOGLE_CLIENT_ID
    + "&redirect_uri=" + urlEncode("https://yourapp.com/api/auth/google/callback")
    + "&response_type=code"
    + "&scope=" + urlEncode("openid email profile")
    + "&state=" + state
    + "&nonce=" + nonce

  REDIRECT to auth_url
```

### 2. Callback: GET /api/auth/google/callback

```pseudocode
endpoint GET /api/auth/google/callback

  // Extract authorization code and state
  code = queryParam("code")
  state = queryParam("state")
  error = queryParam("error")

  IF error is present
    RETURN 400 with error message

  // Verify state (CSRF protection)
  stored_state = RETRIEVE from session/cookie
  IF state != stored_state OR state is expired
    RETURN 403 "CSRF token mismatch"

  // Exchange code for tokens (server-side, client never sees access token)
  token_response = HTTP POST to "https://oauth2.googleapis.com/token"
    body:
      - client_id: OAUTH_GOOGLE_CLIENT_ID
      - client_secret: OAUTH_GOOGLE_CLIENT_SECRET
      - code: code
      - grant_type: "authorization_code"
      - redirect_uri: "https://yourapp.com/api/auth/google/callback"

  IF token_response.error
    RETURN 500 "Token exchange failed"

  access_token = token_response.access_token
  id_token = token_response.id_token
  refresh_token = token_response.refresh_token (if present)

  // Validate and decode ID token (JWT)
  id_token_claims = VERIFY_AND_DECODE_JWT(
    token: id_token,
    public_key: GOOGLE_PUBLIC_KEY,    // Fetch from https://www.googleapis.com/oauth2/v1/certs
    expected_aud: OAUTH_GOOGLE_CLIENT_ID,
    expected_iss: "https://accounts.google.com"
  )

  // Verify nonce (replay protection)
  stored_nonce = RETRIEVE from session/cookie
  IF id_token_claims.nonce != stored_nonce OR nonce is expired
    RETURN 403 "Nonce mismatch"

  // Extract user info from ID token
  google_id = id_token_claims.sub           // Unique Google user ID
  email = id_token_claims.email
  name = id_token_claims.name
  picture = id_token_claims.picture         // URL to profile picture
  email_verified = id_token_claims.email_verified

  // User linking / creation logic
  existing_user = QUERY users WHERE google_id = google_id
  IF existing_user
    // Google ID already linked to a user
    user = existing_user
  ELSE
    // Check if email already exists (from OTP or previous signup)
    existing_user_by_email = QUERY users WHERE email = email
    IF existing_user_by_email
      // Link Google to existing user
      user = existing_user_by_email
      UPDATE users
        SET google_id = google_id,
            google_picture_url = picture,
            oauth_linked_at = NOW()
        WHERE id = user.id
    ELSE
      // Create new user
      user = INSERT into users (
        email: email,
        name: name,
        google_id: google_id,
        google_picture_url: picture,
        oauth_linked_at: NOW(),
        role: 'user'
      )

  // Create session using existing session mechanism (from otp.md)
  session = CREATE_SESSION(user.id)
  SET session cookie (http-only, secure, same-site: strict)

  // Clean up state/nonce
  DELETE state from session/cookie
  DELETE nonce from session/cookie

  // Redirect to dashboard
  REDIRECT to "/dashboard"
```

---

## OAuth Flow (Native / Expo)

For React Native / Expo apps, use `expo-auth-session` or platform-specific OAuth libraries.

```pseudocode
// Pseudocode for Expo
import * as AuthSession from 'expo-auth-session'

FUNCTION initiateGoogleOAuth()
  IF OAUTH_GOOGLE_CLIENT_ID is not set
    SHOW error "OAuth not configured"
    RETURN

  // Generate PKCE challenge (protects against authorization code interception)
  code_verifier = secureRandomString(128)
  code_challenge = BASE64_URL_ENCODE(SHA256(code_verifier))

  // Store code_verifier securely (SecureStore.setItem)
  SECURE_STORE_SET("google_code_verifier", code_verifier)

  // Request authorization
  result = await AuthSession.startAsync(
    discovery: GOOGLE_DISCOVERY_CONFIG,
    clientId: OAUTH_GOOGLE_CLIENT_ID,
    scopes: ["openid", "email", "profile"],
    extraParams: {
      code_challenge: code_challenge,
      code_challenge_method: "S256"
    }
  )

  IF result.type != "success"
    SHOW error "OAuth cancelled"
    RETURN

  // Get authorization code
  code = result.params.code

  // Exchange code for tokens (call your backend)
  token_response = await HTTP POST to "/api/auth/google/token"
    body:
      - code: code
      - code_verifier: code_verifier (retrieved from secure store)

  IF token_response.error
    SHOW error
    RETURN

  // Backend validates tokens and returns session info
  // Store session token securely
  SECURE_STORE_SET("session_token", token_response.session_token)

  // Redirect to authenticated screens
  NAVIGATE to TabNavigator
```

---

## API Routes

### GET /api/auth/google
Initiates the OAuth flow. Returns redirect to Google.

**Parameters:** None.

**Response:**
- HTTP 302 redirect to `https://accounts.google.com/o/oauth2/v2/auth`
- Sets state and nonce in signed cookies.

**Errors:**
- 404 if `OAUTH_GOOGLE_CLIENT_ID` is not set.

---

### GET /api/auth/google/callback
Handles Google's callback redirect. Exchanges code for tokens, validates JWT, creates or links user, and establishes session.

**Parameters:**
- `code` (required): Authorization code from Google.
- `state` (required): CSRF state.
- `error` (optional): Error code if user denied or error occurred.

**Response:**
- HTTP 302 redirect to `/dashboard` (or configured success URL) with session cookie set.

**Errors:**
- 400 Bad Request: Missing code or error present.
- 403 Forbidden: CSRF state mismatch or nonce mismatch.
- 500 Internal Server Error: Token exchange failed or JWT validation failed.

---

### POST /api/auth/google/token (Native Only)
Called by native app after receiving authorization code. Validates PKCE and exchanges code for tokens. Returns session information.

**Parameters:**
- `code` (required): Authorization code.
- `code_verifier` (required): PKCE code verifier.

**Response:**
```json
{
  "session_token": "session_id_or_jwt",
  "user": { "id", "email", "name", "picture" },
  "expires_in": 86400
}
```

**Errors:**
- 400: Invalid PKCE or code.
- 500: Token exchange failed.

---

## User Linking Logic

### Scenario A: First Google Login (No Prior Account)
```pseudocode
google_id = "..." (from ID token sub claim)
email = "alice@example.com"

existing_by_google_id = QUERY users WHERE google_id = google_id
IF existing_by_google_id THEN
  // User already linked; just log them in
  RETURN create_session(existing_by_google_id.id)

existing_by_email = QUERY users WHERE email = email
IF existing_by_email THEN
  // Email exists (e.g., from OTP signup); link Google to this account
  UPDATE users SET google_id = google_id, ... WHERE id = existing_by_email.id
  RETURN create_session(existing_by_email.id)

// No user exists; create new
new_user = INSERT users (
  email: email,
  name: name_from_google,
  google_id: google_id,
  google_picture_url: picture_url,
  oauth_linked_at: NOW(),
  role: 'user'
)
RETURN create_session(new_user.id)
```

### Scenario B: Existing OTP User Links Google
```pseudocode
// User signed up via email OTP, now clicks "Continue with Google" with the same email.

user_by_otp = QUERY users WHERE email = "alice@example.com"
// user_by_otp.google_id is NULL

google_id = "..." (from Google ID token)

// Link Google to existing user
UPDATE users
  SET google_id = google_id,
      google_picture_url = picture_url,
      oauth_linked_at = NOW()
  WHERE id = user_by_otp.id

RETURN create_session(user_by_otp.id)
```

### Scenario C: Email Mismatch (Not Common)
```pseudocode
// User has Google account with email alice+google@example.com,
// but tries to link to OTP account alice@example.com.

// DO NOT link. Treat as two separate identities.
// Prompt: "This Google email is different from your registered email. Create a new account or use OTP login."

// This prevents accidental account merging.
```

---

## UI Changes

### Login / Signup Screen
Add conditional button: "Continue with Google"

```pseudocode
component LoginScreen
  RENDER
    <Form>
      <Input placeholder="Email" onChange={...} />
      <Input type="password" placeholder="Password" onChange={...} />
      <Button onClick={submitEmailOTP}>Continue with Email</Button>

      IF featureFlag("OAUTH_GOOGLE_ENABLED") && OAUTH_GOOGLE_CLIENT_ID is set
        <Divider text="or" />
        <Button onClick={initiateGoogleOAuth} variant="secondary">
          <Icon src="google-logo.svg" />
          Continue with Google
        </Button>
    </Form>
```

### User Profile / Account Settings
Show linked auth methods and picture:

```pseudocode
component AccountSettings
  user = getSession().user

  RENDER
    <Section title="Auth Methods">
      <Item>
        <Label>Email</Label>
        <Value>{user.email} (via OTP)</Value>
      </Item>

      IF user.google_id
        <Item>
          <Label>Google Account</Label>
          <Value>{user.google_id} (linked {user.oauth_linked_at})</Value>
          <Button onClick={unlinkGoogle}>Unlink</Button>
        </Item>
      ELSE
        <Item>
          <Button onClick={initiateGoogleOAuth}>Link Google Account</Button>
        </Item>

    <Section title="Profile Picture">
      IF user.google_picture_url
        <Avatar src={user.google_picture_url} />
      ELSE
        <Avatar src="default-avatar.svg" />
```

---

## Token Handling

### ID Token Validation

```pseudocode
FUNCTION validateIdToken(id_token)

  // Fetch Google's public keys
  certs_response = HTTP GET from "https://www.googleapis.com/oauth2/v1/certs"
  public_keys = PARSE certs_response as JSON
  // Cache with Cache-Control header (up to 24 hours)

  // Decode JWT header to find key ID (kid)
  header = JWT_DECODE_HEADER(id_token)
  kid = header.kid

  // Get the correct public key
  public_key = public_keys[kid]
  IF NOT public_key
    THROW error "Key ID not found"

  // Verify signature
  payload = JWT_VERIFY_SIGNATURE(
    token: id_token,
    public_key: public_key,
    algorithm: "RS256"
  )

  // Verify claims
  IF payload.aud != OAUTH_GOOGLE_CLIENT_ID
    THROW error "Invalid audience"

  IF payload.iss != "https://accounts.google.com"
    THROW error "Invalid issuer"

  IF ABS(NOW() - payload.iat) > 600  // Issued within last 10 minutes
    THROW error "Token too old"

  IF payload.exp < NOW()
    THROW error "Token expired"

  RETURN payload  // Contains sub, email, name, picture, nonce, email_verified
```

### Refresh Tokens
Optional: If implementing token refresh during a session.

```pseudocode
// Store refresh token securely (encrypted in database or secure cookie)
FUNCTION storeRefreshToken(user_id, refresh_token)
  // Option A: Database
  INSERT into oauth_refresh_tokens (user_id, token, expires_at)
    VALUES (user_id, ENCRYPT(refresh_token), NOW() + 6 months)

  // Option B: Secure HTTP-only cookie (more stateless)
  SET cookie "google_refresh_token"
    VALUE: ENCRYPT(refresh_token)
    HTTP_ONLY: true
    SECURE: true
    SAME_SITE: "strict"
    MAX_AGE: 6 months

// Use refresh token only if access token is expired
FUNCTION refreshAccessToken(user_id)
  refresh_token = RETRIEVE from storage
  IF NOT refresh_token
    THROW error "No refresh token"

  response = HTTP POST to "https://oauth2.googleapis.com/token"
    body:
      - client_id: OAUTH_GOOGLE_CLIENT_ID
      - client_secret: OAUTH_GOOGLE_CLIENT_SECRET
      - refresh_token: refresh_token
      - grant_type: "refresh_token"

  new_access_token = response.access_token
  // Note: Google may issue a new refresh token; replace if present
  IF response.refresh_token
    DELETE old refresh token
    STORE new refresh token

  RETURN new_access_token
```

---

## Security

### State Parameter (CSRF Protection)
- Generate a cryptographically secure random state (32+ bytes).
- Store state in a signed cookie or server-side session with 5-minute expiry.
- Verify state matches on callback.
- Reject if state is missing, invalid, or expired.

### Nonce Parameter (Replay Protection)
- Generate a cryptographically secure random nonce (32+ bytes).
- Include nonce in authorization request (not standard Google, but recommended).
- Verify nonce claim in ID token matches on callback.
- Reject if nonce is missing, invalid, or expired.

### PKCE (Proof Key for Code Exchange) — Native Only
- Generate code_verifier (128 random characters).
- Compute code_challenge = BASE64_URL(SHA256(code_verifier)).
- Include code_challenge in authorization request.
- Exchange code with code_verifier.
- Prevents authorization code interception.

### JWT Validation
- Always validate JWT signature using Google's public keys.
- Verify aud (audience), iss (issuer), exp (expiration), iat (issued at).
- Never trust an unverified JWT.

### Session Security (Inherited from otp.md)
- Set session cookie as http-only, secure, and same-site: strict.
- Use the same session mechanism as OTP login — no parallel auth system.
- Invalidate session on logout.

### Redirect URI Validation
- Only allow redirect URIs registered in Google Cloud Console.
- Hardcode redirect URIs in your app; do not accept from request parameters.

### Token Storage
- Never store access tokens in local storage or session storage (XSS-vulnerable).
- Store refresh tokens securely: encrypted in database or secure http-only cookie.
- Access tokens are validated once and discarded.

---

## Native vs. Web Differences

| Aspect | Web | Native |
|--------|-----|--------|
| **Flow** | Authorization Code (server-side token exchange) | Authorization Code + PKCE (client presents code) |
| **Token Exchange** | Always server-side. Client gets session cookie. | Server-side or client-side (depending on architecture). |
| **Popup Handling** | Redirect or popup. Popup blockers may trigger. | Platform-native browser or in-app WebView. |
| **Refresh Tokens** | Optional; store in http-only cookie or database. | Securely store in device keychain. |
| **PKCE** | Optional but recommended. | Required (authorization code interception risk). |
| **Session Cookie** | HTTP-only cookie. | Store session token in secure storage (Keychain/Keystore). |

---

## Google Cloud Console Setup

### Prerequisites
1. Create a Google Cloud project.
2. Enable the "Google+ API" (or "Identity and Access Management API").
3. Create an OAuth 2.0 Client ID.

### Web Application Setup

```pseudocode
Google Cloud Console:
  1. Go to Credentials → Create OAuth 2.0 Client ID (Web Application).
  2. Set Authorized JavaScript Origins:
     - http://localhost:3000 (local dev)
     - https://yourapp.com (production)
  3. Set Authorized Redirect URIs:
     - http://localhost:3000/api/auth/google/callback (local)
     - https://yourapp.com/api/auth/google/callback (production)
  4. Copy Client ID and Client Secret.
  5. Store in .env: OAUTH_GOOGLE_CLIENT_ID and OAUTH_GOOGLE_CLIENT_SECRET.
```

### Native Application Setup

```pseudocode
Google Cloud Console:
  1. Go to Credentials → Create OAuth 2.0 Client ID (iOS / Android).
  2. For iOS:
     - Bundle ID: com.yourapp.ios
     - Team ID: (from Apple Developer Account)
     - App ID Prefix: (from Apple)
  3. For Android:
     - Package name: com.yourapp.android
     - SHA-1 certificate fingerprint: (from keytool)
       keytool -list -v -keystore ~/.android/debug.keystore
       // Enter password: android
  4. Copy Client ID.
  5. Store in app config (hardcoded or build-time variable).
```

---

## Gotchas

### Email Verification Status
- Google's `email_verified` claim may be `false` if user hasn't verified their email with Google.
- You can:
  - Require `email_verified == true` before login (stricter).
  - Accept unverified emails and send a confirmation link anyway (more lenient).
  - Log unverified emails and monitor.
- Decision: recommended to accept unverified emails (Google has different verification standards).

### Account Linking Edge Cases
- **Same email, different Google accounts:** If user has 2+ Google accounts and signs in with a different one, the code will create a separate user (because `google_id` differs). Document this in onboarding.
- **Email change in Google:** If user changes their Google email after linking, the next login attempt will look up the OLD email (stored in users table) and create a new user. Mitigate by prompting user to re-link after detecting email change.
- **Unlinking:** If user unlinks Google, only clear `google_id` (set to NULL). Email and OTP method remain valid.

```pseudocode
FUNCTION unlinkGoogle(user_id)
  UPDATE users
    SET google_id = NULL,
        google_picture_url = NULL,
        oauth_linked_at = NULL
    WHERE id = user_id
  // User can still log in via email OTP
```

### Popup Blockers
- Web: If OAuth is initiated in a popup (not a full redirect), popup blockers may prevent it.
- Mitigation: Default to full-page redirect, not popup. If using popup, document and warn user.

### Picture URL Expiry
- Google profile picture URLs include an expiry parameter (`sz=...`).
- URLs may break after 1 hour. Re-fetch from Google if broken.
- Alternatively: Fetch picture data once and cache it (increases storage, adds sync complexity).
- Recommendation: Display from URL; cache only if needed.

### Scope Limitations
- `openid email profile` provides: sub, email, name, picture, email_verified.
- To fetch additional data (phone, birthday, etc.), request extended scopes or call Google People API with access token.
- Extended scopes trigger additional consent prompts.

### State/Nonce Expiry
- State and nonce should expire in 5-10 minutes.
- If user takes too long to approve on Google's consent screen, state/nonce may expire by the time callback is triggered.
- Mitigate: Use 10+ minute window, or allow user to re-initiate.

### Third-Party Cookies and SameSite
- If your app is embedded in an iframe on a third-party site, SameSite cookies may not be sent.
- Solution: Use SameSite=None; Secure (requires HTTPS) or rely on URL-based session tokens (not cookies).

### Deployment Checklist
- [ ] Set OAUTH_GOOGLE_CLIENT_ID and OAUTH_GOOGLE_CLIENT_SECRET in production .env.
- [ ] Update Google Cloud Console redirect URIs for production domain.
- [ ] Test end-to-end: login, account linking, logout, session expiry.
- [ ] Verify state/nonce expiry and CSRF protection.
- [ ] Test with privacy mode and cross-domain scenarios.
- [ ] Monitor error logs for failed token exchanges and JWT validation failures.

