import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { schema } from "@orca/db";
import type { OrcaDb } from "@orca/db";
import type { AuditStatus } from "@orca/shared";
import { resolveModelForAgent } from "./model.js";
import { loadPrompt, renderPrompt } from "../services/prompt-loader.js";

/**
 * Audit-row agent — spawns `claude` to verify whether a single recipe's
 * functionality is implemented in the project codebase.
 *
 * The agent reads the recipe spec and uses Read/Grep/Glob tools to
 * inspect the codebase, then returns a structured verdict:
 *   - status: implemented | partially-implemented | not-implemented
 *   - evidence: file:line citations
 *   - summary: one-paragraph explanation
 *
 * The verdict updates the audit row's status, lastAuditedAt, and
 * auditVerdict columns. This is the "real audit" — distinct from the
 * resync operation that only checks whether recipe files have changed.
 */

const RECIPES_DIR = path.resolve(
  process.env.ORCA_RECIPES_DIR ??
    "/Users/davidloschiavo/Documents/Goliath/_recipes",
);

const UNMIGRATED_DIR = path.join(RECIPES_DIR, "_unmigrated");

export interface AuditRowResult {
  status: AuditStatus;
  summary: string;
  evidence: string[];
}

/**
 * Load the full text of a recipe by its concern slug.
 * Checks migrated (`_recipes/<slug>/SKILL.md`) first, then unmigrated.
 */
export async function loadRecipeContent(slug: string): Promise<string | null> {
  // Try migrated first
  const migratedPath = path.join(RECIPES_DIR, slug, "SKILL.md");
  try {
    return await fs.readFile(migratedPath, "utf8");
  } catch {
    // not migrated
  }
  // Try unmigrated
  const unmigratedPath = path.join(UNMIGRATED_DIR, `${slug}.md`);
  try {
    return await fs.readFile(unmigratedPath, "utf8");
  } catch {
    return null;
  }
}


/**
 * Spawn claude to verify a single audit row against the codebase.
 * Updates the row in-place and returns the verdict.
 */
export async function runAuditRowAgent(
  db: OrcaDb,
  rowId: string,
): Promise<AuditRowResult | null> {
  // Load the row + its project
  const [row] = await db
    .select()
    .from(schema.implementationAudit)
    .where(eq(schema.implementationAudit.id, rowId));
  if (!row) return null;

  const [project] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, row.projectId));
  if (!project) return null;

  const recipeContent = await loadRecipeContent(row.concernSlug);
  if (!recipeContent) {
    // No recipe file found — can't audit
    const now = new Date();
    await db
      .update(schema.implementationAudit)
      .set({
        lastAuditedAt: now,
        auditVerdict: "Recipe file not found on disk — cannot verify.",
        updatedAt: now,
      })
      .where(eq(schema.implementationAudit.id, rowId));
    return {
      status: row.status as AuditStatus,
      summary: "Recipe file not found on disk — cannot verify.",
      evidence: [],
    };
  }

  const dbPrompt = await loadPrompt("auditor", "main");
  if (!dbPrompt) throw new Error("[orca] auditor [MAIN] prompt not found at prompts/auditor.md");

  const prompt = renderPrompt(dbPrompt, {
    "recipe.title": row.concernTitle,
    "recipe.slug": row.concernSlug,
    "recipe.content": recipeContent,
  });

  const model = await resolveModelForAgent(db, "auditor");
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (model) env.ANTHROPIC_MODEL = model;

  const child = spawn(
    "claude",
    [
      "-p",
      prompt,
      "--dangerously-skip-permissions",
      "--output-format",
      "json",
    ],
    {
      cwd: project.repoPath,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));

  const exitCode: number | null = await new Promise((resolve) => {
    child.once("close", (c) => resolve(c));
    child.once("error", () => resolve(null));
  });

  const now = new Date();

  if (exitCode !== 0) {
    await db
      .update(schema.implementationAudit)
      .set({
        lastAuditedAt: now,
        auditVerdict: `Audit agent failed (exit ${exitCode ?? "null"}): ${stderr.slice(0, 200)}`,
        updatedAt: now,
      })
      .where(eq(schema.implementationAudit.id, rowId));
    return {
      status: row.status as AuditStatus,
      summary: `Audit agent failed (exit ${exitCode ?? "null"})`,
      evidence: [],
    };
  }

  // Parse the CLI JSON wrapper, then the inner verdict
  let verdict: { status?: string; summary?: string; evidence?: string[] };
  try {
    const wrap = JSON.parse(stdout.trim());
    let text =
      typeof wrap === "string"
        ? wrap
        : typeof (wrap as { result?: unknown }).result === "string"
          ? (wrap as { result: string }).result
          : wrap;
    if (typeof text === "string") {
      text = text
        .replace(/^[\s\S]*?```(?:json)?\s*/, "")
        .replace(/\s*```[\s\S]*$/, "")
        .trim();
      // Try to extract JSON from prose
      if (!safeParsesAsObject(text)) {
        const extracted = extractFirstJsonObject(text);
        if (extracted) text = extracted;
      }
    }
    verdict =
      typeof text === "string"
        ? (JSON.parse(text) as typeof verdict)
        : (text as typeof verdict);
  } catch {
    await db
      .update(schema.implementationAudit)
      .set({
        lastAuditedAt: now,
        auditVerdict: `Audit agent returned unparseable output: ${stdout.slice(0, 300)}`,
        updatedAt: now,
      })
      .where(eq(schema.implementationAudit.id, rowId));
    return {
      status: row.status as AuditStatus,
      summary: "Audit agent returned unparseable output",
      evidence: [],
    };
  }

  // Map the verdict status to our AuditStatus enum
  const validStatuses: AuditStatus[] = [
    "implemented",
    "partially-implemented",
    "not-implemented",
  ];
  const newStatus = validStatuses.includes(verdict.status as AuditStatus)
    ? (verdict.status as AuditStatus)
    : (row.status as AuditStatus);

  const summary = typeof verdict.summary === "string" ? verdict.summary : "";
  const evidence = Array.isArray(verdict.evidence)
    ? verdict.evidence.filter((e): e is string => typeof e === "string")
    : [];

  await db
    .update(schema.implementationAudit)
    .set({
      status: newStatus,
      lastAuditedAt: now,
      lastReviewedAt: now,
      lastReviewedBy: "scrum-master",
      auditVerdict: summary,
      recipeStale: false,
      updatedAt: now,
    })
    .where(eq(schema.implementationAudit.id, rowId));

  const result: AuditRowResult = { status: newStatus, summary, evidence };

  return result;
}

function safeParsesAsObject(s: string): boolean {
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null && !Array.isArray(v);
  } catch {
    return false;
  }
}

function extractFirstJsonObject(text: string): string | null {
  const markerRe = /\{\s*"status"\s*:/;
  const match = markerRe.exec(text);
  if (!match) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = match.index; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(match.index, i + 1);
    }
  }
  return null;
}
