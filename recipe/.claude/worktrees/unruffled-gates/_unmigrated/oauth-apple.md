---
name: OAuth — Apple
description: Apple Sign In as an enhancement to the base OTP auth system
type: enhancement
requires: recipes/otp.md
env_vars: OAUTH_APPLE_CLIENT_ID, OAUTH_APPLE_TEAM_ID, OAUTH_APPLE_KEY_ID, OAUTH_APPLE_PRIVATE_KEY
---

# OAuth — Apple

Enhancement to base OTP auth that adds Apple Sign In alongside email OTP authentication. Apple Sign In is required for App Store compliance if any third-party OAuth provider is offered.

## Overview

Apple Sign In uses the OAuth 2.0 Authorization Code flow. The server validates the identity token returned by Apple. This recipe integrates with the existing OTP session mechanism—upon successful authentication, the same session cookie is created as with OTP login.

### Key Design Decisions

1. **Authorization Code Flow**: Apple Sign In uses authorization codes with server-side token exchange. The identity token is a JWT validated server-side.
2. **Name Capture on First Auth Only**: Apple only sends the user's name (`user.name`) on the first authorization. Subsequent logins only include email and subject (sub). You MUST capture and store the name immediately on first callback.
3. **Private Relay Email Handling**: Apple's "Hide My Email" feature generates a private relay address (e.g., `abc123.privaterelay.appleid.com`). Use this relay address as the user identifier—it forwards to the real email and is stable across sessions.
4. **Same Session Mechanism**: Reuses the session creation logic from `recipes/otp.md`. Creates an active session with the same cookie configuration.
5. **Conditional On Environment**: Apple Sign In is only enabled if `OAUTH_APPLE_CLIENT_ID` is present in `.env`.
6. **App Store Policy**: Required if any other third-party OAuth is offered. Apple's policy mandates that if you implement Google/GitHub/Facebook login, you must also offer Apple Sign In.

---

## Apple Developer Setup

### Web Configuration

For web-based Apple Sign In, you need:

1. **Service ID**: Register a service ID (not an app ID) in Apple Developer Console
2. **Domain Verification**: Add your domain to the Service ID and download the domain verification file
3. **Return URL Configuration**: Configure authorized return URLs (e.g., `https://yourapp.com/api/auth/apple/callback`)
4. **API Key**: Generate a private key with "Sign in with Apple" capability

### Native Configuration (iOS/Android via Expo)

1. **App ID**: Configure with "Sign in with Apple" capability enabled
2. **Bundle ID**: Matches your app's bundle identifier
3. **Team ID**: Your Apple Developer Team ID
4. **Key ID**: Generate a private key with "Sign in with Apple" capability
5. **Private Key**: Download and securely store in `.env`

### Environment Variables

```
OAUTH_APPLE_CLIENT_ID=<service-id or bundle-id>
OAUTH_APPLE_TEAM_ID=<your-team-id>
OAUTH_APPLE_KEY_ID=<key-id>
OAUTH_APPLE_PRIVATE_KEY=<private-key-content>
```

The private key is a PEM-encoded file. In `.env`, store it as a single string with literal `\n`:

```
OAUTH_APPLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMII...\n-----END PRIVATE KEY-----"
```

---

## Web Implementation

### OAuth Flow

**User initiates sign in:**

```
1. Client redirects to: https://appleid.apple.com/auth/authorize
   Query params:
   - client_id: OAUTH_APPLE_CLIENT_ID
   - redirect_uri: https://yourapp.com/api/auth/apple/callback
   - response_type: code id_token form_post
   - scope: email (and optionally: name)
   - response_mode: form_post
   - state: <random-nonce>
   - nonce: <separate-random-nonce>
```

**Apple redirects back to your callback endpoint:**

```
POST /api/auth/apple/callback
Content-Type: application/x-www-form-urlencoded

code=<authorization-code>
&id_token=<jwt-identity-token>
&user=<json-string-with-name-email-photo>
&state=<state-nonce>
```

Note: Apple POSTs form data, not query parameters. This is different from most OAuth providers.

### API Route: POST /api/auth/apple/callback

**Pseudocode:**

```
function handleAppleCallback(request):
    // 1. Validate state nonce
    state_from_form = request.body.state
    state_from_session = session.get('oauth_state')
    if state_from_form != state_from_session:
        return error("State mismatch — possible CSRF")

    // 2. Extract authorization code and identity token
    code = request.body.code
    id_token_jwt = request.body.id_token
    user_json_string = request.body.user  // Only present on first auth

    // 3. Verify and decode the identity token
    try:
        decoded_token = verifyAppleIdentityToken(id_token_jwt)
    catch:
        return error("Invalid identity token")

    // 4. Validate token claims
    validateTokenClaims(decoded_token):
        - Check aud (audience) == OAUTH_APPLE_CLIENT_ID
        - Check exp (expiry) > now
        - Check iss (issuer) == "https://appleid.apple.com"
        - Check nonce from token matches request nonce

    // 5. Exchange code for tokens (optional, for refresh tokens)
    // Apple doesn't provide refresh tokens, but you can validate the code server-side
    tokens = exchangeCodeForTokens(code)

    // 6. Extract email and subject from token
    email = decoded_token.email
    apple_sub = decoded_token.sub

    // 7. Check if user exists (by apple_sub or email)
    user = findUserByAppleSubOrEmail(apple_sub, email)

    // 8. If first-time auth, capture and store name
    if user_json_string is present:
        user_data = JSON.parse(user_json_string)
        first_name = user_data.name.firstName
        last_name = user_data.name.lastName
        if user is new:
            user.apple_name_first = first_name
            user.apple_name_last = last_name
            user.save()

    // 9. Upsert user record
    user = upsertUser({
        apple_sub: apple_sub,
        email: email,
        auth_method: 'apple'
    })

    // 10. Link to existing account if email matches OTP user
    existing_otp_user = findUserByEmail(email)
    if existing_otp_user and user != existing_otp_user:
        linkAccounts(existing_otp_user, user)

    // 11. Create session (same as OTP)
    session = createSession(user)
    setCookie('session_id', session.id)

    // 12. Redirect to dashboard
    return redirect('/dashboard')
```

---

## Native Implementation (iOS/Expo)

### OAuth Flow with ASAuthorizationController / expo-apple-authentication

**User initiates sign in (iOS native):**

```
1. Display "Sign in with Apple" button (ASAuthorizationAppleIDButton)
2. On tap, invoke ASAuthorizationController
   Request scopes: .fullName, .email
3. Apple presents native auth UI (biometric or password)
4. User approves — ASAuthorizationController returns:
   - Authorization code
   - Identity token (JWT)
   - User info (fullName, email) — only on first authorization
   - Real user status
```

**User initiates sign in (Expo):**

```
import AppleAuthentication from 'expo-apple-authentication'

async function signInWithApple():
    const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
            AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
            AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ]
    })

    return {
        identityToken: credential.identityToken,
        authorizationCode: credential.authorizationCode,
        user: {
            name: credential.fullName,
            email: credential.email,
            realUserStatus: credential.realUserStatus
        }
    }
```

**Client sends to backend:**

```
POST /api/auth/apple/callback
Content-Type: application/json

{
    "id_token": "<jwt-identity-token>",
    "code": "<authorization-code>",
    "user": {
        "name": { "firstName": "John", "lastName": "Doe" },
        "email": "john@example.com"
    },
    "nonce": "<nonce-from-request>"
}
```

Native apps use the same backend validation as web, but the token exchange flow differs slightly.

---

## Identity Token Validation

Apple's identity token is a JWT. Validate server-side:

**Pseudocode:**

```
function verifyAppleIdentityToken(id_token_jwt):
    // 1. Fetch Apple's public keys (cache aggressively)
    public_keys = fetchApplePublicKeys()  // from https://appleid.apple.com/auth/keys

    // 2. Decode JWT header (without verification)
    header = decodeJWTHeader(id_token_jwt)
    kid = header.kid

    // 3. Find matching public key by kid
    public_key = findKeyByKid(public_keys, kid)
    if public_key is null:
        throw InvalidKeyError("Key not found")

    // 4. Verify JWT signature using RS256
    try:
        decoded = verifyJWTSignature(id_token_jwt, public_key, algorithm='RS256')
    catch:
        throw InvalidSignatureError()

    // 5. Validate required claims
    validateClaims(decoded):
        - aud (audience) must equal OAUTH_APPLE_CLIENT_ID
        - iss (issuer) must equal "https://appleid.apple.com"
        - exp (expiry) must be > current time
        - iat (issued at) should be recent (within last 10 minutes)
        - sub (subject) must be present
        - email must be present

    // 6. Validate nonce if provided (for web, optional; for native, required)
    if request.nonce is present:
        nonce_hash = sha256(request.nonce).base64url_encode()
        if decoded.nonce != nonce_hash:
            throw NonceError("Nonce mismatch")

    return decoded
```

**Apple's public keys endpoint:**

```
GET https://appleid.apple.com/auth/keys
```

Returns JWKS (JSON Web Key Set). Cache the response (Apple sends `max-age` headers).

---

## User Linking & Email Handling

### Same Email = Same User

If a user has already signed up with OTP (email + password), and then signs in with Apple using the same email, link the accounts:

```
function linkAccounts(otp_user, apple_user):
    // Merge Apple identity into OTP account
    otp_user.apple_sub = apple_user.apple_sub
    otp_user.auth_methods.push('apple')
    otp_user.save()

    // Mark Apple account as linked (don't use it as primary)
    // or delete duplicate if you consolidate
    deleteOrMarkAsLinked(apple_user)

    return otp_user
```

### Private Relay Email Handling

Apple's "Hide My Email" feature generates a relay email (e.g., `abc123.privaterelay.appleid.com`). This is a real, stable identifier:

- The relay email is unique per user per app
- Apple forwards mail sent to the relay to the user's real email
- Use the relay email as the user identifier in your system
- Do NOT try to extract or request the real email
- Store both: `email` (relay) and `apple_sub` (immutable identifier)

```
function upsertUser(apple_auth_data):
    apple_sub = apple_auth_data.apple_sub
    email = apple_auth_data.email  // Could be relay or real

    // Find by apple_sub first (most reliable)
    user = findByAppleSub(apple_sub)
    if user:
        return user

    // Fall back to email lookup
    user = findByEmail(email)
    if user:
        user.apple_sub = apple_sub
        user.save()
        return user

    // Create new user
    user = createUser({
        email: email,
        apple_sub: apple_sub,
        auth_methods: ['apple']
    })
    return user
```

---

## Name Capture (First Auth Only)

Apple only sends the user's name on the first authorization. This is critical:

**Pseudocode:**

```
function captureNameOnFirstAuth(user_json_string, user):
    if user_json_string is null:
        // Subsequent login — no name data
        return

    user_data = JSON.parse(user_json_string)

    if user_data.name:
        first_name = user_data.name.firstName || ""
        last_name = user_data.name.lastName || ""
        middle_name = user_data.name.middleName || ""
        name_prefix = user_data.name.namePrefix || ""
        name_suffix = user_data.name.nameSuffix || ""

        // Store immediately
        user.name_first = first_name
        user.name_last = last_name
        user.name_middle = middle_name
        user.name_prefix = name_prefix
        user.name_suffix = name_suffix
        user.name_captured_at = now()
        user.save()
```

**Important:** Do not prompt for name again on subsequent logins. If you need a user's name and it wasn't captured on first auth, ask the user to provide it during onboarding.

---

## Web vs Native Differences

| Aspect | Web | Native (iOS/Android) |
|--------|-----|-----|
| **Sign In UI** | Redirect to `appleid.apple.com` | Native ASAuthorizationController or expo-apple-authentication |
| **Client ID** | Service ID (registered in Developer Console) | App Bundle ID |
| **Domain Verification** | Required (domain verification file) | Not required |
| **Return URL** | Configured in Service ID settings | Native, handled by SDK |
| **Token Delivery** | Form POST with `id_token` in body | Direct to app, forwarded to backend via HTTP |
| **Refresh Tokens** | Not supported | Not supported |
| **Real User Status** | Not available | Available (Apple's fraud detection) |
| **Nonce** | Optional but recommended | Required |
| **Code Exchange** | Optional (for added security) | Can exchange code server-side |

---

## Apple Developer Setup Checklist

### For Web

- [ ] Register a Service ID in Developer Console
- [ ] Add your domain(s) to the Service ID
- [ ] Download and host the domain verification file at `.well-known/apple-developer-domain-association.txt`
- [ ] Add authorized redirect URIs to the Service ID
- [ ] Generate a private key with "Sign in with Apple" capability
- [ ] Store key ID and private key content in `.env`
- [ ] Test redirect flow in sandbox first

### For Native

- [ ] Enable "Sign in with Apple" capability for your App ID
- [ ] Ensure bundle ID matches what's registered in Developer Console
- [ ] Generate a private key with "Sign in with Apple" capability
- [ ] Store team ID, key ID, and private key in `.env`
- [ ] Configure the Apple authentication SDK in your native code
- [ ] Test on a real device (simulator may have limitations)

---

## Security Considerations

### Nonce Validation

Nonce prevents replay attacks and token reuse:

```
function validateNonce(nonce_from_request, nonce_claim_in_token):
    // Client sends a random nonce
    // Apple includes the hash of the nonce in the token
    // Server verifies the hash matches

    expected_nonce_hash = sha256(nonce_from_request).base64url_encode()

    if nonce_claim_in_token != expected_nonce_hash:
        throw NonceError("Nonce mismatch")
```

### Token Replay Prevention

- Validate `exp` and `iat` claims
- Do not accept tokens older than a few minutes
- Do not reuse tokens across multiple requests
- For web: validate `state` parameter to prevent CSRF

### State Parameter (Web Only)

```
function handleStateValidation(state_from_form, state_from_session):
    if state_from_form != state_from_session:
        throw CSRFError("State mismatch")

    // Clear state after validation to prevent reuse
    session.delete('oauth_state')
```

### Code Exchange (Optional but Recommended)

For added security, exchange the authorization code for tokens on the backend:

```
function exchangeCodeForTokens(code):
    response = POST https://appleid.apple.com/auth/token
        client_id: OAUTH_APPLE_CLIENT_ID
        client_secret: generateClientSecret()
        code: code
        grant_type: authorization_code

    // This validates that the code hasn't been reused
    // and that the backend is the only entity using this code

    return response.access_token
```

To generate `client_secret`, create a JWT signed with your private key:

```
function generateClientSecret():
    secret = jwt.sign({
        iss: OAUTH_APPLE_TEAM_ID,
        iat: now(),
        exp: now() + 600,  // 10 minutes
        aud: "https://appleid.apple.com",
        sub: OAUTH_APPLE_CLIENT_ID
    }, OAUTH_APPLE_PRIVATE_KEY, algorithm='ES256')

    return secret
```

---

## Common Gotchas

### 1. Name Only on First Auth

**Problem:** You request the user's name on every login, but Apple only sends it once.

**Solution:** Capture the name on first auth and store it. On subsequent logins, use the stored name or ask the user during onboarding.

### 2. Form POST, Not Query Redirect

**Problem:** Expecting Apple to redirect with query parameters like `?code=...`.

**Solution:** Apple POSTs form data to your callback URL. Parse `request.body`, not `request.query`.

### 3. Private Relay Email Confusion

**Problem:** Trying to extract the "real" email from the relay address.

**Solution:** The relay email is the user identifier. Use it as-is. Apple will forward mail to the real email.

### 4. Service ID vs App ID (Web vs Native)

**Problem:** Using an App ID for web, or a Service ID for native.

**Solution:** Web uses Service ID. Native uses App ID. They are different registrations in Developer Console.

### 5. Domain Verification Not Uploaded

**Problem:** Web flow fails with "Invalid redirect URI."

**Solution:** Download the domain verification file from Developer Console and host it at `.well-known/apple-developer-domain-association.txt`. It must be accessible before redirect URIs are added.

### 6. Key Rotation

**Problem:** Apple rotates public keys; your cached keys become invalid.

**Solution:** Cache public keys with respect to the `max-age` header. Implement a refresh mechanism when a `kid` (key ID) is not found in your cache.

### 7. Nonce Mismatch in Native

**Problem:** Identity token validation fails with nonce error.

**Solution:** Native apps must include a nonce in the request and verify the hash in the token. Web is optional but recommended.

### 8. Code Reuse Prevention

**Problem:** Authorization code used multiple times, or code exchanged twice.

**Solution:** Always exchange the code exactly once. Apple invalidates the code after first use.

---

## Integration with OTP Recipe

This recipe enhances `recipes/otp.md` and reuses its session mechanism:

```
// Same session creation as OTP
session = createSession(user)
setCookie('session_id', session.id, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    maxAge: OTP_SESSION_MAX_AGE
})
```

Users can sign in via:
1. Email + OTP (from `recipes/otp.md`)
2. Apple Sign In (this recipe)
3. Both methods on the same account if email matches

---

## Environment Variables Reference

| Variable | Purpose | Example |
|----------|---------|---------|
| `OAUTH_APPLE_CLIENT_ID` | Service ID (web) or App Bundle ID (native) | `com.example.myapp` |
| `OAUTH_APPLE_TEAM_ID` | Apple Developer Team ID | `ABC123DEF4` |
| `OAUTH_APPLE_KEY_ID` | Private key ID from Developer Console | `2QX123ABC4` |
| `OAUTH_APPLE_PRIVATE_KEY` | PEM-encoded private key content | `-----BEGIN PRIVATE KEY-----\nMII...\n-----END PRIVATE KEY-----` |

