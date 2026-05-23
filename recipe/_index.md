# _recipes

Skill library. Read this index, then load only the relevant SKILL.md.

## Recipe execution rules

When you install a recipe from /Goliath/_recipes, the SKILL.md file is your
specification, not reference material.  The following rules are binding:

1. READ THE RECIPE TWICE. Read SKILL.md at the start of the install. Read it
   again, in full, immediately before you declare the task complete. The
   second read is not optional. State explicitly that you have done it.

2. HARD SPECIFICATIONS. Recipes are to be treated like an LLM version of an npm install  
  or a pip install, with the code implemented as close to the recipe as possible, only modifications for wiring the codebase up to the implementation of the recipe.  

3. LITERAL STRINGS ARE LITERAL. Any string the recipe specifies (persona
   names, titles, env var names, error messages, route paths) must appear
   verbatim in your implementation. You may not rename, paraphrase, or
   "improve" them. If the recipe says "Inbound Support Specialist", that
   exact string must appear in your diff. Grep your diff for it before
   declaring done.

4. ANTI-PATTERNS ARE FORBIDDEN, NOT DISCOURAGED. Before declaring done, you
   must re-read the recipe's Anti-patterns section and, in your final
   message, list every anti-pattern from the recipe and confirm with a
   file:line citation that it does not appear in your diff. If you cannot
   confirm, the install is not done.

5. NO `as any`. You are forbidden from `as any`, `@ts-ignore`, and
   `@ts-expect-error`. If types don't line up, the wiring is wrong — fix
   the underlying type. Silencing the type checker is shipping a bug.

6. COMPILING IS NOT VERIFYING. `tsc` passing is necessary but not
   sufficient. Before declaring done you must run the dev server and
   exercise the user-visible behavior the recipe describes. If you cannot
   run the dev server, the task is BLOCKED, not COMPLETE. "I wrote the
   files and the build is green" is not a completion signal.

7. ALL DELIVERABLES ARE A CHECKLIST. Treat every requirement in the recipe
   (deliverables, behaviors, file paths, function signatures) as a
   checklist item. In your final message, restate each item and mark it
   ✅ done with file:line, ❌ skipped (and explain why), or ⚠️ partial
   (and explain what's missing). No item may be silently omitted.  For each ANTI-PATTERN, you must also explicitly restate each an mark it ✅ done without violation, ❌ violated, or ⚠️ partial violation.

8. PROSE REQUIREMENTS ARE NOT OPTIONAL. The recipe contains UX requirements
   like "focus the input on open" or "click outside to close" written in
   English. These have the same weight as schema requirements. Implement
   and verify them like everything else.

9. WHEN IN DOUBT, COPY. If the recipe shows code, copy it. Do not
   reimplement from your memory of how that thing is "usually" done. Your
   priors about what a chat widget or upload handler "should" look like
   are exactly what the recipe is correcting. The recipe is right; your
   priors are wrong.  

10. DEPENDENCIES ARE INSTALLED FIRST. Before installing a recipe, read the
    `dependencies:` block in its SKILL.md frontmatter. For every entry under
    `requires:`, verify that recipe is already installed in the target
    repo; if it isn't, install it first (recursively — its own
    dependencies install first too). For every entry under `capabilities:`,
    check whether anything already installed in the repo `provides:` that
    capability; if nothing does, install the listed default. Never proceed
    to the recipe's own implementation with an unresolved dependency.
    Cycles are a bug — if you detect one, stop and report it.

If you cannot satisfy any of these rules for any reason, stop and report
the blocker. Do not declare the task complete with rules unsatisfied.
"Mostly done" is the same as "not done" for this queue.

## Dependency model

Recipes declare what they need in their SKILL.md frontmatter:

```yaml
dependencies:
  requires: [recipe-a, recipe-b]      # hard: must be these exact recipes
  capabilities:
    auth: otp-auth                    # any provider of `auth`; default = otp-auth
    design-system: admin-only-notus
provides: [some-capability]           # what this recipe satisfies for others
```

- **`requires`** — hard dependency on a named recipe. The recipe directly
  consumes something the named recipe contributes (an install-time
  registration hook, a specific helper, a shared collection it owns).
- **`capabilities`** — soft dependency on an *interface*. Any installed
  recipe whose `provides:` list includes the capability satisfies it. The
  map value is the **default** to install if nothing in the target repo
  already does.
- **`provides`** — capabilities this recipe satisfies for others.

### Capability registry

The closed vocabulary so two recipes don't invent two names for the same
thing.

| capability | default implementation |
|---|---|
| `auth` | `otp-auth` |
| `tenancy` | `multi-tenant` |
| `user-admin` | `admin-user-crud` |
| `rbac` | `admin-roles-crud` |
| `prompt-queue` | `admin-prompt-queue` |
| `admin-chat` | `admin-chat` |
| `admin-routing` | `admin-routing` |
| `cms` | `cms` |
| `public-page` | `landing-marketing-site` |
| `fingerprint` | `visitor-fingerprint` |
| `design-system` | `admin-only-notus` |
| `stack` | `stack` |
| `auditor` | `auditor` |
| `deploy` | `admin-gcp-deploy` |
| `mfa` | `mfa-totp` |
| `geoip` | `geoip-mmdb` |

## Skills

| Skill | Description | Path |
|---|---|---|
| admin-chat | One admin page at `/admin/chat` with two tabs (In-app, Public) reviewing flagged messages from every chat surface. Generic cross-month query helpers (prefix-based), shared filter set, paired Notus flag/sentiment badges, optimistic resolved toggle, row-expand panel, and a per-tab Compile KB header button (consumer-supplied prompt slug + output path + onComplete). Both `chat-support` and `public-contact-chat` register one tab each. | admin-chat/SKILL.md |
| admin-feed-basic | Operator-attention queue at `/platform/feed` — one ranked list of "things that need a human" backed by a single `feed_items` collection and an idempotent `emitFeedItem()` helper any producer can call. Page has stats strip, category/priority/state filters, snooze + dismiss + resolve transitions, optimistic mutations, hash routing, and a snooze unsnoozer cron. Three baked-in producers: `chat.unviewed` (per-org dedup, resolves on read receipt), `system.exception` (fingerprint dedup, dual-writes to `system_exceptions`), and `security.notable` (failed-login burst, role change, audit anomaly). | admin-feed-basic/SKILL.md |
| admin-feed-deep | Layers more producers onto `admin-feed-basic` without adding a new collection, helper, or page — `signature.*` (stuck, viewed-unsigned, bounced, compliance-risk), `drive.*` (sync failed, oauth expired, ingest failed), `ingest.*` (embedding failed, classification pending, KB stale), `lifecycle.*` (new orgs, invited-no-login, plan-limit, trial-expiring, churn-risk), and `billing.*` (payment failed, subscription canceled, refund). Defines per-producer dedup-key shapes, priority defaults, and resolution rules; spells out the optional `/admin/feed` org-level mirror with the data-scope rule that mirrors the route's auth scope. | admin-feed-deep/SKILL.md |
| admin-gcp-deploy | Canonical GCP deploy stack for any Goliath project — Cloud Build → Artifact Registry → Cloud Run, Firestore in MongoDB-compat mode (native `mongodb` driver, no Firestore SDK), Secret Manager → runtime env with build-time vs runtime split, fail-secure `LOCALHOST_AUTH_BYPASS`. Drops in framework-aware Dockerfile (Next.js / Expo / FastAPI), `cloudbuild.yaml`, idempotent `gcp-bootstrap.sh`, and `sync-local-to-firestore.mjs`. Installs a superadmin-only status page at `/admin/deploy` with a check registry: every human task (project+billing, Firestore enable, GitHub App install, domain verify, DNS, SSL) gets live detection; every automated task (bootstrap, secrets populated, initial sync, first deploy, last build) reports progress or names the upstream human task blocking it; security invariants (`auth-bypass-off-in-prod`, `cookie-secure-prod`) raise a sticky `security-fail` red banner. Foreground-only polling (no background worker): 30s while deploying, 5min once deployed, paused on hidden tab; "Recheck now" buttons drive on-demand recompute. Auto-detects third-party integrations (SES, Stripe, Gemini, Anthropic, OpenAI, Twilio, S3, Sentry, R2) from `package.json` + env-var scan and registers each integration's human/runtime checks; mismatches resolve to `.deploy-spec.yaml`. | admin-gcp-deploy/SKILL.md |
| admin-prompt-queue | Async prompt execution with operator visibility — versioned template manager, per-entity editor+history page, universal queue page, and a Schedules surface for cron-style fires backed by a `prompt_schedules` collection. Each schedule carries three rolling-window USD spend caps (daily / weekly / monthly, default $1/$5/$15) that **skip the fire** with a `status="skipped"` row when exceeded; cadence defaults to **weekly**. A separate scheduler enqueues into the same queue (never calls the LLM directly), so manual and scheduled fires share the worker, snapshot rule, and JobCard. Jobs snapshot the full prompt object and full response on each row. | admin-prompt-queue/SKILL.md |
| admin-roles-crud | Admin UI for managing RBAC roles and the permission catalog. Hardcoded `ALL_PERMISSIONS` catalog with prefix-based grouping, system-role seeding with implicit perms for superadmin/admin, two-column checkbox grid editor, and mandatory delete-with-migration cascade across `users.role` and `org_members.role`. Consumes `otp-auth`. | admin-roles-crud/SKILL.md |
| admin-routing | Baseline URL + auth-gate contract for every admin surface. Dashboard at `/admin/`, directory-style `admin/{page}/` routes only, CRUD as `admin/{page}/{id}`, tabs in the URL hash as `#{tab}`, modals as `#{modal}` with cold-load reopen, single `_layout.tsx` auth gate that redirects to `/login?redirect=` and passes through `LOCALHOST_AUTH_BYPASS`. Prerequisite for every other `admin-*` skill. | admin-routing/SKILL.md |
| admin-user-crud | Admin UI for managing users — paginated list with search/filters and create-user modal, detail view with sessions and audit history as full-width cards, editable email/role/display_name with collision check, session revocation, email-health reset, and tiered delete (soft for users, hard for admins, superadmin undeletable). Defines the shared `audit_log` collection. Consumes `otp-auth`. | admin-user-crud/SKILL.md |
| auditor | Library hygiene linter for `_recipes` itself. Catches drift after a recipe refactor: `_index.md` rows pointing at non-existent paths, untracked SKILL.md dirs, dependency-graph cells that disagree with frontmatter, undeclared cross-recipe references in prose, capability keys outside the registry, duplicate anti-patterns after an extract, stale File Maps. Reports findings; does not auto-fix. | auditor/SKILL.md |
| geoip-mmdb | IP-to-location lookups using DB-IP's free City Lite binary MMDB (no account, no key, CC BY 4.0). **Pluggable backend, auto-selected**: `local-disk` (default, dev / single-box) or `gcs` (active when `GEOIP_GCS_BUCKET` set; correct for Cloud Run / k8s where local disk evaporates on restart). Both backends share the same fetch/validate/atomic-rename flow; only the persistence differs. Monthly cron triggers `backend.refresh()` via `pnpm refresh-geoip`, `POST /api/admin/geoip/refresh`, or a separate Cloud Run Job. Cloud Build runs a `pnpm check-geoip` presence/staleness pre-step that cheap-fetches `version.json` from GCS and only fires a real refresh when missing or older than `GEOIP_STALE_DAYS` (default 35) — self-bootstraps GCS on first deploy and catches stalled crons at build time. In-process singleton Reader (`maxmind` npm) lazy-loads on first lookup; `watchForUpdates: true` hot-reloads on atomic rename. **Admin spoof cookie** lets staff override their resolved location for testing (paste an IP or fill out city/lat/lng); feature code calls `getEffectiveGeo(request)` which honors the cookie before falling back to `lookupIp`. `/admin/geoip` has 3 cards (status + spoof + test-lookup). No Mongo writes anywhere. | geoip-mmdb/SKILL.md |
| extension-crawler | Authenticated-site crawler built as a Chrome MV3 extension + backend queue. User's real Chrome does the scraping (cookies, fingerprint, MFA intact — no headless footprint), so auth-gated and anti-bot-heavy targets work where Playwright fails. Backend owns `crawl_populators` (canonical URL patterns + per-pattern interval) and `crawl_history` (jobs keyed on the three-timestamp model `dt_queued`/`dt_start`/`dt_scraped=null⇒pending`). Service worker polls, opens one hidden `active:false` tab at a time with a 20s timeout + 10–12s jittered inter-crawl delay, gates on `chrome.idle.queryState`. Per-page content scripts (routed by a Loader) extract and `/upsert` with `_setIfMissing`/`_addToSet` so weaker sources never clobber ground truth. Admin page shows targets + queued/scraped/failed tabs + heartbeat. | extension-crawler/SKILL.md |
| cms | Lightweight CMS for content items: multi-slug 301-redirect chains, dirty-state save + publish toggle, WYSIWYG editor emitting CommonMark (tables excluded), S3/local image upload with paste + drag-drop, and a sticky public-side table-of-contents sidebar with scroll-spy active highlighting. Editor mounts at `/platform/cms` (not `/cms` or `/admin/cms`). | cms/SKILL.md |
| connectivity-banner | Single red banner across the top of the app that names *which* layer is broken — user's internet, backend, or backend-in-dev — using a no-cors probe of `google.com/generate_204` to disambiguate. One pub/sub reachability flag fed by the API client wrapper (every successful fetch marks reachable, every network-level throw marks unreachable) plus a 2s `/health` poll that only runs while offline. Suppresses redundant "Failed to fetch" toasts during outages, mounts above the auth gate so a dead backend still gets an explanation, and gates the "restart the dev server" message on `import.meta.env.DEV` so production users never see it. | connectivity-banner/SKILL.md |
| draft-persistence | localStorage-backed form draft store. Every keystroke persists; drafts survive tab crashes, dev-server OOM, network failures, and deploys. Cleared only on a confirmed server ack (2xx). Covers single-string forms, compound-object forms, and send-and-forget chat inputs with failure recovery. Fixes the classic `setValue(""); await fetch(...)` bug that silently destroys typed work on any failure mode. | draft-persistence/SKILL.md |
| code-qa | Binding code-QA checklist covering every UI/UX, layout, state, table, scraping, backend, React-lifecycle, architecture, and server-testing rule mined from past post-mortems. Run after any build/refactor/review, or on `rx code-qa`. Produces a single markdown report where every rule is affirmatively marked PASS / FAIL / FAIL WITH EXPLANATION / N/A (with justification) — a silent omission is itself a fail. | code-qa/SKILL.md |
| chat-support | Full in-app authenticated chat system: org-scoped group chat, Ashley AI agent, chat drawer UI, translator dropdown with country flags, per-message translation chips, participant chips, read receipts, push fallback jobs, monthly `chat_YYYY_MM` rotation, and inline rate limiting with per-message `rate_limited` stamp. Registers the In-app tab into `admin-chat` (with the `ashley-compiler` Compile KB config) and uses `admin-prompt-queue` for the KB compilation worker. Covers both Expo Router +api.ts (TS/Gemini) and FastAPI/Python (Motor/Claude) variants. | chat-support/SKILL.md |
| landing-marketing-site | Public marketing pages inside an Expo Router app: layout-level public-route allowlist that stays public for logged-in users too (no admin sidebar bleed-through), auth-aware Sign In CTA that routes straight to the dash, responsive landing header with left-side mobile hamburger drawer, branded footer, hero/feature/team page patterns, Google Fonts injection on RN Web, top-anchored image crop workaround, `lineHeight` pixel gotcha, `require()` asset-module gotchas, and the DOM CustomEvent bridge to the public-contact-chat drawer. | landing-marketing-site/SKILL.md |
| admin-only-notus | Notus React design-system rules for internal/admin pages ONLY — hard isolation from public: no shared header, footer, CSS, layout, assets, or components with public pages; installing this recipe must not touch any public files. blueGray + lightBlue palette only, canonical card surface, canonical form input (with explicit "Chat Textarea — Stop Reinventing It" rule against `rounded-full`), button variants, paired-color status badges, page-layout shell with `-mt-24` overlap variant, flex-weighted tables that fill their card, FontAwesome5 over emojis, and a pre-flight checklist + anti-pattern list mined from recurring violations. | admin-only-notus/SKILL.md |
| multi-tenant | Organizations as the unit of tenancy: embedded `members[]` array on the org doc, slug-based URLs as the active-org source of truth (no session field), `requireOrgMember(request, orgId, minRole)` with rank-based owner/operator/viewer gating, per-org `domains[]` with auto-join wired into `otp-auth`'s `promoteSession`, navbar org switcher backed by a `useSyncExternalStore` localStorage hint, `platform_settings` single-key collection, superadmin-only host-org dropdown page, and a lazy-on-connect bootstrap seed for Goliath Dynamics Inc. (`gdi`) with David as founding owner + host org. Consumes `otp-auth`. | multi-tenant/SKILL.md |
| public-contact-chat | Unauthenticated public-facing inbound contact chat widget with a persona-driven AI agent. Floating-drawer vs full-height right-rail sidebar shell variants, brand-color theming, AgentIdentity header (avatar + name + title + timestamp), click-outside-to-close, focus-textarea-on-open, monthly `contact_YYYY_MM` collection rotation, fingerprint-based bot detection with no-LLM fallback path, inline rate limiting, 30-second idle re-engagement frames, pre-generated welcome bubbles, typing indicator delay tuning, and lazy prompt seeding. Registers the Public tab into `admin-chat` (with the `amelia-compiler` Compile KB config). | public-contact-chat/SKILL.md |
| otp-auth | Email OTP / magic-link authentication with a sessions collection, native MongoDB driver, opaque-hex `user_id` decoupled from email so addresses are mutable behind a unique index, and a fail-secure LOCALHOST_AUTH_BYPASS dev opt-in. Includes FastAPI/Python variant with granular RBAC (`has_permission` / `require_permission`). | otp-auth/SKILL.md |
| mfa-totp | Optional authenticator-app (TOTP) second factor layered onto `otp-auth`. Default is opt-in: no user is forced unless an org owner flips a per-org `mfa_required` toggle. Single-source-of-truth policy function (`isPolicyRequired`) consulted by the login state machine, the disable endpoint, and the org-settings toggle UI. Four-state session machine (`pending → mfa_enroll | mfa_challenge → active`), AES-256-GCM-encrypted secrets, 10 single-use recovery codes, anti-replay via `mfa_last_used_step`, 5-min step-up window for sensitive actions, and trusted-device behavior piggybacked onto the existing 30-day rolling session cookie (no separate device record). Four-tier admin recovery: self-service recovery codes, peer reset by another org owner, support reset with mandatory 24h delay + cancel link, and superadmin break-glass via offline vault. Cohort forcing (superadmin / host-org / org-owner / role-based) documented in Fit-to-Project as one-line extensions. Skips SMS, security questions, and backup-device enrollment by design. | mfa-totp/SKILL.md |
| skill-creator | Use when extracting a QA-validated feature into a portable SKILL.md — what to capture, what to leave out, and how to mine anti-patterns. | skill-creator/SKILL.md |
| stack | The default Goliath stack — Expo + RN client with Expo Router `+api.ts` routes as the backend, native MongoDB driver, optional Next.js for SSR/logged-out pages, single EC2 box in prod. Includes FastAPI/Python (Motor) variant for Python-first backends. **Before scaffolding, run the `Pre-install: detect the canonical webapp` check at the top of the SKILL — if the repo already has a Next.js app with non-trivial routes, admin/auth go INTO it, not into a parallel Expo app.** | stack/SKILL.md |
| visitor-fingerprint | Anonymous visitor IDs via open-source FingerprintJS — client-only, cookie-cached for a year, lazy-imported, SSR-optional, no API keys. | visitor-fingerprint/SKILL.md |
| web-scraping | Reliable scraping for SPAs and anti-bot sites. Two-phase: discovery then extraction. Playwright over Firecrawl. | web-scraping/SKILL.md |
| service-ports | Uniform `dev`/`build`/`start`/`typecheck`/`clean` script contract for every Goliath repo, plus a copy-in `scripts/service-ports.mjs` helper that registers each running dev service in `/tmp/goliath-{port}` and hunts for a free port instead of cross-killing sibling projects (replaces `lsof -ti:N \| xargs kill -9` predev hooks). Handles Vite/Next/Express/Hono/Expo with peer discovery (web → server URL via env var) and a dev-mode CORS regex widening on the backend so symmetric port hunting works end-to-end. Dev-only registration; `pnpm start` is the uniform prod entry that Cloud Run drives via `process.env.PORT`. | service-ports/SKILL.md |

## Dependency graph

Quick lookup. Authoritative source is the `dependencies:` block inside each
SKILL.md frontmatter — verify there before installing.

| Skill | requires (hard) | capabilities (default) | provides |
|---|---|---|---|
| admin-chat | admin-prompt-queue, admin-routing | auth (otp-auth), design-system (admin-only-notus) | admin-chat |
| admin-feed-basic | admin-routing | auth (otp-auth), design-system (admin-only-notus) | admin-feed |
| admin-feed-deep | admin-feed-basic | auth (otp-auth), design-system (admin-only-notus) | admin-feed-deep |
| admin-gcp-deploy | admin-routing | auth (otp-auth), design-system (admin-only-notus) | deploy |
| admin-prompt-queue | admin-routing, draft-persistence | auth (otp-auth), design-system (admin-only-notus) | prompt-queue |
| admin-roles-crud | admin-routing | auth (otp-auth), user-admin (admin-user-crud), design-system (admin-only-notus) | rbac |
| admin-routing | — | auth (otp-auth) | admin-routing |
| admin-user-crud | admin-routing | auth (otp-auth), design-system (admin-only-notus) | user-admin |
| auditor | — | — | auditor |
| cms | — | auth (otp-auth), design-system (admin-only-notus) | cms |
| connectivity-banner | — | — | connectivity-banner |
| draft-persistence | — | — | form-drafts |
| extension-crawler | — | — | extension-crawler |
| geoip-mmdb | admin-routing | auth (otp-auth), design-system (admin-only-notus) | geoip |
| code-qa | — | — | — |
| chat-support | admin-chat, admin-prompt-queue | auth (otp-auth), tenancy (multi-tenant), design-system (admin-only-notus) | — |
| landing-marketing-site | — | auth (otp-auth), design-system (admin-only-notus) | public-page |
| multi-tenant | — | auth (otp-auth), design-system (admin-only-notus) | tenancy |
| admin-only-notus | admin-routing | — | design-system |
| otp-auth | — | — | auth |
| mfa-totp | otp-auth, multi-tenant | design-system (admin-only-notus) | mfa |
| public-contact-chat | admin-chat, admin-prompt-queue | auth (otp-auth), public-page (landing-marketing-site), fingerprint (visitor-fingerprint), design-system (admin-only-notus) | — |
| skill-creator | — | — | — |
| stack | — | — | stack |
| visitor-fingerprint | — | — | fingerprint |
| web-scraping | — | — | — |
| service-ports | — | — | service-ports |
