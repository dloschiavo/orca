import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { PromptVarResolver } from "./prompt-loader.js";

// Small helpers shared by the PRD/audit dispatch runners. The story path has
// its own inline equivalents; these mirror them for the non-story targets.

export function expandTilde(p: string): string {
  return p.replace(/^~($|\/)/, `${homedir()}$1`);
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function orcaApiUrl(): string {
  return `http://localhost:${process.env.PORT ?? 4455}`;
}

const DIRECTIVES_BASE = join(
  homedir(),
  "Documents",
  "Goliath",
  "orca",
  "recipes",
  "_directives",
);

/**
 * Build `{directive.X}` resolvers for every directive placeholder that appears
 * in the given templates. Each resolves to the directive file's content (or a
 * not-found marker). Only fires for placeholders actually present.
 */
export function buildDirectiveResolvers(
  templates: string[],
): Record<string, PromptVarResolver> {
  const names = new Set<string>();
  for (const t of templates) {
    for (const m of t.matchAll(/\{directive\.([a-zA-Z0-9_-]+)\}/g)) {
      if (m[1]) names.add(m[1]);
    }
  }
  const resolvers: Record<string, PromptVarResolver> = {};
  for (const name of names) {
    const filePath = join(DIRECTIVES_BASE, `${name}.md`);
    resolvers[`directive.${name}`] = async () =>
      readFile(filePath, "utf8").catch(
        () => `(directive "${name}" not found at ${filePath})`,
      );
  }
  return resolvers;
}
