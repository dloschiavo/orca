import { useEffect, useState } from "react";

// Tracks whether the orca backend is reachable. Updated from two sources:
//   1. api.ts `request()` — flips on every successful response, flips off on
//      a network-level throw (TypeError "Failed to fetch" etc.).
//   2. OfflineBanner — polls /health while offline to detect recovery.

let reachable = true;
const listeners = new Set<(v: boolean) => void>();

function emit() {
  for (const l of listeners) l(reachable);
}

export function markServerReachable(): void {
  if (reachable) return;
  reachable = true;
  emit();
}

export function markServerUnreachable(): void {
  if (!reachable) return;
  reachable = false;
  emit();
}

export function isServerReachable(): boolean {
  return reachable;
}

export function useServerReachable(): boolean {
  const [v, setV] = useState(reachable);
  useEffect(() => {
    listeners.add(setV);
    return () => {
      listeners.delete(setV);
    };
  }, []);
  return v;
}

// A thrown fetch error from the browser when the server is unreachable
// presents as `TypeError: Failed to fetch` (Chrome/Edge), `NetworkError when
// attempting to fetch resource.` (Firefox), or `Load failed` (Safari).
export function looksLikeNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message || "";
  return (
    err.name === "TypeError" &&
    (/failed to fetch/i.test(m) ||
      /networkerror/i.test(m) ||
      /load failed/i.test(m) ||
      /network request failed/i.test(m))
  );
}
