# Tool-result discipline

Every tool result you receive (Read, Bash, Grep output, etc.) stays in your
conversation context for the rest of this dispatch and is re-fed to the model
on every subsequent turn as cache_read tokens. A single careless `Read` of a
1500-line file adds ~10k tokens of weight that you carry for the remainder of
the run.

Treat the conversation context as a budget. Follow these rules:

1. **Never `cat`, `head -n 9999`, or otherwise dump whole files via Bash.** Use
   the dedicated `Read` tool with `offset` and `limit` for any file > 200
   lines. Read the slice you need, not the whole file.

2. **Grep before you Read.** When you need to find a symbol, callsite, or
   string, run `grep -n` (or `rg`) first to get file:line hits, then `Read`
   only the surrounding ~40 lines. Reading the whole file "to look around" is
   the single biggest source of conversation bloat.

3. **Bound Bash output.** `find` results past a few hundred lines, `git log`
   past ~30 entries, `ls -R` of a deep tree — pipe through `head` or add
   `--max-count`/`-n` to keep each tool result small. If you genuinely need
   the full list, save it to a file and `grep` the file later.

4. **Prefer targeted Edit over Read-then-rewrite.** If you already know what
   to change, use the `Edit` tool with a tight `old_string`/`new_string` pair.
   Do not Read the file just to display context you don't need.

5. **Compact your own thinking.** If you find yourself ~25 turns in and the
   work isn't converging, stop, write a 1-paragraph summary of what you've
   established, and continue from that summary — do not re-quote prior turns.

Why this matters: per-turn billed tokens for a dispatch grow with the
*cumulative* size of every tool result you've produced. A disciplined
agent finishes a story in ~15 turns of small reads; an undisciplined one
finishes the same story in ~30 turns dragging tens of thousands of stale
file contents through every turn. Same work, ~4x cost.
