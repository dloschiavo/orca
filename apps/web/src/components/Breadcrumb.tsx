import type { ReactNode } from "react";

/**
 * Consistent breadcrumb for PageHeader titles.
 * Usage: <Breadcrumb first="ProjectName" second="All Stories" />
 */
export function Breadcrumb({
  first,
  second,
}: {
  first: ReactNode;
  second: ReactNode;
}) {
  return (
    <span className="flex items-baseline gap-1.5 min-w-0">
      <span className="text-muted font-normal">{first}</span>
      <span className="text-muted font-normal">›</span>
      <span className="text-text">{second}</span>
    </span>
  );
}
