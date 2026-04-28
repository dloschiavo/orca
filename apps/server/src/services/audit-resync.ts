import { and, eq } from "drizzle-orm";
import { schema } from "@orca/db";
import type { OrcaDb } from "@orca/db";
import { loadSeedFiles } from "./audit-seed.js";

/**
 * Resync: re-scan all recipe files and reconcile with existing audit rows.
 *
 * This is a FILE-LEVEL sync only — it discovers new recipes, updates
 * titles, and detects content-hash changes. It does NOT verify whether
 * the recipe is implemented (that's the audit agent's job).
 *
 * For each recipe:
 *  - If no row exists yet: insert it (new recipe discovered).
 *  - If row exists and content hash changed AND status !== "forgone":
 *    mark `recipeStale = true` so the UI can flag it for re-review.
 *  - Update title and hash metadata.
 *
 * Returns a summary of what changed.
 */
export interface ResyncResult {
  inserted: number;
  markedStale: number;
  totalScanned: number;
}

export async function resyncImplementationAudit(
  db: OrcaDb,
  projectId: string,
): Promise<ResyncResult> {
  const seedFiles = await loadSeedFiles();
  const now = new Date();
  let inserted = 0;
  let markedStale = 0;

  for (const seed of seedFiles) {
    const [existing] = await db
      .select()
      .from(schema.implementationAudit)
      .where(
        and(
          eq(schema.implementationAudit.projectId, projectId),
          eq(schema.implementationAudit.concernSlug, seed.slug),
        ),
      )
      .limit(1);

    if (!existing) {
      // New recipe — insert it
      await db.insert(schema.implementationAudit).values({
        projectId,
        concernSlug: seed.slug,
        concernTitle: seed.title,
        cluster: seed.cluster,
        recipeType: seed.recipeType,
        applicability: seed.applicability,
        status: "unaudited",
        recipeContentHash: seed.contentHash,
        recipeStale: false,
        linkedStoryIds: [],
        linkedTriggerIds: [],
        blockingStoryIds: [],
      });
      inserted++;
      continue;
    }

    // Skip forgone rows — they don't need re-sync
    if (existing.status === "forgone") continue;

    const hashChanged =
      existing.recipeContentHash !== seed.contentHash;

    await db
      .update(schema.implementationAudit)
      .set({
        concernTitle: seed.title,
        recipeContentHash: seed.contentHash,
        ...(hashChanged ? { recipeStale: true } : {}),
        updatedAt: now,
      })
      .where(eq(schema.implementationAudit.id, existing.id));

    if (hashChanged) markedStale++;
  }

  return {
    inserted,
    markedStale,
    totalScanned: seedFiles.length,
  };
}
