import type { ReactNode } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import clsx from "clsx";
import { api } from "../api.js";
import { useProjectContext } from "../state/ProjectContext.js";
import type { ServerStatus } from "@orca/shared";

/** Map 0-1 fraction to a green→yellow→red heatmap color. */
function heatColor(fraction: number): string {
  const f = Math.max(0, Math.min(1, fraction));
  if (f < 0.5) {
    // green → yellow
    const r = Math.round(255 * (f / 0.5));
    return `rgb(${r}, 200, 60)`;
  }
  // yellow → red
  const g = Math.round(200 * (1 - (f - 0.5) / 0.5));
  return `rgb(255, ${g}, 60)`;
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: string;
  actions?: ReactNode;
}) {
  const { activeProject } = useProjectContext();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ["usage"],
    queryFn: () => api.usage.get(),
    refetchInterval: 30_000,
  });

  const { data: statusData } = useQuery({
    queryKey: ["server-status"],
    queryFn: () => api.projects.serverStatus(),
    refetchInterval: 10_000,
  });

  const startMutation = useMutation({
    mutationFn: ({ id, kind }: { id: string; kind?: "frontend" | "backend" }) =>
      api.projects.start(id, kind),
    onSuccess: () => {
      // Poll faster for a bit to pick up the newly started process
      setTimeout(
        () => queryClient.invalidateQueries({ queryKey: ["server-status"] }),
        3000,
      );
    },
  });

  const rawUsage = data?.usage ?? null;
  const USAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const usage =
    rawUsage != null &&
    Date.now() - new Date(rawUsage.updatedAt).getTime() <= USAGE_MAX_AGE_MS
      ? rawUsage
      : null;

  // Find status for the active project — prefer live status data over cached config
  const activeStatus: ServerStatus | undefined = activeProject
    ? statusData?.statuses?.find((s) => s.projectId === activeProject.id)
    : undefined;

  const frontends = activeStatus?.endpoints.filter((e) => e.kind === "frontend") ?? [];
  const backends = activeStatus?.endpoints.filter((e) => e.kind === "backend") ?? [];

  // Show indicators if we have live status data OR a cached config
  const hasConfig =
    (activeStatus?.endpoints?.length ?? 0) > 0 ||
    !!activeProject?.serverConfig?.endpoints?.length;

  function handleStart(kind: "frontend" | "backend") {
    if (!activeProject) return;
    startMutation.mutate({ id: activeProject.id, kind });
  }

  return (
    <header className="h-12 px-6 flex items-center justify-between border-b border-border bg-surface shrink-0 sticky top-0 z-40">
      <div className="flex items-baseline gap-3 min-w-0">
        <h1 className="text-sm font-semibold text-text truncate">{title}</h1>
        {subtitle && (
          <span className="text-xs text-muted truncate">{subtitle}</span>
        )}
      </div>
      <div className="flex items-center gap-3">
        {/* Server status indicators */}
        {hasConfig && (
          <div className="flex items-center gap-2 text-xs">
            {frontends.map((ep) => (
              <span key={`fe-${ep.port}`} className="flex items-center gap-1">
                <span
                  className={clsx(
                    "inline-block w-2 h-2 rounded-full",
                    ep.running ? "bg-done" : "bg-red-500",
                  )}
                />
                {ep.running ? (
                  <a
                    href={`http://localhost:${ep.port}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:underline"
                  >
                    localhost:{ep.port}
                  </a>
                ) : (
                  <button
                    type="button"
                    className="text-muted hover:text-text transition-colors"
                    title="Click to start frontend"
                    onClick={() => handleStart("frontend")}
                    disabled={startMutation.isPending}
                  >
                    {startMutation.isPending && startMutation.variables?.kind === "frontend"
                      ? "starting…"
                      : "localhost"}
                  </button>
                )}
              </span>
            ))}
            {frontends.length === 0 &&
              activeProject?.serverConfig?.endpoints
                .filter((e) => e.kind === "frontend")
                .map((ep) => (
                  <span key={`fe-${ep.port}`} className="flex items-center gap-1">
                    <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
                    <button
                      type="button"
                      className="text-muted hover:text-text transition-colors"
                      title="Click to start frontend"
                      onClick={() => handleStart("frontend")}
                      disabled={startMutation.isPending}
                    >
                      {startMutation.isPending && startMutation.variables?.kind === "frontend"
                        ? "starting…"
                        : "localhost"}
                    </button>
                  </span>
                ))}
            {backends.map((ep) => (
              <span key={`be-${ep.port}`} className="flex items-center gap-1">
                <span
                  className={clsx(
                    "inline-block w-2 h-2 rounded-full",
                    ep.running ? "bg-done" : "bg-red-500",
                  )}
                />
                {ep.running ? (
                  <span className="text-muted">
                    {ep.label ?? "backend"}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="text-muted hover:text-text transition-colors"
                    title="Click to start backend"
                    onClick={() => handleStart("backend")}
                    disabled={startMutation.isPending}
                  >
                    {startMutation.isPending && startMutation.variables?.kind === "backend"
                      ? "starting…"
                      : ep.label ?? "backend"}
                  </button>
                )}
              </span>
            ))}
            {backends.length === 0 &&
              activeProject?.serverConfig?.endpoints
                .filter((e) => e.kind === "backend")
                .map((ep) => (
                  <span key={`be-${ep.port}`} className="flex items-center gap-1">
                    <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
                    <button
                      type="button"
                      className="text-muted hover:text-text transition-colors"
                      title="Click to start backend"
                      onClick={() => handleStart("backend")}
                      disabled={startMutation.isPending}
                    >
                      {startMutation.isPending && startMutation.variables?.kind === "backend"
                        ? "starting…"
                        : "backend"}
                    </button>
                  </span>
                ))}
          </div>
        )}
        {usage != null && (
          <div
            className="flex items-center gap-1.5"
            title={`Weekly: ${Math.round(usage.fraction * 100)}% (as of ${new Date(usage.updatedAt).toLocaleTimeString()})`}
          >
            <div className="w-24 h-2 rounded-full bg-border overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${Math.round(usage.fraction * 100)}%`,
                  backgroundColor: heatColor(usage.fraction),
                }}
              />
            </div>
            <span
              className="text-[10px] font-medium tabular-nums"
              style={{ color: heatColor(usage.fraction) }}
            >
              {Math.round(usage.fraction * 100)}%
            </span>
          </div>
        )}
        {actions}
      </div>
    </header>
  );
}
