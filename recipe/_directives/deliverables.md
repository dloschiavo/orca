## Specifity

If the story spec is absent, or contains only a title with no acceptance criteria, only continue if you have no questions and no uncertainty about what is to be implemented.  If you DO have any questions or uncertainties about what is to be implemented, mention those questions instead, each marked with ⚠️, change the story status to blocked, and do not implement.

## Deliverables checklist

Before declaring any story done, restate a requirements checklist from the story spec in your final message and marking each and every requirement explicitly:

- ✅ done — with a `file_path:line_number` citation showing where it was
  implemented (or where the existing code already satisfies it)
- ❌ not done — with a one-line reason
- ⚠️ partial — with what is missing.  

You should ONLY ever have incomplete, partial, or missing elements when encountering uncertainty or a question that the user must answer, and has not answered in the spec or elsewhere.

1. **Establish scope.** Read the diff, the route, or the feature under audit. Write down what is *in* scope and what is *out* of scope before starting. A fuzzy scope invites silent omissions.
2. **Start the servers if applicable.** Do not proceed with "skipped because it wasn't running" — that is an automatic fail under [Backend Server Test] / [Frontend Server Test]. If either can't start, that itself is a blocker finding.
3. **Walk the checklist in order.** For each rule, actually look at the code or the running app — do not mark ✅ from memory. Include file:line or viewport evidence.
4. **Test at both breakpoints.** Any page-level audit must be checked at both >768px and ≤768px. Half the rules have different surfaces in each mode.
5. **Re-read the diff with the rules in mind a second time.** The first pass catches the obvious violations; the second pass catches the subtle ones (a token used in UI chrome but a hardcoded hex in an adjacent chart mapping, an `ActionButton` paired with a bare `TouchableOpacity`).
6. **Write the report.** Every rule appears. Every ❌ has a proposed fix. Every 🚫 N/A has a one-line justification.
7. **Fix the blockers before declaring done.** If the user requested a build-and-QA pass in one turn, perform the fixes and re-run the affected checks. Record the before/after in the report.
8. **Re-read the full checklist one last time.** The second read is not optional — state explicitly that you have done it. This mirrors the recipe-install rule in `_index.md` and catches the "I forgot one of the rules" failure mode.

### Anti-patterns

NEVER silently omit status of any requirement completion.  A silent omission is a false claim of completion. Finishing some of the requirements while reporting "done" is the failure mode tracked as `agent-false-completion` in the findings system, and it is the worst class of failure measures — it is not corrected by clearer specs, because it is not a comprehension failure. **The ONLY way you avoid this finding is to explicitly enumerate every requirement before saying done.** 

NEVER rely on QA catching your omissions — produce the requirements checklist yourself.

Whenever testing any that's viewable by the frontend (so this includes any backend changes for a frontend UI even if no frontend changes were made), you must include in your final report each of the actual URLs you used to test your work product so that a human can easily click through and verify your testing.

- **Skipping N/A rules.** A silent omission is a ❌. If the feature has no tables, the four table rules still appear in the report, each marked 🚫 N/A with "no tables in this feature" as justification. The moment you start dropping "obviously irrelevant" rules, you will drop a relevant one too.
- **Eyeballing without evidence.** Every ✅ needs a file:line or a viewport observation. "Looks fine" is not a pass. The checklist exists specifically because "looks fine" shipped the bugs that produced these rules in the first place.
- **Grading your own work generously.** When you are QA-ing your own diff, apply *stricter* scrutiny than you would to a teammate's PR. You are the one most likely to rationalize a shortcut.
- **Reporting blockers as follow-ups.** A ❌ is a blocker unless the user has explicitly accepted it. Moving something to the "Follow-ups" section to avoid having to fix it right now is dishonest.
- **Running the checklist once and caching the result.** Every run is against the current state of the code. Do not reuse a prior report.
- **Skipping the second read of the checklist.** The first read catches the obvious violations; the second catches what you rationalized past on the first read. Skipping it defeats the purpose of the skill.
- **Dropping rules to shorten the report.** The report is not allowed to be short. 70+ items is the floor, not the ceiling. A short report is a failed audit.
- **Treating the checklist as advice.** These are not heuristics; they are post-mortems. Every rule exists because "looks fine" shipped a bug. Treat them as binding.
- **QA-ing the code but not the running app.** Several rules ([No Page Flicker], [Pressable Background], [Responsive Breakpoint], [Dark Scrollbars], [Endpoint Existence]) can only be verified with the app actually running. Static review alone is insufficient for these.
- **Claiming "this is the first pass, I'll QA next turn."** The QA pass is part of the task, not a follow-up. The task is not complete until the report exists and the blockers are resolved.

## Server Restarts

Server restarts and verification are YOUR job. After making any change:
* You MUST verify the change works. Hit the relevant endpoint, check the UI, confirm the fix actually does what it's supposed to do. Do not declare done until you have evidence it works.
* Never hand off unverified work.  If the work requires a server restart or a cache clear to get something live (e.g. endpoint, migration, clear a cache), then YOU must restart it, YOU must clear that cache, and verify it's live after.  "Restart the server" is not a deliverable - it is an admission that you didn't finish the job.  Kill the running process and relaunch it if you need to. Do not tell the user to restart it.  If you were a developer on this team, shipping unverified work is a fireable offense.

## Append-Only & Additive, only replace when explicit

Some files contain cumulative denylists, allowlists, suppression rules, or accumulated guidance. When a story asks to "hide / filter / suppress / block / drop / exclude X" from one of these files, treat the new entry as **additive**: insert a new line alongside the existing rules, leaving every prior rule untouched. Each existing rule is a record of a past user complaint and is load-bearing.  You may only rewrite or remove entries when the story explicitly says "replace", "start over", "clean up", "instead", or "remove". When in doubt, ask before removing.  These can usually be found with `// APPEND-ONLY`.

## Pre-existing Errors

Whenever you find a pre-existing error:
* If you have explicit instructions to ignore it, state what the error was, plus when/where those instructions to ignore it came from.
* If you do not have explicit instructions to ignore it, you MUST fix it.  These pre-existing errors just drain tokens as you re-analyze them repeatedly.
