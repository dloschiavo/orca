---
name: SaaS Enhancements
description: Multi-tenancy, demo accounts, team management, workspace switching, API keys, and webhooks for SaaS products
type: enhancement
requires: recipes/otp.md, recipes/subscription-billing.md, recipes/admin-dashboard.md
env_vars: MULTI_TENANCY_MODE (shared_db | separate_db | disabled), DEMO_ACCOUNT_ENABLED, DEMO_ACCOUNT_EMAIL
---

# SaaS Enhancements

Stack-agnostic framework for multi-tenant SaaS features: tenant isolation, demo accounts, team management, workspace switching, API key management, and outbound webhook delivery. All features integrate with existing auth (otp.md) and billing (subscription-billing.md) systems.

---

## Overview

This recipe provides enterprise SaaS infrastructure:

1. **Multi-Tenancy** — tenant isolation strategies (shared DB or separate DB per tenant)
2. **Demo Account** — sandbox mode for prospects with ephemeral sessions and read-only data
3. **Team Management** — invite members, role-based permissions, seat limits
4. **Workspace Switcher** — quick context switching for users in multiple tenants
5. **API Key Management** — programmatic access to tenant data with scoped permissions and rate limiting
6. **Webhook System** — outbound event delivery with retry logic and audit logs

All features are optional. Enable only what your SaaS product needs.

---

## Part 1: Multi-Tenancy

### Architecture Decision

Two strategies, each with tradeoffs:

#### Strategy A: Shared Database (Recommended Default)

All tenants share one database. Every table includes a `tenant_id` column. Tenant isolation enforced at query level.

**Pros:**
- Simpler operations (one DB to backup, scale, monitor)
- Easier tenant-to-tenant data migration
- Faster feature deployment (no per-tenant DB setup)

**Cons:**
- Single DB failure affects all tenants
- Possible data isolation bugs if `tenant_id` filter is missed
- Harder to customize per-tenant schema

**Default:** Use this unless your SaaS is enterprise-focused and requires absolute isolation or per-tenant customization.

#### Strategy B: Database Per Tenant

Each tenant gets their own database. Tenant identified by subdomain or path.

**Pros:**
- Complete isolation (tenant DB failure doesn't affect others)
- Per-tenant backup/restore and migrations
- Custom schema per tenant

**Cons:**
- Higher operational complexity (many DB instances to manage)
- More expensive (separate DB resources per tenant)
- Tenant migration/consolidation is expensive
- Feature rollout requires coordinated schema migrations across all DBs

**Choose this if:** Enterprise multi-tenancy, regulatory isolation, or per-tenant customization is non-negotiable.

### Configuration

```
ENV: MULTI_TENANCY_MODE = 'shared_db' | 'separate_db' | 'disabled'

if MULTI_TENANCY_MODE == 'disabled':
  // single-user app, no tenant concept
  skip this section

if MULTI_TENANCY_MODE == 'shared_db':
  // all tables include tenant_id
  // use tenant_id in WHERE clause on every query
  middleware injects tenant_id from session/request

if MULTI_TENANCY_MODE == 'separate_db':
  // route to tenant-specific DB
  // tenant resolved from subdomain or path
  // schema can differ per tenant
```

### Data Models

#### Tenant Table

```
Tenant {
  id:                string (primary key, UUID or nanoid)
  name:              string  // "Acme Corp"
  slug:              string (unique)  // "acme-corp" — used in URLs
  owner_user_id:     string (FK users.user_id)
  plan_id:           string (FK subscription_plans.id) | null
  settings:          JSON object {
    // tenant-level config
    branding_logo_url?: string
    branding_colors?: { primary, secondary }
    webhook_secret_prefix?: string
    api_rate_limit?: integer (requests per hour)
    custom_domain?: string | null
    features_enabled?: array[string]  // 'api_access', 'webhooks', 'team_management'
    // ... more settings as needed
  }
  created_at:        datetime
  updated_at:        datetime
  status:            enum('active', 'suspended', 'cancelled')
  billing_cycle_started_at: datetime | null  // for billing tie-in
}
```

**Indexes:**
- Unique on `slug` — quick lookup by subdomain/path
- FK on `owner_user_id` — find tenants owned by a user
- FK on `plan_id` — find tenants on a plan
- Index on `status` — find active tenants

#### Membership Table

Maps users to tenants with roles.

```
Membership {
  id:                string (primary key)
  tenant_id:         string (FK tenants.id)
  user_id:           string (FK users.user_id)
  role:              enum('owner', 'admin', 'member', 'viewer')
  invited_by:        string | null (FK users.user_id, who invited this user)
  joined_at:         datetime
  created_at:        datetime
  updated_at:        datetime
}
```

**Constraints:**
- Unique on `(tenant_id, user_id)` — user can join a tenant only once

**Indexes:**
- Index on `(tenant_id, role)` — fetch admins/members per tenant
- Index on `(user_id, tenant_id)` — find all tenants a user is in

#### Pending Invitation Table

```
TenantInvitation {
  id:                string (primary key)
  tenant_id:         string (FK tenants.id)
  email:             string (normalized, lowercase)
  role:              enum('owner', 'admin', 'member', 'viewer')
  invited_by:        string (FK users.user_id)
  status:            enum('pending', 'accepted', 'declined', 'expired')
  token:             string (unique, random 32-byte hex for acceptance URL)
  accepted_at:       datetime | null
  expires_at:        datetime  (7 days from creation)
  created_at:        datetime
}
```

**Indexes:**
- Unique on `(tenant_id, email, status='pending')` — prevent duplicate invites
- Index on `token` — lookup by acceptance URL
- Index on `expires_at` — cleanup expired invites

### Tenant Routing

#### Subdomain Strategy (subdomains.example.com)

Route based on subdomain prefix:

```
subdomain = request.host.split('.')[0]

if subdomain == 'www' or subdomain == 'api' or subdomain == app domain:
  // public/landing pages
  no tenant context

else:
  // tenant-specific
  tenant = db.tenants.findOne({ slug: subdomain })
  if not tenant:
    return 404 "Workspace not found"

  // Inject tenant_id into request context
  request.tenant_id = tenant.id
```

#### Path Strategy (/t/slug/...)

Route based on path prefix:

```
if request.pathname starts with '/t/':
  parts = request.pathname.split('/')
  slug = parts[2]  // /t/{slug}/...

  tenant = db.tenants.findOne({ slug })
  if not tenant:
    return 404 "Workspace not found"

  request.tenant_id = tenant.id
  request.pathname = '/' + parts.slice(3).join('/')  // remove /t/slug prefix
```

### Tenant Middleware

Inject `tenant_id` into all authenticated requests:

```pseudocode
function tenantMiddleware(request):
  session = getSession(request)

  // If using path-based routing, extract slug and resolve tenant
  tenant_id = request.tenant_id  // set by routing layer

  if not session:
    // unauthenticated request — set tenant_id but no user_id
    return next()

  if not tenant_id:
    // authenticated but no tenant context
    // this is an API request or SSR route that needs explicit tenant
    // some routes (e.g., /account/settings) are tenant-agnostic
    return next()

  // Verify user is a member of this tenant
  membership = db.memberships.findOne({
    tenant_id: tenant_id,
    user_id: session.user_id
  })

  if not membership:
    return 403 "Access denied"

  // Inject tenant context into request
  request.tenant = {
    id: tenant_id,
    role: membership.role
  }

  return next()
```

### Query Scoping (Shared DB Only)

Every query must include `tenant_id` to prevent cross-tenant data leaks. Use a scoped query helper:

```pseudocode
function scopedQuery(tableName, filters = {}, options = {}):
  // Auto-inject tenant_id into filters
  tenant_id = getCurrentRequest().tenant.id  // from middleware

  if not tenant_id:
    throw Error("No tenant context")

  scoped_filters = { ...filters, tenant_id }

  return db[tableName].find(scoped_filters, options)

// Usage:
users = scopedQuery('users', { role: 'admin' })
// equivalent to: db.users.find({ tenant_id, role: 'admin' })
```

### Tenant Creation

Two paths:

#### Path 1: Auto-Create on Signup

When a new user signs up (completes OTP), create a tenant automatically:

```pseudocode
function onUserSignupComplete(user):
  // Check if user already has a tenant
  existing_tenant = db.tenants.findOne({ owner_user_id: user.user_id })

  if existing_tenant:
    return existing_tenant

  // Auto-create tenant for new user
  tenant = {
    id: nanoid(),
    name: user.display_name + "'s Workspace",
    slug: generateUniqueSlug(user.display_name),
    owner_user_id: user.user_id,
    plan_id: 'free_plan',
    status: 'active',
    settings: {},
    created_at: now
  }

  db.tenants.insertOne(tenant)

  // Create membership as owner
  db.memberships.insertOne({
    id: nanoid(),
    tenant_id: tenant.id,
    user_id: user.user_id,
    role: 'owner',
    joined_at: now,
    created_at: now
  })

  return tenant
```

#### Path 2: Admin Creation

Admin creates a tenant on behalf of an organization:

```
POST /admin/api/tenants

Body: {
  name: string,
  slug: string (unique),
  owner_user_id: string,
  plan_id?: string (default 'free_plan')
}

Validation:
  - slug must match [a-z0-9-]+
  - slug must be unique
  - owner_user_id must exist in users table

Response: { tenant: Tenant }

Side effects:
  - Insert tenant
  - Create membership record (owner role)
  - Log "tenant_created" event
```

### Tenant Suspension

When a tenant is suspended (admin action or billing failure), all access is blocked except billing/account pages:

```pseudocode
function tenantSuspensionMiddleware(request):
  tenant = request.tenant

  if tenant.status == 'suspended':
    // Allow access to:
    // - /billing/* (payment info)
    // - /account/* (contact support)
    // - /logout
    // Block everything else

    allowed_paths = ['/billing', '/account', '/logout']

    if not allowed_paths.some(p => request.pathname.startsWith(p)):
      return 403 {
        error: "Workspace suspended",
        message: "Payment required. Please update billing.",
        action_url: "/billing"
      }

  return next()
```

### Tenant Deletion (Data Retention)

Deletion options (choose one strategy per org):

1. **Hard Delete (GDPR):** Immediately delete all tenant data
2. **Soft Delete (Audit Trail):** Mark as deleted, keep data for 90 days, then archive
3. **Export + Delete:** Export as JSON/CSV, then delete

```pseudocode
async function deleteTenant(tenant_id, strategy = 'soft_delete'):
  tenant = db.tenants.findOne({ id: tenant_id })

  if not tenant:
    throw Error("Tenant not found")

  if strategy == 'hard_delete':
    // Delete all data
    db.memberships.deleteMany({ tenant_id })
    db.tenant_invitations.deleteMany({ tenant_id })
    // Delete all tenant-scoped data tables...
    db.tenants.deleteOne({ id: tenant_id })
    log("tenant_hard_deleted", { tenant_id, at: now })

  else if strategy == 'soft_delete':
    // Mark as deleted, schedule hard delete in 90 days
    db.tenants.updateOne(
      { id: tenant_id },
      { status: 'cancelled', deleted_at: now }
    )
    scheduleJob({
      name: 'hard_delete_tenant',
      run_at: now + 90 days,
      payload: { tenant_id }
    })
    log("tenant_soft_deleted", { tenant_id, at: now })

  // Notify owner
  notifyTenantOwner(tenant.owner_user_id, {
    subject: "Workspace deleted",
    body: "Your workspace has been deleted."
  })
```

---

## Part 2: Demo Account / Sandbox Mode

### Configuration

```
ENV:
  DEMO_ACCOUNT_ENABLED=true|false
  DEMO_ACCOUNT_EMAIL='demo@example.com'
  DEMO_SESSION_TTL='1h' (default: 1 hour)
  DEMO_DATA_RESET_INTERVAL='1h' (auto-reset every 1 hour)
  DEMO_DATA_READ_ONLY=true|false (default: true)
```

### Data Models

#### Demo Session Table

```
DemoSession {
  id:                string (primary key)
  user_id:           string (FK users.user_id, the demo account)
  session_token:     string (unique, random 32-byte hex)
  created_at:        datetime
  expires_at:        datetime (TTL: 1 hour default)
  created_by_ip:     string (for analytics)
}
```

**Indexes:**
- Unique on `session_token` — lookup by token
- TTL on `expires_at` — auto-delete expired demo sessions

#### Demo Account Creation

On first app deployment with `DEMO_ACCOUNT_ENABLED=true`, create the demo account:

```pseudocode
function initializeDemoAccount():
  if not ENV.DEMO_ACCOUNT_ENABLED:
    return

  // Check if demo account already exists
  demo_user = db.users.findOne({ email: ENV.DEMO_ACCOUNT_EMAIL })

  if demo_user:
    return demo_user

  // Create demo user (no password, no OTP history)
  demo_user = {
    user_id: sha256(USER_ID_SEED + ENV.DEMO_ACCOUNT_EMAIL.toLowerCase()),
    email: ENV.DEMO_ACCOUNT_EMAIL,
    display_name: 'Demo Account',
    role: 'user',
    is_demo_account: true,  // flag for internal use
    created_at: now
  }

  db.users.insertOne(demo_user)

  // Create demo tenant
  demo_tenant = {
    id: nanoid(),
    name: 'Demo Workspace',
    slug: 'demo',
    owner_user_id: demo_user.user_id,
    plan_id: 'enterprise_plan',  // full features for demo
    status: 'active',
    settings: {
      is_demo_workspace: true,
      read_only: ENV.DEMO_DATA_READ_ONLY
    },
    created_at: now
  }

  db.tenants.insertOne(demo_tenant)

  // Create membership
  db.memberships.insertOne({
    id: nanoid(),
    tenant_id: demo_tenant.id,
    user_id: demo_user.user_id,
    role: 'owner',
    joined_at: now,
    created_at: now
  })

  return demo_user
```

### Demo Data Seeding

Create a seed script to populate demo workspace with example data:

```pseudocode
async function seedDemoData(demo_tenant_id):
  tenant_id = demo_tenant_id

  // Seed example data relevant to your app
  // Examples:

  // Products/Services
  db.products.insertMany([
    {
      tenant_id,
      id: nanoid(),
      name: 'Starter Plan',
      price: 29,
      created_at: now
    },
    {
      tenant_id,
      id: nanoid(),
      name: 'Professional Plan',
      price: 99,
      created_at: now
    }
  ])

  // Customers
  db.customers.insertMany([
    {
      tenant_id,
      id: nanoid(),
      name: 'Acme Corp',
      email: 'contact@acme.com',
      created_at: now
    }
  ])

  // Other relevant data...

  log('demo_data_seeded', { tenant_id, at: now })
```

Run this on app init if demo data is missing:

```pseudocode
function initApp():
  if ENV.DEMO_ACCOUNT_ENABLED:
    demo_user = initializeDemoAccount()
    demo_data_exists = db.products.findOne({
      tenant_id: demo_user.tenant_id
    })

    if not demo_data_exists:
      await seedDemoData(demo_user.tenant_id)
```

### Demo Login Flow

On landing/login page, show "Try Demo" button:

```
[Login Page]

[Email input] [Send OTP button]

OR

[Try Demo button] → calls POST /api/demo/start-session
```

#### API: `POST /api/demo/start-session`

No auth required.

**Request:**
```
{} (empty body)
```

**Response:**
```
{
  demo_session: {
    session_token: string,
    expires_at: datetime
  },
  user: {
    user_id: string,
    email: string,
    display_name: string
  },
  tenant: {
    id: string,
    name: string,
    slug: string
  }
}
```

**Process:**
1. Check `DEMO_ACCOUNT_ENABLED` — if false, return 400
2. Fetch demo user/tenant
3. Create demo session record with TTL
4. Return session token (client stores in cookie similar to normal auth)
5. Set demo-specific cookie flag (for analytics)

```pseudocode
function postDemoStartSession(request):
  if not ENV.DEMO_ACCOUNT_ENABLED:
    return 400 { error: "Demo is disabled" }

  demo_user = db.users.findOne({ is_demo_account: true })

  if not demo_user:
    return 500 { error: "Demo account not configured" }

  // Create ephemeral demo session
  demo_session = {
    id: nanoid(),
    user_id: demo_user.user_id,
    session_token: randomHex(32),
    created_at: now,
    expires_at: now + parseTTL(ENV.DEMO_SESSION_TTL),
    created_by_ip: request.clientIp
  }

  db.demo_sessions.insertOne(demo_session)

  // Set session cookie with demo flag
  setSessionCookie(
    demo_session.session_token,
    { is_demo_session: true }
  )

  demo_tenant = db.tenants.findOne({ owner_user_id: demo_user.user_id })

  return {
    demo_session,
    user: demo_user,
    tenant: demo_tenant
  }
```

### Demo Session Validation

Auth middleware must check for demo sessions:

```pseudocode
function getSession(request):
  session_token = getSessionCookie(request)

  if not session_token:
    return null

  // Check normal sessions first
  session = db.sessions.findOne({ session_token })

  if session and session.status == 'active':
    return makeAuthSession(session, request)

  // Check demo sessions
  demo_session = db.demo_sessions.findOne({ session_token })

  if demo_session and demo_session.expires_at > now:
    user = db.users.findOne({ user_id: demo_session.user_id })
    return makeAuthSession({
      user_id: user.user_id,
      email: user.email,
      display_name: user.display_name,
      is_demo_session: true
    }, request)

  // Session expired or not found
  return null
```

### Demo Mode Restrictions

Enforce read-only and feature restrictions during demo:

```pseudocode
function enforceDemo(request):
  session = getSession(request)

  if not session or not session.is_demo_session:
    return next()

  // Blocked operations during demo
  blocked_routes = [
    '/api/billing/*',      // no payment
    '/api/auth/logout',    // can't log out (to reset, create new session)
    '/api/account/*',      // no account changes
    '/api/export/*',       // no data export
    '/api/webhooks/*',     // no webhooks
    '/api/api-keys/*',     // no API keys
  ]

  if blocked_routes.some(pattern => matches(request.pathname, pattern)):
    return 403 {
      error: "Not available in demo mode",
      message: "Sign up to unlock this feature"
    }

  // Read-only enforcement
  if ENV.DEMO_DATA_READ_ONLY:
    if request.method in ['POST', 'PATCH', 'DELETE', 'PUT']:
      return 403 {
        error: "Read-only in demo mode",
        action: "Sign up to create and edit data"
      }

  return next()
```

### Demo Data Cleanup

Periodically reset demo data to keep it fresh:

```pseudocode
// Scheduled job (runs every 1 hour, configurable)
async function resetDemoData():
  if not ENV.DEMO_ACCOUNT_ENABLED:
    return

  demo_user = db.users.findOne({ is_demo_account: true })
  demo_tenant = db.tenants.findOne({ owner_user_id: demo_user.user_id })

  // Delete all demo sessions
  db.demo_sessions.deleteMany({ expires_at < now })

  // Reset all tenant-scoped data (products, customers, etc.)
  // This depends on your app's data model
  tablesUsingTenantId = [
    'products', 'customers', 'orders', 'invoices', ...
  ]

  for table in tablesUsingTenantId:
    db[table].deleteMany({ tenant_id: demo_tenant.id })

  // Re-seed fresh demo data
  await seedDemoData(demo_tenant.id)

  log('demo_data_reset', { tenant_id: demo_tenant.id, at: now })
```

### Demo Analytics

Track demo-to-signup conversion:

```pseudocode
// When demo session created
event('demo_session_started', {
  source: request.referrer,
  ip: request.clientIp,
  timestamp: now
})

// When demo user signs up
event('demo_to_signup', {
  user_id: new_user_id,
  demo_session_duration: now - demo_session.created_at,
  timestamp: now
})
```

### Demo UI Banner

Show banner during demo mode:

```
[Page content]

[Banner at top of page]:
  "You're in demo mode. Sign up to save your work."
  [Sign up button]
  [Dismiss button]
```

---

## Part 3: Team Management

### Team Membership (Builds on Multi-Tenancy)

Membership model already defined above. This section adds UI/API for managing members.

### Role Permissions Matrix

| Role | Create Data | Edit Data | Delete Data | Manage Members | Manage Billing | View Reports |
|------|---|---|---|---|---|---|
| Owner | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Admin | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ |
| Member | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ |
| Viewer | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |

Enforce permissions server-side:

```pseudocode
function requireRole(request, allowedRoles: array):
  session = requireSession(request)
  membership = request.tenant  // injected by middleware

  if not allowedRoles.includes(membership.role):
    return 403 { error: "Insufficient permissions" }

  return next()

// Usage:
POST /api/workspace/members/:user_id/promote:
  requireRole(request, ['owner', 'admin'])
  // ...
```

### API Routes

#### `GET /api/workspace/members`

List all members in current workspace.

**Response:**
```
{
  members: [
    {
      user_id: string,
      email: string,
      display_name: string,
      role: 'owner' | 'admin' | 'member' | 'viewer',
      joined_at: datetime,
      last_active_at: datetime | null
    }
  ]
}
```

#### `POST /api/workspace/members/invite`

Invite a user by email.

**Request:**
```
{
  email: string,
  role: 'admin' | 'member' | 'viewer'
}
```

**Validation:**
- Email must be valid and normalized (lowercase)
- Cannot re-invite if already a member
- Cannot re-invite if pending invite exists (offer to resend)
- Seat limit check (if on a plan with seat limits, ensure count < limit)

**Response:**
```
{
  invitation: {
    id: string,
    email: string,
    role: string,
    status: 'pending',
    token: string,
    expires_at: datetime,
    acceptance_url: string
  }
}
```

**Process:**
1. Validate email
2. Check if already a member
3. Check seat limit
4. Create invitation record with random `token`
5. Send invitation email with acceptance URL: `https://app.com/join?token={token}`
6. Return invitation

```pseudocode
function postInviteMember(request):
  requireRole(request, ['owner', 'admin'])

  body = parseJson(request.body)
  email = body.email.toLowerCase().trim()
  role = body.role

  validateEmail(email)
  validateRole(role)

  tenant_id = request.tenant.id

  // Check if already a member
  existing = db.memberships.findOne({ tenant_id, user_id: hashEmail(email) })
  if existing:
    return 400 { error: "User already in workspace" }

  // Check pending invites
  pending_invite = db.tenant_invitations.findOne({
    tenant_id,
    email,
    status: 'pending'
  })
  if pending_invite:
    return 400 {
      error: "Invitation already sent",
      invitation: pending_invite
    }

  // Check seat limit
  plan = db.subscription_plans.findOne({ id: tenant.plan_id })
  if plan.seat_limit:
    member_count = db.memberships.count({ tenant_id })
    if member_count >= plan.seat_limit:
      return 402 {
        error: "Seat limit reached",
        message: "Upgrade your plan to add more team members"
      }

  // Create invitation
  invitation = {
    id: nanoid(),
    tenant_id,
    email,
    role,
    invited_by: request.session.user_id,
    status: 'pending',
    token: randomHex(32),
    expires_at: now + 7 days,
    created_at: now
  }

  db.tenant_invitations.insertOne(invitation)

  // Send email
  sendEmail({
    to: email,
    template: 'team_invitation',
    data: {
      invited_by: request.session.display_name,
      workspace_name: request.tenant.name,
      acceptance_url: `https://${request.host}/join?token=${invitation.token}`,
      expires_at: invitation.expires_at
    }
  })

  return { invitation }
```

#### `GET /api/workspace/invitations`

List pending invitations (owner/admin only).

**Response:**
```
{
  invitations: [
    {
      id: string,
      email: string,
      role: string,
      status: 'pending' | 'accepted' | 'declined' | 'expired',
      invited_by: string,
      created_at: datetime,
      expires_at: datetime
    }
  ]
}
```

#### `POST /api/workspace/invitations/:id/resend`

Resend invitation email.

**Response:**
```
{
  ok: true
}
```

**Side effects:**
- Update `updated_at` on invitation
- Resend email

#### `POST /api/workspace/invitations/:id/revoke`

Cancel an invitation.

**Request:**
```
{} (empty)
```

**Response:**
```
{
  status: 'revoked'
}
```

**Side effects:**
- Set invitation `status = 'revoked'`
- Delete corresponding pending membership if it exists

#### `POST /api/join` (Public, Unauthenticated)

Accept an invitation. User must have already verified their email via OTP.

**Request:**
```
{
  token: string
}
```

**Process:**
1. Look up invitation by token
2. Check not expired
3. Check token status is 'pending'
4. User must be authenticated (have a session)
5. Check user email matches invitation email (once OTP is verified, email is in session)
6. Create membership record
7. Update invitation status to 'accepted'

**Response:**
```
{
  membership: {
    tenant_id: string,
    user_id: string,
    role: string,
    joined_at: datetime
  },
  tenant: {
    id: string,
    name: string,
    slug: string
  }
}
```

```pseudocode
function postJoin(request):
  session = requireSession(request)  // user must be authenticated

  body = parseJson(request.body)
  token = body.token

  invitation = db.tenant_invitations.findOne({ token, status: 'pending' })

  if not invitation:
    return 400 { error: "Invalid or expired token" }

  if invitation.expires_at < now:
    db.tenant_invitations.updateOne(
      { id: invitation.id },
      { status: 'expired' }
    )
    return 400 { error: "Invitation expired" }

  // Check email matches
  if session.email != invitation.email:
    return 400 {
      error: "Email mismatch",
      message: "You must be logged in as " + invitation.email
    }

  tenant_id = invitation.tenant_id
  user_id = session.user_id

  // Check if already a member
  existing = db.memberships.findOne({ tenant_id, user_id })
  if existing:
    return 400 { error: "Already a member of this workspace" }

  // Create membership
  membership = {
    id: nanoid(),
    tenant_id,
    user_id,
    role: invitation.role,
    invited_by: invitation.invited_by,
    joined_at: now,
    created_at: now
  }

  db.memberships.insertOne(membership)

  // Update invitation
  db.tenant_invitations.updateOne(
    { id: invitation.id },
    { status: 'accepted', accepted_at: now }
  )

  tenant = db.tenants.findOne({ id: tenant_id })

  log('team_member_joined', { tenant_id, user_id, at: now })

  return { membership, tenant }
```

#### `PATCH /api/workspace/members/:user_id/role`

Change a member's role.

**Request:**
```
{
  role: 'admin' | 'member' | 'viewer'
}
```

**Validation:**
- Only owner/admin can change roles
- Cannot downgrade last owner

**Response:**
```
{
  membership: { ... }
}
```

#### `DELETE /api/workspace/members/:user_id`

Remove a member from the workspace.

**Validation:**
- Only owner/admin can remove members
- Cannot remove yourself (must transfer ownership first)
- Cannot remove last owner

**Response:**
```
{
  status: 'removed'
}
```

**Side effects:**
- Delete membership record
- Revoke API keys owned by this user (if applicable)
- Log removal event

#### `POST /api/workspace/transfer-ownership`

Transfer ownership to another member.

**Request:**
```
{
  new_owner_user_id: string
}
```

**Validation:**
- Only current owner can transfer
- New owner must be an existing member
- New owner must have role 'admin' or higher

**Process:**
1. Update old owner: role = 'admin'
2. Update new owner: role = 'owner'
3. Update tenant: `owner_user_id = new_owner_user_id`

**Response:**
```
{
  ok: true,
  tenant: {
    owner_user_id: string
  }
}
```

---

## Part 4: Workspace Switcher

### UI Component

Add a dropdown in app header (top-left or top-right):

```
[Current Workspace Name ▼]

Dropdown menu:
  Acme Corp (current) ✓
  Beta Corp
  My Startup
  ─────────────────────
  + Create new workspace
```

### Data Requirement

When user logs in, fetch all workspaces they're a member of:

```
function useWorkspaces():
  workspaces = fetchAllTenants(session.user_id)  // tenants where user is a member
  return workspaces
```

### Workspace Persistence

Store last-used workspace per user:

```
// When user navigates to a workspace, update preference
function setLastWorkspace(user_id, tenant_id):
  db.user_preferences.updateOne(
    { user_id },
    { last_tenant_id: tenant_id },
    { upsert: true }
  )

// On app load, redirect to last workspace if accessible
function getDefaultWorkspace(user_id):
  pref = db.user_preferences.findOne({ user_id })
  if pref and pref.last_tenant_id:
    membership = db.memberships.findOne({
      user_id,
      tenant_id: pref.last_tenant_id
    })
    if membership:
      return membership.tenant_id

  // Fallback: first workspace user is a member of
  first_membership = db.memberships.findOne({ user_id })
  return first_membership?.tenant_id
```

### API: `GET /api/workspaces`

Fetch all workspaces for authenticated user (with last-used info).

**Response:**
```
{
  workspaces: [
    {
      id: string,
      name: string,
      slug: string,
      role: string,
      plan_id: string,
      created_at: datetime
    }
  ],
  current_workspace_id: string (currently active)
  last_used_workspace_id: string | null
}
```

**Implementation:**
```pseudocode
function getWorkspaces(request):
  session = requireSession(request)

  memberships = db.memberships.find({ user_id: session.user_id })

  tenants = memberships.map(m => db.tenants.findOne({ id: m.tenant_id }))

  user_pref = db.user_preferences.findOne({ user_id: session.user_id })

  return {
    workspaces: tenants.map(t => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      role: memberships.find(m => m.tenant_id == t.id).role,
      plan_id: t.plan_id,
      created_at: t.created_at
    })),
    current_workspace_id: request.tenant.id,  // from middleware
    last_used_workspace_id: user_pref?.last_tenant_id
  }
```

### Workspace Switching

When user clicks a different workspace in the dropdown, navigate to that workspace:

```
// Client-side pseudocode
function switchWorkspace(workspace_id):
  tenant = workspaces.find(w => w.id == workspace_id)

  // Save preference
  await api.post('/api/workspace/set-last-used', { tenant_id: workspace_id })

  // Navigate to workspace
  if using subdomain-based routing:
    window.location = `https://${tenant.slug}.example.com/dashboard`

  else if using path-based routing:
    window.location = `/t/${tenant.slug}/dashboard`
```

### API: `POST /api/workspace/set-last-used`

Update last-used workspace preference.

**Request:**
```
{
  tenant_id: string
}
```

**Validation:**
- User must be a member of the tenant

**Response:**
```
{
  ok: true
}
```

### Create New Workspace

"Create new workspace" option in dropdown:

```
function createWorkspace():
  navigate to /workspace/create

// Modal or page:
Form:
  Workspace Name: [input]
  Workspace URL/Slug: [input] (auto-generated from name, editable)
  [Create button]

Validation:
  - Name required
  - Slug unique
  - Slug matches [a-z0-9-]+
```

#### `POST /api/workspace/create`

Create a new workspace.

**Request:**
```
{
  name: string,
  slug: string
}
```

**Response:**
```
{
  tenant: {
    id: string,
    name: string,
    slug: string
  }
}
```

**Process:**
1. Validate slug uniqueness
2. Create tenant (owner = current user)
3. Create membership (owner)
4. Switch to new workspace

---

## Part 5: API Key Management

### Data Model

```
ApiKey {
  id:               string (primary key, UUID)
  tenant_id:        string (FK tenants.id)
  name:             string  // user-friendly name (e.g., "Production API Key")
  key_hash:         string  // sha256(random_secret), never expose
  prefix:           string  // first 8 chars of key, for identification
  // e.g., if key = "sk_live_abcd1234efgh5678...", prefix = "sk_live_abcd"

  permissions:      JSON array [
    // scopes, e.g.:
    'read:products',
    'read:customers',
    'write:orders',
    'admin:*'  // wildcard for all permissions
  ]

  created_by:       string (FK users.user_id)
  created_at:       datetime

  last_used_at:     datetime | null
  expires_at:       datetime | null  // optional key expiry

  rate_limit:       integer | null   // requests per hour (null = no limit)

  revoked:          boolean (default: false)
  revoked_at:       datetime | null
}
```

**Indexes:**
- Index on `tenant_id` — list keys per tenant
- Unique on `key_hash` — validate key on auth
- Index on `prefix` — identify key in logs

### Key Generation

Generate keys with a human-readable prefix:

```pseudocode
function generateApiKey(tenant_id, prefix = 'sk'):
  // Format: {prefix}_{environment}_{random_base64}
  secret = randomBytes(32)  // 256 bits

  env = getEnvironment()  // 'test' or 'live'

  key = `${prefix}_${env}_${base64url(secret)}`

  key_hash = sha256(key)

  key_prefix = key.substring(0, 12)  // e.g., "sk_live_abcd"

  return { key, key_hash, key_prefix }
```

Example keys:
- `sk_live_abc123def456ghi789...` (64+ chars)
- `sk_test_xyz987uvw654tsr321...`

### API Routes

#### `GET /api/api-keys`

List all API keys for current tenant.

**Response:**
```
{
  keys: [
    {
      id: string,
      name: string,
      prefix: string,  // e.g., "sk_live_abcd", never full key
      permissions: array,
      created_at: datetime,
      last_used_at: datetime | null,
      expires_at: datetime | null,
      revoked: boolean
    }
  ]
}
```

#### `POST /api/api-keys`

Create a new API key.

**Request:**
```
{
  name: string,
  permissions: array[string],  // e.g., ['read:products', 'write:orders']
  expires_at?: datetime,
  rate_limit?: integer
}
```

**Validation:**
- Name required and unique per tenant
- Permissions must be valid scopes
- expires_at must be in future if provided

**Response:**
```
{
  key: {
    id: string,
    name: string,
    key: string,  // ONLY SHOWN ONCE, customer must copy/save
    prefix: string,
    permissions: array,
    created_at: datetime
  }
}
```

**Important:** Show the full `key` only once at creation. On subsequent GETs, only return the prefix.

```pseudocode
function postCreateApiKey(request):
  requireRole(request, ['owner', 'admin'])

  body = parseJson(request.body)
  tenant_id = request.tenant.id

  validateName(body.name)
  validatePermissions(body.permissions)

  // Check name uniqueness
  existing = db.api_keys.findOne({
    tenant_id,
    name: body.name,
    revoked: false
  })
  if existing:
    return 400 { error: "Key name already in use" }

  // Generate key
  { key, key_hash, key_prefix } = generateApiKey(tenant_id, 'sk')

  api_key = {
    id: nanoid(),
    tenant_id,
    name: body.name,
    key_hash,
    prefix: key_prefix,
    permissions: body.permissions,
    created_by: request.session.user_id,
    created_at: now,
    expires_at: body.expires_at || null,
    rate_limit: body.rate_limit || null,
    revoked: false
  }

  db.api_keys.insertOne(api_key)

  log('api_key_created', { tenant_id, key_id: api_key.id, at: now })

  return {
    key: {
      id: api_key.id,
      name: api_key.name,
      key,  // full key shown ONCE
      prefix: key_prefix,
      permissions: api_key.permissions,
      created_at: api_key.created_at
    }
  }
```

#### `PATCH /api/api-keys/:key_id`

Update API key metadata (name, permissions, rate limit, expiry). Cannot change the actual secret.

**Request:**
```
{
  name?: string,
  permissions?: array,
  rate_limit?: integer,
  expires_at?: datetime
}
```

**Response:**
```
{
  key: { ... (same as GET) }
}
```

#### `DELETE /api/api-keys/:key_id`

Revoke an API key (soft delete).

**Response:**
```
{
  status: 'revoked'
}
```

**Side effects:**
- Set `revoked = true`, `revoked_at = now`
- Immediately block auth with this key
- Log revocation event

### API Authentication

Requests to `/api/*` routes can authenticate with an API key instead of a session:

```pseudocode
function getSession(request):
  // Check session cookie first
  session = getSessionFromCookie(request)
  if session:
    return session

  // Check Authorization header
  auth_header = request.headers['Authorization']

  if auth_header starts with 'Bearer ':
    token = auth_header.substring(7)  // "Bearer {token}"

    // Check if it's a session token
    session = db.sessions.findOne({ session_token: token })
    if session and session.status == 'active':
      return makeAuthSession(session)

    // Check if it's an API key
    api_key = validateApiKey(token, request)
    if api_key:
      return makeApiKeySession(api_key)

  return null

function validateApiKey(key, request):
  key_hash = sha256(key)

  api_key = db.api_keys.findOne({
    key_hash,
    revoked: false
  })

  if not api_key:
    return null

  // Check expiry
  if api_key.expires_at and api_key.expires_at < now:
    return null

  // Check rate limit
  usage = db.api_key_usage.findOne({
    key_id: api_key.id,
    hour: currentHour()
  })

  if api_key.rate_limit and usage.count >= api_key.rate_limit:
    throw Error("Rate limit exceeded", { status: 429 })

  // Update last used
  db.api_keys.updateOne(
    { id: api_key.id },
    { last_used_at: now }
  )

  // Increment usage
  db.api_key_usage.updateOne(
    { key_id: api_key.id, hour: currentHour() },
    { $inc: { count: 1 } },
    { upsert: true }
  )

  // Validate tenant_id matches request
  if api_key.tenant_id != request.tenant.id:
    throw Error("Key does not belong to this tenant")

  return api_key

function makeApiKeySession(api_key):
  return {
    user_id: null,  // API keys are not user-specific
    email: null,
    is_api_key: true,
    tenant_id: api_key.tenant_id,
    permissions: api_key.permissions
  }
```

### Permission Checking

For API key sessions, check permissions before allowing the action:

```pseudocode
function requirePermission(request, required_permission):
  session = getSession(request)

  if not session:
    return 401 "Unauthenticated"

  // User sessions (email + password) have full access
  if session.user_id:
    return next()

  // API key sessions: check permissions
  if session.is_api_key:
    if hasPermission(session.permissions, required_permission):
      return next()
    else:
      return 403 "Insufficient permissions"

  return 401

function hasPermission(permissions: array, required: string):
  // Exact match
  if permissions.includes(required):
    return true

  // Wildcard match
  // 'admin:*' grants all 'admin:...' permissions
  // '*' grants all permissions
  if permissions.includes('*'):
    return true

  for perm in permissions:
    if perm.endsWith(':*'):
      resource = perm.substring(0, perm.length - 2)  // remove ':*'
      required_resource = required.split(':')[0]
      if required_resource == resource:
        return true

  return false

// Usage in route handlers:
POST /api/products:
  requirePermission(request, 'write:products')
  // ...

GET /api/products:
  requirePermission(request, 'read:products')
  // ...
```

### Rate Limiting

Track API key usage by hour:

```
// Table: api_key_usage
{
  key_id: string,
  hour: datetime (e.g., 2025-06-15 14:00),
  count: integer,
  created_at: datetime
}

// Index: (key_id, hour) unique
// TTL: auto-delete after 30 days
```

### Usage Tracking

Log API key usage for analytics and debugging:

```
// Table: api_key_logs
{
  id: string,
  key_id: string,
  tenant_id: string,
  method: string,
  path: string,
  status_code: integer,
  response_time_ms: integer,
  created_at: datetime
}

// Index: (key_id, created_at) for quick lookups
// TTL: auto-delete after 90 days
```

### Admin UI

Show API keys management page at `/admin/api-keys` or `/workspace/settings/api-keys`:

```
[Page: API Keys]

[Create API Key button]

[Keys table]:
  Name           | Prefix        | Permissions       | Last Used   | Created
  Prod Server    | sk_live_abc123| read:*, write:*   | 2 min ago   | Jun 15
  Mobile App     | sk_live_def456| read:products     | 5 days ago  | Jun 10
  [Copy] [Rotate] [Revoke]

[Click row to see full permissions]
```

---

## Part 6: Webhook System (Outbound)

### Overview

Tenants can register webhook URLs to receive real-time notifications when events occur in their workspace.

Example use cases:
- Notify external system when order is created
- Sync customer data to CRM
- Trigger custom workflows

### Data Models

#### Webhook Subscription

```
WebhookSubscription {
  id:              string (primary key)
  tenant_id:       string (FK tenants.id)
  url:             string  // e.g., https://example.com/webhooks/orders

  events:          array[string]  // e.g., ['order.created', 'order.updated', 'customer.deleted']

  secret:          string (random 32-byte hex, used to sign payloads)
  active:          boolean (default: true)

  created_by:      string (FK users.user_id)
  created_at:      datetime
  updated_at:      datetime
}
```

**Indexes:**
- Index on `tenant_id` — list webhooks per tenant
- Index on `active` — only dispatch to active webhooks

#### Webhook Delivery Log

```
WebhookDelivery {
  id:              string (primary key)
  subscription_id: string (FK webhook_subscriptions.id)
  event_type:      string  // e.g., 'order.created'
  payload:         JSON object  // the event data

  // HTTP details
  request_body:    string (full request body sent)
  request_headers: JSON object

  response_status: integer | null  // HTTP status code
  response_body:   string | null
  response_time_ms: integer | null

  // Retry tracking
  attempt:         integer (1, 2, 3, ..., max 5)
  next_retry_at:   datetime | null

  delivered_at:    datetime | null  // when successfully delivered
  failed_at:       datetime | null

  created_at:      datetime
}
```

**Indexes:**
- Index on `subscription_id` — view delivery history
- Index on `(subscription_id, created_at)` — fetch deliveries for a subscription
- Index on `created_at` — for cleanup
- Index on `event_type` — filter by event type

### Event System

Define what events can trigger webhooks. Example events (app-specific):

```
Event Types:
  - order.created
  - order.updated
  - order.deleted
  - payment.received
  - customer.created
  - customer.updated
  - invoice.issued
  - ... (more per app)
```

Structure to dispatch events:

```pseudocode
async function dispatchEvent(tenant_id, event_type, payload):
  // Find all active webhook subscriptions for this tenant
  webhooks = db.webhook_subscriptions.find({
    tenant_id,
    active: true,
    events: { $in: [event_type] }  // subscription includes this event type
  })

  if not webhooks or webhooks.length == 0:
    return  // no webhooks configured

  for webhook in webhooks:
    // Create delivery record
    delivery = {
      id: nanoid(),
      subscription_id: webhook.id,
      event_type,
      payload,
      attempt: 1,
      created_at: now,
      next_retry_at: now  // deliver immediately
    }

    db.webhook_deliveries.insertOne(delivery)

    // Queue delivery (async job)
    queueJob({
      type: 'deliver_webhook',
      delivery_id: delivery.id,
      priority: 'high'
    })
```

### Delivery Worker

A background job that processes webhook deliveries:

```pseudocode
async function deliverWebhook(delivery_id):
  delivery = db.webhook_deliveries.findOne({ id: delivery_id })

  if not delivery:
    return  // delivery already processed

  webhook = db.webhook_subscriptions.findOne({
    id: delivery.subscription_id
  })

  if not webhook or not webhook.active:
    db.webhook_deliveries.updateOne(
      { id: delivery_id },
      { failed_at: now, response_status: 0 }
    )
    return

  // Prepare request
  request_body = JSON.stringify({
    id: delivery.id,
    event: delivery.event_type,
    timestamp: now,
    data: delivery.payload
  })

  // Sign payload
  signature = hmacSha256(request_body, webhook.secret)

  request_headers = {
    'Content-Type': 'application/json',
    'X-Webhook-ID': delivery.id,
    'X-Webhook-Signature': 'sha256=' + signature,
    'X-Webhook-Timestamp': now
  }

  try:
    startTime = now
    response = await httpPost(webhook.url, {
      body: request_body,
      headers: request_headers,
      timeout: 10_seconds,
      followRedirects: false
    })

    responseTime = now - startTime

    if response.status >= 200 and response.status < 300:
      // Success
      db.webhook_deliveries.updateOne(
        { id: delivery_id },
        {
          response_status: response.status,
          response_body: response.body,
          response_time_ms: responseTime,
          delivered_at: now
        }
      )

      // Update webhook last_successful_delivery
      db.webhook_subscriptions.updateOne(
        { id: webhook.id },
        { last_successful_delivery_at: now }
      )

      log('webhook_delivered', {
        subscription_id: webhook.id,
        event_type: delivery.event_type,
        status: response.status
      })

    else:
      // Client error (4xx) — don't retry
      if response.status >= 400 and response.status < 500:
        db.webhook_deliveries.updateOne(
          { id: delivery_id },
          {
            response_status: response.status,
            response_body: response.body,
            response_time_ms: responseTime,
            failed_at: now
          }
        )

        // Notify webhook owner of failure
        notifyWebhookFailure(webhook, delivery, response.status)

        log('webhook_client_error', {
          subscription_id: webhook.id,
          status: response.status
        })

      else:
        // Server error (5xx) or timeout — retry with backoff
        scheduleRetry(delivery)

  catch error:
    // Network error, timeout, connection refused — retry
    scheduleRetry(delivery)

function scheduleRetry(delivery):
  attempt = delivery.attempt + 1

  if attempt > 5:
    // Max retries exceeded
    db.webhook_deliveries.updateOne(
      { id: delivery.id },
      { failed_at: now }
    )

    log('webhook_max_retries_exceeded', { delivery_id: delivery.id })
    return

  // Exponential backoff: 1min, 5min, 30min, 2hr, 24hr
  backoff_minutes = [1, 5, 30, 120, 1440][attempt - 1]
  next_retry = now + backoff_minutes * 60 * 1000

  db.webhook_deliveries.updateOne(
    { id: delivery.id },
    {
      attempt: attempt,
      next_retry_at: next_retry
    }
  )

  // Re-queue job for next retry
  queueJob({
    type: 'deliver_webhook',
    delivery_id: delivery.id,
    run_at: next_retry
  })
```

### HMAC Signature Verification

Clients verify webhook authenticity using HMAC-SHA256:

```pseudocode
function verifyWebhookSignature(request, secret):
  signature = request.headers['X-Webhook-Signature']

  if not signature:
    return false

  // Expected format: "sha256={hash}"
  parts = signature.split('=')
  if parts[0] != 'sha256':
    return false

  expected_hash = parts[1]

  // Recompute hash
  request_body = request.rawBody  // unserialized body
  computed_hash = hmacSha256(request_body, secret)

  // Constant-time comparison to prevent timing attacks
  return constantTimeEquals(computed_hash, expected_hash)
```

### API Routes

#### `GET /api/workspace/webhooks`

List all webhook subscriptions for current workspace.

**Response:**
```
{
  webhooks: [
    {
      id: string,
      url: string,
      events: array,
      active: boolean,
      created_at: datetime,
      last_successful_delivery_at: datetime | null,
      last_failed_delivery_at: datetime | null
    }
  ]
}
```

#### `POST /api/workspace/webhooks`

Create a new webhook subscription.

**Request:**
```
{
  url: string,  // must be https://
  events: array[string]  // e.g., ['order.created', 'order.updated']
}
```

**Validation:**
- URL must be https (no http for security)
- URL must be valid
- Events must be known event types
- URL must not be localhost

**Response:**
```
{
  webhook: {
    id: string,
    url: string,
    events: array,
    secret: string,  // SHOWN ONCE, customer must save
    test_url: string  // for testing (see below)
  }
}
```

```pseudocode
function postCreateWebhook(request):
  requireRole(request, ['owner', 'admin'])

  body = parseJson(request.body)
  tenant_id = request.tenant.id

  validateUrl(body.url)
  validateEvents(body.events)

  // Check max webhook count (e.g., limit to 10 per workspace)
  count = db.webhook_subscriptions.count({ tenant_id })
  if count >= 10:
    return 400 { error: "Max webhooks per workspace is 10" }

  secret = randomHex(32)

  webhook = {
    id: nanoid(),
    tenant_id,
    url: body.url,
    events: body.events,
    secret,
    active: true,
    created_by: request.session.user_id,
    created_at: now,
    updated_at: now
  }

  db.webhook_subscriptions.insertOne(webhook)

  log('webhook_created', { tenant_id, webhook_id: webhook.id })

  return {
    webhook: {
      id: webhook.id,
      url: webhook.url,
      events: webhook.events,
      secret,  // shown ONCE
      test_url: `https://app.com/workspace/webhooks/${webhook.id}/test`
    }
  }
```

#### `PATCH /api/workspace/webhooks/:webhook_id`

Update webhook (URL, events, active status).

**Request:**
```
{
  url?: string,
  events?: array,
  active?: boolean
}
```

**Response:**
```
{
  webhook: { ... }
}
```

#### `DELETE /api/workspace/webhooks/:webhook_id`

Delete a webhook subscription.

**Response:**
```
{
  status: 'deleted'
}
```

**Side effects:**
- Delete subscription record
- Keep delivery logs for audit trail

#### `GET /api/workspace/webhooks/:webhook_id/deliveries`

View delivery history for a webhook.

**Query params:**
- `limit`: default 20
- `offset`: default 0
- `status`: 'pending' | 'delivered' | 'failed' (optional filter)

**Response:**
```
{
  deliveries: [
    {
      id: string,
      event_type: string,
      response_status: integer | null,
      attempt: integer,
      delivered_at: datetime | null,
      created_at: datetime
    }
  ],
  total: integer
}
```

#### `POST /api/workspace/webhooks/:webhook_id/test`

Send a test webhook to verify endpoint is working.

**Request:**
```
{} (empty)
```

**Process:**
1. Create a synthetic test event
2. Dispatch it as a normal webhook
3. Return immediately (delivery happens async)

**Response:**
```
{
  delivery_id: string,
  message: "Test webhook sent. You should receive it shortly."
}
```

### Webhook UI

Admin panel at `/workspace/settings/webhooks`:

```
[Page: Webhooks]

[Create Webhook button]

[Webhooks table]:
  URL                          | Events         | Status | Last Delivery
  https://example.com/webhooks | order.created  | Active | 2 min ago
  https://other.com/hook       | customer.*     | Active | 5 days ago
  https://broken.com/hook      | payment.*      | Error  | Failed 3x

  [Click row for details]
  [Edit] [Test] [Logs] [Disable]

[Webhook Details Panel]:
  URL: https://example.com/webhooks
  Events: [dropdown checkboxes]
    ☐ order.created
    ☑ order.updated
    ☐ order.deleted
    ☑ customer.created

  Status: Active / Disabled
  Last Successful: Jun 15, 2:30 PM
  Last Failed: Never

  [Edit] [Test Endpoint] [Delete] [View Logs]

[Delivery Logs]:
  Timestamp    | Event     | Status | Response Time | Details
  2 min ago    | order.upd | 200    | 45ms          | [View]
  5 min ago    | order.upd | 200    | 52ms          | [View]
  ...

  [Retry Failed] [Clear Logs]
```

### Failure Alerts

When a webhook fails repeatedly, notify the workspace admin:

```pseudocode
function notifyWebhookFailure(webhook, delivery, status):
  tenant = db.tenants.findOne({ id: webhook.tenant_id })
  owner = db.users.findOne({ user_id: tenant.owner_user_id })

  // Send after 3 consecutive failures
  failed_count = db.webhook_deliveries.count({
    subscription_id: webhook.id,
    failed_at: { $ne: null },
    attempt: 5  // last attempt
  })

  if failed_count % 3 == 0:  // every 3rd failure
    sendEmail({
      to: owner.email,
      template: 'webhook_failure_alert',
      data: {
        webhook_url: webhook.url,
        event_type: delivery.event_type,
        status: status,
        action_url: `https://app.com/workspace/webhooks/${webhook.id}`
      }
    })
```

### Scheduled Cleanup

Periodically clean up old webhook logs:

```pseudocode
// Scheduled job (daily)
function cleanupOldWebhookLogs():
  cutoff_date = now - 90 days

  db.webhook_deliveries.deleteMany({
    created_at: { $lt: cutoff_date },
    delivered_at: { $ne: null }  // only delete successful deliveries
  })

  log('webhook_logs_cleanup', { deleted_count: result.deletedCount })
```

---

## Security Considerations

### Tenant Isolation (Critical)

- **Shared DB:** Every query MUST filter by `tenant_id`. Missing the filter is a data leak.
- **Query Scope Helper:** Use a helper to auto-inject `tenant_id` (see Part 1).
- **Test:** Write tests that verify users cannot query another tenant's data, even if they tamper with IDs.

```pseudocode
// Test: user from tenant A cannot read tenant B's data
test("tenant isolation":
  user_a = createTestUser()
  user_b = createTestUser()

  tenant_a = createTestTenant(owner: user_a)
  tenant_b = createTestTenant(owner: user_b)

  customer_b = createTestCustomer(tenant: tenant_b)

  // user_a tries to fetch customer_b directly
  response = getCustomer(customer_b.id, auth: user_a)

  assert response.status == 404  // or 403 — customer doesn't exist for tenant_a
)
```

### API Key Security

- **Storage:** Never store full API key. Store only `sha256(key)` and a prefix.
- **Transmission:** Require HTTPS for all API key endpoints.
- **Rotation:** Support key rotation (create new, deprecate old with grace period).
- **Scope:** API keys should have minimal permissions. No "admin:*" unless necessary.
- **Logging:** Log all API key creation, rotation, and revocation. Alert on revocation.

### Webhook Security

- **HTTPS Only:** Only allow https:// webhook URLs.
- **Signature:** Always sign payloads with HMAC-SHA256. Clients verify before processing.
- **Retry Logic:** Don't retry on 4xx errors (client's fault). Only retry on 5xx or network errors.
- **IP Allowlist:** Optionally allow customers to restrict webhook IPs.
- **Rate Limiting:** Rate-limit webhook dispatch per subscription (e.g., 100/sec).

### Multi-Tenancy Gotchas

1. **Membership Check:** Always verify user is a member of the tenant before granting access.
2. **Cascading Deletes:** When deleting a tenant, cascade-delete all related records.
3. **Billing Leak:** Don't expose one tenant's billing info to another.
4. **Invitation Phishing:** Validate invitation email matches OTP email before accepting.
5. **API Key Leakage:** Don't log full API keys. Log prefixes only.

---

## Edge Cases

### User in Multiple Tenants

- Auth session doesn't store tenant_id — it's per-request.
- Workspace switcher lets user change context.
- API calls must specify tenant via subdomain/path or header.

```pseudocode
// User logs in, has memberships in tenants A and B
session = verifyOtp(user.email)
// session only contains user_id, email, name

// User navigates to tenant A's subdomain
// Middleware: tenant_id = A

// User switches to tenant B
// Middleware: tenant_id = B
```

### Tenant Deletion

- Soft-delete recommended for audit trail.
- Hard-delete after 90 days if GDPR required.
- Cancel any active subscriptions.

### Demo Data Cleanup

- Reset demo data every 1 hour (configurable).
- Delete old demo sessions on expiry.
- Scheduled job should be idempotent (safe to run multiple times).

### API Key Rotation

```pseudocode
POST /api/api-keys/:key_id/rotate:
  // Create new key
  new_key = generateApiKey(...)

  // Keep old key active for 7 days (grace period)
  db.api_keys.updateOne(
    { id: key_id },
    { deprecated_at: now, expires_at: now + 7 days }
  )

  // Return new key (full key, only shown once)
  return { key: new_key.key, ... }
```

### Suspended Tenant

- Block all access except `/billing` and `/account`.
- Show suspension reason.
- Allow unsuspension if payment/violation is resolved.

---

## Environment Variables

```
# Multi-tenancy
MULTI_TENANCY_MODE=shared_db|separate_db|disabled
MULTI_TENANCY_ROUTING=subdomain|path

# Demo account
DEMO_ACCOUNT_ENABLED=true|false
DEMO_ACCOUNT_EMAIL=demo@example.com
DEMO_SESSION_TTL=1h
DEMO_DATA_RESET_INTERVAL=1h
DEMO_DATA_READ_ONLY=true

# API keys
API_KEY_PREFIX=sk
API_KEY_EXPIRY_DEFAULT=null (never expires)

# Webhooks
WEBHOOK_MAX_PER_TENANT=10
WEBHOOK_TIMEOUT_SECONDS=10
WEBHOOK_RETRY_ATTEMPTS=5
WEBHOOK_BACKOFF_MINUTES=1,5,30,120,1440
WEBHOOK_LOG_RETENTION_DAYS=90
```

---

## Integration with Existing Systems

### Auth (otp.md)

- Signup flow: auto-create tenant on first OTP verify.
- Session doesn't include tenant_id; injected per-request by middleware.
- Team invitations use same OTP flow; invitee must verify email.

### Billing (subscription-billing.md)

- Subscription tied to `tenant.plan_id`.
- Plan determines seat limits, feature access, API rate limits.
- Tenant suspension on billing failure (late payment, chargeback).

### Admin Dashboard (admin-dashboard.md)

- New sections: Tenants, Team Members, API Keys, Webhooks
- Admin can view/suspend/delete tenants.
- Audit logs for all team/API key changes.

---

## Pseudocode Summary

### Key Functions

```
// Tenant middleware
tenantMiddleware(request)

// Scoped queries
scopedQuery(table, filters)

// Demo account
initializeDemoAccount()
seedDemoData(tenant_id)
enforceDemo(request)
resetDemoData()

// Team management
postInviteMember(request)
postJoin(request)

// Workspace switching
useWorkspaces()
setLastWorkspace(user_id, tenant_id)

// API keys
generateApiKey(tenant_id)
validateApiKey(key, request)
requirePermission(request, required_permission)

// Webhooks
dispatchEvent(tenant_id, event_type, payload)
deliverWebhook(delivery_id)
scheduleRetry(delivery)
```

---

## Gotchas & Common Mistakes

1. **Missing `tenant_id` filter:** Single most common multi-tenancy bug. Use scoped query helper.
2. **API key stored plaintext:** Always hash with sha256; show full key only once.
3. **Webhook retry on 4xx:** Don't retry if client's fault. Only retry on 5xx/network.
4. **Demo session collision:** Verify demo account exists before creating session.
5. **Invitation email mismatch:** Check OTP email matches invitation email.
6. **Stale workspace context:** On user navigation, clear cached tenant context.
7. **API key permissions ignored:** Server must always validate permissions; don't trust client.
8. **Webhook signature missing:** Always require HMAC signature; make it standard.
9. **Demo data not resetting:** Ensure scheduled job is enqueued and runs.
10. **Cascading deletes on tenant deletion:** Delete members, invites, webhooks, api keys, etc.
