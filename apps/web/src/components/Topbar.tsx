import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";

interface TopbarProps {
  activeCount: number;
  queueDepth: number;
  nextTickIn: number;
  shippedToday: number;
}

export function Topbar({ activeCount, queueDepth, nextTickIn, shippedToday }: TopbarProps) {
  const { data: statusData } = useQuery({
    queryKey: ["server-status"],
    queryFn: () => api.projects.serverStatus(),
    refetchInterval: 10_000,
  });

  const serverUp = (statusData?.statuses ?? []).some(
    (s) => s.endpoints?.some((e) => e.running)
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
          <span className="tb-server-dot" style={serverUp ? {} : { background: "var(--attn-error)" }} />
          <span className="tb-server-label">server</span>
          <code className="tb-server-host">localhost:4455</code>
          <span className="tb-server-sep">·</span>
          <span className="tb-server-meta">{shippedToday} shipped today</span>
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
          <span className="tb-key">⌘ K</span>
        </div>
      </div>
    </div>
  );
}
