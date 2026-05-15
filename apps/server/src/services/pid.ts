/** Check whether a process with the given PID is still running. */
export function isPidAlive(pid: number): boolean {
  try {
    // signal 0 doesn't kill — it just checks if the process exists.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
