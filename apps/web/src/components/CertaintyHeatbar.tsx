import clsx from "clsx";
import type { CertaintyLevel, StepCertainty } from "@orca/shared";

// The Implementation Certainty Heatbar: per-story visualization of where the
// human's thinking about THIS story is thin. Green = we know what to do, red =
// open refinement question, yellow = assumption we had to make.
//
// One cell per imperative step. Clicking a red cell should jump into the
// global Refinement Q&A Inbox filtered to just this story's open questions —
// that hand-off is wired up in the Story detail view once the inbox ships.

const LEVEL_CLASS: Record<CertaintyLevel, string> = {
  high: "bg-cert-high",
  medium: "bg-cert-medium",
  low: "bg-cert-low",
};

export function CertaintyHeatbar({
  overall,
  stepCertainties,
}: {
  overall: CertaintyLevel;
  stepCertainties: StepCertainty[];
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-1">
        {stepCertainties.length === 0 ? (
          <div className="text-[11px] text-muted">
            (no steps — card empty)
          </div>
        ) : (
          stepCertainties.map((sc) => (
            <span
              key={sc.stepId}
              className={clsx(
                "cert-cell w-6 h-2.5 rounded-sm",
                LEVEL_CLASS[sc.level],
              )}
              title={`${sc.level}: ${sc.reasons.join("; ") || "no reasons"}`}
            />
          ))
        )}
      </div>
      <span className="text-[11px] text-muted">
        overall{" "}
        <span
          className={clsx(
            "text-text",
            overall === "high" && "text-cert-high",
            overall === "medium" && "text-cert-medium",
            overall === "low" && "text-cert-low",
          )}
        >
          {overall}
        </span>
      </span>
    </div>
  );
}
