import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  deleteSummaryFile,
  getFileSha,
  getFileShas,
  readIndex,
  readSummaryFile,
  shaToCachePath,
  writeIndex,
  writeSummaryFile,
} from "./cache.js";
import { summarizeContent } from "./summarize.js";
import type { FileSummary } from "./types.js";

export type { FileSummary, SummaryDecl, SummaryFunction, SummaryLanguage } from "./types.js";
export { detectLanguage } from "./summarize.js";
export { CACHE_ROOT_REL } from "./cache.js";

function readContent(repoRoot: string, relFile: string): string {
  return readFileSync(join(repoRoot, relFile), "utf-8");
}

/** Compute a fresh summary, ignoring any cached entry. */
export function summarizeFile(repoRoot: string, relFile: string): FileSummary {
  const sha = getFileSha(repoRoot, relFile);
  const content = readContent(repoRoot, relFile);
  return summarizeContent(content, relFile, sha);
}

export interface GetOrComputeResult {
  summary: FileSummary;
  cached: boolean;
}

/** Return cached summary if git blob SHA matches; otherwise compute and cache. */
export function getOrCompute(repoRoot: string, relFile: string): GetOrComputeResult {
  const sha = getFileSha(repoRoot, relFile);
  const index = readIndex(repoRoot);
  const entry = index[relFile];

  if (entry && entry.sha === sha) {
    const cached = readSummaryFile(repoRoot, entry.cacheFile);
    if (cached) return { summary: cached, cached: true };
  }

  const content = readContent(repoRoot, relFile);
  const summary = summarizeContent(content, relFile, sha);
  const cacheFile = shaToCachePath(sha, relFile);
  writeSummaryFile(repoRoot, cacheFile, summary);
  index[relFile] = { sha, cacheFile };
  writeIndex(repoRoot, index);
  return { summary, cached: false };
}

export interface SummarizeFilesResult {
  summaries: FileSummary[];
  cacheHits: number;
  cacheMisses: number;
}

/** Get-or-compute over a batch of files. Writes the index once at the end. */
export function summarizeFiles(repoRoot: string, relFiles: string[]): SummarizeFilesResult {
  const index = readIndex(repoRoot);
  const shas = getFileShas(repoRoot, relFiles);
  const summaries: FileSummary[] = [];
  let cacheHits = 0;
  let cacheMisses = 0;

  for (const relFile of relFiles) {
    const sha = shas.get(relFile) ?? "unknown";
    const entry = index[relFile];
    if (entry && entry.sha === sha) {
      const cached = readSummaryFile(repoRoot, entry.cacheFile);
      if (cached) {
        summaries.push(cached);
        cacheHits += 1;
        continue;
      }
    }
    let content: string;
    try {
      content = readContent(repoRoot, relFile);
    } catch {
      cacheMisses += 1;
      continue;
    }
    const summary = summarizeContent(content, relFile, sha);
    const cacheFile = shaToCachePath(sha, relFile);
    writeSummaryFile(repoRoot, cacheFile, summary);
    index[relFile] = { sha, cacheFile };
    summaries.push(summary);
    cacheMisses += 1;
  }

  writeIndex(repoRoot, index);
  return { summaries, cacheHits, cacheMisses };
}

/** Drop a file's cache entry. Call after a worker writes to a file. */
export function invalidate(repoRoot: string, relFile: string): void {
  const index = readIndex(repoRoot);
  const entry = index[relFile];
  if (!entry) return;
  deleteSummaryFile(repoRoot, entry.cacheFile);
  delete index[relFile];
  writeIndex(repoRoot, index);
}
