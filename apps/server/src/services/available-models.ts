import { execFileSync } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { AVAILABLE_MODELS_FALLBACK, type AvailableModel } from "@orca/shared";

// Source of truth for the model list orca exposes in the dropdown and
// in the `{models.list}` prompt placeholder. We scrape model ids out of
// the Claude Code CLI bundle (`@anthropic-ai/claude-code/cli.js`)
// because orca dispatches via `claude --model <id>`; whatever the CLI
// has baked in is exactly the set that will work. When Claude Code
// auto-updates, the next refresh tick picks up the new lineup with no
// orca code change.
//
// Falls back to `AVAILABLE_MODELS_FALLBACK` if the CLI can't be located
// (e.g. orca is running in a container without claude installed). The
// fallback is intentionally a small set — better to be obviously stale
// than to hand the user a bogus long list.

let cached: readonly AvailableModel[] = AVAILABLE_MODELS_FALLBACK;
let cliPath: string | null = null;
let cliMtimeMs: number | null = null;
let lastFetchedAt: Date | null = null;
let lastError: string | null = null;

const DEFAULT_REFRESH_MS = 60 * 60 * 1000;

// Matches `claude-<family>-<major>-<minor>` and an optional `-YYYYMMDD`
// build suffix. We prefer the undated id (it's the alias that points at
// the latest dated build) and drop dated variants when an undated peer
// is present in the same scan.
const MODEL_ID_RE = /claude-(opus|sonnet|haiku)-(\d+)-(\d+)(-\d{8})?/g;

export function getAvailableModels(): readonly AvailableModel[] {
  return cached;
}

export function getAvailableModelsStatus(): {
  count: number;
  cliPath: string | null;
  lastFetchedAt: string | null;
  lastError: string | null;
} {
  return {
    count: cached.length,
    cliPath,
    lastFetchedAt: lastFetchedAt?.toISOString() ?? null,
    lastError,
  };
}

export async function refreshAvailableModels(): Promise<void> {
  try {
    const path = await locateClaudeCli();
    if (!path) {
      lastError = "could not locate Claude Code CLI; using fallback list";
      return;
    }
    cliPath = path;

    const s = await stat(path);
    if (cliMtimeMs === s.mtimeMs && cached !== AVAILABLE_MODELS_FALLBACK) {
      // Bundle hasn't changed and we already have a real scrape result —
      // skip the re-read.
      lastFetchedAt = new Date();
      lastError = null;
      return;
    }

    const body = await readFile(path, "utf8");
    const found = scrapeModelIds(body);
    if (found.length === 0) {
      throw new Error("no model ids found in CLI bundle");
    }
    cached = found;
    cliMtimeMs = s.mtimeMs;
    lastFetchedAt = new Date();
    lastError = null;
    console.log(`[orca/models] scraped ${cached.length} models from ${path}`);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    console.warn(
      `[orca/models] refresh failed (${lastError}); keeping ${cached.length} cached entries`,
    );
  }
}

export function startAvailableModelsRefresh(
  intervalMs: number = Number(
    process.env.ORCA_MODELS_REFRESH_INTERVAL_MS ?? DEFAULT_REFRESH_MS,
  ),
): () => void {
  void refreshAvailableModels();
  const handle = setInterval(() => {
    void refreshAvailableModels();
  }, intervalMs);
  handle.unref?.();
  return () => clearInterval(handle);
}

async function locateClaudeCli(): Promise<string | null> {
  const override = process.env.ORCA_CLAUDE_CLI_PATH;
  if (override) return override;

  // Walk `which claude` → real binary → containing package root → cli.js.
  // The binary is typically a symlink into the npm global install.
  let binPath: string;
  try {
    binPath = execFileSync("which", ["claude"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
  if (!binPath) return null;

  const real = await tryRealpath(binPath);
  const candidate = real ?? binPath;

  if (candidate.endsWith(".js") && (await fileExists(candidate))) {
    return candidate;
  }

  const here = dirname(candidate);
  const sibling = join(here, "cli.js");
  if (await fileExists(sibling)) return sibling;

  // Walk up looking for package.json that names @anthropic-ai/claude-code.
  let dir = here;
  for (let i = 0; i < 6 && dir.length > 1; i++) {
    const pkg = join(dir, "package.json");
    if (await fileExists(pkg)) {
      try {
        const meta = JSON.parse(await readFile(pkg, "utf8")) as {
          name?: string;
          main?: string;
          bin?: string | Record<string, string>;
        };
        if (meta.name === "@anthropic-ai/claude-code") {
          const entry =
            (typeof meta.bin === "string" ? meta.bin : meta.bin?.claude) ??
            meta.main ??
            "cli.js";
          return resolve(dir, entry);
        }
      } catch {
        // ignore malformed package.json and keep walking
      }
    }
    dir = dirname(dir);
  }
  return null;
}

async function tryRealpath(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function scrapeModelIds(source: string): readonly AvailableModel[] {
  const ids = new Set<string>();
  for (const m of source.matchAll(MODEL_ID_RE)) {
    ids.add(m[0]);
  }
  // Drop the `-YYYYMMDD`-suffixed id when its undated peer is also
  // present (the undated form is the alias).
  const undated = new Set<string>();
  for (const id of ids) {
    if (!/-\d{8}$/.test(id)) undated.add(id);
  }
  const kept: string[] = [];
  for (const id of ids) {
    const dateMatch = /-\d{8}$/.exec(id);
    if (dateMatch && undated.has(id.slice(0, dateMatch.index))) continue;
    kept.push(id);
  }
  return kept.sort(compareModelIds).map((id) => ({ id }));
}

export function familyOf(id: string): "opus" | "sonnet" | "haiku" | "unknown" {
  if (id.includes("opus")) return "opus";
  if (id.includes("sonnet")) return "sonnet";
  if (id.includes("haiku")) return "haiku";
  return "unknown";
}

function familyRank(id: string): number {
  const f = familyOf(id);
  return f === "opus" ? 0 : f === "sonnet" ? 1 : f === "haiku" ? 2 : 3;
}

// Opus → Sonnet → Haiku; within a family, newer version first.
function compareModelIds(a: string, b: string): number {
  const fa = familyRank(a);
  const fb = familyRank(b);
  if (fa !== fb) return fa - fb;
  const [majA, minA] = versionTuple(a);
  const [majB, minB] = versionTuple(b);
  if (majA !== majB) return majB - majA;
  if (minA !== minB) return minB - minA;
  return a.localeCompare(b);
}

function versionTuple(id: string): [number, number] {
  const m = /-(\d+)-(\d+)(?:-\d{8})?$/.exec(id);
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}
