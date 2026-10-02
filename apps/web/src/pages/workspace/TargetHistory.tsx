import { useState } from "react";
import type { ActivityEvent } from "../../api.js";
import {
  groupActivity,
  HistoryEvent,
  HistoryShowDropdown,
  eventVisible,
  useHistoryShowSet,
} from "../StoriesWorkspacePage.js";

/**
 * Threaded agent history for a PRD or audit target. Reuses the exact same
 * event feed as the story History tab (grouping, expandable detail, wrapped
 * text, token counts) so it presents identically.
 */
export function TargetHistory({
  activity,
  workspace: workspaceProp,
  hasMore,
  onLoadMore,
  loadingMore,
}: {
  activity: ActivityEvent[];
  /** Workspace path for the noise filter. When the feed is paginated the most
   *  recent dispatch_started may not be loaded, so callers can pass it
   *  explicitly; otherwise it's derived from the loaded events. */
  workspace?: string | null;
  /** Older events remain unloaded — render a "load older" control. */
  hasMore?: boolean;
  onLoadMore?: () => void;
  loadingMore?: boolean;
}) {
  const [expandAll, setExpandAll] = useState(false);
  const [show, toggleShow] = useHistoryShowSet();

  // Same noise filter the story History tab runs before grouping. Without it
  // the interleaved "tool result: ok" user-stream events (hidden by default)
  // sit between consecutive "→ Edit" tool calls and split a single agent's run
  // into one block per edit instead of stacking the arrows under one header.
  const workspace: string | undefined =
    workspaceProp ??
    ([...activity].reverse().find((e) => e.kind === "dispatch_started")?.payload
      ?.repoPath as string | undefined);

  const droppedInstanceIds = new Set<string>();
  for (const e of activity) {
    if (e.kind !== "dispatch_dropped") continue;
    const instId = e.dispatchInstanceId;
    if (instId) droppedInstanceIds.add(instId);
  }

  const visible = activity.filter((e) => eventVisible(e, show, workspace, droppedInstanceIds));
  const events = [...visible].reverse();
  const groups = groupActivity(events);

  if (activity.length === 0) {
    return (
      <div className="sd-soft">
        No agent activity yet. Runs from the drafter / full-stack-engineer appear here as they work this item.
      </div>
    );
  }

  return (
    <div className="hist">
      <div className="hist-toolbar">
        <span>{events.length} events</span>
        <span style={{ color: "var(--fg-4)" }}>·</span>
        <HistoryShowDropdown show={show} onToggle={toggleShow} count={show.size} />
        <span style={{ marginLeft: "auto" }}>
          <button className="btn btn-sm" onClick={() => setExpandAll(true)}>expand all</button>
        </span>
        <span>
          <button className="btn btn-sm" onClick={() => setExpandAll(false)}>collapse</button>
        </span>
      </div>
      {groups.map((g, i) =>
        g.type === "continuing" ? (
          <HistoryEvent
            key={`continuing-${i}`}
            event={g.arrows[0]!}
            arrows={g.arrows}
            forceOpen={expandAll}
            workspace={workspace}
            synthetic
          />
        ) : (
          <HistoryEvent
            key={g.event.id}
            event={g.event}
            arrows={g.type === "bubble" ? g.arrows : undefined}
            forceOpen={expandAll}
            workspace={workspace}
          />
        ),
      )}
      {hasMore && (
        <div className="hist-load-more">
          <button className="btn btn-sm" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? "loading…" : "load older"}
          </button>
        </div>
      )}
    </div>
  );
}
