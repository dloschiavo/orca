import { inArray } from "drizzle-orm";
import { schema } from "@orca/db";
import type { OrcaDb } from "@orca/db";

export const THROTTLE_DEFAULTS = {
  maxConcurrentPerProject: 2,
  maxConcurrentTotal: 3,
  maxConcurrentQa: 2,
  maxConcurrentSpecWriter: 4,
} as const;

export const THROTTLE_KEYS = {
  maxConcurrentPerProject: "throttle.maxConcurrentPerProject",
  maxConcurrentTotal: "throttle.maxConcurrentTotal",
  maxConcurrentQa: "throttle.maxConcurrentQa",
  maxConcurrentSpecWriter: "throttle.maxConcurrentSpecWriter",
} as const;

export interface ThrottleSettings {
  maxConcurrentPerProject: number;
  maxConcurrentTotal: number;
  maxConcurrentQa: number;
  maxConcurrentSpecWriter: number;
}

function parseSettingInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = parseInt(value, 10);
  return isNaN(n) || n < 1 ? fallback : n;
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
  };
}
