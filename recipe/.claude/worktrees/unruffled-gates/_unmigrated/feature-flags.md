---
name: Feature Flags
description: Runtime feature flags with admin UI and per-environment overrides
type: enhancement
requires: recipes/dev-ops.md, recipes/admin-dashboard.md
env_vars: FEATURE_FLAGS_PROVIDER (default: database)
---

# Feature Flags

Runtime feature flags stored in database with admin UI. Supports boolean flags, percentage rollouts, and user-segment targeting. Client reads flags from `/api/config/flags` endpoint. SDK: `useFeatureFlag(name)` hook. Evaluation is cached and refreshed on interval.

---

## Overview

Feature flags allow you to control feature visibility at runtime without deploying code. Use cases:

- Gradual rollout: enable feature for 10% of users, monitor, expand to 50%, then 100%
- A/B testing: flag controls whether user sees variant A or B
- Kill switch: disable a broken feature instantly for all users
- Environment-specific: feature enabled in staging but not production
- User targeting: enable feature for specific user segments (beta testers, admins, etc.)

This recipe provides:
1. Database table to store flags
2. Admin UI to toggle flags and set rules
3. Client-side evaluation with caching
4. Segment-based targeting

---

## Data Model

New table: `feature_flags`

```
FeatureFlag {
  id:               auto-generated primary key
  name:             string (unique)  // e.g., 'new_dashboard'
  description:      string
  enabled:          boolean  // global enable/disable
  type:             enum('boolean', 'percentage', 'user_segment', 'custom')
  rules:            object (JSON)  // rule-specific config

  // For percentage rollouts
  percentage?:      integer  // 0-100

  // For user segment targeting
  target_users?:    array[string]  // list of user_ids
  target_roles?:    array[string]  // ['admin', 'beta_tester']

  // Environment overrides
  overrides:        object {
    [environment]: {
      enabled: boolean,
      percentage?: integer,
      target_users?: array
    }
  }

  created_at:       datetime
  updated_at:       datetime
  created_by:       string  // admin user_id
  updated_by:       string
}
```

**Indexes:**
- Unique index on `name` — look up by flag name
- Index on `updated_at` — for cache invalidation (clients poll for changes)

---

## API Routes

### GET `/api/config/flags`

Fetch all feature flags for client-side evaluation.

**Query params:**
- `user_id?: string` — for user-segment-based evaluation (optional)

**Response:**
```
{
  flags: {
    'new_dashboard': {
      enabled: true,
      type: 'percentage',
      percentage: 45,
      last_updated_at: datetime
    },
    'beta_analytics': {
      enabled: false,
      type: 'user_segment',
      is_target_user: true,  // personalized per user_id
      last_updated_at: datetime
    },
    ...
  },
  cache_expires_at: datetime,
  version: integer  // incremented on each flag change
}
```

**Behavior:**
- If `user_id` provided, evaluate user-segment flags
- Include evaluation context for percentage rollouts (see [Client Evaluation](#client-evaluation) below)
- Cache-friendly: include `ETag` or version number
- Use `s-maxage` for CDN caching if no user-specific flags

### GET `/admin/api/flags`

Admin endpoint: list all flags with full details.

**Requires:** `requireAdmin(request)`

**Response:**
```
{
  flags: [
    {
      id: string,
      name: string,
      description: string,
      enabled: boolean,
      type: string,
      percentage?: number,
      target_users?: array,
      target_roles?: array,
      overrides: object,
      created_at: datetime,
      updated_at: datetime
    }
  ]
}
```

### POST `/admin/api/flags`

Create a new feature flag.

**Request:**
```
{
  name: string,
  description: string,
  enabled: boolean,
  type: enum('boolean', 'percentage', 'user_segment'),
  percentage?: integer,
  target_users?: array[string],
  target_roles?: array[string],
  overrides?: object
}
```

**Validation:**
- `name` must be unique and match `^[a-z_]+$` (lowercase, underscores)
- `percentage` must be 0-100 if type=='percentage'
- `target_users` must be valid user_ids
- `target_roles` must be valid roles

**Response:**
```
{
  flag: { ... }
}
```

**Side effects:**
- Insert flag into database
- Increment flags version number (for cache invalidation)
- Log creation event: "flag_created" with flag name and admin user_id

### PATCH `/admin/api/flags/:name`

Update an existing flag.

**Request:** (partial, any of the above fields)
```
{
  enabled?: boolean,
  percentage?: integer,
  target_users?: array,
  target_roles?: array,
  overrides?: object
}
```

**Response:**
```
{
  flag: { ... }
}
```

**Side effects:**
- Update flag
- Increment version number
- Log change: "flag_updated" with before/after values

### DELETE `/admin/api/flags/:name`

Delete a flag.

**Response:**
```
{
  status: 'deleted'
}
```

**Side effects:**
- Soft-delete flag (set a `deleted_at` field) or hard-delete
- Increment version number
- Log deletion

---

## Client-Side Evaluation

### SDK: `useFeatureFlag` Hook

```pseudocode
// Pseudocode for React
function useFeatureFlag(flagName):
  [flags, setFlags] = useState({})
  [user, setUser] = useState(null)

  useEffect(() => {
    // Fetch flags on mount
    fetchFlags(user?.user_id).then(setFlags)

    // Refresh flags every 5 minutes
    interval = setInterval(
      () => fetchFlags(user?.user_id).then(setFlags),
      5 * 60 * 1000
    )

    return () => clearInterval(interval)
  }, [user?.user_id])

  return evaluateFlag(flagName, flags, user)

// Usage:
function Dashboard():
  isNewDashboardEnabled = useFeatureFlag('new_dashboard')
  return (
    isNewDashboardEnabled ? <NewDashboard /> : <OldDashboard />
  )
```

### Flag Evaluation Logic

```pseudocode
function evaluateFlag(flagName, flagsConfig, user = null):
  flagDef = flagsConfig[flagName]

  if (!flagDef):
    return false  // unknown flag defaults to disabled (safe default)

  // Check environment override (if applicable)
  environment = getCurrentEnvironment()  // 'production', 'staging', 'dev'
  override = flagDef.overrides?.[environment]
  if (override):
    flagDef = override

  // Global disable
  if (!flagDef.enabled):
    return false

  // Type-specific evaluation
  switch flagDef.type:
    case 'boolean':
      return true  // simple on/off

    case 'percentage':
      // Consistent hashing: same user always gets same result
      hash = hashUserId(user?.user_id || getSessionId())
      return (hash % 100) < flagDef.percentage

    case 'user_segment':
      if (flagDef.target_users?.includes(user?.user_id)):
        return true
      if (flagDef.target_roles?.includes(user?.role)):
        return true
      return false

    default:
      return false
```

### Consistent Hashing for Rollouts

For percentage rollouts, the same user must always get the same result (consistent). Use deterministic hashing:

```pseudocode
function hashUserId(userId):
  // Hash user_id to a number 0-99
  // Use the SAME hash every time for same user_id
  hash = crc32(userId + '_' + flagName)  // or md5, sha1, murmur3
  return abs(hash) % 100
```

Example:
- User A: hash=45 → enabled for 50% rollout (45 < 50 = true)
- User B: hash=72 → disabled for 50% rollout (72 < 50 = false)
- User A next day: hash=45 (same) → still enabled ✓

---

## Admin UI

### Flag List Page

```
[Page: /admin/flags]

[Heading: "Feature Flags"]
[Create new flag button]

[Flags table]:
  Name          | Type       | Enabled | Rollout | Updated
  new_dashboard | percentage | ✓       | 45%     | 2 hours ago
  beta_analytics| user_segment| ✗      | N/A     | 5 days ago
  dark_mode     | boolean    | ✓       | N/A     | now

[Click row to edit]
```

### Flag Edit Modal

```
[Modal: "Edit Flag: new_dashboard"]

Name: [read-only] new_dashboard
Description: [textarea] "Redesigned dashboard layout"

Global Enable: [toggle switch]

Type: [dropdown] percentage
  ○ Boolean
  ○ Percentage rollout
  ○ User segment
  ○ Custom

[If Percentage selected]:
  Rollout %: [slider 0-100] 45
  [Preview: "45% of users will see this feature"]

[If User Segment selected]:
  Target Roles: [multi-select] admin, beta_tester
  Target Users: [textarea] user_id_1, user_id_2, ...

Environment Overrides:
  Production:
    Enabled: [toggle]
    Percentage: [input] (if applicable)
  Staging:
    Enabled: [toggle]
    Percentage: [input]

[Save] [Cancel] [Delete] buttons
```

---

## Environment-Specific Overrides

Example config:

```json
{
  "name": "new_dashboard",
  "enabled": true,
  "type": "percentage",
  "percentage": 100,
  "overrides": {
    "staging": {
      "enabled": true,
      "percentage": 100
    },
    "production": {
      "enabled": true,
      "percentage": 45
    },
    "development": {
      "enabled": true,
      "percentage": 100
    }
  }
}
```

Evaluation:
1. Load flag config
2. Check if current environment is in `overrides`
3. If yes, use override values
4. If no, use global values

```pseudocode
function evaluateFlag(flagName, user = null):
  flagDef = loadFlagFromCache(flagName)
  environment = getCurrentEnvironment()

  if (environment in flagDef.overrides):
    // Use environment-specific rule
    return evaluateRules(flagDef.overrides[environment])
  else:
    // Use global rule
    return evaluateRules(flagDef)
```

---

## Caching & Invalidation

### Client-Side Caching

Fetch flags once on app load, refresh periodically:

```pseudocode
class FlagCache:
  constructor():
    this.flags = {}
    this.version = null
    this.lastFetch = null

  async fetchFlags(userId = null):
    // Fetch with ETag for conditional request
    headers = {}
    if (this.version):
      headers['If-None-Match'] = this.version

    response = await fetch('/api/config/flags', {
      headers,
      params: { user_id: userId }
    })

    if (response.status == 304):  // Not Modified
      return this.flags  // use cached version

    if (response.ok):
      data = await response.json()
      this.flags = data.flags
      this.version = response.headers['ETag'] || data.version
      this.lastFetch = now()
      return this.flags

    throw Error('Failed to fetch flags')

  isExpired(ttl = 5 * 60 * 1000):  // 5 min TTL
    return (now - this.lastFetch) > ttl

  async getFlags(userId = null):
    if (!this.flags or this.isExpired()):
      await this.fetchFlags(userId)
    return this.flags
```

### Server-Side Invalidation

When a flag is updated, invalidate client caches:

```pseudocode
PATCH /admin/api/flags/:name:
  flag = updateFlag(name, request.body)

  // Increment global version
  db.system.update({}, { feature_flags_version: version + 1 })

  // Optional: broadcast WebSocket event to all connected clients
  broadcast({ event: 'flags_updated', version })

  return flag
```

Clients detect version change and refetch:

```javascript
// On WebSocket event
socket.on('flags_updated', ({ version }) => {
  flagCache.version = null;  // Clear cached version
  flagCache.fetchFlags(user.user_id);  // Refetch
});
```

---

## Security Notes

### 1. Sensitive Flag Values

Do NOT use flags to gate access to truly sensitive features (e.g., "admin override bypass"). Flags are eval'd in client-side code; a determined attacker can manipulate them.

For access control, always validate server-side.

```pseudocode
// WRONG: client decides to bypass auth
if (useFeatureFlag('disable_auth_check')):
  // skip auth validation
  skipAuth()

// RIGHT: client uses flag only for UI
if (useFeatureFlag('show_experimental_menu')):
  <ExperimentalMenu />

// server always validates auth
requireAuth()
```

### 2. Admin Access Control

Only admins can create/update flags:

```pseudocode
PATCH /admin/api/flags/:name:
  user = requireSession(request)
  if (user.role != 'admin'):
    return 403

  updateFlag(name, request.body)
```

### 3. Audit Logging

Log all flag changes:

```
flag_created: flag_name, admin_user_id, timestamp
flag_updated: flag_name, changes, admin_user_id, timestamp
flag_deleted: flag_name, admin_user_id, timestamp
```

---

## Gotchas

### 1. Percentage Rollout Distribution

Hash-based rollouts distribute users randomly but consistently. A 50% rollout will be ~50% of users, but distribution is pseudorandom. For true randomness, use different hashing per flag:

```pseudocode
function hashUserId(userId, flagName):
  // Include flag name in hash so each flag has different distribution
  hash = crc32(userId + '_' + flagName)
  return abs(hash) % 100
```

### 2. Race Condition: Flag Update During Fetch

Admin updates flag from 50% to 75% while client is mid-fetch. Client might receive partial data. Mitigate with ETags:

- Include `version` or `ETag` header in response
- Client caches version
- On next fetch, send `If-None-Match`; server responds 304 if unchanged

### 3. Flag Names in Client Code

If you hardcode flag names in client code, refactoring becomes tedious. Use a constant or config:

```javascript
const FLAGS = {
  NEW_DASHBOARD: 'new_dashboard',
  BETA_ANALYTICS: 'beta_analytics'
}

isEnabled = useFeatureFlag(FLAGS.NEW_DASHBOARD)
```

### 4. Percentage Rollout Not Uniform

If you use `hash % 100`, user IDs with specific patterns might cluster (e.g., sequential IDs). Use a proper hash function (CRC32, MD5, SHA1) for uniform distribution.

### 5. Default to False

Unknown flags should default to `false` (feature disabled). Never default to true. This prevents outages if flag config is missing:

```pseudocode
function evaluateFlag(name):
  if (not name in flags):
    return false  // safe default
```

### 6. Stale Flags in Offline Mode

If app goes offline (mobile), cached flags become stale. User might see features that are disabled in production. Document this behavior and refresh on reconnect:

```javascript
window.addEventListener('online', async () => {
  flagCache.version = null;  // Clear cache
  await flagCache.fetchFlags(user.user_id);
  location.reload();  // Refresh UI to respect new flags
});
```

### 7. Flag Cleanup

Over time, old flags accumulate. Add a policy to archive or delete deprecated flags:

```
If flag not updated in 90 days and enabled=false, offer admin option to archive
Include "last_updated_at" in flag metadata
Create audit trail before deletion
```

