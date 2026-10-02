import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { schema } from "@orca/db";
import type { OrcaDb } from "@orca/db";
import type { CliDispatchState, AuditScheduleKind } from "@orca/shared";
import { runCliDispatch } from "./cli-dispatch.js";
import {
  loadPrompt,
  renderPromptLazy,
  PROMPTS_DIR,
} from "./prompt-loader.js";
import { resolveModelForAgent, resolveMaxTurnsForAgent } from "../agents/model.js";
import {
  buildDirectiveResolvers,
  orcaApiUrl,
  expandTilde,
  sha256,
} from "./dispatch-prompt-util.js";

export type AuditDispatchMode = "run" | "fix";

export function auditPromptPath(slug: string): string {
  return join(PROMPTS_DIR, "audits", `${slug}.md`);
}

/** Next scheduled run after `from`, or null for manual / unparseable. */
export function computeNextRunAt(
  kind: AuditScheduleKind,
  time: string | null,
  days: number[],
  from: Date = new Date(),
): Date | null {
  if (kind === "manual" || !time) return null;
  const [hh, mm] = time.split(":").map((n) => Number(n));
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
  if (kind === "daily") {
    const next = new Date(from);
    next.setHours(hh, mm, 0, 0);
    if (next <= from) next.setDate(next.getDate() + 1);
    return next;
  }
  // weekly
  const set = new Set((days && days.length ? days : [1]).map((d) => Number(d)));
  for (let i = 0; i < 8; i++) {
    const cand = new Date(from);
    cand.setDate(from.getDate() + i);
    cand.setHours(hh, mm, 0, 0);
    if (set.has(cand.getDay()) && cand > from) return cand;
  }
  return null;
}

// Render the SINGLE next open fail for full-stack-engineer — one at a time so
// the agent keeps a tight context; the heartbeat re-dispatches for the next.
function renderOpenFails(
  fails: { id: string; title: string; detail: string; proposedFix: string | null }[],
): string {
  if (fails.length === 0) return "(no open fails)";
  const f = fails[0]!;
  let s = `- [${f.id}] ${f.title}`;
  if (f.detail) s += `\n  ${f.detail.replace(/\n/g, "\n  ")}`;
  if (f.proposedFix) s += `\n  proposed fix: ${f.proposedFix}`;
  const more = fails.length - 1;
  if (more > 0) {
    s += `\n\n(${more} more open fail${more === 1 ? "" : "s"} remain — fixed one at a time after this one.)`;
  }
  return s;
}

/**
 * Run an audit (mode "run": execute the flat-file audit prompt, which POSTs
 * findings via the orca API) or fix its open fails (mode "fix": full-stack-
 * engineer). Both go through the shared runCliDispatch core. On a completed
 * run, stamp lastRunAt and recompute nextRunAt from the schedule.
 */
export async function runAuditDispatch(opts: {
  db: OrcaDb;
  auditCheckId: string;
  mode: AuditDispatchMode;
  trigger?: string;
  adoptExistingPid?: { pid: number; state: CliDispatchState };
}): Promise<void> {
  const { db, auditCheckId, mode } = opts;
  const [check] = await db
    .select()
    .from(schema.auditChecks)
    .where(eq(schema.auditChecks.id, auditCheckId));
  if (!check) return;
  const [project] = await db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, check.projectId));
  if (!project) return;

  const repoPath = expandTilde(project.repoPath);
  const agentName = mode === "fix" ? "full-stack-engineer" : "audit-runner";

  let prompt = "";
  let systemPrompt: string | null = null;
  let model: string | null = null;
  let maxTurns: number | null = null;
  let systemPromptHash: string | null = null;

  if (!opts.adoptExistingPid) {
    if (mode === "run") {
      // The per-audit flat file holds ONLY audit-specific language. The common
      // machinery (read-only stance, findings contract, sort fail/question)
      // lives in the shared `audit-runner` AGENT prompt; the audit file is
      // injected into it as {audit.prompt}.
      const auditFile = await readFile(auditPromptPath(check.slug), "utf8").catch(
        () => null,
      );
      if (auditFile == null) {
        throw new Error(
          `[orca] audit prompt not found at prompts/audits/${check.slug}.md`,
        );
      }
      const auditSpecific = await renderPromptLazy(auditFile, {
        ...buildDirectiveResolvers([auditFile]),
        "audit.name": check.name,
        "project.name": project.name,
        "project.repo_path": repoPath,
      });

      const mainTpl = await loadPrompt("audit-runner", "main");
      const sysTpl = await loadPrompt("audit-runner", "system");
      if (!mainTpl) {
        throw new Error(`[orca] agent "audit-runner" [MAIN] prompt not found`);
      }
      const resolvers = {
        ...buildDirectiveResolvers([mainTpl, sysTpl ?? ""]),
        "orca.api_url": orcaApiUrl(),
        "audit.id": auditCheckId,
        "audit.name": check.name,
        "audit.prompt": auditSpecific,
        "project.name": project.name,
        "project.repo_path": repoPath,
      };
      prompt = await renderPromptLazy(mainTpl, resolvers);
      systemPrompt = sysTpl ? await renderPromptLazy(sysTpl, resolvers) : null;
      if (systemPrompt) systemPromptHash = sha256(systemPrompt);
      model = await resolveModelForAgent(db, "audit-runner");
      maxTurns = await resolveMaxTurnsForAgent(db, "audit-runner");
    } else {
      // fix mode — full-stack-engineer over the open fail findings.
      const fails = await db
        .select({
          id: schema.auditFindings.id,
          title: schema.auditFindings.title,
          detail: schema.auditFindings.detail,
          proposedFix: schema.auditFindings.proposedFix,
        })
        .from(schema.auditFindings)
        .where(
          and(
            eq(schema.auditFindings.auditCheckId, auditCheckId),
            eq(schema.auditFindings.kind, "fail"),
            eq(schema.auditFindings.status, "open"),
          ),
        );
      const mainTpl = await loadPrompt("full-stack-engineer", "main");
      const sysTpl = await loadPrompt("full-stack-engineer", "system");
      if (!mainTpl) {
        throw new Error(
          `[orca] agent "full-stack-engineer" [MAIN] prompt not found`,
        );
      }
      const resolvers = {
        ...buildDirectiveResolvers([mainTpl, sysTpl ?? ""]),
        "orca.api_url": orcaApiUrl(),
        mode: "Audit fix",
        "audit.id": auditCheckId,
        "audit.name": check.name,
        "audit.fails": renderOpenFails(fails),
        "prd.path": "(n/a — audit fix mode)",
        "prd.abs_path": "(n/a — audit fix mode)",
        "prd.content": "(audit-fix mode — no PRD)",
        "prd.ready_items": "(audit-fix mode — fixing audit findings, see below)",
        "project.name": project.name,
        "project.repo_path": repoPath,
      };
      prompt = await renderPromptLazy(mainTpl, resolvers);
      systemPrompt = sysTpl ? await renderPromptLazy(sysTpl, resolvers) : null;
      if (systemPrompt) systemPromptHash = sha256(systemPrompt);
      model = await resolveModelForAgent(db, "full-stack-engineer");
      maxTurns = await resolveMaxTurnsForAgent(db, "full-stack-engineer");
    }
  }

  await runCliDispatch({
    db,
    target: { kind: "audit", id: auditCheckId, projectId: check.projectId },
    cwd: repoPath,
    agentName,
    prompt,
    systemPrompt,
    model,
    maxTurns,
    // Stateless: audits re-scan the repo fresh each run; findings live in the DB.
    existingSessionId: null,
    systemPromptHash,
    trigger: opts.trigger,
    adoptExistingPid: opts.adoptExistingPid,
    onPidPersist: async (pid, state) => {
      await db
        .update(schema.auditChecks)
        .set({
          dispatchPid: pid,
          dispatchedAt: new Date(),
          dispatchState: state,
          // A fresh dispatch clears any prior manual-stop pause.
          dispatchStoppedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.auditChecks.id, auditCheckId));
    },
    onSessionPersist: async (sessionId, hash) => {
      await db
        .update(schema.auditChecks)
        .set({
          claudeSessionId: sessionId,
          ...(hash ? { claudeSessionSystemPromptHash: hash } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.auditChecks.id, auditCheckId));
    },
    onClearTracking: async () => {
      await db
        .update(schema.auditChecks)
        .set({ dispatchPid: null, dispatchState: null, updatedAt: new Date() })
        .where(eq(schema.auditChecks.id, auditCheckId));
    },
  });

  if (mode === "run") {
    const now = new Date();
    await db
      .update(schema.auditChecks)
      .set({
        lastRunAt: now,
        nextRunAt: computeNextRunAt(
          check.scheduleKind,
          check.scheduleTime,
          check.scheduleDays,
          now,
        ),
        updatedAt: now,
      })
      .where(eq(schema.auditChecks.id, auditCheckId));
  }
}
