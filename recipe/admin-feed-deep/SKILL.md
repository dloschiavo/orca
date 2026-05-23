---
name: admin-feed-deep
description: >
  Use AFTER `admin-feed-basic` is installed and the operator wants the
  attention queue to cover more than chat/exceptions/security. This recipe
  contributes additional producer integrations on top of the same
  `feed_items` collection, the same `emitFeedItem()` helper, and the same
  `/platform/feed` page — no new model, no new page, no new mutation API.
  Producers added here: signature workflow (stuck signers, viewed-not-signed,
  compliance-flagged), drive sync failures, ingestion/embedding failures,
  org/user lifecycle (new signups, churn-risk, plan limits), billing, and
  knowledge-base staleness. Each producer is one new `type` prefix, one
  emit call site, and (when applicable) one resolve call site. The recipe
  also defines the rules for whether a new producer goes in `/platform/feed`
  (cross-org) or a parallel `/admin/feed` (single-org owner-facing).
dependencies:
  requires: [admin-feed-basic]
  capabilities:
    auth: otp-auth
    design-system: admin-only-notus
provides: [admin-feed-deep]
---

# Admin Feed (Deep)

The basic recipe handles the three signals every operator-attention queue starts with: chat to review, exceptions to triage, security events to acknowledge. The **deep** recipe is the long tail — every other "thing the operator should look at" that the host project produces.

The architectural rule is unchanged: **one `feed_items` collection, one `emitFeedItem()` helper, one `/platform/feed` page.** This recipe contributes producer integrations only; no new model, no new mutation API, no new page (with one carefully-scoped exception for an org-level mirror, see § Org-level feed below).

A new producer is three things:

1. A new `type` prefix in the vocabulary (e.g. `signature.*`, `drive.*`, `ingest.*`, `lifecycle.*`, `billing.*`).
2. One or more `emitFeedItem` call sites in the producer's existing handlers.
3. (Where applicable) one `resolveFeedItemsBySource` call site when the source resolves.

If the new producer needs anything beyond that, it doesn't belong here; it belongs in its own recipe.

---

## Producers

Each section below names a producer prefix, the events it emits, the source(s) of truth, and the resolution rule. The shape is identical for every entry; reading the basic recipe's three producer sections first makes this read like a checklist.

### `signature.*` — signature workflow

| Event | Trigger | Priority | Dedupe key | Resolves when |
|---|---|---|---|---|
| `signature.stuck` | Signature request open > 7d with no signer activity | `normal` | `signature.stuck:{request_id}` | Signer signs OR operator cancels OR dismissed |
| `signature.viewed_unsigned` | Signer viewed but didn't sign within 48h of view | `normal` | `signature.viewed_unsigned:{request_id}` | Signer signs OR dismissed |
| `signature.bounced` | Signature request email bounced | `high` | `signature.bounced:{request_id}` | Email re-sent successfully OR dismissed |
| `signature.compliance_risk` | `compliance_analysis.severity === 'high'` lands on a request | `high` | `signature.compliance_risk:{request_id}` | Operator reviews + resolves OR dismissed |

Source: a periodic worker scans `signature_requests` once an hour and calls `emitFeedItem` for stuck/viewed-unsigned items. Bounce events fire from the email-delivery webhook handler. Compliance-risk fires from the compliance worker's completion handler.

`organization_id` is always set — signature events are never platform-wide.

### `drive.*` — drive sync

| Event | Trigger | Priority | Dedupe key | Resolves when |
|---|---|---|---|---|
| `drive.sync_failed` | `DriveWatchedFolder` worker error | `high` | `drive.sync_failed:{folder_id}` | Next successful sync against the folder OR dismissed |
| `drive.oauth_expired` | Drive API call returns refresh-token error | `critical` | `drive.oauth_expired:{user_id}` | User re-authorizes OR dismissed |
| `drive.ingest_failed` | Document ingestion (parse / OCR / embed) errored | `normal` | `drive.ingest_failed:{document_id}` | Document re-ingested successfully OR dismissed |

`drive.oauth_expired` is `critical` because the entire org's drive integration is dead until re-auth; everything else is `high` or `normal`.

### `ingest.*` — knowledge-base ingestion

| Event | Trigger | Priority | Dedupe key | Resolves when |
|---|---|---|---|---|
| `ingest.embedding_failed` | Embedding generation errored on a document | `normal` | `ingest.embedding_failed:{document_id}` | Successful embed retry OR dismissed |
| `ingest.classification_pending` | New `DriveDocument` ingested without a classification > 24h | `low` | `ingest.classification_pending:{document_id}` | Doc gets classified OR dismissed |
| `ingest.kb_stale` | KB-source document hasn't been re-indexed in 90d | `low` | `ingest.kb_stale:{document_id}` | Doc re-indexed OR dismissed |

`ingest.kb_stale` is what bridges "we have a knowledge base" to "the operator notices when the KB rots." It's `low` priority because each individual stale doc isn't urgent, but a flood of them is the signal — the count and category filter will surface that.

### `lifecycle.*` — org/user lifecycle

| Event | Trigger | Priority | Dedupe key | Resolves when |
|---|---|---|---|---|
| `lifecycle.new_org` | Org created | `normal` | (none — every signup is its own row) | Operator dismisses (manual onboarding step) |
| `lifecycle.invited_no_login` | User invited > 7d, never logged in | `low` | `lifecycle.invited_no_login:{user_id}` | User logs in OR invitation revoked OR dismissed |
| `lifecycle.org_at_plan_limit` | Org passes 80% of any plan limit | `normal` | `lifecycle.org_at_plan_limit:{org_id}:{limit_kind}` | Limit raised OR org downgrades OR usage drops below 50% (debounce) OR dismissed |
| `lifecycle.trial_expiring` | Trial expires < 7d from now | `high` | `lifecycle.trial_expiring:{org_id}` | Trial converts OR org dismisses OR trial actually expires (auto-resolve) |
| `lifecycle.churn_risk` | Org's last active session > 30d ago | `low` | `lifecycle.churn_risk:{org_id}` | Org has any active session OR dismissed |

`lifecycle.new_org` is the one event in the deep recipe that opts *out* of dedup. **Why:** every new org is a manual onboarding touchpoint (intro email, demo offer, Slack handoff) and the operator needs one row per org, not a coalesced "8 new orgs" entry that hides which 8.

### `billing.*` — billing events

| Event | Trigger | Priority | Dedupe key | Resolves when |
|---|---|---|---|---|
| `billing.payment_failed` | Stripe webhook `invoice.payment_failed` | `critical` | `billing.payment_failed:{org_id}` | Successful payment OR plan downgrade OR dismissed |
| `billing.subscription_canceled` | Stripe `customer.subscription.deleted` | `high` | (none) | Operator dismisses (manual outreach) |
| `billing.refund_requested` | Operator-tagged refund flow OR Stripe dispute | `high` | (none) | Refund processed OR dispute closed OR dismissed |

Subscription cancellation, like new-org signup, opts out of dedup — every churn is its own touchpoint.

---

## Org-level Feed (Optional)

The basic recipe puts the page at `/platform/feed`, gated to platform staff. Some deep producers (signature, drive sync, billing for one's own org) are equally valuable to **org owners** acting on their own org. If the host project wants this, install the org-level mirror:

- New page at `/admin/feed` (org-level tree per `admin-routing` § Two trees).
- Same `feed_items` collection, same row component, same filter bar.
- The list endpoint scopes to `organization_id IN session.owned_org_ids` server-side, never trusts the client to scope it.
- Platform-wide items (`organization_id: null`) are **never** visible to org owners. The auth gate accepts owners; the data filter excludes nulls.

The org-level page is opt-in per host project. Most projects won't need it — the deep producers' org-relevant items can be surfaced via a sidebar count badge on existing org pages instead, without a full feed UI.

**Anti-pattern:** the org-level feed querying `feed_items` without `organization_id IN session.owned_org_ids` filter — leaks platform-wide security events to org owners. This is the same trap as `/admin/**` vs `/platform/**` URL drift; the data filter must mirror the route's intended scope.

---

## Producer Wiring Conventions

Every deep producer follows the same shape as the basic recipe's three. To keep them consistent across the long tail:

1. **Emit at the producer's existing write/error site.** Don't create a wrapper handler that exists only to emit; tuck the call into the handler that already lives there. If the handler is too tight to read, refactor the *handler*, not the feed integration.

2. **Resolve at the producer's existing resolution site.** Bounced email re-sent → emit-resolve in the resend handler. Document re-ingested → emit-resolve in the ingest worker's success path. The dedup machinery means re-emitting an already-open item is harmless, but explicit resolves are what flip the row green for the operator.

3. **Use the synthetic source pair when the source is a bucket, not a row.** Same pattern as `chat.unviewed` in the basic recipe: `source_collection` names the *concept* (e.g. `'oauth_expired'`), `source_id` names the bucket key (e.g. `'user:{id}'`). This keeps the resolver call symmetric.

4. **Stay platform-wide unless the producer is fundamentally org-scoped.** Set `organization_id: null` for cross-org signals (system, security). Set `organization_id` only when the operator's mental model is "this needs attention because of *that org*."

5. **Default priority is `normal`.** Reach for `high` when the producer's failure mode blocks user value, `critical` when it blocks money or auth. `low` is the long-tail "good to know but not now" — surface it via filters, not by default sort.

---

## Type Vocabulary (Combined)

After installing the deep recipe, the full prefix set is:

| Prefix | Category | Producer recipe |
|---|---|---|
| `chat.*` | knowledge | basic |
| `system.*` | system | basic |
| `security.*` | security | basic |
| `signature.*` | knowledge (workflow) | deep |
| `drive.*` | system | deep |
| `ingest.*` | knowledge | deep |
| `lifecycle.*` | system | deep |
| `billing.*` | system | deep |

Note `signature.*` and `ingest.*` map to the `knowledge` category alongside `chat.*` — they are the workflow that produces the knowledge artifacts. `drive.*` and `lifecycle.*` map to `system` because failures there are infrastructural. `billing.*` maps to `system` because the consequence (loss of access) is operational. The rationale: the page's three category tabs read as "what to fix to keep the operator's value engine running" — not a strict taxonomy, but a sort that matches operator workflow.

If a host project wants a fourth top-level category (e.g. `business` for billing + lifecycle), update the basic recipe's `FeedCategory` enum and re-deploy. Don't fork the type vocabulary across categories — the prefix → category mapping is a function, not a per-call decision.

---

## Fit-to-Project

- **Worker for periodic scans**: `signature.stuck`, `signature.viewed_unsigned`, `lifecycle.invited_no_login`, `lifecycle.churn_risk`, and `ingest.kb_stale` need a periodic scanner — they don't have a natural emit event. Reuse `admin-prompt-queue`'s worker if installed; otherwise an hourly cron. Single tick is enough for all five since they all read from different collections.
- **Stripe webhooks**: `billing.*` requires a Stripe webhook receiver. If the host doesn't have one, install the Stripe integration before this recipe — `billing.*` events are emitted from inside the webhook handler, not from a polling worker.
- **Compliance analysis tagging**: `signature.compliance_risk` requires `compliance_analysis` rows to carry a `severity` field. Recipe expects `'high'` to be the trigger threshold; tune in the producer if the project's analyzer uses a different scale.
- **Plan limit detection**: `lifecycle.org_at_plan_limit` requires a numeric usage tracker per (org, limit_kind). If the host doesn't have one, this event is a no-op — install it later when usage tracking exists. Don't fake it with point-in-time queries inside the emit handler.
- **Org-level feed**: opt-in. Default is platform-only. Hosts that want it install the `/admin/feed` mirror per § Org-level Feed.

---

## Anti-Patterns

- **One recipe per producer family** — bloats the recipe library, fragments the type vocabulary, and tempts each producer to ship its own page. Producers go in *this* recipe; new categories or new mutation APIs go in a recipe split.
- **Emitting `lifecycle.new_org` with a dedup key** — coalesces all signups into one row, which is exactly the wrong UX. Operator needs N rows for N orgs because each is a separate manual touchpoint.
- **Emitting `billing.payment_failed` per failed retry** — Stripe retries 4× over 4 weeks. Without the per-org dedup key, the operator sees 4 rows for one org's churn instead of one. Dedup key is `org_id`, not the Stripe event id.
- **Emitting `drive.oauth_expired` per failed API call** — a dead refresh token can fire on every drive operation, hundreds per minute. Dedup key MUST be `user_id` so it's exactly one open row until re-auth.
- **Auto-resolving `signature.stuck` when the request status changes to anything** — the producer wants to resolve on `signed`, `cancelled`, or operator-dismiss only. Auto-resolving on `viewed` (the very thing that triggers `signature.viewed_unsigned`) hides the next signal. Be explicit about which status flips count as resolution.
- **Letting `lifecycle.org_at_plan_limit` re-fire on every percentage tick** — without a debounce on resolution (recipe specifies "drops below 50%"), an org oscillating around 80% spams the feed. The 50% lower bound is the hysteresis; don't skip it.
- **Org-level `/admin/feed` querying without `organization_id IN owned_orgs` filter** — leaks platform-wide events. Same trap as `/admin/**` URL drift; data scope must mirror route scope.
- **Stuffing the deep producers into a separate `feed_items_extended` collection** — defeats the architectural rule. One collection, one query, one page. The extension point is the type vocabulary, not the storage.
- **A new top-level category invented per producer (`workflow`, `data`, `revenue`, …)** — three categories is the page's tab strip; more than three is a different page. Categories are a sort, not a taxonomy.
- **Per-producer custom emit helpers (`emitSignatureStuck`, `emitDriveOauthExpired`, …)** — wrap-once-then-call-many seems clean but rots fast: each wrapper drifts on default priority, dedup key shape, or category. Call `emitFeedItem` directly with literal args. The verbosity at the call site is the documentation.
- **A "deep" producer that adds a new mutation verb (e.g. "merge two items")** — the mutation API is `state` transitions only. Anything beyond that is a different problem and belongs in a separate recipe, not on top of `feed_items`.
- **Periodic-scan workers running their full sweep inside a request handler** — same pattern as the basic recipe's snooze cron: workers are workers, not request side-effects. Even if the scan is cheap, coupling it to a user request makes the worker's behavior depend on which user happened to load the page.

---

## Logging

Same lines as the basic recipe — `emitFeedItem` and state transitions log themselves. The deep recipe adds:

- Per periodic-scan worker tick: `{ msg: 'feed.scan', producer: 'signature' | 'lifecycle' | 'ingest', emitted: number, scanned: number }` at info. Without this, "is the stuck-signature scan even running" is unanswerable when the feed looks too quiet.
- Stripe webhook receipt: `{ msg: 'feed.billing.webhook', event_type, org_id, emitted: boolean }` at info. Without this, "did Stripe deliver the failed-payment event" is unanswerable on customer escalations.
