import { PageHeader } from "../components/PageHeader.js";
import { Breadcrumb } from "../components/Breadcrumb.js";

export function RecipesPage() {
  return (
    <div className="adm-page">
      <PageHeader
        title={<Breadcrumb first="Orca" second="Recipes" />}
        subtitle="read-only mirror (post-MVP)"
      />
      <div className="adm-body adm-body-narrow">
        <div className="adm-empty">
          <p>
            The <code>_recipes</code> mirror and full-text search arrive in
            MVP+1. For now the feedback loop auto-opens one PR per confirmed
            cross-project Finding, and the recipe bodies stay the source of
            truth on disk.
          </p>
        </div>
      </div>
    </div>
  );
}
