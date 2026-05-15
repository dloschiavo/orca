import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { useProjectContext } from "../state/ProjectContext.js";
import { ServerEndpointPips } from "./ServerEndpointPips.js";

interface TopbarProps {
  activeCount: number;
  queueDepth: number;
  nextTickIn: number;
}

export function Topbar({ activeCount, queueDepth, nextTickIn }: TopbarProps) {
  const { activeProjectId } = useProjectContext();
  const qc = useQueryClient();

  const { data: statusData } = useQuery({
    queryKey: ["server-status"],
    queryFn: () => api.projects.serverStatus(),
    refetchInterval: 10_000,
  });

  const projectStatus = (statusData?.statuses ?? []).find(
    (s) => s.projectId === activeProjectId,
  );

  return (
    <div className="topbar">
      <div className="tb">
        <div className="tb-brand">
          <div className="tb-logo" />
          <div className="tb-brand-name">Orca</div>
          <div className="tb-brand-meta">v0</div>
        </div>

        <div className="tb-server">
          <ServerEndpointPips
            projectId={activeProjectId}
            endpoints={projectStatus?.endpoints ?? []}
            strayProcesses={projectStatus?.strayProcesses ?? []}
            onChange={() =>
              qc.invalidateQueries({ queryKey: ["server-status"] })
            }
          />
        </div>

        <div className="tb-status">
          <span className="tb-counter">
            <span className="tb-counter-pulse" />
            <span className="num">{activeCount}</span>
            <span className="lbl">agent{activeCount === 1 ? "" : "s"} working</span>
          </span>
          <span className="tb-sep">·</span>
          <span className="tb-counter">
            <span className="num">{queueDepth}</span>
            <span className="lbl">queued</span>
          </span>
          <span className="tb-sep">·</span>
          <span className="tb-counter">
            <span className="lbl">next tick</span>
            <code className="num mono">{nextTickIn}s</code>
          </span>
        </div>
      </div>
    </div>
  );
}

