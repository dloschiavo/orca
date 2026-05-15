import type { ReactNode } from "react";

export function Breadcrumb({
  first,
  second,
}: {
  first: ReactNode;
  second: ReactNode;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        gap: 6,
        minWidth: 0,
        fontWeight: 400,
      }}
    >
      <span style={{ color: "var(--fg-2)" }}>{first}</span>
      <span style={{ color: "var(--fg-4)" }}>›</span>
      <span style={{ color: "var(--fg-0)", fontWeight: 600 }}>{second}</span>
    </span>
  );
}
