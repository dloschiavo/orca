import { useNavigate, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faUser, faClock, faFlag, faComments, faListCheck,
  faRobot, faBook, faGear,
} from "@fortawesome/free-solid-svg-icons";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { useProjectContext } from "../state/ProjectContext.js";
import { api } from "../api.js";
import type { Story } from "@orca/shared";
import { resolveAgentDisplay } from "../utils/agentStyle.js";

// Project dot colors — cycled by index
const PROJECT_COLORS = [
  "oklch(0.78 0.16 145)",
  "oklch(0.78 0.15 60)",
  "oklch(0.78 0.14 250)",
  "oklch(0.78 0.14 320)",
  "oklch(0.78 0.10 200)",
];

export function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { projects, activeProjectId, setActiveProjectId, isLoading } = useProjectContext();

  // Per-project story counts for badges
  const { data: storyCounts } = useQuery({
    queryKey: ["story-counts"],
    queryFn: () => api.stories.counts(),
    refetchInterval: 5_000,
  });

  // All stories (for agent activity buckets)
  const { data: allStoriesData } = useQuery({
    queryKey: ["all-stories-sidebar"],
    queryFn: async () => {
      if (projects.length === 0) return { stories: [] as Story[] };
      const results = await Promise.all(
        projects.map((p) => api.stories.list({ projectId: p.id }))
      );
      return { stories: results.flatMap((r) => r.stories) };
    },
    enabled: projects.length > 0,
    refetchInterval: 10_000,
  });

  const allStories = allStoriesData?.stories ?? [];

  // Group active-agent stories by their assigned agent name
  const agentBuckets = new Map<string, Story[]>();
  for (const s of allStories) {
    if (s.status !== "planning" && s.status !== "implementing" && s.status !== "qa") continue;
    const name = s.agentOverride ?? s.agent ?? "(unknown)";
    const bucket = agentBuckets.get(name) ?? [];
    bucket.push(s);
    agentBuckets.set(name, bucket);
  }
  const activeAgentRows = Array.from(agentBuckets.entries()).sort(([a], [b]) => a.localeCompare(b));

  const humanStories = allStories.filter((s) => s.status === "review" || s.status === "blocked");

  const projectBadges = new Map<string, { planning: number; implementing: number; qa: number; review: number }>();
  for (const row of storyCounts?.counts ?? []) {
    const entry = projectBadges.get(row.projectId) ?? { planning: 0, implementing: 0, qa: 0, review: 0 };
    if (row.status === "planning") entry.planning += row.count;
    if (row.status === "implementing") entry.implementing += row.count;
    if (row.status === "qa") entry.qa += row.count;
    if (row.status === "review") entry.review += row.count;
    projectBadges.set(row.projectId, entry);
  }

  // Count stories waiting on the human (planning = spec-writer asking questions, review/blocked = needs your input)
  const planningStories = allStories.filter((s) => s.status === "planning");
  const waitingOnMe = planningStories.length + humanStories.length;

  function handleProjectClick(projectId: string) {
    setActiveProjectId(projectId);
    navigate(
      location.pathname === "/projects"
        ? "/projects"
        : "/stories",
    );
  }

  return (
    <aside className="sidebar">
      <div style={{ overflow: "auto", flex: 1, minHeight: 0 }}>
        {/* Projects */}
        <div className="sb-section">
          <span>Projects</span>
          <span className="plus" title="Add project" onClick={() => navigate("/projects/add")}>+</span>
        </div>
        {isLoading && <div style={{ padding: "6px var(--pad-x)", color: "var(--fg-3)", fontSize: 11.5 }}>loading…</div>}
        {projects.map((p, i) => {
          const active = p.id === activeProjectId;
          const badges = projectBadges.get(p.id);
          const hasActive = (badges?.implementing ?? 0) + (badges?.qa ?? 0) > 0;
          const projectColor = PROJECT_COLORS[i % PROJECT_COLORS.length]!;
          return (
            <div
              key={p.id}
              className={"sb-item" + (active ? " active" : "")}
              onClick={() => handleProjectClick(p.id)}
            >
              <span className="sb-dot" style={{ background: projectColor }} />
              <span className="sb-name">{p.name}</span>
              {hasActive && <span className="sb-active-pulse" title="agent active" />}
              {badges && (badges.planning + badges.implementing + badges.qa + badges.review) > 0 && (
                <span className="sb-count">
                  {badges.planning + badges.implementing + badges.qa + badges.review}
                </span>
              )}
            </div>
          );
        })}

        <div className="sb-divider" />

        {/* Active agents — rendered dynamically from story.agent groupings */}
        <div className="sb-section"><span>Active agents</span></div>
        {activeAgentRows.length === 0 && humanStories.length === 0 && (
          <div style={{ padding: "4px var(--pad-x)", color: "var(--fg-3)", fontSize: 11.5 }}>all idle</div>
        )}
        {activeAgentRows.map(([name, stories]) => (
          <AgentRow key={name} agentName={name} stories={stories} />
        ))}
        {humanStories.length > 0 && (
          <AgentRow agentName="__human__" stories={humanStories} />
        )}

        <div className="sb-divider" />

        {/* Views */}
        <div className="sb-section"><span>Views</span></div>
        <SbLink icon={faClock}      name="Waiting on me" count={waitingOnMe} onClick={() => navigate("/stories")} />
        <SbLink icon={faFlag}       name="Blocked" count={allStories.filter((s) => s.status === "blocked").length} onClick={() => navigate("/stories")} />
        <SbLink icon={faComments}   name="Refinement Q&A" onClick={() => navigate("/refinement-qa")} />
        <SbLink icon={faListCheck}  name="Findings" onClick={() => navigate("/findings")} />

        <div className="sb-divider" />

        {/* Admin */}
        <div className="sb-section"><span>Admin</span></div>
        <SbLink icon={faRobot} name="Agents" onClick={() => navigate("/agents")} />
        <SbLink icon={faBook}  name="Recipes" onClick={() => navigate("/recipes")} />
        <SbLink icon={faGear}  name="Settings" onClick={() => navigate("/settings")} />
      </div>

      <div style={{
        borderTop: "1px solid var(--border-0)", padding: "8px var(--pad-x)",
        fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-3)",
        display: "flex", alignItems: "center",
      }}>
        <span style={{ marginLeft: "auto" }}>j ↕ · ⏎ open</span>
      </div>
    </aside>
  );
}

interface AgentRowProps {
  agentName: string;
  stories: Story[];
}

const AGENT_TASK_LABEL: Record<string, string> = {
  "spec-writer":  "asking questions",
  "scrum-master": "planning",
  "reviewer":     "verifying",
  "auditor":      "auditing",
  "__human__":    "awaiting you",
};

function AgentRow({ agentName, stories }: AgentRowProps) {
  const isHuman = agentName === "__human__";
  const { icon, color } = isHuman
    ? { icon: faUser, color: "var(--ag-human)" }
    : resolveAgentDisplay(agentName);
  const label = isHuman ? "you" : agentName;
  const taskLabel = AGENT_TASK_LABEL[agentName] ?? "working";

  return (
    <div className="sb-agent" title={stories.map((s) => s.id).join(", ")}>
      <span className="sb-agent-glyph" style={{ color }}>
        <FontAwesomeIcon icon={icon} />
      </span>
      <div style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <span className="sb-agent-name">{label}</span>
        <span className="sb-agent-task">
          {taskLabel}
          {!isHuman && (
            <span className="typing" style={{ marginLeft: 4, color }}>
              <i /><i /><i />
            </span>
          )}
        </span>
      </div>
      <span className="sb-agent-count">{stories.length}</span>
    </div>
  );
}

function SbLink({ icon, name, count, onClick }: { icon: IconDefinition; name: string; count?: number; onClick?: () => void }) {
  return (
    <div className="sb-item" onClick={onClick} style={{ cursor: onClick ? "default" : undefined }}>
      <FontAwesomeIcon icon={icon} style={{ color: "var(--fg-3)", width: 12, flexShrink: 0 }} />
      <span className="sb-name" style={{ marginLeft: 6 }}>{name}</span>
      {count != null && <span className="sb-count">{count}</span>}
    </div>
  );
}
