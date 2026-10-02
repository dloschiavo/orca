import { spawn } from "node:child_process";

// Pure, cwd-scoped git/file helpers shared by every dispatch runner
// (runClaudeDispatch for stories, runCliDispatch for PRDs/audits). Moved out
// of routes/stories.ts so there is a single source of truth — the changed-file
// listing and the diff-capture fallback chain are identical across targets.

/**
 * List every file under `cwd` modified after `marker`'s mtime, excluding the
 * usual junk dirs. Used to surface "what did the agent touch" without relying
 * on git (works in non-git workspaces too). Capped at 500 entries.
 */
export async function listChangedFiles(
  cwd: string,
  marker: string,
): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawn(
      "find",
      [
        ".",
        "-type",
        "f",
        "-newer",
        marker,
        "-not",
        "-path",
        "*/node_modules/*",
        "-not",
        "-path",
        "*/.git/*",
        "-not",
        "-path",
        "*/dist/*",
        "-not",
        "-path",
        "*/.next/*",
        "-not",
        "-path",
        "*/build/*",
        "-not",
        "-path",
        "*/logs/*",
        "-not",
        "-name",
        "*.log",
        "-not",
        "-name",
        ".env",
        "-not",
        "-name",
        ".env.*",
      ],
      { cwd },
    );
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString("utf8")));
    child.on("close", () => {
      const files = out
        .split("\n")
        .map((f) => f.replace(/^\.\//, "").trim())
        .filter(Boolean)
        .slice(0, 500);
      resolve(files);
    });
    child.on("error", () => resolve([]));
  });
}

/**
 * Snapshot the current working-tree state by creating a temporary stash
 * commit (git stash create). This does NOT modify the working directory or
 * index — it only creates a dangling commit object we can diff against
 * later. Returns the commit SHA, or null if there are no uncommitted
 * changes or this isn't a git repo.
 */
export async function snapshotWorkingTree(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("git", ["stash", "create"], { cwd });
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString("utf8")));
    child.on("close", (code) => {
      const sha = out.trim();
      resolve(code === 0 && sha.length > 0 ? sha : null);
    });
    child.on("error", () => resolve(null));
  });
}

/**
 * Capture a git diff for this dispatch session. When `baseRef` is provided
 * (a stash commit from before the agent ran), we diff that commit against
 * the current working tree so we capture only the changes the agent made
 * in this session, not the accumulated changes from prior runs. Falls back
 * to `git diff HEAD` when no baseline is available (first run, or non-git
 * directory).
 */
export async function captureGitDiff(
  cwd: string,
  baseRef?: string | null,
): Promise<string> {
  return new Promise((resolve) => {
    const args = baseRef
      ? ["diff", baseRef, "--no-color"]
      : ["diff", "HEAD", "--no-color"];
    const child = spawn("git", args, { cwd });
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString("utf8")));
    child.on("close", (code) => resolve(code === 0 ? out : ""));
    child.on("error", () => resolve(""));
  });
}

/** Return the current HEAD commit SHA, or null if not a git repo. */
export async function getHeadSha(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("git", ["rev-parse", "HEAD"], { cwd });
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString("utf8")));
    child.on("close", (code) => {
      const sha = out.trim();
      resolve(code === 0 && sha.length > 0 ? sha : null);
    });
    child.on("error", () => resolve(null));
  });
}

/** Diff committed changes between two refs (e.g. pre-dispatch HEAD vs current HEAD). */
export async function captureCommittedDiff(
  cwd: string,
  fromRef: string,
): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("git", ["diff", fromRef, "HEAD", "--no-color"], { cwd });
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString("utf8")));
    child.on("close", (code) => resolve(code === 0 ? out : ""));
    child.on("error", () => resolve(""));
  });
}

/**
 * Generate synthetic diffs for repos with no commits by diffing /dev/null
 * against each file. This produces standard unified diff output so
 * parseDiffStats in the frontend can extract line counts.
 */
export async function synthDiffForNewFiles(
  cwd: string,
  files: string[],
): Promise<string> {
  const parts: string[] = [];
  for (const f of files) {
    const d = await new Promise<string>((resolve) => {
      const child = spawn(
        "git",
        ["diff", "--no-index", "--no-color", "/dev/null", f],
        { cwd },
      );
      let out = "";
      child.stdout.on("data", (c) => (out += c.toString("utf8")));
      child.on("close", () => resolve(out));
      child.on("error", () => resolve(""));
    });
    if (d) parts.push(d);
  }
  return parts.join("\n");
}
