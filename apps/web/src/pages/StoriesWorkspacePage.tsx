import React, { useState, useEffect, useRef, useCallback } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ActivityEvent } from "../api.js";
import type { RefinementQuestion, Story, StoryStatus } from "@orca/shared";
import { NewStoryModal } from "../components/NewStoryModal.js";
import { useProjectContext } from "../state/ProjectContext.js";
import { useStoryEventStream } from "../hooks/useStoryEventStream.js";
import { USER_LABEL, resolveAgentDisplay } from "../utils/agentStyle.js";
import { formatElapsed } from "../utils/formatters.js";
import {
  renderEvent,
  shortenHome,
  isHideableToolUse,
  extractContent,
  parseDiffStats,
} from "../utils/activity.js";
import { renderMarkdown, parseInlineMarkdown, maybePrettyJson } from "../utils/markdown.js";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faEllipsis } from "@fortawesome/free-solid-svg-icons";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";

// ── Stage config ────────────────────────────────────────────────────────────

type Tier = "high" | "mid" | "low" | "done" | "dead";

interface StageConfig {
  short: string;
  color: string;
  tier: Tier;
}

const STAGE_CONFIG: Record<StoryStatus, StageConfig> = {
  blocked:     { short: "Blocked",  color: "var(--st-blocked)",        tier: "high" },
  canceled:    { short: "Cancelled",color: "var(--st-cancelled)",      tier: "dead" },
  icebox:      { short: "Icebox",   color: "var(--st-icebox)",         tier: "low"  },
  planning:    { short: "Planning", color: "var(--st-planning)",       tier: "high" },
  backlog:     { short: "Backlog",  color: "var(--st-backlog)",        tier: "low"  },
  implementing:{ short: "Building", color: "var(--st-implementation)", tier: "mid"  },
  qa:          { short: "In QA",   color: "var(--st-qa)",             tier: "mid"  },
  review:      { short: "Review",  color: "var(--st-review)",         tier: "high" },
  done:        { short: "Shipped", color: "var(--st-done)",           tier: "done" },
};

function getAgent(name: string | null) {
  if (!name) return null;
  const { icon, color } = resolveAgentDisplay(name);
  return { icon, color, label: name };
}

// ── Token formatter ───────────────────────────────────────────────────────────

function fmtTokens(n: number | null | undefined): string {
  if (!n) return "—";
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1) + "k";
  if (n < 1_000_000) return Math.round(n / 1000) + "k";
  return (n / 1_000_000).toFixed(1) + "M";
}

// ── Relative time ─────────────────────────────────────────────────────────────

function relTime(ts: string): string {
  const delta = Date.now() - new Date(ts).getTime();
  const m = Math.floor(delta / 60_000);
  if (m < 1) return "now";
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h";
  return Math.floor(h / 24) + "d";
}

// ── Stage pill ────────────────────────────────────────────────────────────────

function StagePill({ status, active }: { status: StoryStatus; active?: boolean }) {
  const s = STAGE_CONFIG[status];
  if (!s) return null;
  const classes = ["pill", active ? "active" : "", s.tier === "high" ? "attn-high" : ""].filter(Boolean).join(" ");
  return (
    <span className={classes} style={{ color: s.color }}>
      <span className="pill-dot" />
      {s.short}
    </span>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

const STATUS_ALL: StoryStatus[] = [
  "blocked", "canceled", "icebox", "planning", "backlog", "implementing", "qa", "review", "done",
];

export function StoriesWorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { activeProjectId, activeProject } = useProjectContext();
  useStoryEventStream(activeProjectId);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<"all" | "mine" | "active">("all");

  const queryClient = useQueryClient();

  const { data: agentsData } = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.agents.list(),
  });

  const createMut = useMutation({
    mutationFn: (body: { title: string; specMd: string; status: "icebox" | "planning" | "backlog"; agent: string }) =>
      api.stories.create({ projectId: activeProjectId!, ...body }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["stories"] });
      queryClient.invalidateQueries({ queryKey: ["story-counts"] });
      setCreating(false);
      if (result?.story?.id) navigate(`/stories/${result.story.id}`);
    },
  });

  if (!activeProjectId) {
    return (
      <div className="pane-list" style={{ flex: 1 }}>
        <div className="sd-empty">
          No project selected. <Link to="/projects" style={{ color: "var(--ag-impl)" }}>Create one</Link>.
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>
      <StoryList
        activeProjectId={activeProjectId}
        activeProject={activeProject}
        selectedId={id ?? null}
        filter={filter}
        onSetFilter={setFilter}
        onNewStory={() => setCreating(true)}
      />

      <div className="pane-detail" style={{ flex: "1.6 1 0", minWidth: 480 }}>
        {id ? (
          <StoryDetailPanel id={id} />
        ) : (
          <div className="sd-empty">
            select a story to see spec,<br />inline questions, and agent history
          </div>
        )}
      </div>

      {creating && (
        <NewStoryModal
          onClose={() => setCreating(false)}
          onSubmit={(body) => createMut.mutate(body)}
          submitting={createMut.isPending}
          agents={agentsData?.agents ?? []}
        />
      )}
    </div>
  );
}

// ── Story list (left pane) ────────────────────────────────────────────────────

interface StoryListProps {
  activeProjectId: string;
  activeProject: { id: string; name: string } | null;
  selectedId: string | null;
  filter: "all" | "mine" | "active";
  onSetFilter: (f: "all" | "mine" | "active") => void;
  onNewStory: () => void;
}

function StoryList({ activeProjectId, activeProject, selectedId, filter, onSetFilter, onNewStory }: StoryListProps) {
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: ["stories", activeProjectId],
    queryFn: () =>
      activeProjectId
        ? api.stories.list({ projectId: activeProjectId })
        : Promise.resolve({ stories: [] as Story[] }),
    enabled: !!activeProjectId,
    refetchInterval: 15_000,
  });

  const stories = data?.stories ?? [];

  const filtered = React.useMemo(() => {
    if (filter === "mine") return stories.filter((s) => s.status === "planning" || s.status === "review" || s.status === "blocked");
    if (filter === "active") return stories.filter((s) => s.dispatchPid != null);
    return stories;
  }, [stories, filter]);

  const counts = {
    all: stories.length,
    mine: stories.filter((s) => s.status === "planning" || s.status === "review" || s.status === "blocked").length,
    active: stories.filter((s) => s.dispatchPid != null).length,
  };

  // Auto-select the first story when none is selected (e.g. on project open)
  useEffect(() => {
    if (!selectedId && !isLoading && filtered.length > 0) {
      navigate(`/stories/${filtered[0]!.id}`, { replace: true });
    }
  }, [selectedId, isLoading, filtered, navigate]);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "TEXTAREA" || (e.target as HTMLElement).tagName === "INPUT") return;
      if (e.key === "j" || e.key === "ArrowDown") {
        const idx = filtered.findIndex((s) => s.id === selectedId);
        const next = filtered[Math.min(filtered.length - 1, idx + 1)];
        if (next) navigate(`/stories/${next.id}`);
        e.preventDefault();
      } else if (e.key === "k" || e.key === "ArrowUp") {
        const idx = filtered.findIndex((s) => s.id === selectedId);
        const next = filtered[Math.max(0, idx - 1)];
        if (next) navigate(`/stories/${next.id}`);
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [filtered, selectedId, navigate]);

  const projectName = activeProject?.name ?? "…";

  return (
    <div className="pane-list" style={{ flex: "1.1 1 0", minWidth: 380 }}>
      <div className="pl-toolbar">
        <span className="pl-title">{projectName}</span>
        <span className="pl-count">{isLoading ? "…" : `${filtered.length}/${stories.length}`}</span>
        <div className="pl-chips">
          <Chip label="all" count={counts.all} active={filter === "all"} onClick={() => onSetFilter("all")} />
          <Chip label="waiting on me" count={counts.mine} active={filter === "mine"} color="var(--attn-high)" onClick={() => onSetFilter("mine")} />
          <Chip label="active" count={counts.active} active={filter === "active"} color="var(--ag-impl)" onClick={() => onSetFilter("active")} />
        </div>
        <span className="pl-new" onClick={onNewStory} title="Create story (C)">
          <span className="pl-new-plus">+</span>
          <span>New story</span>
        </span>
      </div>

      <div className="pl-head">
        <span>ID</span>
        <span>Title</span>
        <span>Stage</span>
        <span>Agent</span>
        <span style={{ textAlign: "right" }}>Tokens</span>
        <span style={{ textAlign: "right" }}>Upd</span>
      </div>

      <div className="pl-rows">
        {isLoading && (
          <div style={{ padding: "20px var(--pad-x)", color: "var(--fg-3)", fontFamily: "var(--mono)", fontSize: 11.5 }}>
            loading…
          </div>
        )}
        {!isLoading && filtered.length === 0 && (
          <div style={{ padding: "40px", textAlign: "center", color: "var(--fg-3)", fontFamily: "var(--mono)", fontSize: 12 }}>
            ∅ no stories match this filter
          </div>
        )}
        {filtered.map((story) => (
          <StoryRow
            key={story.id}
            story={story}
            active={story.id === selectedId}
            onClick={() => navigate(`/stories/${story.id}`)}
          />
        ))}
        <div style={{ padding: "10px var(--pad-x)", color: "var(--fg-4)", fontFamily: "var(--mono)", fontSize: 11, display: "flex", alignItems: "center", gap: 8 }}>
          <span>+</span>
          <span style={{ cursor: "default" }} onClick={onNewStory}>Quick-capture a story…</span>
          <span className="kbd" style={{ marginLeft: "auto" }}>C</span>
        </div>
      </div>
    </div>
  );
}

function StoryRow({ story, active, onClick }: { story: Story; active: boolean; onClick: () => void }) {
  const agent = getAgent(story.agent);
  const isAgentActive = story.dispatchPid != null;
  const stage = STAGE_CONFIG[story.status];
  const rowClasses = [
    "pl-row",
    active ? "active" : "",
    stage?.tier === "high" ? "attn-high" : "",
    stage?.tier === "done" ? "tier-done" : "",
    stage?.tier === "dead" ? "tier-dead" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={rowClasses} onClick={onClick}>
      <div className="pl-cell-id">#{story.id.slice(0, 7)}</div>
      <div className="pl-cell-title">{story.title}</div>
      <div className="pl-cell-stage">
        <StagePill status={story.status} active={isAgentActive} />
      </div>
      <div className="pl-cell-agent">
        {agent ? (
          <>
            <FontAwesomeIcon icon={agent.icon} style={{ color: agent.color }} />
            <span style={{ color: "var(--fg-2)", fontSize: 11 }}>{agent.label}</span>
            {isAgentActive && (
              <span className="typing" style={{ color: agent.color, marginLeft: 2 }}>
                <i /><i /><i />
              </span>
            )}
          </>
        ) : (
          <span style={{ color: "var(--fg-4)" }}>—</span>
        )}
      </div>
      <div
        className="pl-cell-tokens"
        title={story.totalTokensUsed != null ? story.totalTokensUsed.toLocaleString() + " tokens" : "no tokens used yet"}
      >
        {story.totalTokensUsed ? fmtTokens(story.totalTokensUsed) : <span style={{ color: "var(--fg-4)" }}>—</span>}
      </div>
      <div className="pl-cell-updated">{relTime(story.updatedAt)}</div>
    </div>
  );
}

function Chip({ label, count, active, color, onClick }: { label: string; count: number; active: boolean; color?: string; onClick: () => void }) {
  return (
    <span className={"pl-chip" + (active ? " active" : "")} onClick={onClick}>
      {color && <span className="pl-chip-dot" style={{ background: color }} />}
      <span>{label}</span>
      <span style={{ color: "var(--fg-3)" }}>{count}</span>
    </span>
  );
}

// ── Story detail (right pane) ─────────────────────────────────────────────────

type DetailTab = "spec" | "history" | "controls" | "original";

function StoryDetailPanel({ id }: { id: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<DetailTab>("spec");
  const [commentBody, setCommentBody] = useState("");
  const [commentInterrupt, setCommentInterrupt] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["story", id],
    queryFn: () => api.stories.get(id),
    enabled: !!id,
    refetchInterval: (q) => {
      const s = q.state.data?.story.status;
      return s === "implementing" ? 3000 : 15_000;
    },
  });

  // Switch to history tab when story is in blocked/review stage
  useEffect(() => {
    if (!data) return;
    const s = data.story.status;
    if (s === "blocked" || s === "review") setTab("history");
    else setTab("spec");
  }, [data?.story?.id]);

  // Reset on story switch
  useEffect(() => {
    setMenuOpen(false);
    setCommentBody("");
  }, [id]);

  const dispatchMut = useMutation({
    mutationFn: () => api.stories.dispatch(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["story", id] });
      queryClient.invalidateQueries({ queryKey: ["stories"] });
      queryClient.invalidateQueries({ queryKey: ["story-counts"] });
    },
  });

  const stopMut = useMutation({
    mutationFn: () => api.stories.stop(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["story", id] });
      queryClient.invalidateQueries({ queryKey: ["stories"] });
      queryClient.invalidateQueries({ queryKey: ["story-counts"] });
    },
  });

  const patchMut = useMutation({
    mutationFn: (body: { title?: string; specMd?: string; status?: StoryStatus; agent?: string | null }) =>
      api.stories.patch(id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["story", id] });
      queryClient.invalidateQueries({ queryKey: ["stories"] });
      queryClient.invalidateQueries({ queryKey: ["story-counts"] });
    },
  });

  const deleteMut = useMutation({
    mutationFn: () => api.stories.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stories"] });
      queryClient.invalidateQueries({ queryKey: ["story-counts"] });
      navigate("/stories");
    },
  });

  const commentMut = useMutation({
    mutationFn: () => api.stories.comment(id, { body: commentBody, interrupt: commentInterrupt }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["story", id] });
      setCommentBody("");
    },
  });

  const { data: agentsData } = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.agents.list(),
  });

  // ⋯ menu outside-click
  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (menuBtnRef.current && menuBtnRef.current.contains(target)) return;
      const drop = document.getElementById("story-actions-menu");
      if (drop && drop.contains(target)) return;
      setMenuOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [menuOpen]);

  if (isLoading || !data) {
    return (
      <div className="sd-empty" style={{ paddingTop: 60 }}>loading…</div>
    );
  }

  const { story, activity: rawActivity, refinementQuestions: rawQuestions } = data;
  const openQuestions = (rawQuestions ?? []).filter((q) => q.status === "open");
  const answeredQuestions = (rawQuestions ?? []).filter((q) => q.status === "answered");

  const stage = STAGE_CONFIG[story.status];
  const agent = getAgent(story.agent);
  const isAgentActive = story.dispatchPid != null;
  const running = story.status === "implementing";
  const dispatchable = story.status !== "implementing";

  const toggleMenu = () => {
    if (!menuOpen) {
      const r = menuBtnRef.current?.getBoundingClientRect();
      if (r) setMenuPos({ top: r.bottom + 4, left: r.right - 160 });
    }
    setMenuOpen((v) => !v);
  };

  const handleRespec = async () => {
    setMenuOpen(false);
    if (story.agent !== "spec-writer") {
      await patchMut.mutateAsync({ agent: "spec-writer" });
    }
    dispatchMut.mutate();
  };

  const handleDelete = () => {
    setMenuOpen(false);
    if (confirm(`Delete "${story.title}"? This cannot be undone.`)) deleteMut.mutate();
  };

  // Build workspace path for activity filtering
  const workspace: string | undefined = [...rawActivity]
    .reverse()
    .find((e: ActivityEvent) => e.kind === "dispatch_started")
    ?.payload?.repoPath as string | undefined;

  const droppedInstanceIds = new Set<string>();
  for (const e of rawActivity) {
    if (e.kind !== "dispatch_dropped") continue;
    const instId = e.dispatchInstanceId;
    if (instId) droppedInstanceIds.add(instId);
  }

  const activity = rawActivity.filter((e) => {
    if (e.kind === "story_created") return false;
    if (e.kind === "comment" || e.kind === "agent_prompt" || e.kind === "agent_transition" || e.kind === "state_transition") return true;
    if (e.kind === "dispatch_started") {
      const p = e.payload as Record<string, unknown> | undefined;
      if (workspace && p?.repoPath === workspace) return false;
      return true;
    }
    if (e.kind === "dispatch_claim") {
      const instId = e.dispatchInstanceId;
      if (instId && droppedInstanceIds.has(instId)) return false;
      return true;
    }
    if (e.kind === "dispatch_dropped") {
      const p = e.payload as Record<string, unknown> | undefined;
      if (p?.reason === "another_active_dispatch") return false;
      return true;
    }
    if (e.kind !== "agent_stream") return true;
    const p = e.payload as Record<string, unknown>;
    const type = p.type as string | undefined;
    if (!type && p.result === "clear") return false;
    if (type === "system") {
      const sub = p.subtype as string | undefined;
      if (sub === "task_started" || sub === "task_progress" || sub === "task_notification" || sub === "init" || sub === "compact_boundary" || sub === "status" || sub === "post_turn_summary") return false;
      return true;
    }
    if (type === "user") return false;
    if (type === "assistant") {
      const content = extractContent(p);
      if (content.length === 0) return false;
      const hasNonEmptyText = content.some((c) => c.type === "text" && (c.text ?? "").trim() !== "");
      const toolUses = content.filter((c) => c.type === "tool_use");
      if (toolUses.length === 0 && !hasNonEmptyText) return false;
      if (hasNonEmptyText) return true;
      if (toolUses.length > 0 && toolUses.every((c) => isHideableToolUse(c.name ?? "", c.input, workspace))) return false;
      return true;
    }
    if (workspace && JSON.stringify(p).includes(`spawning claude-local in ${workspace}`)) return false;
    return true;
  });

  return (
    <>
      <div className="sd-head">
        <div className="sd-head-row">
          <div className="sd-head-tokens" title={story.totalTokensUsed != null ? story.totalTokensUsed.toLocaleString() + " tokens" : "no tokens used"}>
            <span className="sd-head-tokens-arrow">Σ</span>
            <span className="sd-head-tokens-val">{fmtTokens(story.totalTokensUsed)}</span>
            <span className="sd-head-tokens-lbl">tokens</span>
            {story.totalCostUsd != null && (
              <>
                <span className="sd-head-sep">·</span>
                <span className="sd-head-tokens-val">${story.totalCostUsd.toFixed(2)}</span>
                <span className="sd-head-tokens-lbl">cost</span>
              </>
            )}
          </div>
          <span className="sd-head-author" style={{ marginLeft: "auto", color: "var(--fg-2)", fontSize: 11.5 }}>
            #{story.id.slice(0, 7)} · {relTime(story.updatedAt) === "now" ? "just now" : `${relTime(story.updatedAt)} ago`}
          </span>
          {/* actions */}
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginLeft: 10 }}>
            {story.status === "review" && (
              <button className="btn btn-sm btn-primary" onClick={() => patchMut.mutate({ status: "done" })}>✓ Done</button>
            )}
            {running ? (
              <button className="btn btn-sm btn-danger" onClick={() => stopMut.mutate()}>
                {stopMut.isPending ? "…" : "Stop"}
              </button>
            ) : (
              <button
                className="btn btn-sm btn-primary"
                disabled={!dispatchable || dispatchMut.isPending}
                onClick={() => dispatchable && !dispatchMut.isPending && dispatchMut.mutate()}
              >
                {dispatchMut.isPending ? "…" : "Dispatch"}
              </button>
            )}
            <button ref={menuBtnRef} className="btn btn-sm" onClick={toggleMenu}>
              <FontAwesomeIcon icon={faEllipsis} />
            </button>
          </div>
        </div>

        <div className="sd-title">{story.title}</div>

        <div className="sd-meta-row">
          <MetaDropdown
            value={story.status}
            options={STATUS_ALL.map((s) => ({ value: s, label: STAGE_CONFIG[s]?.short ?? s, color: STAGE_CONFIG[s]?.color }))}
            color={stage?.color}
            disabled={patchMut.isPending}
            onChange={(v) => patchMut.mutate({ status: v })}
          />
          <MetaDropdown
            value={(story.agent ?? "") as string}
            options={[{ value: "", label: "(unassigned)" }, ...(agentsData?.agents ?? []).map((a) => { const d = resolveAgentDisplay(a.name); return { value: a.name, label: a.name, color: d.color, icon: d.icon }; })]}
            color={agent?.color ?? "var(--fg-3)"}
            icon={agent?.icon}
            disabled={running || patchMut.isPending}
            onChange={(v) => patchMut.mutate({ agent: v || null })}
          />
          {story.priority != null && story.priority > 0 && (
            <span className="pill" style={{ color: "var(--fg-2)" }}>
              <span className="pill-dot" />
              P{story.priority}
            </span>
          )}
        </div>

        {/* Agent-active banner */}
        {isAgentActive && agent && (
          <div className="sd-agent-active" style={{ "--ag": agent.color } as React.CSSProperties}>
            <span className="sd-agent-active-stripe" />
            <span className="sd-agent-active-glyph"><FontAwesomeIcon icon={agent.icon} /></span>
            <div className="sd-agent-active-body">
              <div className="sd-agent-active-head">
                <span className="sd-agent-active-label">
                  <span className="sd-agent-active-name">{agent.label}</span>
                  <span className="sd-agent-active-status">working</span>
                </span>
                <span className="typing" style={{ color: agent.color }}><i /><i /><i /></span>
              </div>
              <div className="sd-agent-active-task">
                {story.dispatchedAt ? `running · started ${formatElapsed(story.dispatchedAt)} ago` : "running"}
                {story.dispatchPid != null ? ` · pid ${story.dispatchPid}` : ""}
              </div>
            </div>
            <div className="sd-agent-active-meta">
              {story.dispatchedAt && (
                <span className="sd-agent-active-since">started {formatElapsed(story.dispatchedAt)} ago</span>
              )}
              <button
                className="btn btn-sm btn-danger"
                onClick={() => stopMut.mutate()}
              >
                interrupt
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="sd-tabs">
        <TabBtn id="spec" active={tab === "spec"} onClick={() => setTab("spec")}>
          Spec
          {openQuestions.length > 0 && (
            <span className="sd-tab-badge attn">{openQuestions.length}</span>
          )}
        </TabBtn>
        <TabBtn id="history" active={tab === "history"} onClick={() => setTab("history")}>
          History
          <span className="sd-tab-badge muted">{activity.length}</span>
        </TabBtn>
        <TabBtn id="controls" active={tab === "controls"} onClick={() => setTab("controls")}>
          Controls
        </TabBtn>
        {(story.originalTitle || story.originalSpecMd) && (
          <TabBtn id="original" active={tab === "original"} onClick={() => setTab("original")}>
            Original
          </TabBtn>
        )}
      </div>

      <div className="sd-body">
        {tab === "spec" && (
          <SpecTab
            story={story}
            openQuestions={openQuestions}
            answeredQuestions={answeredQuestions}
            storyId={id}
          />
        )}
        {tab === "history" && <HistoryTab activity={activity} workspace={workspace} />}
        {tab === "controls" && (
          <ControlsTab
            story={story}
            agents={agentsData?.agents ?? []}
            onPatch={(body) => patchMut.mutate(body)}
            onDispatch={() => dispatchMut.mutate()}
            onStop={() => stopMut.mutate()}
            onDelete={handleDelete}
            isPending={patchMut.isPending || dispatchMut.isPending || stopMut.isPending}
          />
        )}
        {tab === "original" && <OriginalTab story={story} />}
      </div>

      {/* Comment composer */}
      <div className="sd-composer">
        <div className="sd-composer-inner">
          <textarea
            rows={2}
            placeholder="Comment or reply… (⌘↵ to send)"
            value={commentBody}
            onChange={(e) => setCommentBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && commentBody.trim()) {
                commentMut.mutate();
              }
            }}
          />
          <div className="sd-composer-actions">
            <button
              className="btn btn-sm btn-primary"
              disabled={!commentBody.trim() || commentMut.isPending}
              onClick={() => commentMut.mutate()}
            >
              {commentMut.isPending ? "…" : "Send"}
            </button>
            <label className="sd-composer-interrupt">
              <input
                type="checkbox"
                checked={commentInterrupt}
                onChange={(e) => setCommentInterrupt(e.target.checked)}
                style={{ accentColor: "var(--ag-impl)" }}
              />
              Interrupt
            </label>
          </div>
        </div>
      </div>

      {/* ⋯ actions menu */}
      {menuOpen && menuPos && (
        <div
          id="story-actions-menu"
          style={{
            position: "fixed", top: menuPos.top, left: menuPos.left,
            background: "var(--bg-2)", border: "1px solid var(--border-1)",
            borderRadius: "var(--r-md)", boxShadow: "0 8px 24px rgba(0,0,0,.4)",
            zIndex: 9999, width: 160, padding: "4px 0",
          }}
        >
          <MenuBtn onClick={handleRespec} disabled={!dispatchable || dispatchMut.isPending || patchMut.isPending}>Re-spec</MenuBtn>
          <MenuBtn onClick={handleDelete} danger disabled={running || deleteMut.isPending}>
            {deleteMut.isPending ? "Deleting…" : "Delete"}
          </MenuBtn>
        </div>
      )}
    </>
  );
}

function MetaDropdown<T extends string>({
  value, options, color, icon, disabled, onChange,
}: {
  value: T;
  options: { value: T; label: string; color?: string; icon?: IconDefinition }[];
  color?: string;
  icon?: IconDefinition;
  disabled?: boolean;
  onChange: (v: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        className="meta-drop-btn"
        style={{ color: color ?? "var(--fg-1)", opacity: disabled ? 0.4 : 1 }}
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
      >
        {icon && <FontAwesomeIcon icon={icon} style={{ marginRight: 4, fontSize: "0.75em" }} />}
        {current?.label ?? value}
        <span className="meta-drop-caret">▾</span>
      </button>
      {open && (
        <div className="meta-drop-menu">
          {options.map((o) => (
            <button
              key={o.value}
              className={"meta-drop-item" + (o.value === value ? " active" : "")}
              style={o.color ? { color: o.color } : undefined}
              onClick={() => { onChange(o.value); setOpen(false); }}
            >
              {o.icon && <FontAwesomeIcon icon={o.icon} style={{ marginRight: 5, fontSize: "0.75em", opacity: 0.8 }} />}
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TabBtn({ id, active, onClick, children }: { id: string; active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <span className={"sd-tab" + (active ? " active" : "")} onClick={onClick}>
      {children}
    </span>
  );
}

function MenuBtn({ children, onClick, danger, disabled }: { children: React.ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "flex", width: "100%", padding: "6px 12px",
        background: "transparent", border: 0, textAlign: "left",
        color: danger ? "var(--attn-error)" : "var(--fg-0)",
        fontSize: 13, cursor: disabled ? "not-allowed" : "default",
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {children}
    </button>
  );
}

// ── Spec tab ──────────────────────────────────────────────────────────────────

function SpecTab({
  story,
  openQuestions,
  answeredQuestions,
  storyId,
}: {
  story: Story;
  openQuestions: RefinementQuestion[];
  answeredQuestions: RefinementQuestion[];
  storyId: string;
}) {
  return (
    <>
      {openQuestions.length > 0 && (
        <div className="spec-banner">
          <span className="spec-banner-dot" />
          <span>
            <b>{openQuestions.length}</b>{" "}
            {openQuestions.length === 1 ? "question" : "questions"} from the spec writer — answer inline below
          </span>
          <span style={{ marginLeft: "auto", color: "var(--fg-3)", fontSize: 11.5 }}>⌘↵ submits</span>
        </div>
      )}

      <div className="sd-section-title">
        <span>Description</span>
        <span style={{ flex: 1, height: 1, background: "var(--border-0)" }} />
      </div>
      <div className="sd-prose">
        {story.specMd ? (
          <div style={{ color: "var(--fg-1)", fontSize: 13.5, lineHeight: 1.55 }}>
            {renderMarkdown(story.specMd)}
          </div>
        ) : (
          <p style={{ color: "var(--fg-3)" }}>(no spec yet — click Controls to edit)</p>
        )}
      </div>

      {openQuestions.length > 0 && (
        <>
          <div className="sd-section-title" style={{ marginTop: 20 }}>
            <span>Open questions</span>
            <span style={{ flex: 1, height: 1, background: "var(--border-0)" }} />
          </div>
          {openQuestions.map((q) => (
            <OpenQuestion key={q.id} question={q} storyId={storyId} />
          ))}
        </>
      )}

      {answeredQuestions.length > 0 && (
        <>
          <div className="sd-section-title" style={{ marginTop: 20 }}>
            <span>Answered</span>
            <span style={{ flex: 1, height: 1, background: "var(--border-0)" }} />
          </div>
          {answeredQuestions.map((q) => (
            <AnsweredQuestion key={q.id} question={q} />
          ))}
        </>
      )}
    </>
  );
}

// ── Original tab ─────────────────────────────────────────────────────────────

function OriginalTab({ story }: { story: Story }) {
  return (
    <>
      <div className="spec-banner" style={{ background: "var(--bg-1)", borderColor: "var(--border-0)" }}>
        <span style={{ color: "var(--fg-3)", fontSize: 11.5 }}>
          Read-only snapshot captured at creation, before spec-writer rewrites.
        </span>
      </div>

      <div className="sd-section-title">
        <span>Original title</span>
        <span style={{ flex: 1, height: 1, background: "var(--border-0)" }} />
      </div>
      <div className="sd-prose">
        <p style={{ color: "var(--fg-1)", fontSize: 13.5, margin: 0 }}>
          {story.originalTitle ?? <span style={{ color: "var(--fg-3)" }}>(none)</span>}
        </p>
      </div>

      <div className="sd-section-title" style={{ marginTop: 20 }}>
        <span>Original spec</span>
        <span style={{ flex: 1, height: 1, background: "var(--border-0)" }} />
      </div>
      <div className="sd-prose">
        {story.originalSpecMd ? (
          <div style={{ color: "var(--fg-1)", fontSize: 13.5, lineHeight: 1.55 }}>
            {renderMarkdown(story.originalSpecMd)}
          </div>
        ) : (
          <p style={{ color: "var(--fg-3)" }}>(no original spec captured)</p>
        )}
      </div>
    </>
  );
}

function OpenQuestion({ question, storyId }: { question: RefinementQuestion; storyId: string }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");

  const answerMut = useMutation({
    mutationFn: () => api.refinementQuestions.answer(question.id, draft),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["story", storyId] });
      queryClient.invalidateQueries({ queryKey: ["refinement-questions"] });
      setDraft("");
    },
  });

  const skipMut = useMutation({
    mutationFn: () => api.refinementQuestions.skip(question.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["story", storyId] });
      queryClient.invalidateQueries({ queryKey: ["refinement-questions"] });
    },
  });

  return (
    <div className="inline-q">
      <div className="inline-q-head">
        <span className="inline-q-glyph" style={{ color: "var(--ag-spec)" }}>◆</span>
        <span className="inline-q-who">spec-writer asks</span>
        {question.source && <span className="inline-q-time">{question.source}</span>}
        <span className="inline-q-pending">waiting on you</span>
      </div>
      <div className="inline-q-text">{question.question}</div>
      {question.context && <div className="inline-q-reason">{question.context}</div>}
      <div className="inline-q-input">
        <textarea
          placeholder="answer inline…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && draft.trim()) {
              answerMut.mutate();
            }
          }}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <button
            className="btn btn-sm btn-primary"
            disabled={!draft.trim() || answerMut.isPending}
            onClick={() => { if (draft.trim()) answerMut.mutate(); }}
          >
            {answerMut.isPending ? "…" : "submit"}
          </button>
          <span
            style={{ fontSize: 10, color: "var(--fg-3)", cursor: "default", textAlign: "center", padding: "2px 4px" }}
            onClick={() => skipMut.mutate()}
          >
            skip
          </span>
        </div>
      </div>
    </div>
  );
}

function AnsweredQuestion({ question }: { question: RefinementQuestion }) {
  return (
    <div className="inline-q resolved">
      <div className="inline-q-head">
        <span className="inline-q-glyph" style={{ color: "var(--ag-spec)" }}>◆</span>
        <span className="inline-q-who">spec-writer asked</span>
        {question.answeredAt && (
          <span className="inline-q-time">{relTime(question.answeredAt)}</span>
        )}
        <span className="inline-q-resolved-label">✓ answered</span>
      </div>
      <div className="inline-q-text">{question.question}</div>
      {question.answer && (
        <div className="inline-q-answer-shown">
          <span className="inline-q-answer-label">your answer</span>
          <span className="inline-q-answer-text">{question.answer}</span>
        </div>
      )}
    </div>
  );
}

// ── History tab ───────────────────────────────────────────────────────────────

type EventGroup =
  | { type: "bubble"; event: ActivityEvent; arrows: ActivityEvent[] }
  | { type: "continuing"; arrows: ActivityEvent[] }
  | { type: "other"; event: ActivityEvent };

const BUBBLE_KINDS = new Set([
  "state_transition", "agent_transition", "comment",
  "agent_prompt", "triage_prompt", "qa_prompt", "classifier_prompt",
]);

function groupActivity(events: ActivityEvent[]): EventGroup[] {
  const groups: EventGroup[] = [];
  let openBubble: { event: ActivityEvent; arrows: ActivityEvent[] } | null = null;

  for (const e of events) {
    const evLine = shortenHome(renderEvent(e));
    const isArrowRow = e.kind === "agent_stream" && evLine.startsWith("→");
    const isBubbleKind = (e.kind === "agent_stream" && !isArrowRow) || BUBBLE_KINDS.has(e.kind);

    if (isBubbleKind) {
      if (openBubble) groups.push({ type: "bubble", ...openBubble });
      openBubble = { event: e, arrows: [] };
    } else if (isArrowRow) {
      if (openBubble && openBubble.event.actor === e.actor) {
        openBubble.arrows.push(e);
      } else {
        if (openBubble) { groups.push({ type: "bubble", ...openBubble }); openBubble = null; }
        const last = groups[groups.length - 1];
        if (last?.type === "continuing" && last.arrows[0]?.actor === e.actor) {
          last.arrows.push(e);
        } else {
          groups.push({ type: "continuing", arrows: [e] });
        }
      }
    } else {
      if (openBubble) { groups.push({ type: "bubble", ...openBubble }); openBubble = null; }
      groups.push({ type: "other", event: e });
    }
  }
  if (openBubble) groups.push({ type: "bubble", ...openBubble });
  return groups;
}

function HistoryTab({ activity, workspace }: { activity: ActivityEvent[]; workspace?: string }) {
  const [expandAll, setExpandAll] = useState(false);

  if (activity.length === 0) {
    return (
      <div style={{ color: "var(--fg-3)", fontSize: 12.5, padding: 12, fontFamily: "var(--mono)" }}>
        no activity yet — dispatch to start
      </div>
    );
  }

  const events = [...activity].reverse();
  const groups = groupActivity(events);

  return (
    <div className="hist">
      <div className="hist-toolbar">
        <span>{groups.length} events</span>
        <span style={{ color: "var(--fg-4)" }}>·</span>
        <span style={{ marginLeft: "auto" }}>
          <button className="btn btn-sm" onClick={() => setExpandAll(true)}>expand all</button>
        </span>
        <span>
          <button className="btn btn-sm" onClick={() => setExpandAll(false)}>collapse</button>
        </span>
      </div>
      {groups.map((g, i) => {
        if (g.type === "continuing") {
          return (
            <HistoryEvent
              key={`continuing-${i}`}
              event={g.arrows[0]!}
              arrows={g.arrows}
              forceOpen={expandAll}
              workspace={workspace}
              synthetic
            />
          );
        }
        return (
          <HistoryEvent
            key={g.type === "other" ? g.event.id : g.event.id}
            event={g.type === "other" ? g.event : g.event}
            arrows={g.type === "bubble" ? g.arrows : undefined}
            forceOpen={expandAll}
            workspace={workspace}
          />
        );
      })}
    </div>
  );
}

function HistoryEvent({
  event, forceOpen, workspace, arrows, synthetic,
}: {
  event: ActivityEvent;
  forceOpen: boolean;
  workspace?: string;
  arrows?: ActivityEvent[];
  synthetic?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const isOpen = forceOpen || open;

  const tsDate = new Date(event.createdAt);
  const ts = tsDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  const actorName = event.actor === "user" ? USER_LABEL : event.actor;
  const agentCfg = actorName ? { ...resolveAgentDisplay(actorName), label: actorName } : null;

  const line = shortenHome(renderEvent(event));
  const fullLine = shortenHome(renderEvent(event, true));
  const isArrow = line.startsWith("→");

  let content: string;
  if (synthetic) {
    content = "Continuing…";
  } else if (event.kind === "state_transition") {
    const p = event.payload as { status?: string };
    content = `→ ${p.status ?? "unknown"}`;
  } else if (event.kind === "agent_transition") {
    const p = event.payload as { from?: string | null; to?: string | null };
    content = `${p.from ?? "(none)"} → ${p.to ?? "(none)"}`;
  } else if (event.kind === "comment") {
    const p = event.payload as { body?: string };
    content = p.body ?? "";
  } else {
    content = isArrow ? line.slice(2) : fullLine;
  }

  const PROMPT_KINDS = ["agent_prompt", "triage_prompt", "qa_prompt", "classifier_prompt"];
  const isPromptEvent = PROMPT_KINDS.includes(event.kind);
  const displayLine = content.length > 120 ? content.slice(0, 120) + "…" : content;
  const hasDetail = fullLine.length > 80 || event.kind === "dispatch_completed" || isPromptEvent;
  const hasArrows = arrows && arrows.length > 0;

  return (
    <div className={"hist-evt" + (isOpen ? " open" : "") + (hasDetail ? " has-packet" : "")}>
      <div className="hist-evt-head" onClick={hasDetail ? () => setOpen((v) => !v) : undefined}>
        <span className="hist-evt-t">{ts}</span>
        <span className="hist-evt-glyph" style={{ color: agentCfg?.color ?? "var(--fg-3)" }}>
          {agentCfg ? <FontAwesomeIcon icon={agentCfg.icon} /> : "·"}
        </span>
        <span className="hist-evt-who" style={{ color: agentCfg?.color ?? "var(--fg-0)" }}>
          {agentCfg?.label ?? actorName ?? event.kind}
        </span>
        <div>
          <span className="hist-evt-text">{displayLine}</span>
          {hasArrows && (
            <div className="hist-evt-arrows">
              {arrows.map((a) => (
                <div key={a.id} className="hist-evt-arrow-row" title={shortenHome(renderEvent(a, true))}>
                  {shortenHome(renderEvent(a, true))}
                </div>
              ))}
            </div>
          )}
        </div>
        <span />
        {hasDetail && <span className="hist-evt-chev">{isOpen ? "▾" : "▸"}</span>}
      </div>
      {isOpen && hasDetail && (
        <div className="packet">
          {event.kind === "dispatch_completed" ? (
            <DispatchCompletedDetail event={event} />
          ) : isPromptEvent ? (
            <PromptDetail event={event} />
          ) : (
            <pre className="packet-pre" style={{ margin: 0 }}>
              {fullLine}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function PromptDetail({ event }: { event: ActivityEvent }) {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  const systemPrompt = typeof p.systemPrompt === "string" ? p.systemPrompt : null;
  const prompt = typeof p.prompt === "string" ? p.prompt : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {systemPrompt && (
        <div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            System Prompt
          </div>
          <pre className="packet-pre" style={{ margin: 0 }}>{systemPrompt}</pre>
        </div>
      )}
      {prompt && (
        <div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-3)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Prompt
          </div>
          <pre className="packet-pre" style={{ margin: 0 }}>{prompt}</pre>
        </div>
      )}
      {!systemPrompt && !prompt && (
        <pre className="packet-pre" style={{ margin: 0 }}>{JSON.stringify(p, null, 2)}</pre>
      )}
    </div>
  );
}

function DispatchCompletedDetail({ event }: { event: ActivityEvent }) {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const changedFiles = Array.isArray(payload.changedFiles) ? (payload.changedFiles as string[]) : [];
  const gitDiff = typeof payload.gitDiff === "string" ? payload.gitDiff : "";
  const diffStats = parseDiffStats(gitDiff);

  if (changedFiles.length === 0) {
    return <div style={{ color: "var(--fg-3)", fontSize: 12 }}>Agent touched no files.</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {changedFiles.map((f) => {
        const s = diffStats.get(f);
        return (
          <div key={f} style={{ display: "flex", gap: 10, alignItems: "center", fontFamily: "var(--mono)", fontSize: 11.5 }}>
            <span style={{ color: "var(--fg-0)", flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{f}</span>
            {s?.added ? <span style={{ color: "var(--ag-impl)" }}>+{s.added}</span> : null}
            {s?.removed ? <span style={{ color: "var(--attn-error)" }}>-{s.removed}</span> : null}
          </div>
        );
      })}
    </div>
  );
}

// ── Controls tab ──────────────────────────────────────────────────────────────

interface ControlsTabProps {
  story: Story;
  agents: { name: string }[];
  onPatch: (body: { title?: string; specMd?: string; status?: StoryStatus; agent?: string | null }) => void;
  onDispatch: () => void;
  onStop: () => void;
  onDelete: () => void;
  isPending: boolean;
}

function ControlsTab({ story, agents, onPatch, onDispatch, onStop, onDelete, isPending }: ControlsTabProps) {
  const [editingSpec, setEditingSpec] = useState(false);
  const [specDraft, setSpecDraft] = useState(story.specMd);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(story.title);
  const specRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editingSpec) specRef.current?.focus();
  }, [editingSpec]);

  const running = story.status === "implementing";
  const dispatchable = story.status !== "implementing";

  return (
    <>
      <div className="sd-section-title">
        <span>Title</span>
        <span style={{ flex: 1, height: 1, background: "var(--border-0)" }} />
      </div>
      <div className="ctrl-group">
        <div className="ctrl-row">
          <span className="ctrl-key">Title</span>
          {editingTitle ? (
            <input
              style={{
                background: "var(--bg-0)", border: "1px solid var(--border-1)",
                borderRadius: "var(--r-sm)", color: "var(--fg-0)", font: "inherit",
                fontSize: 13, padding: "3px 8px", outline: "none", width: "100%",
              }}
              value={titleDraft}
              autoFocus
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => {
                if (titleDraft.trim() && titleDraft !== story.title) onPatch({ title: titleDraft.trim() });
                setEditingTitle(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") setEditingTitle(false);
                if (e.key === "Enter") {
                  if (titleDraft.trim() && titleDraft !== story.title) onPatch({ title: titleDraft.trim() });
                  setEditingTitle(false);
                }
              }}
            />
          ) : (
            <span className="ctrl-val" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{story.title}</span>
          )}
          <button className="btn btn-sm" onClick={() => { setTitleDraft(story.title); setEditingTitle(true); }}>edit</button>
        </div>
      </div>

      <div className="sd-section-title">
        <span>Spec</span>
        <span style={{ flex: 1, height: 1, background: "var(--border-0)" }} />
      </div>
      {editingSpec ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
          <textarea
            ref={specRef}
            style={{
              background: "var(--bg-0)", border: "1px solid var(--border-1)",
              borderRadius: "var(--r-md)", color: "var(--fg-0)", font: "inherit",
              fontSize: 13, padding: "10px 12px", outline: "none",
              resize: "vertical", minHeight: 200, lineHeight: 1.55,
            }}
            value={specDraft}
            onChange={(e) => setSpecDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditingSpec(false);
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                if (specDraft !== story.specMd) onPatch({ specMd: specDraft });
                setEditingSpec(false);
              }
            }}
          />
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn btn-sm btn-primary" onClick={() => { if (specDraft !== story.specMd) onPatch({ specMd: specDraft }); setEditingSpec(false); }}>Save</button>
            <button className="btn btn-sm" onClick={() => setEditingSpec(false)}>Cancel</button>
            {running && <span style={{ fontSize: 11, color: "var(--attn-high)", alignSelf: "center" }}>Saving will interrupt the running agent.</span>}
          </div>
        </div>
      ) : (
        <div className="ctrl-group">
          <div className="ctrl-row" style={{ gridTemplateColumns: "1fr auto" }}>
            <span className="ctrl-val" style={{ fontSize: 12, color: "var(--fg-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {story.specMd ? story.specMd.slice(0, 80) + (story.specMd.length > 80 ? "…" : "") : "(empty)"}
            </span>
            <button className="btn btn-sm" onClick={() => { setSpecDraft(story.specMd); setEditingSpec(true); }}>edit</button>
          </div>
        </div>
      )}

      <div className="sd-section-title">
        <span>Stage</span>
        <span style={{ flex: 1, height: 1, background: "var(--border-0)" }} />
      </div>
      <div className="ctrl-group">
        <div className="ctrl-row">
          <span className="ctrl-key">Force stage</span>
          <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {STATUS_ALL.map((s) => (
              <span
                key={s}
                className={"pill" + (s === story.status ? " active" : "")}
                style={{
                  color: STAGE_CONFIG[s]?.color,
                  cursor: "default",
                  opacity: s === story.status ? 1 : 0.55,
                  fontSize: 10.5,
                }}
                onClick={() => s !== story.status && onPatch({ status: s })}
              >
                <span className="pill-dot" />
                {STAGE_CONFIG[s]?.short ?? s}
              </span>
            ))}
          </span>
          <span className="ctrl-hint">override</span>
        </div>
      </div>

      <div className="sd-section-title">
        <span>Agent</span>
        <span style={{ flex: 1, height: 1, background: "var(--border-0)" }} />
      </div>
      <div className="ctrl-group">
        <div className="ctrl-row">
          <span className="ctrl-key">Assigned agent</span>
          <select
            style={{
              background: "var(--bg-0)", border: "1px solid var(--border-1)",
              borderRadius: "var(--r-sm)", color: "var(--fg-0)", font: "inherit",
              fontSize: 12, padding: "3px 8px", outline: "none",
            }}
            value={story.agent ?? ""}
            onChange={(e) => onPatch({ agent: e.target.value || null })}
            disabled={running || isPending}
          >
            <option value="">(unassigned)</option>
            {agents.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
          </select>
          <span />
        </div>
      </div>

      <div className="sd-section-title">
        <span>Dispatch</span>
        <span style={{ flex: 1, height: 1, background: "var(--border-0)" }} />
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {running && (
          <button className="btn btn-sm btn-danger" onClick={onStop}>stop agent</button>
        )}
      </div>
    </>
  );
}
