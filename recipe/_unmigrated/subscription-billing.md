---
name: Subscription & Billing
description: Payment provider integration, subscription lifecycle, pricing UI, invoicing, dunning, and trial/freemium logic
type: project
---

# Subscription & Billing Recipe

## Overview

A complete, production-ready subscription and billing system with Stripe as the default payment provider. The implementation is webhook-driven with Stripe as the single source of truth for subscription state. Stripe is never polled; all state changes flow through verified webhooks. Local database caches mirror Stripe state for fast reads and enables offline access to subscription status.

## Architectural Principles

**Stripe is Authoritative**
- Stripe is the source of truth for all subscription, invoice, and payment state.
- Local database is a cache for fast lookups and historical records.
- Webhooks drive all state changes. The server never polls Stripe.
- If local state diverges from Stripe, Stripe state wins.

**Provider Abstraction**
- While Stripe is the default, the system is designed to swap providers (Paddle, RevenueCat, etc.) without rewriting business logic.
- All Stripe-specific logic lives in a `PaymentProvider` interface/abstract class.
- Core billing logic (dunning, trial, freemium) is provider-agnostic.

**Security First**
- All webhook payloads are verified using provider-supplied signatures (Stripe: HMAC-SHA256).
- No price or plan information is trusted from the client.
- Monetary amounts are stored in cents (integers), never floats.
- Payment methods are never stored locally; Stripe handles PCI compliance.
- Subscription changes (upgrade/downgrade) are validated server-side against plan definitions.

**Plans Defined in Stripe**
- Plans (products + prices) are defined and managed in Stripe dashboard or API.
- A sync service periodically pulls plan definitions from Stripe and caches them locally for fast reads and SSR rendering.
- No local-only plan definitions; all truth lives in Stripe.
- Plans are immutable once created; pricing changes require new price objects in Stripe.

**Freemium as a Plan**
- Freemium is a plan with price = $0, same subscription model, not a special case.
- Freemium users are subscribed to a $0 plan, enabling feature gating logic to be uniform.

**Dunning & Grace Periods**
- On failed payment, the customer enters a grace period (default 3 days, configurable per plan).
- During grace period: subscription status is `past_due`, user can still access features, but a banner/notification is shown.
- After grace period: subscription status transitions to `unpaid`, features are locked, and a final retention email is sent.
- Cancellation happens after grace period + 7 days of non-action or explicit cancellation by the customer.

**Billing Portal Self-Service**
- Stripe Customer Portal link is provided for customers to self-manage billing: update payment method, view invoices, change plans, etc.
- No need to build custom billing UI; Stripe handles it.

## Data Models

### Customers Collection/Table

Maps internal users to Stripe customers.

```
{
  id: UUID (primary key),
  user_id: UUID (foreign key to users),
  stripe_customer_id: string (unique, e.g., "cus_123abc"),
  stripe_customer_created_at: ISO 8601 timestamp,
  created_at: ISO 8601 timestamp,
  updated_at: ISO 8601 timestamp,
  metadata: object (custom fields, e.g., { account_tier: "pro", signup_source: "organic" })
}
```

**Invariants:**
- One row per user.
- `stripe_customer_id` is immutable once set.
- Metadata is mutable and user-editable (for tracking custom attributes).

### Subscriptions Collection/Table

Mirrors Stripe subscription state. Synced via webhooks.

```
{
  id: UUID (primary key),
  customer_id: UUID (foreign key to customers),
  stripe_subscription_id: string (unique, e.g., "sub_123abc"),
  stripe_customer_id: string (denormalized, for quick lookups),
  plan_id: UUID (foreign key to plans),
  status: enum [trialing, active, past_due, unpaid, paused, canceled],
  current_period_start: ISO 8601 timestamp,
  current_period_end: ISO 8601 timestamp,
  trial_start: ISO 8601 timestamp (nullable),
  trial_end: ISO 8601 timestamp (nullable),
  cancel_at: ISO 8601 timestamp (nullable, when cancellation is scheduled),
  canceled_at: ISO 8601 timestamp (nullable, when cancellation was finalized),
  ended_at: ISO 8601 timestamp (nullable),
  grace_period_end: ISO 8601 timestamp (nullable, derived from failed payment + config),
  amount_due: integer (cents),
  currency: string (e.g., "usd", lowercase),
  billing_cycle_anchor: ISO 8601 timestamp (when the subscription cycles renew),

  // Stripe sync metadata
  stripe_status: string (raw Stripe status, for auditing),
  last_webhook_event_id: string (idempotency: last processed webhook),
  last_webhook_event_timestamp: ISO 8601 timestamp,

  created_at: ISO 8601 timestamp,
  updated_at: ISO 8601 timestamp
}
```

**Invariants:**
- One active subscription per customer (or none).
- Multiple historical subscriptions per customer are allowed (past cancellations).
- `status` is the app's canonical status; `stripe_status` is synced for auditing.
- `trial_end` is null if not on a trial.
- `grace_period_end` is computed: `failed_at + provider_config.grace_period_days`.
- Once `canceled_at` is set, the subscription is immutable.

### Plans Collection/Table

Synced from Stripe products + prices.

```
{
  id: UUID (primary key),
  stripe_product_id: string (unique, e.g., "prod_123abc"),
  stripe_price_id: string (unique, e.g., "price_123abc"),
  name: string (e.g., "Pro Monthly"),
  slug: string (unique, e.g., "pro-monthly", for URLs),
  description: string,
  price_amount: integer (cents, e.g., 2999 = $29.99),
  currency: string (e.g., "usd"),
  billing_interval: enum [month, year],
  billing_interval_count: integer (e.g., 1 for monthly, 12 for annual),
  trial_days: integer (default 0 = no trial),
  grace_period_days: integer (default 3),

  // Feature flags / tiers
  features: object (e.g., { max_users: 5, api_access: true, support_tier: "priority" }),

  // Metadata
  metadata: object (Stripe metadata synced locally),
  is_active: boolean (whether new subscriptions can be created),
  stripe_product_created_at: ISO 8601 timestamp,
  created_at: ISO 8601 timestamp,
  updated_at: ISO 8601 timestamp
}
```

**Invariants:**
- Plans are immutable after creation (except `is_active` and metadata).
- Pricing changes require creating a new price object in Stripe, not modifying an existing one.
- `slug` is used for URLs and must be human-readable.
- `trial_days` and `grace_period_days` are plan-specific; they override provider defaults.
- Freemium plans have `price_amount: 0`.

### Invoices Collection/Table

Synced from Stripe invoices. Read-only locally.

```
{
  id: UUID (primary key),
  customer_id: UUID (foreign key to customers),
  stripe_invoice_id: string (unique, e.g., "in_123abc"),
  stripe_subscription_id: string (nullable, may be standalone),
  stripe_customer_id: string (denormalized),

  status: enum [draft, open, paid, uncollectible, void],
  amount_due: integer (cents),
  amount_paid: integer (cents),
  amount_remaining: integer (cents),
  currency: string (e.g., "usd"),

  billing_reason: string (e.g., "subscription_cycle", "subscription_create", "subscription_update"),
  period_start: ISO 8601 timestamp,
  period_end: ISO 8601 timestamp,
  due_date: ISO 8601 timestamp (nullable),
  paid_at: ISO 8601 timestamp (nullable),

  pdf_url: string (Stripe-hosted PDF, for secure access),
  hosted_invoice_url: string (Stripe-hosted invoice page),

  metadata: object (custom fields),
  stripe_created_at: ISO 8601 timestamp,
  created_at: ISO 8601 timestamp,
  updated_at: ISO 8601 timestamp
}
```

**Invariants:**
- Read-only; updates come only from Stripe webhooks.
- `pdf_url` and `hosted_invoice_url` are time-limited Stripe URLs; refresh them if stale.

### Payment Events Collection/Table (Optional, for Dunning Analytics)

Tracks payment failures and recovery attempts for reporting and dunning workflows.

```
{
  id: UUID (primary key),
  customer_id: UUID (foreign key to customers),
  subscription_id: UUID (foreign key to subscriptions),
  stripe_payment_intent_id: string (nullable),
  stripe_charge_id: string (nullable),

  event_type: enum [payment_attempt, payment_failed, payment_succeeded, dunning_started, dunning_ended],
  reason: string (if failed, e.g., "card_declined", "insufficient_funds"),
  amount: integer (cents),
  currency: string,

  attempt_number: integer (1st failure, 2nd retry, etc.),
  grace_period_remaining_days: integer (at time of event),

  stripe_event_id: string (from webhook),
  stripe_event_timestamp: ISO 8601 timestamp,
  created_at: ISO 8601 timestamp
}
```

**Invariants:**
- Insert-only; used for analytics and dunning reporting.
- Helps understand customer payment behavior and dunning success rates.

## API Contracts

### POST /api/billing/create-checkout-session

Create a Stripe Checkout session for subscribing to a plan. The client is redirected to Stripe's hosted checkout.

**Request:**
```
{
  plan_slug: string (required, e.g., "pro-monthly"),
  success_url: string (required, e.g., "https://app.example.com/billing/success"),
  cancel_url: string (required, e.g., "https://app.example.com/pricing")
}
```

**Response (on success):**
```
{
  checkout_url: string (Stripe Checkout URL to redirect to),
  session_id: string (for tracking)
}
```

**Response (on error):**
```
{
  error: string (e.g., "Plan not found", "You are already subscribed"),
  code: string (e.g., "PLAN_NOT_FOUND", "ALREADY_SUBSCRIBED")
}
```

**Business Logic:**
- Verify the user is authenticated.
- Load the plan by slug; fail if not found or inactive.
- Check if the user already has an active subscription; fail if so (should upgrade/downgrade instead).
- If the user has a Stripe customer ID, reuse it; otherwise create a new customer in Stripe.
- Pass metadata to Stripe (user_id, account_type, etc.).
- Create a Checkout session in Stripe with the plan's price_id.
- Store the session_id locally for reference (optional, for analytics).
- Return the checkout URL.

**Edge Cases:**
- User is already subscribed: reject with "ALREADY_SUBSCRIBED".
- Plan is inactive: reject with "PLAN_INACTIVE".
- Plan is freemium ($0): skip Stripe checkout and directly create a subscription (use a POST /api/billing/subscribe endpoint internally).
- Stripe API error: log and return a generic error to the user.

### POST /api/billing/create-portal-session

Create a Stripe Customer Portal session for self-service billing management.

**Request:**
```
{
  return_url: string (required, e.g., "https://app.example.com/settings/billing")
}
```

**Response (on success):**
```
{
  portal_url: string (Stripe Customer Portal URL to redirect to)
}
```

**Response (on error):**
```
{
  error: string,
  code: string
}
```

**Business Logic:**
- Verify the user is authenticated.
- Load the customer's Stripe customer ID; fail if not found.
- Create a billing portal session in Stripe.
- Return the portal URL.

**Edge Cases:**
- User has no Stripe customer ID: create one on-the-fly, then create the portal session.

### POST /api/billing/webhooks

Webhook endpoint for Stripe events. This is the primary driver of subscription state changes.

**Request:**
```
{
  id: string (Stripe event ID, e.g., "evt_123abc"),
  type: string (Stripe event type, e.g., "customer.subscription.updated"),
  created: integer (Unix timestamp),
  data: {
    object: object (the Stripe object that changed),
    previous_attributes: object (nullable, for updated events)
  }
}

Header: Stripe-Signature (HMAC-SHA256 signature of the raw request body)
```

**Response:**
```
{
  status: "received" or "error",
  event_id: string (for Stripe's deduplication)
}
```

**Business Logic:**
- Verify the webhook signature using the Stripe signing secret.
- Extract the event ID and type.
- Check if the event has been processed before (using `event_id` in subscriptions table or a separate `webhook_events` log). If so, return 200 (idempotent).
- Route to an event handler based on the event type.
- Handle the following events (at minimum):

  **customer.subscription.created**
  - Extract subscription data from the Stripe object.
  - Find or create the subscription row in the local database.
  - Store the subscription state (status, current_period_start/end, trial_end, etc.).
  - Mark subscription as active if applicable.

  **customer.subscription.updated**
  - Load the existing subscription row.
  - Update the subscription state (status, current_period_start/end, cancel_at, etc.).
  - If status changed to `past_due`, compute `grace_period_end` and schedule a dunning email.
  - If status changed to `canceled`, set `canceled_at`.
  - If status changed from `trialing` to `active`, log a conversion event.

  **customer.subscription.deleted**
  - Load the existing subscription row.
  - Set `canceled_at` to the event timestamp.
  - Mark status as `canceled` (if not already).

  **invoice.created**
  - Extract invoice data from the Stripe object.
  - Insert or upsert the invoice row in the local database.
  - If invoice is for the user's subscription, update `amount_due` on the subscription row.

  **invoice.payment_succeeded**
  - Load the invoice row.
  - Update status to `paid`, set `paid_at`.
  - If this was a retry payment (dunning recovery), update the subscription status from `past_due` to `active`.
  - Clear the `grace_period_end` on the subscription.
  - Log a payment success event.
  - Send a payment receipt email.

  **invoice.payment_failed**
  - Load the invoice row.
  - Update status to `open`.
  - Find the associated subscription and update its status to `past_due`.
  - Compute `grace_period_end` based on the plan's grace_period_days.
  - Log a payment failed event.
  - Schedule a dunning email (immediate or after N hours).

  **charge.refunded** (optional, for full refunds)
  - Find the associated invoice and subscription.
  - Emit an event (for downstream logic, e.g., feature revert, refund email).

- Log all webhook events to a webhook log (for auditing and debugging).
- Return 200 OK if the event was processed.
- Return 400 if the signature is invalid.
- Return 500 if processing fails; Stripe will retry.

**Idempotency:**
- Every subscription and invoice row has a `last_webhook_event_id` and `last_webhook_event_timestamp` field.
- Before processing an event, check if `event_id` matches the row's `last_webhook_event_id` and the timestamp is the same. If so, return 200 immediately (idempotent).
- This prevents double-processing if Stripe retries a webhook.

### GET /api/billing/subscription

Fetch the current user's subscription status.

**Request:**
```
GET /api/billing/subscription
```

**Response (on success):**
```
{
  subscription: {
    id: string,
    plan: {
      id: string,
      name: string,
      slug: string,
      price_amount: integer,
      billing_interval: string,
      features: object
    },
    status: string,
    current_period_start: ISO 8601,
    current_period_end: ISO 8601,
    trial_end: ISO 8601 (nullable),
    cancel_at: ISO 8601 (nullable),
    canceled_at: ISO 8601 (nullable),
    grace_period_end: ISO 8601 (nullable),
    days_until_renewal: integer,
    days_until_trial_end: integer (nullable),
    days_in_grace_period: integer (nullable)
  },
  or
  subscription: null (user has no active subscription)
}
```

**Response (on error):**
```
{
  error: string,
  code: string
}
```

**Business Logic:**
- Verify the user is authenticated.
- Load the user's subscription from the database.
- If no subscription, return `{ subscription: null }`.
- Enrich the subscription with computed fields (days_until_renewal, etc.).
- Join with the plan to include plan details.
- Cache this response for up to 60 seconds (per user, per session).

**Security:**
- Verify the user can only see their own subscription.

### GET /api/billing/invoices

Fetch the current user's invoice history.

**Request:**
```
GET /api/billing/invoices?limit=20&offset=0
```

**Response (on success):**
```
{
  invoices: [
    {
      id: string,
      stripe_invoice_id: string,
      status: string,
      amount_due: integer,
      amount_paid: integer,
      currency: string,
      period_start: ISO 8601,
      period_end: ISO 8601,
      paid_at: ISO 8601 (nullable),
      pdf_url: string,
      hosted_invoice_url: string
    }
  ],
  total: integer,
  limit: integer,
  offset: integer
}
```

**Response (on error):**
```
{
  error: string,
  code: string
}
```

**Business Logic:**
- Verify the user is authenticated.
- Load invoices for the user's customer_id, ordered by date descending.
- Paginate using limit and offset (default limit: 20, max: 100).
- Include pdf_url and hosted_invoice_url for downloading/viewing invoices.
- Cache this response for up to 5 minutes (per user).

**Security:**
- Verify the user can only see their own invoices.

### GET /api/billing/plans

Fetch all available plans. Public, highly cacheable.

**Request:**
```
GET /api/billing/plans
```

**Response (on success):**
```
{
  plans: [
    {
      id: string,
      name: string,
      slug: string,
      description: string,
      price_amount: integer,
      currency: string,
      billing_interval: string,
      trial_days: integer,
      features: object,
      is_active: boolean
    }
  ]
}
```

**Business Logic:**
- Load all active plans from the database.
- Return only active plans (is_active: true).
- Order by price_amount ascending.
- Cache this response for up to 24 hours (or set a very short TTL and use a CDN).

**Security:**
- No authentication required.
- This endpoint is public and can be called from the browser.

### POST /api/billing/subscribe (Internal Only, for Freemium)

Directly subscribe a user to a freemium ($0) plan, bypassing Stripe Checkout.

**Request:**
```
{
  plan_slug: string (required)
}
```

**Response (on success):**
```
{
  subscription: { ... }
}
```

**Business Logic:**
- Verify the user is authenticated.
- Load the plan by slug.
- Verify the plan's price_amount is 0 (freemium).
- Check if the user already has a subscription; fail if so.
- Create a local subscription row (no Stripe API call).
- Set status to `active`, trial_end to null.
- Return the subscription.

**Edge Cases:**
- User already subscribed: reject.
- Plan is not freemium: reject.

## UI Components & Layouts

### Pricing Page

A public-facing page showing plan comparison and CTAs.

**Layout:**
```
┌─────────────────────────────────────────────────────────┐
│ PRICING                                                 │
├─────────────────────────────────────────────────────────┤
│ Toggle: Monthly / Yearly                                │
├─────────────────────────────────────────────────────────┤
│ [Plan 1 Card] [Plan 2 Card] [Plan 3 Card] [Plan 4 Card]│
│ ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│ │ Free     │  │ Pro      │  │ Team     │  │ Enterprise
│ │ $0/mo    │  │ $29/mo   │  │ $99/mo   │  │ Custom   │
│ │          │  │          │  │          │  │          │
│ │ - Feature│  │✓ Feature │  │✓ Feature │  │✓ All     │
│ │ - Feature│  │✓ Feature │  │✓ Feature │  │✓ features│
│ │          │  │          │  │✓ Feature │  │✓ Priority
│ │ [Sign Up]│  │[Get Start]│  │[Get Start]│  │[Contact] │
│ └──────────┘  └──────────┘  └──────────┘  └──────────┘ │
└─────────────────────────────────────────────────────────┘
```

**Data:**
- Fetched from GET /api/billing/plans (cacheable, static).
- Each plan shows: name, price, billing interval, feature list, CTA button.
- If user is logged in and already subscribed, show the current plan with a "Your Plan" badge.

**CTAs:**
- Free plan: [Sign Up] button (redirects to signup or direct free subscription).
- Paid plan: [Get Started] button → POST /api/billing/create-checkout-session → redirect to Stripe Checkout.
- Enterprise plan: [Contact Us] button → contact form or email.

**Freemium Toggle:**
- If there are both monthly and annual plans, show a toggle for switching between billing intervals.
- Recalculate pricing and feature comparisons on toggle.

**SSR Considerations:**
- This page is critical for SEO; it must be server-rendered with plan data.
- Plans should be fetched server-side and injected into the initial HTML.
- No loading skeleton or lazy loading; static content only.

### Billing Settings Page

A logged-in page showing the user's current subscription, next renewal, and management options.

**Layout:**
```
┌─────────────────────────────────────────────────────────┐
│ BILLING SETTINGS                                        │
├─────────────────────────────────────────────────────────┤
│ Current Plan: Pro Monthly                               │
│ Price: $29.99/month                                     │
│ Renews: 2026-04-15                                      │
│ Days until renewal: 20                                  │
│                                                         │
│ [Upgrade Plan] [Manage Billing] [Cancel Subscription]  │
│                                                         │
├─────────────────────────────────────────────────────────┤
│ INVOICES                                                │
│ [Invoice History Table]                                 │
│                                                         │
│ Date        | Amount | Status | PDF                    │
│ 2026-03-15  | $29.99 | Paid   | [Download]             │
│ 2026-02-15  | $29.99 | Paid   | [Download]             │
│ ...                                                     │
└─────────────────────────────────────────────────────────┘
```

**Elements:**
- **Subscription Card:**
  - Current plan name, price, billing interval.
  - Next renewal date.
  - Days until renewal (dynamic, recomputed on load).
  - Status badge (active, trial, past_due, canceled).

- **Action Buttons:**
  - [Upgrade Plan] → redirect to pricing page or show a modal with available plans.
  - [Manage Billing] → POST /api/billing/create-portal-session → redirect to Stripe Customer Portal.
  - [Cancel Subscription] → POST /api/billing/cancel-subscription → modal confirmation → cancel in Stripe.

- **Invoice History Table:**
  - Paginated list of invoices.
  - Columns: Date, Amount, Status, PDF Download.
  - [Download PDF] link → opens Stripe's hosted invoice URL (secure, no auth needed).
  - Pagination: prev/next buttons or "Load More".

**Trial Banner:**
- If user is on a trial, show a banner: "Your trial ends in 5 days. [Upgrade Now]"
- If trial ends in < 3 days, use a warning color (orange/red).

**Past Due Banner:**
- If user is in grace period, show: "Payment failed. Your access will be limited on [grace_period_end]. [Update Payment Method]"
- [Update Payment Method] → Stripe Customer Portal or standalone payment collection form.

**Freemium User:**
- Show "You're on the Free plan" with option to [Upgrade].
- No renewal date or invoices.

### Subscription Status Banner

A global banner shown across the app when the subscription requires attention.

**Shown when:**
- Trial ending in < 7 days: "Your trial ends in X days. [Upgrade Now]"
- Trial ended: "Your trial has ended. [Upgrade Now]"
- Past due / in grace period: "Payment failed. Your access will be limited on [date]. [Update Payment Method]"
- Unpaid / feature locked: "Your subscription was canceled due to non-payment. [Reactivate] or [Contact Support]"

**Design:**
- Sticky, top-of-page banner.
- Color-coded: yellow (trial ending), red (past_due/unpaid).
- Dismissible (user can close, but re-shows on next page load).

### Paywall / Feature Gate Component

A reusable component that wraps features requiring a paid subscription.

**Pseudocode:**
```
<PaywallGate required_plan="pro">
  <FeatureContent />
</PaywallGate>
```

**Behavior:**
- If user's current plan meets `required_plan`, render `<FeatureContent />`.
- If user is on a free plan, show a modal: "This feature requires [Plan Name]. [Upgrade Now]"
- If user is not subscribed, redirect to pricing page or show signup CTA.
- If user's subscription is past_due or unpaid, show: "Your subscription was paused due to a failed payment. [Update Payment Method]"

**Props:**
- `required_plan`: string (plan slug, e.g., "pro", "team").
- `feature_name`: string (for analytics/logging, e.g., "api_access", "advanced_reporting").
- `children`: component to render if user has access.

**Feature Flag Definition:**
- Each plan has a `features` object (e.g., `{ api_access: true, users_per_seat: 5 }`).
- The gate checks if the user's plan's features include the required feature.
- Features are versioned in Stripe metadata, synced to the local plans table.

### Invoice History Table

Detailed, paginated list of invoices.

**Columns:**
- Date: ISO date, human-readable (e.g., "Mar 15, 2026").
- Amount: formatted currency (e.g., "$29.99").
- Status: badge (Paid, Open, Void, Uncollectible).
- Actions: [Download PDF], [View Online].

**Pagination:**
- Show 10 or 20 invoices per page.
- Prev/Next buttons.
- Total count: "Showing 1-20 of 47 invoices".

**Empty State:**
- If no invoices, show: "No invoices yet. Your first invoice will appear after your trial ends or your first payment is processed."

## Webhook Event Handling

### Event Types to Listen For

**Essential:**
- `customer.subscription.created` → Create local subscription row.
- `customer.subscription.updated` → Update local subscription row, check for status changes (especially to past_due).
- `customer.subscription.deleted` → Mark subscription as canceled.
- `invoice.created` → Create local invoice row.
- `invoice.payment_succeeded` → Mark invoice as paid, clear grace period.
- `invoice.payment_failed` → Mark invoice as failed, enter grace period.

**Recommended:**
- `charge.refunded` → Log refund event, trigger refund email.
- `customer.deleted` → Cascade delete local customer and subscriptions (PII cleanup).
- `payment_intent.payment_failed` → More granular payment failure tracking.

### Webhook Processing Algorithm

```
1. Extract Stripe-Signature header.
2. Verify HMAC-SHA256(request_body, signing_secret) == Stripe-Signature.
3. If invalid, return 403 Forbidden.
4. Parse JSON body to extract event { id, type, created, data }.
5. Look up event by id in webhook_events log.
6. If found and status != "error", return 200 (idempotent).
7. Route to handler based on event.type.
8. Inside handler:
   a. Load affected customer, subscription, or invoice from local DB.
   b. Compare with Stripe data from event.data.object.
   c. If local state differs, update to match Stripe.
   d. Update last_webhook_event_id and last_webhook_event_timestamp on the row.
9. Log event to webhook_events with status "success".
10. Return 200 OK to Stripe.
11. If any exception, log to webhook_events with status "error" and return 500 (Stripe will retry).
```

### Idempotency Key

- Each row in subscriptions and invoices has: `last_webhook_event_id` (string) and `last_webhook_event_timestamp` (ISO 8601).
- Before processing an event that affects a row:
  - If `row.last_webhook_event_id == event.id` AND `row.last_webhook_event_timestamp == event.created`, it's a duplicate. Return 200.
  - Otherwise, update the row and set `last_webhook_event_id = event.id` and `last_webhook_event_timestamp = event.created`.

## Dunning & Grace Period Flow

### Payment Failure Sequence

```
Timeline:
─────────────────────────────────────────────────────────────────

[Day 0: Payment Fails]
├─ Stripe event: invoice.payment_failed
├─ Local action:
│  ├─ Subscription status: past_due
│  ├─ grace_period_end = now + plan.grace_period_days (e.g., +3 days)
│  ├─ Send "Payment Failed" email immediately
│  └─ Show banner in app: "Payment failed. Your access will be limited on [grace_period_end]."

[Day 0-3: Grace Period]
├─ User can still access features
├─ Banner is shown persistently in the app
├─ User can update payment method via Stripe Customer Portal
├─ Stripe may auto-retry the payment (default: 3 retries over 3 days)
├─ If payment succeeds:
│  ├─ Stripe event: invoice.payment_succeeded
│  ├─ Local action:
│  │  ├─ Subscription status: active
│  │  ├─ grace_period_end = null
│  │  ├─ Send "Payment Received" receipt email
│  │  └─ Clear the banner
│  └─ END: Subscription is restored

[Day 3: Grace Period Expires]
├─ Cron job or scheduled task checks for subscriptions with grace_period_end < now
├─ Local action:
│  ├─ Subscription status: unpaid
│  ├─ Send "Final Notice" email: "Your subscription will be canceled tomorrow. [Update Payment Method]"
│  └─ Features are locked (paywall shows)

[Day 4: Cancellation]
├─ Subscription is canceled via API or remains in unpaid state
├─ Send "Subscription Canceled" email with retention offer
└─ END: User can resubscribe (or contact support for recovery)
```

### Email Sequence

1. **Payment Failed Email (Day 0, immediate)**
   - Subject: "Payment Failed — Please Update Your Payment Method"
   - Body: "Your payment for [Plan Name] failed. Your access will continue for 3 days, after which your account will be downgraded. [Update Payment Method]"
   - CTA: Link to Stripe Customer Portal.

2. **Grace Period Reminder (Day 1 or 2, if configured)**
   - Subject: "Reminder: Update Your Payment Method"
   - Body: "Your subscription will be paused in X days. [Update Payment Method]"

3. **Final Notice (Day 3, as grace period expires)**
   - Subject: "Final Notice: Your Subscription Will Be Canceled Tomorrow"
   - Body: "Your subscription will be canceled in 24 hours. [Update Payment Method] or [Contact Support]"

4. **Cancellation Confirmation (Day 4+, after cancellation)**
   - Subject: "Your Subscription Has Been Canceled"
   - Body: "We're sorry to see you go. Your data is safe and retained for 30 days. [Resubscribe] | [Contact Support]"
   - Include a special offer (e.g., "Come back for 20% off").

### Configuration

**Provider Config (environment variables or database):**
```
GRACE_PERIOD_DAYS: integer (default 3)
FINAL_NOTICE_LEAD_TIME_HOURS: integer (default 24, send final notice 1 day before cancellation)
AUTO_RETRY_ENABLED: boolean (default true, let Stripe auto-retry)
AUTO_RETRY_DAYS: integer (default 3, Stripe will retry for 3 days)
CANCELLATION_GRACE_PERIOD_AFTER_FAILED_DUNNING: integer (days, default 7, cancel after this if still unpaid)
```

**Per-Plan Override (in plans table, metadata field):**
```
{
  "grace_period_days": 5,
  "dunning_sequence": ["immediate", "day_2", "day_3_final"]
}
```

### Scheduled Tasks / Cron Jobs

**Daily Dunning Check**
- Run once per day (e.g., 06:00 UTC).
- Query subscriptions where `status = past_due` AND `grace_period_end < now`.
- Transition these to `unpaid`, send final notice email, lock features.

**Daily Cancellation Check**
- Run once per day (e.g., 06:30 UTC).
- Query subscriptions where `status = unpaid` AND `canceled_at = null` AND `grace_period_end + 7_days < now`.
- Call Stripe API to cancel subscriptions.
- Send cancellation email with retention offer.

**Trial Ending Reminder**
- Run twice daily (e.g., 06:00 and 18:00 UTC).
- Query subscriptions where `status = trialing` AND `trial_end < now + 7_days` AND `trial_ending_email_sent = false`.
- Send "Your trial ends in X days" email.
- Set `trial_ending_email_sent = true` to avoid re-sending.

## Trial Logic

### Trial Configuration

**Plan Definition (in Stripe):**
- `trial_days`: integer (e.g., 14 for a 14-day trial).

**Subscription Row (local):**
- `trial_start`: ISO timestamp (when the trial started).
- `trial_end`: ISO timestamp (trial_start + trial_days).
- `status`: "trialing" while trial_end > now.

### Trial to Active Conversion

**Automatic Conversion:**
- When `trial_end <= now` and `status = trialing`, Stripe automatically transitions the subscription to `active` (if there's a valid payment method).
- The `invoice.payment_succeeded` webhook is fired, and the subscription status updates to `active`.
- If payment fails, the subscription is not converted and enters `past_due` immediately (no trial grace period).

**Trial Ending Soon Email:**
- Send 7 days before trial end: "Your trial ends in 7 days. Your plan is $X/month. Your card will be charged on [trial_end_date]. [Update Payment Method] | [Cancel]"
- Send 1 day before trial end: "Your trial ends tomorrow!"
- Include a CTA to upgrade or cancel.

### Trial Conversion Tracking

Log a conversion event when trial transitions to active:
```
{
  event_type: "trial_converted",
  customer_id: UUID,
  subscription_id: UUID,
  plan_id: UUID,
  plan_name: string,
  price_amount: integer,
  trial_days: integer,
  timestamp: ISO 8601
}
```

Use this for analytics and product metrics (conversion rate, LTV, etc.).

### Trial Skip / Cancellation

- User can cancel during trial via Stripe Customer Portal.
- Subscription status changes to `canceled`, no invoice is generated.
- Send a cancellation email with a retention offer (e.g., "We'd love to have you back — 20% off if you resubscribe").

## Freemium Model

### Definition

- Freemium is a plan with `price_amount = 0`.
- Freemium users are subscribed to a plan, same as paid users.
- Feature gating is uniform: check the user's plan.features, not a separate "is_free" flag.

### Freemium Sign-Up Flow

```
1. User clicks [Sign Up Free].
2. Create account in auth system.
3. Create customer in local DB (not in Stripe yet; no Stripe call).
4. POST /api/billing/subscribe with plan_slug = "free".
5. Create subscription row: status = active, trial_end = null, price_amount = 0.
6. Return subscription object.
7. Redirect to app dashboard.
```

**Important:** Do NOT create a Stripe customer until the user upgrades to a paid plan.

### Freemium to Paid Upgrade

```
1. User clicks [Upgrade to Pro].
2. Fetch current plan to verify it's freemium (price_amount = 0).
3. Create Stripe customer (if not exists).
4. Redirect to Stripe Checkout with the paid plan's price_id.
5. On checkout success, Stripe creates a subscription and fires a webhook.
6. Webhook handler updates the local subscription row, linking it to the Stripe subscription.
```

**Key Point:** The transition from freemium to paid requires creating a Stripe subscription, not upgrading within Stripe (there's nothing to upgrade from in Stripe yet).

## Security

### Webhook Signature Verification

**Algorithm:**
```
1. Extract the Stripe-Signature header.
2. Parse it: "t=<timestamp>,v1=<signature>"
3. Compute HMAC-SHA256:
   hmac = HMAC_SHA256(key=signing_secret, msg="<timestamp>.<raw_body>")
   hex_hmac = hex(hmac)
4. Verify: hex_hmac == signature (constant-time comparison).
5. Also verify that timestamp is recent (e.g., within last 5 minutes) to prevent replay attacks.
6. If invalid, return 403 Forbidden.
```

**Signing Secret:**
- Store in environment variable `STRIPE_WEBHOOK_SIGNING_SECRET`.
- Never commit to source control.
- Rotate if compromised (Stripe allows multiple signing secrets during rotation).

### Price Manipulation Prevention

**Client-Side:**
- Never trust prices from the client.
- Client may send `plan_slug`, not price.

**Server-Side:**
- Always load the plan from the database and verify price_amount against Stripe (on create-checkout-session).
- When creating a Stripe Checkout session, use the plan's `stripe_price_id` (from Stripe), not a price sent by the client.

**Pseudocode:**
```
POST /api/billing/create-checkout-session
├─ client sends: { plan_slug: "pro-monthly" }
├─ server loads: plan = db.plans.find_by_slug("pro-monthly")
├─ server verifies: plan.stripe_price_id is valid (cross-check with Stripe if needed)
├─ server uses: plan.stripe_price_id to create Stripe session (NOT a client-supplied price)
└─ never use client-supplied amounts, tax rates, or discounts
```

### Payment Method Security

- Payment methods are NEVER stored locally.
- Stripe handles all PCI compliance; credit card data never touches the server.
- Use Stripe Customer Portal for payment method management (no custom forms needed).

### CORS & CSRF

- POST /api/billing/* endpoints should require authentication (verify session/token).
- Use CSRF tokens for form submissions (if not using stateless tokens).
- Stripe Checkout is redirected to Stripe's domain, then back to the app (no cross-origin risk).

### Logging & Auditing

- Log all webhook events to a webhook log, including event_id, type, timestamp, and outcome (success/error).
- Do NOT log raw Stripe data (cards, secrets, etc.); log only event metadata.
- Retain webhook logs for at least 90 days (for compliance and debugging).
- Log all manual subscription changes (e.g., admin overrides, support cancellations) with user/reason.

## Environment Variables

**Required:**
```
STRIPE_PUBLISHABLE_KEY
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SIGNING_SECRET
```

**Optional:**
```
GRACE_PERIOD_DAYS (default: 3)
TRIAL_ENDING_EMAIL_DAYS_BEFORE (default: 7)
STRIPE_API_VERSION (default: latest)
STRIPE_ACCOUNT_ID (if using Stripe Connect)
```

## Background Jobs / Scheduled Tasks

### Daily Sync Plans from Stripe

**Schedule:** Once per day (e.g., 02:00 UTC).

**Logic:**
```
1. Fetch all products from Stripe API.
2. For each product with type = "service" or "good":
   a. Fetch all prices for the product.
   b. For each price:
      i. Upsert into plans table.
      ii. Update name, description, price_amount, currency, billing_interval.
      iii. Mark deleted prices as is_active = false.
3. Log sync result (e.g., "Synced 5 plans, 2 updated, 1 deleted").
```

**Error Handling:**
- If Stripe API is down, log and retry in 1 hour.
- Partial syncs are acceptable; plans table remains usable with last-known-good data.

### Daily Dunning Check

**Schedule:** Once per day (e.g., 06:00 UTC).

**Logic:**
```
1. Query: subscriptions where status = "past_due" AND grace_period_end < now.
2. For each subscription:
   a. Update status to "unpaid".
   b. Send final notice email.
   c. Log dunning event.
```

### Daily Cancellation Check

**Schedule:** Once per day (e.g., 06:30 UTC).

**Logic:**
```
1. Query: subscriptions where status = "unpaid" AND canceled_at IS NULL AND (grace_period_end + 7 days) < now.
2. For each subscription:
   a. Call Stripe API to cancel the subscription.
   b. Update local status to "canceled", set canceled_at.
   c. Send cancellation email.
   d. Log cancellation event.
```

### Trial Ending Reminder

**Schedule:** Twice per day (e.g., 06:00 and 18:00 UTC).

**Logic:**
```
1. Query: subscriptions where status = "trialing" AND trial_end < now + 7 days AND trial_ending_email_sent = false.
2. For each subscription:
   a. Calculate days_until_trial_end = (trial_end - now).days.
   b. If days_until_trial_end == 7, send "Trial ends in 7 days" email.
   c. If days_until_trial_end == 1, send "Trial ends tomorrow" email.
   d. Set trial_ending_email_sent = true.
```

## Testing Strategy

### Unit Tests

- Subscription status transitions (trialing → active, active → past_due, past_due → unpaid).
- Grace period calculation.
- Feature gating (user's plan.features vs. required features).
- Plan pricing and currency formatting.
- Dunning email logic.

### Integration Tests

- Webhook event processing (create, update, payment failed, payment succeeded).
- Idempotency (reprocessing the same webhook returns the same result).
- Freemium sign-up and upgrade.
- Trial ending and conversion.

### E2E Tests

- User signs up, starts a trial, pays, and upgrades.
- Payment fails, grace period elapses, cancellation.
- Freemium user upgrades to paid.
- Admin views invoice history and cancels subscription.

### Mock Stripe

- Use Stripe's test API keys (publishable and secret).
- Use Stripe's test card numbers (e.g., 4242 4242 4242 4242 for success, 4000 0000 0000 0002 for declined).
- Use stripe-mock or a similar tool for local webhook testing.

## Edge Cases & Gotchas

### Gotcha 1: Duplicate Webhooks

**Scenario:** Stripe retries a webhook (network timeout, server error). Without idempotency, the subscription is updated twice, causing data corruption.

**Mitigation:** Store `last_webhook_event_id` on each row. Before processing, check if the event_id matches the last processed event. If so, return 200 immediately (idempotent).

### Gotcha 2: Stripe State Diverges from Local State

**Scenario:** A webhook is lost (network error, server crashes). Local subscription shows "active", but Stripe subscription is "canceled".

**Mitigation:**
- Daily sync job: query Stripe for subscriptions, verify local state matches.
- If divergence detected, log alert and update local to match Stripe.
- Provide admin UI to manually sync or inspect a single subscription.

### Gotcha 3: Freemium User Tries to Upgrade to Freemium

**Scenario:** User clicks "Upgrade" on the same plan (free → free, or pro → pro).

**Mitigation:** Check if user's current plan == requested plan. If so, return "You're already on this plan" and don't redirect to checkout.

### Gotcha 4: Trial Ends While User Is Offline

**Scenario:** User's trial ends while they're not using the app. They don't see the "trial ending" email and aren't charged.

**Mitigation:**
- Trial ending emails are sent via email, not just in-app.
- When user logs in after trial ends, show a banner: "Your trial has ended. [Upgrade Now]"
- Grace period on the first payment may be needed (depend on payment provider behavior).

### Gotcha 5: Grace Period Boundary Timing

**Scenario:** Grace period ends at 2026-03-18T14:32:00Z. Dunning job runs at 06:00 UTC. User's features are locked 8+ hours after grace period technically ends.

**Mitigation:**
- Consider grace period end as "start of day" (e.g., 2026-03-18T00:00:00Z) to align with job schedules.
- Or, trigger dunning immediately on grace_period_end < now, without waiting for daily job.
- Use webhooks where possible instead of polling (e.g., Stripe may have a webhook for grace period end).

### Gotcha 6: Stripe Metadata Limits

**Scenario:** Storing large JSON objects (custom attributes, feature flags) in Stripe metadata causes API errors (metadata is limited to 50 keys, 500 chars per value).

**Mitigation:**
- Keep Stripe metadata minimal (e.g., account_type: "pro", signup_source: "organic").
- Store complex features in the local plans table, not Stripe.

### Gotcha 7: Subscription Cycle Anchor Mismatch

**Scenario:** User signs up on March 15, is on a monthly plan, should renew every 15th. But Stripe calculates renewal as "30 days later" (different days have different lengths).

**Mitigation:**
- Use `billing_cycle_anchor` in Stripe to fix renewal to a specific day of month.
- Store `billing_cycle_anchor` in the local subscription row for reference.

### Gotcha 8: Multi-Currency Pricing

**Scenario:** Offer same plan in USD ($29.99) and EUR (€25.00). Stripe requires separate price objects per currency.

**Mitigation:**
- Store `currency` in the plans table.
- Create separate plan rows for each currency (or use a `currency` dimension in the slug, e.g., "pro-monthly-usd", "pro-monthly-eur").
- On create-checkout-session, ensure the user's locale matches the plan's currency.

### Gotcha 9: Proration on Upgrade/Downgrade

**Scenario:** User upgrades from a $29/month plan (renews in 10 days) to a $99/month plan. Stripe prorates, charging a difference of ~$56.67.

**Mitigation:**
- Use Stripe's default proration behavior (charge immediately for the upgrade).
- Alternative: schedule the upgrade for the next billing cycle (no immediate charge).
- Document this in the UI: "You'll be charged $56.67 today, and your next billing date will be [date]."

### Gotcha 10: Webhook Replay Attacks

**Scenario:** Attacker captures a webhook and resends it, triggering duplicate state changes.

**Mitigation:**
- Verify webhook signature (HMAC-SHA256).
- Verify webhook timestamp is recent (within last 5 minutes).
- Check idempotency key (event_id) before processing.

### Gotcha 11: Customer Portal Returns to Wrong URL

**Scenario:** User updates payment method in Stripe Customer Portal. On return, they're redirected to a wrong URL or back to an old version of the billing page.

**Mitigation:**
- Pass `return_url` when creating the portal session.
- Ensure the return_url is a valid, stable URL (e.g., `/settings/billing`).
- Consider not relying on return_url for state sync; instead, use webhooks or a page load refresh.

### Gotcha 12: Stripe API Idempotency for Subscription Changes

**Scenario:** Network timeout when creating a Stripe subscription. Request is retried, but the subscription was already created, causing a duplicate subscription.

**Mitigation:**
- Use idempotency keys in Stripe API requests (send an Idempotency-Key header).
- Stripe will return the same subscription if the key is replayed.
- Store idempotency keys locally for replay prevention.

### Gotcha 13: Insufficient Inventory / Plan Limits

**Scenario:** Plan is "Team (5 seats)". User tries to upgrade to Team but they have 6 users. Upgrade should fail or require additional seats.

**Mitigation:**
- Check user count before allowing upgrade to Team.
- Show error: "You have 6 users, but Team plan includes 5 seats. Upgrade to Enterprise or remove users."
- This logic is app-specific and outside the billing system, but can be gated at the checkout step.

### Gotcha 14: Subscription Created Before Customer Created

**Scenario:** Webhook for subscription.created arrives before the webhook for customer.created (Stripe fires events asynchronously).

**Mitigation:**
- Gracefully handle missing customer: create customer row on-the-fly in the subscription handler.
- Or, query Stripe API for the customer if not found locally.

### Gotcha 15: Timezone Issues on Trial End Dates

**Scenario:** Plan has trial_days = 14. Trial starts at 2026-03-15T14:30:00Z. Trial should end at 2026-03-29T14:30:00Z. But display says "March 29" in the user's local timezone (PST: March 29, 6:30 AM), causing confusion.

**Mitigation:**
- Always store timestamps in UTC (ISO 8601).
- Convert to user's local timezone only for display.
- Use a library like date-fns or luxon for timezone handling.
- Be clear in emails: "Your trial ends on March 29, 2026 at 2:30 PM UTC (6:30 AM PST)."

### Gotcha 16: Stripe Tax & Transactions API

**Scenario:** User is in a tax jurisdiction (VAT, GST, sales tax). Stripe's Tax API calculates and applies tax. Local invoice amount must include tax.

**Mitigation:**
- Enable Stripe Tax in Stripe dashboard.
- When creating checkout session, pass Stripe Tax parameters (customer location, tax IDs, etc.).
- Stripe automatically applies tax to the Checkout session.
- Store the tax-inclusive amount in the local invoice row (Stripe webhooks provide this).

## Data Synchronization Strategy

### Read Path (GET /api/billing/subscription, /api/billing/plans, /api/billing/invoices)

- Query local database (fast, cached, no Stripe API call).
- Cache results in memory or Redis for 1-5 minutes (depends on data freshness requirements).
- For pricing page (GET /api/billing/plans), cache for 24 hours (static data).

### Write Path (POST /api/billing/create-checkout-session, /api/billing/create-portal-session)

- Call Stripe API to create checkout or portal session.
- Store session metadata locally for reference (optional, for analytics).
- Webhook will update local subscription/invoice when the user completes the flow.

### Webhook Path (POST /api/billing/webhooks)

- Stripe initiates the webhook request.
- Verify signature and event_id (idempotency).
- Update local subscription/invoice/plan rows to match Stripe state.
- Return 200 immediately; any async work (emails, etc.) is queued in a background job.

### Sync Correction (Daily Cron Job)

- Query Stripe for all subscriptions, invoices, products.
- Compare with local database.
- If divergence detected, update local to match Stripe.
- Log discrepancies for manual review.

## Migration & Bootstrapping

### Migrating from Legacy Billing

**Scenario:** App already has a billing system (custom-built or other provider). Need to migrate to this subscription model.

**Steps:**
1. Create Stripe products and prices in Stripe dashboard.
2. Sync to local plans table (run sync job).
3. For each existing customer:
   a. Create Stripe customer.
   b. Create Stripe subscription (or import via API).
   c. Create/update local customer row.
   d. Create/update local subscription row.
4. Validate local state matches Stripe.
5. Deploy app with new billing logic.
6. Monitor webhooks and dunning emails.

### Bootstrapping from Scratch

1. Create Stripe account and API keys.
2. Store `STRIPE_PUBLISHABLE_KEY` and `STRIPE_SECRET_KEY` in environment.
3. Create products and prices in Stripe dashboard (or via API).
4. Run sync job to populate local plans table.
5. Deploy app.
6. Test flow: sign up → checkout → subscription created.

## Observability & Monitoring

### Metrics to Track

- **Subscription Metrics:**
  - Active subscriptions (by plan).
  - Trial conversions (trial → active).
  - Churn rate (canceled subscriptions).
  - Average revenue per user (ARPU).

- **Payment Metrics:**
  - Successful payments (monthly).
  - Failed payments (rate, reasons).
  - Dunning recovery rate (failed → recovered).
  - Refunds (rate, reasons).

- **Webhook Metrics:**
  - Webhook processing latency (p50, p95, p99).
  - Webhook error rate.
  - Idempotency key hit rate (duplicates detected).

### Alerts

- Webhook processing latency > 1 second.
- Webhook error rate > 1%.
- Failed payments > 5% of transaction volume.
- Stripe API rate limits approaching.
- Discrepancies between Stripe and local state (from sync job).

### Logging

- Log all webhook events (event_id, type, timestamp, outcome).
- Log all Stripe API calls (method, endpoint, duration, errors).
- Log all subscription state transitions (status before/after).
- Log all dunning/cancellation events (user, reason, timestamp).

## Deployment Checklist

- [ ] Stripe API keys are in environment variables (not hardcoded).
- [ ] Webhook signing secret is set and verified.
- [ ] Database migration applied (create subscriptions, invoices, plans tables).
- [ ] Cron jobs configured (daily sync, dunning, cancellation, trial reminders).
- [ ] Email templates created and tested (payment failed, trial ending, etc.).
- [ ] Pricing page is SSR-compatible and SEO-friendly.
- [ ] Paywall component is integrated into gated features.
- [ ] Billing settings page is accessible to authenticated users.
- [ ] Webhook endpoint is publicly accessible at /api/billing/webhooks.
- [ ] Stripe webhook is configured to send events to /api/billing/webhooks.
- [ ] Test mode: used Stripe test API keys and test webhook signing secret.
- [ ] Staging: run full flow (sign up, checkout, subscription created).
- [ ] Production: deploy with production API keys, monitor webhooks.
- [ ] Runbook created for common issues (webhook failures, manual subscription changes, refunds).
