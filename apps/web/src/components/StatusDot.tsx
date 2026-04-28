import clsx from "clsx";
import type { StoryStatus } from "@orca/shared";

const COLOR_BY_STATUS: Record<StoryStatus, string> = {
  icebox: "bg-icebox",
  backlog: "bg-backlog",
  in_progress: "bg-in-progress",
  in_qa: "bg-in-qa",
  final_review: "bg-final-review",
  blocked: "bg-blocked",
  done: "bg-done",
  canceled: "border border-gray-500",
};

export function StatusDot({
  status,
  className,
}: {
  status: StoryStatus;
  className?: string;
}) {
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
      {status.replace("_", " ")}
    </span>
  );
}
