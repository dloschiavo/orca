// Ad-hoc CLI for the codebase signature index. Walks the repo (or a subtree),
// summarises each indexable file, and prints stats: per-file token counts,
// cache hit rate, and total compression vs. raw source.
//
//   tsx src/scripts/codebase-index.ts                 # whole monorepo
//   tsx src/scripts/codebase-index.ts packages/db     # subtree
//   tsx src/scripts/codebase-index.ts --top 20        # show top N modules by export surface
//
// Output is JSON-on-stdout; human-readable summary on stderr.

import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { detectLanguage, summarizeFiles } from "../services/codebase-index/index.js";
import type { FileSummary } from "../services/codebase-index/types.js";

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".turbo",
  ".vite",
  ".git",
  ".data",
  "coverage",
  "pgdata",
  ".next",
]);

const INDEXABLE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".md", ".mdx",
]);

function walk(root: string, sub: string, out: string[]): void {
  const abs = join(root, sub);
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".gitignore") continue;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(root, sub ? `${sub}/${e.name}` : e.name, out);
    } else if (e.isFile()) {
      const ext = e.name.slice(e.name.lastIndexOf(".")).toLowerCase();
      if (!INDEXABLE_EXT.has(ext)) continue;
      out.push(sub ? `${sub}/${e.name}` : e.name);
    }
  }
}

function exportSurface(s: FileSummary): number {
  return (
    s.classes.filter((c) => c.exported).length +
    s.functions.filter((f) => f.exported).length
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function main(): void {
  const args = process.argv.slice(2);
  let topN = 10;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--top" && args[i + 1]) {
      topN = parseInt(args[++i] ?? "10", 10);
    } else if (a !== undefined) {
      positional.push(a);
    }
  }

  const repoRoot = resolve(process.cwd(), "..", "..");
  const subtree = positional[0] ? positional[0] : "";

  const subAbs = subtree ? resolve(repoRoot, subtree) : repoRoot;
  const subRel = relative(repoRoot, subAbs) || ".";
  let stat;
  try {
    stat = statSync(subAbs);
  } catch {
    process.stderr.write(`Path not found: ${subAbs}\n`);
    process.exit(1);
  }

  const files: string[] = [];
  if (stat.isFile()) {
    files.push(relative(repoRoot, subAbs));
  } else {
    walk(repoRoot, subRel === "." ? "" : subRel, files);
  }

  process.stderr.write(`Indexing ${files.length} files under ${subRel}…\n`);

  const t0 = Date.now();
  const { summaries, cacheHits, cacheMisses } = summarizeFiles(repoRoot, files);
  const elapsedMs = Date.now() - t0;

  const totalOriginalTokens = summaries.reduce((s, x) => s + x.originalTokens, 0);
  const totalSummaryTokens = summaries.reduce((s, x) => s + x.tokens, 0);
  const compression =
    totalOriginalTokens > 0 ? 1 - totalSummaryTokens / totalOriginalTokens : 0;

  const byLanguage = new Map<string, { count: number; original: number; summary: number }>();
  for (const s of summaries) {
    const cur = byLanguage.get(s.language) ?? { count: 0, original: 0, summary: 0 };
    cur.count += 1;
    cur.original += s.originalTokens;
    cur.summary += s.tokens;
    byLanguage.set(s.language, cur);
  }

  process.stderr.write("\n=== Codebase index ===\n");
  process.stderr.write(`Files indexed:       ${summaries.length}\n`);
  process.stderr.write(`Cache hits / misses: ${cacheHits} / ${cacheMisses}\n`);
  process.stderr.write(`Elapsed:             ${elapsedMs}ms\n`);
  process.stderr.write(`Original tokens:     ${totalOriginalTokens.toLocaleString()} (~${fmtBytes(totalOriginalTokens * 4)})\n`);
  process.stderr.write(`Summary tokens:      ${totalSummaryTokens.toLocaleString()} (~${fmtBytes(totalSummaryTokens * 4)})\n`);
  process.stderr.write(`Compression:         ${(compression * 100).toFixed(1)}%\n`);

  process.stderr.write("\nBy language:\n");
  for (const [lang, v] of [...byLanguage.entries()].sort((a, b) => b[1].original - a[1].original)) {
    const pct = v.original > 0 ? ((1 - v.summary / v.original) * 100).toFixed(1) : "0.0";
    process.stderr.write(
      `  ${lang.padEnd(12)} ${String(v.count).padStart(4)} files  ${String(v.original).padStart(8)}→${String(v.summary).padStart(7)} tok  (${pct}%)\n`,
    );
  }

  if (topN > 0) {
    const top = [...summaries]
      .sort((a, b) => exportSurface(b) - exportSurface(a))
      .slice(0, topN);
    process.stderr.write(`\nTop ${topN} modules by export surface:\n`);
    for (const s of top) {
      process.stderr.write(
        `  ${String(exportSurface(s)).padStart(3)} exports  ${s.path}\n`,
      );
    }
  }

  // Stdout: machine-readable, suitable for piping or saving.
  process.stdout.write(
    JSON.stringify(
      {
        repoRoot,
        subtree: subRel,
        elapsedMs,
        cacheHits,
        cacheMisses,
        totals: {
          files: summaries.length,
          originalTokens: totalOriginalTokens,
          summaryTokens: totalSummaryTokens,
          compression,
        },
      },
      null,
      2,
    ) + "\n",
  );
}

main();
