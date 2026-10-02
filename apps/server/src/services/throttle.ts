import { inArray } from "drizzle-orm";
import { schema } from "@orca/db";
import type { OrcaDb } from "@orca/db";

export const THROTTLE_DEFAULTS = {
  maxConcurrentPerProject: 2,
  maxConcurrentTotal: 3,
  maxConcurrentQa: 2,
  maxConcurrentSpecWriter: 4,
  // audit-runner is read-only (scans the repo, POSTs findings — never edits
  // code) so it keeps its own light cap, independent of the code-editing
  // impl-pipeline. The PRD/audit *code* agents do NOT have their own caps:
  // full-stack-engineer draws from the impl-pipeline budget (total +
  // per-project) and drafter draws from the spec-writer budget — see
  // `poolForAgent` below. That keeps the /settings caps a true ceiling on
  // system-wide concurrency rather than a story-only one.
  maxConcurrentAudit: 2,
} as const;

export const THROTTLE_KEYS = {
  maxConcurrentPerProject: "throttle.maxConcurrentPerProject",
  maxConcurrentTotal: "throttle.maxConcurrentTotal",
  maxConcurrentQa: "throttle.maxConcurrentQa",
  maxConcurrentSpecWriter: "throttle.maxConcurrentSpecWriter",
  maxConcurrentAudit: "throttle.maxConcurrentAudit",
} as const;

export interface ThrottleSettings {
  maxConcurrentPerProject: number;
  maxConcurrentTotal: number;
  maxConcurrentQa: number;
  maxConcurrentSpecWriter: number;
  maxConcurrentAudit: number;
}

/**
 * The throttle pool an agent draws its concurrency budget from. PRD/audit
 * agents deliberately share the SAME pools as story agents so the /settings
 * caps bound true system-wide concurrency:
 *   - `drafter` authors PRD docs → "spec" pool (maxConcurrentSpecWriter),
 *     alongside story spec-writers.
 *   - `full-stack-engineer` edits code for PRD [IMP] items / audit fixes →
 *     "impl" pool (maxConcurrentTotal + maxConcurrentPerProject), alongside
 *     story frontend/backend agents — they all cause watcher load.
 *   - `audit-runner` is read-only → its own "audit-run" pool
 *     (maxConcurrentAudit).
 * Everything else (frontend, backend, …, and any unknown/null agent) is an
 * impl-pipeline code editor.
 */
export type ThrottlePool = "impl" | "spec" | "qa" | "audit-run";

export function poolForAgent(agent: string | null | undefined): ThrottlePool {
  switch (agent) {
    case "spec-writer":
    case "drafter":
      return "spec";
    case "qa-tester":
      return "qa";
    case "audit-runner":
      return "audit-run";
    default:
      return "impl";
  }
}

function parseSettingInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  // Allow 0 (a deliberate "freeze — dispatch nothing" setting). Only reject
  // missing/NaN/negative values, which fall back to the default.
  return isNaN(n) || n < 0 ? fallback : n;
}

/**
 * Load throttle settings from orca_settings, falling back to defaults.
 */
export async function getThrottleSettings(
  db: OrcaDb,
): Promise<ThrottleSettings> {
  const rows = await db
    .select()
    .from(schema.orcaSettings)
    .where(
      inArray(schema.orcaSettings.key, [
        THROTTLE_KEYS.maxConcurrentPerProject,
        THROTTLE_KEYS.maxConcurrentTotal,
        THROTTLE_KEYS.maxConcurrentQa,
        THROTTLE_KEYS.maxConcurrentSpecWriter,
        THROTTLE_KEYS.maxConcurrentAudit,
      ]),
    );

  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    maxConcurrentPerProject: parseSettingInt(
      byKey[THROTTLE_KEYS.maxConcurrentPerProject],
      THROTTLE_DEFAULTS.maxConcurrentPerProject,
    ),
    maxConcurrentTotal: parseSettingInt(
      byKey[THROTTLE_KEYS.maxConcurrentTotal],
      THROTTLE_DEFAULTS.maxConcurrentTotal,
    ),
    maxConcurrentQa: parseSettingInt(
      byKey[THROTTLE_KEYS.maxConcurrentQa],
      THROTTLE_DEFAULTS.maxConcurrentQa,
    ),
    maxConcurrentSpecWriter: parseSettingInt(
      byKey[THROTTLE_KEYS.maxConcurrentSpecWriter],
      THROTTLE_DEFAULTS.maxConcurrentSpecWriter,
    ),
    maxConcurrentAudit: parseSettingInt(
      byKey[THROTTLE_KEYS.maxConcurrentAudit],
      THROTTLE_DEFAULTS.maxConcurrentAudit,
    ),
  };
}
