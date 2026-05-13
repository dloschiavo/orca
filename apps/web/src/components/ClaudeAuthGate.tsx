import { useEffect, useState } from "react";

interface HealthResponse {
  claudeLoggedIn: boolean;
}

export function ClaudeAuthGate({ children }: { children: React.ReactNode }) {
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const res = await fetch("/health");
        if (!res.ok) return;
        const data: HealthResponse = await res.json();
        if (!cancelled) setLoggedIn(data.claudeLoggedIn);
      } catch {
        // Server unreachable — don't change shown state
      }
    }

    check();
    const interval = setInterval(check, 10_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <>
      {loggedIn === false && (
        <div className="fixed top-0 left-0 right-0 z-50 bg-red-900/95 border-b-2 border-red-500 px-4 py-3 flex items-center gap-4 shadow-lg">
          <span className="text-xl shrink-0">⚠️</span>
          <div className="flex-1 min-w-0">
            <span className="font-semibold text-red-200">Claude Code not logged in — agents will fail. </span>
            <span className="text-red-300 text-sm">
              Run{" "}
              <code className="bg-red-950 text-yellow-300 px-1.5 py-0.5 rounded font-mono text-xs">claude auth login</code>
              {" "}or set{" "}
              <code className="bg-red-950 text-yellow-300 px-1.5 py-0.5 rounded font-mono text-xs">ANTHROPIC_API_KEY</code>
              , then restart the server.
            </span>
          </div>
          <button
            className="shrink-0 text-red-300 hover:text-white text-sm underline"
            onClick={() => window.location.reload()}
          >
            Recheck
          </button>
        </div>
      )}
      {loggedIn === false ? <div className="pt-[52px] flex h-full w-full flex-col">{children}</div> : <>{children}</>}
    </>
  );
}
