import { writeFile, rename } from "node:fs/promises";

// Serialize read-modify-write file ops per absolute path. PRD writes come from
// two orca-side paths that must not interleave: the answer route (read →
// setPrdAnswer → write) and the drafter's post-run answer merge. Without this
// they race and lose updates — and the UI can fire a *burst* of answer writes at
// once (every dirty question card flushes its draft on unmount when the drafter
// re-parses the doc). Keyed by abs path; the map holds at most one (resolved)
// promise per path. This only orders orca's own writes — the agent's Write tool
// runs in a separate process, which is why the merge runs strictly after the
// agent exits, never concurrently with it.
const fileWriteLocks = new Map<string, Promise<void>>();

export async function withFileWriteLock<T>(
  abs: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = fileWriteLocks.get(abs) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  fileWriteLocks.set(
    abs,
    prev.then(() => gate),
  );
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

// Write all-or-nothing: a reader (UI poll, heartbeat parse, the agent's next
// read) never observes a half-written file. Write to a sibling temp file, then
// atomically rename over the target. Always call inside withFileWriteLock so two
// writers don't collide on the same temp path.
export async function atomicWriteFile(abs: string, content: string): Promise<void> {
  const tmp = `${abs}.orca-tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, abs);
}
