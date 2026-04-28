import { NavLink, useNavigate, useLocation } from "react-router-dom";
import clsx from "clsx";
import { useQuery } from "@tanstack/react-query";
import { useProjectContext } from "../state/ProjectContext.js";
import { api } from "../api.js";
import type { ServerStatus } from "@orca/shared";

// Linear-style left rail. Keep it dense, keyboard-friendly, no icons yet
// (that's one of the things we'll copy from notus/lucide post-MVP).

interface NavItem {
  to: string;
  label: string;
  countKey?: string;
  // `end` matches the path exactly so `/audit` doesn't stay active on `/audit/x`
  end?: boolean;
}

const SECTIONS: { title: string; items: NavItem[] }[] = [
  {
    title: "Pipeline",
    items: [
      { to: "/stories", label: "All", countKey: "stories" },
      { to: "/findings", label: "Findings" },
      { to: "/audit", label: "Audit" },
    ],
  },
  {
    title: "Admin",
    items: [
      { to: "/projects", label: "Projects" },
      { to: "/projects/add", label: "Add Project" },
      { to: "/agents", label: "Agents" },
      { to: "/recipes", label: "Recipes" },
    ],
  },
];

export function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { projects, activeProjectId, setActiveProjectId, isLoading } =
    useProjectContext();

  const { data: statusData } = useQuery({
    queryKey: ["server-status"],
    queryFn: () => api.projects.serverStatus(),
    refetchInterval: 10_000, // poll every 10s
  });
  const statusMap = new Map<string, ServerStatus>(
    (statusData?.statuses ?? []).map((s) => [s.projectId, s]),
  );

  const { data: storiesData } = useQuery({
    queryKey: ["stories", activeProjectId],
    queryFn: () =>
      activeProjectId
        ? api.stories.list({ projectId: activeProjectId })
        : Promise.resolve({ stories: [] }),
    enabled: !!activeProjectId,
  });
  const counts: Record<string, number> = {
    stories: storiesData?.stories.length ?? 0,
  };

  // Per-project in_progress / in_review counts for sidebar badges
  const { data: storyCounts } = useQuery({
    queryKey: ["story-counts"],
    queryFn: () => api.stories.counts(),
    refetchInterval: 30_000,
  });
  const projectBadges = new Map<
    string,
    { inProgress: number; inReview: number }
  >();
  for (const row of storyCounts?.counts ?? []) {
    const entry = projectBadges.get(row.projectId) ?? {
      inProgress: 0,
      inReview: 0,
    };
    if (row.status === "in_progress") entry.inProgress = row.count;
    if (row.status === "in_qa" || row.status === "final_review") entry.inReview += row.count;
    projectBadges.set(row.projectId, entry);
  }

  return (
    <aside className="w-56 shrink-0 h-full bg-surface border-r border-border flex flex-col">
      {/* Workspace label */}
      <div className="px-3 py-3 border-b border-border">
        <div className="text-[11px] uppercase tracking-wider text-muted">
          orca
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto py-2">
        {/* Projects section */}
        <div className="px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-muted px-1 pb-1">
            Projects
          </div>
          <ul className="space-y-0.5">
            {isLoading && (
              <li className="px-2 py-1 text-xs text-muted">loading…</li>
            )}
            {!isLoading && projects.length === 0 && (
              <li className="px-2 py-1 text-xs text-muted">no projects</li>
            )}
            {projects.map((p) => {
              const status = statusMap.get(p.id);
              const hasLiveStatus = !!status?.endpoints?.length;
              // Green only if ALL endpoints are running; red if any is down;
              // empty (border-only) dot if unknown (no config or no live status yet)
              const allRunning = hasLiveStatus
                ? status!.endpoints.every((e) => e.running)
                : false;
              const badges = projectBadges.get(p.id);
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveProjectId(p.id);
                      navigate(
                        location.pathname.startsWith("/audit")
                          ? "/audit"
                          : location.pathname === "/projects"
                          ? "/projects"
                          : "/stories",
                      );
                    }}
                    className={clsx(
                      "sidebar-link w-full text-left",
                      p.id === activeProjectId && "active",
                    )}
                  >
                    <span
                      className={clsx(
                        "inline-block w-2 h-2 rounded-full shrink-0",
                        hasLiveStatus
                          ? allRunning
                            ? "bg-done"
                            : "bg-red-500"
                          : "border border-muted",
                      )}
                    />
                    <span className="flex-1 truncate">{p.name}</span>
                    <span className="ml-auto flex items-center gap-1">
                      {badges?.inProgress ? (
                        <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-medium rounded bg-yellow-400 text-yellow-900">
                          {badges.inProgress}
                        </span>
                      ) : null}
                      {badges?.inReview ? (
                        <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-medium rounded bg-blue-200 text-blue-800">
                          {badges.inReview}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {SECTIONS.map((section) => (
          <div key={section.title} className="px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-muted px-1 pb-1">
              {section.title}
            </div>
            <ul className="space-y-0.5">
              {section.items.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      clsx("sidebar-link", isActive && "active")
                    }
                  >
                    <span className="flex-1 truncate">{item.label}</span>
                    {item.countKey && counts[item.countKey] != null && (
                      <span className="text-[10px] text-muted">
                        {counts[item.countKey]}
                      </span>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="px-3 py-2 border-t border-border text-[10px] text-muted">
        <span className="inline-block w-2 h-2 rounded-full bg-done mr-1.5" />
        connected · http://localhost:4455
      </div>
    </aside>
  );
}
