---
name: connectivity-banner
description: >
  Use when the app makes API calls to its own backend and you want to surface
  network failures as a banner instead of toast spam. Covers the three-state
  diagnosis (user offline vs backend down vs backend down in dev), the
  external probe that distinguishes them, the centralized reachability flag
  fed by every API call, and the toast-suppression rule.
---

# Connectivity Banner

A single red bar across the top of the app that tells the user *which* thing
is broken: their internet, the backend, or the backend in a way they can fix.
The key insight is that a two-state design ("server up / server down") sends
the user to debug the wrong layer half the time — when their wifi drops, the
app says "server unreachable" and they reload, blame the backend, file a bug.
Three states with one external probe fixes this for the cost of one
no-cors fetch per poll while offline.

Reference implementation: `orca/apps/web/src/` —
[`state/serverStatus.ts`](../../apps/web/src/state/serverStatus.ts),
[`components/OfflineBanner.tsx`](../../apps/web/src/components/OfflineBanner.tsx),
[`api.ts`](../../apps/web/src/api.ts),
[`main.tsx`](../../apps/web/src/main.tsx).

## State model

Three displayable states. Each maps to one message:

| Internet probe | Backend `/health` | `import.meta.env.DEV` | Banner shown |
|---|---|---|---|
| ok    | ok       | —     | (hidden) |
| fails | (skip)   | —     | `you appear to be offline` |
| ok    | fails    | true  | `<app> backend unreachable — restart the dev server (port N)` |
| ok    | fails    | false | `<app> server unreachable — retrying…` |

The backend probe is skipped when the internet probe fails — there's no point
asking "is the server up" when you can't reach anything.

## The reachability flag — one source of truth

```ts
// state/serverStatus.ts
let reachable = true;
const listeners = new Set<(v: boolean) => void>();

export function markServerReachable(): void { /* flip true + emit */ }
export function markServerUnreachable(): void { /* flip false + emit */ }
export function useServerReachable(): boolean { /* subscribe */ }

export function looksLikeNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message || "";
  return err.name === "TypeError" && (
    /failed to fetch/i.test(m) ||      // Chrome / Edge
    /networkerror/i.test(m) ||          // Firefox
    /load failed/i.test(m) ||           // Safari
    /network request failed/i.test(m)   // RN-ish hosts
  );
}
```

Two writers feed this flag:

1. **The API client wrapper** — every successful `fetch()` calls
   `markServerReachable()`, every thrown `fetch()` calls
   `markServerUnreachable()`. This is the fast path: the banner appears the
   instant any user action hits the dead backend, not after the next health
   tick.
2. **The banner's own poll** — while offline, polls `/health` every 2s so
   recovery is detected without waiting for the user to click something.

When reachable, the banner does no polling at all. Regular API traffic keeps
the flag fresh; an idle tab on a healthy app should make zero extra requests.

## The API wrapper

```ts
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`/api${path}`, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  } catch (err) {
    markServerUnreachable();   // network-level throw — TypeError, etc.
    throw err;
  }
  markServerReachable();        // got bytes back, even if 4xx/5xx
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${await r.text()}`);
  return await r.json() as T;
}
```

A 4xx/5xx is *not* unreachable — the server replied. Only mark unreachable on
a thrown `fetch()` (the network-level failure modes `looksLikeNetworkError`
detects). This keeps the banner from misfiring on a 500 caused by a bug.

## The banner component

```tsx
async function probeInternet(signal?: AbortSignal): Promise<boolean> {
  try {
    await fetch("https://www.google.com/generate_204", {
      mode: "no-cors", cache: "no-store", signal,
    });
    return true;
  } catch { return false; }
}

export function OfflineBanner() {
  const reachable = useServerReachable();
  const [userOnline, setUserOnline] = useState(true);

  useEffect(() => {
    if (reachable) { setUserOnline(true); return; }
    let cancelled = false;
    const ctrl = new AbortController();
    async function tick() {
      const online = await probeInternet(ctrl.signal);
      if (cancelled) return;
      setUserOnline(online);
      try {
        const r = await fetch("/health", { cache: "no-store", signal: ctrl.signal });
        if (cancelled) return;
        r.ok ? markServerReachable() : markServerUnreachable();
      } catch { if (!cancelled) markServerUnreachable(); }
    }
    const id = setInterval(tick, 2000);
    void tick();
    return () => { cancelled = true; ctrl.abort(); clearInterval(id); };
  }, [reachable]);

  if (reachable) return null;
  const message = !userOnline ? "you appear to be offline"
    : import.meta.env.DEV ? "orca backend unreachable — restart the dev server (port 4455)"
    : "orca server unreachable — retrying…";
  return <div className="offline-banner" role="alert"><span className="offline-banner-dot" />{message}</div>;
}
```

### The external probe — `generate_204` over no-cors

`https://www.google.com/generate_204` returns 204 with an empty body. It's
what Chrome itself uses for connectivity checks, so it's tuned for
availability and low latency. With `mode: 'no-cors'` the browser returns an
opaque response — you can't read the status, but **a resolved promise means
the network attempt completed**. Reject means DNS/transport failure, which
is what "offline" feels like in practice. Captive portals usually intercept
this request to a redirect, which still resolves — so captive-portal users
will be told the server is unreachable, not that they're offline. That's
fine: they can't reach the server through the portal either.

## Mount above the auth gate

```tsx
export function App() {
  return (
    <ProjectProvider>
      <OfflineBanner />          {/* above the gate — see Anti-Patterns */}
      <AuthGate>
        <ErrorToaster />
        <AppShell />
      </AuthGate>
    </ProjectProvider>
  );
}
```

The auth gate typically opens with a `/health`-style bootstrap call. If the
backend is down, that call hangs or fails and the gate renders a spinner or
nothing. The banner has to be outside the gate so the user gets an
explanation instead of staring at a blank screen.

## Suppress redundant toasts during outages

Most apps surface every query/mutation error as a toast. When the backend is
down, that's one toast *per scheduled refetch* — dozens stacked over the
banner inside a minute, all saying "Failed to fetch". Filter them out:

```ts
function reportError(err: unknown) {
  if (looksLikeNetworkError(err)) return;   // banner already covers it
  pushErrorToast(err instanceof Error ? err.message : String(err));
}
const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: reportError }),
  mutationCache: new MutationCache({ onError: reportError }),
  /* … */
});
```

A non-network error (500, 422, etc.) still produces a toast — those are real
server-side bugs, not connectivity, and the banner doesn't cover them.

## Styling

Fixed strip at `top: 0`, `z-index` high enough to clear app chrome
(orca uses 200), centered text + pulsing dot. Red is `--attn-error` in
orca's token system (oklch 0.65 0.15 25). Width: `100vw`. Height: ~28px so
it doesn't dominate.

```css
.offline-banner {
  position: fixed; top: 0; left: 0; right: 0;
  z-index: 200;
  display: flex; align-items: center; justify-content: center; gap: 10px;
  height: 28px;
  background: var(--attn-error);
  color: #fff;
  font-size: 12.5px; font-weight: 500;
}
.offline-banner-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #fff;
  animation: pulse-opacity 1.6s ease-in-out infinite;
}
```

The pulsing dot is load-bearing: it signals "we're actively retrying" rather
than a static error. Without it users assume the banner is stale.

## Fit-to-Project

- **Build tool dev flag?** Vite exposes `import.meta.env.DEV`. Webpack/CRA
  uses `process.env.NODE_ENV === "development"`. Next.js: same. Pick the
  one your tooling guarantees is statically replaced.
- **What's the backend health URL?** Default to `/health`. If your backend
  is gated behind auth, expose an unauthenticated `/health` — the banner
  must work before login.
- **Is the dev server port stable?** If yes, hard-code it in the dev
  message (`port 4455`). If you have multi-service dev (web + api + worker),
  name the service instead (`restart the api server`).
- **State store?** The reference uses a 30-line pub/sub. If you're already on
  Zustand/Jotai/Redux, put it there instead — don't introduce a second store
  primitive for one flag.
- **Probe endpoint?** `generate_204` works everywhere except cn. For
  China-facing apps swap to `https://cp.cloudflare.com/` or
  `https://www.baidu.com/`. The contract is "no-cors-fetchable URL that
  virtually never goes down."
- **Polling interval while offline?** 2s is responsive without being
  abusive. Don't go below 1s (you'll fire two probes per visible animation
  frame on slow networks). Don't go above 5s (users notice).

## Anti-Patterns

- **Two-state design ("server up / server down")** — misdiagnoses every
  wifi-drop and captive-portal case as a backend outage. Three states is
  the whole point of this skill.
- **Pinging your own backend to determine if the user is online** — circular.
  If the server is down, you can't tell whether the user has internet at all.
  The external probe is the only way to disambiguate.
- **`navigator.onLine` as the source of truth** — returns `true` on captive
  portals, returns `false` only when the OS NIC is fully down. Useful as a
  hint, not as a decision. Stick with the fetch probe.
- **CORS-strict probe** — fetching the probe URL without `mode: 'no-cors'`
  throws on CORS preflight and every probe falsely reports offline. The
  contract is "did the network attempt complete," which only no-cors gives
  you.
- **Polling /health forever, even when reachable** — wastes bandwidth, fills
  server logs. Poll only while the banner is up; regular API calls keep the
  flag fresh otherwise.
- **Banner inside the auth gate** — if the gate's bootstrap fetch is the
  call that fails, the user sees a blank page with no explanation. The
  banner must be a sibling above the gate.
- **Toast spam during outage** — every scheduled refetch fires another
  "Failed to fetch" toast on top of the banner. Filter network errors out of
  the global error handler; the banner is the one display surface for them.
- **Telling production users to restart the server** — the dev-only message
  must gate on the build-time DEV flag. A user on a hosted app has no shell;
  showing them `pnpm dev` is noise.
- **No AbortController on the poll** — leaving the 2s interval running
  across unmounts (route changes, HMR) leaks intervals and races state
  updates. Abort on cleanup.
- **Probe without a per-attempt timeout** — on a flaky network, `fetch()` to
  the probe URL can hang for tens of seconds. The shared AbortController in
  the example caps this implicitly via unmount; for long-lived apps add a
  3s `setTimeout(() => ctrl.abort())` per tick.
- **Marking unreachable on a 4xx/5xx response** — the server *replied*. The
  banner is for network-level failures only; a 500 is a separate bug and
  belongs in the toast/log path.

## Logging

The banner itself shouldn't log — it's a UI surface, and an outage is by
definition a moment when logging-to-server doesn't work. But the upstream
state-flips are worth one `console.warn` each:

```ts
export function markServerUnreachable(): void {
  if (!reachable) return;
  reachable = false;
  console.warn("[connectivity] server marked unreachable");
  emit();
}
```

…so the user can correlate the banner with whatever they were doing in
DevTools at the moment it appeared. Skip the recovery log — it fires every
time the banner closes, and the absence of "unreachable" warnings is the
recovery signal.
