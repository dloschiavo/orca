import React, { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faEllipsis } from "@fortawesome/free-solid-svg-icons";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ActivityEvent } from "../api.js";
import type { RefinementQuestion, Story, StoryStatus } from "@orca/shared";
import { PageHeader } from "../components/PageHeader.js";
import { Breadcrumb } from "../components/Breadcrumb.js";
import { StatusDot } from "../components/StatusDot.js";
import { Section } from "../components/Section.js";
import { NewStoryModal } from "../components/NewStoryModal.js";
import { useProjectContext } from "../state/ProjectContext.js";
import { useStoryEventStream } from "../hooks/useStoryEventStream.js";
import { USER_LABEL, agentColors, agentIcon, type ActorColors } from "../utils/agentStyle.js";
import { formatElapsed, formatTokens, tokenHeatColor } from "../utils/formatters.js";
import {
  renderEvent,
  shortenHome,
  isHideableToolUse,
  extractContent,
  parseDiffStats,
} from "../utils/activity.js";
import { renderMarkdown, parseInlineMarkdown, maybePrettyJson } from "../utils/markdown.js";

const STATUS_OPTIONS: StoryStatus[] = [
  "blocked", "canceled", "icebox", "planning", "backlog", "implementing", "qa", "review", "done",
];
const STATUS_LABELS: Record<StoryStatus, string> = {
  icebox: "icebox",
  planning: "planning",
  backlog: "backlog",
  implementing: "implementing",
  qa: "qa",
  review: "review",
  blocked: "blocked",
  done: "done",
  canceled: "canceled",
};

const DETAIL_WIDTH_KEY = "orca.storiesWorkspace.detailWidth";
const MIN_DETAIL_WIDTH = 480;

function clampDetailWidth(w: number): number {
  const max = Math.round(window.innerWidth * 0.7);
  return Math.max(MIN_DETAIL_WIDTH, Math.min(max, w));
}

export function StoriesWorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { activeProjectId, activeProject } = useProjectContext();
  useStoryEventStream(activeProjectId);
  const [creating, setCreating] = useState(false);

  const [detailWidth, setDetailWidth] = useState<number>(() => {
    try {
      const stored = localStorage.getItem(DETAIL_WIDTH_KEY);
      if (stored) {
        const n = Number(stored);
        if (Number.isFinite(n) && n > 0) return clampDetailWidth(n);
      }
    } catch { /* ignore */ }
    return Math.round(window.innerWidth * 0.4);
  });

  const [dragging, setDragging] = useState(false);

  // Clamp on window resize
  useEffect(() => {
    function handleResize() {
      setDetailWidth((w) => clampDetailWidth(w));
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Attach drag listeners to window while dragging
  useEffect(() => {
    if (!dragging) return;

    function handleMouseMove(e: MouseEvent) {
      setDetailWidth(clampDetailWidth(window.innerWidth - e.clientX));
    }

    function handleMouseUp(e: MouseEvent) {
      const final = clampDetailWidth(window.innerWidth - e.clientX);
      setDetailWidth(final);
      try { localStorage.setItem(DETAIL_WIDTH_KEY, String(final)); } catch { /* ignore */ }
      setDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragging]);

  function handleDragStart(e: React.MouseEvent) {
    e.preventDefault();
    setDragging(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

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
      <div className="h-full flex flex-col">
        <PageHeader title="All Stories" />
        <div className="p-6 text-muted text-sm">
          No project selected. Create one from{" "}
          <Link to="/projects" className="text-accent underline">Projects</Link>.
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <PageHeader
        title={<Breadcrumb first={activeProject?.name ?? "…"} second="All Stories" />}
        actions={
          <button className="btn btn-primary" onClick={() => setCreating(true)} disabled={!activeProjectId}>
            New story
          </button>
        }
      />

      <div className="flex-1 flex min-h-0">
        {/* Full-screen overlay during drag prevents text selection / hover effects */}
        {dragging && (
          <div
            className="fixed inset-0 z-10"
            style={{ cursor: "col-resize", backgroundColor: "rgba(0,0,0,0.01)" }}
          />
        )}
        <div className="flex-1 min-w-0 overflow-y-auto">
          <StoryList activeProjectId={activeProjectId} selectedId={id ?? null} />
        </div>
        {/* Drag handle — owns the visible border */}
        <div
          className={`w-1.5 shrink-0 cursor-col-resize relative z-20 transition-colors ${dragging ? "bg-accent/40" : "bg-border/40 hover:bg-accent/30"}`}
          onMouseDown={handleDragStart}
        />
        <div
          className="shrink-0 min-w-[480px] flex flex-col overflow-hidden"
          style={{ width: detailWidth }}
        >
          {id ? (
            <StoryDetailPanel id={id} />
          ) : (
            <div className="flex-1 flex items-center justify-center text-sm text-muted">
              Select a story to see its details
            </div>
          )}
        </div>
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

// ---------------------------------------------------------------------------
// Story list (center column)
// ---------------------------------------------------------------------------

function StoryList({ activeProjectId, selectedId }: { activeProjectId: string; selectedId: string | null }) {
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: ["stories", activeProjectId],
    queryFn: () =>
      activeProjectId
        ? api.stories.list({ projectId: activeProjectId })
        : Promise.resolve({ stories: [] as Story[] }),
    enabled: !!activeProjectId,
    refetchInterval: (q) => {
      const stories = q.state.data?.stories ?? [];
      return stories.some((s) => s.status === "implementing") ? 10_000 : 30_000;
    },
  });

  const visible = data?.stories ?? [];

  const [, setTick] = useState(0);
  const hasInProgress = visible.some((s) => s.status === "implementing");
  useEffect(() => {
    if (!hasInProgress) return;
    const id = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => clearInterval(id);
  }, [hasInProgress]);

  return (
    <>
      {isLoading && <div className="p-6 text-muted text-sm">loading…</div>}
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-border text-[11px] text-muted uppercase tracking-wide">
            <th className="px-6 py-2 font-medium">Title</th>
            <th className="px-2 py-2 font-medium text-right w-[64px]">Cost</th>
            <th className="px-2 py-2 font-medium text-right w-[80px]">Tokens</th>
            <th className="px-2 py-2 font-medium text-right pr-6 w-[88px]">Updated</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {visible.map((story) => {
            const isActive = story.dispatchPid != null;
            const isSelected = selectedId === story.id;
            const activeRowClass = story.status === "implementing"
              ? "bg-yellow-500/[0.04]"
              : story.status === "qa"
              ? "bg-orange-500/[0.04]"
              : "";
            const rowClass = isSelected
              ? "bg-accent/10 border-l-2 border-l-accent hover:bg-accent/10"
              : `border-l-2 border-l-transparent hover:bg-surface ${isActive ? `${activeRowClass} animate-pulse` : activeRowClass}`;
            return (
              <tr
                key={story.id}
                className={`group transition-colors cursor-pointer ${rowClass}`}
                onClick={() => navigate(`/stories/${story.id}`)}
              >
                <td className="px-6 py-2.5">
                  <div className={`flex items-start gap-2 text-sm ${isSelected ? "text-text" : "text-text group-hover:text-accent"}`}>
                    <StatusDot status={story.status} className="shrink-0 mt-0.5" pulse={isActive} />
                    <span className="flex-1 min-w-0 break-words">{story.title}</span>
                    <div className="shrink-0 flex items-center gap-2 whitespace-nowrap pt-0.5">
                      {story.status === "implementing" && story.dispatchPid != null && (
                        <span className="text-[11px] text-muted">
                          pid {story.dispatchPid}
                          {story.dispatchedAt && <> · {formatElapsed(story.dispatchedAt)}</>}
                          {story.lastActivityAt && <> · {formatElapsed(story.lastActivityAt)} ago</>}
                        </span>
                      )}
                      {story.labels.slice(0, 2).map((l) => (
                        <span key={l} className="pill">{l}</span>
                      ))}
                    </div>
                  </div>
                </td>
                <td className="px-2 py-2.5 text-right text-[11px] text-muted whitespace-nowrap">
                  {story.totalCostUsd != null ? `$${story.totalCostUsd.toFixed(2)}` : ""}
                </td>
                <td className="px-2 py-2.5 text-right">
                  {story.totalTokensUsed != null && (
                    <span className="text-[11px] font-medium whitespace-nowrap" style={{ color: tokenHeatColor(story.totalTokensUsed) }}>
                      {formatTokens(story.totalTokensUsed)}
                    </span>
                  )}
                </td>
                <td className="px-2 py-2.5 text-right pr-6 text-xs text-muted whitespace-nowrap">
                  {new Date(story.updatedAt).toLocaleDateString()}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

// ---------------------------------------------------------------------------
// Story detail panel (right column)
// ---------------------------------------------------------------------------

function StoryDetailPanel({ id }: { id: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [editingTitle, setEditingTitle] = useState(false);
  const [editingSpec, setEditingSpec] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [specDraft, setSpecDraft] = useState("");
  const [specHeight, setSpecHeight] = useState<number | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [statusPos, setStatusPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const specRef = useRef<HTMLTextAreaElement>(null);
  const statusBtnRef = useRef<HTMLButtonElement>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["story", id],
    queryFn: () => api.stories.get(id),
    enabled: !!id,
    refetchInterval: (q) => {
      const s = q.state.data?.story.status;
      return s === "implementing" ? 2000 : 30_000;
    },
  });

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

  const [commentBody, setCommentBody] = useState("");
  const [commentInterrupt, setCommentInterrupt] = useState(true);
  const commentMut = useMutation({
    mutationFn: () => api.stories.comment(id, { body: commentBody, interrupt: commentInterrupt }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["story", id] });
      queryClient.invalidateQueries({ queryKey: ["stories"] });
      setCommentBody("");
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

  const { data: agentsData } = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.agents.list(),
  });

  // Status dropdown outside-click + reposition
  useEffect(() => {
    if (!statusOpen) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (statusBtnRef.current && statusBtnRef.current.contains(target)) return;
      const drop = document.getElementById("status-fixed-dropdown");
      if (drop && drop.contains(target)) return;
      setStatusOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [statusOpen]);

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

  useEffect(() => { if (editingTitle) titleRef.current?.focus(); }, [editingTitle]);
  useEffect(() => { if (editingSpec) specRef.current?.focus(); }, [editingSpec]);

  // Reset editing/draft state when switching stories
  useEffect(() => {
    setEditingTitle(false);
    setEditingSpec(false);
    setStatusOpen(false);
    setMenuOpen(false);
    setCommentBody("");
  }, [id]);

  if (isLoading || !data) {
    return (
      <div className="p-6 text-muted text-sm">loading…</div>
    );
  }

  const { story, activity: rawActivity, refinementQuestions: rawQuestions } = data;
  const openQuestions = (rawQuestions ?? []).filter((q) => q.status === "open");
  const answeredQuestions = (rawQuestions ?? []).filter((q) => q.status === "answered");

  const workspace: string | undefined = [...rawActivity]
    .reverse()
    .find((e: ActivityEvent) => e.kind === "dispatch_started")
    ?.payload?.repoPath as string | undefined;

  // Build dispatch timeline so activity rows can show agent/model context.
  const dispatchTimeline: { ts: string; agent: string | undefined; model: string | undefined }[] = [];
  for (const e of rawActivity) {
    if (e.kind === "dispatch_started") {
      const p = e.payload as Record<string, unknown> | undefined;
      dispatchTimeline.push({
        ts: e.createdAt,
        agent: (p?.agent ?? p?.archetype) as string | undefined,
        model: p?.model as string | undefined,
      });
    }
  }
  // Backfill actual model from dispatch_completed.
  for (const e of rawActivity) {
    if (e.kind === "dispatch_completed") {
      const completedModel = (e.payload as Record<string, unknown>)?.model as string | undefined;
      if (!completedModel) continue;
      for (let i = dispatchTimeline.length - 1; i >= 0; i--) {
        const entry = dispatchTimeline[i];
        if (!entry) continue;
        if (entry.ts <= e.createdAt) {
          if (!entry.model) entry.model = completedModel;
          break;
        }
      }
    }
  }

  function agentContextFor(event: ActivityEvent): { agent?: string; model?: string } {
    const p = event.payload as Record<string, unknown> | undefined;
    const agent = event.actor ?? undefined;
    if (p?.model) return { agent, model: p.model as string };
    let best: (typeof dispatchTimeline)[number] | undefined;
    for (const d of dispatchTimeline) {
      if (d.ts <= event.createdAt) best = d;
    }
    return { agent, model: best?.model };
  }

  // Only hide a dispatch_claim if the very same dispatch instance also
  // logged a dispatch_dropped (the claim guard self-killed). A standalone
  // claim that proceeded into a real dispatch is signal, not noise — never
  // hide it.
  const droppedInstanceIds = new Set<string>();
  for (const e of rawActivity) {
    if (e.kind !== "dispatch_dropped") continue;
    const id = e.dispatchInstanceId;
    if (id) droppedInstanceIds.add(id);
  }

  // APPEND-ONLY: every suppression rule below was added in response to a
  // specific user complaint and is load-bearing. Add new rules alongside
  // these — never rewrite the block to contain only the new rule.
  const activity = rawActivity.filter((e) => {
    // story_created is implicit — suppress it
    if (e.kind === "story_created") return false;
    // Comments, agent prompts, and transition events are always shown (rendered as bubbles)
    if (e.kind === "comment" || e.kind === "agent_prompt" || e.kind === "agent_transition" || e.kind === "state_transition") return true;
    if (e.kind === "dispatch_started") {
      const p = e.payload as Record<string, unknown> | undefined;
      if (workspace && p?.repoPath === workspace) return false;
      return true;
    }
    // Only suppress claim+drop pairs (instance opened and immediately
    // self-killed by the claim guard). A claim with no matching drop is a
    // real dispatch and stays visible.
    if (e.kind === "dispatch_claim") {
      const id = e.dispatchInstanceId;
      if (id && droppedInstanceIds.has(id)) return false;
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
      if (sub === "task_started" || sub === "task_progress" || sub === "task_notification" || sub === "init" || sub === "compact_boundary" || sub === "status") return false;
      return true;
    }

    if (type === "user") {
      const content = extractContent(p);
      const tr = content.find((c) => c.type === "tool_result");
      // hide ALL tool results (including errors) — user requested no tool results shown
      if (tr) return false;
      return false;
    }

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

    if (type === "rate_limit_event") {
      const rli = p.rate_limit_info as Record<string, unknown> | undefined;
      if (rli && rli.status === "allowed" && rli.overageStatus === "rejected" && rli.rateLimitType === "five_hour" && rli.isUsingOverage === false && rli.overageDisabledReason === "org_level_disabled") {
        const expectedTopKeys = new Set(["type", "uuid", "session_id", "rate_limit_info"]);
        const expectedRliKeys = new Set(["status", "resetsAt", "overageStatus", "rateLimitType", "isUsingOverage", "overageDisabledReason"]);
        const topKeys = Object.keys(p);
        const rliKeys = Object.keys(rli);
        if (topKeys.length === expectedTopKeys.size && topKeys.every((k) => expectedTopKeys.has(k)) && rliKeys.length === expectedRliKeys.size && rliKeys.every((k) => expectedRliKeys.has(k))) return false;
      }
    }

    if (workspace && JSON.stringify(p).includes(`spawning claude-local in ${workspace}`)) return false;

    return true;
  });

  const dispatchable = story.status !== "implementing";
  const running = story.status === "implementing";
  const agentRunning = story.dispatchPid != null;
  const agentRunColor = story.status === "qa"
    ? { text: "text-orange-400", bg: "bg-qa" }
    : { text: "text-yellow-400", bg: "bg-implementing" };

  const startEditTitle = () => { setTitleDraft(story.title); setEditingTitle(true); };
  const saveTitle = () => {
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== story.title) patchMut.mutate({ title: trimmed });
    setEditingTitle(false);
  };

  const startEditSpec = () => { setSpecDraft(story.specMd); setEditingSpec(true); };
  const saveSpec = () => {
    if (specDraft !== story.specMd) patchMut.mutate({ specMd: specDraft });
    setEditingSpec(false);
  };

  const toggleStatus = () => {
    if (!statusOpen) {
      const r = statusBtnRef.current?.getBoundingClientRect();
      if (r) setStatusPos({ top: r.bottom + 4, left: r.left, width: r.width });
    }
    setStatusOpen((v) => !v);
  };

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

  return (
    <>
      <div className="flex-1 overflow-y-auto">
        <div className="px-5 py-4 space-y-5">
          {/* Header: Row 1 = id chip + action buttons; Row 2 = editable title */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-muted text-sm shrink-0 font-mono">#{story.id.slice(0, 8)}</span>
              <div className="flex-1" />
              <div className="flex items-center gap-2 shrink-0">
              {story.status === "review" && (
                <button
                  className="btn btn-primary"
                  onClick={() => patchMut.mutate({ status: "done" })}
                  disabled={patchMut.isPending}
                  title="Mark this story done"
                >
                  Done
                </button>
              )}
              {running ? (
                <button
                  className="btn bg-red-600 hover:bg-red-700 text-white"
                  onClick={() => stopMut.mutate()}
                  disabled={stopMut.isPending}
                  title="Kill the running agent and block the story"
                >
                  {stopMut.isPending ? "Stopping…" : "Stop"}
                </button>
              ) : (
                <button
                  className="btn btn-primary"
                  onClick={() => dispatchMut.mutate()}
                  disabled={!dispatchable || dispatchMut.isPending}
                  title={dispatchable ? "Spawn claude in the project repo with this story's spec" : "Cannot dispatch a story that is already in progress"}
                >
                  {dispatchMut.isPending ? "Dispatching…" : "Dispatch"}
                </button>
              )}
              <button
                ref={menuBtnRef}
                className="btn px-2 cursor-pointer"
                onClick={toggleMenu}
                title="More actions"
                aria-label="More actions"
              >
                <FontAwesomeIcon icon={faEllipsis} />
              </button>
              </div>
            </div>
            {/* Row 2: editable story title */}
            {editingTitle ? (
              <form onSubmit={(e) => { e.preventDefault(); saveTitle(); }}>
                <input
                  ref={titleRef}
                  className="w-full text-sm font-semibold bg-surface border border-border rounded px-2 py-0.5 text-text"
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Escape") setEditingTitle(false); }}
                  onBlur={saveTitle}
                />
              </form>
            ) : (
              <span
                className="text-sm font-semibold text-text cursor-pointer hover:underline decoration-dotted underline-offset-4 break-words"
                onClick={startEditTitle}
                title="Click to edit title"
              >
                {story.title}
              </span>
            )}
          </div>

          {agentRunning && (
            <Section title="Run">
              <div className={`flex items-center gap-2 text-xs ${agentRunColor.text}`}>
                <span className="relative flex h-2 w-2 shrink-0">
                  <span className={`absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping ${agentRunColor.bg}`} />
                  <span className={`relative inline-flex h-2 w-2 rounded-full ${agentRunColor.bg}`} />
                </span>
                <span className="font-medium">{story.agent ?? "agent"}</span>
                <span>running</span>
                <span className="text-muted">pid {story.dispatchPid}</span>
              </div>
            </Section>
          )}

          <Section title="Status / Agent">
            <div className="flex gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-[10px] text-muted mb-1">Status</div>
                <button
                  ref={statusBtnRef}
                  className="flex items-center gap-2 w-full bg-surface2 border border-border rounded-md px-3 py-2 text-sm text-left hover:border-accent/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                  onClick={toggleStatus}
                  disabled={running || patchMut.isPending}
                >
                  <StatusDot status={story.status} />
                  <span className="flex-1 text-text">{STATUS_LABELS[story.status]}</span>
                  <span className="text-muted text-xs">▾</span>
                </button>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[10px] text-muted mb-1">Agent</div>
                <select
                  className="w-full bg-surface2 border border-border rounded-md px-3 py-2 text-sm text-text cursor-pointer outline-none hover:border-accent/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  value={story.agent ?? ""}
                  onChange={(e) => patchMut.mutate({ agent: e.target.value || null })}
                  disabled={running || patchMut.isPending}
                >
                  <option value="">(unassigned)</option>
                  {agentsData?.agents.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
                </select>
              </div>
            </div>
          </Section>

          <Section
            title="Spec"
            action={!editingSpec && <button className="text-[11px] text-accent hover:underline cursor-pointer" onClick={startEditSpec}>Edit</button>}
          >
            {editingSpec ? (
              <div className="space-y-2">
                <textarea
                  ref={specRef}
                  className="w-full text-sm text-text bg-surface rounded-md border border-border p-3 resize-y"
                  style={specHeight !== null ? { height: specHeight } : { minHeight: 400 }}
                  value={specDraft}
                  onChange={(e) => setSpecDraft(e.target.value)}
                  onMouseUp={() => { if (specRef.current) setSpecHeight(specRef.current.offsetHeight); }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setEditingSpec(false);
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveSpec();
                  }}
                />
                <div className="flex gap-2">
                  <button className="btn btn-primary text-xs" onClick={saveSpec} disabled={patchMut.isPending}>
                    {running ? "Save & re-dispatch" : "Save"}
                  </button>
                  <button className="btn text-xs" onClick={() => setEditingSpec(false)}>Cancel</button>
                  {running && <span className="text-[11px] text-amber-400 self-center">Saving will interrupt the running agent.</span>}
                </div>
              </div>
            ) : (
              <div className="whitespace-pre-wrap text-sm text-text bg-surface rounded-md border border-border p-3 cursor-pointer hover:border-accent/40 transition-colors" onClick={startEditSpec} title="Click to edit spec">
                {story.specMd || "(empty — click to add a spec)"}
              </div>
            )}
          </Section>

          {(openQuestions.length > 0 ||
            answeredQuestions.length > 0 ||
            story.status === "planning") && (
            <Section
              title="Q&A"
              subtitle={
                openQuestions.length > 0
                  ? `${openQuestions.length} open${
                      answeredQuestions.length > 0
                        ? ` · ${answeredQuestions.length} answered`
                        : ""
                    }`
                  : answeredQuestions.length > 0
                  ? `${answeredQuestions.length} answered`
                  : story.status === "planning"
                  ? "spec-writer is working"
                  : undefined
              }
            >
              {openQuestions.length === 0 && answeredQuestions.length === 0 ? (
                <div className="text-xs text-muted">
                  spec-writer is reviewing the spec. Questions will appear here.
                </div>
              ) : (
                <ul className="space-y-3">
                  {openQuestions.map((q) => (
                    <QuestionForm key={q.id} question={q} storyId={story.id} />
                  ))}
                  {answeredQuestions.map((q) => (
                    <AnsweredQuestion key={q.id} question={q} />
                  ))}
                </ul>
              )}
            </Section>
          )}

          <Section title="History">
            {activity.length === 0 ? (
              <div className="text-xs text-muted pb-4">No activity yet. Click Dispatch to spawn the agent.</div>
            ) : (
              <ol className="space-y-1 pb-4">
                {(() => {
                  // Forward pass (chronological order) — open a bubble on genuine agent
                  // text, absorb all following arrow rows into it, close on non-agent_stream.
                  // Activity from the API is desc (latest-first); .reverse() = chronological.
                  type Group =
                    | { type: "bubble"; event: ActivityEvent; arrows: ActivityEvent[] }
                    | { type: "continuing"; actor: string; arrows: ActivityEvent[] }
                    | { type: "other"; event: ActivityEvent };
                  // Any event rendered as a bubble can absorb following arrows
                  // from the same actor. Orphaned arrows (no matching bubble) are
                  // grouped into a synthetic "Continuing…" bubble per actor.
                  const BUBBLE_KINDS = new Set(["state_transition", "agent_transition", "comment", "agent_prompt"]);
                  const groups: Group[] = [];
                  let openBubble: { event: ActivityEvent; arrows: ActivityEvent[] } | null = null;
                  for (const e of [...activity].reverse()) {
                    const evLine = shortenHome(renderEvent(e));
                    const isGenuineText = e.kind === "agent_stream" && !evLine.startsWith("→");
                    const isArrowRow   = e.kind === "agent_stream" &&  evLine.startsWith("→");
                    const isBubbleKind = isGenuineText || BUBBLE_KINDS.has(e.kind);

                    if (isBubbleKind) {
                      // Finalize any open bubble, start a new one
                      if (openBubble) groups.push({ type: "bubble", ...openBubble });
                      openBubble = { event: e, arrows: [] };
                    } else if (isArrowRow) {
                      if (openBubble && openBubble.event.actor === e.actor) {
                        // Same actor — absorb into open bubble
                        openBubble.arrows.push(e);
                      } else {
                        // Different actor or no open bubble — fold into a "Continuing…" group
                        if (openBubble) { groups.push({ type: "bubble", ...openBubble }); openBubble = null; }
                        const last = groups[groups.length - 1];
                        if (last?.type === "continuing" && last.actor === e.actor) {
                          last.arrows.push(e);
                        } else {
                          groups.push({ type: "continuing", actor: e.actor, arrows: [e] });
                        }
                      }
                    } else {
                      // Non-bubble event — close chain, insert inline
                      if (openBubble) { groups.push({ type: "bubble", ...openBubble }); openBubble = null; }
                      groups.push({ type: "other", event: e });
                    }
                  }
                  if (openBubble) groups.push({ type: "bubble", ...openBubble });

                  let lastDayKey = "";
                  const rendered: React.ReactNode[] = [];
                  groups.forEach((g, gi) => {
                    const evDate = new Date(
                      g.type === "continuing" ? g.arrows[0]!.createdAt : g.event.createdAt
                    );
                    const dayKey = evDate.toDateString();
                    if (dayKey !== lastDayKey) {
                      lastDayKey = dayKey;
                      const today = new Date();
                      const isToday = dayKey === today.toDateString();
                      if (!isToday) {
                        const label = evDate.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
                        rendered.push(
                          <li key={`day-${dayKey}`} className="flex items-center gap-2 py-1 -mx-1 select-none">
                            <span className="flex-1 border-t border-border/40" />
                            <span className="text-[10px] text-muted/60 whitespace-nowrap">{label}</span>
                            <span className="flex-1 border-t border-border/40" />
                          </li>
                        );
                      }
                    }
                    if (g.type === "continuing") {
                      const ctx = agentContextFor(g.arrows[0]!);
                      rendered.push(
                        <ActivityRow
                          key={`continuing-${gi}`}
                          event={g.arrows[0]!}
                          agent={ctx.agent}
                          model={ctx.model}
                          arrows={g.arrows}
                          synthetic
                        />
                      );
                    } else {
                      const ctx = agentContextFor(g.event);
                      rendered.push(
                        <ActivityRow
                          key={g.event.id}
                          event={g.event}
                          agent={ctx.agent}
                          model={ctx.model}
                          arrows={g.type === "bubble" ? g.arrows : undefined}
                        />
                      );
                    }
                  });
                  return rendered;
                })()}
              </ol>
            )}
          </Section>
        </div>
      </div>

      {/* Comment composer — stays at bottom of right column */}
      <div className="shrink-0 bg-bg border-t border-border px-5 pt-3 pb-3">
        <div className="flex gap-2 items-end">
          <textarea
            className="flex-1 bg-surface border border-border rounded-md px-3 py-2 text-sm text-text placeholder:text-muted resize-none"
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
          <div className="flex flex-col gap-1.5 shrink-0">
            <button
              className="btn btn-primary text-xs px-3"
              disabled={!commentBody.trim() || commentMut.isPending}
              onClick={() => commentMut.mutate()}
            >
              {commentMut.isPending ? "…" : "Send"}
            </button>
            <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer select-none">
              <input
                type="checkbox"
                checked={commentInterrupt}
                onChange={(e) => setCommentInterrupt(e.target.checked)}
                className="accent-accent"
              />
              Interrupt
            </label>
          </div>
        </div>
      </div>

      {/* Status dropdown — position: fixed anchored via getBoundingClientRect */}
      {statusOpen && statusPos && (
        <div
          id="status-fixed-dropdown"
          className="bg-surface2 border border-border rounded-md shadow-xl py-1 z-[9999]"
          style={{ position: "fixed", top: statusPos.top, left: statusPos.left, width: statusPos.width }}
        >
          {STATUS_OPTIONS.map((s) => (
            <button
              key={s}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-surface transition-colors text-left cursor-pointer"
              onClick={() => { patchMut.mutate({ status: s }); setStatusOpen(false); }}
            >
              <StatusDot status={s} />
              <span className="text-text">{STATUS_LABELS[s]}</span>
            </button>
          ))}
        </div>
      )}

      {/* ⋯ menu — position: fixed anchored via getBoundingClientRect */}
      {menuOpen && menuPos && (
        <div
          id="story-actions-menu"
          className="bg-surface2 border border-border rounded-md shadow-xl py-1 z-[9999] w-40"
          style={{ position: "fixed", top: menuPos.top, left: menuPos.left }}
        >
          <button
            className="flex items-center w-full px-3 py-1.5 text-sm hover:bg-surface transition-colors text-left cursor-pointer text-text disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleRespec}
            disabled={!dispatchable || dispatchMut.isPending || patchMut.isPending}
            title="Force re-spec: reassign to spec-writer and dispatch."
          >
            Re-spec
          </button>
          <button
            className="flex items-center w-full px-3 py-1.5 text-sm hover:bg-surface transition-colors text-left cursor-pointer text-red-400 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleDelete}
            disabled={running || deleteMut.isPending}
            title="Delete this story permanently"
          >
            {deleteMut.isPending ? "Deleting…" : "Delete"}
          </button>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Activity helpers (ported verbatim from StoryDetailPage)
// ---------------------------------------------------------------------------

function ActivityBubble({ ts, dayMarker, tsTitle, name, colors, body, bodyNode, icon, tag, footer }: { ts: string; dayMarker?: string; tsTitle: string; name: string; colors: ActorColors; body?: string; bodyNode?: ReactNode; icon?: IconDefinition; tag?: ReactNode; footer?: ReactNode }) {
  return (
    <li className="flex gap-2 text-xs -mx-1">
      <div className="text-muted shrink-0 w-20 whitespace-nowrap pt-1" title={tsTitle}>
        <div>{ts}</div>
        {dayMarker && <div className="text-[9px] text-muted/70">{dayMarker}</div>}
      </div>
      <div className="flex-1 min-w-0 rounded-md border border-border bg-surface px-3 py-2 space-y-1">
        <div className="flex items-center gap-2">
          {icon && (
            <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full shrink-0 ${colors.bg} ${colors.text}`}>
              <FontAwesomeIcon icon={icon} className="text-[9px]" />
            </span>
          )}
          <span className={`font-medium text-[11px] ${colors.text}`}>{name}</span>
          {tag}
        </div>
        <div className="text-text break-words whitespace-pre-wrap leading-relaxed">
          {bodyNode ?? (body !== undefined ? renderMarkdown(maybePrettyJson(body)) : null)}
        </div>
        {footer}
      </div>
    </li>
  );
}

function ActivityRow({ event, agent, model, arrows, synthetic }: { event: ActivityEvent; agent?: string; model?: string; arrows?: ActivityEvent[]; synthetic?: boolean }) {
  const tsDate = new Date(event.createdAt);
  const ts = tsDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const tsTitle = tsDate.toLocaleString();
  const today = new Date();
  const isToday = tsDate.toDateString() === today.toDateString();
  const dayMarker = isToday
    ? undefined
    : tsDate.toLocaleDateString([], { weekday: "short", month: "numeric", day: "numeric" });
  const line = shortenHome(renderEvent(event));
  const fullLine = shortenHome(renderEvent(event, true));
  const isArrow = line.startsWith("→");
  const isTriageQuestion = event.kind === "triage_question";
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((v) => !v), []);

  const shortAgent = (agent === "user" ? USER_LABEL : agent) ?? "";
  const isSystemActor = event.actor === "user" || event.actor === "system" || !event.actor;
  const shortModel = isSystemActor ? "" : (model?.replace(/^.*\//, "").replace(/^claude-/, "") ?? "");

  // NB: do not introduce a local component wrapper here — its identity would
  // change on every parent re-render, causing React to remount the entire
  // bubble subtree and blow away browser-managed state like <details open>.
  // Pass ts/tsTitle through to ActivityBubble explicitly instead.

  // User comment (posted via comment box)
  if (event.kind === "comment") {
    const p = event.payload as { body?: string; interrupt?: boolean };
    const commentName = event.actor === "user" ? USER_LABEL : event.actor;
    return (
      <ActivityBubble ts={ts} dayMarker={dayMarker} tsTitle={tsTitle}
        name={commentName}
        colors={agentColors(commentName)}
        icon={agentIcon(commentName)}
        body={p.body ?? ""}
        tag={p.interrupt ? <span className="text-[10px] text-amber-400">⚡ interrupt</span> : undefined}
      />
    );
  }

  // agent_prompt — shown as a comment from "you" addressed to the agent
  if (event.kind === "agent_prompt") {
    const p = event.payload as Record<string, unknown>;
    const targetAgent = (p.agent ?? event.actor ?? "") as string;
    const promptBody = (p.prompt ?? p.body ?? "") as string;
    const systemPrompt = (p.systemPrompt ?? "") as string;
    return (
      <ActivityBubble ts={ts} dayMarker={dayMarker} tsTitle={tsTitle}
        name={USER_LABEL}
        colors={agentColors(USER_LABEL)}
        icon={agentIcon(USER_LABEL)}
        bodyNode={
          <>
            {systemPrompt && (
              <details className="mb-2 rounded border border-border/60 bg-bg/40">
                <summary className="cursor-pointer select-none px-2 py-1 text-[11px] text-muted hover:text-text">
                  system prompt ({systemPrompt.length.toLocaleString()} chars)
                </summary>
                <div className="border-t border-border/60 px-2 py-2 break-words whitespace-pre-wrap leading-relaxed">
                  {renderMarkdown(systemPrompt)}
                </div>
              </details>
            )}
            {renderMarkdown(maybePrettyJson(`@${targetAgent}: ${promptBody}`))}
          </>
        }
      />
    );
  }

  // agent_transition — "changed actor {from} to {to}" with colored names
  if (event.kind === "agent_transition") {
    const p = event.payload as { from?: string | null; to?: string | null };
    const actorName = (event.actor === "user" ? USER_LABEL : event.actor) || "system";
    const fromName = p.from ?? "(none)";
    const toName = p.to ?? "(none)";
    return (
      <ActivityBubble ts={ts} dayMarker={dayMarker} tsTitle={tsTitle}
        name={actorName}
        colors={agentColors(actorName)}
        icon={agentIcon(actorName)}
        bodyNode={
          <span>
            changed actor{" "}
            <span className={agentColors(fromName).text}>{fromName}</span>
            {" → "}
            <span className={agentColors(toName).text}>{toName}</span>
          </span>
        }
      />
    );
  }

  // state_transition — "changed state to {status}" with bold-white status
  if (event.kind === "state_transition") {
    const p = event.payload as { status?: string };
    const actorName = (event.actor === "user" ? USER_LABEL : event.actor) || "system";
    return (
      <ActivityBubble ts={ts} dayMarker={dayMarker} tsTitle={tsTitle}
        name={actorName}
        colors={agentColors(actorName)}
        icon={agentIcon(actorName)}
        bodyNode={
          <span>
            changed state to{" "}
            <span className="font-bold text-white">{p.status ?? "unknown"}</span>
          </span>
        }
      />
    );
  }

  // agent_stream genuine text response (non-arrow) — also used for synthetic "Continuing…" bubbles
  if (synthetic || (event.kind === "agent_stream" && !isArrow)) {
    const label = shortModel ? `${shortAgent} (${shortModel})` : shortAgent;
    const arrowFooter = arrows && arrows.length > 0 ? (
      <ul className="mt-1 border-t border-border/50 pt-1 space-y-0.5">
        {arrows.map((a) => {
          const aLine = shortenHome(renderEvent(a, true));
          return (
            <li key={a.id} className="text-[11px] text-muted truncate" title={aLine}>
              {parseInlineMarkdown(aLine)}
            </li>
          );
        })}
      </ul>
    ) : undefined;
    return (
      <ActivityBubble ts={ts} dayMarker={dayMarker} tsTitle={tsTitle}
        name={label || "agent"}
        colors={agentColors(shortAgent)}
        icon={agentIcon(shortAgent)}
        body={synthetic ? "Continuing…" : fullLine}
        footer={arrowFooter}
      />
    );
  }

  if (isTriageQuestion) {
    return (
      <li className="flex gap-2 text-xs rounded px-2 py-1.5 -mx-1 bg-amber-500/15 border border-amber-500/30">
        <div className="text-muted shrink-0 w-20 whitespace-nowrap" title={tsTitle}>
          <div>{ts}</div>
          {dayMarker && <div className="text-[9px] text-muted/70">{dayMarker}</div>}
        </div>
        <span className="text-muted shrink-0 w-20 truncate" title={agent}>{shortAgent}</span>
        {shortModel && <span className="text-muted shrink-0 w-24 truncate" title={model}>{shortModel}</span>}
        <span className="shrink-0 w-28 text-amber-400 font-medium">triage question</span>
        <div className="flex-1 min-w-0 overflow-x-auto">
          <span className="text-amber-200 break-words whitespace-pre-wrap">{renderMarkdown(fullLine)}</span>
        </div>
      </li>
    );
  }

  // Non-arrow events that are NOT agent_stream text (dispatch_completed, state_transition, etc.)
  if (!isArrow) {
    const display = maybePrettyJson(fullLine);
    let changedFilesNode: ReactNode = null;
    if (event.kind === "dispatch_completed") {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      const changedFiles = Array.isArray(payload.changedFiles) ? (payload.changedFiles as string[]) : [];
      const gitDiff = typeof payload.gitDiff === "string" ? payload.gitDiff : "";
      if (changedFiles.length === 0) {
        changedFilesNode = (
          <div className="text-xs text-muted mt-1">Agent touched no files under the repo root.</div>
        );
      } else {
        const diffStats = parseDiffStats(gitDiff);
        changedFilesNode = (
          <ul className="text-xs font-mono text-text space-y-0.5 mt-1">
            {changedFiles.map((f) => {
              const s = diffStats.get(f);
              return (
                <li key={f} className="flex items-center gap-2 truncate">
                  <span className="truncate">{f}</span>
                  {s && (
                    <span className="flex-shrink-0 ml-auto flex gap-1.5">
                      {s.added > 0 && <span className="text-green-500">+{s.added}</span>}
                      {s.removed > 0 && <span className="text-red-500">-{s.removed}</span>}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        );
      }
    }
    return (
      <li className="flex items-start gap-2 text-xs rounded py-1 -mx-1">
        <div className="text-muted shrink-0 w-20 whitespace-nowrap pt-px" title={tsTitle}>
          <div>{ts}</div>
          {dayMarker && <div className="text-[9px] text-muted/70">{dayMarker}</div>}
        </div>
        <span className="text-muted shrink-0 w-20 truncate pt-px" title={agent}>{shortAgent}</span>
        {shortModel && <span className="text-muted shrink-0 w-24 truncate pt-px" title={model}>{shortModel}</span>}
        <span className="text-muted shrink-0 w-28 truncate pt-px">{event.kind}</span>
        <div className="flex-1 min-w-0 overflow-x-auto">
          <span className="text-text break-words whitespace-pre-wrap">{renderMarkdown(display)}</span>
          {changedFilesNode}
        </div>
      </li>
    );
  }

  return (
    <li className="flex gap-2 text-xs cursor-pointer hover:bg-surface/50 rounded py-0.5 -mx-1" onClick={toggle}>
      <div className="text-muted shrink-0 w-20 whitespace-nowrap pt-px" title={tsTitle}>
        <div>{ts}</div>
        {dayMarker && <div className="text-[9px] text-muted/70">{dayMarker}</div>}
      </div>
      <span className="text-muted shrink-0 w-20 truncate pt-px" title={agent}>{shortAgent}</span>
      {shortModel && <span className="text-muted shrink-0 w-24 truncate pt-px" title={model}>{shortModel}</span>}
      <span className="text-muted shrink-0 w-28 truncate pt-px">{event.kind}</span>
      <div className={`flex-1 min-w-0 ${expanded ? "overflow-x-auto" : "overflow-hidden"}`}>
        <span className={`text-muted ${expanded ? "break-words whitespace-pre-wrap" : "truncate block"}`}>
          {expanded ? renderMarkdown(fullLine) : parseInlineMarkdown(line)}
        </span>
      </div>
    </li>
  );
}

function AnsweredQuestion({ question }: { question: RefinementQuestion }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-md border border-border/60 bg-surface/60 px-3 py-2 text-xs">
      <button
        className="w-full text-left flex items-start gap-2 hover:text-text transition-colors cursor-pointer"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="text-muted shrink-0">{open ? "▾" : "▸"}</span>
        <span className="flex-1 min-w-0">
          <span className="text-muted line-through decoration-muted/40">
            {question.question}
          </span>
        </span>
        <span className="pill text-[10px] text-done border-done/40 shrink-0">
          answered
        </span>
      </button>
      {open && (
        <div className="mt-2 pl-4 border-l-2 border-done/30">
          <div className="text-text whitespace-pre-wrap break-words">
            {question.answer ?? ""}
          </div>
          {question.answeredAt && (
            <div className="text-[10px] text-muted mt-1">
              answered {new Date(question.answeredAt).toLocaleString()}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function QuestionForm({ question, storyId }: { question: RefinementQuestion; storyId: string }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [skipping, setSkipping] = useState(false);

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
      setSkipping(false);
    },
  });

  return (
    <li className="rounded-md border border-border bg-surface px-3 py-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-sm text-text font-medium">{question.question}</div>
          {question.context && (
            <div className="text-[11px] text-muted italic mt-0.5">{question.context}</div>
          )}
          <div className="flex items-center gap-2 mt-1.5">
            <span className="pill text-[10px]">{question.source}</span>
            {question.blocksDispatch && (
              <span className="pill text-[10px] text-cert-low border-cert-low/40">
                blocks dispatch
              </span>
            )}
          </div>
        </div>
      </div>
      <textarea
        className="w-full bg-bg border border-border rounded px-2 py-1.5 text-sm text-text placeholder:text-muted resize-y min-h-[64px]"
        placeholder="Answer (⌘↵ to submit)"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && draft.trim()) {
            answerMut.mutate();
          }
        }}
      />
      <div className="flex items-center justify-end gap-2">
        <button
          className="btn text-xs"
          onClick={() => {
            setSkipping(true);
            skipMut.mutate();
          }}
          disabled={skipping || skipMut.isPending}
        >
          {skipMut.isPending ? "Skipping…" : "Skip (obsolete)"}
        </button>
        <button
          className="btn btn-primary text-xs"
          disabled={!draft.trim() || answerMut.isPending}
          onClick={() => answerMut.mutate()}
        >
          {answerMut.isPending ? "Answering…" : "Answer"}
        </button>
      </div>
    </li>
  );
}
