---
name: Admin Dashboard
description: Admin-only dashboard showing signups, active users, revenue, churn, and key business metrics
type: project
---

# Admin Dashboard Recipe

## Overview

A backend-driven dashboard accessible only to admins, displaying real-time business metrics computed from existing user, subscription, and billing data. Metrics are aggregated server-side and refreshed on-demand via a single REST endpoint.

## Key Design Decisions

1. **Admin-only access**: Enforced via `requireAdmin()` from auth recipe before any data is returned.
2. **Server-side aggregation**: All metric calculations happen on the backend. Raw user, subscription, and billing data never reaches the client.
3. **Existing data sources**: Metrics are derived from `users`, `subscriptions`, and `invoices` collections—no separate analytics database required for MVP.
4. **Time ranges**: 7d, 30d, 90d, 12mo, all-time. Default is 30d.
5. **SPA architecture**: No server-side rendering needed; dashboard is admin-only and SEO is irrelevant.
6. **On-demand refresh**: Metrics refresh on page load and when time range changes. No auto-polling; admins manually refresh if needed.
7. **Server-side caching**: Aggregated metrics cached for 5 minutes per time range to minimize expensive DB aggregations.

---

## Metrics to Display

### Primary Metrics (Core Four)

1. **Signups**
   - Total new users over selected period
   - Daily/weekly chart showing signup trend
   - Trend indicator vs previous period

2. **Active Users**
   - DAU (Daily Active Users): users with activity in the last 24h
   - WAU (Weekly Active Users): users with activity in the last 7d
   - MAU (Monthly Active Users): users with activity in the last 30d
   - Optional: retention curve (% of cohort active after 1d, 7d, 30d)

3. **Revenue**
   - MRR (Monthly Recurring Revenue): sum of active monthly/annual plans normalized to 30d
   - Total revenue over period: sum of all invoice amounts
   - ARPU (Average Revenue Per User): total revenue / active subscriber count
   - Chart: revenue by day/week over period
   - Trend indicator vs previous period

4. **Churn**
   - Subscription cancellations over period
   - Churn rate (%): canceled subs / starting subscriber count
   - Net subscriber change: (new - canceled) over period
   - Trend indicator

### Secondary Metrics (Enhancements)

5. **Plan Distribution**
   - Active subscribers per plan (pie or bar chart)
   - % breakdown

6. **Trial Conversion**
   - Trial starts over period
   - Trial-to-paid conversions over period
   - Conversion rate (%)
   - Trend indicator

---

## Dashboard Layout

### Visual Structure

```
┌─────────────────────────────────────────────────────────────┐
│  Admin Dashboard                [Time Range Selector: 30d ▼] │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐         │
│  │ Signups      │ │ Active Users │ │ Revenue      │         │
│  │ 1,234 ↑ 12%  │ │ 5,678 ↑ 8%   │ │ $45,678 ↑ 5% │         │
│  └──────────────┘ └──────────────┘ └──────────────┘         │
│  ┌──────────────┐                                             │
│  │ Churn Rate   │                                             │
│  │ 2.3% ↓ 0.5%  │                                             │
│  └──────────────┘                                             │
│                                                               │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  Chart: Signups (Line)                                       │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                          ╱╲       ╱╲                │    │
│  │                  ╱╲    ╱        ╱    ╲              │    │
│  │        ╱╲╲    ╱    ╱╲╱                              │    │
│  │      ╱        ╱                                      │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                               │
│  Chart: Revenue (Area)                                       │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                    ▓▓▓▓▓▓▓                          │    │
│  │              ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓                        │    │
│  │        ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓                  │    │
│  │    ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓                │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                               │
│  Chart: Plan Distribution (Pie)    Chart: Churn (Bar)       │
│  ┌────────────────┐                ┌────────────────┐       │
│  │      ◐◐◑       │                │  ▦▦▦  ▥▥▥  ▤▤▤  │       │
│  │    Plan A      │                │  Jan Feb Mar   │       │
│  │    Plan B      │                └────────────────┘       │
│  │    Plan C      │                                          │
│  └────────────────┘                                          │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

### Responsive Grid

- **Desktop (>1200px)**: 4-column metric card grid; charts in 2-column rows below
- **Tablet (768–1200px)**: 2-column metric grid; charts full-width
- **Mobile (<768px)**: 1-column metric grid; charts stacked full-width

---

## Metric Card Component

### Structure

```
┌──────────────────────────┐
│ Signups                  │
│ 1,234          [↑ 12%]   │
│ ▁▂▃▄▅▄▅▆▇▆▇█▇▆▅▄▃▂▁    │  <- Sparkline (optional)
└──────────────────────────┘
```

### Specification

- **Label**: metric name (Signups, Active Users, Revenue, Churn Rate, etc.)
- **Primary value**: large, bold number (formatted with thousands separator, $ for currency, % for rates)
- **Trend indicator**:
  - Arrow + percentage: `↑ 12%` (positive), `↓ 3%` (negative), `→ 0%` (neutral)
  - Color: green (↑), red (↓), gray (→)
- **Sparkline** (optional): mini line/bar chart showing last 7 or 30 data points, helps visualize trend at a glance
- **Tooltip**: hover to show "vs. previous period: +150 signups"

---

## Chart Specifications

### Signups Chart
- **Type**: Line or area chart
- **X-axis**: dates (daily or weekly bins depending on range)
- **Y-axis**: signup count
- **Color**: blue
- **Tooltip**: date, count, cumulative total

### Active Users (DAU/WAU/MAU)
- **Type**: Line chart with three series (DAU, WAU, MAU)
- **X-axis**: dates (daily)
- **Y-axis**: user count
- **Colors**: blue (DAU), orange (WAU), green (MAU)
- **Legend**: identify each series
- **Tooltip**: date, DAU, WAU, MAU

### Revenue Chart
- **Type**: Stacked area or single area chart
- **X-axis**: dates (daily or weekly)
- **Y-axis**: revenue amount (USD)
- **Color**: green
- **Format Y-axis as currency**: $0, $1k, $10k, etc.
- **Tooltip**: date, revenue, cumulative, MRR projection

### Churn Chart
- **Type**: Bar chart (cancellations) + optional line (churn rate %)
- **X-axis**: dates (weekly or monthly bins)
- **Y-axis (left)**: cancellation count
- **Y-axis (right)**: churn rate (%)
- **Colors**: red (cancellations), orange (rate line)
- **Tooltip**: period, cancellations, churn rate

### Plan Distribution
- **Type**: Pie or donut chart
- **Segments**: one per plan (Pro, Startup, Enterprise, Free, etc.)
- **Label format**: "Plan Name: 234 (12%)"
- **Tooltip**: plan name, count, percentage, MRR contribution

### Trial Conversion
- **Type**: Bar chart with overlay line
- **X-axis**: weeks or months
- **Y-axis (left)**: trial starts + conversions (bars)
- **Y-axis (right)**: conversion rate (%)
- **Colors**: light blue (starts), dark blue (conversions), red (rate line)
- **Tooltip**: period, starts, conversions, conversion rate

---

## API Routes

### Single Endpoint (Recommended)

```
GET /api/admin/dashboard?range=30d
```

**Query Parameters:**
- `range` (optional, enum): `7d`, `30d`, `90d`, `12mo`, `all` (default: `30d`)

**Response:**

```json
{
  "period": {
    "start": "2026-02-25T00:00:00Z",
    "end": "2026-03-26T23:59:59Z",
    "label": "Last 30 days",
    "range": "30d"
  },
  "metrics": {
    "signups": {
      "total": 1234,
      "trend": {
        "value": 150,
        "percent": 12.1,
        "direction": "up"
      },
      "daily": [
        { "date": "2026-02-25", "count": 38 },
        { "date": "2026-02-26", "count": 42 }
        // ...
      ]
    },
    "activeUsers": {
      "dau": 5678,
      "wau": 8234,
      "mau": 12456,
      "trend": {
        "value": 456,
        "percent": 8.0,
        "direction": "up"
      },
      "daily": [
        { "date": "2026-02-25", "dau": 5500, "wau": 8000, "mau": 12000 }
        // ...
      ]
    },
    "revenue": {
      "total": 45678.50,
      "mrr": 48000,
      "arpu": 3.67,
      "trend": {
        "value": 2100.50,
        "percent": 5.0,
        "direction": "up"
      },
      "daily": [
        { "date": "2026-02-25", "amount": 1450.25 }
        // ...
      ]
    },
    "churn": {
      "cancellations": 45,
      "rate": 2.3,
      "netChange": 105,
      "trend": {
        "value": -10,
        "percent": -18.2,
        "direction": "down"
      },
      "weekly": [
        { "week": "2026-02-25", "cancellations": 8, "rate": 2.1 }
        // ...
      ]
    },
    "planDistribution": [
      { "plan": "Startup", "count": 3456, "percent": 45.2, "mrr": 17280 },
      { "plan": "Pro", "count": 2345, "percent": 30.6, "mrr": 23450 },
      { "plan": "Enterprise", "count": 890, "percent": 11.6, "mrr": 8900 },
      { "plan": "Free", "count": 654, "percent": 8.5, "mrr": 0 }
    ],
    "trialConversion": {
      "trialStarts": 567,
      "conversions": 234,
      "rate": 41.3,
      "trend": {
        "value": 15,
        "percent": 6.9,
        "direction": "up"
      },
      "weekly": [
        { "week": "2026-02-25", "starts": 85, "conversions": 32, "rate": 37.6 }
        // ...
      ]
    }
  },
  "previousPeriod": {
    "signups": 1084,
    "revenue": 43578.50,
    "churn": { "cancellations": 55, "rate": 2.8 }
  }
}
```

**Security:**
- Require admin authentication before processing.
- Return 403 if user is not an admin.
- No PII in response (only aggregated counts, sums, rates).

### Alternative: Per-Metric Endpoints

If you prefer granular endpoints:

```
GET /api/admin/dashboard/signups?range=30d
GET /api/admin/dashboard/active-users?range=30d
GET /api/admin/dashboard/revenue?range=30d
GET /api/admin/dashboard/churn?range=30d
GET /api/admin/dashboard/plan-distribution?range=30d
GET /api/admin/dashboard/trial-conversion?range=30d
```

This approach allows clients to fetch only needed metrics and cache independently, but increases complexity. Recommended only if metrics have different refresh rates.

---

## Aggregation Queries (Pseudocode)

### Prerequisites

Assume collections: `users`, `subscriptions`, `invoices`, `activities`.

Field assumptions:
- `users`: `id`, `createdAt`, `email`, `status` (active/suspended)
- `subscriptions`: `id`, `userId`, `plan`, `status` (active/trialing/canceled), `currentPeriodStart`, `currentPeriodEnd`, `canceledAt`, `createdAt`, `price` (monthly equivalent)
- `invoices`: `id`, `subscriptionId`, `userId`, `amount`, `paidAt`, `createdAt`, `status` (paid/pending/failed)
- `activities`: `id`, `userId`, `type` (login/action/view), `timestamp`

### Signups

```pseudocode
function getSignups(startDate, endDate):
  newUsers = query(users)
    .where("createdAt >= startDate AND createdAt <= endDate")
    .select("id", "createdAt")

  daily = group(newUsers, by: "date(createdAt)")
    .aggregate(count: "id")

  previousCount = query(users)
    .where("createdAt >= (startDate - period) AND createdAt < startDate")
    .aggregate(count: "id")

  currentCount = len(newUsers)
  trendPercent = ((currentCount - previousCount) / previousCount) * 100

  return {
    total: currentCount,
    trend: {
      value: currentCount - previousCount,
      percent: trendPercent,
      direction: trendPercent > 0 ? "up" : "down"
    },
    daily: daily
  }
```

### Active Users (DAU, WAU, MAU)

```pseudocode
function getActiveUsers(startDate, endDate):
  // For each day in range, count unique users with activity in last 24h
  dau_data = []
  for each day in (startDate to endDate):
    activeTodayUsers = query(activities)
      .where("timestamp >= day - 24h AND timestamp < day")
      .select("userId")
      .distinct()
    dau_data.append({
      date: day,
      dau: count(activeTodayUsers),
      wau: countDistinct(userId) where timestamp in last 7d,
      mau: countDistinct(userId) where timestamp in last 30d
    })

  // Trend vs previous period
  previousDAU = query(activities)
    .where("timestamp >= (startDate - period - 24h) AND timestamp < (startDate - 24h)")
    .select("userId")
    .distinct()
    .count()

  currentDAU = query(activities)
    .where("timestamp >= (endDate - 24h) AND timestamp < endDate")
    .select("userId")
    .distinct()
    .count()

  trendPercent = ((currentDAU - previousDAU) / previousDAU) * 100

  return {
    dau: currentDAU,
    wau: countDistinct(userId) where timestamp in last 7d,
    mau: countDistinct(userId) where timestamp in last 30d,
    trend: {
      value: currentDAU - previousDAU,
      percent: trendPercent,
      direction: trendPercent > 0 ? "up" : "down"
    },
    daily: dau_data
  }
```

### Revenue

```pseudocode
function getRevenue(startDate, endDate):
  // Total revenue: sum of paid invoices
  paidInvoices = query(invoices)
    .where("paidAt >= startDate AND paidAt <= endDate AND status = 'paid'")

  totalRevenue = sum(paidInvoices, "amount")

  // Daily revenue
  dailyRevenue = group(paidInvoices, by: "date(paidAt)")
    .aggregate(sum: "amount")

  // MRR: sum of active subscriptions' monthly prices
  activeSubs = query(subscriptions)
    .where("status in ('active', 'trialing') AND currentPeriodEnd > now()")

  mrr = sum(activeSubs, field: "price") // price stored as monthly equivalent

  // For annual plans, divide by 12 when calculating MRR
  mrr = sum(activeSubs, field: "price / planDurationMonths")

  // ARPU: revenue / active subscriber count
  activeSubCount = count(activeSubs)
  arpu = totalRevenue / activeSubCount // if activeSubCount > 0

  // Trend vs previous period
  previousRevenue = query(invoices)
    .where("paidAt >= (startDate - period) AND paidAt < startDate AND status = 'paid'")
    .aggregate(sum: "amount")

  trendPercent = ((totalRevenue - previousRevenue) / previousRevenue) * 100

  return {
    total: totalRevenue,
    mrr: mrr,
    arpu: arpu,
    trend: {
      value: totalRevenue - previousRevenue,
      percent: trendPercent,
      direction: trendPercent > 0 ? "up" : "down"
    },
    daily: dailyRevenue
  }
```

### Churn

```pseudocode
function getChurn(startDate, endDate):
  // Canceled subscriptions in period
  canceledSubs = query(subscriptions)
    .where("canceledAt >= startDate AND canceledAt <= endDate")

  cancellationCount = count(canceledSubs)

  // Starting subscriber count (active at startDate)
  startingCount = query(subscriptions)
    .where("status in ('active', 'trialing') AND createdAt < startDate AND (canceledAt is null OR canceledAt >= startDate)")
    .count()

  // Churn rate
  churnRate = (cancellationCount / startingCount) * 100 // if startingCount > 0

  // New subscriptions in period
  newSubs = query(subscriptions)
    .where("createdAt >= startDate AND createdAt <= endDate AND status != 'canceled'")
    .count()

  // Net change
  netChange = newSubs - cancellationCount

  // Weekly/monthly cancellations
  cancellationsByWeek = group(canceledSubs, by: "week(canceledAt)")
    .aggregate(count: "id", churnRate: (count / startingCount) * 100)

  // Trend (churn rate vs previous period)
  previousCancelCount = query(subscriptions)
    .where("canceledAt >= (startDate - period) AND canceledAt < startDate")
    .count()

  previousStarting = query(subscriptions)
    .where("createdAt < (startDate - period) AND (canceledAt is null OR canceledAt >= (startDate - period))")
    .count()

  previousChurnRate = (previousCancelCount / previousStarting) * 100

  trendRateChange = churnRate - previousChurnRate

  return {
    cancellations: cancellationCount,
    rate: churnRate,
    netChange: netChange,
    trend: {
      value: cancellationCount - previousCancelCount,
      percent: ((cancellationCount - previousCancelCount) / previousCancelCount) * 100,
      direction: churnRate < previousChurnRate ? "down" : "up"
    },
    weekly: cancellationsByWeek
  }
```

### Plan Distribution

```pseudocode
function getPlanDistribution(startDate, endDate):
  // Active subscribers per plan (current snapshot)
  activeSubs = query(subscriptions)
    .where("status in ('active', 'trialing')")

  byPlan = group(activeSubs, by: "plan")
    .aggregate(
      count: "id",
      mrrSum: sum("price")
    )

  totalActive = sum(byPlan, "count")

  result = []
  for each planGroup in byPlan:
    result.append({
      plan: planGroup.plan,
      count: planGroup.count,
      percent: (planGroup.count / totalActive) * 100,
      mrr: planGroup.mrrSum
    })

  return result
```

### Trial Conversion

```pseudocode
function getTrialConversion(startDate, endDate):
  // Trial subscriptions started in period
  trialStarts = query(subscriptions)
    .where("createdAt >= startDate AND createdAt <= endDate AND status = 'trialing'")

  startCount = count(trialStarts)

  // Trials converted to paid in period
  converted = query(subscriptions)
    .where("createdAt >= startDate AND createdAt <= endDate AND status = 'trialing'")
    .andWhere("status changed to 'active' within same period")

  conversionCount = count(converted)
  conversionRate = (conversionCount / startCount) * 100 // if startCount > 0

  // Weekly breakdown
  weeklyData = group(trialStarts, by: "week(createdAt)")
    .aggregate(
      starts: count("id"),
      conversions: count(conversions in same week),
      rate: (conversions / starts) * 100
    )

  // Trend vs previous period
  previousStarts = query(subscriptions)
    .where("createdAt >= (startDate - period) AND createdAt < startDate AND status = 'trialing'")
    .count()

  previousConverted = count(subscriptions converted in previous period)
  previousRate = (previousConverted / previousStarts) * 100

  trendPercent = ((conversionRate - previousRate) / previousRate) * 100

  return {
    trialStarts: startCount,
    conversions: conversionCount,
    rate: conversionRate,
    trend: {
      value: conversionCount - previousConverted,
      percent: trendPercent,
      direction: trendPercent > 0 ? "up" : "down"
    },
    weekly: weeklyData
  }
```

---

## Time Range Handling

### Supported Ranges

| Range | Duration | Example (today = 2026-03-26) |
|-------|----------|-----|
| 7d    | 7 days   | 2026-03-19 to 2026-03-26 |
| 30d   | 30 days  | 2026-02-25 to 2026-03-26 |
| 90d   | 90 days  | 2025-12-27 to 2026-03-26 |
| 12mo  | 12 months| 2025-03-26 to 2026-03-26 |
| all   | all time | 2020-01-01 to now         |

### Date Calculation Pseudocode

```pseudocode
function getPeriod(range):
  endDate = now() (end of today, UTC)

  switch range:
    case "7d":
      startDate = endDate - 7 days
      label = "Last 7 days"
    case "30d":
      startDate = endDate - 30 days
      label = "Last 30 days"
    case "90d":
      startDate = endDate - 90 days
      label = "Last 90 days"
    case "12mo":
      startDate = endDate - 365 days
      label = "Last 12 months"
    case "all":
      startDate = earliest user createdAt date
      label = "All time"

  return {
    start: startDate,
    end: endDate,
    label: label,
    range: range
  }

function getPreviousPeriod(period):
  duration = period.end - period.start
  previousStart = period.start - duration
  previousEnd = period.start - 1 second

  return {
    start: previousStart,
    end: previousEnd
  }
```

### Timezone Considerations

- **Database storage**: all timestamps in UTC
- **API responses**: all timestamps as ISO 8601 with Z (UTC)
- **Client display**: convert to admin's local timezone for rendering dates in charts and tables
- **Daily binning**: bin by UTC date, not local date (avoids edge case errors in aggregation)
- **Period start/end**: use 00:00:00 UTC (start) and 23:59:59 UTC (end)

---

## Caching Strategy

### Goal
Avoid expensive database aggregations on every page load while keeping metrics reasonably fresh.

### Implementation

```pseudocode
function getDashboard(range):
  cacheKey = f"dashboard_{range}"
  cached = cache.get(cacheKey)

  if cached is not null and cached.expiresAt > now():
    return cached.data

  // Compute all metrics
  data = {
    period: getPeriod(range),
    metrics: {
      signups: getSignups(...),
      activeUsers: getActiveUsers(...),
      revenue: getRevenue(...),
      churn: getChurn(...),
      planDistribution: getPlanDistribution(...),
      trialConversion: getTrialConversion(...)
    },
    previousPeriod: {
      signups: count from previous period,
      revenue: sum from previous period,
      churn: { cancellations, rate } from previous period
    }
  }

  // Cache with 5-minute TTL
  cache.set(cacheKey, data, ttl: 5 minutes)

  return data
```

### Cache Invalidation

- **Automatic**: 5-minute TTL (cache expires and is recomputed)
- **Manual**: admin clicks "Refresh" button → clear cache for current range and re-fetch
- **Event-driven** (optional enhancement):
  - On new subscription: invalidate `revenue`, `planDistribution`, `activeUsers` caches
  - On cancellation: invalidate `churn`, `revenue`, `planDistribution` caches
  - On new user signup: invalidate `signups`, `activeUsers` caches

### Cache Keys by Range

```
dashboard_7d
dashboard_30d
dashboard_90d
dashboard_12mo
dashboard_all
```

---

## Security

### Authentication & Authorization

```pseudocode
async function handleGET_AdminDashboard(request, response):
  // 1. Verify user is authenticated
  user = requireAuth(request)
  if user is null:
    return 401 Unauthorized

  // 2. Verify user is admin
  isAdmin = requireAdmin(user)
  if not isAdmin:
    return 403 Forbidden

  // 3. Validate range parameter
  range = request.query.range or "30d"
  if range not in ["7d", "30d", "90d", "12mo", "all"]:
    return 400 Bad Request

  // 4. Compute or retrieve cached metrics
  data = getDashboard(range)

  // 5. Return aggregated data only (no PII)
  return 200 OK {
    data: data
  }
```

### Data Handling

- **Never include in response**: user emails, names, phone numbers, billing addresses, payment methods, subscription details of individual users
- **Always aggregate**: counts, sums, rates, percentages
- **Audit logging**: log all admin dashboard accesses (timestamp, admin user ID, range queried)

### Rate Limiting

Implement per-admin rate limiting:
- Max 10 requests per minute per admin user
- Prevents accidental/malicious dashboard spam

---

## Gotchas & Edge Cases

### 1. Timezone Edge Cases in Daily Counts

**Problem**: If binning by local date instead of UTC, daily counts may shift depending on admin's timezone.

**Solution**: Always bin by UTC date in aggregation queries. Store all timestamps in UTC. Convert to local time only for display.

```pseudocode
// ✗ Wrong (timezone-dependent)
dailyCounts = group(users, by: "date_in_local_tz(createdAt)")

// ✓ Correct
dailyCounts = group(users, by: "date_utc(createdAt)")
```

### 2. MRR Calculation with Annual Plans

**Problem**: A $1200/year plan should contribute $100/month to MRR, not $1200.

**Solution**: Normalize all plan prices to a monthly equivalent when calculating MRR.

```pseudocode
// Store in subscriptions.price: monthly equivalent
// e.g., annual $1200 plan -> stored as price: 100

function calculateMRR(subscriptions):
  return sum(subscriptions where status in ('active', 'trialing'), "price")

// Or normalize on the fly:
for each sub in subscriptions:
  if sub.billingCycle == "annual":
    monthlyPrice = sub.price / 12
  else:
    monthlyPrice = sub.price
  mrrSum += monthlyPrice
```

### 3. Counting Free Plan Users in Churn

**Problem**: Free plan users have no subscription record; churn rate calculation breaks if denominator includes free users.

**Solution**: Churn rate = (canceled paid subscriptions / starting paid subscribers) × 100. Exclude free users.

```pseudocode
function getChurn(startDate, endDate):
  // Only count paid subscriptions
  canceledPaidSubs = query(subscriptions)
    .where("canceledAt >= startDate AND plan != 'free'")

  startingPaidCount = query(subscriptions)
    .where("createdAt < startDate AND plan != 'free' AND (canceledAt >= startDate OR canceledAt is null)")

  churnRate = (count(canceledPaidSubs) / startingPaidCount) * 100
```

### 4. Active User Counting (Session vs. Record-Based)

**Problem**: Should DAU count users with a login, or any activity (view, click, etc.)?

**Solution**: Define explicitly in spec. Recommended: any logged activity (login, action, view, api call). Store all user activities in a dedicated `activities` table.

```pseudocode
// Activity types to count:
// - "login": user authenticated
// - "action": user performed in-app action
// - "view": user viewed a page
// - "api_call": user called an API endpoint

activeTodayUsers = query(activities)
  .where("timestamp >= today and type in ('login', 'action', 'view', 'api_call')")
  .select("userId")
  .distinct()
```

### 5. Trial Conversion Window

**Problem**: If a trial started on day 1 but converts on day 35, should it count in the same period?

**Solution**: Define explicitly. Recommended: count conversions that happen within the queried period, regardless of when the trial started. Separately track "trial starts in period" vs. "all trials that convert in period".

```pseudocode
// Trial starts in period
trialStarts = query(subscriptions)
  .where("createdAt >= startDate AND status = 'trialing'")

// Trials (started anytime) that converted in period
conversionsInPeriod = query(subscriptions)
  .where("status changed from 'trialing' to 'active' between startDate and endDate")

// Conversion rate for cohort started in period
trialStartsInPeriod = query(subscriptions)
  .where("createdAt >= startDate AND status = 'trialing'")
conversionsFromCohort = count(conversionsInPeriod where original createdAt >= startDate)
cohortConversionRate = (conversionsFromCohort / trialStartsInPeriod) * 100
```

### 6. Suspended/Inactive User Handling

**Problem**: Should suspended users count toward DAU/active users?

**Solution**: Exclude suspended users from all activity-based metrics.

```pseudocode
activeUsers = query(activities)
  .where("timestamp >= startDate")
  .where("userId in (select id from users where status = 'active')")
  .select("userId")
  .distinct()
```

### 7. Empty Periods

**Problem**: If no data exists for a date, should the chart show a gap or zero?

**Solution**: Always return zero values for gaps; don't omit dates. This keeps charts continuous and prevents misalignment.

```pseudocode
// ✓ Correct (includes all dates, even with zero)
dailySignups = [
  { date: "2026-02-25", count: 10 },
  { date: "2026-02-26", count: 0 },  // no signups
  { date: "2026-02-27", count: 5 }
]
```

---

## Frontend Checklist

- [ ] Authentication check on page load; redirect to login if not authenticated
- [ ] Authorization check; show 403 error if user is not admin
- [ ] Time range selector (7d, 30d, 90d, 12mo, all); default to 30d
- [ ] "Refresh" button to manually clear cache and re-fetch
- [ ] Metric cards with label, value, trend arrow, sparkline
- [ ] Responsive grid layout (4-col desktop, 2-col tablet, 1-col mobile)
- [ ] Charts (line, area, bar, pie) with tooltips and legends
- [ ] Loading states while fetching data
- [ ] Error handling (display message if API returns 403, 500, etc.)
- [ ] Format numbers: thousands separator (1,234), currency ($45,678.50), percentages (5.2%)
- [ ] Timezone: convert UTC timestamps to admin's local timezone for display

---

## Backend Checklist

- [ ] Implement `requireAdmin()` auth middleware
- [ ] Implement `/api/admin/dashboard` endpoint with `range` query parameter
- [ ] Validate range parameter (enum: 7d, 30d, 90d, 12mo, all)
- [ ] Implement all aggregation queries (signups, active users, revenue, churn, plan distribution, trial conversion)
- [ ] Implement server-side cache (5-min TTL) keyed by time range
- [ ] Implement cache invalidation (manual "refresh" via cache-busting query param or header)
- [ ] Format response with ISO 8601 timestamps (UTC), numbers, strings per spec
- [ ] Include previous period summary for trend calculations
- [ ] Audit log: log all admin dashboard accesses (user ID, range, timestamp)
- [ ] Rate limit: max 10 requests/minute per admin user
- [ ] Error handling: return 401 if not authenticated, 403 if not admin, 400 if invalid range
- [ ] Test with various ranges, empty periods, and edge cases (annual plans, free users, suspended users)

---

## Success Criteria

- [ ] Dashboard loads in <2 seconds (with cache hit)
- [ ] All six metric types display correctly with accurate calculations
- [ ] Trend arrows and percentages match previous period comparison
- [ ] Charts render properly across desktop, tablet, mobile
- [ ] Time range selector works; results update when range changes
- [ ] No raw user/billing PII exposed in API responses
- [ ] Admin audit log captures all dashboard accesses
- [ ] Rate limiting prevents abuse
