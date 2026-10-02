export function formatElapsed(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h${rm}m` : `${h}h`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}m tok`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k tok`;
  return `${n} tok`;
}

/** Green → yellow → orange → red heatmap based on token count. */
export function tokenHeatColor(n: number): string {
  if (n < 50_000) return "#22c55e";
  if (n < 200_000) return "#eab308";
  if (n < 500_000) return "#f97316";
  return "#ef4444";
}

/**
 * Compact a raw model id for a dense meta line.
 *
 * `claude-opus-4-7[1m]`            → { label: "opus-4-7", variant: "1m" }
 * `claude-sonnet-4-6`             → { label: "sonnet-4-6", variant: null }
 * `claude-haiku-4-5-20251001`    → { label: "haiku-4-5", variant: null }
 * `claude-sonnet-4-6, claude-…`  → { label: "sonnet-4-6 +1", variant: null }
 *
 * The bracketed suffix (e.g. `[1m]`) is the context-window / variant tier the
 * CLI reports — surfaced separately so it reads as a distinct chip. It is NOT
 * a reasoning-effort level; the CLI does not emit one.
 */
export function formatModel(raw: string): { label: string; variant: string | null } {
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const first = ids[0] ?? raw;
  const variantMatch = first.match(/\[([^\]]+)\]/);
  const variant = variantMatch ? variantMatch[1]! : null;
  let label = first
    .replace(/\[[^\]]+\]/, "")
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "");
  if (ids.length > 1) label += ` +${ids.length - 1}`;
  return { label, variant };
}

export function formatBytes(n: unknown): string {
  if (typeof n !== "number" || n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
