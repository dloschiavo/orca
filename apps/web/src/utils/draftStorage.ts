// Tiny per-key draft store backed by localStorage. Used by the new-story
// modal and the story comment composer to survive accidental dismissal /
// remount / page reload. Entries older than MAX_AGE_MS are dropped lazily
// on every read so the store can't grow without bound.

const STORAGE_KEY = "orca.drafts.v1";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface Entry<T = unknown> {
  value: T;
  savedAt: number;
}

type Store = Record<string, Entry>;

function readStore(): Store {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function writeStore(store: Store) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    /* quota / disabled — ignore */
  }
}

function sweep(store: Store): Store {
  const cutoff = Date.now() - MAX_AGE_MS;
  let mutated = false;
  for (const k of Object.keys(store)) {
    const e = store[k];
    if (!e || typeof e.savedAt !== "number" || e.savedAt < cutoff) {
      delete store[k];
      mutated = true;
    }
  }
  if (mutated) writeStore(store);
  return store;
}

export function loadDraft<T>(key: string): T | null {
  const store = sweep(readStore());
  const entry = store[key];
  return entry ? (entry.value as T) : null;
}

export function saveDraft<T>(key: string, value: T): void {
  if (value == null || (typeof value === "string" && value.trim() === "")) {
    clearDraft(key);
    return;
  }
  const store = sweep(readStore());
  store[key] = { value, savedAt: Date.now() };
  writeStore(store);
}

export function clearDraft(key: string): void {
  const store = readStore();
  if (!(key in store)) return;
  delete store[key];
  writeStore(store);
}
