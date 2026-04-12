# orca — agent instructions

## Database schema changes

The schema lives in `packages/db/src/schema/*.ts` (Drizzle). The server runs
an auto-sync migrator (`apps/server/src/db/migrate.ts`) on every boot, which
walks every exported table and `ALTER TABLE ADD COLUMN IF NOT EXISTS` for any
column missing from the live database. **New columns do not require a
hand-edit of `migrate.ts`** — just add them to the drizzle table and restart
the server.

Two hard rules:

1. **If you change anything under `packages/db/src/schema/`, you must force
   the orca server to restart before considering the task done.** A running
   server has an old `OrcaDb` client cached in memory and will 500 on every
   query that touches the new column until it reboots. `tsx watch` picks up
   most edits automatically, but workspace package changes can be missed —
   when in doubt, kill and relaunch the server process explicitly. Do not
   hand the task off with a stale server running.

2. **The auto-sync migrator only handles additive column changes** (new
   columns, with type + default + NOT-NULL-if-defaulted). It does *not*
   handle:
   - column removals
   - column type changes
   - new foreign keys, unique constraints, or indexes
   - column renames

   If you need any of those, edit `BASE_DDL` inside `migrate.ts` directly
   with an idempotent `ALTER TABLE` or an `IF NOT EXISTS` index, alongside
   the drizzle schema change. Run `tsx src/scripts/migrate-smoke.ts` from
   `apps/server` to verify on a throwaway DB before shipping.

## Scope discipline

orca is a Day-0 scaffold. Many features described in the design docs are not
yet built. When fixing a bug, fix exactly the reported symptom — do not
expand scope to "improve" adjacent code, add new UI affordances, or land
architectural refactors that weren't asked for. If you notice something else
that looks broken, flag it in your reply and let the human decide whether
to open a follow-up.

## Agile vocabulary

Story statuses are the canonical set in `packages/shared/src/`. Never
reintroduce `refinement`, `unreviewed`, or `implementing` — those were
retired and have migrations in `migrate.ts` that reset them.

## Deliverables checklist

Before declaring any story done, restate every numbered or bulleted
requirement from the story spec in your final message and mark each
explicitly:

- ✅ done — with a `file_path:line_number` citation showing where it was
  implemented (or where the existing code already satisfies it)
- ❌ not done — with a one-line reason
- ⚠️ partial — with what is missing

A silent omission is a false claim of completion. Finishing some of the
requirements while reporting "done" is the failure mode tracked as
`agent-false-completion` in the findings system, and it is the worst
class of failure orca measures — it is not corrected by clearer specs,
because it is not a comprehension failure. **The way you avoid being
this finding is to literally enumerate every requirement before saying
done.** This rule is the orca-story analogue of recipe rule 7 in
`/Goliath/_recipes/_index.md`.

This rule is defense-in-depth, not a fix. The real fix is the QA agent
gate built in `apps/server/src/agents/qa.ts`, which independently checks
diff-against-spec after the do-er reports done. Do not rely on QA
catching your omissions — produce the checklist yourself.

## Append-only invariants

Some files contain cumulative denylists, allowlists, suppression rules,
or accumulated guidance. When a story asks to "hide / filter / suppress
/ block / drop / exclude X" from one of these files, treat the new entry
as **additive**: insert a new line alongside the existing rules, leaving
every prior rule untouched. Each existing rule is a record of a past
user complaint and is load-bearing.

You may only rewrite or remove entries when the story explicitly says
"replace", "start over", "clean up", or "remove". When in doubt, ask
before removing.

Known append-only blocks (search the code for `// APPEND-ONLY` to find
the rest):

- `apps/web/src/pages/StoryDetailPage.tsx` — the `rawActivity.filter`
  block that suppresses noisy agent stream lines.

This rule exists because rewriting the block to contain only the new
entry has happened more than once and silently wipes out every prior
suppression rule. Tracked as `agent-failure` in the findings system.
<!-- orca auto-applied (finding cf6dbde8-7edb-4a51-bbf9-dedb038b18bc) -->
When updating an implementation-audit row, `lastReviewedAt` must stay in sync with the semantic meaning of the status: setting status to `unaudited` must clear (null) `lastReviewedAt`, never stamp it with a new date. Only statuses that represent a completed review (e.g. `compliant`, `non-compliant`, `partial`) should receive a fresh timestamp.
<!-- /orca auto-applied -->
<!-- orca auto-applied (finding 837b0922-2401-4944-b6ac-439dc2e4c481) -->
The 72-hour periodic audit trigger must invoke AI-powered implementation verification (runAuditRowAgent) for stale or unaudited rows — not just filesystem metadata resync. resyncImplementationAudit is a prerequisite step (discover new recipes, detect stale hashes), but it is not an audit. After resync, any row that is unaudited or recipeStale must be queued for the AI agent. Every code path that writes to the implementationAudit table — including the manual PATCH route and the audit-row agent's fallback/error branches — must enforce the lastReviewedAt invariant: status 'unaudited' → lastReviewedAt = null; only completed-review statuses (compliant, non-compliant, partial, implemented, etc.) may stamp a fresh timestamp.
<!-- /orca auto-applied -->
