import { PageHeader } from "../components/PageHeader.js";
import { Breadcrumb } from "../components/Breadcrumb.js";

// Read-only mirror of _recipes with search and findings-linked references.
// MVP ships the nav slot; the mirror+search land once the findings
// write-back loop is proven and we promote the in-app auditor.

export function RecipesPage() {
  return (
    <div className="h-full flex flex-col">
      <PageHeader title={<Breadcrumb first="Orca" second="Recipes" />} subtitle="read-only mirror (post-MVP)" />
      <div className="p-6 text-sm text-muted max-w-xl">
        The <code>_recipes</code> mirror and full-text search arrive in
        MVP+1. For now the feedback loop auto-opens one PR per confirmed
        cross-project Finding, and the recipe bodies stay the source of
        truth on disk.
      </div>
    </div>
  );
}
