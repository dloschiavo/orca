import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, ne } from "drizzle-orm";
import { schema } from "@orca/db";
import type { OrcaDb } from "@orca/db";
import type { CliDispatchState, AgentName } from "@orca/shared";
import { parsePrdDoc, readyBulletLines, setPrdAnswer, foldBulletContinuations } from "@orca/shared";
import { withFileWriteLock, atomicWriteFile } from "./file-write-lock.js";
import { runCliDispatch } from "./cli-dispatch.js";
import { buildPrdCodebaseMap } from "./prd-codebase-map.js";
import { isUnderProductDir } from "./prd-scan.js";
import { loadPrompt, renderPromptLazy } from "./prompt-loader.js";
import { resolveModelForAgent, resolveMaxTurnsForAgent } from "../agents/model.js";
import {
  buildDirectiveResolvers,
  orcaApiUrl,
  expandTilde,
  sha256,
} from "./dispatch-prompt-util.js";

export type PrdDispatchMode = "draft" | "implement";

// Render the question state for the drafter. The full question blocks (incl.
// their `details`) are ALREADY in `{prd.content}`, so re-emitting them here just
// doubles the token weight of every question on every dispatch. We instead emit
// only what each state needs the drafter to ACT on:
//   - answered  → the question + the user's answer + the fold-in/delete order
//                 (this is the work; the answer text lives only in the doc's
//                 answer area, so it must be surfaced).
//   - open      → a one-line stub so the drafter knows not to re-ask it; the
//                 detail is in `{prd.content}` if it needs to re-read it.
function renderQuestionsForDrafter(content: string): string {
  const parse = parsePrdDoc(content);
  if (parse.questions.length === 0) return "(no questions in the doc yet)";
  const answered = parse.questions.filter((q) => q.answered);
  const open = parse.questions.filter((q) => !q.answered);
  const parts: string[] = [];
  if (answered.length) {
    parts.push(
      answered
        .map(
          (q) =>
            `❓ ${q.question}${q.id ? ` [${q.id}]` : ""}\nANSWER (fold this into the doc body, then delete the whole question block): ${q.answer}`,
        )
        .join("\n\n"),
    );
  }
  if (open.length) {
    parts.push(
      `Still-open questions (full detail is in the PRD body above — do NOT re-ask these):\n` +
        open.map((q) => `- ❓ ${q.question}${q.id ? ` [${q.id}]` : ""}`).join("\n"),
    );
  }
  return parts.join("\n\n");
}

// A one-line synopsis of a sibling PRD, extracted from content we already read
// server-side. Lets the drafter judge scope overlap from the injected list
// instead of re-opening every sibling file each dispatch. Prefers an explicit
// `**Status:**`/`## Summary` line; falls back to the first real prose line.
function siblingSynopsis(content: string): string {
  const lines = content.split(/\r?\n/);
  let snippet = "";
  const statusLine = lines.find((l) => /^\s*\*\*Status:\*\*/i.test(l));
  if (statusLine) {
    snippet = statusLine.replace(/^\s*\*\*Status:\*\*\s*/i, "").trim();
  } else {
    // First non-empty line that isn't a heading, token, list bullet, or rule.
    const prose = lines.find(
      (l) =>
        l.trim() &&
        !/^\s*(#|>|-|\*|\||`{3}|\[ICEBOX\]|❓|---|\/\/\/)/.test(l.trim()),
    );
    snippet = (prose ?? "").trim();
  }
  if (snippet.length > 160) snippet = `${snippet.slice(0, 157)}…`;
  const ready = readyBulletLines(content).length;
  const readyNote = ready > 0 ? `${ready} ready [IMP]` : "no ready items";
  return snippet ? `${snippet} · ${readyNote}` : readyNote;
}

// Max ready items handed to one implement dispatch. A whole section's worth of
// related work amortizes the cold-start cost (re-read PRD + codebase map +
// re-discover files) across many items instead of paying it per item; the cap
// keeps a pathologically large section from blowing the agent's context. The
// remainder dispatches in the next pass.
const MAX_READY_BATCH = 12;

// How recently the last implement pass must have run for a --resume to be worth
// it. Resuming replays the prior transcript; that's cheap `cache_read` only
// while Anthropic's prompt cache (≈5 min TTL) is still warm. Past this window
// the resumed (and now larger) context goes cold and a fresh cold-start is
// cheaper — so we only resume within it.
const RESUME_TTL_MS = 4 * 60 * 1000;

// Select the next batch of ready [IMP] items: all ready items that live under
// the SAME PRD section (nearest preceding heading), in document order, capped at
// MAX_READY_BATCH. Same-section items are the "tightly-coupled section" the
// implementer prompt already licenses — batching them avoids N cold starts for
// N items while still keeping unrelated sections in separate passes.
export function selectReadyBatch(content: string): {
  items: string[];
  remaining: number;
  section: string;
} {
  // Shared classifier (code-span aware, accepts both `- [ ] … [IMP]` and the
  // `- [IMP] …` bracket form) so this matches exactly what the heartbeat's
  // `hasImplementableWork` and the web detail pane count as ready.
  const ready = readyBulletLines(content);
  if (ready.length === 0) return { items: [], remaining: 0, section: "" };
  const readySet = new Set(ready);

  // Walk the doc tracking the nearest heading; record each ready line with the
  // section it sits under. Items under one heading are contiguous here (document
  // order never revisits an earlier heading), so the first section's ready items
  // are a prefix of this list. Walk the SAME folded view `readyBulletLines`
  // returns — a source-wrapped bullet is one logical line there (with its
  // end-of-sentence `[IMP]` merged in), so matching against raw physical lines
  // would never hit the set and `withSection` would be empty.
  const withSection: { section: string; line: string }[] = [];
  let heading = "";
  for (const raw of foldBulletContinuations(content.split("\n"))) {
    const hm = raw.match(/^#{1,6}\s+(.+?)\s*$/);
    if (hm) {
      heading = hm[1]!.trim();
      continue;
    }
    if (readySet.has(raw)) withSection.push({ section: heading, line: raw.trim() });
  }

  const firstSection = withSection[0]!.section;
  const items: string[] = [];
  for (const r of withSection) {
    if (r.section !== firstSection) break; // next section → next pass
    items.push(r.line);
    if (items.length >= MAX_READY_BATCH) break;
  }
  return { items, remaining: ready.length - items.length, section: firstSection };
}

// Render the next batch of related ready items for full-stack-engineer.
function renderReadyItems(content: string): string {
  const { items, remaining, section } = selectReadyBatch(content);
  if (items.length === 0) return "(no [IMP] items — nothing to implement)";
  const head =
    items.length === 1
      ? `Implement this ready item, then check it off in the PRD:`
      : `Implement these ${items.length} ready items${section ? ` (all under **${section}**)` : ""} together as one coherent change, then check EACH off in the PRD:`;
  const body = items.join("\n");
  const more =
    remaining > 0
      ? `\n\n(${remaining} more [IMP] item${remaining === 1 ? "" : "s"} remain in other sections — they dispatch in a later pass; do NOT touch them now.)`
      : "";
  return `${head}\n${body}${more}`;
}

/**
 * Re-apply durable human answers into the on-disk PRD after the agent rewrote
 * it. The drafter rewrites the file wholesale, so an answer the human saved
 * before/during the run (stored in `prds.answers`, keyed by `Q##` id) would be
 * lost on overwrite. For each stored answer:
 *   - the post-run file STILL has that `--- Q## ---` block → re-apply the answer
 *     (the drafter rewrote the question in place but dropped the answer text).
 *   - the block is gone → the drafter folded the answer into the spec and
 *     removed the question; drop the stored entry so a later *reused* id (the
 *     drafter does reopen e.g. `Q01`) can't resurrect a stale answer.
 *
 * Runs strictly AFTER the agent process exits, under the per-file write lock, so
 * it never races the agent's own writes. A failed/empty post-run read prunes
 * nothing and writes nothing — answers survive for the next successful pass.
 */
async function mergeStoredAnswersIntoFile(
  abs: string,
  after: string,
  storedAnswers: Record<string, string>,
): Promise<{ content: string; answers: Record<string, string>; answersChanged: boolean }> {
  const entries = Object.entries(storedAnswers ?? {});
  if (entries.length === 0 || after.trim() === "") {
    return { content: after, answers: storedAnswers ?? {}, answersChanged: false };
  }

  const presentIds = new Set(
    parsePrdDoc(after)
      .questions.map((q) => q.id)
      .filter((id): id is string => id != null),
  );

  let merged = after;
  const kept: Record<string, string> = {};
  let answersChanged = false;
  for (const [qid, answer] of entries) {
    if (presentIds.has(qid)) {
      kept[qid] = answer;
      merged = setPrdAnswer(merged, qid, answer);
    } else {
      answersChanged = true; // block folded away → forget the answer
    }
  }

  if (merged !== after) {
    await withFileWriteLock(abs, () => atomicWriteFile(abs, merged));
  }
  return { content: merged, answers: kept, answersChanged };
}

/**
 * Dispatch the drafter (mode "draft") or full-stack-engineer (mode "implement")
 * against a single PRD file, via the shared runCliDispatch core. On completion,
 * stamp the processed hash so the settle/debounce window doesn't re-fire on the
 * change the agent itself just made.
 */
export async function runPrdDispatch(opts: {
  db: OrcaDb;
  prdId: string;
  mode: PrdDispatchMode;
  trigger?: string;
  adoptExistingPid?: { pid: number; state: CliDispatchState };
}): Promise<void> {
  const { db, prdId, mode } = opts;
  const [prd] = await db
    .select()
    .from(schema.prds)
    .where(eq(schema.prds.id, prdId));
  if (!prd) return;
  const [project] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, prd.projectId));
  if (!project) return;

  const repoPath = expandTilde(project.repoPath);
  const absPath = join(repoPath, prd.relPath);
  const agentName: AgentName = mode === "draft" ? "drafter" : "full-stack-engineer";
  const content = await readFile(absPath, "utf8").catch(() => "");

  let prompt = "";
  let systemPrompt: string | null = null;
  let model: string | null = null;
  let maxTurns: number | null = null;
  let systemPromptHash: string | null = null;
  // The section this implement pass will work on, and whether we resume the
  // prior session instead of cold-starting. Both stay at their defaults for the
  // drafter and for the adoption branch.
  let batchSection = "";
  let resumeSessionId: string | null = null;

  if (!opts.adoptExistingPid) {
    const mainTpl = await loadPrompt(agentName, "main");
    const sysTpl = await loadPrompt(agentName, "system");
    if (!mainTpl) {
      throw new Error(`[orca] agent "${agentName}" [MAIN] prompt not found at prompts/${agentName}.md`);
    }
    // Sibling PRDs in the same project — the drafter reads these to detect
    // overlap/supersession (cross-PRD dedup). Exclude parked/ignored docs: an
    // iceboxed, per-file-ignored, or ignored-folder doc is not a canonical
    // source to dedup against. relPath is the stable anchor; the title is a hint
    // (may be slightly stale until the sibling re-drafts).
    const ignoredFolders = (project.prdIgnoredFolders ?? []).map((f) =>
      f.replace(/^\/+|\/+$/g, ""),
    );
    const underIgnoredFolder = (rel: string): boolean =>
      ignoredFolders.some((f) => rel === f || rel.startsWith(`${f}/`));
    const siblingRows = await db
      .select({
        relPath: schema.prds.relPath,
        title: schema.prds.title,
        ignoredAt: schema.prds.ignoredAt,
      })
      .from(schema.prds)
      .where(and(eq(schema.prds.projectId, prd.projectId), ne(schema.prds.id, prdId)));
    const siblings: { relPath: string; title: string | null; synopsis: string }[] = [];
    for (const s of siblingRows) {
      if (s.ignoredAt != null) continue;
      if (!isUnderProductDir(s.relPath)) continue;
      if (underIgnoredFolder(s.relPath)) continue;
      const sContent = await readFile(join(repoPath, s.relPath), "utf8").catch(() => null);
      if (sContent == null) continue; // file gone
      if (parsePrdDoc(sContent).iceboxed) continue; // parked
      // Synopsis from the content we just read — saves the drafter from
      // re-opening each sibling to judge overlap.
      siblings.push({ relPath: s.relPath, title: s.title, synopsis: siblingSynopsis(sContent) });
    }
    const siblingsRendered = siblings.length
      ? siblings
          .map(
            (s) =>
              `- \`${s.relPath}\`${s.title ? ` — ${s.title}` : ""}\n    ${s.synopsis}`,
          )
          .join("\n")
      : "(no other PRDs in this project)";
    // Rendered once at dispatch time so the drafter writes an accurate
    // History timestamp instead of guessing the date.
    const nowStamp = `${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`;
    const resolvers = {
      ...buildDirectiveResolvers([mainTpl, sysTpl ?? ""]),
      "orca.api_url": orcaApiUrl(),
      mode: mode === "implement" ? "PRD implementation" : "PRD drafting",
      now: nowStamp,
      "prd.id": prdId,
      "prd.path": prd.relPath,
      "prd.abs_path": absPath,
      "prd.content": content || "(empty file)",
      "prd.questions": renderQuestionsForDrafter(content),
      "prd.ready_items": renderReadyItems(content),
      "prd.siblings": siblingsRendered,
      // Lazy: only computed when the agent's template references it. A bounded
      // structural map of the source files this PRD names, so a stateless cold
      // dispatch doesn't re-Read them wholesale to rediscover their structure.
      "prd.codebase_map": async () =>
        buildPrdCodebaseMap({ repoPath, prdRelPath: prd.relPath, content }),
      "audit.name": "(n/a — PRD mode)",
      "audit.fails": "(n/a — PRD mode)",
      "project.name": project.name,
      "project.repo_path": repoPath,
    };
    prompt = await renderPromptLazy(mainTpl, resolvers);
    systemPrompt = sysTpl ? await renderPromptLazy(sysTpl, resolvers) : null;
    if (systemPrompt) systemPromptHash = sha256(systemPrompt);
    model = await resolveModelForAgent(db, agentName);
    maxTurns = await resolveMaxTurnsForAgent(db, agentName);

    // Bounded session continuity (implement mode only). Resume the prior
    // session ONLY when this pass continues the SAME PRD section the session was
    // built on (same files → the replayed context is relevant, not dead
    // weight), the system prompt is unchanged (so we're not resuming the
    // drafter's session or a stale prompt), and the session is still cache-warm.
    // Otherwise cold-start: the .md file is the durable state, and the codebase
    // map already makes a cold start cheap. The same-section guard naturally
    // scopes resume to a section that overflowed MAX_READY_BATCH — exactly the
    // case where consecutive passes touch the same code.
    if (mode === "implement") {
      batchSection = selectReadyBatch(content).section;
      const sameSection =
        prd.claudeSessionSection != null && prd.claudeSessionSection === batchSection;
      const samePrompt =
        prd.claudeSessionSystemPromptHash != null &&
        prd.claudeSessionSystemPromptHash === systemPromptHash;
      const warm =
        prd.lastProcessedAt != null &&
        Date.now() - prd.lastProcessedAt.getTime() < RESUME_TTL_MS;
      if (prd.claudeSessionId && sameSection && samePrompt && warm) {
        resumeSessionId = prd.claudeSessionId;
      }
    }
  }

  const result = await runCliDispatch({
    db,
    target: { kind: "prd", id: prdId, projectId: prd.projectId },
    cwd: repoPath,
    agentName,
    prompt,
    systemPrompt,
    model,
    maxTurns,
    // Resume the prior session for a same-section continuation pass (set above),
    // else null = cold start. buildClaudeArgs only sends the system prompt when
    // this is null, so a resume continues the cached session in place.
    existingSessionId: resumeSessionId,
    systemPromptHash,
    trigger: opts.trigger,
    adoptExistingPid: opts.adoptExistingPid,
    onPidPersist: async (pid, state) => {
      await db
        .update(schema.prds)
        .set({
          dispatchPid: pid,
          dispatchedAt: new Date(),
          dispatchState: state,
          // A fresh dispatch clears any prior manual-stop pause.
          dispatchStoppedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.prds.id, prdId));
    },
    onSessionPersist: async (sessionId, hash) => {
      await db
        .update(schema.prds)
        .set({
          claudeSessionId: sessionId,
          ...(hash ? { claudeSessionSystemPromptHash: hash } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.prds.id, prdId));
    },
    onClearTracking: async () => {
      await db
        .update(schema.prds)
        .set({ dispatchPid: null, dispatchState: null, updatedAt: new Date() })
        .where(eq(schema.prds.id, prdId));
    },
  });

  // Stamp the post-run state as processed. We update lastSeenHash +
  // lastProcessedHash to the post-run content so the heartbeat doesn't (a)
  // re-draft on the agent's own edit (drafter is gated on hash !==
  // lastProcessedHash) or (b) mistake the agent's checkbox-flip for a fresh
  // human edit (gated on hash !== lastSeenHash).
  //
  // We deliberately do NOT touch lastChangeAt here. lastChangeAt is the
  // human-edit debounce anchor: PRD_IMPLEMENT_SETTLE_MS exists to give a human
  // time to read/edit a doc before code gets written, measured from the last
  // *human* edit. Re-stamping it on the agent's own checkbox-flip re-armed that
  // 10-min window after every item, so a doc with N ready items took N×10 min of
  // dead settle time. By leaving lastChangeAt anchored at the last human edit,
  // the implementer flows through all ready items one per tick; a real human
  // edit still re-arms the debounce via the heartbeat's fresh-change branch.
  const afterRaw = await readFile(absPath, "utf8").catch(() => "");
  // Re-apply human answers the drafter's wholesale rewrite may have dropped.
  // Re-read the answers column fresh — the human may have answered DURING the
  // run, after `prd` was loaded at dispatch start.
  const [answersRow] = await db
    .select({ answers: schema.prds.answers })
    .from(schema.prds)
    .where(eq(schema.prds.id, prdId));
  const merge = await mergeStoredAnswersIntoFile(absPath, afterRaw, answersRow?.answers ?? {});
  const after = merge.content;
  const hash = sha256(after);
  // Session-continuity bookkeeping (implement mode, fresh spawn only):
  //   - resume that couldn't even start (stale/expired session) → drop the
  //     session so the next pass cold-starts fresh.
  //   - otherwise → record the section this session is implementing, so a
  //     same-section continuation pass can --resume it (onSessionPersist has
  //     already written the session id during the run).
  // The drafter and the adoption branch leave claudeSessionSection untouched;
  // an interleaving drafter run changes the session's system-prompt hash, which
  // already blocks an implement resume.
  const sessionFields: { claudeSessionId?: null; claudeSessionSection?: string | null } =
    !opts.adoptExistingPid && mode === "implement"
      ? result.resumeStartFailed
        ? { claudeSessionId: null, claudeSessionSection: null }
        : { claudeSessionSection: batchSection }
      : {};
  await db
    .update(schema.prds)
    .set({
      lastProcessedHash: hash,
      lastProcessedAt: new Date(),
      lastSeenHash: hash,
      title: parsePrdDoc(after).title || prd.title,
      // Prune answers whose question the drafter folded away (see merge above).
      ...(merge.answersChanged ? { answers: merge.answers } : {}),
      ...sessionFields,
      updatedAt: new Date(),
    })
    .where(eq(schema.prds.id, prdId));
}
