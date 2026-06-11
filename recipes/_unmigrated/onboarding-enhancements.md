---
name: Onboarding Enhancements
description: Pre-auth excitement stepper, post-auth checklist, and profile completion nudge for new users
type: enhancement
requires: recipes/auth.md, recipes/feature-flags.md
env_vars: ONBOARDING_ENABLED (boolean, default: true)
---

# Onboarding Enhancements

Three coordinated components to guide new users through app activation:

1. **Pre-Auth Excitement Stepper** — Fullscreen multi-step carousel shown before login on first visit. Configurable per app. Dismissible with localStorage memory.
2. **Onboarding Checklist** — Persistent post-auth widget for new users. Tracks completion in database. Dismissible after all items complete or manually.
3. **Profile Completion Nudge** — Subtle banner/toast alerting users when profile is incomplete. Links to settings. Dismissible per session.

All three are optional, configurable per app, and gated by feature flags for A/B testing.

---

## Data Models

### Table: `onboarding_checklist_items`

Pre-defined checklist items, configured per app. Not user-specific.

```
OnboardingChecklistItem {
  id:                   auto-generated primary key
  app_id:               string  // e.g., "myapp", "otherapp"
  label:                string  // "Complete your profile", "Create first project"
  description:          string  // Longer explanation
  item_key:             string  // unique key per app: "profile_complete", "first_project"
  completion_rule_type: enum    // 'manual' | 'feature_gate' | 'function'
  completion_rule:      string  // Feature flag name or function reference
  link_path?:           string  // Route to navigate to: "/settings/profile", "/projects/new"
  icon_key?:            string  // Icon identifier: "profile", "rocket", "check"
  order:                integer // Display order
  required:             boolean // If true, dismiss button hidden until complete
  feature_flag?:        string  // Show item only if flag enabled (e.g., "projects_enabled")
  created_at:           datetime
  updated_at:           datetime
}
```

### Table: `onboarding_checklist_state`

Per-user completion state for onboarding items.

```
OnboardingChecklistState {
  id:                     auto-generated primary key
  user_id:                string  // FK to users table
  app_id:                 string
  item_id:                string  // FK to onboarding_checklist_items
  completed:              boolean // User has completed this item
  completed_at?:          datetime
  dismissed:              boolean // User manually dismissed (if not required)
  dismissed_at?:          datetime
  all_items_completed:    boolean // Cached: all non-feature-gated items done
  checklist_dismissed:    boolean // User dismissed entire checklist
  checklist_dismissed_at: datetime // When checklist was permanently dismissed
  created_at:             datetime
  updated_at:             datetime
  UNIQUE:                 (user_id, app_id, item_id)
}
```

### Table: `pre_auth_stepper_dismissals`

Tracks first-visit stepper dismissal (stored per session/device, no user needed yet).

```
PreAuthStepperDismissal {
  id:             auto-generated primary key
  session_id:     string  // Ephemeral session token
  app_id:         string
  dismissed_at:   datetime
  created_at:     datetime
}
```

### Table: `profile_completion_nudge_dismissals`

Tracks per-session dismissal of profile completion nudge.

```
ProfileNudgeDismissal {
  id:          auto-generated primary key
  user_id:     string
  app_id:      string
  dismissed_at: datetime
  session_id:  string  // Track per-session (reset on new session)
  created_at:  datetime
}
```

---

## Config Schema

### App Configuration: `onboarding_config.json`

Defined per app, loaded at startup or from admin panel.

```
AppOnboardingConfig {
  app_id: string

  // Pre-auth excitement stepper
  pre_auth_stepper: {
    enabled:      boolean
    steps: [
      {
        id:               string      // "step_1", "step_2"
        title:            string      // "Collaborate instantly"
        description:      string      // Rich text description
        illustration_url: string      // URL to SVG or image
        icon_key?:        string      // Fallback icon: "star", "rocket"
        cta_text?:        string      // Optional CTA: "Let's go", "Learn more"
        cta_action?:      enum        // 'next_step' | 'external_link' | 'none'
        cta_link?:        string      // For external_link action
      }
    ]
    animation_style: enum  // 'slide' | 'fade' | 'none'
  }

  // Post-auth onboarding checklist
  onboarding_checklist: {
    enabled:   boolean
    headline:  string  // "Get started in 3 steps"
    show_progress_bar: boolean
    items: [
      {
        item_key:           string  // unique key: "profile", "avatar", "project"
        label:              string
        description:        string
        link_path:          string
        completion_rule:    enum    // 'manual' | 'feature_gate' | 'profile_field'
        completion_check:   string  // Feature flag name, or "profile.display_name"
        required:           boolean
        feature_flag?:      string  // Show only if enabled
      }
    ]
  }

  // Profile completion nudge banner
  profile_completion_nudge: {
    enabled:          boolean
    style:            enum  // 'banner' | 'toast'
    message:          string  // "Complete your profile to unlock all features"
    cta_text:         string  // "Go to settings"
    fields_to_check: [string]  // ["display_name", "avatar", "bio"]
  }

  // Feature flags
  feature_flags: {
    force_onboarding:      boolean  // Show even for existing users (testing)
    skip_profile_nudge:    boolean  // Disable nudge
    analytics_tracking:    boolean  // Track stepper/checklist interactions
  }
}
```

---

## API Routes

### GET `/api/onboarding/config`

Returns onboarding config for current app.

**Response:**
```
{
  pre_auth_stepper: { ... },
  onboarding_checklist: { ... },
  profile_completion_nudge: { ... },
  feature_flags: { ... }
}
```

---

### GET `/api/onboarding/checklist`

Get current user's checklist state. Requires auth.

**Response:**
```
{
  user_id: string,
  app_id: string,
  items: [
    {
      id: string,
      item_key: string,
      label: string,
      description: string,
      completed: boolean,
      completed_at?: datetime,
      link_path: string,
      icon_key: string,
      required: boolean,
      hidden_by_feature_flag?: boolean
    }
  ],
  progress: {
    total_items: integer,
    completed_items: integer,
    percentage: float  // 0-100
  },
  all_completed: boolean,
  checklist_dismissed: boolean
}
```

---

### POST `/api/onboarding/checklist/:item_id/complete`

Mark a checklist item as complete. Requires auth.

**Request:**
```
{}
```

**Response:**
```
{
  item_id: string,
  completed: true,
  completed_at: datetime,
  progress: {
    completed_items: integer,
    total_items: integer,
    percentage: float
  }
}
```

**Side effects:**
- Update `onboarding_checklist_state.completed = true`
- Trigger webhook if configured (for analytics, email, etc.)
- If all items complete, optionally mark checklist as completable

---

### POST `/api/onboarding/checklist/:item_id/dismiss`

Dismiss a single optional (non-required) item.

**Response:**
```
{
  item_id: string,
  dismissed: true,
  dismissed_at: datetime
}
```

**Side effects:**
- Set `dismissed = true`
- Update progress calculation (exclude dismissed items from denominator)

---

### POST `/api/onboarding/checklist/dismiss-all`

Dismiss entire checklist (only allowed when all items complete or user forces).

**Request:**
```
{
  force?: boolean  // If true, dismiss even if items incomplete
}
```

**Response:**
```
{
  checklist_dismissed: true,
  dismissed_at: datetime
}
```

**Side effects:**
- Set `checklist_dismissed = true`
- Log event for analytics
- Checklist reappears on next session unless all items were complete

---

### GET `/api/onboarding/profile-status`

Get profile completion status. Requires auth.

**Response:**
```
{
  user_id: string,
  is_profile_complete: boolean,
  missing_fields: [string],  // ["display_name", "avatar"]
  nudge_dismissed_this_session: boolean
}
```

---

### POST `/api/onboarding/profile-nudge/dismiss`

Dismiss profile completion nudge for this session.

**Response:**
```
{
  dismissed: true,
  session_expires_at: datetime  // Reappears next session
}
```

**Side effects:**
- Write to `profile_completion_nudge_dismissals`
- Store in session cache to avoid showing again this session

---

### POST `/api/onboarding/analytics/event`

Track user interactions with onboarding components (optional, gated by feature flag).

**Request:**
```
{
  event_type: enum,  // 'stepper_viewed', 'stepper_dismissed', 'stepper_completed',
                     // 'checklist_item_completed', 'checklist_dismissed',
                     // 'profile_nudge_shown', 'profile_nudge_dismissed'
  item_id?: string,
  step_index?: integer,
  timestamp: datetime
}
```

**Response:**
```
{
  success: true,
  event_id: string
}
```

---

## Pre-Auth Excitement Stepper Implementation

### Flow

```pseudocode
// On app load (before auth), check if user should see stepper

function shouldShowPreAuthStepper(request):
  // Check if onboarding enabled
  if not getConfig('onboarding_enabled'):
    return false

  // Check feature flag
  if not isFeatureFlagEnabled('force_onboarding') and not isFirstVisit(request):
    return false

  // Check if already dismissed this session
  sessionId = request.cookies['session_id']
  if isDismissed(sessionId):
    return false

  return true

function isFirstVisit(request):
  // No session cookie means first visit
  return not request.cookies['session_id']

function isDismissed(sessionId):
  // Check localStorage (client-side) or session storage
  return db.pre_auth_stepper_dismissals.findOne({
    session_id: sessionId
  })
```

### Client-Side: Pre-Auth Stepper Component

```pseudocode
Component PreAuthStepper:
  state:
    currentStepIndex = 0
    config = null
    visible = true

  onMount():
    config = await fetch('/api/onboarding/config')
    if not shouldShow(config):
      visible = false
      return

    // Check localStorage for dismissal
    if localStorage.getItem('pre_auth_stepper_dismissed'):
      visible = false
      return

    // Track view event
    if config.feature_flags.analytics_tracking:
      trackEvent('stepper_viewed')

  handleNext():
    currentStepIndex += 1
    if currentStepIndex >= config.pre_auth_stepper.steps.length:
      handleComplete()

  handlePrevious():
    currentStepIndex = max(0, currentStepIndex - 1)

  handleDismiss():
    // Save to localStorage
    localStorage.setItem('pre_auth_stepper_dismissed', true)

    // Save to DB (optional, tracks dismissal across devices)
    POST '/api/onboarding/stepper/dismiss'

    visible = false
    trackEvent('stepper_dismissed')

  handleCTA(step):
    if step.cta_action == 'next_step':
      handleNext()
    else if step.cta_action == 'external_link':
      window.location.href = step.cta_link
    else if step.cta_action == 'none':
      // Just visual

  render():
    if not visible:
      return null

    step = config.pre_auth_stepper.steps[currentStepIndex]

    return (
      <Fullscreen overlay>
        <StepperContainer>
          <StepImage src={step.illustration_url} />
          <StepTitle>{step.title}</StepTitle>
          <StepDescription>{step.description}</StepDescription>

          <ProgressDots>
            for i in 0..steps.length-1:
              <Dot active={i == currentStepIndex} />

          <ButtonRow>
            <Button onClick={handlePrevious} disabled={currentStepIndex == 0}>
              Back
            <Button onClick={handleDismiss} style="secondary">
              Skip for now
            if step.cta_text:
              <Button onClick={handleCTA} style="primary">
                {step.cta_text}
            else:
              <Button onClick={handleNext} style="primary">
                Next
        </StepperContainer>
      </Fullscreen>
    )
```

### Server-Side: Store Stepper Dismissal

```pseudocode
POST /api/onboarding/stepper/dismiss:
  sessionId = generateOrGetSessionId(request)

  db.pre_auth_stepper_dismissals.insert({
    session_id: sessionId,
    app_id: getCurrentAppId(),
    dismissed_at: now()
  })

  return {
    success: true
  }
```

---

## Post-Auth Onboarding Checklist Implementation

### Server-Side: Initialize Checklist for New Users

When a user signs up (in auth/registration flow), initialize their checklist:

```pseudocode
function onUserRegistration(user):
  if not getConfig('onboarding_checklist.enabled'):
    return

  // Only for new users, not existing ones
  if user.created_at != now():
    return

  config = getOnboardingConfig()
  appId = getCurrentAppId()

  for item in config.onboarding_checklist.items:
    // Skip if feature-gated and flag disabled
    if item.feature_flag:
      if not isFeatureFlagEnabled(item.feature_flag):
        continue

    db.onboarding_checklist_state.insert({
      user_id: user.user_id,
      app_id: appId,
      item_id: item.id,
      completed: false,
      dismissed: false,
      all_items_completed: false,
      checklist_dismissed: false,
      created_at: now()
    })
```

### Client-Side: Onboarding Checklist Component

```pseudocode
Component OnboardingChecklist:
  state:
    items = []
    progress = null
    loading = true
    error = null
    collapsed = false

  onMount():
    if not isAuthenticatedUser():
      return

    // Load checklist
    response = await fetch('/api/onboarding/checklist')
    items = response.items
    progress = response.progress
    checklist_dismissed = response.checklist_dismissed

    if checklist_dismissed and progress.percentage == 100:
      // Don't show if dismissed and all done
      return

    if checklist_dismissed and progress.percentage < 100:
      // Show minimized version to allow continuation
      collapsed = true

    loading = false

  handleCompleteItem(itemId):
    response = await POST `/api/onboarding/checklist/${itemId}/complete`
    update progress
    trackEvent('checklist_item_completed', itemId)

  handleDismissItem(itemId):
    response = await POST `/api/onboarding/checklist/${itemId}/dismiss`
    update progress
    trackEvent('checklist_item_dismissed', itemId)

  handleDismissChecklist():
    response = await POST '/api/onboarding/checklist/dismiss-all'
    visible = false
    trackEvent('checklist_dismissed')

  render():
    if loading:
      return <Skeleton />

    if progress.percentage == 100:
      return (
        <Card>
          <Heading>You're all set!</Heading>
          <Checkmark icon />
          <Button onClick={handleDismissChecklist}>Done</Button>
        </Card>
      )

    if collapsed:
      return (
        <Drawer position="bottom">
          <Heading size="small">
            {progress.completed_items} of {progress.total_items} done
          <ProgressBar percentage={progress.percentage} />
          <Button onClick={() => collapsed = false}>Expand</Button>
          <Button onClick={handleDismissChecklist} style="secondary">Dismiss</Button>
        </Drawer>
      )

    return (
      <Card>
        <Header>
          <Heading>{config.onboarding_checklist.headline}</Heading>
          <CloseButton onClick={handleDismissChecklist} />
        </Header>

        if config.onboarding_checklist.show_progress_bar:
          <ProgressBar percentage={progress.percentage} />

        <ChecklistItems>
          for item in items:
            if item.hidden_by_feature_flag:
              continue

            <ChecklistItem>
              <Checkbox
                checked={item.completed}
                disabled={item.required and not item.completed}
                onChange={() => handleCompleteItem(item.id)}
              />
              <ItemContent>
                <ItemLabel>{item.label}</ItemLabel>
                <ItemDescription>{item.description}</ItemDescription>
              </ItemContent>
              if not item.required and not item.completed:
                <DismissButton onClick={() => handleDismissItem(item.id)}>
                  ✕
              <ItemLink to={item.link_path}>→</ItemLink>
        </ChecklistItems>

        if progress.percentage == 100:
          <ActionButton onClick={handleDismissChecklist}>
            All done!
        else:
          <ActionButton onClick={handleDismissChecklist} style="secondary">
            Not now
      </Card>
    )
```

### Server-Side: Checklist Completion Logic

```pseudocode
POST /api/onboarding/checklist/:itemId/complete:
  user = getAuthenticatedUser(request)
  itemId = request.params.itemId
  appId = getCurrentAppId()

  // Validate item exists and belongs to this app
  item = db.onboarding_checklist_items.findOne({
    id: itemId,
    app_id: appId
  })
  if not item:
    return response.status(404).json({error: "Item not found"})

  // Update state
  state = db.onboarding_checklist_state.findOne({
    user_id: user.user_id,
    item_id: itemId,
    app_id: appId
  })

  // Check if item is already complete
  if state.completed:
    return response.json({
      item_id: itemId,
      completed: true,
      completed_at: state.completed_at
    })

  // Verify completion rule before marking complete
  if item.completion_rule_type == 'feature_gate':
    flagEnabled = isFeatureFlagEnabled(item.completion_rule)
    if not flagEnabled:
      return response.status(400).json({
        error: "Item not yet available",
        detail: "Feature flag not enabled"
      })

  // Mark complete
  state.completed = true
  state.completed_at = now()
  state.save()

  // Calculate progress
  progress = calculateProgress(user.user_id, appId)

  // Trigger webhooks (analytics, email, etc.)
  if getConfig('webhooks.enabled'):
    triggerWebhook('onboarding.item_completed', {
      user_id: user.user_id,
      item_id: itemId,
      all_completed: progress.percentage == 100
    })

  // Log event
  log('onboarding_item_completed', {user_id: user.user_id, item_id: itemId})

  return response.json({
    item_id: itemId,
    completed: true,
    completed_at: state.completed_at,
    progress: {
      completed_items: progress.completed_items,
      total_items: progress.total_items,
      percentage: progress.percentage
    }
  })

function calculateProgress(userId, appId):
  allItems = db.onboarding_checklist_state.find({
    user_id: userId,
    app_id: appId
  })

  // Count items, excluding dismissed ones
  totalItems = 0
  completedItems = 0

  for state in allItems:
    if state.dismissed or state.hidden_by_feature_flag:
      continue

    totalItems += 1

    if state.completed:
      completedItems += 1

  if totalItems == 0:
    percentage = 100
  else:
    percentage = (completedItems / totalItems) * 100

  return {
    total_items: totalItems,
    completed_items: completedItems,
    percentage: percentage
  }
```

---

## Profile Completion Nudge Implementation

### Server-Side: Check Profile Completeness

```pseudocode
GET /api/onboarding/profile-status:
  user = getAuthenticatedUser(request)
  appId = getCurrentAppId()
  config = getOnboardingConfig()

  fieldsToCheck = config.profile_completion_nudge.fields_to_check
  // e.g., ["display_name", "avatar"]

  missingFields = []
  for field in fieldsToCheck:
    if field == 'display_name':
      if not user.display_name or user.display_name.trim() == '':
        missingFields.append('display_name')

    else if field == 'avatar':
      if not user.avatar_url or user.avatar_url == '':
        missingFields.append('avatar')

    else if field == 'bio':
      if not user.bio or user.bio.trim() == '':
        missingFields.append('bio')

    else:
      // Generic field check
      if not user[field]:
        missingFields.append(field)

  isProfileComplete = missingFields.length == 0

  // Check if nudge dismissed this session
  sessionId = request.cookies['session_id']
  dismissedThisSession = db.profile_completion_nudge_dismissals.findOne({
    user_id: user.user_id,
    session_id: sessionId,
    created_at: { $gt: sessionStartTime }
  }) != null

  return response.json({
    user_id: user.user_id,
    is_profile_complete: isProfileComplete,
    missing_fields: missingFields,
    nudge_dismissed_this_session: dismissedThisSession
  })

POST /api/onboarding/profile-nudge/dismiss:
  user = getAuthenticatedUser(request)
  appId = getCurrentAppId()
  sessionId = request.cookies['session_id']

  db.profile_completion_nudge_dismissals.insert({
    user_id: user.user_id,
    app_id: appId,
    session_id: sessionId,
    dismissed_at: now(),
    created_at: now()
  })

  return response.json({
    dismissed: true,
    session_expires_at: getSessionExpiry()
  })
```

### Client-Side: Profile Nudge Component

```pseudocode
Component ProfileCompletionNudge:
  state:
    profileStatus = null
    visible = true
    loading = true

  onMount():
    response = await fetch('/api/onboarding/profile-status')
    profileStatus = response

    if profileStatus.is_profile_complete:
      visible = false
      return

    if profileStatus.nudge_dismissed_this_session:
      visible = false
      return

    loading = false

  handleNavigateToSettings():
    navigate('/settings/profile')

  handleDismiss():
    POST '/api/onboarding/profile-nudge/dismiss'
    visible = false

  render():
    if loading or not visible:
      return null

    config = getConfig('profile_completion_nudge')

    missingFieldsText = formatFieldList(profileStatus.missing_fields)
    // e.g., "display name and avatar"

    message = config.message
    // e.g., "Complete your profile to unlock all features"

    if config.style == 'banner':
      return (
        <Banner style="info" onClose={handleDismiss}>
          <BannerContent>
            <BannerText>{message}</BannerText>
            <BannerSubtext>Missing: {missingFieldsText}</BannerSubtext>
          </BannerContent>
          <BannerActions>
            <Button onClick={handleNavigateToSettings}>
              {config.cta_text}
            <CloseButton onClick={handleDismiss} />
        </Banner>
      )

    else if config.style == 'toast':
      return (
        <Toast position="bottom-right" onClose={handleDismiss}>
          <ToastText>{message}</ToastText>
          <Button onClick={handleNavigateToSettings} size="small">
            {config.cta_text}
        </Toast>
      )
```

---

## Integration with Auth System

### useAuth Hook / Context

Extend the existing auth context to expose onboarding state:

```pseudocode
hook useAuth():
  user = getAuthenticatedUser()
  onboardingState = {
    isNewUser: user.created_at > now - 7 days,
    checklistVisible: shouldShowChecklist(user),
    profileIncomplete: hasIncompleteProfile(user),
    checklistProgress: getChecklistProgress(user)
  }

  return {
    user,
    authenticated: user != null,
    onboarding: onboardingState,
    completeChecklistItem(itemId): completeItem(itemId),
    dismissProfileNudge(): dismissNudge()
  }
```

Usage in components:

```pseudocode
Component Dashboard:
  auth = useAuth()

  if not auth.authenticated:
    // Show pre-auth stepper
    return <PreAuthStepper />

  return (
    <DashboardLayout>
      if auth.onboarding.checklistVisible:
        <OnboardingChecklist />

      if auth.onboarding.profileIncomplete:
        <ProfileCompletionNudge />

      <MainContent>
        // ... dashboard content
  )
```

---

## Checking Item Completion: Feature Flags

For items with `completion_rule_type: 'feature_gate'`, the item is marked complete when a feature flag becomes enabled:

```pseudocode
// Before attempting to complete item
function canCompleteItem(item, user):
  if item.completion_rule_type == 'manual':
    return true
  else if item.completion_rule_type == 'feature_gate':
    return isFeatureFlagEnabled(item.completion_rule, userId: user.user_id)
  else:
    return false

// Automatic completion when feature flag is enabled
job syncChecklistItemsWithFeatureFlags():
  allItems = db.onboarding_checklist_items.find({
    completion_rule_type: 'feature_gate'
  })

  for item in allItems:
    if not isFeatureFlagEnabled(item.completion_rule):
      continue

    // Find all users with this item NOT completed
    states = db.onboarding_checklist_state.find({
      item_id: item.id,
      completed: false
    })

    for state in states:
      // Auto-complete
      state.completed = true
      state.completed_at = now()
      state.save()

      log('item_auto_completed', {
        user_id: state.user_id,
        item_id: item.id,
        reason: 'feature_flag_enabled'
      })
```

Schedule this job to run every 5-10 minutes.

---

## Edge Cases & Gotchas

### 1. Returning Users Who Already Completed Items

If a user completed checklist items in a previous session, they shouldn't see the full checklist again. However, they should be able to continue/review.

**Gotcha:** If `checklist_dismissed = true` but `percentage < 100`, show a collapsed/minimized version.

**Handling:**
```pseudocode
if checklist_dismissed and progress.percentage == 100:
  hide checklist entirely

if checklist_dismissed and progress.percentage < 100:
  show drawer: "You've completed X of Y items. [Expand] [Dismiss]"

if not checklist_dismissed:
  show full checklist
```

---

### 2. Feature Flag Added After Items Defined

If a new feature flag is added to an existing item, users who already have that item marked complete will be confused.

**Gotcha:** Users who completed the feature-gated item before the flag existed won't be affected. New users see the flag as optional (if feature not enabled).

**Handling:** Document that adding feature gates to existing items is a breaking change. Consider running a migration to re-show items to affected users, or accept that they won't see the updated rule.

---

### 3. Required Item Can't Be Completed

If a required item has `completion_rule_type: 'feature_gate'` and the flag is never enabled, the user is stuck with "incomplete" forever.

**Gotcha:** Users will see incomplete checklist indefinitely and can't dismiss it.

**Handling:** Don't mark required items as feature-gated. Or make feature-gated items optional.

```pseudocode
if item.required and item.completion_rule_type == 'feature_gate':
  throw ValidationError("Required items cannot be feature-gated")
```

---

### 4. Profile Fields Change Between Versions

If your app's profile schema evolves (e.g., "bio" becomes mandatory), existing users with incomplete profile won't be nudged for the new field.

**Gotcha:** Config is static. Users who completed profile before new field was added won't be re-nudged.

**Handling:** Manually trigger nudge for existing users, or accept that not all users will complete new fields.

---

### 5. Dismissal Across Sessions

Pre-auth stepper dismissal is stored in localStorage (client-side) for performance. If localStorage is cleared or user switches devices, they'll see stepper again.

**Gotcha:** No guarantee stepper is truly dismissed across all user sessions/devices.

**Handling:** Optional server-side tracking (`pre_auth_stepper_dismissals` table) syncs dismissal across devices. Client checks DB before showing stepper.

---

### 6. Analytics Tracking When Feature Flag Disabled

If `analytics_tracking` feature flag is disabled, events aren't recorded. This makes debugging/A/B testing harder.

**Gotcha:** No data on why users skip onboarding if tracking is off.

**Handling:** Always keep basic tracking on (dismissals, completions). Only disable detailed tracking (step views, interactions).

---

### 7. Profile Nudge Appears Infinite Times

If user never completes their profile, nudge appears on every new session. This could be annoying.

**Gotcha:** No permanent dismissal option for profile nudge (it's session-based).

**Handling:** After N dismissals, stop showing nudge entirely. Or add "Remind me later" with exponential backoff.

```pseudocode
function shouldShowProfileNudge(user):
  config = getConfig('profile_completion_nudge')
  if config.skip_profile_nudge:
    return false

  if hasIncompleteProfile(user):
    recentDismissals = db.profile_completion_nudge_dismissals.count({
      user_id: user.user_id,
      created_at: { $gt: now - 7 days }
    })

    if recentDismissals >= 5:
      // User has dismissed nudge 5+ times in past week
      return false

    return true

  return false
```

---

### 8. Concurrency: Item Completed Twice

User clicks "Complete" twice (slow network, double-click). Race condition updates state twice.

**Gotcha:** Item marked complete twice, progress calculation off.

**Handling:** Use idempotent endpoint. Check if already complete before updating.

```pseudocode
POST /api/onboarding/checklist/:itemId/complete:
  state = db.onboarding_checklist_state.findOne({...})

  // Idempotent: if already complete, return same response
  if state.completed:
    return response.json({
      item_id: itemId,
      completed: true,
      completed_at: state.completed_at
    })

  // Mark complete (only once)
  state.completed = true
  state.completed_at = now()
  state.save()
```

---

### 9. Database Inconsistency: Dismissed vs Completed

If user dismisses item, then feature flag enables it, should item reappear as completable?

**Gotcha:** `dismissed = true` but `completed = false`. State is ambiguous.

**Handling:** Clarify semantics:
- `dismissed = true` + `completed = false` → Item hidden from UI, but can be "un-dismissed"
- `dismissed = true` + `completed = true` → Item hidden and done

Or: Don't allow dismissing required items.

---

### 10. New Users After Large Config Change

If you completely redefine onboarding config (new steps, items, etc.), existing users still have old items in DB.

**Gotcha:** User sees mix of old and new items, orphaned DB rows.

**Handling:** Migration script to delete old items and reinitialize for all active users, or set config version and only show items matching current version.

```pseudocode
onboarding_checklist_items:
  id
  config_version: string  // e.g., "v1", "v2", "v3"
  ...

// Only show items from latest config version
GET /api/onboarding/checklist:
  currentVersion = getOnboardingConfigVersion()
  items = db.onboarding_checklist_items.find({
    app_id: appId,
    config_version: currentVersion
  })
```

---

## Configuration Examples

### Example 1: Minimal Onboarding (Pre-Auth Only)

```json
{
  "app_id": "myapp",
  "pre_auth_stepper": {
    "enabled": true,
    "steps": [
      {
        "id": "step_1",
        "title": "Welcome to MyApp",
        "description": "The fastest way to build.",
        "illustration_url": "https://cdn.example.com/stepper-1.svg",
        "cta_text": "Next",
        "cta_action": "next_step"
      },
      {
        "id": "step_2",
        "title": "Collaborate with your team",
        "description": "Invite teammates and build together.",
        "illustration_url": "https://cdn.example.com/stepper-2.svg",
        "cta_text": "Let's go",
        "cta_action": "next_step"
      }
    ]
  },
  "onboarding_checklist": {
    "enabled": false
  },
  "profile_completion_nudge": {
    "enabled": false
  }
}
```

### Example 2: Full Onboarding Flow

```json
{
  "app_id": "myapp",
  "pre_auth_stepper": {
    "enabled": true,
    "steps": [
      {
        "id": "step_1",
        "title": "Welcome",
        "description": "MyApp is the fastest way to ship.",
        "illustration_url": "https://cdn.example.com/stepper-1.svg",
        "cta_action": "next_step"
      }
    ]
  },
  "onboarding_checklist": {
    "enabled": true,
    "headline": "Get started in 3 steps",
    "show_progress_bar": true,
    "items": [
      {
        "item_key": "profile_complete",
        "label": "Complete your profile",
        "description": "Add your name and photo",
        "link_path": "/settings/profile",
        "completion_rule": "profile.display_name",
        "required": false,
        "feature_flag": null
      },
      {
        "item_key": "first_project",
        "label": "Create your first project",
        "description": "Get hands-on in 2 minutes",
        "link_path": "/projects/new",
        "completion_rule": "projects_enabled",
        "completion_rule_type": "feature_gate",
        "required": false,
        "feature_flag": "projects_v1"
      },
      {
        "item_key": "invite_team",
        "label": "Invite your team",
        "description": "Build together faster",
        "link_path": "/settings/team",
        "completion_rule": "team_members_count >= 1",
        "required": false,
        "feature_flag": null
      }
    ]
  },
  "profile_completion_nudge": {
    "enabled": true,
    "style": "banner",
    "message": "Complete your profile to unlock team features",
    "cta_text": "Go to settings",
    "fields_to_check": ["display_name", "avatar"]
  },
  "feature_flags": {
    "force_onboarding": false,
    "skip_profile_nudge": false,
    "analytics_tracking": true
  }
}
```

---

## Metrics & Analytics

Track these events for insights:

```
Events:
  - stepper_viewed (pre-auth)
  - stepper_dismissed (pre-auth)
  - stepper_completed (pre-auth, all steps seen)
  - checklist_viewed (post-auth, first load)
  - checklist_item_completed (per item)
  - checklist_item_dismissed (per item)
  - checklist_all_completed (progress = 100%)
  - checklist_dismissed (user skipped early)
  - profile_nudge_shown (first impression per session)
  - profile_nudge_dismissed (user closed nudge)
  - profile_nudge_acted (user navigated to settings)

Metrics:
  - Stepper completion rate (% users who see all steps)
  - Checklist completion time (avg hours from first view to 100%)
  - Checklist item completion by item (which items are blockers?)
  - Profile completion rate (% users with complete profiles)
  - Profile nudge effectiveness (% of nudge views that lead to action)
```

Use these to optimize onboarding copy, ordering, and difficulty.

