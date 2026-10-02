import type { ActivityEventRow } from "@orca/db";

export interface SerializedActivity {
  id: string;
  storyId: string | null;
  kind: string;
  actor: string;
  payload: Record<string, unknown>;
  dispatchInstanceId: string | null;
  targetKind: string;
  targetId: string | null;
  createdAt: string;
}

/** Map an activity_events row to the JSON shape the web client expects. */
export function serializeActivity(r: ActivityEventRow): SerializedActivity {
  return {
    id: r.id,
    storyId: r.storyId,
    kind: r.kind,
    actor: r.actor,
    payload: r.payload,
    dispatchInstanceId: r.dispatchInstanceId,
    targetKind: r.targetKind,
    targetId: r.targetId,
    createdAt: r.createdAt.toISOString(),
  };
}
