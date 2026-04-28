import { execSync } from "node:child_process";
import { and, desc, eq, sql } from "drizzle-orm";
import { schema } from "@orca/db";
import type { OrcaDb } from "@orca/db";

/**
 * Default cap on concurrent `claude` processes before auto-dispatch is gated.
 * Override with ORCA_CONCURRENCY_CAP env var. We don't know the exact
 * Anthropic rate-limit threshold yet — this is a conservative starting point
 * that can be tuned once we collect PID-count telemetry from rate-limit events.
 */
const DEFAULT_CONCURRENCY_CAP = 5;

export function getConcurrencyCap(): number {
  const envVal = process.env.ORCA_CONCURRENCY_CAP;
  if (envVal) {
    const n = parseInt(envVal, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return DEFAULT_CONCURRENCY_CAP;
}

/**
 * Counts the number of running `claude` prompt processes (i.e. `claude -p`).
 * Uses `pgrep` which is available on macOS and Linux.
 * Returns 0 if the count can't be determined.
 *
 * IMPORTANT: the pattern must be specific enough to NOT match Claude desktop
 * processes. Claude desktop's command line contains flags like
 * `--permission-prompt-tool`, `--permission-mode`, `--plugin-dir`,
 * `--allow-dangerously-skip-permissions` — all of which contain the substring
 * `-p`. A regex like `claude.*-p` matches all of those greedily and over-counts
 * by a factor of ~16, jamming the concurrency gate permanently. We anchor on
 * the literal `claude -p ` substring (with a trailing space) which orca always
 * passes as the first arg to its spawn calls and which Claude desktop never
 * produces.
 */
export function countClaudeProcesses(): number {
  try {
    // pgrep -f matches the full command line. The literal `claude -p `
    // (note the trailing space before the prompt arg) is what `spawn("claude",
    // ["-p", prompt, …])` produces in argv and is unique to orca's invocations.
    const out = execSync('pgrep -f "claude -p " 2>/dev/null || true', {
      encoding: "utf8",
      timeout: 5000,
    });
    const pids = out
      .trim()
      .split("\n")
      .filter((line) => line.trim() !== "");
    return pids.length;
  } catch {
    return 0;
  }
}

/**
 * Returns true if we're at or above the concurrency cap and should defer
 * new auto-dispatches.
 */
export function isConcurrencyExceeded(): boolean {
  const count = countClaudeProcesses();
  const cap = getConcurrencyCap();
  return count >= cap;
}

// ── Rate-limit tracking ─────────────────────────────────────────────
// In-memory tracker for the most recent rate-limit signal. Auto-dispatch
// checks this before spawning a new agent; manual dispatch does not.

interface RateLimitRecord {
  /** e.g. "input_tokens_per_minute", "requests_per_minute" */
  rateLimitType: string | null;
  /** Seconds the API asked us to wait */
  retryAfterSec: number | null;
  /** Wall-clock time we should stop gating */
  gatedUntil: Date;
  /** PID count at the time the limit was hit */
  claudeProcessCount: number;
  /** ISO timestamp of when we recorded this */
  recordedAt: string;
}

let lastRateLimit: RateLimitRecord | null = null;

/**
 * Record a rate-limit event observed during a dispatch. Called from the
 * stream-json and stderr handlers in stories.ts.
 *
 * If `retryAfterSec` is provided (from the API's retry_after field), the
 * gate holds until that period elapses. Otherwise we apply a conservative
 * 60-second cooldown so the next heartbeat tick backs off at least once.
 */
export function recordRateLimit(info: {
  rateLimitType?: string | null;
  retryAfterSec?: number | null;
  claudeProcessCount: number;
}): void {
  const cooldownSec = info.retryAfterSec != null && info.retryAfterSec > 0
    ? info.retryAfterSec
    : 60; // conservative default
  lastRateLimit = {
    rateLimitType: info.rateLimitType ?? null,
    retryAfterSec: info.retryAfterSec ?? null,
    gatedUntil: new Date(Date.now() + cooldownSec * 1000),
    claudeProcessCount: info.claudeProcessCount,
    recordedAt: new Date().toISOString(),
  };
  console.log(
    `[orca/concurrency] rate limit recorded: type=${lastRateLimit.rateLimitType}, ` +
    `retryAfter=${cooldownSec}s, gatedUntil=${lastRateLimit.gatedUntil.toISOString()}`,
  );
}

/**
 * Returns true if a recent rate-limit event means we should defer
 * auto-dispatch. The gate lifts once the cooldown / retry_after expires.
 */
export function isRateLimited(): boolean {
  if (!lastRateLimit) return false;
  return new Date() < lastRateLimit.gatedUntil;
}

/**
 * Returns the current rate-limit record (for logging in activity events),
 * or null if there is none / it has expired.
 */
export function getRateLimitInfo(): RateLimitRecord | null {
  if (!lastRateLimit) return null;
  if (new Date() >= lastRateLimit.gatedUntil) return null;
  return { ...lastRateLimit };
}

// ── Weekly-allotment usage tracking ─────────────────────────────────
// Claude streams `rate_limit_event` messages with status "allowed" /
// "allowed_warning" that carry a decimal 0-1 `usage_fraction` showing
// how much of the weekly token allotment has been consumed. We keep an
// in-memory cache AND persist to orca_settings so the value survives
// server restarts.

const USAGE_SETTINGS_KEY = "rateLimitUsageFraction";

let latestUsageFraction: number | null = null;
let usageFractionUpdatedAt: string | null = null;

/**
 * Store the latest weekly-allotment usage fraction (0-1) in memory.
 * `asOf` overrides the timestamp when seeding from a historical event so
 * the bar reflects when the data was actually emitted by the CLI, not
 * when we happened to observe it.
 */
export function recordUsageFraction(fraction: number, asOf?: string): void {
  latestUsageFraction = fraction;
  usageFractionUpdatedAt = asOf ?? new Date().toISOString();
}

/**
 * Extract weekly-allotment usage fraction from a rate_limit_info object.
 *
 * Only the `seven_day` bucket carries the weekly-allotment utilization;
 * `five_hour` and `seven_day_sonnet` events would clobber the headline
 * fraction with the wrong meaning, so we ignore them.
 *
 * Field name history: the CLI used to call this `usage_fraction`, then
 * renamed it to `utilization` (CLI v2.x). We accept either.
 */
export function extractUsageFraction(rli: Record<string, unknown>): number | null {
  const rlType = typeof rli.rateLimitType === "string" ? rli.rateLimitType : null;
  if (rlType != null && rlType !== "seven_day") return null;
  const uf = rli.utilization ?? rli.usage_fraction ?? rli.usageFraction;
  if (typeof uf === "number" && uf >= 0 && uf <= 1) return uf;
  return null;
}

/** Persist the current in-memory usage fraction to the database. */
export async function persistUsageFraction(db: OrcaDb): Promise<void> {
  if (latestUsageFraction == null || usageFractionUpdatedAt == null) return;
  const value = JSON.stringify({
    fraction: latestUsageFraction,
    updatedAt: usageFractionUpdatedAt,
  });
  await db
    .insert(schema.orcaSettings)
    .values({ key: USAGE_SETTINGS_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.orcaSettings.key,
      set: { value, updatedAt: new Date() },
    });
}

/** Clear the in-memory usage fraction. */
export function clearUsageFraction(): void {
  latestUsageFraction = null;
  usageFractionUpdatedAt = null;
}

/** Delete the persisted usage fraction from the DB. */
export async function clearPersistedUsageFraction(db: OrcaDb): Promise<void> {
  await db
    .delete(schema.orcaSettings)
    .where(eq(schema.orcaSettings.key, USAGE_SETTINGS_KEY));
}

/** Load the persisted usage fraction from DB into memory (call on boot). */
export async function loadUsageFractionFromDb(db: OrcaDb): Promise<void> {
  const [row] = await db
    .select()
    .from(schema.orcaSettings)
    .where(eq(schema.orcaSettings.key, USAGE_SETTINGS_KEY));
  if (!row) return;
  try {
    const parsed = JSON.parse(row.value) as { fraction: number; updatedAt: string };
    if (typeof parsed.fraction === "number" && typeof parsed.updatedAt === "string") {
      latestUsageFraction = parsed.fraction;
      usageFractionUpdatedAt = parsed.updatedAt;
    }
  } catch {
    // corrupted value — ignore
  }
}

/** Return the latest usage fraction, or null if we haven't seen one yet. */
export function getUsageFraction(): { fraction: number; updatedAt: string } | null {
  if (latestUsageFraction == null || usageFractionUpdatedAt == null) return null;
  return { fraction: latestUsageFraction, updatedAt: usageFractionUpdatedAt };
}

/**
 * Backfill the usage cache from the most recent `seven_day` rate_limit_event
 * already in `activity_events`. The in-stream extractor was once broken
 * (looking for the old field name `usage_fraction` after the CLI renamed it
 * to `utilization`), so the activity log accumulated events whose data was
 * never harvested. On boot we walk back through them so the bar shows the
 * latest value we've ever seen, even if no fresh dispatch has run yet.
 *
 * Only seeds if the activity event is newer than the persisted cache —
 * otherwise the persisted value is authoritative.
 */
export async function backfillUsageFractionFromActivity(db: OrcaDb): Promise<void> {
  const [row] = await db
    .select({
      payload: schema.activityEvents.payload,
      createdAt: schema.activityEvents.createdAt,
    })
    .from(schema.activityEvents)
    .where(
      and(
        eq(schema.activityEvents.kind, "agent_stream"),
        sql`${schema.activityEvents.payload}->>'type' = 'rate_limit_event'`,
        sql`${schema.activityEvents.payload}->'rate_limit_info'->>'rateLimitType' = 'seven_day'`,
        sql`${schema.activityEvents.payload}->'rate_limit_info'->'utilization' IS NOT NULL`,
      ),
    )
    .orderBy(desc(schema.activityEvents.createdAt))
    .limit(1);

  if (!row) return;
  const payload = row.payload as Record<string, unknown>;
  const rli = payload.rate_limit_info as Record<string, unknown> | null;
  if (!rli) return;
  const uf = extractUsageFraction(rli);
  if (uf == null) return;

  const eventTs = row.createdAt.toISOString();
  if (usageFractionUpdatedAt != null && eventTs <= usageFractionUpdatedAt) return;

  recordUsageFraction(uf, eventTs);
  await persistUsageFraction(db).catch(() => {});
  console.log(
    `[orca/usage] backfilled fraction=${uf} from activity event at ${eventTs}`,
  );
}
