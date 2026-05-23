---
name: OAuth — GitHub
description: GitHub OAuth login as an enhancement to the base OTP auth system
type: enhancement
requires: recipes/otp.md
env_vars: OAUTH_GITHUB_CLIENT_ID, OAUTH_GITHUB_CLIENT_SECRET
---

# OAuth — GitHub

GitHub OAuth provides a streamlined login method for existing GitHub users. Unlike Google/Apple, GitHub's flow is simpler: no ID tokens, just access tokens and direct API calls to resolve user identity and email.

## Key Decisions

1. **Authorization Code Flow** — Server exchanges the authorization code for an access token. No implicit grants.
2. **Email Resolution** — GitHub user profiles may not include a primary email. Always call `/user/emails` endpoint to fetch and verify the primary email address.
3. **Session Mechanism** — Reuses the same session system as `recipes/otp.md`.
4. **Conditional Registration** — Only available if `OAUTH_GITHUB_CLIENT_ID` is set in `.env`.
5. **User Linking** — Same email = same user account, regardless of auth method.

## GitHub App Setup

Create an OAuth App at https://github.com/settings/developers:

- **Application name** — e.g., "My App"
- **Homepage URL** — `https://yourdomain.com`
- **Authorization callback URL** — `https://yourdomain.com/api/auth/github/callback`
- **Scopes** — `read:user`, `user:email`

Store credentials in `.env`:
```
OAUTH_GITHUB_CLIENT_ID=<client_id>
OAUTH_GITHUB_CLIENT_SECRET=<client_secret>
OAUTH_GITHUB_REDIRECT_URI=https://yourdomain.com/api/auth/github/callback
```

## OAuth Flow

```
User clicks "Login with GitHub"
  ↓
GET /api/auth/github
  → generate state token (CSRF protection)
  → redirect to https://github.com/login/oauth/authorize
    ?client_id=<CLIENT_ID>
    &redirect_uri=<REDIRECT_URI>
    &scope=read:user,user:email
    &state=<STATE_TOKEN>
  ↓
User authorizes app on github.com
  ↓
GitHub redirects to /api/auth/github/callback
  ?code=<AUTH_CODE>&state=<STATE>
  ↓
Server validates state token
  → POST https://api.github.com/login/oauth/access_token
    {client_id, client_secret, code}
  ← receive access_token
  ↓
Server calls GitHub API
  → GET https://api.github.com/user (Authorization: token <ACCESS_TOKEN>)
  ← receive {login, id, ...}
  → GET https://api.github.com/user/emails
  ← receive [{email, primary, verified}, ...]
  ↓
Extract primary verified email
  ↓
Find or create user by email
  → Create session (same as OTP)
  ↓
Redirect to dashboard
```

## API Routes

### GET /api/auth/github

Initiates GitHub OAuth flow.

```
Pseudocode:

function handleGitHubInitiate(req, res):
  if not OAUTH_GITHUB_CLIENT_ID:
    return res.status(400).json({error: "GitHub OAuth not configured"})

  state = generateRandomToken(32)  // CSRF protection
  store_state_in_session(state, expiry: 10 minutes)

  auth_url = "https://github.com/login/oauth/authorize" +
    "?client_id=" + OAUTH_GITHUB_CLIENT_ID +
    "&redirect_uri=" + OAUTH_GITHUB_REDIRECT_URI +
    "&scope=read:user,user:email" +
    "&state=" + state

  return res.redirect(auth_url)
```

### GET /api/auth/github/callback

Handles OAuth callback from GitHub.

```
Pseudocode:

function handleGitHubCallback(req, res):
  code = req.query.code
  state = req.query.state
  error = req.query.error

  // Check for errors
  if error:
    return res.status(400).json({error: "Authorization denied", detail: error})

  if not code or not state:
    return res.status(400).json({error: "Missing code or state"})

  // Validate CSRF state
  if not validate_state_in_session(state):
    return res.status(403).json({error: "Invalid or expired state token"})

  // Exchange code for access token
  token_response = POST "https://api.github.com/login/oauth/access_token" {
    client_id: OAUTH_GITHUB_CLIENT_ID,
    client_secret: OAUTH_GITHUB_CLIENT_SECRET,
    code: code,
    redirect_uri: OAUTH_GITHUB_REDIRECT_URI
  }

  if token_response.error:
    return res.status(401).json({error: "Token exchange failed"})

  access_token = token_response.access_token

  // Fetch user profile
  user_profile = GET "https://api.github.com/user" {
    headers: {Authorization: "token " + access_token}
  }

  if not user_profile:
    return res.status(500).json({error: "Failed to fetch user profile"})

  github_id = user_profile.id
  github_login = user_profile.login

  // Fetch emails (profile may not have primary email)
  emails_response = GET "https://api.github.com/user/emails" {
    headers: {Authorization: "token " + access_token}
  }

  // Find primary verified email
  primary_email = null
  for email_record in emails_response:
    if email_record.verified and email_record.primary:
      primary_email = email_record.email
      break

  // Fallback: use first verified email if no explicit primary
  if not primary_email:
    for email_record in emails_response:
      if email_record.verified:
        primary_email = email_record.email
        break

  if not primary_email:
    return res.status(400).json({error: "No verified email found"})

  // Find or create user
  user = findUserByEmail(primary_email)

  if not user:
    user = createUser({
      email: primary_email,
      github_id: github_id,
      github_login: github_login
    })
  else:
    // Link GitHub if not already linked
    if not user.github_id:
      updateUser(user.id, {github_id: github_id, github_login: github_login})

  // Create session (same mechanism as OTP)
  session = createSession({
    user_id: user.id,
    auth_method: "github",
    expires_at: now() + 7 days
  })

  // Set secure session cookie
  res.cookie("session_id", session.id, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax"
  })

  return res.redirect("/dashboard")
```

## Email Resolution

GitHub's user profile endpoint does not always include the primary email. Always:

1. Call `/user/emails` to get the full email list.
2. Find the record with `verified: true` and `primary: true`.
3. If no explicit primary, use the first verified email.
4. Reject sign-up if no verified email exists.

## User Linking

Users with the same email address — whether from OTP, GitHub, or future providers — belong to the same account. Store `github_id` and `github_login` on the user record for future logins.

## Security

- **State Parameter** — Generate a random, unguessable state token and validate on callback. Prevents CSRF attacks.
- **HTTPS Only** — All OAuth communication must use HTTPS.
- **Access Token Storage** — Do NOT store the access token in the database or session cookie. Use it immediately and discard.
- **Scope Minimization** — Request only `read:user` and `user:email`. Do not request write scopes.

## Gotchas

1. **No Email in Profile** — GitHub profiles may omit the email field. Always call `/user/emails`.
2. **Multiple Verified Emails** — Users may have multiple verified email addresses. GitHub indicates the primary via the `primary` field.
3. **Unverified Emails** — Some users may not have verified their email. Reject if no verified email exists.
4. **Enterprise Accounts** — Enterprise GitHub instances use different OAuth endpoints (e.g., `https://enterprise.github.com`). This recipe assumes github.com.
5. **Token Expiration** — GitHub access tokens from the OAuth flow do not expire by default. However, treat them as short-lived for security.

## Testing Checklist

- [ ] State parameter is validated on callback.
- [ ] Email is fetched from `/user/emails` endpoint, not profile.
- [ ] User is found or created by verified primary email.
- [ ] Session is created and cookie is set securely.
- [ ] User without verified email is rejected.
- [ ] Missing `OAUTH_GITHUB_CLIENT_ID` returns 400.
- [ ] Token exchange failure is handled gracefully.
