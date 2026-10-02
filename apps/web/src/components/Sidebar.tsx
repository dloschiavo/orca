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
import type { Story, ServerStatus } from "@orca/shared";
import { resolveAgentDisplay } from "../utils/agentStyle.js";

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

  // Per-project dev-server status (frontend + backend ports). Shared query key
  // with PageHeader/ProjectsPage so React Query deduplicates the poll.
  const { data: statusData } = useQuery({
    queryKey: ["server-status"],
    queryFn: () => api.projects.serverStatus(),
    refetchInterval: 10_000,
  });
  const statusByProject = new Map<string, ServerStatus>(
    (statusData?.statuses ?? []).map((s) => [s.projectId, s]),
  );

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

  // Live PRD/audit dispatches (drafter / full-stack-engineer / audit-runner).
  // DB-only endpoint — cheap, no per-project disk scan.
  const { data: activeAgentsData } = useQuery({
    queryKey: ["active-agents-sidebar"],
    queryFn: () => api.activeAgents.list(),
    refetchInterval: 5_000,
  });

  // Group active-agent work by agent name. "Agent working" = a live dispatched
  // process (dispatchPid != null for stories; a row in /active-agents for
  // prds/audits). Items carry the thing being processed so the row can show it.
  const agentBuckets = new Map<string, ActiveItem[]>();
  for (const s of allStories) {
    if (s.dispatchPid == null) continue;
    const name = s.agentOverride ?? s.agent;
    if (!name) continue;
    const bucket = agentBuckets.get(name) ?? [];
    bucket.push({ kind: "story", id: s.id, label: s.title });
    agentBuckets.set(name, bucket);
  }
  for (const d of activeAgentsData?.dispatches ?? []) {
    const bucket = agentBuckets.get(d.agent) ?? [];
    bucket.push({ kind: d.kind, id: d.id, label: d.label });
    agentBuckets.set(d.agent, bucket);
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

  // A project pulses when any of its stories — or PRDs/audits — has a live agent.
  const projectsWithActiveAgent = new Set<string>();
  for (const s of allStories) {
    if (s.dispatchPid != null) projectsWithActiveAgent.add(s.projectId);
  }
  for (const d of activeAgentsData?.dispatches ?? []) projectsWithActiveAgent.add(d.projectId);

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
        {projects.map((p) => {
          const active = p.id === activeProjectId;
          const badges = projectBadges.get(p.id);
          const hasActive = projectsWithActiveAgent.has(p.id);
          const status = statusByProject.get(p.id);
          return (
            <div
              key={p.id}
              className={"sb-item" + (active ? " active" : "")}
              onClick={() => handleProjectClick(p.id)}
            >
              <ProjectStatusPip status={status} />
              <span className="sb-name">{p.name}</span>
              {hasActive && (
                <span className="typing" style={{ color: "var(--attn-mid)" }} title="agent active">
                  <i /><i /><i />
                </span>
              )}
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
        {activeAgentRows.map(([name, items]) => (
          <AgentRow key={name} agentName={name} items={items} />
        ))}
        {humanStories.length > 0 && (
          <AgentRow
            agentName="__human__"
            items={humanStories.map((s) => ({ kind: "story" as const, id: s.id, label: s.title }))}
          />
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
    </aside>
  );
}

interface ActiveItem {
  kind: "story" | "prd" | "audit";
  id: string;
  label: string;
}

interface AgentRowProps {
  agentName: string;
  items: ActiveItem[];
}

const AGENT_TASK_LABEL: Record<string, string> = {
  "spec-writer":  "asking questions",
  "scrum-master": "planning",
  "reviewer":     "verifying",
  "auditor":      "auditing",
  "drafter":      "drafting",
  "full-stack-engineer": "implementing",
  "audit-runner": "auditing",
  "__human__":    "awaiting you",
};

const ITEM_ROUTE: Record<ActiveItem["kind"], string> = {
  story: "stories",
  prd: "prds",
  audit: "audits",
};

function AgentRow({ agentName, items }: AgentRowProps) {
  const navigate = useNavigate();
  const isHuman = agentName === "__human__";
  const { icon, color } = isHuman
    ? { icon: faUser, color: "var(--ag-human)" }
    : resolveAgentDisplay(agentName);
  const label = isHuman ? "you" : agentName;
  // When the agent is on exactly one item, show that item's title (which one
  // it's processing); otherwise fall back to the task verb + count.
  const taskText = items.length === 1 ? items[0]!.label : AGENT_TASK_LABEL[agentName] ?? "working";
  const first = items[0];

  return (
    <div
      className="sb-agent"
      title={items.map((i) => i.label).join("\n")}
      onClick={() => first && navigate(`/${ITEM_ROUTE[first.kind]}/${first.id}`)}
    >
      <span className="sb-agent-glyph" style={{ color }}>
        <FontAwesomeIcon icon={icon} />
      </span>
      <div style={{ display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        <span className="sb-agent-name">{label}</span>
        <span className="sb-agent-task">
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              display: "inline-block",
              maxWidth: 108,
              verticalAlign: "bottom",
            }}
          >
            {taskText}
          </span>
          {!isHuman && (
            <span className="typing" style={{ marginLeft: 4, color }}>
              <i /><i /><i />
            </span>
          )}
        </span>
      </div>
      <span className="sb-agent-count">{items.length}</span>
    </div>
  );
}

// Tri-state service health:
//   all   — every declared/discovered service is up (green, blinking)
//   some  — at least one up but not all (yellow, blinking)
//   none  — nothing up, or no services known (red, static)
type ProjectHealth = "all" | "some" | "none";

function projectHealth(status: ServerStatus | undefined): ProjectHealth {
  if (!status || status.endpoints.length === 0) return "none";
  const running = status.endpoints.filter((e) => e.running).length;
  if (running === 0) return "none";
  if (running === status.endpoints.length) return "all";
  return "some";
}

function ProjectStatusPip({ status }: { status: ServerStatus | undefined }) {
  const health = projectHealth(status);
  const title = !status
    ? "no server config"
    : status.endpoints.length === 0
      ? "no endpoints"
      : status.endpoints
          .map((e) => `${e.framework}:${e.port} ${e.running ? "up" : "down"}`)
          .join(" · ");
  // Tri-state palette: green (all), yellow (some), red (none). The yellow
  // is inlined because the design system's `--attn-high` is an amber that
  // reads as too close to the red `--attn-error` at 7px.
  const background =
    health === "all"
      ? "var(--attn-done)"
      : health === "some"
        ? "oklch(0.88 0.18 100)"
        : "var(--attn-error)";
  return (
    <span
      title={title}
      style={{
        width: 7,
        height: 7,
        borderRadius: "50%",
        background,
        flexShrink: 0,
        animation:
          health === "none" ? "none" : "dot-blink 2.4s ease-in-out infinite",
      }}
    />
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
