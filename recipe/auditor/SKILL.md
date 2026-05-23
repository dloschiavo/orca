---
name: auditor
description: >
  Use when auditing the `_recipes` library itself for drift after a refactor
  — paths in `_index.md` that don't exist on disk, untracked SKILL.md
  directories, frontmatter `dependencies:` blocks that disagree with the
  dependency graph table, `requires:` entries pointing at recipes that no
  longer exist, `capabilities:` keys not in the registry, prose
  cross-references like "see X" pointing at renamed/missing skills, and
  anti-patterns that have drifted between two skills after an extract.
  Output is a categorised report and a fix-list — the auditor finds and
  fixes; it does not author new content.
provides: [auditor]
---

# Recipes Library Auditor

The `_recipes` library is its own little dependency graph — `_index.md` is the table of contents, each `<slug>/SKILL.md` is a node, and the `dependencies:` frontmatter + the dependency graph table at the bottom of `_index.md` are two views of the same edges. Every refactor (extract a skill, rename a directory, add a capability) creates the chance that those views stop agreeing. This recipe is the linter that catches the drift before another install picks up a broken row.

This skill is **only** for auditing the `_recipes` repo itself. It is not for auditing the install state of a target project; that is a different problem.

Reference implementation: this very repo. Every check below has a worked example mined from a real drift event.

---

## When To Run

Run the auditor:

- After any commit that adds, renames, removes, or splits a recipe
- Before pushing a batch of skill updates to teammates
- After a `git mv` of a recipe directory
- After editing `_index.md` by hand (the index is the easiest thing to drift)
- Whenever you notice a `?? <skill>/` in `git status` that's been sitting around

It's a fast pass — read every SKILL.md frontmatter, parse `_index.md`, do the cross-checks below, report. No LLM calls, no network.

---

## What To Audit

Each category below is a check the auditor performs. The order matters — earlier checks gate later ones (no point comparing dependency graphs if a SKILL.md is missing from disk).

### 1. Index ↔ filesystem agreement

**Recipes are always flat under `_recipes/`** — every recipe lives at `_recipes/<slug>/SKILL.md`, never under a parent grouping directory like `admin/` or `chat/`. The `Path` column in the `## Skills` table must always be exactly `<slug>/SKILL.md`. If you ever see a path with an extra directory segment (e.g. `admin/cms/SKILL.md`), the row is wrong — the recipe goes back at the top level.

**Critical:** the prose inside any SKILL.md may legitimately reference `admin/<thing>` paths — those are **target-app URL routes and source files** (e.g. `app/(app)/admin/cms/index.tsx` is an Expo Router route in the consuming project, not a directory inside `_recipes/`). The auditor must never interpret a leading `admin/` inside a SKILL.md body as a claim about the recipe's own location. The only place that decides recipe location is the `Path` column of the `## Skills` table, and the only valid shape is `<slug>/SKILL.md`.

For every row in the `## Skills` table of `_index.md`:

- The `Path` column matches the regex `^<slug>/SKILL\.md$` (no leading directory segments).
- That file exists on disk.

For every directory containing a `SKILL.md` (excluding `_unmigrated/`, `agent/`, `.claude/`):

- It is a top-level child of `_recipes/`. Nested SKILL.md files (e.g. under an `admin/` subdir) are a structural violation — flatten them and update the row.
- There is exactly one row in the `## Skills` table whose `Path` column points at it.
- A directory with a `SKILL.md` that has no row is a "ghost recipe" — usually the result of forgetting to update the index after `mkdir <new-skill>/`.

### 2. Git tracking of new skill directories

For every `<slug>/SKILL.md` referenced from `_index.md`, run the equivalent of `git ls-files --error-unmatch <slug>/SKILL.md`:

- If the file is untracked, flag it. A row in `_index.md` plus an untracked SKILL.md is a half-committed split — teammates who pull will get the index update but not the file, and `install.sh` will explode trying to read the missing recipe.

**Worked example:** `admin-chat/SKILL.md` exists, is referenced from `_index.md:116`, and `git status` shows `?? admin-chat/`. Auditor reports:

- ⚠️ `admin-chat/SKILL.md` is referenced from `_index.md:116` but is untracked in git. Stage it (`git add admin-chat/SKILL.md`) before pushing.

### 3. Frontmatter `name:` matches directory slug

For every SKILL.md, the YAML `name:` field must equal the directory name. A `name: admin-chat` SKILL.md living under `admin-chat-v2/` means the install command will reach for the wrong directory. Trivial check, frequent footgun after a copy-and-rename.

### 4. Frontmatter `dependencies:` ↔ dependency graph table

The dependency graph table at the bottom of `_index.md` is a *summary* of every SKILL.md's `dependencies:` block. They must agree on every cell.

For each skill row in the graph table:

- `requires (hard)` column matches `dependencies.requires` in the SKILL.md frontmatter (set equality, not list-order).
- `capabilities (default)` column matches `dependencies.capabilities` (each `key (default)` in the table must appear as `key: default` in the frontmatter, and vice versa).
- `provides` column matches the top-level `provides:` list in the frontmatter.

A skill that has no `dependencies:` block at all (e.g. `web-scraping`, `skill-creator`) must show `—` in all three columns of the graph table. A skill with a `provides:` but no `dependencies:` (e.g. `admin-only-notus`, `otp-auth`, `stack`, `visitor-fingerprint`) must show `—` in `requires` and `capabilities` columns but a real value in `provides`.

**Drift sources:** the table is hand-maintained — when you add or rename a capability in a SKILL.md, the table doesn't update itself. After every dependency edit, re-derive the relevant row of the table from the frontmatter and diff.

### 5. Capability registry consistency

The "Capability registry" table in `_index.md` is the closed vocabulary for capability names. Every key used in any SKILL.md's `dependencies.capabilities:` block must appear in this registry, and every value (the default implementation) must be the slug of a recipe that exists and that `provides:` the capability.

Three checks:

- Every `capabilities.<key>` used anywhere → the key is a row in the registry.
- Every default in the registry → the recipe exists and lists that capability in its `provides:`.
- Every `provides: [<cap>]` → the capability is a row in the registry. (A skill claiming to provide an unregistered capability is either a typo or a sign that the registry needs a new row — the auditor reports it; the human decides.)

A new capability should be added to the registry in the *same commit* as the first SKILL.md that uses it. The auditor catches the case where one was missed.

### 6. `requires:` validity

For every entry in any SKILL.md's `dependencies.requires:` list, the named recipe directory must exist and have a SKILL.md. A recipe that requires a deleted/renamed dependency will look fine to `tsc` but will explode at install time.

This is also where the auditor catches **dependency cycles**. Compute the requires-graph and report any cycle as a hard failure (`_index.md` line 65 explicitly says cycles are a bug). Don't try to break the cycle automatically — report it and stop.

### 7. Prose cross-references to other skills

Inside each SKILL.md body, look for backtick-quoted recipe slugs and the phrases "see `<slug>`", "from `<slug>`", "lives in `<slug>`", "owned by the `<slug>` recipe", and `<slug>/SKILL.md` paths. Each referenced slug must:

- Exist as a directory with a SKILL.md, AND
- Be reachable from this skill's transitive dependency closure (`requires` + `capabilities` defaults), OR be `_index.md`'s own self-references, OR be in a clearly-marked "see also" / "related" position.

The strict "must be in the dependency closure" rule is the load-bearing one — if `chat-support` says "owned by the `admin-chat` recipe" but doesn't `require: admin-chat`, that's an undeclared dependency and a future install will fail.

**Worked example:** `chat-support/SKILL.md` body has multiple references to `admin-chat` (`Wires the In-app tab into the shared admin-chat review surface`, `the admin flagged-message review router lives in the admin-chat recipe, not here`). Auditor verifies that `chat-support`'s frontmatter has `requires: [admin-chat, admin-prompt-queue]`. ✅ Consistent. If the `requires` were missing, the auditor would flag every prose mention as an undeclared dependency.

### 8. Stale paths after extract / rename

When a recipe is split (e.g. the admin review page extracted from `chat-support` into `admin-chat`), the original recipe's File Map and prose tend to keep pointing at files the donor recipe no longer owns. Audit for:

- Repository file paths in the donor's File Map (`app/(app)/admin/chat/index.tsx`, `app/api/admin/chat+api.ts`, `routers/admin_chat.py`) that are now owned by the extractee. They should either be removed from the donor's File Map or annotated `(now in <extractee>)`.
- Anti-patterns in the donor that are now redundant with anti-patterns in the extractee. The donor should drop them; the extractee owns them. (See also category 9.)

This check is fuzzy by nature — flag suspect lines and let the human confirm.

### 9. Duplicate anti-patterns across skills

Build an index of every bullet from every `## Anti-Patterns` section across all SKILL.md files. Group by leading bold name (`**Flat-file admin pages**`, `**Single forever-growing collection**`). Report any name that appears in two or more skills.

A duplicate is one of:

- A genuine cross-cutting rule that should live in only one place (usually the more specialised recipe — e.g. `**Flat-file admin pages**` belongs in `admin-chat`, not in `chat-support`, after the extract).
- A copy-paste leftover from a recent split.
- A shared concept that needs to be promoted to a top-level rule in `_index.md` (the "Recipe execution rules" section).

Don't auto-merge. Report and let the human choose which copy survives.

### 10. Reference implementation paths

When a SKILL.md says `Reference implementation: docpost-app/components/` or `filament.is/app/`, those paths point at sibling repos outside `_recipes/`. The auditor cannot verify them on disk, but it *can* normalise: every reference impl path should be a single clearly-formatted line under the intro paragraph, and the slug-name part should be consistent across skills (`docpost-app`, not `docpost`/`docpost-app`/`docpost/docpost-app`). Inconsistent naming is a future-Claude footgun: a reference path that drifts is no reference at all.

### 11. `_index.md` description ↔ SKILL.md description

The one-line description in `_index.md`'s skill table is what Claude scans to decide which skill to load. It's separate from the longer YAML `description:` in the SKILL.md frontmatter, but they should not actively contradict each other. Audit:

- Trigger words in the frontmatter description that don't appear in the index row (the index row is the discoverability surface — losing trigger words from it loses lookups).
- Claims about `provides:` / `requires:` in the index description that disagree with the actual frontmatter.

This is the lowest-confidence check. Surface as "review", not "fix".

---

## Audit Procedure

1. **Parse `_index.md`** into three structured tables: the skill table, the capability registry, and the dependency graph.
2. **Walk the filesystem** under `_recipes/` for every `<slug>/SKILL.md` (skip `_unmigrated/`, `agent/`, dotfiles, hidden dirs).
3. **Parse each SKILL.md's frontmatter** with a real YAML parser (the `description:` field is multi-line; do not regex it).
4. **Run categories 1–11 in order.** Earlier categories gate later ones — if a SKILL.md is missing from disk, the dependency graph check is skipped for that row and the failure is recorded once at category 1 instead of three times across categories 1, 4, and 5.
5. **Group findings by category, then by file.** Output is a flat list of `<severity> <file>:<line> — <message>` lines, plus a summary count per category.
6. **Stop. Do not auto-fix.** Most fixes are unambiguous (`git add`, fix a path) but a few are not (which side of a rename to keep, which copy of a duplicated anti-pattern survives) — and the value of the auditor is in being trustworthy, not aggressive.

Severities:

- ❌ **error** — repo is in an inconsistent state that will break an install. Auditor exits non-zero.
- ⚠️ **warn** — drift that is not yet broken but will become an error if left alone (untracked SKILL.md, undeclared dependency).
- ℹ️ **review** — fuzzy check (description drift, suspect file path) that needs a human to confirm.

---

## Output Format

A single markdown report. Top is the summary; bottom is the per-finding list.

```
# Audit report — _recipes/

Summary
-------
❌ 2 errors
⚠️ 1 warning
ℹ️ 3 reviews

Errors
------
❌ _index.md:120 — cms row points at admin/cms/SKILL.md, file does not exist
   Fix: either `git mv cms admin/cms` and stage, or revert this row to cms/SKILL.md
❌ cms/SKILL.md — exists on disk but no _index.md row references it
   (paired with the row above)

Warnings
--------
⚠️ admin-chat/SKILL.md — referenced from _index.md:116 but untracked in git
   Fix: git add admin-chat/SKILL.md

Reviews
-------
ℹ️ chat-support/SKILL.md:892 — File Map references app/api/admin/chat+api.ts; this file is now owned by admin-chat
ℹ️ chat-support/SKILL.md:756 — Anti-pattern "Flat-file admin pages" duplicates admin-chat/SKILL.md:336
ℹ️ admin-only-notus/SKILL.md frontmatter description mentions "diplomat-app" — _index.md row does not
```

Keep the format flat and grep-able. Don't bury findings inside collapsible sections; this report is read in a terminal.

---

## Fit-to-Project

This skill assumes the layout in `_recipes/` as it currently exists. Before running:

- Is the index file actually `_index.md` at the repo root? (If you forked or renamed, update the parser.)
- Are there any directories under `_recipes/` that contain a SKILL.md but should be skipped? (Today: `_unmigrated/` and `agent/`. If new ones exist, add them to the skip list.)
- Is the dependency graph rendered as a markdown table in `_index.md`, or has someone moved it to a separate file? (Currently inline; if moved, the parser needs both files.)
- Does the team treat untracked SKILL.md files as a hard error or a warning? Default: warning. Promote to error if your release process can't tolerate them.

---

## Anti-Patterns

- **Auto-fixing a rename** — when `_index.md` and the filesystem disagree on a path, the auditor must not pick a side. Either side could be the freshly-typed-and-correct one and the other could be the stale-and-wrong one. Report both, let the human decide.
- **Treating description drift as an error** — the YAML `description:` and the index row description serve different audiences (one is a frontmatter trigger, one is a TOC scan). They will *always* drift slightly. Surface as ℹ️ review, never ❌ error, or the auditor becomes noise and the team starts ignoring it.
- **Walking `_unmigrated/`** — `_unmigrated/` is the holding pen for raw notes that haven't been turned into recipes yet. Including it in the audit guarantees a flood of false positives on every run. Skip it. Same for `agent/`, `.claude/`, dotfiles.
- **Regex-parsing the YAML frontmatter** — the `description:` field is a multi-line folded scalar (`>` block); a regex that grabs `description:\s*(.+)` will get one line and lie about everything else. Use a real YAML parser.
- **Failing silently on a malformed SKILL.md** — a SKILL.md with broken frontmatter should be a ❌ error in its own category (parse failure) and the auditor should *continue* to the next file. Do not let one broken file mask a dozen real findings in others.
- **Reporting the same drift in three categories** — a missing file will look like an error in category 1 (filesystem), category 4 (graph mismatch), and category 5 (capability registry). Suppress the downstream ones; report once at the earliest gating category.
- **Auto-merging duplicate anti-patterns** — the human knows which recipe owns the rule after an extract. The auditor doesn't. Report duplicates with both file:line citations and stop.
- **Running the auditor as part of `install.sh`** — installs operate on a single recipe; the auditor operates on the whole library. Wrong scope and wrong blast radius. Run it from a `pre-push` hook or a make target, not the install path.
- **Letting the auditor write to `_index.md` directly** — drift fixes go through the same review/commit flow as any other recipe edit. If the auditor edits the index, you lose the ability to git-blame the fix and you risk wiping a hand-edited row.
- **Adding a new check without a worked example from this repo** — every category in this skill exists because of a real drift that happened. Speculative checks ("what if someone uses two periods in a row in a description?") are noise. If you can't point at a real recent breakage, leave it out.
- **Conflating `_recipes` audit with target-project audit** — the auditor in this skill audits the recipe library. Auditing an *installed* recipe in a target project for compliance with its SKILL.md is a different problem (and probably a different skill). Don't mix them.

---

## Logging

Not applicable — this skill has no runtime in the traditional sense. The auditor's "log" is its report. If you build a script implementation:

- Print the report to stdout, with severity prefixes that survive piping (`❌`/`⚠️`/`ℹ️` or `ERROR`/`WARN`/`INFO`).
- Exit non-zero if there is at least one ❌ error. Warnings and reviews are exit-zero by default; offer a `--strict` flag that promotes warnings to errors for CI.
- Do not write to a file by default. Reports are ephemeral; the source of truth is the repo.
