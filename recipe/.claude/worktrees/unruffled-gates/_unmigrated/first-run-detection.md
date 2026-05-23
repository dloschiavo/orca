---
name: First-Run State Detection
description: Mechanism to detect when a user has no data yet and render contextual empty states with guided prompts
type: project
---

# First-Run State Detection

## Overview

First-run detection identifies when a user has no data in a given section and renders contextual empty states instead of blank screens. This recipe treats empty state detection as **per-section**, data-driven, and integrated with onboarding to guide users toward their first meaningful action.

**Core principle:** Don't ask "has the user seen this page?" — ask "does the user have data here?"

---

## 1. EmptyState Component Specification

The `EmptyState` component is a reusable, visually consistent container for all empty-state UX.

### Props Interface

```
EmptyState:
  icon: (required) IconName or Component
    - Semantic icon representing the empty section
    - Examples: "inbox-empty", "folder-empty", "chart-empty"

  title: (required) string
    - Concise heading (3–5 words)
    - Example: "No projects yet"

  description: (required) string
    - Context and encouragement (1–2 sentences)
    - Can include: why it's empty, what they can do, benefit of adding data

  primaryCta: (required) object
    label: string (action label, e.g., "Create Project")
    action: function or URL
      - Callback: function() → navigates or opens modal
      - URL: string path to creation flow

  secondaryCta: (optional) object
    label: string (e.g., "Learn more", "View examples")
    action: function or URL

  illustration: (optional) Component or URL
    - Custom SVG or image for this empty state
    - If omitted, use icon as fallback

  size: (optional) enum ["small", "medium", "large"]
    - small: condensed card or list-item context
    - medium: full-page (default)
    - large: hero-style with prominent illustration
```

### Layout & Styling

```
Structure (visual hierarchy):
  [Illustration/Icon - centered, 64–128px or custom]
  [Title - bold, ~24px, centered]
  [Description - body text, ~16px, centered, max-width 400px]
  [Primary CTA button - prominent, full-width or wide]
  [Secondary CTA link - subdued, optional]

Spacing:
  - Vertical gaps: 24–32px between sections
  - Horizontal margins: safe padding from container edges
  - Responsive: stack on mobile, center on desktop

Color & Tone:
  - Icon/illustration: use semantic color (e.g., blue for info, green for success)
  - Text: secondary/tertiary color hierarchy (not error red unless it's a failure state)
  - CTA buttons: primary brand color for main action
  - Background: inherit from container (no special background unless full-page)

Animation (recommended):
  - Fade-in on mount (200–300ms)
  - Subtle scale or slide-up (optional delight)
  - No interruption to user flow; keep it light
```

### Example Rendering

```
Dashboard (full-page empty state):
  ┌─────────────────────────────────────────────┐
  │                                             │
  │  ☐ (icon: chart-empty, 96px)                │
  │                                             │
  │  No projects yet                            │
  │                                             │
  │  Create your first project to get started.  │
  │  Track milestones, tasks, and team progress │
  │  in one place.                              │
  │                                             │
  │  [Create a Project] [View examples]         │
  │                                             │
  └─────────────────────────────────────────────┘

List view (small, condensed):
  ┌─ Your tasks               ────────┐
  │  ☐ (icon: check-square, 32px)    │
  │  No tasks                         │
  │  Add your first task →            │
  └───────────────────────────────────┘
```

---

## 2. Detection Pattern

Empty state detection is **per-section** and **data-driven**. Implement a reusable detection function/hook that checks for data presence.

### Detection Hook (Pseudocode)

```
function useIsEmpty(section: string, userId: string):
  section: "dashboard" | "projects" | "inbox" | "profile" | etc.
  userId: string (current user ID)

  returns: object
    isEmpty: boolean
    isLoading: boolean
    error: Error | null

  Logic:
    1. Load section-specific data from cache or API
    2. If loading, return { isEmpty: false, isLoading: true }
    3. If error, return { isEmpty: false, error: Error }
    4. Check section-specific "empty" condition:
       - "dashboard": user has no projects AND no recent activity
       - "projects": array length === 0
       - "inbox": message count === 0
       - "profile": required fields not filled
    5. Return { isEmpty: isDataEmpty, isLoading: false, error: null }
```

### Detection Function (Pseudocode)

```
function isEmptySection(section: string, userData: object):

  const emptyConditions = {
    "dashboard": (data) =>
      data.projects.length === 0 &&
      data.recentActivity.length === 0,

    "projects": (data) =>
      data.projects.length === 0,

    "inbox": (data) =>
      data.messages.length === 0,

    "profile": (data) =>
      !data.displayName || !data.avatar ||
      !data.bio,

    "settings": (data) =>
      false, // settings page always has defaults, never "empty"
  }

  const condition = emptyConditions[section]
  if (!condition) throw Error("Unknown section: " + section)

  return condition(userData)
```

### Key Points

- **Per-section:** Each section defines its own empty condition. The dashboard may be empty while the profile is complete.
- **Data-driven:** Check actual presence of data (count > 0, fields filled) instead of storing a "seen" flag.
- **Avoid stale flags:** If a user deletes all their projects, the dashboard should show empty state again — no flag checking.
- **Loading state separate:** While data loads, do NOT show empty state. Return `isLoading: true` and render a skeleton or spinner.

---

## 3. First-Visit vs Returning-Empty Differentiation

Not all empty states are the same. **First-time users** need more guidance; **returning users** who deleted data need different messaging.

### Heuristic for Differentiation

```
function detectFirstVisit(user: object, section: string):

  data:
    - user.createdAt (account creation timestamp)
    - user.lastVisitDate[section] (last time they viewed this section)
    - user.dataCount[section] (total items ever created in this section, cumulative)

  Logic:
    accountAgeInDays = now - user.createdAt
    hasEverHadData = user.dataCount[section] > 0
    daysSinceLastVisit = now - user.lastVisitDate[section]

    if (accountAgeInDays < 1) → isFirstVisit = true
      (brand new account, less than 24 hours)

    elif (hasEverHadData === false) → isFirstVisit = true
      (user never created anything in this section)

    elif (hasEverHadData === true && daysSinceLastVisit < 30) → isReturningEmpty
      (they had data, haven't visited recently, might have deleted it)

    elif (hasEverHadData === true && daysSinceLastVisit > 30) → isLapsed
      (returning after inactivity; encourage re-engagement)

    return { isFirstVisit, isReturningEmpty, isLapsed }
```

### Messaging Strategy

```
First-visit messaging:
  Title: "No projects yet"
  Description: "Create your first project to get started.
                Track milestones, tasks, and team progress."
  Tone: encouraging, educational
  CTA: Primary call to action toward creation
  Illustration: hero-style, larger, more illustrated

Returning-empty messaging:
  Title: "All clear!"
  Description: "You've completed all your projects.
                Create a new one to continue."
  Tone: celebratory, lighter
  CTA: "Create a new project" or "View completed projects"
  Illustration: simpler, more minimal

Lapsed/re-engagement messaging:
  Title: "Welcome back!"
  Description: "It's been a while. See what's changed,
                or start a new project."
  Tone: warm, welcoming
  CTA: "View your profile" or "Create a new project"
  Illustration: welcoming/celebratory
```

---

## 4. Integration with Onboarding

Empty states should guide first-time users progressively through key features.

### Progressive Disclosure Pattern

```
Onboarding flow:
  Step 1: User signs up
    → Account created, all sections empty

  Step 2: Show dashboard empty state
    → Primary CTA: "Create your first project"
    → This launches project creation modal

  Step 3: After first project created
    → Dashboard now shows the project
    → Empty state in "tasks" section appears
    → Secondary action: "View examples of popular tasks"

  Step 4: User explores, continues filling out profile
    → Profile section empty state guides completion
    → "Complete your profile" CTA

  Step 5: After key sections filled
    → Show tour or hint about advanced features
    → Disable empty-state prompts if user is active

Strategy:
  - Show empty states in order of onboarding importance
  - Use secondary CTAs to suggest next steps without blocking flow
  - Track which empty states user has interacted with
  - Don't show same empty state twice if user dismissed it

Metrics to track:
  - Time from first empty state to first creation
  - Which CTA was clicked (primary vs secondary)
  - Sections completed in first session
```

---

## 5. Common Empty State Templates

Pre-built templates for common patterns across applications.

### Dashboard / Home

```
Icon: chart, dashboard, or home
Title: "Welcome! Get started here"
Description: "Create your first [primary resource type]
              to begin tracking progress and collaborating
              with your team."
Primary CTA: "Create [Resource]"
Secondary CTA: "View examples"
Size: large
Illustration: hero-style with custom background
```

### List View / Collection

```
Icon: list, folder, or section-specific icon
Title: "No [items] yet"
Description: "Add your first [item] to get started."
Primary CTA: "Create [item]" or "Import from file"
Secondary CTA: "See sample data"
Size: medium
Illustration: icon-based or minimal
```

### Detail View / Drawer

```
Icon: detailed section icon
Title: "[Section] is empty"
Description: "This section will show [content type] once you have data."
Primary CTA: "Go create one" or "Add [item]"
Secondary CTA: none or "Learn more"
Size: small
Illustration: icon-based
```

### Search Results

```
Icon: search or magnifying glass
Title: "No results found"
Description: "Try searching for different keywords,
              or explore featured [items]."
Primary CTA: "Clear filters" or "Browse all"
Secondary CTA: "Save this search"
Size: medium
Illustration: minimal
Note: Differentiate from first-run empty state; this is "no match" not "no data"
```

### Error State (edge case)

```
Icon: alert, warning, or error
Title: "Something went wrong"
Description: "We couldn't load your data.
              Please refresh and try again."
Primary CTA: "Refresh page" or "Retry"
Secondary CTA: "Contact support"
Size: medium
Illustration: error-specific icon
Note: This is NOT an empty state per se, but related
```

---

## 6. Animated & Illustrated Empty States

Empty states are UX opportunities. Animations and custom illustrations improve engagement.

### Illustration Slot

```
Component accepts optional illustration prop:
  illustration: Component | URL string

  If provided:
    - Render custom SVG or image above title
    - Size: responsive (64–256px depending on context)
    - Aspect ratio: flexible (typically square or 4:3)

  If omitted:
    - Render semantic icon (32–64px) as fallback
    - Icon color: secondary or accent color

Benefits of custom illustration:
  - Increases perceived polish
  - Improves memorability of onboarding flow
  - Can convey tone (playful, professional, etc.)
  - Provides visual break on text-heavy pages

Gotcha:
  - Keep illustration simple and on-brand
  - Avoid overly cute/distracting illustrations for B2B products
  - Ensure alt text for accessibility
```

### Animation Recommendations

```
Mount animation:
  - Fade-in: 200–300ms ease-out
  - Optional: slide-up 24–32px simultaneously
  - Keep subtle; don't distract from CTA

Icon/illustration animation (optional delight):
  - Gentle bounce or pulse on mount (1–2 sec)
  - Hover effect: slight scale (1.05x) on illustration
  - CTA button: always interactive (color change, shadow on hover)

Examples:

  Pulse icon:
    @keyframes pulse
      0%: scale(1)
      50%: scale(1.05)
      100%: scale(1)
    duration: 2s, infinite

  Fade-in:
    @keyframes fadeIn
      0%: opacity(0), translateY(8px)
      100%: opacity(1), translateY(0)
    duration: 300ms ease-out

Don't:
  - Auto-play complex animations (can distract)
  - Use loud colors just because the page is empty
  - Animate on every state check (only on mount)
```

---

## 7. Gotchas & Edge Cases

### 1. Race Conditions with Loading States

**Problem:** Empty state flashes briefly before data loads, then content appears.

```
Prevention:

  if (isLoading) {
    return <SkeletonLoader /> // don't show empty state
  }

  if (isEmpty && !isLoading) {
    return <EmptyState ... />
  }

  return <Content ... />

Timing:
  - Skeleton should render immediately (no delay)
  - Actual data load in background (network calls)
  - Only show empty state after isLoading → false AND isEmpty === true
  - If data arrives, replace skeleton directly with content
```

### 2. Stale Empty States from Caching

**Problem:** Cache shows empty state even though user just added data in another tab.

```
Prevention:

  - Use cache busting on data mutations
  - On create/update/delete, invalidate section cache
  - Refetch data immediately after mutation
  - Use optimistic updates (show data before server confirms)

  Example:
    function createProject(name):
      // Optimistic: assume success
      addToLocalCache({ projects: [..., newProject] })

      // Update UI immediately (isLoading: false, isEmpty: false)

      // Confirm with server
      try:
        await API.createProject(name)
      catch:
        revertLocalCache() // rollback if server fails
        showError("Failed to create project")

  Caching library:
    - Use SWR, React Query, or similar
    - Set low staleTime for sections that change frequently
    - Manual revalidation after mutations
```

### 3. SSR Flashing

**Problem:** On SSR pages, client hydration may differ from server-rendered empty state.

```
Prevention:

  - Server: compute isEmpty at render time
  - Include detection logic in server template
  - Render empty state server-side (no hydration mismatch)

  Server pseudocode:
    function renderDashboard(req):
      user = getUser(req)
      isEmpty = isEmptySection("dashboard", user.data)

      if (isEmpty):
        return renderEmptyState({ section: "dashboard", ... })
      else:
        return renderContent({ data: user.data })

  Client:
    - Skip re-checking isEmpty on mount if server already rendered it
    - Use suppressHydrationWarning if minor SSR/client diff exists
    - Refetch data only after hydration completes

  Don't:
    - Render content on server, then switch to empty on client
    - Show loading state after hydration if content already there
```

### 4. Empty State When Data is Restricted

**Problem:** Section is empty because user lacks permissions, not because no data exists.

```
Prevention:

  Differentiate in detection:
    function useIsEmpty(section, userId):
      data = fetchData(section, userId)

      if (data.error && data.error.code === "UNAUTHORIZED"):
        return { isEmpty: false, isRestricted: true }

      if (data.isEmpty):
        return { isEmpty: true, isRestricted: false }

  Render different message:
    if (isRestricted):
      <EmptyState
        title="Access denied"
        description="You don't have permission to view this section.
                     Contact your admin."
      />
    elif (isEmpty):
      <EmptyState title="No data" ... />
```

### 5. Empty State in Modals/Drawers

**Problem:** EmptyState size="large" doesn't fit in a modal.

```
Prevention:

  - Always pass size prop to EmptyState based on context
  - size="small" for modals, dropdowns, popovers
  - size="medium" for pages, full-width sections
  - size="large" for hero/full-page only

  Example:
    <Modal>
      <EmptyState
        section="projects"
        size="small"
      />
    </Modal>
```

### 6. Overlapping Empty States (nested sections)

**Problem:** Both parent and child sections show empty states, confusing the user.

```
Prevention:

  - Only show empty state for the deepest non-empty level
  - If parent is empty, don't render children at all

  Example (dashboard with empty cards):
    function DashboardPage():
      if (isEmptyDashboard):
        return <EmptyState section="dashboard" />

      return <DashboardGrid>
        <ProjectCard project={...} /> // these render
        <MetricsCard /> // these render
        // don't show empty states inside these cards
      </DashboardGrid>
```

### 7. Accessibility & Alt Text

**Problem:** Illustration is purely decorative but blocks screen readers.

```
Prevention:

  - Use role="presentation" or aria-hidden="true" on decorative illustrations
  - Ensure alt text describes purpose, not just "image"

  Example:
    <img
      src="empty-projects.svg"
      alt="Illustration of empty projects list"
      role="presentation"
    />

  CTA buttons:
    - Always have descriptive text (not just icon)
    - <button>Create Project</button> not <button>+</button>

  Keyboard navigation:
    - Primary CTA must be focusable and clickable
    - Tab order: title → description → primary CTA → secondary CTA
```

---

## 8. Implementation Checklist

- [ ] Define empty-state condition for each section (per-section detection)
- [ ] Implement `useIsEmpty` hook or function
- [ ] Build reusable `EmptyState` component with all props
- [ ] Create empty-state templates for each section (dashboard, lists, detail)
- [ ] Set up differentiation between first-visit and returning-empty
- [ ] Integrate with onboarding flow (progressive disclosure)
- [ ] Add custom illustrations (or use semantic icons as fallback)
- [ ] Test race conditions (loading → data → empty transitions)
- [ ] Validate cache invalidation on mutations
- [ ] Verify SSR rendering matches client
- [ ] Add analytics to track empty-state CTAs
- [ ] Audit accessibility (alt text, keyboard nav, screen readers)
- [ ] Test empty states on mobile (responsive sizing)
- [ ] Document section-specific empty conditions in code comments

---

## 9. Quick Reference

| Aspect | Rule |
|--------|------|
| **Detection** | Data-driven, per-section, no stale flags |
| **Condition** | Check if count > 0 or required fields filled |
| **Loading** | Show skeleton, never empty state during load |
| **Messaging** | Different copy for first-visit vs returning-empty |
| **CTA** | Primary action always leads to creation or resolution |
| **Size** | small (modal), medium (page), large (hero) |
| **Illustration** | Custom SVG preferred; icon fallback if omitted |
| **Animation** | Fade-in 200–300ms on mount; keep subtle |
| **Cache** | Invalidate on mutations; use optimistic updates |
| **SSR** | Render empty state server-side to avoid flashing |
| **A11y** | Descriptive alt text, keyboard navigable, screen reader safe |
| **Onboarding** | Progressive disclosure; guide to first creation |

