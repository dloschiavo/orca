import { useState, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageHeader } from "../components/PageHeader.js";
import { Breadcrumb } from "../components/Breadcrumb.js";
import { StatusDot } from "../components/StatusDot.js";
import { NewStoryModal } from "../components/NewStoryModal.js";
import { useProjectContext } from "../state/ProjectContext.js";
import { formatElapsed, formatTokens, tokenHeatColor } from "../utils/formatters.js";
import type { Story } from "@orca/shared";

export function StoriesPage() {
  const navigate = useNavigate();
  const { activeProjectId, activeProject } = useProjectContext();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["stories", activeProjectId],
    queryFn: () =>
      activeProjectId
        ? api.stories.list({ projectId: activeProjectId })
        : Promise.resolve({ stories: [] as Story[] }),
    enabled: !!activeProjectId,
    refetchInterval: (q) => {
      const stories = q.state.data?.stories ?? [];
      return stories.some((s) => s.status === "in_progress") ? 10_000 : 30_000;
    },
  });

  const visible = data?.stories ?? [];

  const [, setTick] = useState(0);
  const hasInProgress = visible.some((s) => s.status === "in_progress");
  useEffect(() => {
    if (!hasInProgress) return;
    const id = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => clearInterval(id);
  }, [hasInProgress]);

  const { data: agentsData } = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.agents.list(),
  });

  const createMut = useMutation({
    mutationFn: (body: { title: string; specMd: string; status: "icebox" | "backlog"; agent: string }) =>
      api.stories.create({ projectId: activeProjectId!, ...body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stories"] });
      setCreating(false);
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

      <div className="flex-1 overflow-y-auto">
        {isLoading && <div className="p-6 text-muted text-sm">loading…</div>}
        <table className="w-full text-left table-fixed">
          <thead>
            <tr className="border-b border-border text-[11px] text-muted uppercase tracking-wide">
              <th className="px-6 py-2 font-medium w-[72px]">ID</th>
              <th className="px-2 py-2 font-medium">Title</th>
              <th className="px-2 py-2 font-medium text-right whitespace-nowrap w-[280px]">Info</th>
              <th className="px-2 py-2 font-medium text-right w-[64px]">Cost</th>
              <th className="px-2 py-2 font-medium text-right w-[80px]">Tokens</th>
              <th className="px-2 py-2 font-medium text-right pr-6 w-[88px]">Updated</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {visible.map((story) => (
              <tr key={story.id} className="group hover:bg-surface transition-colors cursor-pointer" onClick={() => navigate(`/stories/${story.id}`)}>
                <td className="px-6 py-2.5 text-[11px] text-muted group-hover:text-accent">{story.id.slice(0, 7)}</td>
                <td className="px-2 py-2.5 max-w-0">
                  <div className="flex items-center gap-2 min-w-0 text-sm text-text group-hover:text-accent">
                    <StatusDot status={story.status} className="shrink-0" />
                    <span className="truncate">{story.title}</span>
                  </div>
                </td>
                <td className="px-2 py-2.5 whitespace-nowrap text-right">
                  <div className="flex items-center justify-end gap-2">
                    {story.status === "in_progress" && story.dispatchPid != null && (
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
            ))}
          </tbody>
        </table>
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
