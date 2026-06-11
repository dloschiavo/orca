
NEVER tell the user to restart the server, reload the extension, or restart any process/service.  If you do, it means not only did you NOT finish the task, you ALSO didn't test it because you couldn't have tested it if you didn't restart the server.
If anything is stale or down — servers, watch processes, extensions — diagnose it, kill what needs killing,
and bring it back up yourself.  At the end of every modification that requires a restart/reload, output "✅" and then what you restarted/reloaded (extension, server at address:port, etc).

### Architecture

- **[No Duplication & Single Source Truth]** The same concern is not recreated in multiple places. Diverging implementations of the same concern are bugs waiting to happen. Favor OO / shared modules.  No duplicate implementations across files. If a function/constant is defined in one module, it is not redefined in another. When discovering a duplicate, consolidate immediately. Adopt the more robust implementation (better error handling, more fallback paths, broader input coverage) and delete the inferior copies. Merge the best of both when they have diverged — never pick arbitrarily.
- **[Port Don't Rewrite]** When migrating a prior version with a working implementation of the same concern, port the original code first, then refactor. Never rewrite from scratch. Compare the port against the original to verify behavioral equivalence.
- **[Preserve Logging]** When porting code, keep all `console.log`/`console.warn`/`console.debug` calls — including commented-out ones. They are active-development breadcrumbs.
- **[Thin Orchestrators]** Orchestrator scripts (service workers, background scripts, main entry points) delegate all business logic to importable modules. Every line in an orchestrator requires a full process restart to test; modules only need a re-import.
- **[Completion Barrier]** Async status aggregation uses a pending counter decremented in each callback — the aggregate is computed only when all callbacks have fired. Never set the aggregate synchronously from the first response.
- **[Polling Semaphore]** `setInterval`-driven loops that call async work check a running flag before starting a new iteration. Without this, slow iterations cause concurrent execution.

### Servers & Testing

- **[Backend Server Test]** If the backend is not running, run it. Reporting "skipped because backend is unavailable" is a fail.
- **[Frontend Server Test]** If the frontend is not running, run it. Reporting "skipped because frontend is unavailable" is a fail.
- **[Extension Test]** If the code is for a Chrome extension, test it. Claude Chrome + MCP is installed — use it. Content scripts do not require a full extension reload.
- **[Recursive Testing]** Test recursively against the PRD's requirements, not just the happy path of the latest change.
- **[Auth Bypass]** You do not need to worry about auth in local development — there is already a bypass for localhost requests in dev mode.
- **[Mock Data Clarity]** Mock data is obviously mock — alpha strings contain the word "mock", phone numbers start with 555.

### Scraping / Extraction

- **[Selector Fallbacks]** DOM extractors use a specific-to-broad fallback chain: (1) dedicated element attribute, (2) structured URL patterns in `href`, (3) any attribute value matching the identifier pattern, (4) full `innerHTML` scan as last resort. Attribute-filtered selectors are paired with a broader container selector and post-filtered by extraction result. Selector match counts are logged on every run.
- **[Unrecognized Storage]** Unrecognized patterns (delivery status text, unknown state labels) are stored on the database object in `_unrecognized_*` fields — never silently discarded.
- **[Phrasing Coverage]** Enumerated state parsing covers *all* known surface phrasings, including indirect/contextual variants ("You reviewed this item" = "approved"), before falling through to generic substring checks.
- **[Unconditional Write]** A write triggered by observing a domain event persists the primary state change unconditionally. Supplementary fields are additive and never cause the whole write to be skipped.
- **[State Field Overwrite]** Observable current-state fields (approval status, quality tier) are always included in the upsert payload when observed — never conditionally omitted. `$setOnInsert` / `_setIfMissing` is reserved for immutable provenance fields.
- **[Label Length Cap]** Categorical labels extracted from scraped text are capped at ≤ 20 chars. Longer strings indicate the wrong DOM node — discard.
- **[Scrape Timestamps]** Relative date references ("today", "yesterday", day names) resolve relative to the scrape timestamp, not `Date.now()`. When re-processing, use the stored scrape timestamp.

### Backend & Data Integrity

- **[Config Source Match]** Backend config source matches the deployment pattern. If `.env` is expected, there is a dotenv loader. Spec, code, and UI warning text all reference the same config source.
- **[Endpoint Existence]** Every frontend `fetch()` has a corresponding backend endpoint. Check the network tab for 4xx/5xx as part of every audit.
- **[API Client Methods]** The centralized API client supports every HTTP method the app uses (GET, POST, PUT, PATCH, DELETE). Direct `fetch()` calls in the codebase usually indicate a missing helper — add the helper, don't wrap one call.
- **[No Route Errors]** No routes/pages return 404 or 405, no data fetch failures, data actually displays.
- **[Error Shape]** All backend endpoints return errors in a consistent shape (e.g. `{ error: string, code?: string }`). Every non-2xx uses the same shape. 2xx responses never include an `error`-like field.
- **[Query Indexes]** Every production query pattern has a supporting MongoDB index. `$exists`, compound filters, and sorts on unindexed fields are verified with `explain()`.
- **[ISO Timestamps]** MongoDB timestamps use ISO 8601 with timezone offset. No mixing of bare epoch integers and ISO strings in the same collection. Frontend converts to local at render, not at storage.
- **[Canonical Casing]** Field names in upsert payloads use the canonical casing from the data model spec. Check the spec and existing query projections before writing `payload.fieldName = ...`.
- **[Field Type Match]** Data model field type specs match actual BSON storage. Sample a doc (`db.collection.findOne({field: {$exists: true}})`) and verify the type matches the spec.
- **[Debug No Filter]** Debug/inspection views (`JSON.stringify(item)` dumps in InspectDrawers, debug panels) show *all* fields regardless of the view's intended scope.
- **[No Large Exclusions]** No `$nin` with hundreds/thousands of values. Prefer time-based cursors (`$gt since`) with client-side dedup. Exclusion sets are <50.
- **[No Mongoose]** Mongoose is not used. Native MongoDB driver only.
