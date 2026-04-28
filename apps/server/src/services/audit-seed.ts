import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { and, eq } from "drizzle-orm";
import { schema } from "@orca/db";
import type { OrcaDb } from "@orca/db";
import type {
  AuditApplicability,
  AuditCluster,
  AuditRecipeType,
} from "@orca/shared";

/**
 * Seed the Implementation Audit matrix for a newly-created project.
 *
 * One row per recipe file — both migrated (`_recipes/<name>/SKILL.md`) and
 * unmigrated (`_recipes/_unmigrated/*.md`). Every row starts
 * `status: unaudited`. The project owner walks the table once and makes a
 * conscious decision on each row — this is the PM pipeline visibility
 * surface, not an agent safety net.
 *
 * Seeding is idempotent: the row identity is `(project_id, concern_slug)`.
 * Re-running on the same project is a no-op per existing row.
 */

const RECIPES_DIR = path.resolve(
  process.env.ORCA_RECIPES_DIR ??
    "/Users/davidloschiavo/Documents/Goliath/_recipes",
);

const UNMIGRATED_DIR = path.join(RECIPES_DIR, "_unmigrated");

// Twelve-cluster taxonomy from the spec. Every slug lands in exactly one
// cluster. A handful of ambiguous slugs (dev-ops vs deployment, rendering vs
// performance) are decided here explicitly so the seeder is deterministic.
const CLUSTER_BY_SLUG: Record<string, AuditCluster> = {
  // core-infrastructure
  "app-config-theming": "core-infrastructure",
  "feature-flags": "core-infrastructure",
  "first-run-detection": "core-infrastructure",
  "maintenance-mode": "core-infrastructure",
  "rendering-routing": "core-infrastructure",
  stack: "core-infrastructure",
  "theming-enhancements": "ux-content-shell",

  // auth-identity
  "account-deletion": "auth-identity",
  "avatar-upload": "auth-identity",
  "oauth-apple": "auth-identity",
  "oauth-github": "auth-identity",
  "oauth-google": "auth-identity",
  "otp-auth": "auth-identity",
  "password-reset": "auth-identity",
  "sms-otp": "auth-identity",
  "user-impersonation": "auth-identity",
  "admin-roles-crud": "auth-identity",
  "admin-user-crud": "auth-identity",

  // monetization-billing
  "subscription-billing": "monetization-billing",
  "billing-enhancements": "monetization-billing",

  // observability-admin
  "admin-dashboard": "observability-admin",
  "admin-enhancements": "observability-admin",
  "admin-prompt-queue": "observability-admin",
  analytics: "observability-admin",
  "analytics-enhancements": "observability-admin",
  "import-google-analytics": "observability-admin",
  auditor: "observability-admin",
  "admin-only-notus": "observability-admin",

  // compliance-legal
  "age-gate": "compliance-legal",
  checklist: "compliance-legal",
  "cookie-consent": "compliance-legal",
  dmca: "compliance-legal",
  "gdpr-data": "compliance-legal",
  implement: "compliance-legal",
  "privacy-policy": "compliance-legal",

  // ux-content-shell
  "contact-support-form": "ux-content-shell",
  "onboarding-enhancements": "ux-content-shell",
  "support-enhancements": "ux-content-shell",
  cms: "ux-content-shell",
  "landing-marketing-site": "ux-content-shell",
  "public-contact-chat": "ux-content-shell",

  // error-handling-resilience
  "404-redirector": "error-handling-resilience",
  "error-handling": "error-handling-resilience",
  "offline-fallback": "error-handling-resilience",

  // performance
  "cache-headers": "performance",
  "performance-enhancements": "performance",
  "rendering-enhancements": "performance",

  // seo-content
  "seo-enhancements": "seo-content",
  "seo-marketing-templates": "seo-content",

  // notifications-comms
  "notification-system": "notifications-comms",
  "admin-chat": "notifications-comms",
  "chat-support": "notifications-comms",

  // devops-deployment
  "dev-ops": "devops-deployment",
  "devops-enhancements": "devops-deployment",
  "github-pages-hosting": "devops-deployment",
  "code-qa": "devops-deployment",
  "skill-creator": "devops-deployment",
  "web-scraping": "devops-deployment",

  // saas-specific
  "saas-enhancements": "saas-specific",
  "multi-tenant": "saas-specific",
  "visitor-fingerprint": "saas-specific",
};

// Slugs that are not broadly applicable. Still seeded as `unaudited` — the
// human decides `forgone` vs `substituted` when they walk the table. We
// annotate the default applicability to help the risk view sort correctly.
const APPLICABILITY_BY_SLUG: Record<string, AuditApplicability> = {
  "age-gate": "web-only",
  "cookie-consent": "web-only",
  "github-pages-hosting": "web-only",
  "import-google-analytics": "web-only",
  "oauth-apple": "web-only",
  "oauth-github": "web-only",
  "oauth-google": "web-only",
  "saas-enhancements": "saas-only",
  "subscription-billing": "saas-only",
  "billing-enhancements": "saas-only",
  "seo-enhancements": "web-only",
  "seo-marketing-templates": "web-only",
  "multi-tenant": "saas-only",
  "visitor-fingerprint": "web-only",
  "landing-marketing-site": "web-only",
  "offline-fallback": "native-only",
};

export interface SeedFile {
  slug: string;
  title: string;
  recipeType: AuditRecipeType;
  cluster: AuditCluster;
  applicability: AuditApplicability;
  contentHash: string;
}

// Parse the frontmatter block manually with a forgiving line-parser. Several
// _unmigrated files have unquoted colons mid-value (`env_vars: X (default: 5)`)
// that crash strict YAML. We don't need full YAML semantics — we only read a
// handful of scalar keys.
function parseLooseFrontmatter(raw: string): Record<string, string> {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const block = match[1] ?? "";
  const out: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const [, key, valueRaw] = m;
    if (!key) continue;
    let value = (valueRaw ?? "").trim();
    // Strip matching surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** SHA-256 content hash (hex, first 16 chars) for recipe staleness detection. */
export function contentHash(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/**
 * Load seed files from both migrated (`_recipes/<name>/SKILL.md`) and
 * unmigrated (`_recipes/_unmigrated/*.md`) directories.
 */
export async function loadSeedFiles(): Promise<SeedFile[]> {
  const out: SeedFile[] = [];
  const seen = new Set<string>();

  // 1. Migrated recipes — directories with SKILL.md files
  try {
    const entries = await fs.readdir(RECIPES_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
      const skillPath = path.join(RECIPES_DIR, entry.name, "SKILL.md");
      let raw: string;
      try {
        raw = await fs.readFile(skillPath, "utf8");
      } catch {
        continue; // no SKILL.md in this directory
      }
      if (raw.trim().length === 0) continue;

      const slug = entry.name;
      seen.add(slug);

      let data: Record<string, string> = {};
      try {
        const parsed = matter(raw);
        const gm = parsed.data as Record<string, unknown>;
        for (const [k, v] of Object.entries(gm)) {
          if (typeof v === "string") data[k] = v;
        }
      } catch {
        data = parseLooseFrontmatter(raw);
      }

      const name =
        typeof data.name === "string" && data.name.trim().length > 0
          ? data.name
          : humanize(slug);
      const cluster: AuditCluster =
        CLUSTER_BY_SLUG[slug] ?? "core-infrastructure";
      const applicability: AuditApplicability =
        APPLICABILITY_BY_SLUG[slug] ?? "universal";

      out.push({
        slug,
        title: name,
        recipeType: "project",
        cluster,
        applicability,
        contentHash: contentHash(raw),
      });
    }
  } catch {
    // RECIPES_DIR doesn't exist — fall through to unmigrated only
  }

  // 2. Unmigrated recipes — flat .md files (skip slugs already covered above)
  try {
    const entries = await fs.readdir(UNMIGRATED_DIR);
    const mdFiles = entries.filter((f) => f.endsWith(".md"));
    for (const file of mdFiles) {
      const slug = file.replace(/\.md$/, "");
      if (seen.has(slug)) continue; // migrated version takes precedence

      const full = path.join(UNMIGRATED_DIR, file);
      const raw = await fs.readFile(full, "utf8");
      if (raw.trim().length === 0) continue;

      let data: Record<string, string> = {};
      try {
        const parsed = matter(raw);
        const gm = parsed.data as Record<string, unknown>;
        for (const [k, v] of Object.entries(gm)) {
          if (typeof v === "string") data[k] = v;
        }
      } catch {
        data = parseLooseFrontmatter(raw);
      }

      const name =
        typeof data.name === "string" && data.name.trim().length > 0
          ? data.name
          : humanize(slug);
      const type = data.type === "enhancement" ? "enhancement" : "project";
      const cluster: AuditCluster =
        CLUSTER_BY_SLUG[slug] ?? "core-infrastructure";
      const applicability: AuditApplicability =
        APPLICABILITY_BY_SLUG[slug] ?? "universal";

      out.push({
        slug,
        title: name,
        recipeType: type,
        cluster,
        applicability,
        contentHash: contentHash(raw),
      });
    }
  } catch {
    // UNMIGRATED_DIR doesn't exist
  }

  return out;
}

function humanize(slug: string): string {
  return slug
    .split("-")
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * Idempotent: if a row already exists for (project, slug), skip it.
 * Returns the number of rows inserted on this call.
 */
export async function seedImplementationAudit(
  db: OrcaDb,
  projectId: string,
): Promise<number> {
  let seedFiles: SeedFile[];
  try {
    seedFiles = await loadSeedFiles();
  } catch (err) {
    console.warn(
      `[orca] audit seed skipped: cannot read recipes: ${String(err)}`,
    );
    return 0;
  }

  let inserted = 0;
  for (const seed of seedFiles) {
    const existing = await db
      .select({ id: schema.implementationAudit.id })
      .from(schema.implementationAudit)
      .where(
        and(
          eq(schema.implementationAudit.projectId, projectId),
          eq(schema.implementationAudit.concernSlug, seed.slug),
        ),
      )
      .limit(1);
    if (existing.length > 0) continue;

    await db.insert(schema.implementationAudit).values({
      projectId,
      concernSlug: seed.slug,
      concernTitle: seed.title,
      cluster: seed.cluster,
      recipeType: seed.recipeType,
      applicability: seed.applicability,
      status: "unaudited",
      recipeContentHash: seed.contentHash,
      linkedStoryIds: [],
      linkedTriggerIds: [],
      blockingStoryIds: [],
    });
    inserted++;
  }
  return inserted;
}
