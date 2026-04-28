import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { USER_LABEL, agentColors, agentIcon, type ActorColors } from "../utils/agentStyle.js";
import { useParams, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ActivityEvent } from "../api.js";
import { PageHeader } from "../components/PageHeader.js";
import { Breadcrumb } from "../components/Breadcrumb.js";
import { StatusDot } from "../components/StatusDot.js";
import { Section } from "../components/Section.js";
import { NewStoryModal } from "../components/NewStoryModal.js";
import { useProjectContext } from "../state/ProjectContext.js";
import {
  renderEvent,
  shortenHome,
  isHideableToolUse,
  extractContent,
  parseDiffStats,
  findAllCompletions,
} from "../utils/activity.js";
import { renderMarkdown, parseInlineMarkdown, maybePrettyJson } from "../utils/markdown.js";
import { formatTokens } from "../utils/formatters.js";
import type { StoryStatus } from "@orca/shared";

const STATUS_OPTIONS: StoryStatus[] = [
  "icebox", "backlog", "in_progress", "in_qa", "final_review", "blocked", "done", "canceled",
];
const STATUS_LABELS: Record<StoryStatus, string> = {
  icebox: "icebox",
  backlog: "backlog",
  in_progress: "in progress",
  in_qa: "in qa",
  final_review: "final review",
  blocked: "blocked",
  done: "done",
  canceled: "canceled",
};

export function StoryDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { activeProjectId, activeProject } = useProjectContext();

  const [editingTitle, setEditingTitle] = useState(false);
  const [editingSpec, setEditingSpec] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [specDraft, setSpecDraft] = useState("");
  const [specHeight, setSpecHeight] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const specRef = useRef<HTMLTextAreaElement>(null);
  const statusDropRef = useRef<HTMLDivElement>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["story", id],
    queryFn: () => api.stories.get(id!),
    enabled: !!id,
    refetchInterval: (q) => {
      const s = q.state.data?.story.status;
      return s === "in_progress" ? 2000 : 30_000;
    },
  });

  const dispatchMut = useMutation({
    mutationFn: () => api.stories.dispatch(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["story", id] });
      queryClient.invalidateQueries({ queryKey: ["stories"] });
    },
  });

  const [showFindingForm, setShowFindingForm] = useState(false);
  const [findingBody, setFindingBody] = useState("");
  const [findingRootCause, setFindingRootCause] = useState("agent-false-completion");

  const fileFindingMut = useMutation({
    mutationFn: ({ body, rootCause }: { body: string; rootCause: string }) =>
      api.findings.create({ storyId: id!, source: "human", body, rootCause }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["story", id] });
      queryClient.invalidateQueries({ queryKey: ["stories"] });
      setShowFindingForm(false);
      setFindingBody("");
      setFindingRootCause("agent-false-completion");
    },
  });

  const stopMut = useMutation({
    mutationFn: () => api.stories.stop(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["story", id] });
      queryClient.invalidateQueries({ queryKey: ["stories"] });
    },
  });

  const [commentBody, setCommentBody] = useState("");
  const [commentInterrupt, setCommentInterrupt] = useState(true);
  const commentMut = useMutation({
    mutationFn: () => api.stories.comment(id!, { body: commentBody, interrupt: commentInterrupt }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["story", id] });
      queryClient.invalidateQueries({ queryKey: ["stories"] });
      setCommentBody("");
    },
  });

  const patchMut = useMutation({
    mutationFn: (body: { title?: string; specMd?: string; status?: StoryStatus; agent?: string | null }) =>
      api.stories.patch(id!, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["story", id] });
      queryClient.invalidateQueries({ queryKey: ["stories"] });
    },
  });

  const deleteMut = useMutation({
    mutationFn: () => api.stories.remove(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stories"] });
      navigate("/stories");
    },
  });

  const createMut = useMutation({
    mutationFn: (body: { title: string; specMd: string; status: "icebox" | "backlog"; agent: string }) =>
      api.stories.create({ projectId: activeProjectId!, ...body }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["stories"] });
      setCreating(false);
      if (result?.story?.id) navigate(`/stories/${result.story.id}`);
    },
  });

  const { data: agentsData } = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.agents.list(),
  });

  useEffect(() => {
    if (!statusOpen) return;
    function handleClick(e: MouseEvent) {
      if (statusDropRef.current && !statusDropRef.current.contains(e.target as Node)) {
        setStatusOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [statusOpen]);

  useEffect(() => { if (editingTitle) titleRef.current?.focus(); }, [editingTitle]);
  useEffect(() => { if (editingSpec) specRef.current?.focus(); }, [editingSpec]);

  if (!id) return null;
  if (isLoading || !data) {
    return (
      <div className="flex flex-col">
        <PageHeader title="Story" />
        <div className="p-6 text-muted text-sm">loading…</div>
      </div>
    );
  }

  const { story, activity: rawActivity } = data;

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

  const dispatchable = story.status !== "in_progress";
  const running = story.status === "in_progress";
  const completions = findAllCompletions(activity);

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

  return (
    <div className="flex flex-col">
      <PageHeader
        title={
          <Breadcrumb
            first={activeProject?.name ?? "…"}
            second={
              editingTitle ? (
                <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); saveTitle(); }}>
                  <input
                    ref={titleRef}
                    className="text-sm font-semibold bg-surface border border-border rounded px-2 py-0.5 text-text"
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Escape") setEditingTitle(false); }}
                    onBlur={saveTitle}
                  />
                </form>
              ) : (
                <span>
                  <span className="text-muted font-normal">#{story.id.slice(0, 8)}</span>{" "}
                  <span className="cursor-pointer hover:underline decoration-dotted underline-offset-4" onClick={startEditTitle} title="Click to edit title">
                    {story.title}
                  </span>
                </span>
              )
            }
          />
        }
        actions={
          <>
            {running && (
              <span className="flex items-center gap-1.5 text-xs text-accent">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-accent opacity-75 animate-ping" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
                </span>
                agent running
                {story.dispatchPid != null && <span className="text-muted">(pid {story.dispatchPid})</span>}
              </span>
            )}
            {running ? (
              <button className="btn bg-red-600 hover:bg-red-700 text-white" onClick={() => stopMut.mutate()} disabled={stopMut.isPending} title="Kill the running agent and block the story">
                {stopMut.isPending ? "Stopping…" : "Stop"}
              </button>
            ) : (
              <>
                <button
                  className="btn btn-primary"
                  onClick={() => dispatchMut.mutate()}
                  disabled={!dispatchable || dispatchMut.isPending}
                  title={dispatchable ? "Spawn claude in the project repo with this story's spec" : "Cannot dispatch a story that is already in progress"}
                >
                  {dispatchMut.isPending ? "Dispatching…" : "Dispatch"}
                </button>
                {(story.status === "in_qa" || story.status === "final_review" || story.status === "done") && (
                  <button className="btn bg-red-900/60 hover:bg-red-900 text-red-200" onClick={() => setShowFindingForm(true)} title="File a finding against this story">
                    File finding
                  </button>
                )}
              </>
            )}
            <button className="btn btn-primary" onClick={() => setCreating(true)} disabled={!activeProjectId}>
              New story
            </button>
          </>
        }
      />

      {showFindingForm && (
        <div className="mx-6 mt-4 p-4 rounded-lg border border-red-500/40 bg-red-950/30">
          <h3 className="text-sm font-semibold text-red-300 mb-2">File finding</h3>
          <p className="text-xs text-muted mb-3">Record what went wrong. Story status is unchanged.</p>
          <label className="block text-xs text-muted mb-1">Root cause</label>
          <select className="w-full bg-surface border border-border rounded px-3 py-1.5 text-sm text-text mb-3" value={findingRootCause} onChange={(e) => setFindingRootCause(e.target.value)}>
            <optgroup label="Agent reliability">
              <option value="agent-false-completion">agent-false-completion — claimed done, wasn't</option>
              <option value="agent-failure">agent-failure — misread instructions</option>
            </optgroup>
            <optgroup label="Human foresight gaps">
              <option value="bad-spec">bad-spec — spec was wrong/incomplete</option>
              <option value="missing-context">missing-context — agent lacked needed context</option>
              <option value="missing-constraint">missing-constraint — unstated constraint</option>
              <option value="missing-audit-row">missing-audit-row</option>
            </optgroup>
            <optgroup label="Process">
              <option value="pipeline-failure">pipeline-failure — plumbing dropped it</option>
              <option value="tooling-gap">tooling-gap — new check/tool needed</option>
            </optgroup>
            <optgroup label="Other">
              <option value="user-error">user-error — my fault</option>
              <option value="unknown">unknown</option>
            </optgroup>
          </select>
          <label className="block text-xs text-muted mb-1">What happened?</label>
          <textarea className="w-full bg-surface border border-border rounded px-3 py-2 text-sm text-text placeholder:text-muted resize-y min-h-[80px] mb-3" placeholder="What was missed or went wrong?" value={findingBody} onChange={(e) => setFindingBody(e.target.value)} />
          <div className="flex gap-2 justify-end">
            <button className="btn text-xs" onClick={() => { setShowFindingForm(false); setFindingBody(""); setFindingRootCause("agent-false-completion"); }}>Cancel</button>
            <button className="btn bg-red-600 hover:bg-red-700 text-white text-xs" onClick={() => fileFindingMut.mutate({ body: findingBody, rootCause: findingRootCause })} disabled={!findingBody.trim() || fileFindingMut.isPending}>
              {fileFindingMut.isPending ? "Filing…" : "File finding"}
            </button>
          </div>
        </div>
      )}

      <section className="p-5 grid grid-cols-[1fr_minmax(280px,400px)] gap-6">
        <div className="space-y-6 min-w-0">
          <Section
            title="Spec"
            action={!editingSpec && <button className="text-[11px] text-accent hover:underline" onClick={startEditSpec}>Edit</button>}
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

          <Section title="Activity">
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

                  return groups.map((g, gi) => {
                    if (g.type === "continuing") {
                      const ctx = agentContextFor(g.arrows[0]!);
                      return (
                        <ActivityRow
                          key={`continuing-${gi}`}
                          event={g.arrows[0]!}
                          agent={ctx.agent}
                          model={ctx.model}
                          arrows={g.arrows}
                          synthetic
                        />
                      );
                    }
                    const ctx = agentContextFor(g.event);
                    return (
                      <ActivityRow
                        key={g.event.id}
                        event={g.event}
                        agent={ctx.agent}
                        model={ctx.model}
                        arrows={g.type === "bubble" ? g.arrows : undefined}
                      />
                    );
                  });
                })()}
              </ol>
            )}
          </Section>

          {/* Comment footer — inside left column, sticky to bottom of viewport */}
          <div className="sticky bottom-0 bg-bg border-t border-border pt-3 pb-2">
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
        </div>

        <div className="space-y-6 min-w-0 sticky top-12 self-start">
          <Section title="Status">
            <div className="relative" ref={statusDropRef}>
              <button
                className="flex items-center gap-2 w-full bg-surface2 border border-border rounded-md px-3 py-2 text-sm text-left hover:border-accent/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={() => setStatusOpen((v) => !v)}
                disabled={running || patchMut.isPending}
              >
                <StatusDot status={story.status} />
                <span className="flex-1 text-text">{STATUS_LABELS[story.status]}</span>
                <span className="text-muted text-xs">▾</span>
              </button>
              {statusOpen && (
                <div className="absolute top-full left-0 w-full mt-1 bg-surface2 border border-border rounded-md shadow-xl z-10 py-1">
                  {STATUS_OPTIONS.map((s) => (
                    <button key={s} className="flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-surface transition-colors text-left" onClick={() => { patchMut.mutate({ status: s }); setStatusOpen(false); }}>
                      <StatusDot status={s} />
                      <span className="text-text">{STATUS_LABELS[s]}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </Section>

          <Section title="Agent">
            <select
              className="w-full bg-surface2 border border-border rounded-md px-3 py-2 text-sm text-text cursor-pointer outline-none hover:border-accent/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              value={story.agent ?? ""}
              onChange={(e) => patchMut.mutate({ agent: e.target.value || null })}
              disabled={running || patchMut.isPending}
            >
              <option value="">(unassigned)</option>
              {agentsData?.agents.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
            </select>
          </Section>

          <div className="flex justify-end">
            <button className="btn text-xs text-red-400 hover:text-red-300 hover:bg-red-950/40 border-red-900/40" title="Delete this story permanently" disabled={running || deleteMut.isPending} onClick={() => { if (confirm(`Delete "${story.title}"? This cannot be undone.`)) deleteMut.mutate(); }}>
              {deleteMut.isPending ? "Deleting…" : "Delete story"}
            </button>
          </div>

          {completions.length === 0 ? (
            <Section title="Changed Files">
              <div className="text-xs text-muted">No dispatch has completed yet.</div>
            </Section>
          ) : (
            completions.map((c, idx) => {
              const runLabel = completions.length > 1 ? `Run ${idx + 1} — ${new Date(c.completedAt).toLocaleString()}` : "Changed Files";
              const diffStats = parseDiffStats(c.gitDiff);
              return (
                <Section key={idx} title={runLabel} subtitle={[c.totalCostUsd != null ? `$${c.totalCostUsd.toFixed(2)}` : null, c.totalTokensUsed != null ? formatTokens(c.totalTokensUsed) : null].filter(Boolean).join(" · ")}>
                  {c.changedFiles.length === 0 ? (
                    <div className="text-xs text-muted">Agent touched no files under the repo root.</div>
                  ) : (
                    <ul className="text-xs font-mono text-text space-y-0.5">
                      {c.changedFiles.map((f) => {
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
                  )}
                </Section>
              );
            })
          )}
        </div>
      </section>

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


function ActivityBubble({ ts, tsTitle, name, colors, body, bodyNode, icon, tag, footer }: { ts: string; tsTitle: string; name: string; colors: ActorColors; body?: string; bodyNode?: ReactNode; icon?: IconDefinition; tag?: ReactNode; footer?: ReactNode }) {
  return (
    <li className="flex gap-2 text-xs -mx-1">
      <span className="text-muted shrink-0 w-16 whitespace-nowrap pt-1" title={tsTitle}>{ts}</span>
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
  const ts = tsDate.toLocaleTimeString();
  const tsTitle = tsDate.toLocaleString();
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
      <ActivityBubble ts={ts} tsTitle={tsTitle}
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
      <ActivityBubble ts={ts} tsTitle={tsTitle}
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
      <ActivityBubble ts={ts} tsTitle={tsTitle}
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
      <ActivityBubble ts={ts} tsTitle={tsTitle}
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
      <ActivityBubble ts={ts} tsTitle={tsTitle}
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
        <span className="text-muted shrink-0 w-16 whitespace-nowrap" title={tsTitle}>{ts}</span>
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
    return (
      <li className="flex gap-2 text-xs rounded py-1 -mx-1">
        <span className="text-muted shrink-0 w-16 whitespace-nowrap pt-px" title={tsTitle}>{ts}</span>
        <span className="text-muted shrink-0 w-20 truncate pt-px" title={agent}>{shortAgent}</span>
        {shortModel && <span className="text-muted shrink-0 w-24 truncate pt-px" title={model}>{shortModel}</span>}
        <span className="text-muted shrink-0 w-28 truncate pt-px">{event.kind}</span>
        <div className="flex-1 min-w-0 overflow-x-auto">
          <span className="text-text break-words whitespace-pre-wrap">{renderMarkdown(display)}</span>
        </div>
      </li>
    );
  }

  return (
    <li className="flex gap-2 text-xs cursor-pointer hover:bg-surface/50 rounded py-0.5 -mx-1" onClick={toggle}>
      <span className="text-muted shrink-0 w-16 whitespace-nowrap pt-px" title={tsTitle}>{ts}</span>
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
