import { AVAILABLE_MODELS_FALLBACK, type AvailableModel } from "@orca/shared";

// Cached list of models that the server hands out to agents and the web
// UI. Populated by polling Anthropic's `/v1/models` endpoint; until the
// first poll succeeds (or if it keeps failing) we fall back to the
// hard-coded list in @orca/shared so the dropdown is never empty.
//
// The refresh loop is started from `index.ts` once per server boot.

let cached: readonly AvailableModel[] = AVAILABLE_MODELS_FALLBACK;
let lastFetchedAt: Date | null = null;
let lastError: string | null = null;

const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_API_VERSION = "2023-06-01";

// Default refresh cadence: once an hour. Override via
// ORCA_MODELS_REFRESH_INTERVAL_MS for tests.
const DEFAULT_REFRESH_MS = 60 * 60 * 1000;

interface AnthropicModelsResponse {
  data: Array<{ id: string; display_name?: string; type?: string }>;
  has_more?: boolean;
}

export function getAvailableModels(): readonly AvailableModel[] {
  return cached;
}

export function getAvailableModelsStatus(): {
  count: number;
  lastFetchedAt: string | null;
  lastError: string | null;
} {
  return {
    count: cached.length,
    lastFetchedAt: lastFetchedAt?.toISOString() ?? null,
    lastError,
  };
}

export async function refreshAvailableModels(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    lastError = "ANTHROPIC_API_KEY not set; using fallback model list";
    return;
  }

  try {
    // Anthropic paginates; ask for the max page size, then page until done.
    const all: AvailableModel[] = [];
    let url = `${ANTHROPIC_MODELS_URL}?limit=1000`;
    // Cap pages defensively so a bad response can't spin forever.
    for (let i = 0; i < 10; i++) {
      const res = await fetch(url, {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_API_VERSION,
        },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const body = (await res.json()) as AnthropicModelsResponse;
      for (const m of body.data ?? []) {
        if (!m.id.startsWith("claude-")) continue;
        all.push({ id: m.id, displayName: m.display_name ?? m.id });
      }
      if (!body.has_more) break;
      const last = body.data[body.data.length - 1];
      if (!last) break;
      url = `${ANTHROPIC_MODELS_URL}?limit=1000&after_id=${encodeURIComponent(last.id)}`;
    }
    if (all.length === 0) {
      throw new Error("Anthropic returned zero models");
    }
    cached = sortByFamilyThenVersion(all);
    lastFetchedAt = new Date();
    lastError = null;
    console.log(`[orca/models] refreshed ${cached.length} models from Anthropic`);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    console.warn(`[orca/models] refresh failed (${lastError}); keeping ${cached.length} cached entries`);
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
  // Don't keep the event loop alive just for the refresh tick.
  handle.unref?.();
  return () => clearInterval(handle);
}

// Opus before Sonnet before Haiku (most-capable first), then newer versions
// first inside each family. The Anthropic endpoint's natural order is
// reverse-chronological which isn't quite what we want for the UI.
function familyRank(id: string): number {
  if (id.includes("opus")) return 0;
  if (id.includes("sonnet")) return 1;
  if (id.includes("haiku")) return 2;
  return 3;
}

function sortByFamilyThenVersion(
  models: AvailableModel[],
): readonly AvailableModel[] {
  return [...models].sort((a, b) => {
    const fa = familyRank(a.id);
    const fb = familyRank(b.id);
    if (fa !== fb) return fa - fb;
    // Within a family, lexicographic descending lands newer versions first
    // because Anthropic's ids are `claude-<family>-<major>-<minor>[-<date>]`.
    return b.id.localeCompare(a.id);
  });
}

export function familyOf(id: string): "opus" | "sonnet" | "haiku" | "unknown" {
  if (id.includes("opus")) return "opus";
  if (id.includes("sonnet")) return "sonnet";
  if (id.includes("haiku")) return "haiku";
  return "unknown";
}
