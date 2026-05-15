import type { ReactNode } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { api } from "../api.js";
import { useProjectContext } from "../state/ProjectContext.js";
import type { ServerStatus } from "@orca/shared";

/** Map 0-1 fraction to a green→yellow→red heatmap color. */
function heatColor(fraction: number): string {
  const f = Math.max(0, Math.min(1, fraction));
  if (f < 0.5) {
    const r = Math.round(255 * (f / 0.5));
    return `rgb(${r}, 200, 60)`;
  }
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

  const activeStatus: ServerStatus | undefined = activeProject
    ? statusData?.statuses?.find((s) => s.projectId === activeProject.id)
    : undefined;

  const frontends = activeStatus?.endpoints.filter((e) => e.kind === "frontend") ?? [];
  const backends = activeStatus?.endpoints.filter((e) => e.kind === "backend") ?? [];

  const hasConfig =
    (activeStatus?.endpoints?.length ?? 0) > 0 ||
    !!activeProject?.serverConfig?.endpoints?.length;

  function handleStart(kind: "frontend" | "backend") {
    if (!activeProject) return;
    startMutation.mutate({ id: activeProject.id, kind });
  }

  return (
    <header className="adm-head">
      <h1 className="adm-head-title">{title}</h1>
      {subtitle && <span className="adm-head-sub">{subtitle}</span>}
      <div className="adm-head-actions">
        {hasConfig && (
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {frontends.map((ep) => (
              <ServerPip key={`fe-${ep.port}`} running={ep.running}>
                {ep.running ? (
                  <a
                    href={`http://localhost:${ep.port}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "var(--ag-impl)", textDecoration: "none" }}
                  >
                    localhost:{ep.port}
                  </a>
                ) : (
                  <button
                    type="button"
                    className="adm-pip-btn"
                    title="Click to start frontend"
                    onClick={() => handleStart("frontend")}
                    disabled={startMutation.isPending}
                  >
                    {startMutation.isPending && startMutation.variables?.kind === "frontend"
                      ? "starting…"
                      : "localhost"}
                  </button>
                )}
              </ServerPip>
            ))}
            {frontends.length === 0 &&
              activeProject?.serverConfig?.endpoints
                .filter((e) => e.kind === "frontend")
                .map((ep) => (
                  <ServerPip key={`fe-${ep.port}`} running={false}>
                    <button
                      type="button"
                      className="adm-pip-btn"
                      title="Click to start frontend"
                      onClick={() => handleStart("frontend")}
                      disabled={startMutation.isPending}
                    >
                      {startMutation.isPending && startMutation.variables?.kind === "frontend"
                        ? "starting…"
                        : "localhost"}
                    </button>
                  </ServerPip>
                ))}
            {backends.map((ep) => (
              <ServerPip key={`be-${ep.port}`} running={ep.running}>
                {ep.running ? (
                  <span style={{ color: "var(--fg-2)" }}>{ep.label ?? "backend"}</span>
                ) : (
                  <button
                    type="button"
                    className="adm-pip-btn"
                    title="Click to start backend"
                    onClick={() => handleStart("backend")}
                    disabled={startMutation.isPending}
                  >
                    {startMutation.isPending && startMutation.variables?.kind === "backend"
                      ? "starting…"
                      : ep.label ?? "backend"}
                  </button>
                )}
              </ServerPip>
            ))}
            {backends.length === 0 &&
              activeProject?.serverConfig?.endpoints
                .filter((e) => e.kind === "backend")
                .map((ep) => (
                  <ServerPip key={`be-${ep.port}`} running={false}>
                    <button
                      type="button"
                      className="adm-pip-btn"
                      title="Click to start backend"
                      onClick={() => handleStart("backend")}
                      disabled={startMutation.isPending}
                    >
                      {startMutation.isPending && startMutation.variables?.kind === "backend"
                        ? "starting…"
                        : "backend"}
                    </button>
                  </ServerPip>
                ))}
          </div>
        )}
        {usage != null && (
          <div
            style={{ display: "flex", alignItems: "center", gap: 6 }}
            title={`Weekly: ${Math.round(usage.fraction * 100)}% (as of ${new Date(usage.updatedAt).toLocaleTimeString()})`}
          >
            <div
              style={{
                width: 88, height: 5, borderRadius: 4,
                background: "var(--bg-3)", overflow: "hidden",
                border: "1px solid var(--border-1)",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${Math.round(usage.fraction * 100)}%`,
                  backgroundColor: heatColor(usage.fraction),
                  transition: "width 400ms ease",
                }}
              />
            </div>
            <span
              style={{
                fontFamily: "var(--mono)", fontSize: 10.5,
                color: heatColor(usage.fraction), fontVariantNumeric: "tabular-nums",
              }}
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

function ServerPip({ running, children }: { running: boolean; children: ReactNode }) {
  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-2)",
      }}
    >
      <span
        style={{
          width: 6, height: 6, borderRadius: "50%",
          background: running ? "var(--attn-mid)" : "var(--attn-error)",
          flexShrink: 0,
          animation: running ? "dot-blink 2.4s ease-in-out infinite" : "none",
        }}
      />
      {children}
    </span>
  );
}
