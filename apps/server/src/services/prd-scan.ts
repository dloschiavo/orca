import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { expandTilde } from "./dispatch-prompt-util.js";

// orca ingests PRDs from ONE place per project: a directory literally named
// "product" sitting at depth 1 or 2 below the project root (`<root>/product`
// or `<root>/<sub>/product`). Everything else in the repo — code, recipes,
// READMEs, prompt templates — is deliberately ignored. This kept far too many
// non-PRD .md files from being sucked in.
const PRODUCT_DIR = "product";

// Hard-coded junk-dir excludes (third-party / build output / caches), on top of
// the user-curated per-project ignore list. Any directory whose name starts
// with "." is also skipped. Applied both when locating the product dir at
// depth 2 and when walking inside it.
const DEFAULT_EXCLUDE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "out",
  "coverage",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".turbo",
  ".vercel",
  "Pods",
  ".expo",
  "fixtures",
]);

const MAX_FILES = 2000;

export interface ScannedPrd {
  relPath: string;
  mtime: Date;
}

/**
 * True when `relPath` (relative to the project root) lives inside a `product/`
 * directory that sits at depth 1 or 2 from the root — i.e. the first or second
 * path segment is exactly "product" and there is a file beneath it. This is the
 * ONLY shape orca treats as an ingestable PRD; it's the single source of truth
 * shared by the disk scan, the heartbeat dispatch gate, and the drafter's
 * sibling-PRD lookup so stale rows from before this rule never get processed.
 */
export function isUnderProductDir(relPath: string): boolean {
  const segs = relPath.split(/[/\\]/).filter(Boolean);
  const idx = segs.indexOf(PRODUCT_DIR);
  return (idx === 0 || idx === 1) && segs.length > idx + 1;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Find every `product` directory at depth 1 (`<root>/product`) or depth 2
 * (`<root>/<sub>/product`). Monorepos can have more than one (e.g.
 * `web/product`, `server/product`); single projects have exactly one.
 */
async function findProductDirs(root: string, ignored: Set<string>): Promise<string[]> {
  const found: string[] = [];
  if (await isDirectory(join(root, PRODUCT_DIR))) found.push(join(root, PRODUCT_DIR));

  let top;
  try {
    top = await readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of top) {
    if (!e.isDirectory()) continue;
    if (e.name === PRODUCT_DIR) continue; // already added at depth 1
    if (DEFAULT_EXCLUDE_DIRS.has(e.name)) continue;
    if (e.name.startsWith(".")) continue;
    if (ignored.has(e.name)) continue;
    const candidate = join(root, e.name, PRODUCT_DIR);
    if (await isDirectory(candidate)) found.push(candidate);
  }
  return found;
}

/**
 * Scan a project for PRD docs, looking ONLY inside its `product/` directory
 * (depth 1 or 2 below the root — see {@link isUnderProductDir}). Walks each
 * product dir for *.md files, skipping junk dirs, dot-dirs, and any folder in
 * `ignoredFolders` (paths relative to the repo root). Returns paths relative to
 * the repo root with each file's mtime. Capped at MAX_FILES.
 */
export async function scanPrdFiles(
  repoPath: string,
  ignoredFolders: string[] = [],
): Promise<ScannedPrd[]> {
  const root = expandTilde(repoPath);
  const ignored = new Set(
    ignoredFolders.map((f) => f.replace(/^\/+|\/+$/g, "")),
  );
  const results: ScannedPrd[] = [];

  async function walk(dir: string): Promise<void> {
    if (results.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= MAX_FILES) return;
      const full = join(dir, e.name);
      const rel = relative(root, full);
      if (e.isDirectory()) {
        if (DEFAULT_EXCLUDE_DIRS.has(e.name)) continue;
        if (e.name.startsWith(".")) continue;
        if (ignored.has(rel)) continue;
        await walk(full);
      } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
        if ([...ignored].some((f) => rel === f || rel.startsWith(`${f}/`))) continue;
        let st;
        try {
          st = await stat(full);
        } catch {
          continue;
        }
        results.push({ relPath: rel, mtime: st.mtime });
      }
    }
  }

  const productDirs = await findProductDirs(root, ignored);
  for (const dir of productDirs) {
    if (results.length >= MAX_FILES) break;
    await walk(dir);
  }
  return results;
}
