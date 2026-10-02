import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { summarizeContent } from "./codebase-index/summarize.js";

// ─────────────────────────────────────────────────────────────────────────────
// PRD codebase map — a BOUNDED structural index of the source files a PRD
// already references, injected into the drafter/implementer prompts.
//
// Why: PRD dispatch is stateless (no --resume), so every cold run re-discovers
// the same code from scratch. On a large PRD the full-stack-engineer re-read
// `lib/.../**` on all ~10 implement runs — ~10M cache_read tokens each, ~97% of
// the bill. PRD bodies are dense with backticked paths (`lib/foo/bar.ts`), so we
// can hand the agent the current exported surface of exactly those files up
// front. It edits in place instead of grepping/Reading them wholesale to relearn
// the structure every dispatch.
//
// Strictly bounded so the map itself can never bloat the prompt:
//   - only files the PRD already names (no repo crawl / discovery)
//   - existing files only, capped at MAX_FILES, skipping oversized blobs
//   - exported surface only, capped per file, with a global char cap
// Computed in-memory (read + summarizeContent) — no git, no cache writes into
// the target repo.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_FILES = 40;
const MAX_FILE_BYTES = 200_000;
const MAX_DECLS_PER_FILE = 14;
const MAX_OUTPUT_CHARS = 10_000;
const SIG_SLICE = 110;

// Looks like a repo-relative source path: at least one slash, a real-ish
// extension. Extensions we summarize meaningfully (ts/js/tsx/json/md) plus a
// few common neighbors we still want to list by path.
const PATH_RE =
  /(?:[\w.@-]+\/)+[\w.@-]+\.(?:tsx?|jsx?|mjs|cjs|json|md|mdx|css|scss|sql|ya?ml|py|go|rs|sh)/g;

/**
 * Pull candidate source paths out of a PRD body. Scans backticked code spans
 * first (the convention), then the raw text, and strips any `:line` /
 * `(123-456)` suffix the doc may carry. Returns unique paths in first-seen
 * order (rough proxy for relevance).
 */
function extractCandidatePaths(content: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string) => {
    // Strip a trailing :line or :start-end and any surrounding punctuation.
    const cleaned = raw.replace(/[:#].*$/, "").replace(/[)\].,;]+$/, "").trim();
    if (!cleaned || seen.has(cleaned)) return;
    seen.add(cleaned);
    out.push(cleaned);
  };
  // Backticked spans (highest signal).
  for (const m of content.matchAll(/`([^`]+)`/g)) {
    const inner = m[1] ?? "";
    for (const p of inner.matchAll(PATH_RE)) add(p[0]);
  }
  // Bare paths in prose (catches un-backticked references).
  for (const p of content.matchAll(PATH_RE)) add(p[0]);
  return out;
}

/**
 * Resolve a PRD-referenced path against the repo. PRD paths are usually
 * relative to the app subfolder that holds `product/` (e.g. `docpost-app`),
 * not the repo root, so try the app root first, then the repo root.
 */
async function resolveExisting(
  bases: string[],
  rel: string,
): Promise<{ abs: string; rel: string } | null> {
  for (const base of bases) {
    const abs = join(base, rel);
    try {
      const st = await stat(abs);
      if (st.isFile() && st.size <= MAX_FILE_BYTES) return { abs, rel };
    } catch {
      // not here — try the next base
    }
  }
  return null;
}

/** The app-root segment of a PRD relPath: everything before the `product/` dir. */
function appRootRel(prdRelPath: string): string {
  const segs = prdRelPath.split(/[/\\]/).filter(Boolean);
  const idx = segs.indexOf("product");
  return idx > 0 ? segs.slice(0, idx).join("/") : "";
}

function renderFileSummary(relForDisplay: string, content: string): string | null {
  const sum = summarizeContent(content, relForDisplay, "");
  const lines: string[] = [];
  // Exported surface first; fall back to a few top-level decls if nothing is
  // exported (still useful to know the file's shape).
  const fns = sum.functions.filter((f) => f.exported);
  const decls = sum.classes.filter((d) => d.exported);
  const pickFns = (fns.length ? fns : sum.functions).slice(0, MAX_DECLS_PER_FILE);
  const pickDecls = (decls.length ? decls : sum.classes).slice(
    0,
    Math.max(0, MAX_DECLS_PER_FILE - pickFns.length),
  );
  for (const d of pickDecls) {
    lines.push(`  ${d.kind} ${d.name}${d.exported ? "" : " (local)"}`);
  }
  for (const f of pickFns) {
    // The summary signature carries the full `export async function name(...)`;
    // drop the `export`/`function` keywords since the `fn` prefix already says
    // it's a function and the exported/local marker is appended.
    const sig = (f.signature || f.name)
      .replace(/^export\s+/, "")
      .replace(/^(async\s+)?function\s+/, "$1")
      .slice(0, SIG_SLICE);
    lines.push(`  fn ${sig}${f.exported ? "" : " (local)"}`);
  }
  const head = `\`${relForDisplay}\` (${sum.language})`;
  if (lines.length === 0) return head; // listed by path; agent knows it exists
  return `${head}\n${lines.join("\n")}`;
}

/**
 * Build the `{prd.codebase_map}` block for a PRD: the current exported surface
 * of the source files the PRD references. Empty-safe and hard-bounded.
 */
export async function buildPrdCodebaseMap(opts: {
  repoPath: string;
  prdRelPath: string;
  content: string;
}): Promise<string> {
  const { repoPath, prdRelPath, content } = opts;
  const candidates = extractCandidatePaths(content);
  if (candidates.length === 0) return "(no source files referenced in this PRD)";

  const appRoot = appRootRel(prdRelPath);
  const bases = appRoot ? [join(repoPath, appRoot), repoPath] : [repoPath];

  const blocks: string[] = [];
  let used = 0;
  let total = 0;
  for (const rel of candidates) {
    if (used >= MAX_FILES) break;
    if (total >= MAX_OUTPUT_CHARS) break;
    const hit = await resolveExisting(bases, rel);
    if (!hit) continue;
    let fileContent: string;
    try {
      fileContent = await readFile(hit.abs, "utf8");
    } catch {
      continue;
    }
    const block = renderFileSummary(rel, fileContent);
    if (!block) continue;
    used += 1;
    total += block.length + 1;
    blocks.push(block);
  }

  if (blocks.length === 0) return "(no referenced source files found on disk)";
  return blocks.join("\n");
}
