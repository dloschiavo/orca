import { useEffect, useState } from "react";
import {
  markServerReachable,
  markServerUnreachable,
  useServerReachable,
} from "../state/serverStatus.js";

// Fixed banner that appears across the top when the orca backend is
// unreachable. Reachability is flipped by api.ts on every successful response
// or network-level throw; this component also actively polls /health while
// offline so recovery is detected without waiting for a user-initiated fetch.
//
// We additionally probe a never-down third party to distinguish three cases:
//   1. user has no internet at all          → "you appear to be offline"
//   2. user online, backend down, dev build → "restart the dev server"
//   3. user online, backend down, prod      → "server unreachable — retrying"

async function probeInternet(signal?: AbortSignal): Promise<boolean> {
  try {
    await fetch("https://www.google.com/generate_204", {
      mode: "no-cors",
      cache: "no-store",
      signal,
    });
    return true;
  } catch {
    return false;
  }
}

export function OfflineBanner() {
  const reachable = useServerReachable();
  const [userOnline, setUserOnline] = useState(true);

  useEffect(() => {
    if (reachable) {
      setUserOnline(true);
      return;
    }
    let cancelled = false;
    const ctrl = new AbortController();

    async function tick() {
      const online = await probeInternet(ctrl.signal);
      if (cancelled) return;
      setUserOnline(online);
      try {
        const r = await fetch("/health", { cache: "no-store", signal: ctrl.signal });
        if (cancelled) return;
        if (r.ok) markServerReachable();
        else markServerUnreachable();
      } catch {
        if (cancelled) return;
        markServerUnreachable();
      }
    }

    const id = setInterval(tick, 2000);
    void tick();
    return () => {
      cancelled = true;
      ctrl.abort();
      clearInterval(id);
    };
  }, [reachable]);

  if (reachable) return null;

  let message: string;
  if (!userOnline) {
    message = "you appear to be offline";
  } else if (import.meta.env.DEV) {
    message = "orca backend unreachable — restart the dev server (port 4455)";
  } else {
    message = "orca server unreachable — retrying…";
  }

  return (
    <div className="offline-banner" role="alert">
      <span className="offline-banner-dot" />
      {message}
    </div>
  );
}
