# Marketing Copy

This is a **binding checklist**. After editing any
marketing / landing copy, enumerate every rule below and mark each ✅ PASS (with the
sentence as evidence), ❌ FAIL (quote the offending copy + the fix), or 🚫 N/A (one-line
reason). A silently skipped rule is itself a fail. Every rule below exists because it
*already shipped* on a DocPost marketing page and had to be ripped back out.

## The rules

- **[Sell]** Focus marketing copy on an **outcome to a buyer**, address pain points, frame the buyer as the hero of the story, and we help them be the hero.  If you don't know who the ICP is for the copy, check the PRD.  If it's still missing, ask explicitly before continuing.   

- **[No under-the-hood]** Marketing copy is not a technical document. Never describe HOW it works internally, like storage, wrapping, persistence, pipelines, normalization. Banned shapes: *"wrapped as a Markdown document and persisted to the tenant's vault,"* *"no memory-only path that bypasses storage."*
  The buyer cannot evaluate it and does not care. Sell the outcome, not how you built it.  Even worse, when you tell them how it works under the hood, you're describing how they should just build it.

- **[No internal identifiers]** Never surface opaque internal IDs or system tokens —
  `document_id`, `tenant_id`, `org_id`, storage keys, collection names, bucket paths.
  They mean nothing to a reader. Name the real-world thing (*"a document already in your
  vault"*), not its database handle.

- **[Only real, shipped features]** Every capability stated in the present tense must exist and be shipped or be in a PRD for pre-launch development.  No invented modes, toggles, or behaviors (e.g. a *"strict /
  impute mode"* that was never built). Aspirational items past the launch go in an explicit **Roadmap**
  section, marked as such — never mixed into the live product pitch.

- **[Durable, not brittle]** Coverage / capability of enumerated sets should be generic enough that it survives the next functionality bump. NEVER enumerate a specific scope in marketing copy that near-term expansion will outdate named sets, tiers, or precise counts (*"the T14 and the ATL Top 50,"* *"the top ~20
  journals,"* *"4 agency types"*). That kind of granularity goes in the PRD and will be put into a knowledge base for technical Q&A, not in public marketing copy.  The test: **if we add more of this next month, does this sentence need editing?** If yes, it's too specific — raise the altitude. A "+" growth figure on high fuzzy numbers like *"16M+"* is fine; a fixed enumerated set that easily changes as we grow is not.

- **[Don't route the buyer through your own internals]** Never make a specific internal
  surface the payoff. Banned shapes: *"render it inline in the DocPost editor,"* *"comments
  that route back to the editing workflow."* Describe the outcome in the buyer's world —
  pipe it, file it, hand it off — not a tour of your UI plumbing.

- **[Parameter names ≠ jargon]** API parameter names that are themselves plain English
  (`jurisdiction`, `document_date`) are fine inside an API section. Opaque internal IDs are
  not. The test: **would a buyer recognize the concept without reading your code?** If yes,
  keep it; if no, it's jargon — cut or rename.

- **[Cut, don't soften]** When copy explains mechanism, **delete the sentence** — do not
  reword it into gentler mechanism. The fix almost always makes the block *shorter* and
  lands it on the benefit. If your "fix" is the same length, you probably just paraphrased
  the plumbing.

## Process

1. After editing marketing copy, re-read **each sentence** and ask: *"Does this describe
   what the buyer GETS, or how we BUILT it?"* Every how-we-built-it sentence is a FAIL.
2. Marketing / landing copy lives in the public-route files (DocPost: `app/**/*.web.tsx`).
   Apply this directive on every edit to those files.
3. Verify the rendered result in the running dev server, in a browser — copy is observable,
   so eyeball it. Include the actual URL(s) you tested in your final report so a human can
   click through and confirm.
4. Never tell the user to restart the server, reload, or hit refresh. Copy edits propagate
   via HMR — assume it worked and verify via the browser/logs before reaching for a restart.
   If something is genuinely stale or down, fix it yourself; only restart when the edit truly
   can't propagate via HMR, and if you do, output "✅" plus exactly what you restarted.
