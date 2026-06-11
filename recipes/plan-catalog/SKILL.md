---
name: plan-catalog
description: >
  Use when implementing billing plans / pricing tiers as a versioned JSON
  catalog that is the single source of truth for the whole app. Covers the
  immutable-slug + `public`/date-window pattern that lets you keep billing
  retired plans for existing subscribers while only offering current plans to
  new ones, the typed loader with startup validation, and the Stripe
  price-id-per-slug binding.
---

# Plan Catalog

Pricing data wants to live in one place and be read everywhere — landing page, signup routing, quota enforcement, feature gates, and the payment webhook. The trap is that pricing *changes over time*: you raise a price, retire a tier, run a custom enterprise deal. If "the plan" is a row you mutate, you destroy the billing terms of every existing subscriber the moment you edit it.

The pattern: a single **JSON catalog** of immutable plan entries keyed by **slug**, loaded once through a typed accessor module that every subsystem consumes. A plan slug is born once and never edited. Changing a price = adding a *new* slug and closing the old one. Two orthogonal axes — a `public` boolean and an `open_date`/`close_date` window — separate **"shown to new buyers"** from **"still billable for existing subscribers."** A retired plan stays in the catalog forever (still resolvable, still billed) but stops appearing in the offer list.

Reference implementation: `docpost` (`docpost-app/`). Key files cited inline:
- `data/plan-catalog.json` — the catalog (single source of truth)
- `lib/plan-catalog.ts` — typed loader, validation, accessors
- `app/api/webhooks/stripe+api.ts` — slug ↔ Stripe price-id resolution
- `lib/entitlements.ts`, `lib/usageMetering.ts` — feature gates + quota reading the catalog
- `agent/billing-stripe.md` — the full versioning rule

## Core Pattern: immutable slug + two-axis lifecycle

A slug is the permanent identity of a set of billing terms. Encode a version stamp in it so a new version is a new slug:

```
{tier}-{term?}-{YYMM}      e.g.  standard-annual-2605   (Standard / annual / opened 2026-05)
                                 starter-2605           (free tier, no term)
                                 overage-100-2605       (one-time pack)
```

Every entry shares a common envelope, then specializes by `kind`:

```jsonc
{
  "slug": "standard-annual-2605",   // IMMUTABLE identity — never edit in place
  "kind": "subscription",           // subscription | overage | seat_pack | referral_bonus
  "tier": "standard",
  "term": "annual",                 // monthly | annual | null
  "public": true,                   // axis 1: appears in offer lists?
  "open_date": "2026-05-01",        // axis 2: billable window start
  "close_date": null,               // null = still open to new signups; a date = retired
  "display_name": "Standard",
  "price": 300,                     // MAJOR units (dollars), not cents
  "currency": "usd",
  "stripe": { "product_id": "prod_…", "price_id": "price_…" },  // pinned per slug
  "limits":   { "signatures_per_year": 240, "signers_per_document": 4, "max_seats": 10 },
  "features": { "api_access": false, "sso": false, /* …every flag, explicit */ }
}
```

The two axes are independent and both load-bearing:

| | `public: true` | `public: false` |
|---|---|---|
| **open window** (`open_date ≤ today < close_date`) | offered to new buyers AND billable | custom/enterprise deal — billable, never advertised |
| **closed** (`close_date ≤ today`) | retired — existing subscribers keep billing, no new signups | dead custom deal — billable for whoever's on it |

**Why two axes, not one status enum:** "is this advertised" and "is this billable" are genuinely different questions with four real combinations (notably the public-but-closed legacy plan and the private-but-open enterprise deal). A single `status: active|retired` field collapses them and forces a lie about one of the two.

### The versioning move

When pricing changes, you **never** touch the live slug. Instead:

1. Add a new entry with a new slug (new `YYMM`) and a fresh Stripe Price.
2. Set `close_date` on the old slug to today.
3. Existing subscribers keep `org.plan = "standard-annual-2605"` forever and keep paying the old price; their `getPlan()` still resolves.
4. New signups route through `latestOpenPlan(tier, term)`, which returns the new slug.

No subscriber migration, no data backfill, no grandfather-clause branching in code. The old terms live in the old slug.

## The typed loader

`lib/plan-catalog.ts` is the only module that imports the JSON. It does four things; copy the shape:

1. **Import + cache once.** `import catalogData from '../data/plan-catalog.json'` then a module-level `let cache` populated on first access. Bundlers inline the JSON; there's no runtime fetch.
2. **Validate on first load, fail hard.** A `validateAndCast()` runs per-`kind` shape checks and throws `[plan-catalog] {slug}: {msg}` on any violation — duplicate slug, wrong type, unknown kind, version mismatch. **Why:** the catalog is hand-edited JSON with no compiler over it; a typo (price as string, missing limit) must blow up at boot, not silently mis-bill a customer. Expose a `_resetCatalogCache()` for tests.
3. **Discriminated union types.** `type Plan = SubscriptionPlan | OveragePack | …`, each extending a `PlanCommon`, discriminated on `kind`. `tier`/`term`/`kind` are string-literal unions, not `string`.
4. **Narrow accessors** — never export the raw array; export intent-named functions:

```ts
getPlan(slug): Plan | null                         // identity lookup — used by billing/quota/gates
getPlanByStripePriceId(priceId): Plan | null       // reverse lookup for the webhook
listPublicPlans(today = new Date()): SubscriptionPlan[]   // offer list: public && open
latestOpenPlan(tier, term, today = new Date()): SubscriptionPlan | null  // signup routing
```

`isOpenAt(plan, today)` is the shared predicate (`open_date ≤ today` and no `close_date ≤ today`). The offer-list functions are `.filter(isSubscription).filter(p => p.public && isOpenAt(p, today))`. `latestOpenPlan` filters by `(tier, term)` open entries and `reduce`s to the max `open_date` — so the newest slug wins automatically when you add one.

**Why pass `today` as an injectable default:** lets tests assert the window logic deterministically without mocking the clock.

## Consumption points (all read through `getPlan`)

The whole point is that nothing re-implements pricing — every surface calls the loader:

- **Signup / offer UI** → `listPublicPlans()` / `latestOpenPlan(tier, term)`. The landing page literally cannot show a retired plan because the filter excludes it.
- **Feature gates** (`lib/entitlements.ts`) → `planHasFeature(slug, feature)` does `getPlan(slug)?.features[feature]`; `requireFeature(org, feature)` throws a 403 when false. Subscriber's stored slug drives it, including retired ones.
- **Quota / metering** (`lib/usageMetering.ts`) → `getPlan(org.plan).limits` supplies the caps that `checkSignatureQuota` enforces (returns 402 when exhausted).
- **Stripe webhook** (`app/api/webhooks/stripe+api.ts`) → see below.

### Stripe binding: price-id pinned per slug

Each slug pins its own `stripe.price_id`. Resolution is two-way and slug-first:

```ts
function planFromSubscription(sub): string | null {
  const metaSlug = sub.metadata?.plan_slug          // 1. trust the slug we stamped at checkout
  if (metaSlug && getPlan(metaSlug)) return metaSlug
  const item = sub.items.data[0]                    // 2. fall back to reverse lookup by price id
  return getPlanByStripePriceId(item?.price?.id ?? '')?.slug ?? null
}
```

**Why slug-in-metadata first, price-id second:** the slug is your identity; the price-id is Stripe's. Stamping `plan_slug` into subscription metadata at checkout means you resolve back to the *exact* slug the customer bought even if two slugs ever shared economics. The price-id reverse lookup is the safety net for subscriptions created outside your checkout. Retiring a plan never deletes its Stripe Price, so the reverse lookup keeps working for legacy subscribers.

Two reserved-slug escape hatches worth copying:
- `HOST_PLAN = 'host'` — an in-code sentinel (not in the catalog) that `planHasFeature` short-circuits to `true`; for internal/host orgs that bypass all gates.
- `FALLBACK_PLAN = 'starter-2605'` — the free slug an org reverts to on `customer.subscription.deleted` or a non-active status.

## Fit-to-Project

Before implementing, decide:

- **Where does the JSON live and how is it loaded?** A bundler `import` (as in docpost) inlines it at build — simplest, requires a deploy to change pricing. If pricing must change without a deploy, load from a config store/DB instead, but keep the same loader+validate+cache+accessor shape.
- **What's your slug version stamp?** `YYMM` works if you version less than monthly; use a full date or a sequence if you might ship two versions in one month.
- **What are your `limits` and `features` keys?** These are 100% domain-specific (docpost uses signature quotas + 28 boolean compliance/feature flags). Enumerate *every* feature flag on *every* plan explicitly — no inheritance, no defaults.
- **Price units:** pick major units (dollars) or minor (cents) and assert it in validation. docpost uses major units; Stripe wants cents — convert at the boundary, don't store both.
- **What's your fallback plan and host/bypass model?** Most apps need a free/cancelled-state slug and possibly an internal-bypass sentinel.
- **Payment processor:** the slug↔price-id binding generalizes to any processor — pin the processor's price/product id per slug, resolve slug-first with a reverse lookup fallback.

## Anti-Patterns

- **Editing a shipped slug's price/limits/features.** This silently re-prices or re-gates every existing subscriber on that slug. A shipped slug is immutable; change = new slug + `close_date` on the old. This is the entire reason the pattern exists.
- **Deleting a retired plan from the catalog.** `getPlan(oldSlug)` then returns null and every subscriber on it loses their limits, feature gates, and webhook resolution. Retired plans stay in the file forever; `public`/`close_date` hide them from offers, they are not removed.
- **One `status` field instead of two axes.** Collapsing `public` and the date window loses the public-but-closed (legacy) and private-but-open (enterprise) quadrants and forces special-case branching back into code.
- **Computing the offer list anywhere but the loader.** A landing page that hardcodes tiers, or filters on its own, will drift from billing and eventually advertise a retired or mis-priced plan. Offer UIs call `listPublicPlans` / `latestOpenPlan`, full stop.
- **Reading `plan.features` / `plan.limits` off a copy instead of `getPlan(org.plan)`.** Caching a plan object on the org doc (or in the session) re-introduces the mutation problem and goes stale. Store only the **slug** on the entity; resolve live every time.
- **Trusting the Stripe price-id as the primary key.** Resolve slug-first (from checkout metadata), price-id only as fallback. The price-id is Stripe's identity, not yours, and one slug can outlive a Price object.
- **Skipping startup validation because "it's just JSON."** Hand-edited JSON has no type-checker. Without a fail-hard validator, a `price: "300"` or a missing `signers_per_document` ships and mis-bills before anyone notices. Validate every entry on first load and throw.
- **Letting two open slugs share one `(tier, term)` without intending it.** `latestOpenPlan` silently picks the max `open_date`; if you forget to `close_date` the prior version, new signups jump to the new price but you may not have meant to open it yet. Closing the old slug in the same edit is part of the versioning move.

## Logging

- **At load:** validation throws are the log — the `[plan-catalog] {slug}: {msg}` prefix makes a bad catalog edit obvious at boot. Don't swallow them.
- **At resolution:** when the webhook falls back from metadata-slug to price-id lookup (or fails both and uses `FALLBACK_PLAN`), log the subscription id, the attempted slug/price-id, and the chosen slug. **Why:** a customer on a plan that resolved to the fallback is a billing incident you want to catch from logs, not a support ticket.
- **At gate/quota denial:** log org id, stored slug, and the feature/limit that denied — so "why can't this paying customer do X" is answerable without a repro.
