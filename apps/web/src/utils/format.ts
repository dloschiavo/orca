/** Compact relative time: "12s", "5m", "3h", "2d". */
export function relTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return "—";
  const s = Math.max(0, Math.floor((Date.now() - d) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function parentFolder(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i >= 0 ? relPath.slice(0, i) : "";
}

/**
 * Every ancestor folder of a file, deepest first. For "web/docs/prd-foo.md"
 * returns ["web/docs", "web"] — so the ignore-folder menu can offer one option
 * per level up the tree (the true ignore is sometimes 2+ folders up).
 */
export function ancestorFolders(relPath: string): string[] {
  const parts = relPath.split("/");
  parts.pop(); // drop the filename
  const out: string[] = [];
  for (let i = parts.length; i > 0; i--) {
    out.push(parts.slice(0, i).join("/"));
  }
  return out;
}

export function baseName(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i >= 0 ? relPath.slice(i + 1) : relPath;
}

// Compact status verb shown in a list row while an agent is processing it.
const AGENT_VERB: Record<string, string> = {
  drafter: "drafting",
  "full-stack-engineer": "building",
  "audit-runner": "auditing",
};
export function agentVerb(agent: string | null | undefined): string {
  return (agent && AGENT_VERB[agent]) || "working";
}

// Break an inline "(a) … (b) … (c) …" enumeration onto bulleted lines so a
// multi-part question/finding detail renders as a scannable list instead of a
// wall of prose. Only single-letter parens match, so "(e.g. …)"/"(2026-06)"
// are untouched.
export function formatQuestionDetails(text: string): string {
  return text.replace(/\s*\(([a-z])\)\s+/gi, (_m, l: string) => `\n- (${l}) `).trim();
}
