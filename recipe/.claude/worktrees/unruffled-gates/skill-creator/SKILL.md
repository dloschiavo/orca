---
name: skill-creator
description: >
  Use when extracting a QA-validated feature into a portable SKILL.md — either
  creating a new skill or updating an existing one. Covers what to capture,
  what to leave out, how to mine anti-patterns from the QA history, and the
  required file structure.
---

# Skill Creator

A meta-skill for turning a feature you just shipped into a reusable recipe. Run this when:

- A feature has been implemented, gone through real QA rounds, and the user is happy with it
- The same pattern is likely to come up in another project or another part of this one
- You want future-Claude (or a teammate's Claude) to land the same pattern on the first try, not the fifth

The output is a single `<skill-name>/SKILL.md` file in `_recipes/`, plus an entry in `_index.md`. That's it. No code, no scaffolding, no per-project install.

## When To Create vs Update

**Create a new skill** when the topic doesn't overlap meaningfully with anything in `_index.md`. Read `_index.md` first — don't skip this step.

**Update an existing skill** when:
- The new learnings are a refinement of one already-listed skill (e.g. a new anti-pattern, a better default, a missing edge case)
- Splitting them would force readers to load both files together every time
- The existing skill's `description` already covers the territory

When updating, also update the `description` field if the scope has shifted, and revise the `_index.md` row to match.

## Process

**Do NOT run eval loops, benchmarks, subagent test runs, or review viewers.** Read the implementation, write the skill, done. The Anthropic skills-plugin skill-creator has an elaborate test-and-iterate workflow — ignore it entirely when invoked via `rx skill-creator`. This recipe is for documenting a shipped feature, not for optimizing a prompt.

### 1. Pull the source material

Before writing anything, gather:
- The implementation files (read them, don't guess at the structure)
- The conversation/PR history that produced the QA fixes (this is where the anti-patterns live — every "no, do it this way" is a future anti-pattern)
- Any related PRD, design doc, or ticket
- The user's stated reasons for changes — these become the *why* behind rules

If the implementation lives in a sibling repo, cite the path. Reference implementations are gold; future-Claude can read them when the SKILL.md is ambiguous.

### 2. Decide what's reusable vs project-specific

Reusable (goes in the skill):
- Architectural patterns (two-phase, status discriminator, snapshot-at-enqueue)
- Data shapes that any implementation needs (collection schema, status enum)
- Defaults that worked (poll interval, concurrency, retry count)
- Anti-patterns the user explicitly rejected
- Validation rules ("HTTP 200 isn't enough — also check X")

Project-specific (does NOT go in the skill):
- Hard-coded paths, framework names, ORM names — push these to a `Fit-to-Project` section as questions, not assertions
- Variable names, table names, route prefixes
- Auth middleware details unique to one repo
- UI component library specifics (e.g. `<Button variant="primary">`)

If you're unsure, ask: "would this still apply in a Python project? a Rails project?" If no, it's project-specific — abstract it or move it to Fit-to-Project.

### 3. Mine anti-patterns from QA history

This is the highest-leverage section of the skill. Every anti-pattern should answer: "what's the wrong thing future-Claude will reach for first, and why is it wrong?"

Sources:
- User corrections during QA ("don't do X", "stop doing Y")
- Bugs that shipped and got fixed
- Approaches Claude tried that the user rejected
- Things that *seem* right but break under load / edge cases

Format each as: **bold name** — one-sentence description, then the consequence. Keep them tight; one anti-pattern, one paragraph max.

### 4. Capture the *why*, not just the *what*

Rules without reasons rot fast. Future-Claude hits an edge case, can't tell if the rule still applies, and either blindly follows it or blindly breaks it. Add a `Why:` line for any non-obvious rule.

Bad: "Always snapshot inputs at enqueue time."
Good: "Always snapshot inputs at enqueue time. **Why:** if the entity is edited between enqueue and execution, the worker should run what the operator saw and clicked Generate on, not the post-edit state."

### 5. Write the SKILL.md

Use the structure below. Aim for 150–400 lines for a substantial skill, 50–100 for a focused one. Longer than 500 means the skill is doing too much — split it.

## SKILL.md Structure

```markdown
---
name: <skill-slug>
description: >
  Use when <trigger condition>. Covers <2-3 specific things>.
---

# <Title Case Name>

<One-paragraph elevator pitch — what problem this solves and the key insight.>

Reference implementation: `<repo-or-path>` — files cited inline below. (Optional but valuable.)

## <Architecture / Data Model / Core Pattern>

<The load-bearing structural decision. Code blocks with the actual schema, the actual function signature, the actual config object — not a description of them.>

## <Implementation Sections>

<Break by surface or phase. For each, name the file from the reference impl, then describe what it does and the key decisions inside.>

## Fit-to-Project

Before implementing, check:
- <Question about framework/library choice>
- <Question about existing infrastructure to reuse>
- <Question about auth/permission model>
- <Tunable defaults and when to change them>

## Anti-Patterns

- **<Name>** — <one-line description of the wrong thing>. <Why it bites you.>
- **<Name>** — <...>

## Logging

<What to log so that future debugging is possible without re-instrumenting.>
```

### Required sections

- **YAML frontmatter** with `name` and `description`. The description is what Claude sees when scanning `_index.md` to decide which skill to load — make it specific. "Use when X" framing works well.
- **One-paragraph intro** explaining the problem and the insight.
- **Fit-to-Project** — questions, not commands. Forces the reader to map the skill onto their stack.
- **Anti-Patterns** — at least 3, ideally 5–8.

### Optional but high-value sections

- **Reference implementation** path — when the source is accessible
- **Data model** — when the skill turns on a specific schema
- **API/contract** — when the skill is about an interface
- **Logging** — what to log so the next person can debug

### Sections to avoid

- "Background" / "Motivation" — folds into the intro paragraph
- "Future work" — skills are about what you've validated, not aspirations
- Code that's just illustrative — if the code isn't load-bearing, describe in prose
- TOC — `_index.md` is the TOC; the skill itself should fit in one mental scroll

## Code Detail Level

Include code when:
- The code IS the pattern (data model, status enum, retry policy constants)
- It captures a non-obvious sequence (the exact order of operations in an enqueue handler)
- It documents a specific contract (API response shape, error codes)

Don't include code when:
- It's framework boilerplate (component scaffolding, route registration)
- It only makes sense in one project's file layout
- You can describe the behavior in two sentences

When you do include code, prefer the smallest snippet that captures the rule. A 5-line schema beats a 50-line class.

## File Layout

```
_recipes/
  <skill-name>/
    SKILL.md
```

One directory per skill. The directory exists so a skill can later add fixtures, sub-docs, or example files without inflating the SKILL.md itself. Single file is fine to start.

The slug should be:
- Lowercase, kebab-case
- 2–4 words
- Names the *thing being built*, not the *technology used* (`admin-prompt-queue`, not `mongodb-queue`)

## After Writing

1. Add a row to `_recipes/_index.md`: `| <slug> | <one-line desc> | <slug>/SKILL.md |`. Keep the description distinct from any other row — readers scan this table.
2. If migrating from `_unmigrated/`, delete the source file in the same commit
3. Commit and push — teammates pick it up on next `git pull && ./install.sh`

## Anti-Patterns

- **Documenting what the framework already does** — if React docs cover it, don't repeat. Skills capture cross-project tribal knowledge, not tutorials.
- **Skipping the *why*** — rules without reasons get blindly followed past their useful life or blindly broken at the first edge case.
- **Copy-pasting the implementation verbatim** — the SKILL.md is the *distilled lesson*, not the source. If a reader needs the full code, they read the reference impl.
- **No anti-patterns section** — anti-patterns are the highest-signal part of the skill because they encode the QA you already paid for. A skill without them is a tutorial, not a recipe.
- **Project-specific names left in** — `useScene`, `prompt_queue`, `requireAdmin` belong in the reference impl. The skill should say "the entity hook", "the queue collection", "the admin guard".
- **Multiple skills in one file** — if the description has "and" in it more than once, split it. One skill, one job.
- **Skills built from features that haven't shipped or been QA'd** — premature skills encode hypotheses, not lessons. Wait until the user is happy with the implementation before extracting.
- **Forgetting to update `_index.md`** — an unindexed skill is invisible. Every new SKILL.md needs an `_index.md` row in the same commit.
- **Vague description fields** — "Use when working with auth" is useless. "Use when implementing OTP/magic-link auth with a sessions collection and email-based identity" is the right level.

## Logging

Not applicable to this skill (no runtime). But for the skills you create, default to including a Logging section unless the feature has no runtime component.
