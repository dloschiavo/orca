---
name: Offline Fallback (Native)
description: For React Native/Expo native builds - detects network connectivity and queues requests
type: enhancement
requires: recipes/error-handling.md
env_vars: OFFLINE_QUEUE_MAX_SIZE, OFFLINE_QUEUE_MAX_AGE_MS
---

# Offline Fallback (Native)

For React Native and Expo native apps. Detects network connectivity changes. Displays offline indicator banner. Queues failed API requests for retry when back online. Caches last-fetched data for read-only offline mode. Optimistic UI for queued writes with conflict resolution via server timestamp comparison. **Web apps use standard browser offline behavior; this recipe is native-only.**

---

## Overview

Network connectivity in mobile apps is unpredictable. Users may:
- Lose signal in tunnels, elevators, rural areas
- Airplane mode on/off
- Switch between WiFi and cellular
- Close app and reopen with network restored

This recipe provides:
1. Network connectivity detection (NetInfo API)
2. Offline indicator banner (non-dismissible)
3. Request queue for failed API calls
4. Local data cache (read-only offline mode)
5. Optimistic UI updates (show change immediately, sync when online)
6. Conflict resolution (server timestamp comparison)
7. Sync status indicator (shows when processing queue)

---

## Architecture Overview

```
┌─────────────────────────────────────────────┐
│  React Native App (UI Layer)                │
│  - Components check offline state           │
│  - Optimistic updates show immediately      │
└─────────────┬───────────────────────────────┘
              │
              ↓
┌─────────────────────────────────────────────┐
│  Offline Middleware (Request Layer)         │
│  - Detects network connectivity             │
│  - Queues failed requests                   │
│  - Manages optimistic updates               │
└─────────────┬───────────────────────────────┘
              │
    ┌─────────┴──────────┐
    ↓                    ↓
┌──────────────┐  ┌──────────────┐
│ AsyncStorage │  │  HTTP Client │
│ (Local Cache)│  │ (Server API) │
└──────────────┘  └──────────────┘
```

---

## Data Model

### Local Storage (AsyncStorage)

Store cached API responses and queue state:

```
// Cache format
AsyncStorage.setItem('api_cache:GET:/api/user/profile', JSON.stringify({
  data: { user_id, email, name, ... },
  timestamp: datetime,  // when cached
  etag: string | null,  // for validation
  expires_at: datetime  // when cache should refresh
}))

// Request queue
AsyncStorage.setItem('offline_queue', JSON.stringify([
  {
    id: 'req_123',
    method: 'PATCH',
    endpoint: '/api/user/profile',
    body: { name: 'New Name' },
    queued_at: datetime,
    optimistic_update_id: 'opt_123'  // for rollback
  },
  ...
]))

// Optimistic updates
AsyncStorage.setItem('optimistic_updates', JSON.stringify([
  {
    id: 'opt_123',
    resource_type: 'user',
    resource_id: 'user_456',
    original_value: { name: 'Old Name' },
    new_value: { name: 'New Name' },
    created_at: datetime
  },
  ...
]))
```

### Configuration

```
OFFLINE_QUEUE_MAX_SIZE = 50              // max requests to queue
OFFLINE_QUEUE_MAX_AGE_MS = 86400000      // 24 hours
OFFLINE_CACHE_TTL_MS = 3600000           // 1 hour default
OFFLINE_SYNC_BATCH_SIZE = 10             // process 10 requests at a time
```

---

## Network Detection

### NetInfo API (React Native)

Use `@react-native-community/netinfo` package:

```pseudocode
import NetInfo from '@react-native-community/netinfo';

class OfflineManager:
  constructor():
    this.isOnline = true
    this.listeners = []

  initialize():
    // Listen for connectivity changes
    unsubscribe = NetInfo.addEventListener((state) => {
      this.isOnline = state.isConnected
      this.notifyListeners()

      if (this.isOnline):
        this.syncQueue()  // restart queue when back online
    })

  notifyListeners():
    for listener in this.listeners:
      listener(this.isOnline)

  onConnectivityChange(callback):
    this.listeners.push(callback)
    return () => {
      this.listeners = this.listeners.filter(l => l != callback)
    }
```

### Usage in React Hooks

```pseudocode
function useNetworkStatus():
  [isOnline, setIsOnline] = useState(true)
  [isSyncing, setIsSyncing] = useState(false)

  useEffect(() => {
    unsubscribe = offlineManager.onConnectivityChange((online) => {
      setIsOnline(online)
      if (online):
        setIsSyncing(true)
        offlineManager.syncQueue().then(() => setIsSyncing(false))
    })

    return unsubscribe
  }, [])

  return { isOnline, isSyncing }
```

---

## Offline Indicator Banner

Display at top of screen when offline (non-dismissible):

```
[Banner, red/warning background, fixed at top]
[Icon: ⚠️ No Connection]
You're offline. Changes will sync when you're back online.
```

Styling:
- Height: 48-60px
- Z-index: high (above content)
- Non-dismissible (no close button)
- Only shows when offline
- Animation: slide in from top

```pseudocode
function OfflineIndicator():
  { isOnline, isSyncing } = useNetworkStatus()

  if (isOnline):
    return null  // don't show when online

  return (
    <SafeAreaView style={styles.banner}>
      <View style={styles.content}>
        <Icon name="wifi-off" />
        <Text>You're offline.</Text>
        if (isSyncing):
          <ActivityIndicator />
        endif
      </View>
    </SafeAreaView>
  )
```

---

## Request Queueing

### HTTP Client Middleware

Intercept failed requests and queue them:

```pseudocode
class OfflineHttpClient:
  constructor(baseUrl, offlineManager):
    this.baseUrl = baseUrl
    this.offlineManager = offlineManager
    this.queue = new RequestQueue()

  async request(method, endpoint, body = null, options = {}):
    try:
      // Try to make request
      response = await fetch(this.baseUrl + endpoint, {
        method: method,
        body: JSON.stringify(body),
        ...options
      })

      // Cache successful responses
      if (method == 'GET' and response.ok):
        this.cacheResponse(endpoint, response)

      return response

    catch (error):
      // Network error
      if (!this.offlineManager.isOnline):
        // Queue request for later
        if (this.shouldQueueRequest(method, endpoint)):
          this.queue.add({
            method: method,
            endpoint: endpoint,
            body: body,
            options: options
          })

          // Return optimistic/cached response
          return this.getCachedOrOptimisticResponse(endpoint)

      throw error

  shouldQueueRequest(method, endpoint):
    // Only queue certain endpoints; some are not queueable
    queueableEndpoints = [
      '/api/user/profile',  // PATCH ok
      '/api/notes',         // POST/PATCH ok
      '/api/lists',         // POST/PATCH ok
    ]

    // Do not queue:
    // - GET requests (read-only)
    // - DELETE requests (dangerous)
    // - Payment endpoints (financial)

    return method in ['POST', 'PATCH'] and endpoint in queueableEndpoints
```

### Optimistic Updates

Show changes immediately while queuing:

```pseudocode
class OptimisticUpdateManager:
  constructor():
    this.updates = {}  // id -> { original_value, new_value }

  applyUpdate(resourceId, newValue):
    // Store original value for rollback
    this.updates[resourceId] = {
      id: generateId(),
      resource_id: resourceId,
      original_value: getCurrentValue(resourceId),
      new_value: newValue,
      created_at: now,
      synced: false
    }

    // Update UI immediately
    updateUIState(resourceId, newValue)
    persistToAsyncStorage(this.updates)

  rollbackUpdate(resourceId):
    update = this.updates[resourceId]
    updateUIState(resourceId, update.original_value)
    delete this.updates[resourceId]
    persistToAsyncStorage(this.updates)

  confirmUpdate(resourceId):
    update = this.updates[resourceId]
    update.synced = true
    persistToAsyncStorage(this.updates)
```

### Usage in Components

```pseudocode
function UserProfileScreen():
  [user, setUser] = useState(initialUser)
  { isOnline } = useNetworkStatus()

  function updateName(newName):
    // Apply optimistic update
    optimisticManager.applyUpdate('user_profile', {
      ...user,
      name: newName
    })

    setUser({ ...user, name: newName })

    if (isOnline):
      // Make API call
      fetch('/api/user/profile', {
        method: 'PATCH',
        body: JSON.stringify({ name: newName })
      })
        .then(response => {
          // Confirm optimistic update
          optimisticManager.confirmUpdate('user_profile')
          setUser(response.json())
        })
        .catch(error => {
          // Rollback on error
          optimisticManager.rollbackUpdate('user_profile')
          setUser(initialUser)
          showError('Failed to update. Try again.')
        })
    else:
      // Offline: queue for later
      httpClient.request('PATCH', '/api/user/profile', { name: newName })
  endif

  return (
    <Screen>
      <TextInput
        value={user.name}
        onChangeText={updateName}
        editable={true}  // always editable, offline or not
      />
      {!isOnline and <Text style={styles.syncPending}>Syncing...</Text>}
    </Screen>
  )
```

---

## Local Data Cache

Cache GET responses for offline reading:

```pseudocode
class CacheManager:
  constructor():
    this.cache = {}  // endpoint -> { data, timestamp, ttl }

  async cacheResponse(endpoint, response):
    data = await response.json()
    etag = response.headers.get('etag')

    cacheEntry = {
      data: data,
      timestamp: now,
      etag: etag,
      expires_at: now + OFFLINE_CACHE_TTL_MS
    }

    // Store in AsyncStorage
    await AsyncStorage.setItem(
      'cache:' + endpoint,
      JSON.stringify(cacheEntry)
    )

    this.cache[endpoint] = cacheEntry

  async getFromCache(endpoint):
    // Check in-memory first
    if (this.cache[endpoint]):
      entry = this.cache[endpoint]
      if (entry.expires_at > now):
        return entry.data

    // Load from AsyncStorage
    stored = await AsyncStorage.getItem('cache:' + endpoint)
    if (stored):
      entry = JSON.parse(stored)
      if (entry.expires_at > now):
        this.cache[endpoint] = entry
        return entry.data

    return null

  async getCachedOrOptimistic(endpoint):
    // 1. Check optimistic updates (highest priority)
    optimistic = optimisticManager.getForEndpoint(endpoint)
    if (optimistic):
      return optimistic.new_value

    // 2. Check cache
    cached = await this.getFromCache(endpoint)
    if (cached):
      return cached

    // 3. Return null (no data available)
    return null
```

---

## Sync Queue

Background job processes queued requests when back online:

```pseudocode
class RequestQueue:
  constructor(httpClient):
    this.httpClient = httpClient
    this.queue = []  // requests to process

  async add(request):
    if (this.queue.length >= OFFLINE_QUEUE_MAX_SIZE):
      return false  // queue full

    queuedRequest = {
      id: generateId(),
      ...request,
      queued_at: now
    }

    this.queue.push(queuedRequest)
    await this.persistQueue()
    return true

  async syncQueue():
    if (this.queue.length == 0):
      return  // nothing to sync

    // Process in batches
    batch = this.queue.slice(0, OFFLINE_SYNC_BATCH_SIZE)
    results = []

    for request in batch:
      try:
        response = await this.httpClient.request(
          request.method,
          request.endpoint,
          request.body,
          request.options
        )

        if (response.ok):
          // Success: remove from queue
          this.queue = this.queue.filter(r => r.id != request.id)
          results.push({ id: request.id, status: 'success' })

          // Confirm optimistic update
          optimisticManager.confirmUpdate(request.endpoint)
        else:
          // Server error: stop syncing (backoff)
          results.push({ id: request.id, status: 'failed', code: response.status })
          break
      catch (error):
        // Network error: stop syncing
        results.push({ id: request.id, status: 'error', error: error.message })
        break

    // Persist updated queue
    await this.persistQueue()

    // Notify UI of sync results
    notifySyncResults(results)

  async persistQueue():
    await AsyncStorage.setItem('offline_queue', JSON.stringify(this.queue))

  async loadQueue():
    stored = await AsyncStorage.getItem('offline_queue')
    if (stored):
      this.queue = JSON.parse(stored)
```

---

## Conflict Resolution

If server data changed since offline request was queued:

```pseudocode
async function resolveConflict(queuedRequest, serverResponse):
  // Strategy: last-write-wins with timestamp comparison

  queuedRequest_ts = queuedRequest.queued_at
  serverResponse_ts = serverResponse.updated_at

  if (queuedRequest_ts > serverResponse_ts):
    // Client change is newer: re-apply our change
    // Merge: take server data, then apply client change
    mergedValue = mergeUpdates(
      serverResponse.data,
      queuedRequest.body
    )
    return { action: 'reapply', value: mergedValue }
  else:
    // Server change is newer: accept server data
    return { action: 'accept_server', value: serverResponse.data }
```

Example:

```
Server state: { name: 'Alice', updated_at: 2 hours ago }
Client queued: { name: 'Bob' } (offline, now)
Server now has: { name: 'Charlie', updated_at: 1 hour ago }

Conflict:
  Client.queued_at (now) > Server.updated_at (1 hour ago)
  → Re-apply client change over server data
  → Result: { name: 'Bob', updated_at: now }
```

---

## Sync Status Indicator

Show when queue is being processed:

```pseudocode
function SyncStatusBadge():
  { isSyncing } = useNetworkStatus()

  if (!isSyncing):
    return null

  return (
    <View style={styles.badge}>
      <ActivityIndicator size="small" />
      <Text>Syncing...</Text>
    </View>
  )
```

Display in:
- Top-right corner of header
- Inline next to edited items
- In a global notification

---

## Edge Cases & Configuration

### Queueable Endpoints Configuration

Not all endpoints should be queued. Define per-app:

```json
{
  "offline_config": {
    "queueable_endpoints": [
      {
        "method": "PATCH",
        "pattern": "/api/user/*",
        "max_queue_age_ms": 86400000
      },
      {
        "method": "POST",
        "pattern": "/api/notes",
        "max_queue_age_ms": 86400000
      },
      {
        "method": "PATCH",
        "pattern": "/api/notes/:id",
        "max_queue_age_ms": 86400000
      }
    ],
    "non_queueable_endpoints": [
      "/api/auth/*",
      "/api/billing/*",
      "/api/admin/*",
      "*/DELETE"
    ]
  }
}
```

### Queue Age Limits

Remove requests from queue if too old:

```pseudocode
async function cleanOldRequests():
  now = getCurrentTime()
  cutoff = now - OFFLINE_QUEUE_MAX_AGE_MS

  queue.queue = queue.queue.filter(req => req.queued_at > cutoff)

  // Notify user if requests were dropped
  if (removedCount > 0):
    showWarning('Some offline changes were discarded. Max queue age exceeded.')
```

Run this check:
- On app launch
- Every 5 minutes (background)
- When syncing

### Rate Limiting During Sync

Avoid overwhelming server when syncing large queue:

```pseudocode
async function syncQueueWithBackoff():
  for (let batch of batches):
    // Process batch
    await processBatch(batch)

    // Exponential backoff if many requests
    if (queue.length > 25):
      await delay(1000)  // 1 second between batches
    else if (queue.length > 10):
      await delay(500)
    else:
      await delay(100)  // fast for small queues
```

---

## Error Handling Integration

Hook into error handling to show offline-aware messages:

```pseudocode
function handleApiError(error, context):
  if (!isOnline):
    // Offline: queued or cached
    if (context.queued):
      showInfo('Change saved locally. Will sync when online.')
    else if (context.cached):
      showInfo('Showing cached data. Last updated 2 hours ago.')
  else:
    // Online but failed: show actual error
    showError(error.message)
```

---

## UI Considerations

### Read-Only Mode Indicator

When offline and no cache available:

```
[Grayed out section]
[Icon: lock]
No offline data available.

You can view cached data, but cannot make changes.
Go online to see the latest information.
```

### Batch Sync Notifications

After syncing queue:

```
// All succeeded
[Toast: ✓ 5 changes synced]

// Partial success
[Toast: ⚠ 3 of 5 changes synced. Retry offline items?]
[Retry button]

// All failed
[Toast: ✗ Failed to sync 5 changes. Retry?]
[Retry button]
```

---

## Configuration Example

Full offline config for an app:

```javascript
const OFFLINE_CONFIG = {
  enabled: true,
  network_detection: 'netinfo',  // React Native only

  cache: {
    ttl_ms: 3600000,      // 1 hour
    max_size_entries: 200,
  },

  queue: {
    max_size: 50,
    max_age_ms: 86400000,  // 24 hours
    batch_size: 10,
    batch_delay_ms: 100,
  },

  sync: {
    auto_sync: true,       // sync when online
    interval_ms: null,     // no time-based sync, only on connectivity change
  },

  queueable: [
    { method: 'PATCH', pattern: '/api/user/profile' },
    { method: 'PATCH', pattern: '/api/user/settings' },
    { method: 'POST', pattern: '/api/notes' },
    { method: 'PATCH', pattern: '/api/notes/:id' },
  ],

  non_queueable: [
    '/api/auth/**',
    '/api/billing/**',
    '/api/upload',
    '/**/DELETE',
  ],
};
```

---

## Gotchas

### 1. Offline Does Not Mean No Network

On some devices, the app might lose internet but think it's connected. NetInfo might report `isConnected: true` but actual request fails. Always handle network errors gracefully:

```pseudocode
// WRONG: trust NetInfo alone
if (isOnline):
  await fetch(url)  // assume this succeeds

// RIGHT: handle failures even if isOnline
try:
  if (isOnline):
    await fetch(url)
  else:
    return cachedData
catch:
  // Even online, request can fail
  return cachedData or queue request
```

### 2. Concurrent Offline/Online Switches

User goes offline → request queued → reconnect → request sent → disconnect → reconnect. Handle these transitions:

```pseudocode
class StateManager:
  constructor():
    this.isTransitioning = false

  onConnectivityChange(newState):
    if (this.isTransitioning):
      return  // already processing

    this.isTransitioning = true
    try:
      if (newState):
        syncQueue()
      else:
        pauseQueue()
    finally:
      this.isTransitioning = false
```

### 3. Optimistic Updates Cause Stale Data

If optimistic update shows new value, but network fetch fails, user sees outdated data. Always provide visual feedback:

```
[Text field showing "Bob" (optimistic)]
[Icon: ⚠️ Sync pending]

If user navigates away and comes back, data might revert to server state.
```

### 4. Queue Grows Too Large

If user is offline for days and makes many changes, queue explodes. Implement limits:

```pseudocode
async function add(request):
  if (this.queue.length >= OFFLINE_QUEUE_MAX_SIZE):
    // Option 1: reject new requests
    return false

    // Option 2: show modal asking to go online
    // Option 3: drop oldest requests

    // Option 4: compress queue (merge updates to same resource)
```

### 5. Sensitive Data in AsyncStorage

Cached data and queued requests are stored in AsyncStorage (not encrypted by default). For sensitive apps:

```pseudocode
// Use Encryption library
import RNSecureKeyStore from 'react-native-secure-key-store';

async function persistQueue(queue):
  encrypted = encrypt(JSON.stringify(queue), secretKey)
  await RNSecureKeyStore.set('offline_queue', encrypted)

async function loadQueue():
  encrypted = await RNSecureKeyStore.get('offline_queue')
  queue = decrypt(encrypted, secretKey)
  return queue
```

### 6. Batch Requests in Queue Fail

If syncing a batch of 10 requests and the 5th fails, what happens to the rest? Consider:

```pseudocode
async function syncQueue():
  // Option 1: stop on first failure (current implementation)
  // Option 2: continue and log failures
  // Option 3: retry individual requests with exponential backoff
  // Option 4: parallel requests with concurrency limit

  // Current: stop on failure
  for request in batch:
    try:
      await request()
    catch:
      break  // stop here, retry batch next time
```

### 7. Clock Skew in Conflict Resolution

If user's device clock is wrong, timestamps in conflict resolution are unreliable:

```pseudocode
// User's device thinks it's 2025 but server is 2026
QueuedRequest.timestamp = 2025
ServerResponse.timestamp = 2026
// Looks like server is newer, but client might actually be newer

// Mitigate: use server's timestamp for all decisions
```

### 8. Offline Signup/Login Not Supported

Users cannot sign up or log in while offline. Clear error:

```
[Button: "Sign Up"]
[onclick -> check network]

if (!isOnline):
  showError('You must be online to create an account. Please connect and try again.')
```

### 9. Large File Uploads Queued

If user tries to upload a 50MB file offline, it's queued in AsyncStorage. This can crash the app. Block:

```pseudocode
POST /api/upload:
  if (!isOnline):
    return { error: 'uploads_not_supported_offline' }

  if (!isOnline and request.body.size > 5MB):
    return { error: 'file_too_large_offline' }
```

### 10. Deeplinks + Offline

If app receives deeplink while offline, cached data might not have the linked resource:

```
Deeplink: /notes/note_456
App: offline
Cache: does not have note_456

Solution:
- Show loading state
- When online, fetch the resource
- Update URL and show content
```

