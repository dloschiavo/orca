import { spawn } from "node:child_process";

// Deterministic spec parser. The QA agent's prompt used to ask the
// model to enumerate every requirement out of the spec markdown — that
// burns tokens on a job a regex can do, and the model sometimes misses
// items. Pull the requirements in TS instead, then either (a) hand the
// pre-parsed list to QA so the model only has to verify, not enumerate,
// or (b) skip the LLM entirely if a deterministic grep can prove every
// requirement is already satisfied in HEAD.

export interface SpecRequirement {
  // Stable id of the form "spec-1", "spec-2" so QA can key its items
  // back to the parsed list.
  id: string;
  text: string;
  // Hint tokens — significant words extracted from the requirement
  // that the empty-diff grep shortcut tries to find in the working
  // tree. Lower-cased, deduped, stop-words removed.
  keywords: string[];
}

// Words we never count as a requirement signal. Generic verbs and
// connectors that appear in every requirement and would otherwise
// pollute every grep with thousands of irrelevant hits.
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "these", "those",
  "must", "should", "will", "shall", "have", "has", "had", "been", "being",
  "add", "fix", "make", "use", "uses", "used", "using", "set", "get",
  "all", "any", "some", "into", "onto", "upon", "over", "under",
  "when", "where", "what", "which", "who", "how", "why",
  "if", "then", "else", "than", "but", "not", "are", "was", "were", "is",
  "of", "in", "on", "at", "to", "by", "as", "an", "a",
  "it", "its", "or", "be", "do", "does", "did", "doing",
  "you", "your", "we", "our", "i", "me", "my",
  "new", "old", "more", "less", "each", "every",
  "spec", "specs", "story", "stories", "task", "tasks",
]);

/**
 * Walk the spec markdown line by line and pull out things that look
 * like requirements:
 *   - numbered list items ("1. …", "2) …")
 *   - bulleted list items ("- …", "* …")
 *   - imperative sentences whose first word matches a known directive
 *
 * Returns a stable, ordered list. Empty input → empty list. The order
 * matches the source spec so the QA agent can refer to "requirement
 * spec-3" and the human can find it on the page.
 */
export function parseSpecRequirements(specMd: string): SpecRequirement[] {
  if (!specMd || !specMd.trim()) return [];

  const out: SpecRequirement[] = [];
  const lines = specMd.split("\n");
  let counter = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    // Skip headings and code fences — those describe sections, not
    // requirements. Headings can still contain something requirement-y
    // ("## Requirements") but they're never themselves the work item.
    if (line.startsWith("#")) continue;
    if (line.startsWith("```")) continue;

    let text: string | null = null;

    // Numbered list: "1." / "1)" / "10."
    const numMatch = line.match(/^(\d+)[.)]\s+(.+)$/);
    if (numMatch && numMatch[2]) {
      text = numMatch[2];
    }

    // Bullet list: "- …" / "* …"
    if (!text) {
      const bullMatch = line.match(/^[-*+]\s+(.+)$/);
      if (bullMatch && bullMatch[1]) text = bullMatch[1];
    }

    // Imperative sentence: starts with a directive verb in lower or
    // title case. We're conservative here — only sentences whose first
    // word is in this small whitelist count, otherwise narrative
    // background prose ("the system handles X") would be flagged as
    // requirements.
    if (!text) {
      const imperativeMatch = line.match(
        /^(Add|Fix|Remove|Delete|Rename|Update|Create|Implement|Wire|Replace|Refactor|Ensure|Validate|Show|Hide|Enable|Disable|Allow|Forbid|Surface|Persist)\b\s+(.+)$/,
      );
      if (imperativeMatch && imperativeMatch[1] && imperativeMatch[2]) {
        text = `${imperativeMatch[1]} ${imperativeMatch[2]}`;
      }
    }

    if (!text) continue;

    // Strip trailing punctuation from the captured text — feels nicer
    // in the QA report.
    text = text.replace(/[.;:,!?]+$/, "").trim();
    if (!text) continue;

    counter += 1;
    out.push({
      id: `spec-${counter}`,
      text,
      keywords: extractKeywords(text),
    });
  }

  return out;
}

/**
 * Extract grep-able keywords from a requirement. Significant tokens
 * only — identifiers that look like file paths, function names, or
 * camelCase/PascalCase symbols are weighted highest because they're
 * the things that actually exist in the codebase verbatim.
 */
function extractKeywords(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  // Pull file-path-ish tokens first (they're the highest signal):
  // anything containing a slash or dot followed by an extension.
  const pathRe = /[A-Za-z0-9_./-]+\.[A-Za-z0-9]+|[A-Za-z0-9_-]+\/[A-Za-z0-9_./-]+/g;
  for (const m of text.matchAll(pathRe)) {
    const w = m[0];
    if (!seen.has(w)) {
      seen.add(w);
      out.push(w);
    }
  }

  // Pull camelCase / PascalCase / snake_case identifiers — these
  // survive verbatim into code.
  const idRe = /\b[A-Za-z][A-Za-z0-9_]*[A-Z_][A-Za-z0-9_]*\b/g;
  for (const m of text.matchAll(idRe)) {
    const w = m[0];
    if (!seen.has(w)) {
      seen.add(w);
      out.push(w);
    }
  }

  // Then quoted strings — specs often quote the literal text the
  // change should produce.
  const quoteRe = /["'`]([^"'`]+)["'`]/g;
  for (const m of text.matchAll(quoteRe)) {
    const inner = (m[1] ?? "").trim();
    if (inner.length >= 3 && !seen.has(inner)) {
      seen.add(inner);
      out.push(inner);
    }
  }

  // Finally fall back to plain word tokens 4+ chars, stop-word filtered.
  const wordRe = /\b[A-Za-z][A-Za-z0-9_]{3,}\b/g;
  for (const m of text.matchAll(wordRe)) {
    const w = m[0];
    const lower = w.toLowerCase();
    if (STOP_WORDS.has(lower)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= 8) break;
  }

  return out;
}

export interface DeterministicQaPass {
  satisfied: boolean;
  // For each requirement, the keyword that successfully matched in the
  // working tree (or null if none did). Used to give the human / QA
  // agent evidence of which file the match came from.
  evidence: { id: string; keyword: string | null; file: string | null }[];
}

/**
 * Pre-flight QA check: for each parsed requirement, run a single
 * `git grep` for the strongest keyword (file paths > identifiers >
 * quoted strings > words). Returns satisfied=true ONLY when EVERY
 * requirement has at least one match. Falls open (satisfied=false) on
 * any uncertainty — it's a fast-path optimization, not a replacement
 * for the LLM QA gate.
 *
 * The win: when the do-er runs on a story whose feature is already in
 * HEAD (e.g. a re-dispatch after a manual fix, or a story that was
 * built in a prior session and just hasn't been marked done), this
 * skips the entire QA model call.
 */
export async function runDeterministicQa(
  repoPath: string,
  requirements: SpecRequirement[],
): Promise<DeterministicQaPass> {
  if (requirements.length === 0) {
    // No requirements means we can't prove anything either way.
    // Fall through to LLM QA.
    return { satisfied: false, evidence: [] };
  }

  const evidence: DeterministicQaPass["evidence"] = [];
  for (const req of requirements) {
    let matched: { keyword: string; file: string } | null = null;
    for (const kw of req.keywords) {
      const file = await gitGrepFirstFile(repoPath, kw);
      if (file) {
        matched = { keyword: kw, file };
        break;
      }
    }
    if (!matched) {
      // Even one un-matched requirement disqualifies the whole pass.
      // Bail early — no point grepping the rest.
      evidence.push({ id: req.id, keyword: null, file: null });
      return { satisfied: false, evidence };
    }
    evidence.push({ id: req.id, keyword: matched.keyword, file: matched.file });
  }

  return { satisfied: true, evidence };
}

/**
 * `git grep -l --fixed-strings <kw>` returning the first matching file
 * (or null). Bounded — we kill the child after a short timeout because
 * a runaway grep is much worse than a missed match.
 */
function gitGrepFirstFile(
  cwd: string,
  keyword: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    // Reject anything that looks like a git grep flag or shell metachar.
    // Keywords come from spec text so we don't fully trust them.
    if (!/^[A-Za-z0-9_./\- ]+$/.test(keyword)) {
      resolve(null);
      return;
    }
    const child = spawn(
      "git",
      ["grep", "-l", "-I", "--fixed-strings", "--", keyword],
      { cwd },
    );
    let out = "";
    let done = false;
    const finish = (val: string | null) => {
      if (done) return;
      done = true;
      try {
        child.kill();
      } catch {
        // ignore — child already exited
      }
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), 2000);
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.on("close", () => {
      clearTimeout(timer);
      const first = out.split("\n").find((l) => l.trim().length > 0) ?? null;
      finish(first);
    });
    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
  });
}
