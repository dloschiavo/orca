import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { desc, eq, isNull } from "drizzle-orm";
import { schema } from "@orca/db";
import type { OrcaDb } from "@orca/db";
import type { AgentName } from "@orca/shared";
import { AVAILABLE_MODELS_LIST } from "../agents/model.js";

export type PromptVarResolver = string | (() => string | Promise<string>);
export type PromptKey = "main" | "system";

/**
 * Render a prompt template, resolving only the variables that actually appear
 * in the template text. Pass strings for values already in hand; pass
 * `() => value` (or `async () => value`) for anything that requires a fetch
 * or computation — those functions are only called if the placeholder is
 * present in the template.
 *
 * `models.list` is injected automatically and does not need to be provided
 * by the caller.
 *
 * Unresolved placeholders (no resolver provided) are left as-is so the LLM
 * can see what was expected.
 */
export async function renderPromptLazy(
  template: string,
  resolvers: Record<string, PromptVarResolver>,
): Promise<string> {
  const needed = new Set<string>();
  template.replace(/\{([a-zA-Z0-9_.]+)\}/g, (_, k: string) => {
    needed.add(k);
    return _;
  });

  const allResolvers: Record<string, PromptVarResolver> = {
    "models.list": AVAILABLE_MODELS_LIST,
    ...resolvers,
  };

  const vars: Record<string, string> = {};
  await Promise.all(
    [...needed]
      .filter((k) => k in allResolvers)
      .map(async (k) => {
        const r = allResolvers[k]!;
        vars[k] = typeof r === "function" ? await r() : r;
      }),
  );

  return renderPrompt(template, vars);
}

/**
 * Wrap an async fetch so it runs at most once, even if multiple resolvers
 * depend on the same data source.
 */
export function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let result: Promise<T> | null = null;
  return () => result ?? (result = fn());
}

// ────────────────────────────────────────────────────────────────────
// Prompt files live at <repo-root>/prompts/<agent-name>.md and are
// split into [SYSTEM] and [MAIN] sections. Versioning is git's job —
// there is no DB row, no version number, and no UI for editing them.
// ────────────────────────────────────────────────────────────────────

function findRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir.length > 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "[orca/prompt-loader] could not locate pnpm-workspace.yaml — is the repo layout broken?",
  );
}

const PROMPTS_DIR = resolve(findRepoRoot(), "prompts");

/**
 * Parse a prompt file's body into its [SYSTEM] and [MAIN] sections.
 * Section headers are lines containing exactly `[SYSTEM]` or `[MAIN]`
 * (case-insensitive). Content between two headers (or before the first
 * header / after the last) belongs to the preceding section. A missing
 * or empty section returns null.
 */
export function parsePromptSections(body: string): {
  system: string | null;
  main: string | null;
} {
  const sections: Record<string, string[]> = { SYSTEM: [], MAIN: [] };
  let current: "SYSTEM" | "MAIN" | null = null;
  for (const line of body.split(/\r?\n/)) {
    const m = /^\[(SYSTEM|MAIN)\]\s*$/i.exec(line);
    if (m) {
      current = m[1]!.toUpperCase() as "SYSTEM" | "MAIN";
      continue;
    }
    if (current) sections[current]!.push(line);
  }
  const norm = (lines: string[]): string | null => {
    const text = lines.join("\n").replace(/^\n+|\n+$/g, "");
    return text.length > 0 ? text : null;
  };
  return { system: norm(sections.SYSTEM!), main: norm(sections.MAIN!) };
}

/**
 * Load the prompt text for an agent from `<repo>/prompts/<agentName>.md`.
 * Returns null if the file does not exist or the requested section is
 * absent/empty. Read on every call — files are tiny and the cost is
 * negligible compared to a Claude round-trip, and it lets editors save
 * a file and have the next dispatch pick it up without a server restart.
 */
export async function loadPrompt(
  agentName: AgentName,
  promptKey: PromptKey,
): Promise<string | null> {
  const filePath = join(PROMPTS_DIR, `${agentName}.md`);
  const body = await readFile(filePath, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (body == null) return null;
  const sections = parsePromptSections(body);
  return sections[promptKey];
}

const STORY_SCOPED_VAR_PATTERNS: RegExp[] = [
  /\{story\.[a-zA-Z0-9_.]+\}/,
  /\{files\.[a-zA-Z0-9_.]+\}/,
  /\{project\.[a-zA-Z0-9_.]+\}/,
  /\{change_summary\}/,
  /\{recovery\}/,
  /\{findings\}/,
];

/**
 * Throws if the given system-prompt template contains any placeholder
 * whose value is story- or dispatch-scoped. The system prompt is cached
 * by Claude across `--resume` calls — story-scoped values would silently
 * defeat the cache.
 */
export function assertSystemPromptStable(
  agentName: string,
  template: string,
): void {
  const offenders = new Set<string>();
  for (const pat of STORY_SCOPED_VAR_PATTERNS) {
    const m = template.match(pat);
    if (m) offenders.add(m[0]);
  }
  if (offenders.size > 0) {
    throw new Error(
      `[orca/prompt-loader] agent "${agentName}" system prompt contains story/dispatch-scoped placeholders that would invalidate prompt caching on --resume: ${[
        ...offenders,
      ].join(", ")}. Move these to the [MAIN] section.`,
    );
  }
}

/**
 * Load the AGENTS.md background content for an agent.
 */
export async function loadAgentsMd(
  db: OrcaDb,
  agentName: AgentName,
): Promise<string> {
  const [row] = await db
    .select({ agentsMd: schema.agents.agentsMd })
    .from(schema.agents)
    .where(eq(schema.agents.name, agentName))
    .orderBy(desc(schema.agents.version))
    .limit(1);

  if (!row) {
    throw new Error(`[orca/prompt-loader] agent "${agentName}" does not exist in the DB`);
  }

  return row.agentsMd;
}

/**
 * Replace `{placeholder}` tokens with values. Unmatched placeholders
 * are left as-is so the LLM can see what was expected.
 */
export function renderPrompt(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{([a-zA-Z0-9_.]+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : match,
  );
}

export async function getRegisteredAgentNames(
  db: OrcaDb,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ name: schema.agents.name })
    .from(schema.agents);
  return rows.map((r) => r.name);
}

export async function getRegisteredAgentsWithDescriptions(
  db: OrcaDb,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ name: schema.agents.name, description: schema.agents.description })
    .from(schema.agents)
    .where(isNull(schema.agents.archivedAt));
  return rows.map((r) => `${r.name} — ${r.description}`);
}
