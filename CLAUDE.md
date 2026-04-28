# orca — agent instructions

When finishing changes, you MUST verify there is no 500 ISE.

## Database schema changes

The schema lives in `packages/db/src/schema/*.ts` (Drizzle). The server runs
an auto-sync migrator (`apps/server/src/db/migrate.ts`) on every boot, which
walks every exported table and `ALTER TABLE ADD COLUMN IF NOT EXISTS` for any
column missing from the live database. **New columns do not require a
hand-edit of `migrate.ts`** — just add them to the drizzle table and restart
the server.

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

A running server has an old `OrcaDb` client cached in memory and will 500 on every
   query that touches the new column until it reboots. `vite-node --watch` picks up
   most edits automatically, but workspace package changes can be missed —
   when in doubt, kill and relaunch the server process explicitly. Do not
   hand the task off with a stale server running.

## Agile vocabulary

Story statuses are the canonical set in `packages/shared/src/`. Never
reintroduce `refinement`, `unreviewed`, or `implementing` — those were
retired and have migrations in `migrate.ts` that reset them.

When updating an implementation-audit row, `lastReviewedAt` must stay in sync with the semantic meaning of the status: setting status to `unaudited` must clear (null) `lastReviewedAt`, never stamp it with a new date. Only statuses that represent a completed review (e.g. `compliant`, `non-compliant`, `partial`) should receive a fresh timestamp.

## Updating stories

You can update stories via API with the following...

{orca.stories_api}