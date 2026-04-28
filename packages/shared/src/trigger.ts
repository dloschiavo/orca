// Recurring automations (cron / file-watch / webhook) linked to stories and audit rows.
// Data model is present in the MVP; UI + scheduler land post-MVP.

export type TriggerKind = "cron" | "file-watch" | "webhook";

export type TriggerConcurrencyPolicy = "coalesce_if_active" | "skip_missed";

export interface Trigger {
  id: string;
  projectId: string;
  kind: TriggerKind;
  schedule: string | null; // cron expression when kind == "cron"
  watchPattern: string | null; // glob when kind == "file-watch"
  targetStoryTemplateId: string | null;
  linkedAuditRowId: string | null;
  concurrencyPolicy: TriggerConcurrencyPolicy;
  enabled: boolean;
  lastFiredAt: string | null;
  nextFireAt: string | null;
  createdAt: string;
  updatedAt: string;
}
