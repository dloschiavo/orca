---
name: code-qa
description: >
  Run a comprehensive QA audit against every code-quality guideline in the
  user's library. Use this any time you finish building, refactoring, or
  reviewing a feature — or any time the user says "QA this", "audit this",
  "run code QA", "check this against the guidelines", or "rx code-qa". The
  skill is a hard checklist: each guideline must be affirmatively marked
  PASS, FAIL, or FAIL WITH EXPLANATION for the diff/page/feature being
  audited. A silent omission is itself a fail. Applies to everything you
  ship — new code, bug fixes, and other people's code under review.
---

# Code QA



---

## When To Run

Run this skill:

- **After writing or modifying any UI, API, extractor, or data-model code** — before declaring the task complete.
- **During code review / PR review** — when the user asks "QA this PR" or "audit this diff".
- **When the user types `rx code-qa`** — the explicit trigger.
- **When the user says "QA", "audit", "check the guidelines", "compliance check"** — treat as an implicit trigger unless context makes clear they mean something else.
- **Recursively on yourself** — when you finish implementing a recipe or feature and are about to report "done", run the checklist against your own diff first. "I'll QA it next turn" is a fail.

You may not declare a task complete unless you have produced the checklist and resolved every failure or documented why a failure is accepted.

---

## Output Format

Produce a single markdown report with this exact shape:

```
# Code QA Report — <short feature/page/PR name>

## Scope
- What was audited: <files, routes, component, PR number>
- What was NOT audited: <anything explicitly out of scope>
- Viewports tested: <wide / narrow / both>
- Backend state: <running / not running / N/A>
- Frontend state: <running / not running / N/A>

## Checklist

### UI/UX Consistency
- ✅ **[Consistent Headers]** <evidence / file:line>
- ❌ **[Button Consistency]** <what failed, file:line, proposed fix>
- ⚠️ **[Save Disable State]** N/A — feature has no editable form
  ...

### Responsive & Layout
  ...

### State, Loading, Errors
  ...

### Tables
  ...

### Scraping / Extraction
  ...

### Backend & Data Integrity
  ...

### React Lifecycle
  ...

### Servers & Testing
  ...

### Architecture
  ...

## Summary
- <N> passed
- <N> failed
- <N> N/A (with one-line justification each)

## Blockers (must fix before shipping)
- <list of ❌ items that block declaring done>

## Follow-ups (should fix soon)
- <list of ⚠️ / non-blocking items>
```

**You must include every item from the checklist below in the report**, even if marked N/A. A missing item is a silent omission and is itself a ❌.

## Logging

- The report itself is the log. Save it alongside the work (in a PR comment, a commit trailer, a chat reply) so future audits can see what was checked last time.
- When a new rule is added to this skill (because a new post-mortem produced one), audit the *previous* features under that rule as well — a fresh rule is usually born from a bug that exists in more than one place.
- If you find yourself wanting to skip a rule repeatedly because it's "not relevant to this codebase", that's a signal to re-examine the rule — either it needs to be sharpened, or the codebase has drifted from the rule in a way that deserves a fix, not a skip.
