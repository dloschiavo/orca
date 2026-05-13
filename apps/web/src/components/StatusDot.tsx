import clsx from "clsx";
import type { StoryStatus } from "@orca/shared";

const COLOR_BY_STATUS: Record<StoryStatus, string> = {
  icebox: "bg-icebox",
  planning: "bg-planning",
  backlog: "bg-backlog",
  implementing: "bg-implementing",
  qa: "bg-qa",
  review: "bg-review",
  blocked: "bg-blocked",
  done: "bg-done",
  canceled: "border border-gray-500",
};

const LABEL_BY_STATUS: Record<StoryStatus, string> = {
  icebox: "icebox",
  planning: "planning",
  backlog: "backlog",
  implementing: "implementing",
  qa: "qa",
  review: "review",
  blocked: "blocked",
  done: "done",
  canceled: "canceled",
};

export function StatusDot({
  status,
  className,
  pulse,
}: {
  status: StoryStatus;
  className?: string;
  // When true, the dot pulses. Callers decide the condition (today: active dispatched PID).
  pulse?: boolean;
}) {
  const shouldPulse = pulse;
  if (shouldPulse) {
    return (
      <span className={clsx("relative flex h-2 w-2 shrink-0", className)} title={status}>
        <span className={clsx("absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping", COLOR_BY_STATUS[status])} />
        <span className={clsx("relative inline-flex h-2 w-2 rounded-full", COLOR_BY_STATUS[status])} />
      </span>
    );
  }
  return (
    <span
      className={clsx("state-dot", COLOR_BY_STATUS[status], className)}
      title={status}
    />
  );
}

export function StatusLabel({ status }: { status: StoryStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      <StatusDot status={status} />
      {LABEL_BY_STATUS[status]}
    </span>
  );
}
