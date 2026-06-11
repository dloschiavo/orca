# Memory discipline

How to write, scope, and maintain durable memory across the stores: the global
`~/.claude/CLAUDE.md`, per-project memory (a `MEMORY.md` index + one file per
fact), and these `_directives/`. Binding whenever you create, edit, consolidate,
or route a memory.

## Route by scope — don't misfile

Decide where a fact belongs the moment you record it:

- **Global behavior / how-I-work** → `~/.claude/CLAUDE.md` (loaded every session, every project).
- **Cross-project Goliath convention** (true on every Goliath project) → the "Goliath conventions" section of CLAUDE.md.
- **Binding standard / rubric / checklist** (UI, marketing copy, browser use, this file) → a file in `_directives/`, force-loaded via a CLAUDE.md trigger ("if you do X, you MUST follow `<directive>.md`").
- **Point-in-time build steps** → a recipe `SKILL.md` — a snapshot for scaffolding, NOT updated to track a project's evolving state.
- **Genuinely project-specific fact** → that project's memory dir.

Misfiling is the failure this system exists to prevent: a global preference buried in one project's memory never fires anywhere else; a one-project quirk promoted to global mis-fires everywhere.

## Prefer directives over historicals

The load-bearing rule.

- **Operative facts → state-independent directives.** "Never propose Postgres." "Only eyecite may be Python." "Route all scraping through the apparatus." A directive doesn't depend on a snapshot of current code, so it survives partial/grep retrieval and code drift, and it **fails safe** — it makes you *avoid* something.
- **A historical is a timestamped snapshot** ("as of DATE, X is Python") and **fails unsafe**: retrieved as a fragment, it reads as present tense and you continue from a stale state. Embedded caveats ("this is the target, not reality") do NOT reliably save it — the stale assertion is still sitting there in declarative voice.
- Therefore:
  - Anything that should drive behavior → phrase as a **present-tense directive**.
  - **Current state** → one living, present-tense, dated map per subsystem; keep it reconciled.
  - **History / provenance** → keep ONLY for the *why* (the war-story that makes a rule stick), hard-timestamped, and explicitly marked as not-the-operative-truth. Git is the real changelog; memory is not.

## One fact per file; keep the index in sync

- Per-project memory is one `*.md` per fact plus a `MEMORY.md` index (one line each) that IS loaded every session. Every file has a `name:` slug and a `type` (`project` / `feedback` / `reference`).
- Every create / delete / rename updates `MEMORY.md` in the same pass. Index entries and files stay 1:1 — no index line pointing at a missing file, no file missing from the index.

## Wikilink hygiene

- `[[name]]` resolves to another memory's `name:` **slug** — not its filename. Keep slugs and links consistent (don't link `[[project_foo]]` when the slug is `foo`).
- When you delete or promote a memory, repoint or unlink every inbound `[[...]]` in the same pass — point it at the new home ("see CLAUDE.md") or drop the bracket. Leave no danglers.

## Altitude — rule, not symptom

Record the general rule, not the one-incident symptom. "docpost-app is a git repo" was the symptom; "the repo is the scaffolded subfolder, not the project root" is the rule. Generalize before you write.

## Reconcile; promote-then-remove

- Memories rot. Re-verify a claim against current code before asserting it; date current-state notes.
- When you promote a fact up a tier (project → CLAUDE.md / a directive), DELETE or trim the lower copy so there's exactly one source of truth — duplicates drift apart and you can't tell which is current.
