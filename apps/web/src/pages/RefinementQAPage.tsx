import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { PageHeader } from "../components/PageHeader.js";
import { Breadcrumb } from "../components/Breadcrumb.js";
import { useProjectContext } from "../state/ProjectContext.js";
import type { RefinementQuestion, StoryStatus } from "@orca/shared";

// The Refinement Q&A Inbox — the metavine-principle surface. Bubble up
// uncertainty *ahead of* agent resource availability so that when a slot
// frees, the thinking is already pre-loaded.
//
// Keyboard-first ergonomics (spec §Feedback Loop):
//   j/k  — move
//   a    — focus answer
//   ⌘↵   — submit + advance
//   s    — skip (obsolete)
//   o    — open source story

interface InboxItem {
  q: RefinementQuestion;
  storyTitle: string;
  storyStatus: StoryStatus;
  storyProjectId: string;
}

export function RefinementQAPage() {
  const { activeProjectId, activeProject } = useProjectContext();
  const queryClient = useQueryClient();
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["refinement-questions", activeProjectId],
    queryFn: () =>
      api.refinementQuestions.list({
        projectId: activeProjectId ?? undefined,
      }),
  });

  const items = useMemo<InboxItem[]>(
    () => (data?.questions as InboxItem[] | undefined) ?? [],
    [data],
  );
  const current = items[index] ?? null;

  useEffect(() => {
    setAnswer("");
  }, [current?.q.id]);

  const answerMut = useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) =>
      api.refinementQuestions.answer(id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["refinement-questions"] });
      setAnswer("");
      // Advance to next (same index — the list shrinks under us).
      setIndex((i) => Math.max(0, Math.min(i, items.length - 2)));
    },
  });

  const skipMut = useMutation({
    mutationFn: (id: string) => api.refinementQuestions.skip(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["refinement-questions"] });
      setIndex((i) => Math.max(0, Math.min(i, items.length - 2)));
    },
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement && e.key !== "Enter") return;
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "j") setIndex((i) => Math.min(items.length - 1, i + 1));
      if (e.key === "k") setIndex((i) => Math.max(0, i - 1));
      if (e.key === "s" && current) skipMut.mutate(current.q.id);
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && current && answer) {
        answerMut.mutate({ id: current.q.id, body: answer });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [items.length, current, answer, answerMut, skipMut]);

  return (
    <div className="h-full flex flex-col">
      <PageHeader
        title={<Breadcrumb first={activeProject?.name ?? "Orca"} second="Refinement Q&A" />}
        subtitle={`${items.length} open`}
        actions={
          <div className="text-[11px] text-muted">
            j/k · a · ⌘↵ · s · o
          </div>
        }
      />
      <div className="flex-1 min-h-0 grid grid-cols-[280px_minmax(0,1fr)_280px]">
        {/* Left: list */}
        <aside className="border-r border-border overflow-y-auto">
          {isLoading && (
            <div className="p-4 text-xs text-muted">loading…</div>
          )}
          {!isLoading && items.length === 0 && (
            <div className="p-4 text-xs text-muted">
              Inbox is empty. Every open question across the pipeline is
              resolved.
            </div>
          )}
          <ul>
            {items.map((item, i) => (
              <li key={item.q.id}>
                <button
                  className={`w-full text-left px-4 py-2.5 border-b border-border hover:bg-surface transition-colors ${
                    i === index ? "bg-surface2" : ""
                  }`}
                  onClick={() => setIndex(i)}
                >
                  <div className="text-xs text-muted truncate">
                    {item.storyTitle}
                  </div>
                  <div className="text-sm text-text truncate">
                    {item.q.question}
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="pill">{item.q.source}</span>
                    {item.q.blocksDispatch && (
                      <span className="pill text-cert-low border-cert-low/40">
                        blocks dispatch
                      </span>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        {/* Center: current question */}
        <section className="overflow-y-auto p-6">
          {current ? (
            <div className="max-w-2xl space-y-4">
              <div className="text-[11px] uppercase tracking-wider text-muted">
                {current.storyTitle}
              </div>
              <h2 className="text-lg text-text">{current.q.question}</h2>
              {current.q.context && (
                <p className="text-sm text-muted italic">
                  {current.q.context}
                </p>
              )}

              <textarea
                autoFocus
                className="input text-sm h-32 resize-none"
                placeholder="Answer (⌘↵ to submit and advance)"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
              />
              <div className="flex items-center gap-2">
                <button
                  className="btn btn-primary"
                  disabled={!answer || answerMut.isPending}
                  onClick={() =>
                    current &&
                    answerMut.mutate({ id: current.q.id, body: answer })
                  }
                >
                  Answer + next
                </button>
                <button
                  className="btn"
                  onClick={() => current && skipMut.mutate(current.q.id)}
                >
                  Skip (obsolete)
                </button>
                <Link
                  to={`/stories/${current.q.storyId}`}
                  className="btn"
                >
                  Open story
                </Link>
              </div>
            </div>
          ) : (
            <div className="text-muted text-sm">
              Pick a question from the list, or let the Scrum Master generate
              some by refining a story.
            </div>
          )}
        </section>

        {/* Right: priority factors */}
        <aside className="border-l border-border p-4 overflow-y-auto">
          {current && (
            <>
              <div className="text-[11px] uppercase tracking-wider text-muted mb-2">
                Priority
              </div>
              <div className="text-2xl text-text">
                {current.q.priority.toFixed(2)}
              </div>
              <div className="mt-4 space-y-1 text-xs text-muted">
                <div>
                  closeness to dispatch:{" "}
                  <span className="text-text">
                    {current.q.priorityFactors.closenessToDispatch}
                  </span>
                </div>
                <div>
                  certainty delta:{" "}
                  <span className="text-text">
                    {current.q.priorityFactors.certaintyDelta}
                  </span>
                </div>
                <div>
                  blocks dispatch:{" "}
                  <span
                    className={
                      current.q.priorityFactors.blocksDispatch
                        ? "text-cert-low"
                        : "text-text"
                    }
                  >
                    {String(current.q.priorityFactors.blocksDispatch)}
                  </span>
                </div>
                <div>
                  age:{" "}
                  <span className="text-text">
                    {Math.round(current.q.priorityFactors.ageMs / 60_000)}m
                  </span>
                </div>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
