/**
 * Lightweight runtime smoke-check for story pages.
 *
 * Two tiers:
 *   1. API check — hits GET /api/stories/:id on the orca backend to verify
 *      the endpoint doesn't 500. This catches DB errors, missing columns,
 *      serialisation bugs, etc.
 *   2. Page check — fetches the story page from the Vite dev server (if
 *      running) and scans the HTML for error indicators. An SPA always
 *      returns 200 for the shell, but React error boundaries, Vite HMR
 *      errors, and unhandled exceptions leave telltale strings in the
 *      response body.
 *
 * Both checks are best-effort: if the dev server isn't running or the
 * fetch times out, the check is skipped (returns pass) so it never blocks
 * QA on infra that isn't available.
 */

const API_PORT = Number(process.env.PORT ?? 4455);
const WEB_PORT = Number(process.env.ORCA_WEB_PORT ?? 5173);
const TIMEOUT_MS = 8_000;

export interface SmokeCheckResult {
  pass: boolean;
  failures: string[];
  /** Whether each sub-check ran (vs was skipped because the server wasn't reachable). */
  ran: { api: boolean; page: boolean };
}

// Error markers we look for in the HTML body of the SPA. These cover:
// - React error overlay (Vite plugin-react)
// - Vite HMR error overlay
// - Next.js error page (in case the stack ever switches)
// - Generic unhandled-error patterns
const PAGE_ERROR_PATTERNS = [
  // Vite / plugin-react error overlay
  /vite-error-overlay/i,
  /plugin-react.*error/i,
  // React internal errors
  /Minified React error/i,
  /Error: Minified/i,
  /application error.*occurred/i,
  // Next.js error page
  /next-error/i,
  /Application error: a (?:client|server)-side exception/i,
  // Generic stack trace in HTML
  /at\s+\w+\s+\(.*:\d+:\d+\)/,
  // Vite module loading failures
  /Failed to fetch dynamically imported module/i,
  /TypeError:.*is not a function/i,
  // orca ErrorToaster renders with this class
  /bg-red-950/,
];

async function fetchWithTimeout(
  url: string,
  ms: number,
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Check that the backend API endpoint for the story returns 200. */
async function checkApi(storyId: string): Promise<{
  ran: boolean;
  pass: boolean;
  detail?: string;
}> {
  const url = `http://localhost:${API_PORT}/api/stories/${storyId}`;
  const res = await fetchWithTimeout(url, TIMEOUT_MS);
  if (!res) {
    // Server unreachable — skip, don't block.
    return { ran: false, pass: true };
  }
  if (res.ok) {
    return { ran: true, pass: true };
  }
  // Non-200 — read the body for the error message.
  let body = "";
  try {
    body = await res.text();
  } catch {
    /* ignore */
  }
  const errorMsg =
    body.length > 300 ? body.slice(0, 300) + "…" : body || "(empty body)";
  return {
    ran: true,
    pass: false,
    detail: `API GET /api/stories/${storyId} returned ${res.status}: ${errorMsg}`,
  };
}

/** Check that the web page loads without visible error indicators. */
async function checkPage(storyId: string): Promise<{
  ran: boolean;
  pass: boolean;
  detail?: string;
}> {
  const url = `http://localhost:${WEB_PORT}/stories/${storyId}`;
  const res = await fetchWithTimeout(url, TIMEOUT_MS);
  if (!res) {
    // Dev server not running — skip.
    return { ran: false, pass: true };
  }
  if (!res.ok) {
    return {
      ran: true,
      pass: false,
      detail: `Page GET ${url} returned HTTP ${res.status}`,
    };
  }
  let html = "";
  try {
    html = await res.text();
  } catch {
    return { ran: true, pass: true }; // Can't read body — skip.
  }

  // Check for error markers in the HTML.
  const matched: string[] = [];
  for (const pattern of PAGE_ERROR_PATTERNS) {
    if (pattern.test(html)) {
      matched.push(pattern.source);
    }
  }
  if (matched.length > 0) {
    return {
      ran: true,
      pass: false,
      detail:
        `Page ${url} loaded (HTTP 200) but HTML contains error indicators: ` +
        matched.join(", ") +
        `. First 500 chars of body: ${html.slice(0, 500)}`,
    };
  }
  return { ran: true, pass: true };
}

/**
 * Run both smoke checks for a story. Returns a combined result.
 *
 * If `changedFiles` doesn't include any web-app files, the page check is
 * skipped (the change can't have broken the UI).
 */
export async function runSmokeCheck(
  storyId: string,
  changedFiles: string[],
): Promise<SmokeCheckResult> {
  const touchesWeb = changedFiles.some(
    (f) =>
      f.startsWith("apps/web/") ||
      f.startsWith("packages/shared/") ||
      f.startsWith("packages/db/"),
  );

  const [apiResult, pageResult] = await Promise.all([
    checkApi(storyId),
    touchesWeb
      ? checkPage(storyId)
      : Promise.resolve({ ran: false, pass: true } as const),
  ]);

  const failures: string[] = [];
  if (!apiResult.pass && apiResult.detail) failures.push(apiResult.detail);
  if (!pageResult.pass && pageResult.detail) failures.push(pageResult.detail);

  return {
    pass: failures.length === 0,
    failures,
    ran: { api: apiResult.ran, page: pageResult.ran },
  };
}
