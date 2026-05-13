import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CacheIndex, FileSummary } from "./types.js";

export const CACHE_ROOT_REL = ".data/codebase-index";
const INDEX_FILE = "index.json";

export function cacheRoot(repoRoot: string): string {
  return join(repoRoot, CACHE_ROOT_REL);
}

function indexPath(repoRoot: string): string {
  return join(cacheRoot(repoRoot), INDEX_FILE);
}

export function readIndex(repoRoot: string): CacheIndex {
  const p = indexPath(repoRoot);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as CacheIndex;
  } catch {
    return {};
  }
}

export function writeIndex(repoRoot: string, index: CacheIndex): void {
  const p = indexPath(repoRoot);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(index, null, 2));
}

/**
 * Git blob SHA of a file's *working-tree content* (not the committed version).
 * Falls back to mtime+size if git is unavailable or the file isn't tracked.
 */
export function getFileSha(repoRoot: string, relFile: string): string {
  const abs = join(repoRoot, relFile);
  try {
    return execFileSync("git", ["hash-object", abs], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    try {
      const s = statSync(abs);
      return `mtime-${s.mtimeMs}-${s.size}`;
    } catch {
      return "unknown";
    }
  }
}

function mtimeShaFallback(repoRoot: string, relFile: string): string {
  try {
    const s = statSync(join(repoRoot, relFile));
    return `mtime-${s.mtimeMs}-${s.size}`;
  } catch {
    return "unknown";
  }
}

/**
 * Batch variant of `getFileSha`. One `git hash-object` invocation for the
 * whole list — orders of magnitude faster than per-file forks.
 */
export function getFileShas(repoRoot: string, relFiles: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (relFiles.length === 0) return out;

  try {
    const abs = relFiles.map((f) => join(repoRoot, f));
    const stdout = execFileSync("git", ["hash-object", "--", ...abs], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    }).toString();
    const lines = stdout.split("\n").filter((l) => l.length > 0);
    if (lines.length === relFiles.length) {
      for (let i = 0; i < relFiles.length; i++) {
        const f = relFiles[i];
        const sha = lines[i];
        if (f && sha) out.set(f, sha);
      }
      return out;
    }
    // Length mismatch — fall through to per-file fallback below.
  } catch {
    // git not available, or non-zero exit (e.g. file missing) — fallback.
  }

  for (const f of relFiles) {
    out.set(f, mtimeShaFallback(repoRoot, f));
  }
  return out;
}

function slugify(relFile: string): string {
  return relFile.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

export function shaToCachePath(sha: string, relFile: string): string {
  const prefix = sha.slice(0, 2) || "xx";
  const rest = sha.slice(2) || sha;
  return join(prefix, `${rest}-${slugify(relFile)}.summary.json`);
}

export function readSummaryFile(repoRoot: string, cacheFile: string): FileSummary | null {
  const p = join(cacheRoot(repoRoot), cacheFile);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as FileSummary;
  } catch {
    return null;
  }
}

export function writeSummaryFile(repoRoot: string, cacheFile: string, summary: FileSummary): void {
  const p = join(cacheRoot(repoRoot), cacheFile);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(summary, null, 2));
}

export function deleteSummaryFile(repoRoot: string, cacheFile: string): void {
  const p = join(cacheRoot(repoRoot), cacheFile);
  if (!existsSync(p)) return;
  try {
    unlinkSync(p);
  } catch {
    // ignore
  }
}
