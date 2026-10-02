// Parser + writers for the embedded-in-.md PRD convention. The file on disk is
// the single source of truth; this module is the ONE place that understands the
// token grammar so the server (heartbeat, routes), the drafter agent's
// expectations, and the web detail pane all agree.
//
// Grammar (minimal, hand-typeable):
//   • Whole-PRD icebox: `[ICEBOX]` anywhere in the first non-empty line.
//   • Line-items: GFM checkboxes `- [ ]` (outstanding) / `- [x]` (done).
//       - `[IMP]` token on the line  → ready for implementation (full-stack picks up)
//       - `[ICEBOX]` token on the line → that single item parked
//       - neither token              → still drafting (the default; no tag needed)
//   • Questions:
//       ❓ <question on the same line as the red question-mark emoji>
//       <any number of detail lines>
//     The ❓ MUST be at column 0 (no leading whitespace). An indented or
//     mid-line ❓ is an inline cross-reference in prose ("see ❓ Q02"), not a
//     question — only a left-margin ❓ opens a question block.
//       --- Q01 ---
//       <answer — any number of lines>
//       /// Q01 ///
//     The answer block is OUTSTANDING while empty, ANSWERED once it has content.

export interface PrdQuestion {
  /** The Q## id from the `--- Q## ---` markers, or null when no block exists yet. */
  id: string | null;
  question: string;
  details: string;
  answer: string;
  /** True once the answer block contains non-whitespace text. */
  answered: boolean;
}

export interface PrdBulletCounts {
  total: number;
  done: number;
  /** Unchecked bullets (all of them, including ready + iceboxed). */
  outstanding: number;
  /** Unchecked `[IMP]` bullets that are not `[ICEBOX]` and the doc isn't iceboxed. */
  ready: number;
  /** Unchecked bullets tagged `[ICEBOX]` (or any bullet when the whole doc is iceboxed). */
  iceboxed: number;
}

export interface PrdParse {
  title: string;
  iceboxed: boolean;
  bullets: PrdBulletCounts;
  questions: PrdQuestion[];
  outstandingQuestions: number;
  /** Deterministic heartbeat signal: full-stack-engineer has something to do. */
  hasImplementableWork: boolean;
  /** Had actionable items, all done, nothing outstanding — folds under "Show more". */
  completed: boolean;
  /**
   * True once the drafter has recorded a `[dedup]` line in the History section,
   * i.e. it has run the full duplication check (codebase + sibling PRDs) at
   * least once. The heartbeat forces a first-round draft pass on any active PRD
   * where this is still false so legacy docs get verified before implementation.
   */
  dedupVerified: boolean;
}

// A bullet's checkbox bracket holds EITHER a GFM state (` `/`x`/`X`) OR a
// readiness tag placed directly in the slot (`IMP`/`ICEBOX`). The drafter
// naturally writes the tag form `- [IMP] …` (a literal reading of "a [IMP]
// token on a bullet line"), so the parser MUST read that as an unchecked
// bullet carrying the tag — otherwise every ready item is invisible to the
// picker and the whole PRD looks like it has no implementable work.
const BULLET_RE = /^\s*[-*+]\s+\[(\s|x|X|IMP|ICEBOX)\]\s?(.*)$/i;
// The ❓ must sit at column 0. Allowing leading whitespace turned source-wrapped
// prose cross-references ("…(see\n  ❓ Q02), and…") into spurious questions that
// swallowed the rest of the doc as "details".
const Q_LINE_RE = /^❓\s*(.*)$/;
const ANSWER_START_RE = /^---\s*(Q[\w-]+)\s*---\s*$/;
const ANSWER_END_RE = /^\/\/\/\s*(Q[\w-]+)\s*\/\/\/\s*$/;

function stripTags(s: string): string {
  return s.replace(/\[(IMP|ICEBOX)\]/gi, "").replace(/\s{2,}/g, " ").trim();
}

// Inline code spans are documentation, not grammar. A PRD that *describes* the
// convention — e.g. "…not v1, but must precede that feature's `[IMP]` tagging" —
// correctly backticks the token; scanning the raw line would mistake that prose
// reference for a real readiness tag and dispatch a blocked item. Strip code
// spans before testing for `[IMP]`/`[ICEBOX]` so prose can mention the grammar.
function stripCodeSpans(s: string): string {
  return s.replace(/`[^`]*`/g, " ");
}

export type BulletTag = "imp" | "icebox" | null;

export interface BulletInfo {
  /** True when the line is a GFM checkbox bullet (any bracket form). */
  isBullet: boolean;
  /** True for `- [x]` (done). */
  checked: boolean;
  /**
   * Readiness tag for an unchecked bullet — from the bracket slot (`- [IMP] …`)
   * OR an inline `[IMP]`/`[ICEBOX]` token in the body (code spans ignored).
   * `icebox` (parked) wins over `imp` (ready). `null` = untagged / still
   * drafting. Always `null` when checked.
   */
  tag: BulletTag;
}

/**
 * The single source of truth for reading one bullet line. The parser, the
 * dispatch ready-item renderer, and the web detail pane all route through this
 * so every surface agrees on what "ready" means. They previously each
 * re-encoded the rule with a bare `/\[IMP\]/` test and drifted: the picker
 * fired on a code-span `[IMP]` reference the implementer then correctly
 * rejected, while 39 genuinely-ready `- [IMP] …` items stayed invisible.
 */
export function classifyBullet(raw: string): BulletInfo {
  const m = raw.match(BULLET_RE);
  if (!m) return { isBullet: false, checked: false, tag: null };
  const slot = m[1].trim().toLowerCase();
  if (slot === "x") return { isBullet: true, checked: true, tag: null };
  // Unchecked. Tag comes from the bracket slot or an inline token in the body,
  // with code spans stripped so prose references don't count. ICEBOX beats IMP.
  const body = stripCodeSpans(m[2]);
  const hasIcebox = slot === "icebox" || /\[ICEBOX\]/i.test(body);
  const hasImp = slot === "imp" || /\[IMP\]/i.test(body);
  const tag: BulletTag = hasIcebox ? "icebox" : hasImp ? "imp" : null;
  return { isBullet: true, checked: false, tag };
}

/**
 * Fold each GFM bullet together with its source-wrapped continuation lines into
 * a single logical line. A bullet's body frequently wraps across several
 * physical lines, indented to align under the marker; a readiness token the
 * drafter writes at the END of that wrapped sentence (`… index.web.tsx`. [IMP]`)
 * therefore lands on a CONTINUATION line, which has no `- [ ]` marker and so
 * fails `BULLET_RE`. Classifying physical-line-by-physical-line drops that
 * token entirely — the item parses as untagged (`ready: 0`), the picker never
 * sees it, and the doc wedges in "outstanding but nothing tagged" limbo while
 * the drafter (correctly) believes it tagged the item. Merging the continuation
 * text back into the bullet line before `classifyBullet` runs is what lets an
 * end-of-sentence tag count.
 *
 * A continuation line is a non-blank line, indented deeper than the bullet
 * marker, that is not itself a bullet. A blank line, a dedent to/under the
 * marker, or a new bullet ends the item — so nested sub-bullets stay their own
 * logical lines and list nesting is preserved.
 */
export function foldBulletContinuations(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!BULLET_RE.test(raw)) {
      out.push(raw);
      continue;
    }
    const markerIndent = (raw.match(/^\s*/)?.[0] ?? "").length;
    let merged = raw;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const next = lines[j];
      if (!next.trim()) break; // blank line ends the item
      if (BULLET_RE.test(next)) break; // next (possibly nested) bullet
      const indent = (next.match(/^\s*/)?.[0] ?? "").length;
      if (indent <= markerIndent) break; // dedented — no longer this item
      merged += ` ${next.trim()}`;
    }
    out.push(merged);
    i = j - 1;
  }
  return out;
}

/**
 * Unchecked, `[IMP]`-tagged, non-iceboxed bullet lines in document order — the
 * items full-stack-engineer may implement. Returns `[]` for a whole-doc icebox.
 */
export function readyBulletLines(md: string): string[] {
  const lines = md.split("\n");
  for (const raw of lines) {
    if (!raw.trim()) continue;
    if (/\[ICEBOX\]/i.test(raw)) return []; // whole-doc parked
    break;
  }
  return foldBulletContinuations(lines).filter((l) => {
    const b = classifyBullet(l);
    return b.isBullet && !b.checked && b.tag === "imp";
  });
}

// Strip a redundant "PRD" leader/follower — we already know it's a PRD.
// Handles "PRD — Foo", "PRD: Foo", "PRD - Foo", "Foo — PRD", etc.
function stripPrdLeader(s: string): string {
  return s
    .replace(/^\s*PRD\s*[—–:\-]\s*/i, "")
    .replace(/\s*[—–:\-]\s*PRD\s*$/i, "")
    .trim();
}

/** Title = first H1 heading text (tags + "PRD —" leader stripped), else "". */
export function prdTitle(md: string): string {
  for (const raw of md.split("\n")) {
    const m = raw.match(/^#\s+(.+?)\s*$/);
    if (m) return stripPrdLeader(stripTags(m[1]));
  }
  return "";
}

export function parsePrdDoc(md: string): PrdParse {
  const lines = md.split("\n");

  // Whole-PRD icebox: first non-empty line contains [ICEBOX].
  let iceboxed = false;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    iceboxed = /\[ICEBOX\]/i.test(raw);
    break;
  }

  const bullets: PrdBulletCounts = {
    total: 0,
    done: 0,
    outstanding: 0,
    ready: 0,
    iceboxed: 0,
  };
  for (const raw of foldBulletContinuations(lines)) {
    const b = classifyBullet(raw);
    if (!b.isBullet) continue;
    bullets.total++;
    if (b.checked) {
      bullets.done++;
      continue;
    }
    bullets.outstanding++;
    if (iceboxed || b.tag === "icebox") bullets.iceboxed++;
    else if (b.tag === "imp") bullets.ready++;
  }

  const questions = parseQuestions(lines);
  const outstandingQuestions = questions.filter((q) => !q.answered).length;

  const hasImplementableWork = !iceboxed && bullets.ready > 0;
  // A PRD with ZERO checkbox items is definitionally NOT done — it means the
  // drafter never itemized the requirements, so the doc is still in the drafting
  // phase regardless of any prose "shipped"/"no outstanding work" claim. Hence
  // `bullets.total > 0`: completion requires real itemized items, all checked.
  const completed =
    !iceboxed &&
    bullets.total > 0 &&
    bullets.outstanding === 0 &&
    outstandingQuestions === 0;
  // The drafter stamps `[dedup]` into a History line once it has run the full
  // duplication check. Only the drafter ever writes this token.
  const dedupVerified = /\[dedup\]/i.test(md);

  return {
    title: prdTitle(md),
    iceboxed,
    bullets,
    questions,
    outstandingQuestions,
    hasImplementableWork,
    completed,
    dedupVerified,
  };
}

function parseQuestions(lines: string[]): PrdQuestion[] {
  const questions: PrdQuestion[] = [];
  let i = 0;
  while (i < lines.length) {
    const qm = lines[i].match(Q_LINE_RE);
    if (!qm) {
      i++;
      continue;
    }
    const question = qm[1].trim();
    i++;
    const details: string[] = [];
    let id: string | null = null;
    const answerLines: string[] = [];
    // Walk forward collecting detail lines until an answer-block start marker
    // or the next question / EOF.
    while (i < lines.length) {
      const startM = lines[i].match(ANSWER_START_RE);
      if (startM) {
        id = startM[1];
        i++;
        while (i < lines.length) {
          if (ANSWER_END_RE.test(lines[i])) {
            i++;
            break;
          }
          answerLines.push(lines[i]);
          i++;
        }
        break;
      }
      if (Q_LINE_RE.test(lines[i])) break; // next question begins
      details.push(lines[i]);
      i++;
    }
    const answer = answerLines.join("\n").trim();
    questions.push({
      id,
      question,
      details: details.join("\n").trim(),
      answer,
      answered: answer.length > 0,
    });
  }
  return questions;
}

/**
 * Write `answer` into the `--- Q<id> ---` … `/// Q<id> ///` block for question
 * `id`, replacing whatever was there. Returns the updated markdown unchanged if
 * the markers aren't found. Used by the PRD detail pane's answer textarea.
 */
export function setPrdAnswer(md: string, id: string, answer: string): string {
  const lines = md.split("\n");
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].match(ANSWER_START_RE);
    if (s && s[1] === id) {
      start = i;
      for (let j = i + 1; j < lines.length; j++) {
        const e = lines[j].match(ANSWER_END_RE);
        if (e && e[1] === id) {
          end = j;
          break;
        }
      }
      break;
    }
  }
  if (start === -1 || end === -1) return md;
  const answerLines = answer.replace(/\s+$/, "").split("\n");
  const next = [
    ...lines.slice(0, start + 1),
    ...answerLines,
    ...lines.slice(end),
  ];
  return next.join("\n");
}
