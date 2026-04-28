import type { ReactNode } from "react";

interface SectionProps {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
}

export function Section({ title, subtitle, action, children }: SectionProps) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-[11px] uppercase tracking-wider text-muted">{title}</h3>
        {subtitle && <span className="text-[11px] text-muted">{subtitle}</span>}
        {action}
      </div>
      {children}
    </div>
  );
}
