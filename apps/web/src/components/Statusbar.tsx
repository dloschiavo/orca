import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { ServerEndpointPips } from "./ServerEndpointPips.js";

interface StatusbarProps {
  doneToday: number;
}

export function Statusbar({ doneToday }: StatusbarProps) {
  const qc = useQueryClient();

  const { data: projectsData } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.projects.list(),
    refetchInterval: 60_000,
  });

  const { data: statusData } = useQuery({
    queryKey: ["server-status"],
    queryFn: () => api.projects.serverStatus(),
    refetchInterval: 10_000,
  });

  const orca = (projectsData?.projects ?? []).find(
    (p) => p.name.toLowerCase() === "orca",
  );
  const orcaStatus = orca
    ? (statusData?.statuses ?? []).find((s) => s.projectId === orca.id)
    : undefined;

  return (
    <div className="statusbar">
      <div className="stb">
        <span>{doneToday} done today</span>
        <div className="stb-right">
          <div className="stb-server">
            {orca ? (
              <ServerEndpointPips
                projectId={orca.id}
                endpoints={orcaStatus?.endpoints ?? []}
                strayProcesses={orcaStatus?.strayProcesses ?? []}
                onChange={() =>
                  qc.invalidateQueries({ queryKey: ["server-status"] })
                }
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
