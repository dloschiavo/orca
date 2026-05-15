import { PageHeader } from "../components/PageHeader.js";
import { Breadcrumb } from "../components/Breadcrumb.js";

export function TriggersPage() {
  return (
    <div className="adm-page">
      <PageHeader
        title={<Breadcrumb first="Orca" second="Triggers" />}
        subtitle="recurring automations"
      />
      <div className="adm-body adm-body-narrow">
        <div className="adm-empty">
          <p>
            Triggers are the recurring-automation half of the PM pipeline. Their
            data model is wired up (<code>cron</code> / <code>file-watch</code> /{" "}
            <code>webhook</code>, coalesce vs skip-missed policy, linked audit
            row), but the scheduler and editor UI ship post-MVP.
          </p>
          <p>
            In the meantime, the Implementation Audit is the place to mark a
            thread as handled by a (future) trigger.
          </p>
        </div>
      </div>
    </div>
  );
}
