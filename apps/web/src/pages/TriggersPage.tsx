import { PageHeader } from "../components/PageHeader.js";
import { Breadcrumb } from "../components/Breadcrumb.js";

// Triggers — recurring automations (cron / file-watch / webhook).
// Data model present in packages/db; scheduler and UI land post-MVP.

export function TriggersPage() {
  return (
    <div className="h-full flex flex-col">
      <PageHeader title={<Breadcrumb first="Orca" second="Triggers" />} subtitle="recurring automations" />
      <div className="p-6 text-sm text-muted max-w-xl space-y-2">
        <p>
          Triggers are the recurring-automation half of the PM pipeline. Their
          data model is wired up (cron / file-watch / webhook, coalesce vs
          skip-missed policy, linked audit row), but the scheduler and editor
          UI ship post-MVP.
        </p>
        <p>
          In the meantime, the Implementation Audit is the place to mark a
          thread as handled by a (future) trigger.
        </p>
      </div>
    </div>
  );
}
