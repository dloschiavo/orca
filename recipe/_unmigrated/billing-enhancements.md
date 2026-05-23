---
name: Billing Enhancements
description: Stripe-powered features for promo codes, usage metering, multiple payment methods, and flexible billing intervals
type: enhancement
requires: recipes/dev-ops.md, recipes/admin-dashboard.md
env_vars: STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY
---

# Billing Enhancements

Four advanced billing features (all conditional on Stripe being enabled via `STRIPE_SECRET_KEY`):

1. **Promo Code / Coupon Support** — Admin UI to create and manage Stripe coupons. Promo code validation and application at checkout.
2. **Usage Metering Hooks** — Track usage-based metrics per customer (API calls, storage, seats). Real-time dashboard. Threshold alerts.
3. **Multiple Payment Methods** — Customers can add, remove, and switch between payment cards. Secure card collection via Stripe SetupIntents.
4. **Annual vs Monthly Toggle** — Flexible billing intervals with configurable annual discounts. Plan switching with prorated pricing.

---

## Feature 1: Promo Code / Coupon Support

### Overview

Allow users to apply promotional codes at checkout. Admins create and manage coupons in Stripe via the admin panel. Each coupon can be:
- **Percentage discount** (e.g., 20% off)
- **Fixed amount** (e.g., $10 off)
- **Duration-based** (repeating, one-time, or permanently)
- **Redemption limits** (max number of uses, expiry date)

Stripe `Coupon` and `PromotionCode` objects model these rules. Validation occurs server-side before applying to a subscription.

### Data Models

**Promo Code Cache** (local table for reference tracking)

```
PromotionCodeCache {
  id:                    auto-generated primary key
  stripe_id:             string (unique)  // Stripe PromotionCode ID
  stripe_coupon_id:      string  // Reference to underlying Stripe Coupon
  code:                  string (unique)  // user-facing code, e.g., "SUMMER20"
  discount_type:         enum('percentage' | 'fixed_amount')
  discount_value:        number  // 20 for 20%, or 1000 for $10.00 (cents)
  currency:              string  // 'usd', 'eur', etc.
  duration:              enum('once' | 'repeating' | 'forever')
  duration_in_months:    integer  // if repeating, how many months (null if once/forever)
  max_redemptions:       integer  // null = unlimited
  redeemed_count:        integer  // local counter, updated via webhook
  expires_at:            datetime  // null = no expiry
  is_active:             boolean
  description:           string  // Admin notes
  created_by:            string  // admin user_id
  created_at:            datetime
  updated_at:            datetime
}

index on stripe_id, code, is_active
```

**Subscription Coupon Application** (denormalized in subscription model)

```
Subscription {
  // ... existing fields
  applied_coupon_code:   string  // e.g., "SUMMER20"
  applied_coupon_id:     string  // stripe promo code id
  discount_amount_cents: integer  // calculated at time of subscription
  discount_type:         enum('percentage' | 'fixed_amount')
  coupon_applied_at:     datetime
  coupon_expires_at:     datetime  // when discount ends (if duration is 'repeating')
}
```

### Admin UI: Coupon Management

```
[Page: /admin/billing/coupons]

[Heading: "Promo Codes & Coupons"]
[Create new coupon button]

[Coupons Table]:
  Code        | Discount    | Duration    | Max Uses | Redeemed | Expires    | Status
  SUMMER20    | 20% off     | One-time    | 100      | 87       | Apr 1      | Active
  SPRING10    | $10 off     | Forever     | Unlimited| 456      | Never      | Active
  EARLY2024   | 15% off     | 3 months    | 50       | 50       | Feb 28     | Expired

[Click row to edit]
[Bulk actions: Export, Disable, Delete]
```

### Create/Edit Coupon Form

```
[Modal: "Create Promo Code"]

Code: [text input] "SUMMER20"  [Generate random button]
Description: [textarea] "Summer campaign 2024"

Discount Type: [radio]
  ○ Percentage
    Percentage: [slider 0-100] 20
  ○ Fixed Amount
    Amount: [currency input] 10.00
    Currency: [dropdown] USD

Duration: [dropdown]
  ○ One-time (applied once per customer)
  ○ Repeating
    Months: [input] 3
  ○ Forever

Redemption:
  Max Redemptions: [checkbox] ☑
    Max Uses: [input] 100
  Expiry: [checkbox] ☑
    Expires At: [date picker] Apr 1, 2024

Active: [toggle switch] ON

[Create] [Cancel] buttons
```

### API Endpoints

#### POST `/admin/api/billing/coupons`

Create a new coupon in Stripe and cache locally.

**Request:**
```
{
  code: string,  // "SUMMER20"
  description?: string,
  discount_type: "percentage" | "fixed_amount",
  discount_value: number,  // 20 for 20%, 1000 for $10.00
  currency?: string,  // defaults to account currency
  duration: "once" | "repeating" | "forever",
  duration_in_months?: integer,
  max_redemptions?: integer,  // null = unlimited
  expires_at?: datetime,
  is_active: boolean
}
```

**Validation:**
- `code` must be unique and match `^[A-Z0-9_]+$` (6-50 chars)
- `discount_value` > 0
- If `duration == "repeating"`, `duration_in_months` must be 1-36
- If `max_redemptions` provided, must be > 0
- `expires_at` must be in future

**Response:**
```
{
  promotion_code: {
    id: string,
    stripe_id: string,
    code: string,
    discount_type: string,
    discount_value: number,
    duration: string,
    max_redemptions: integer,
    redeemed_count: integer,
    expires_at: datetime,
    is_active: boolean,
    created_at: datetime
  }
}
```

**Side effects:**
- Create `Coupon` object in Stripe
- Create `PromotionCode` object in Stripe pointing to the coupon
- Insert `PromotionCodeCache` record locally
- Log: "coupon_created" with code, discount_value, admin_user_id

#### GET `/admin/api/billing/coupons`

List all coupons with statistics.

**Query params:**
- `status?: "active" | "expired" | "all"` (default: "all")
- `limit?: integer` (default: 50)
- `offset?: integer` (default: 0)

**Response:**
```
{
  coupons: [
    {
      id: string,
      code: string,
      discount_type: string,
      discount_value: number,
      duration: string,
      max_redemptions: integer,
      redeemed_count: integer,
      expires_at: datetime,
      is_active: boolean,
      created_at: datetime
    }
  ],
  total: integer,
  offset: integer
}
```

#### PATCH `/admin/api/billing/coupons/:id`

Update coupon details.

**Request:** (any subset)
```
{
  description?: string,
  is_active?: boolean,
  max_redemptions?: integer,
  expires_at?: datetime
}
```

**Constraints:**
- Cannot change `discount_type`, `discount_value`, `currency`, or `duration` after creation (Stripe limitation)
- Can only deactivate or update expiry

**Response:**
```
{
  promotion_code: { ... }
}
```

**Side effects:**
- Update `PromotionCodeCache` locally
- Update Stripe coupon metadata if applicable
- Log change with before/after values

#### DELETE `/admin/api/billing/coupons/:id`

Deactivate and archive a coupon (soft-delete).

**Response:**
```
{
  status: "deleted"
}
```

**Side effects:**
- Set `is_active = false` in local table
- Set `expires_at = now()` in Stripe
- Log deletion with coupon code and admin_user_id

#### POST `/api/billing/validate-promo`

Client-side validation of a promo code (before checkout).

**Request:**
```
{
  code: string,
  plan_id?: string  // optional: validate against specific plan
}
```

**Response:**
```
{
  valid: boolean,
  code?: string,
  discount_type?: string,
  discount_value?: number,
  discount_display?: string,  // "20% off" or "$10 off"
  duration?: string,
  expires_at?: datetime,
  error?: string  // if not valid
}
```

**Validation logic:**
1. Look up code in PromotionCodeCache
2. Check is_active = true
3. Check expires_at > now
4. Check redeemed_count < max_redemptions (if set)
5. Return result

#### POST `/api/billing/apply-promo`

Apply promo code when creating/upgrading subscription.

**Request:**
```
{
  code: string,
  subscription_id?: string  // if upgrading existing subscription
}
```

**Response:**
```
{
  success: boolean,
  subscription: { ... },
  discount_applied: {
    discount_type: string,
    discount_value: number,
    discount_display: string
  },
  error?: string
}
```

**Server-side logic:**
1. Validate code (same checks as above)
2. Retrieve Stripe PromotionCode object
3. If creating subscription: pass `promotion_codes: [stripe_promo_id]` to Stripe API
4. If upgrading: update subscription with new coupon (Stripe handles prorating)
5. Update local `applied_coupon_code` field in subscription
6. Increment `redeemed_count` in PromotionCodeCache
7. Return updated subscription

**Webhook handler:**
- On `coupon.deleted` (Stripe webhook): mark local cache as inactive
- On `promotion_code.updated`: sync local cache

### Edge Cases

1. **Expired Coupon Mid-Checkout**
   - User applies promo, then delays checkout past expiry date
   - Validation endpoint returns `valid: false`
   - Client must show error and clear promo field

2. **Max Redemptions Reached**
   - Last valid user applies promo simultaneously with redemption threshold
   - Race condition: both succeed in Stripe, second fails in prorating
   - Handle: validate `redeemed_count < max_redemptions` server-side before subscription creation

3. **Coupon Expires Mid-Subscription**
   - Subscription created with 3-month duration coupon
   - After 3 months, discount expires but subscription continues at full price
   - Stripe handles this automatically; show expiry in invoice

4. **Plan-Specific Coupons**
   - Some coupons may only apply to specific plans
   - Store `applicable_plans: array[string]` in PromotionCodeCache
   - Validate plan_id in `/api/billing/validate-promo`

5. **Percentage Discount on Variable Pricing**
   - Usage-based plans with metered pricing
   - Discount applies to base subscription cost only, not overage charges
   - Document clearly in coupon details

---

## Feature 2: Usage Metering Hooks

### Overview

For usage-based pricing plans, track customer consumption of defined dimensions (API calls, storage, seats, etc.). Report usage to Stripe, which aggregates and bills based on rates. Customers see real-time dashboard showing current period consumption and forecasted costs. Threshold alerts notify when approaching limits.

### Data Models

**Usage Dimension** (configuration per plan)

```
UsageDimension {
  id:                    auto-generated primary key
  stripe_meter_id:       string (unique)  // Stripe Meter ID for this dimension
  app_id:                string  // which app uses this dimension
  name:                  string  // "api_calls", "storage_gb", "team_seats"
  display_name:          string  // "API Calls", "Storage (GB)", "Team Seats"
  unit:                  string  // "calls", "gb", "seats"
  description:           string
  price_per_unit:        number  // in cents; $0.01 per call = 1
  aggregation_method:    enum('sum' | 'max' | 'last_during_period')
  // sum: total calls across period
  // max: peak storage used in period
  // last_during_period: final value at end of period
  is_active:             boolean
  created_at:            datetime
  updated_at:            datetime
}

indexes on app_id, stripe_meter_id
```

**Usage Record** (local tracking for audit/caching)

```
UsageRecord {
  id:                    auto-generated primary key
  customer_id:           string  // Stripe customer ID
  dimension_id:          string  // references UsageDimension
  timestamp:             datetime
  quantity:              number  // units consumed
  idempotency_key:       string (unique)  // prevent duplicate reporting
  stripe_posted:         boolean  // whether sent to Stripe
  stripe_timestamp:      datetime  // when Stripe received it
  created_at:            datetime
}

indexes on customer_id, dimension_id, timestamp
composite index on idempotency_key for deduplication
```

**Usage Summary** (cached/aggregated for dashboard)

```
UsageSummary {
  id:                    auto-generated primary key
  customer_id:           string
  dimension_id:          string
  billing_period_start:  datetime
  billing_period_end:    datetime
  total_quantity:        number  // aggregated per dimension
  max_quantity:          number  // peak if aggregation_method = 'max'
  estimated_charge:      number  // in cents; total_quantity * price_per_unit
  created_at:            datetime
  updated_at:            datetime
}

indexes on customer_id, billing_period_start
```

**Threshold Alert** (configuration per customer-dimension)

```
ThresholdAlert {
  id:                    auto-generated primary key
  customer_id:           string
  dimension_id:          string
  threshold_quantity:    number  // alert when quantity > this
  alert_type:            enum('warning' | 'critical')
  // warning: at 80% of threshold
  // critical: at 100% of threshold
  enabled:               boolean
  notified_at:           datetime  // last time alert sent
  created_at:            datetime
  updated_at:            datetime
}

indexes on customer_id, dimension_id
```

### Usage Reporting API

#### POST `/api/usage/report`

Report usage consumption for a dimension.

**Request:**
```
{
  dimension: string,  // "api_calls", "storage_gb", etc.
  quantity: number,
  timestamp?: datetime,  // defaults to now
  idempotency_key?: string  // for deduplication
}
```

**Response:**
```
{
  success: boolean,
  recorded: {
    dimension: string,
    quantity: number,
    timestamp: datetime
  },
  error?: string
}
```

**Server-side logic:**
1. Authenticate request (API key or OAuth token)
2. Look up customer from auth context
3. Look up dimension by name; validate it exists
4. Check idempotency_key to avoid duplicate recording
5. Create UsageRecord in local database
6. Call Stripe Usage Records API: `stripe.billing.meters.events.create()`
7. Update UsageSummary cache
8. Check thresholds; send alert if exceeded
9. Return success

**Idempotency:**
- If same `idempotency_key` submitted twice, return 200 (not 400)
- This allows clients to retry safely without double-charging

#### GET `/api/usage/current-period`

Fetch current billing period usage for authenticated customer.

**Query params:**
- `dimension?: string` (optional; if omitted, return all dimensions)

**Response:**
```
{
  billing_period: {
    start: datetime,
    end: datetime,
    days_remaining: integer
  },
  usage: [
    {
      dimension: string,
      display_name: string,
      unit: string,
      quantity: number,
      price_per_unit: number,
      estimated_charge: number,  // in cents
      threshold?: {
        quantity: number,
        percentage_used: number  // 0-100
      }
    }
  ]
}
```

#### GET `/api/usage/history`

Fetch usage history for a date range.

**Query params:**
- `start_date: datetime`
- `end_date: datetime`
- `dimension?: string`

**Response:**
```
{
  periods: [
    {
      period: { start: datetime, end: datetime },
      usage: [
        {
          dimension: string,
          total_quantity: number,
          estimated_charge: number
        }
      ]
    }
  ]
}
```

### Usage Dashboard

```
[Page: /account/usage]

[Heading: "Current Billing Period Usage"]
Current Period: March 20 - April 19, 2024 (23 days remaining)

[Usage Cards]:
┌─────────────────────────────────────────────────┐
│ API Calls                                       │
│ 125,430 / 500,000 calls                         │
│ ████████░░░░░░░░░░░░░░░░░░░░  25.1%           │
│ Estimated charge: $12.54 of $50.00 monthly     │
│ Forecast end-of-period: ~$25.08                │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│ Storage                                         │
│ 450.2 GB / 1,000 GB                            │
│ ████████████████████░░░░░░░░░░  45.0%          │
│ Estimated charge: $90.04 of $100.00 monthly   │
└─────────────────────────────────────────────────┘

[Threshold Alerts]:
⚠ API Calls approaching threshold (25% remaining)
[Manage thresholds] button

[Usage By Month Table]:
Month    | API Calls | Storage   | Total
Mar 2024 | 4,200,000 | 450.2 GB  | $120.50
Feb 2024 | 3,100,000 | 380.0 GB  | $95.30
Jan 2024 | 2,800,000 | 320.5 GB  | $82.10
```

### Threshold Management UI

```
[Page: /account/billing/thresholds]

[Heading: "Usage Alerts & Thresholds"]

[For each dimension]:
┌─────────────────────────────────────────┐
│ API Calls                               │
│ Enable alerts: [toggle] ON              │
│ Alert when usage exceeds:               │
│   [radio] 80% of 500,000 (400,000)     │
│   [radio] Custom amount: [input] 350000│
│ Notification type:                      │
│   [checkbox] Email                      │
│   [checkbox] Slack webhook              │
│   [checkbox] SMS                        │
│ [Save]                                  │
└─────────────────────────────────────────┘
```

### Server-Side Usage Aggregation

```pseudocode
function aggregateUsageForPeriod(customerId, dimensionId, periodStart, periodEnd):
  records = queryDatabase(
    "SELECT SUM(quantity) as total_quantity FROM UsageRecord
    WHERE customer_id = ? AND dimension_id = ? AND timestamp BETWEEN ? AND ?",
    [customerId, dimensionId, periodStart, periodEnd]
  )

  dimension = loadDimension(dimensionId)
  totalQuantity = records.total_quantity || 0

  // Apply aggregation method
  switch dimension.aggregation_method:
    case 'sum':
      quantity = totalQuantity
    case 'max':
      quantity = queryDatabase(
        "SELECT MAX(quantity) FROM UsageRecord WHERE ..."
      ).max_quantity
    case 'last_during_period':
      quantity = queryDatabase(
        "SELECT quantity FROM UsageRecord
        WHERE ... ORDER BY timestamp DESC LIMIT 1"
      ).quantity

  estimatedCharge = quantity * dimension.price_per_unit

  // Cache summary
  upsertUsageSummary({
    customer_id: customerId,
    dimension_id: dimensionId,
    billing_period_start: periodStart,
    billing_period_end: periodEnd,
    total_quantity: quantity,
    estimated_charge: estimatedCharge
  })

  return {
    dimension_name: dimension.name,
    quantity: quantity,
    estimated_charge: estimatedCharge
  }

function checkUsageThresholds(customerId):
  thresholds = queryDatabase(
    "SELECT * FROM ThresholdAlert WHERE customer_id = ? AND enabled = true",
    [customerId]
  )

  for threshold in thresholds:
    currentPeriod = getCurrentBillingPeriod(customerId)
    usage = aggregateUsageForPeriod(
      customerId, threshold.dimension_id,
      currentPeriod.start, currentPeriod.end
    )

    percentageUsed = (usage.quantity / threshold.threshold_quantity) * 100

    // Send alert if exceeded
    if percentageUsed >= 100:
      sendAlert(customerId, threshold, "critical", percentageUsed)
    elif percentageUsed >= 80 AND threshold.alert_type == "warning":
      sendAlert(customerId, threshold, "warning", percentageUsed)

    // Update notified_at timestamp to prevent spam
    updateThreshold(threshold.id, { notified_at: now() })
```

### Billing Cycle Reset

```pseudocode
function resetUsageOnNewBillingCycle(subscriptionId, newPeriodStart, newPeriodEnd):
  // Called automatically when billing cycle renews
  // (Stripe webhook: invoice.created or subscription period change)

  customerId = getCustomerIdFromSubscription(subscriptionId)
  dimensions = queryDatabase(
    "SELECT id FROM UsageDimension WHERE app_id = ?",
    [getAppIdFromCustomer(customerId)]
  )

  for dimension in dimensions:
    // No explicit reset needed; usage records accumulate per period
    // Dashboard queries by billing_period_start/end to isolate periods
    // Threshold alerts check current period usage only
    logEvent("usage_period_reset", { customerId, newPeriodStart, newPeriodEnd })
```

### Stripe Integration

**Stripe Meters** (configuration):
- Each UsageDimension maps to a Stripe Meter (Stripe Billing Meters API)
- Meter defines aggregation type (sum, max, last)
- Price plan references meter for metered billing

**Usage Records Event** (reporting):
```pseudocode
POST /api/usage/report:
  // Create usage record locally, then post to Stripe
  record = createUsageRecord(request.body)

  stripeResponse = stripe.billing.meters.events.create({
    event_name: dimension.stripe_meter_id,
    properties: {
      stripe_customer_id: customerId,
      quantity: request.body.quantity,
      timestamp: request.body.timestamp || now()
    },
    idempotency_key: request.body.idempotency_key
  })

  if stripeResponse.ok:
    updateUsageRecord(record.id, { stripe_posted: true, stripe_timestamp: stripeResponse.timestamp })
    return success
  else:
    logError("Failed to post usage to Stripe", stripeResponse.error)
    return error (client should retry)
```

### Edge Cases

1. **Retroactive Usage Reporting**
   - Client reports usage with past timestamp (e.g., "API call at 10:00 AM, reported at 11:00 AM")
   - Stripe accepts events with up to 1 hour delay
   - Use `idempotency_key` to prevent duplicates if client retries

2. **Usage Spike / Overage**
   - Customer consumes 2x monthly quota in a single day
   - Usage dashboard shows 200% consumption
   - Threshold alert fires immediately
   - Invoice includes overage charges based on metered rate
   - Document in ToS that overages are charged

3. **Mid-Billing-Cycle Upgrade**
   - Customer on plan A upgrades to plan B on day 15 of 30
   - Usage for API calls resets or carries over? (Depends on plan design)
   - Proration: charge difference for remaining period
   - Recommendation: Reset usage on plan change; document in upgrade flow

4. **Threshold Alert Storm**
   - Customer crosses threshold multiple times in one period
   - Prevent alert spam: only send if `now() - notified_at > 1 hour`
   - Include "Do not disturb until" option in settings

5. **Usage Data Lag**
   - Event posted to Stripe, but summary dashboard hasn't aggregated yet
   - Dashboard may show stale data (5-10 minute delay acceptable)
   - Include "Last updated X minutes ago" timestamp in UI

6. **Free Trial or No Usage**
   - New customer has no usage records
   - Dashboard should show "No usage yet" gracefully
   - Dimension cards show 0/limit with 0% progress bar

7. **Meter Deprecation**
   - App retires an API dimension; want to stop metering it
   - Set `is_active = false` in UsageDimension
   - Dashboard stops showing it; historical data preserved
   - Don't delete old records (audit trail)

---

## Feature 3: Multiple Payment Methods

### Overview

Customers can securely add multiple payment methods (cards) to their account, select a default, and switch between them for recurring charges. Uses Stripe SetupIntent for PCI-compliant card tokenization. Fallback logic retries failed charges on alternative payment methods.

### Data Models

**Payment Method** (local cache of Stripe PaymentMethod)

```
PaymentMethod {
  id:                    auto-generated primary key
  stripe_id:             string (unique)  // Stripe PaymentMethod ID
  customer_id:           string  // Stripe customer ID
  type:                  enum('card')  // extensible: 'bank_account', etc.
  card_brand:            string  // 'visa', 'mastercard', 'amex'
  card_last_four:        string  // "4242"
  card_exp_month:        integer
  card_exp_year:         integer
  is_default:            boolean  // default for subscription charges
  is_verified:           boolean  // payment method verified (test charge passed)
  billing_name:          string  // cardholder name
  billing_address_line1: string
  billing_address_line2: string
  billing_city:          string
  billing_state:         string
  billing_postal_code:   string
  billing_country:       string
  created_at:            datetime
  updated_at:            datetime
  deleted_at:            datetime  // soft-delete when removed
}

indexes on customer_id, is_default, stripe_id
```

**Payment Method Retry Log** (fallback mechanism)

```
PaymentMethodRetry {
  id:                    auto-generated primary key
  invoice_id:            string  // Stripe invoice ID
  payment_method_id:     string  // primary payment method that failed
  retry_number:          integer  // 1st retry, 2nd retry, etc.
  attempted_payment_methods: array[string]  // list of payment_method_ids tried
  succeeded_with_id:     string  // which payment_method_id succeeded (if any)
  error_message:         string  // reason for each failure
  last_attempt_at:       datetime
  next_retry_at:         datetime
  status:                enum('pending' | 'succeeded' | 'exhausted')
  // exhausted: tried all available payment methods, all failed
}

indexes on invoice_id, status
```

### Payment Method Management API

#### POST `/api/payment-methods/create-setup-intent`

Initiate card collection via SetupIntent (secure, PCI-compliant).

**Request:**
```
{
  // No sensitive data in request; all handled by Stripe on client
}
```

**Response:**
```
{
  setup_intent_secret: string,  // Pass to Stripe.js on client
  client_secret: string  // alternative name
}
```

**Server-side logic:**
1. Authenticate request (session or OAuth)
2. Get customer's Stripe customer_id
3. Create Stripe SetupIntent:
   ```
   stripe.setup_intents.create({
     customer: stripe_customer_id,
     payment_method_types: ['card'],
     usage: 'off_session'  // for recurring charges without user present
   })
   ```
4. Return `client_secret` to client

#### POST `/api/payment-methods/confirm-setup-intent`

Client confirms card via Stripe.js, then server registers it locally.

**Request:**
```
{
  setup_intent_id: string,
  billing_name: string,
  billing_address: {
    line1: string,
    line2?: string,
    city: string,
    state: string,
    postal_code: string,
    country: string
  },
  set_as_default: boolean  // make this the default payment method
}
```

**Response:**
```
{
  success: boolean,
  payment_method: {
    id: string,
    card_brand: string,
    card_last_four: string,
    card_exp_month: integer,
    card_exp_year: integer,
    is_default: boolean
  },
  error?: string
}
```

**Server-side logic:**
1. Verify SetupIntent status (must be succeeded)
2. Retrieve payment_method_id from SetupIntent
3. If `set_as_default`, update old default's `is_default = false` in local table
4. Create/update PaymentMethod record locally:
   - Store Stripe payment_method_id, card details, billing address
   - Set is_default per request
   - Verify card with small test charge (optional; $0.01, refunded immediately)
5. Update Stripe customer's default payment method:
   ```
   stripe.customers.update(stripe_customer_id, {
     invoice_settings: {
       default_payment_method: stripe_payment_method_id
     }
   })
   ```
6. Return success

#### GET `/api/payment-methods`

List customer's saved payment methods.

**Response:**
```
{
  payment_methods: [
    {
      id: string,
      card_brand: string,
      card_last_four: string,
      card_exp_month: integer,
      card_exp_year: integer,
      is_default: boolean,
      is_verified: boolean,
      billing_name: string,
      billing_address: { ... },
      created_at: datetime,
      is_expired: boolean  // exp_year/month < today
    }
  ]
}
```

#### PATCH `/api/payment-methods/:id`

Update payment method (billing address, set as default).

**Request:**
```
{
  billing_name?: string,
  billing_address?: { ... },
  is_default?: boolean  // make this the default
}
```

**Response:**
```
{
  payment_method: { ... }
}
```

**Side effects:**
- Update local PaymentMethod record
- If `is_default: true`, update Stripe customer's default
- If billing address changed, no re-verification needed

#### DELETE `/api/payment-methods/:id`

Remove a payment method from account.

**Response:**
```
{
  status: "deleted"
}
```

**Validation:**
- Cannot delete if it's the only payment method (require at least one default)
- If deleted method is default, promote another to default automatically

**Side effects:**
- Soft-delete from local table (`deleted_at = now()`)
- Detach from Stripe customer:
   ```
   stripe.payment_methods.detach(stripe_payment_method_id)
   ```
- If was default, set next oldest payment method as new default

#### PATCH `/api/payment-methods/:id/set-default`

Quickly set a payment method as the default.

**Response:**
```
{
  payment_method: { ... }
}
```

### Account Settings UI

```
[Page: /account/billing/payment-methods]

[Heading: "Payment Methods"]

[Saved Cards]:
┌──────────────────────────────────────────────┐
│ 💳 Visa •••• 4242                           │
│ Expires: 12/25 | John Doe                   │
│ [Default] [Edit] [Remove]                   │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│ 💳 Mastercard •••• 5555                     │
│ Expires: 08/26 | Jane Doe                   │
│ [ ] Set as default  [Edit] [Remove]         │
└──────────────────────────────────────────────┘

[+ Add new card] button

[Modal: "Add Payment Method"]
[Stripe Card Element for secure input]
Name: [input field]
Address: [input fields]
[Save card] button
```

### Fallback Retry Logic

When a subscription charge fails:

```pseudocode
function handleFailedCharge(invoiceId, failureReason):
  invoice = stripe.invoices.retrieve(invoiceId)
  customerId = invoice.customer
  paymentMethodId = invoice.payment_method

  // Get all available payment methods for this customer
  savedMethods = queryDatabase(
    "SELECT id, stripe_id FROM PaymentMethod
    WHERE customer_id = ? AND deleted_at IS NULL
    ORDER BY is_default DESC, created_at DESC",
    [customerId]
  )

  if not savedMethods or len(savedMethods) == 0:
    // No backup payment methods; escalate to customer
    sendEmail(customerId, "payment_failed_no_backup", { invoiceId, failureReason })
    return

  // Retry with each available payment method
  retryLog = createPaymentMethodRetry({
    invoice_id: invoiceId,
    payment_method_id: paymentMethodId,
    status: 'pending',
    attempted_payment_methods: []
  })

  for (index, method) in enumerate(savedMethods):
    if method.stripe_id == paymentMethodId:
      continue  // already tried

    logDebug("Retrying charge with backup payment method", { invoiceId, method })

    result = stripe.payment_intents.create({
      customer: customerId,
      invoice: invoiceId,
      payment_method: method.stripe_id,
      confirm: true,
      off_session: true
    })

    retryLog.attempted_payment_methods.append(method.stripe_id)

    if result.status == 'succeeded':
      updatePaymentMethodRetry(retryLog.id, {
        status: 'succeeded',
        succeeded_with_id: method.stripe_id,
        last_attempt_at: now()
      })
      sendEmail(customerId, "payment_recovered", { invoiceId, paymentMethod: method })
      return

    else:
      logWarning("Backup payment method failed", { method, error: result.error })
      updatePaymentMethodRetry(retryLog.id, {
        last_attempt_at: now(),
        error_message: result.error.message
      })

  // All payment methods exhausted
  updatePaymentMethodRetry(retryLog.id, { status: 'exhausted' })
  sendEmail(customerId, "payment_failed_all_methods", { invoiceId })
  scheduleRetryAfterXDays(invoiceId, 3)

function scheduleRetryAfterXDays(invoiceId, days):
  // Attempt recharge in 3 days via Stripe's automatic retry schedule
  // Or trigger manual retry via webhook
```

### Webhook Events

```
charge.failed -> handleFailedCharge()
charge.succeeded -> logPaymentMethodUsed()
payment_method.attached -> syncPaymentMethodToLocal()
payment_method.detached -> markPaymentMethodDeleted()
setup_intent.succeeded -> confirmPaymentMethodSetup()
setup_intent.setup_failed -> notifyPaymentMethodFailed()
```

### Edge Cases

1. **Expired Card**
   - Card exp_year/month < today
   - Mark `is_expired = true` in PaymentMethod
   - Prevent selection as default
   - Prompt customer to update or remove

2. **SCA/3D Secure Challenge**
   - Charge requires additional authentication (3DS)
   - SetupIntent handles this on client via Stripe.js
   - Server waits for webhook confirmation before registering card

3. **Card Decline During Setup**
   - Customer adds card but bank declines test charge
   - Mark `is_verified = false` in PaymentMethod
   - Warn customer: "This card was declined. Please try another."

4. **Race Condition: Delete While Default**
   - Customer deletes payment method while it's being charged
   - Fallback logic tries to charge deleted method, fails
   - Automatically retry with next available method

5. **No Default Payment Method**
   - Subscription tries to charge but no default set
   - Pause subscription temporarily; email customer
   - Require customer to set default before resuming

6. **International Cards**
   - Card from non-USD country; currency mismatch
   - Stripe handles currency conversion via Billing Platform
   - Store `card_country` in PaymentMethod for reference

7. **Payment Method Reuse Across Subscriptions**
   - Same card on multiple subscriptions
   - If card deleted, all subscriptions need fallback
   - Query: `SELECT * FROM PaymentMethod WHERE stripe_id IN (SELECT payment_method FROM subscriptions)`

---

## Feature 4: Annual vs Monthly Toggle

### Overview

Offer customers choice between monthly and annual billing with a configurable discount (e.g., "2 months free" = 17% savings). Pricing page displays toggle to switch between intervals. Customers can change billing interval mid-subscription with prorated pricing handled by Stripe.

### Data Models

**Billing Plan** (price configuration)

```
BillingPlan {
  id:                    auto-generated primary key
  app_id:                string  // which app this plan belongs to
  plan_name:             string  // "pro", "enterprise"
  stripe_product_id:     string  // Stripe Product
  display_name:          string  // "Professional Plan"
  description:           string

  // Pricing per interval
  monthly_price_cents:   integer  // e.g., 4900 for $49.00
  annual_price_cents:    integer  // e.g., 49900 for $499.00 (17% discount)

  // Discount configuration
  annual_discount_type:  enum('percentage' | 'months_free' | 'fixed_amount')
  annual_discount_value: number  // 17 for 17%, 2 for 2 months free, 2000 for $20 off
  annual_savings_display: string  // "Save 17%" or "Save 2 months"

  // Stripe price IDs
  stripe_price_id_monthly: string  // Stripe Price object (monthly)
  stripe_price_id_annual:  string  // Stripe Price object (annual)

  features:              array[string]  // e.g., ["api_access", "analytics", "webhook_events"]
  limits:                object {  // per-plan limits
    api_calls_monthly?: integer,
    storage_gb?: integer,
    team_members?: integer
  }

  is_active:             boolean
  created_at:            datetime
  updated_at:            datetime
}

indexes on app_id, plan_name, stripe_product_id
```

**Subscription Interval Change Log** (audit trail)

```
SubscriptionIntervalChange {
  id:                    auto-generated primary key
  subscription_id:       string  // Stripe subscription ID
  customer_id:           string
  old_interval:          enum('month' | 'year')
  new_interval:          enum('month' | 'year')
  old_price_cents:       integer
  new_price_cents:       integer
  prorated_credit_cents: integer  // if switching from annual to monthly mid-cycle
  effective_date:        datetime
  created_at:            datetime
}

indexes on subscription_id, customer_id
```

### Pricing Page UI

```
[Page: /pricing]

[Heading: "Choose Your Plan"]

[Billing Interval Toggle]:
  Monthly | ◯ Annual (Save 17%)
  ○●──────◯

[Plans Grid]:

┌──────────────────────────────────────┐
│ Professional                         │
│ $49/month or $499/year (Save $88!)  │
│ ────────────────────────────────────│
│ ✓ API Access (10K calls/month)      │
│ ✓ Analytics Dashboard               │
│ ✓ Email Support                     │
│ ────────────────────────────────────│
│ [Subscribe Monthly] [Subscribe Annua│
└──────────────────────────────────────┘

┌──────────────────────────────────────┐
│ Enterprise                           │
│ $199/month or $1,990/year (Save $388)
│ ────────────────────────────────────│
│ ✓ Unlimited API Access              │
│ ✓ Advanced Analytics & ML           │
│ ✓ Dedicated Support                 │
│ ✓ SSO & Advanced Security           │
│ ────────────────────────────────────│
│ [Subscribe Monthly] [Subscribe Annual│
└──────────────────────────────────────┘

[Toggle changes pricing display and button labels in real-time]
```

### API Endpoints

#### GET `/api/billing/plans`

Fetch all active plans with pricing for selected interval.

**Query params:**
- `interval?: "month" | "year"` (default: "month")

**Response:**
```
{
  billing_interval: string,
  plans: [
    {
      id: string,
      plan_name: string,
      display_name: string,
      description: string,
      price_cents: number,
      price_display: string,  // "$49.00/month" or "$499.00/year"
      annual_discount?: {
        type: string,
        value: number,
        display: string  // "Save 17%" or "Save $88/year"
      },
      features: array[string],
      limits: object,
      stripe_price_id: string
    }
  ]
}
```

**Server-side logic:**
1. Query active BillingPlans
2. For each plan, return price based on `interval` param
3. Calculate and include annual discount display

#### POST `/api/billing/subscribe`

Create subscription with selected interval.

**Request:**
```
{
  plan_id: string,
  interval: "month" | "year",
  payment_method_id?: string,  // if not provided, use default
  promo_code?: string,
  trial_days?: integer  // if plan offers trial
}
```

**Response:**
```
{
  success: boolean,
  subscription: {
    id: string,
    plan_name: string,
    interval: string,
    price_cents: number,
    next_billing_date: datetime,
    promo_code_applied?: string
  },
  error?: string
}
```

**Server-side logic:**
1. Authenticate customer
2. Validate plan exists and is active
3. Validate interval is "month" or "year"
4. Look up Stripe price ID for selected plan + interval
5. Create subscription in Stripe:
   ```
   stripe.subscriptions.create({
     customer: stripe_customer_id,
     items: [{
       price: stripe_price_id_for_interval  // monthly or annual price
     }],
     payment_method: payment_method_id || customer.default_payment_method,
     trial_period_days: trial_days || 0,
     description: plan.display_name,
     metadata: {
       app_id: app_id,
       plan_name: plan.plan_name,
       interval: interval
     }
   })
   ```
6. If promo_code, apply via promotion_codes parameter
7. Return subscription details

#### PATCH `/api/billing/subscription/:id/change-interval`

Switch between monthly and annual (or vice versa).

**Request:**
```
{
  new_interval: "month" | "year",
  effective_date?: datetime  // defaults to immediately
}
```

**Response:**
```
{
  success: boolean,
  subscription: {
    id: string,
    interval: string,
    price_cents: number,
    next_billing_date: datetime,
    prorated_adjustment: {
      type: "credit" | "charge",
      amount_cents: number,
      reason: string  // "Switching to monthly from annual (prorated)"
    }
  },
  error?: string
}
```

**Server-side logic:**
1. Authenticate customer
2. Retrieve subscription from Stripe
3. Validate new_interval differs from current
4. Look up new Stripe price ID
5. Update subscription with Stripe's proration handling:
   ```
   stripe.subscriptions.update(subscription_id, {
     items: [{
       id: subscription.items.data[0].id,
       price: new_stripe_price_id
     }],
     proration_behavior: 'create_prorations',  // auto-calculate credit/charge
     effective_date: effective_date || 'immediately'
   })
   ```
6. Stripe returns prorated adjustment amount in response
7. Log change in SubscriptionIntervalChange table
8. Return updated subscription with prorated adjustment details

#### GET `/api/billing/subscription/:id`

Fetch subscription details including interval and next billing date.

**Response:**
```
{
  subscription: {
    id: string,
    customer_id: string,
    plan_name: string,
    interval: string,
    price_cents: number,
    current_period_start: datetime,
    current_period_end: datetime,
    next_billing_date: datetime,
    cancel_at_period_end: boolean,
    status: string  // "active", "past_due", "canceled", etc.
  }
}
```

### Subscription Management UI

```
[Page: /account/billing/subscription]

[Current Plan]:
Professional Plan (Annual)
$499.00/year (saves you $88!)
Billing period: March 20, 2024 - March 19, 2025
Next billing date: March 19, 2025

[Change Interval]:
○ Monthly ($49/month)
● Annual ($499/year - Save 17%)
[Save changes] button

[If switching to monthly]:
⚠ Prorated adjustment: $-29.92 credit
You'll receive a credit of $29.92 (unused annual portion)
```

### Annual Discount Configuration

Admin-configurable discounts:

```
[Page: /admin/billing/plans/:plan_id]

Annual Discount:
[radio buttons]:
  ○ Percentage off: [input] 17 %
  ○ Months free: [input] 2 months
  ○ Fixed amount: [input] 88.00 USD

Discount Display: [text] "Save 17%"

Calculation (for preview):
Monthly price: $49.00
Annual equivalent: $49.00 × 12 = $588.00
Discount (17%): -$99.96
Annual price: $488.04
Displayed as: "Save 17%" or "$99.96/year"

[Save] button
```

### Proration Calculation

When customer switches intervals mid-cycle:

```pseudocode
function calculateProration(subscription, newInterval, newPrice):
  currentPeriodStart = subscription.current_period_start
  currentPeriodEnd = subscription.current_period_end
  currentPrice = subscription.current_price_cents
  daysInPeriod = (currentPeriodEnd - currentPeriodStart).days
  daysRemaining = (currentPeriodEnd - today()).days

  // Cost per day for current plan
  currentDailyRate = currentPrice / daysInPeriod

  // Adjustments
  if newInterval == 'monthly' and subscription.interval == 'year':
    // Switching annual to monthly: credit unused portion
    remainingCost = currentDailyRate * daysRemaining
    newMonthlyCost = newPrice  // for first month
    credit = remainingCost - newMonthlyCost
    return { type: 'credit', amount: credit, reason: 'Switching to monthly from annual (prorated)' }

  if newInterval == 'year' and subscription.interval == 'month':
    // Switching monthly to annual: charge for remaining period
    nextBillingDate = currentPeriodEnd + 1 day
    daysUntilNextBilling = (nextBillingDate - today()).days
    monthlyRateDaily = currentPrice / 30  // avg days in month
    chargeForRemainingMonth = monthlyRateDaily * daysUntilNextBilling
    annualPrice = newPrice
    charge = annualPrice - chargeForRemainingMonth  // difference
    return { type: 'charge', amount: charge, reason: 'Switching to annual from monthly (prorated)' }

  return { type: 'none', amount: 0, reason: 'No change' }

// Stripe handles this automatically via proration_behavior='create_prorations'
// Server receives prorated adjustment in API response
```

### Webhook Events

```
invoice.created -> log subscription charges
invoice.payment_succeeded -> confirm payment for billing period
subscription.updated -> detect interval change, log in SubscriptionIntervalChange
customer.subscription.deleted -> handle cancellation
```

### Edge Cases

1. **Partial Month to Annual Conversion**
   - Customer on monthly plan, day 7 of 30-day cycle
   - Switches to annual; should receive credit for remaining 23 days
   - Stripe proration handles this; credit appears as negative line item on next invoice

2. **Trial Periods with Interval Change**
   - Customer on free trial; wants to switch from monthly to annual before trial ends
   - Stripe allows interval change during trial
   - New billing date extends trial period and applies annual pricing

3. **Discount Stacking**
   - Customer has promo code (20% off) AND switches to annual (17% discount)
   - Coupon discount applies first; then interval-based discount? Or exclusive?
   - Recommendation: Document behavior clearly; coupon overrides annual discount

4. **Interval Change with Usage Metering**
   - Customer on monthly plan with metered API calls
   - Switches to annual; should usage reset?
   - Recommendation: Usage continues per billing period; doesn't reset on interval change

5. **Early Renewal Before Annual Expires**
   - Customer on 1-year subscription, 6 months remaining
   - Initiates manual renewal or switches interval
   - Stripe handles: extends billing date or charges immediately depending on config

6. **Currency-Specific Pricing**
   - Plans have different prices per currency (EUR, GBP, etc.)
   - BillingPlan stores only base currency; Stripe Price objects handle per-currency pricing
   - Ensure Stripe Product/Price IDs cover all supported currencies

7. **Grandfathered Legacy Pricing**
   - Old customer locked into $39/month (no longer offered)
   - Cannot switch plans due to price increase
   - Recommendation: Preserve legacy price; warn if switching to new plan (higher cost)

8. **Annual-Only or Monthly-Only Plans**
   - Some plans may not support both intervals
   - Store `supported_intervals: ["month"] | ["year"] | ["month", "year"]` in BillingPlan
   - API validation: reject unsupported interval requests

---

## Security Considerations

### Stripe Integration

1. **No Client-Side Secret Keys**
   - Publishable key only on client (for Stripe.js, SetupIntent)
   - Secret key NEVER exposed to browser
   - All Stripe API calls: server-side only

2. **SetupIntent and PaymentIntent Security**
   - Client receives `client_secret` to confirm card via Stripe.js
   - Server never touches card data (PCI compliance)
   - Stripe handles tokenization and encryption

3. **Webhook Signature Verification**
   - All Stripe webhooks signed with HMAC-SHA256
   - Verify signature before processing:
     ```pseudocode
     signature = request.headers['stripe-signature']
     body = request.raw_body  // must be raw bytes, not parsed JSON
     timestamp = signature.split(',')[0].split('=')[1]
     hash = hmac_sha256(timestamp + '.' + body, STRIPE_WEBHOOK_SECRET)
     if hash != signature.split(',')[1].split('=')[1]:
       return 403
     ```

4. **Idempotency Keys**
   - All state-changing Stripe API calls include idempotency_key
   - Prevents duplicate charges if request retried
   - Server generates UUID4 for each operation

### Data Protection

1. **PII Masking**
   - Store only last 4 digits of card number, never full PAN
   - Mask email, phone in logs
   - Expire/delete card data after account deletion

2. **Rate Limiting**
   - `/api/usage/report`: 1000 requests/minute per customer
   - `/api/billing/validate-promo`: 10 attempts/minute (prevent brute force)
   - Admin endpoints: 100 requests/minute per admin

3. **Access Control**
   - Customers can only access their own payment methods, usage, subscriptions
   - Admins need `role=admin` to access `/admin/billing/*` endpoints
   - Audit all admin actions (create coupon, update plan, etc.)

4. **Encryption**
   - Payment method billing addresses: encrypt in transit (HTTPS) and at rest
   - Database: use field-level encryption for PII if applicable

### Validation & Sanitization

1. **Input Validation**
   - Promo code: alphanumeric only, max 50 chars
   - Usage quantity: numeric, positive, max precision 2 decimals
   - Prices: numeric, cents-only (no float), > 0
   - Emails: standard email regex

2. **Output Encoding**
   - API responses: JSON with proper Content-Type header
   - HTML rendering: escape all user inputs (names, addresses)
   - No injection attacks in logging

3. **Stripe API Validation**
   - Validate all Stripe IDs format (start with specific prefix: cus_, sub_, pi_, etc.)
   - Never trust client-provided Stripe IDs; look up in database first
   - Example: if client says "my subscription is sub_123", verify ownership in `Subscription` table

---

## Gotchas

### 1. Idempotency Key Expiry

Stripe retains idempotency keys for 24 hours. After 24 hours, same key treated as new request:
- For payment methods: retryable within 24 hours
- For subscriptions: expect idempotent behavior within transaction window only

### 2. Subscription Item IDs Change

When updating subscription prices, Stripe may reassign `subscription_item_id`. Don't rely on static item IDs:
```pseudocode
// Wrong: hardcoded subscription_item_id
stripe.subscription_items.update('si_12345', ...)

// Right: fetch from subscription, then update
subscription = stripe.subscriptions.retrieve(subscription_id)
item_id = subscription.items.data[0].id  // current item ID
stripe.subscription_items.update(item_id, ...)
```

### 3. Coupon Duration Immutability

Stripe Coupon `duration` cannot be changed post-creation. Plan accordingly; use PromotionCode instead for flexibility.

### 4. Metered Billing Lag

Usage records posted to Stripe may take 5-10 minutes to aggregate. Dashboard show-latest-first; document lag.

### 5. SetupIntent Success Doesn't Guarantee Charge Success

Card passes SetupIntent verification but charge fails for other reasons (expired, stolen, etc.):
- Implement fallback retry logic (Feature 3)
- Test with Stripe test card numbers (4000 0000 0000 0002 = decline)

### 6. Annual Price Changes

If you update BillingPlan's `annual_price_cents`, existing subscriptions on old price are unaffected (Stripe grandfathers). Only new subscriptions use new price. Document price change date.

### 7. Usage Dimensions Are Immutable

Stripe Meter definition cannot be changed post-creation. Create new dimension if aggregation method changes.

### 8. Proration Behavior Applies to All Items

If subscription has multiple items (plan + add-on), `proration_behavior` applies to all items. Verify expected behavior:
```pseudocode
stripe.subscriptions.update(subscription_id, {
  items: [
    { id: 'si_plan', price: new_price_id },
    { id: 'si_addon', price: addon_price_id }  // also prorated
  ],
  proration_behavior: 'create_prorations'
})
```

### 9. Delete Payment Method, Then Charge

If payment method is detached from Stripe but customer has subscriptions:
- Subscription charge falls back to default payment method
- If no default, charge fails and manual retry required
- Always validate default method exists before allowing deletion (Feature 3 validation)

### 10. Timezone Issues in Cron/Billing Cycles

Stripe billing cycles are UTC. If app uses local timezone for calculations:
- Usage period resets at UTC midnight, not local midnight
- Threshold alerts may fire at unexpected local times
- Standardize on UTC for all backend billing logic

### 11. Expired Promotional Code in Flight

Admin disables coupon while customer in checkout:
- Validation endpoint returns `valid: false`
- Client shows error, but order form still has code in field
- Customer must clear and resubmit (no silent auto-recovery)

### 12. Payment Method on Multiple Customers

Stripe allows same payment method (card) on multiple customers (rare edge case). If customer merged/accounts consolidated:
- Detach method from old customer before attaching to new
- Subscription charges use default method per customer; no cross-customer reuse

---

## Feature Interplay

### Promo Code + Multiple Payment Methods
- Promo code applied at subscription creation
- If charge fails, fallback logic retries with alternate payment method
- Discount persists across retry (coupon already applied to invoice)

### Usage Metering + Annual Billing
- Metered charges accumulate per billing cycle
- Annual billing cycle: usage reported/aggregated for 12-month period
- Monthly billing cycle: usage reset every 30 days
- Threshold alerts check current billing period (month or year)

### Usage Metering + Fallback Payment Methods
- Usage invoice fails due to payment method decline
- Fallback logic retries with next available card
- Usage record remains in system; no re-reporting needed

### Annual Discount + Promo Code
- Document: Does promo code stack with annual discount, or is promo exclusive?
- Recommendation: Promo code overrides annual discount (coupon takes precedence)
- Clearly disclose to customers in pricing UI

### Plan Switching (not covered above, but related)
- Customers can upgrade/downgrade plans at any time
- Stripe prorates the difference
- If switching from annual to different annual plan: proration applies
- Usage dimensions may differ per plan; reset/preserve based on plan design

---

## Environment Variables

```
STRIPE_SECRET_KEY=sk_live_...  // Required for all billing features
STRIPE_PUBLISHABLE_KEY=pk_live_...  // Client-side Stripe.js
STRIPE_WEBHOOK_SECRET=whsec_...  // Webhook signature verification

// Optional feature flags to enable/disable features
BILLING_PROMO_CODES_ENABLED=true
BILLING_USAGE_METERING_ENABLED=true
BILLING_MULTIPLE_PAYMENTS_ENABLED=true
BILLING_ANNUAL_MONTHLY_TOGGLE_ENABLED=true

// Feature-specific config
USAGE_ALERT_THRESHOLD_PERCENTAGE=80  // Alert at 80% of threshold
USAGE_ALERT_EMAIL_ENABLED=true
USAGE_ALERT_SLACK_ENABLED=false

// Payment method retry policy
PAYMENT_RETRY_MAX_ATTEMPTS=3
PAYMENT_RETRY_DELAY_HOURS=24

// Promo code brute-force protection
PROMO_CODE_RATE_LIMIT_ATTEMPTS=10
PROMO_CODE_RATE_LIMIT_WINDOW_MINUTES=1
```

---

## Implementation Checklist

### Phase 1: Promo Codes (Week 1-2)
- [ ] Create `PromotionCodeCache` and `Subscription.applied_coupon_code` fields
- [ ] Build admin coupon creation UI
- [ ] Implement `/admin/api/billing/coupons` endpoints
- [ ] Implement `/api/billing/validate-promo` and `/api/billing/apply-promo`
- [ ] Wire promo code input into checkout flow
- [ ] Test coupon duration (one-time, repeating, forever)
- [ ] Test max redemptions enforcement
- [ ] Stripe webhook: monitor coupon.deleted, promotion_code.updated

### Phase 2: Usage Metering (Week 3-4)
- [ ] Create `UsageDimension`, `UsageRecord`, `UsageSummary` tables
- [ ] Create `ThresholdAlert` table for configuration
- [ ] Implement `/api/usage/report` endpoint (with idempotency)
- [ ] Implement `/api/usage/current-period` and `/api/usage/history`
- [ ] Build usage dashboard UI
- [ ] Implement threshold alert logic (email/Slack integration)
- [ ] Stripe integration: create Meters, post Usage Records
- [ ] Test aggregation methods (sum, max, last_during_period)
- [ ] Test billing cycle reset

### Phase 3: Multiple Payment Methods (Week 5-6)
- [ ] Create `PaymentMethod` and `PaymentMethodRetry` tables
- [ ] Implement `/api/payment-methods/create-setup-intent`
- [ ] Implement `/api/payment-methods/confirm-setup-intent`
- [ ] Implement GET/PATCH/DELETE `/api/payment-methods/:id`
- [ ] Build payment method list UI in account settings
- [ ] Implement fallback/retry logic for failed charges
- [ ] Wire default payment method into subscription creation
- [ ] Test expired card handling
- [ ] Test 3DS/SCA challenge flow

### Phase 4: Annual vs Monthly Toggle (Week 7-8)
- [ ] Create `BillingPlan` table with monthly/annual pricing
- [ ] Create `SubscriptionIntervalChange` audit table
- [ ] Implement `/api/billing/plans` endpoint
- [ ] Implement `/api/billing/subscribe` endpoint
- [ ] Implement `/api/billing/subscription/:id/change-interval` endpoint
- [ ] Build pricing page toggle UI
- [ ] Build subscription management UI
- [ ] Test proration calculations (annual to monthly, vice versa)
- [ ] Test interval change with trial periods
- [ ] Test interval change with metered billing

### Phase 5: Testing & QA (Week 9-10)
- [ ] End-to-end testing: promo code → checkout → payment → usage metering → invoice
- [ ] Load testing: high usage reporting volume
- [ ] Edge case testing (see Gotchas section)
- [ ] Security audit: PCI compliance, webhook verification, rate limiting
- [ ] Stripe sandbox testing with test cards/coupons
- [ ] Production staging: one admin user tests full flow

### Phase 6: Monitoring & Support (Ongoing)
- [ ] Set up Stripe event monitoring / webhooks dashboard
- [ ] Log all billing operations (coupon applied, payment failed, usage submitted, interval changed)
- [ ] Alert on payment failures, usage quota breaches, webhook failures
- [ ] Customer support runbook: how to manually fix billing issues, refund overcharges, etc.

---

## Summary

This recipe provides production-ready patterns for four advanced billing features. All integrate with Stripe and are controlled via `STRIPE_SECRET_KEY` env var. Key architectural decisions:

- **Server-side Stripe operations only** (no secret keys on client)
- **Secure card collection via SetupIntent** (PCI-compliant)
- **Proration handled by Stripe** (use `proration_behavior` flag)
- **Webhook-driven state sync** (subscribe to Stripe events)
- **Idempotent retries** (prevent duplicate charges)
- **Caching + eventual consistency** (local tables reference Stripe source of truth)
- **Comprehensive logging** (audit all admin actions and billing operations)

Implement in phases to manage complexity. Start with promo codes (least complex), then layer in usage metering, payment methods, and finally interval flexibility.
