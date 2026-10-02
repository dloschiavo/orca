# Batch API cost investigation — findings

**Date:** 2026-07-12
**Question:** Can the Anthropic Message Batches API (`POST /v1/messages/batches`,
50% off per-token pricing) reduce orca's token/cost spend?

**Verdict: Not applicable to orca as architected.** Two independent, each-fatal
reasons — the execution model and the billing model. No implementation is
recommended. The levers that *do* reduce orca's spend are already in place; a
couple can be pushed further (below).

---

## 1. How orca actually spends tokens

orca does **zero** direct Messages API calls. There is no `@anthropic-ai/sdk`,
no `messages.create`, no `messages.batches` anywhere in the tree. The only
`anthropic.*` reference is OAuth token *refresh*
([claude-oauth.ts:23](../apps/server/src/services/claude-oauth.ts)).

Every LLM dollar/token is a **`claude` Code CLI subprocess** — `spawn("claude",
["-p", prompt, ...])` — running a full agentic, multi-turn, tool-using,
filesystem-mutating dev session. Call-site catalog:

| Call site | Purpose | Path | Batchable? |
|---|---|---|---|
| `runClaudeDispatch` | Story implementation (full-stack-engineer / drafter / QA gate) | [routes/stories.ts:1396, spawn @2254](../apps/server/src/routes/stories.ts) | No — agentic tool loop |
| `runCliDispatch` | Generic dispatcher for PRDs + audits | [services/cli-dispatch.ts:180](../apps/server/src/services/cli-dispatch.ts) | No — agentic tool loop |
| `runAuditRowAgent` | Verify one recipe is implemented in a repo (Read/Grep/Glob) | [agents/audit-row.ts:114](../apps/server/src/agents/audit-row.ts) | No — needs codebase inspection |
| audit dispatch | Scheduled (manual/daily/weekly) audit runs → `runCliDispatch` | [services/audit-dispatch.ts:191](../apps/server/src/services/audit-dispatch.ts) | No — agentic tool loop |
| refinement questions | Generate refinement questions → `runClaudeDispatch` | [routes/refinement-questions.ts:144](../apps/server/src/routes/refinement-questions.ts) | No — agentic tool loop |
| spec requirements | Enumerate spec requirements | [services/spec-requirements.ts](../apps/server/src/services/spec-requirements.ts) | **Already not an LLM call** — replaced with a regex parser + `git grep` short-circuit |

Notably, the one job that once *was* a pure text-transform (enumerating
requirements from spec markdown) was already de-LLM'd into a deterministic
parser to save tokens. That's the orca-native cost pattern: **eliminate the
call, don't discount it.**

## 2. Why Batch API can't wrap this — reason A: execution model

The Batch API is a batch wrapper over the **Messages API**. You submit a list of
self-contained requests; each yields exactly **one** response, keyed by
`custom_id`. It cannot run an agentic loop — where the model calls
Read/Grep/Edit/Bash, the *client* executes the tool, and feeds results back over
many turns. That loop is inherently synchronous round-trips.

Every orca call site *is* exactly that loop (a Claude Code session reading and
mutating a repo). "Implement this story" / "audit this recipe against the
codebase" cannot be expressed as a single one-shot Messages request. The Claude
Code CLI has no batch mode. So none of the current call sites can be routed
through Batch as-is — regardless of latency tolerance.

> Latency tolerance is *necessary but not sufficient*. Many orca jobs (audits,
> PRD scans, refinement) genuinely tolerate up-to-1h latency — but the blocker
> isn't latency, it's that they're agentic tool loops, not one-shot text calls.

## 3. Why Batch API can't help — reason B: billing model

Even if reason A were solved, the 50% discount is a **metered pay-per-token
API-key** feature. orca authenticates its agents with **Claude subscription
OAuth** (Claude Code CLI credentials, `claudeAiOauth`, refreshed against
`console.anthropic.com/v1/oauth/token` —
[claude-oauth.ts](../apps/server/src/services/claude-oauth.ts)). The spend is
governed by a **weekly token allotment**, tracked as a `usage_fraction` from the
`seven_day` rate-limit bucket
([concurrency.ts:134-173](../apps/server/src/services/concurrency.ts)), plus
rate limits and concurrency caps.

There is no per-token invoice to halve. Batch requires an API key on
pay-as-you-go billing — a *different, separately-metered* cost basis. Moving
background work onto an API key to "save 50%" would replace subscription-included
usage with net-new metered dollars — likely *more* expensive at orca's volume,
not less.

## 4. Prompt caching — already in use, already exploited

orca doesn't (and can't) set `cache_control` itself — it doesn't build Messages
requests; the CLI manages caching internally and applies it automatically to the
system prompt, tools, and conversation prefix. orca **reads** the cache metrics
from CLI usage (`cache_read_input_tokens` / `cache_creation_input_tokens` in
[cli-dispatch.ts:481-491](../apps/server/src/services/cli-dispatch.ts) and the
story path) and already leans on the complementary levers:

- **Session resume** (`--resume` via `existingSessionId`) — keeps the cached
  prefix warm across dispatches; system prompt only sent on fresh sessions.
- **`--max-turns` caps** to shrink accumulated tool-result context, explicitly
  documented as *"the dominant per-dispatch cost"*
  ([model.ts:118-135](../apps/server/src/agents/model.ts)).

So caching is not an untapped lever — it's the primary one, and it's already
pulled.

## 5. What actually reduces orca's spend (recommended)

Under subscription-OAuth + CLI, the real dial is **weekly-allotment
consumption**, not dollars-per-token. All of these already exist; the first two
can be pushed harder:

1. **Deterministic pre-flight / LLM-skip** — the `spec-requirements` pattern
   (regex + `git grep` proves a requirement is already satisfied → skip the QA
   model call entirely). Highest ROII pattern in the codebase; extend it to more
   gates where a cheap check can short-circuit a dispatch.
2. **Model tiering per agent** — `resolveModelTierForAgent` (fast/strong) and
   per-agent `agent.model` already route auditor/refinement/classifier work to
   cheaper models and reserve Opus for implementation
   ([model.ts:66-116](../apps/server/src/agents/model.ts)). Audit dozen-of-rows
   jobs are the best candidates to pin to Haiku/Sonnet.
3. **Latency tolerance → curve-flattening, not cost reduction.** Deferring
   batch-tolerant work (audits, PRD scans) helps orca *dodge the 5-hour /
   rate-limit walls* — it does **not** reduce total weekly-allotment
   consumption (quota is token-metered, not time-metered — see §6). Push this
   work *earlier in the weekly cycle* rather than to off-peak clock hours, and
   keep bursts tight (don't drip-feed) so caching stays warm. **Caveat:**
   spreading a session out with idle gaps longer than the ~5-min cache TTL can
   *increase* consumption by re-billing cache-creation (see §6).
4. **Input trimming + codebase-map** — the established "cut tokens via input
   trimming, not turn caps" strategy shrinks the per-dispatch prompt that gets
   billed as cache-creation on turn one.

## 6. Quota metering: time-of-day is orthogonal to cost

**The same prompt costs the same quota whenever you run it.** Weekly-allotment
consumption is metered on **tokens processed** (input + output + cache-creation +
cache-read), not wall-clock time or server load. The `usage_fraction` orca tracks
comes straight off the `seven_day` token bucket
([concurrency.ts:158-173](../apps/server/src/services/concurrency.ts)) — there is
no time-of-day multiplier anywhere in the accounting. Identical token counts →
identical fraction of the weekly allotment, 3am or 3pm.

What peak hours change is **throttling, not cost**:

- **Rate limits (429s) and the 5-hour cap** — at peak you get *told to wait*
  sooner because aggregate demand is higher, but being rate-limited consumes **no
  quota**; it only gates *when* you're allowed to spend it.
- **Latency** — turns are slower under load. Slower ≠ more expensive.

So peak vs. off-peak affects *when and how fast* you can burn the allotment,
never *how much* a given prompt burns. (Empirically orca rarely hits the 5-hour
cap — mostly at end-of-cycle when a lot is forced through at once.)

### The one thing that *does* move per-prompt quota: cache warmth (~5-min TTL)

Prompt caching is governed by a ~5-minute cache TTL, **not** clock time. This
cuts *against* naive "spread it out to off-peak":

- **Bursting dispatches back-to-back** keeps the cached prefix (system prompt +
  tool defs + conversation prefix) warm → later turns bill as cheap
  cache-**reads** (~0.1× input rate).
- **Drip-feeding the same work** with idle gaps > the cache TTL lets the prefix
  expire → each turn re-pays full cache-**creation**. The identical work can cost
  *more* total quota when spread out than when bursted.

**Practical consequence:** to survive the end-of-cycle crunch, flatten the
*weekly* curve (start the heavy push earlier in the cycle so you're not slamming
the 5-hour cap), but keep each burst *tight* so caching stays warm. Moving work
to off-peak clock hours for "cost" reasons is a misconception — it buys you
rate-limit headroom, not quota.

## 7. When to revisit Batch

Only if **both** change: (a) a genuinely tool-free, one-shot text job appears
(bulk classification/summarization/extraction with no repo inspection), **and**
(b) that specific job is moved to a metered API key. For agentic development
work, neither holds. If orca ever grows a large offline text-analysis surface
(e.g. summarizing thousands of activity logs with no tools), *that* slice — and
only that slice — would be a Batch candidate; the dev-agent core never is.
