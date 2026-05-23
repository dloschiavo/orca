# App Build Kit Checklist

> Goal: Everything below is done once in the kit. Per-app work is **business logic only**.
>
> Each section splits into **Minimum** (ship-blocking — every app needs this) and **Enhancements** (nice-to-have, add per app as needed).
>
> `[x]` = recipe written. `[ ]` = no recipe yet.

---

## Auth & Identity

**Minimum:**

- [x] OTP (email) — `recipes/otp.md` · email OTP with magic link, 6-digit code fallback, SES delivery
- [x] Session management (token refresh, expiry, revocation) — `recipes/otp.md` · rolling expiry, TTL index auto-cleanup, HttpOnly cookie, multi-device sessions
- [x] Role-based access control (RBAC) — admin, user, custom roles — `recipes/otp.md` · `user`/`admin` roles on `users` collection, `requireAdmin()` middleware
- [x] Auth-aware SSR middleware (server-side redirect for protected SSR routes, client-side guard for SPA routes) — `recipes/otp.md` · `getSession`/`requireSession`/`requireAdmin` + server HTML redirect + client `useAuth()` guard

**Enhancements:**

- [x] Password reset flow (only needed if email+password auth is added) — `recipes/password-reset.md`
- [x] OAuth — Google — `recipes/oauth-google.md` · conditional on `OAUTH_GOOGLE_CLIENT_ID`
- [x] OAuth — Apple — `recipes/oauth-apple.md` · conditional on `OAUTH_APPLE_CLIENT_ID`
- [x] OAuth — GitHub — `recipes/oauth-github.md` · conditional on `OAUTH_GITHUB_CLIENT_ID`
- [x] OTP via SMS — `recipes/sms-otp.md` · conditional on `SMS_PROVIDER`

---

## User Management

**Minimum:**

- [x] Admin CRUD of users — `recipes/admin-user-crud.md` · paginated list, detail view, role management, session revocation, search/filter
- [x] User profile / settings page (name, email) — `recipes/otp.md` · `/account` section with display name edit, alerts panel

**Enhancements:**

- [x] Avatar upload — `recipes/avatar-upload.md` · conditional on `FILE_STORAGE_PROVIDER`
- [x] Email preferences / notification opt-in/out — `recipes/notification-system.md`
- [x] Account deletion (GDPR-compliant, with data export) — `recipes/account-deletion.md` + `recipes/gdpr-data.md`
- [x] User impersonation (for support debugging) — `recipes/user-impersonation.md` · admin-only, time-limited, audit-logged, blocked destructive actions

---

## Onboarding

**Minimum:**

- [x] Email template scaffold (layout, SES integration) — `recipes/otp.md` · OTP email template via SES (plain text Phase 1)
- [x] First-run state detection mechanism (hook/component that detects empty state and renders guided prompts) — `recipes/first-run-detection.md`

**Enhancements:**

- [x] Pre-auth excitement stepper component (configurable per app) — `recipes/onboarding-enhancements.md`
- [x] Onboarding checklist / progress indicator component — `recipes/onboarding-enhancements.md`
- [x] Profile completion nudge component — `recipes/onboarding-enhancements.md`

---

## Subscription & Billing

**Minimum:**

- [x] Stripe (or provider) integration scaffold — `recipes/subscription-billing.md`
- [x] Subscription management (plans, upgrade/downgrade) — `recipes/subscription-billing.md`
- [x] Pricing page template / plan comparison component — `recipes/subscription-billing.md` + `recipes/seo-marketing-templates.md`
- [x] Invoices & receipts (email + in-app history) — `recipes/subscription-billing.md`
- [x] Dunning / failed payment handling (retry logic, grace period, lockout) — `recipes/subscription-billing.md`
- [x] Trial period / freemium logic — `recipes/subscription-billing.md`

**Enhancements:**

- [x] Promo code / coupon support — `recipes/billing-enhancements.md` · Stripe Coupons/Promotion Codes, admin UI, validation endpoint
- [x] Usage metering hooks (for usage-based plans) — `recipes/billing-enhancements.md` · Stripe Usage Records, dimension tracking, threshold alerts
- [x] Multiple payment methods per account — `recipes/billing-enhancements.md` · SetupIntents, default selection, fallback logic
- [x] Annual vs monthly toggle — `recipes/billing-enhancements.md` · interval pricing, proration, savings display

---

## Rendering & Routing

**Minimum:**

- [x] Route-level rendering config (SSR / SSG / SPA per section) — `recipes/rendering-routing.md`
- [x] Expo Router + Next.js integration boilerplate — `recipes/rendering-routing.md`
- [x] Shared layout system (no hydration mismatches across modes) — `recipes/rendering-routing.md`

**Enhancements:**

- [x] Loading / skeleton states per rendering mode — `recipes/rendering-enhancements.md` · shimmer animations, layout-shift prevention, per-content-type skeletons
- [x] Deep linking (native + web) — `recipes/rendering-enhancements.md` · universal links, app links, deferred deep links, auth-gated deep links

---

## SEO & Marketing

**Minimum:**

- [x] Landing page template (layout + component scaffold) — `recipes/seo-marketing-templates.md`
- [x] Pricing page template (plan comparison component) — `recipes/seo-marketing-templates.md`
- [x] FAQ page template (accordion component) — `recipes/seo-marketing-templates.md`

**Enhancements:**

- [x] `<SEOHead>` component (meta tags, Open Graph, Twitter cards, JSON-LD) — `recipes/seo-enhancements.md`
- [x] Canonical URL management — `recipes/seo-enhancements.md` · trailing slash normalization, query param stripping
- [x] Sitemap generator (auto-discovers SSR/SSG routes, ignores SPA) — `recipes/seo-enhancements.md` · XML sitemap, dynamic routes, sitemap index for large sites
- [x] robots.txt template — `recipes/seo-enhancements.md` · per-environment rules, admin/API/auth disallow
- [x] Changelog / what's new page — `recipes/seo-enhancements.md` · SSR-rendered, RSS feed, "what's new" badge tracking

---

## Notifications

**Minimum:**

- [x] Transactional email scaffold (SES integration, template rendering, shared layout) — `recipes/otp.md` · OTP/magic-link email via SES (partial — only auth emails built; payment/subscription templates still needed as kit-level scaffolds)

**Enhancements:**

- [x] In-app notification system (bell icon, unread count, notification feed) — `recipes/notification-system.md`
- [x] Push notification scaffold (Expo push + web push) — `recipes/notification-system.md`
- [x] Notification preferences (per-channel opt-in/out) — `recipes/notification-system.md`

---

## Legal & Compliance

**Minimum:**

- [x] Privacy policy (template + renderer) — `recipes/privacy-policy.md` · hosted at goliathdynamics.com/privacy/
- [x] Terms of service (template + renderer) — `recipes/dmca.md` · hosted at goliathdynamics.com/legal/
- [x] DMCA and other notices — `recipes/dmca.md` · hosted at goliathdynamics.com/legal/

**Enhancements:**

- [x] Cookie consent banner (with granular opt-in) — `recipes/cookie-consent.md`
- [x] GDPR data export endpoint — `recipes/gdpr-data.md`
- [x] GDPR data deletion endpoint — `recipes/gdpr-data.md` + `recipes/account-deletion.md`
- [x] Consent logging / audit trail — `recipes/cookie-consent.md`
- [x] Age gate (if applicable) — `recipes/age-gate.md` · conditional on `AGE_GATE_MINIMUM_AGE`, COPPA/GDPR compliance

---

## Admin Panel

**Minimum:**

- [x] Admin prompt queue — `recipes/admin-prompt-queue.md` · prompt CRUD with versioning, job queue with worker, Gemini handler, retry/backoff, admin UI
- [x] Admin dashboard (signups, active users, revenue, churn) — `recipes/admin-dashboard.md`

**Enhancements:**

- [x] Admin crawler — `recipes/admin-enhancements.md` · broken links, missing meta, slow pages, console errors, scheduled crawls
- [x] Feature flag management UI — `recipes/feature-flags.md`
- [x] Audit log viewer — `recipes/admin-enhancements.md` · searchable/filterable, CSV export, retention policy

---

## Support & Feedback

**Minimum:**

- [x] Contact / support form component (reusable layout, submission handler scaffold) — `recipes/contact-support-form.md`

**Enhancements:**

- [x] Bug report widget (with screenshot capture) — `recipes/support-enhancements.md` · auto-captures screenshot, console errors, device info
- [x] Ticketing integration hook (Zendesk, Intercom, etc.) — `recipes/contact-support-form.md` · conditional on `SUPPORT_INTEGRATION`
- [x] In-app feedback modal — `recipes/support-enhancements.md` · general feedback, feature requests, NPS-style ratings
- [x] Status page link / integration — `recipes/support-enhancements.md` · conditional on `STATUS_PAGE_URL`, polling external API

---

## Analytics & Tracking

**Minimum:**

- [x] Analytics wrapper (multi-context, server-side + client-side) — `recipes/analytics.md`
- [x] Event tracking integration (GA4 / PostHog / Mixpanel / Amplitude) — `recipes/analytics.md`

**Enhancements:**

- [x] Server-side page views for SSR routes — `recipes/analytics-enhancements.md` · SSR middleware, bot filtering, no double-counting
- [x] Client-side event tracking for SPA routes — `recipes/analytics-enhancements.md` · auto page views, data-track attributes, scroll depth, time on page
- [x] Conversion funnel helpers — `recipes/analytics-enhancements.md` · named funnels in config, drop-off detection, admin visualization
- [x] UTM parameter capture and persistence — `recipes/analytics-enhancements.md` · session storage, first/last-touch attribution, user record attachment

---

## Error Handling & Resilience

**Minimum:**

- [x] 404 page — `recipes/error-handling.md`
- [x] 500 / generic error page — `recipes/error-handling.md`
- [x] Rate limiting middleware — `recipes/otp.md` · auth-specific; generic middleware in `recipes/error-handling.md`
- [x] Global error boundary (React) — `recipes/error-handling.md`

**Enhancements:**

- [x] Maintenance mode toggle (with bypass for admins) — `recipes/maintenance-mode.md`
- [x] Crash reporting integration (Sentry / Bugsnag) — `recipes/error-handling.md` · conditional on `CRASH_REPORTING_DSN`
- [x] Offline fallback (native) — `recipes/offline-fallback.md` · network detection, request queue, local cache, conflict resolution

---

## Caching & Performance

**Minimum:**

- [x] Cache-control headers per route type (ISR for SSR, none for SPA) — `recipes/cache-headers.md`

**Enhancements:**

- [x] CDN config template (Vercel / Cloudflare) — `recipes/performance-enhancements.md` · conditional on `CDN_BASE_URL`, cache rules, purge strategy
- [x] Image optimization pipeline — `recipes/performance-enhancements.md` · conditional on `FILE_STORAGE_PROVIDER`, resize/WebP/blur placeholder/srcset
- [x] Bundle splitting defaults — `recipes/performance-enhancements.md` · route-level splitting, vendor chunk, size budgets, preload hints

---

## Developer / Ops Scaffolding

**Minimum:**

- [x] Environment config management (.env schema, validation) — `recipes/dev-ops.md`
- [x] Health check endpoint — `recipes/dev-ops.md`
- [x] Logging framework (structured, leveled) — `recipes/dev-ops.md`

**Enhancements:**

- [x] Feature flags (runtime toggleable, per-environment) — `recipes/feature-flags.md`
- [x] Audit trail system — `recipes/devops-enhancements.md` · append-only log, auto-captured events, configurable retention
- [x] CI/CD pipeline template — `recipes/devops-enhancements.md` · GitHub Actions primary, staging/production deploys, PR previews, rollback
- [x] Database migration scaffold — `recipes/devops-enhancements.md` · timestamped migrations, up/down, locking, CLI commands
- [x] API versioning convention — `recipes/devops-enhancements.md` · URL-based `/api/v1/`, deprecation headers, sunset dates

---

## App Config & Theming

**Minimum:**

- [x] App manifest / config file (app name, colors, logo, feature toggles) — `recipes/app-config-theming.md`
- [x] Theme system (colors, typography, spacing — per-app overrides) — `recipes/app-config-theming.md`

**Enhancements:**

- [x] Dark mode support — `recipes/theming-enhancements.md` · system preference + manual toggle, CSS custom properties, no flash on SSR
- [x] White-label / branding config — `recipes/theming-enhancements.md` · per-tenant branding, subdomain detection, email template theming

---

## SaaS Features

**Enhancements:**

- [x] Multi-tenancy (shared DB with tenant_id or DB-per-tenant) — `recipes/saas-enhancements.md` · conditional on `MULTI_TENANCY_MODE`, tenant isolation, suspension
- [x] Demo account / sandbox mode — `recipes/saas-enhancements.md` · conditional on `DEMO_ACCOUNT_ENABLED`, temp sessions, read-only, periodic reset
- [x] Team management (invite, roles, seat limits) — `recipes/saas-enhancements.md` · owner/admin/member/viewer roles, invitation flow, seat limits tied to plans
- [x] Workspace switcher — `recipes/saas-enhancements.md` · multi-tenant context switching, last-used persistence
- [x] API key management — `recipes/saas-enhancements.md` · tenant-scoped keys, permissions, rate limiting, rotation
- [x] Webhook system (outbound) — `recipes/saas-enhancements.md` · HMAC-SHA256 signing, retry with backoff, delivery logs

---

## Hosting & Deployment

**Enhancements:**

- [x] GitHub Pages landing page hosting — `recipes/github-pages-hosting.md` · conditional on `GITHUB_ORG` + `GITHUB_TOKEN` + `LANDING_PAGE_DOMAIN`, programmatic repo creation, Pages setup, domain verification

---

## Per-App Checklist (copy for each new app)

- [ ] Stack description (usually Expo web + React Native)

**Config & Identity:**

- [ ] Set app name, bundle ID, domain in config
- [ ] Set brand colors / logo / theme
- [ ] Configure rendering mode per section (SSR vs SPA)
- [ ] Define user roles
- [ ] Set up DNS + deploy

**Content (can't be scaffolded — requires app context):**

- [ ] Write landing page copy + hero content
- [ ] Write pricing page copy + define subscription plans
- [ ] Write FAQ content
- [ ] Write welcome / onboarding email copy
- [ ] Write transactional email copy (payment receipt, subscription change, etc.)
- [ ] Define first-run empty states and guided prompts
- [ ] Write SEO content for SSR pages (meta descriptions, OG tags, JSON-LD)
- [ ] Write seed data script
- [ ] Configure support form destination (email, Zendesk, etc.)

**Wiring:**

- [ ] Wire up business logic
- [ ] Configure analytics events
- [ ] Define feature flags (if using)
