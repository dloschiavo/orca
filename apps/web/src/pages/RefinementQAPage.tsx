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
    <div className="adm-page">
      <PageHeader
        title={<Breadcrumb first={activeProject?.name ?? "Orca"} second="Refinement Q&A" />}
        subtitle={`${items.length} open`}
        actions={
          <span
            style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-3)" }}
          >
            j/k · a · ⌘↵ · s · o
          </span>
        }
      />

      <div
        style={{
          flex: 1, minHeight: 0, display: "grid",
          gridTemplateColumns: "300px minmax(0,1fr) 280px",
        }}
      >
        <aside
          style={{
            borderRight: "1px solid var(--border-0)",
            background: "var(--bg-1)", overflowY: "auto", minHeight: 0,
          }}
        >
          {isLoading && (
            <div
              style={{
                padding: "18px 14px", color: "var(--fg-2)", fontSize: 12,
                fontFamily: "var(--mono)",
              }}
            >
              loading…
            </div>
          )}
          {!isLoading && items.length === 0 && (
            <div
              className="adm-empty"
              style={{ padding: 16, fontSize: 12 }}
            >
              Inbox is empty. Every open question across the pipeline is resolved.
            </div>
          )}
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {items.map((item, i) => (
              <li key={item.q.id}>
                <button
                  className={"adm-inbox-row" + (i === index ? " active" : "")}
                  onClick={() => setIndex(i)}
                >
                  <div className="adm-inbox-story">{item.storyTitle}</div>
                  <div className="adm-inbox-q">{item.q.question}</div>
                  <div className="adm-inbox-pills">
                    <span className="adm-tag">{item.q.source}</span>
                    {item.q.blocksDispatch && (
                      <span className="adm-tag adm-tag-error">blocks dispatch</span>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section style={{ overflowY: "auto", padding: "24px var(--pad-x)" }}>
          {current ? (
            <div style={{ maxWidth: 720, display: "flex", flexDirection: "column", gap: 16 }}>
              <div className="adm-inbox-story">{current.storyTitle}</div>
              <h2
                style={{
                  fontSize: 18, fontWeight: 500,
                  color: "var(--fg-0)", lineHeight: 1.35,
                  margin: 0, letterSpacing: "-0.005em",
                }}
              >
                {current.q.question}
              </h2>
              {current.q.context && (
                <p
                  style={{
                    margin: 0, color: "var(--fg-2)", fontSize: 13,
                    fontStyle: "italic", lineHeight: 1.55,
                  }}
                >
                  {current.q.context}
                </p>
              )}

              <textarea
                autoFocus
                className="adm-textarea"
                style={{ minHeight: 140, fontFamily: "var(--sans)", fontSize: 13 }}
                placeholder="Answer (⌘↵ to submit and advance)"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
              />

              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <button
                  className="btn btn-sm btn-primary"
                  disabled={!answer || answerMut.isPending}
                  onClick={() =>
                    current && answerMut.mutate({ id: current.q.id, body: answer })
                  }
                >
                  Answer + next
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => current && skipMut.mutate(current.q.id)}
                >
                  Skip (obsolete)
                </button>
                <Link
                  to={`/stories/${current.q.storyId}`}
                  className="btn btn-sm"
                  style={{ textDecoration: "none" }}
                >
                  Open story
                </Link>
              </div>
            </div>
          ) : (
            <div className="adm-empty" style={{ maxWidth: 560 }}>
              Pick a question from the list, or let the Scrum Master generate
              some by refining a story.
            </div>
          )}
        </section>

        <aside
          style={{
            borderLeft: "1px solid var(--border-0)",
            background: "var(--bg-1)",
            padding: "20px var(--pad-x)",
            overflowY: "auto",
          }}
        >
          {current && (
            <>
              <div className="adm-section" style={{ marginBottom: 8 }}>
                <span>Priority</span>
                <span className="adm-section-rule" />
              </div>
              <div
                style={{
                  fontFamily: "var(--mono)", fontSize: 28, fontWeight: 500,
                  color: "var(--fg-0)", fontVariantNumeric: "tabular-nums",
                }}
              >
                {current.q.priority.toFixed(2)}
              </div>
              <div
                style={{
                  marginTop: 16, display: "flex", flexDirection: "column", gap: 6,
                  fontSize: 11.5, color: "var(--fg-2)",
                }}
              >
                <PriorityRow
                  label="closeness to dispatch"
                  value={String(current.q.priorityFactors.closenessToDispatch)}
                />
                <PriorityRow
                  label="certainty delta"
                  value={String(current.q.priorityFactors.certaintyDelta)}
                />
                <PriorityRow
                  label="blocks dispatch"
                  value={String(current.q.priorityFactors.blocksDispatch)}
                  valueColor={current.q.priorityFactors.blocksDispatch ? "var(--attn-error)" : undefined}
                />
                <PriorityRow
                  label="age"
                  value={`${Math.round(current.q.priorityFactors.ageMs / 60_000)}m`}
                />
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

function PriorityRow({
  label, value, valueColor,
}: {
  label: string; value: string; valueColor?: string;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
      <span>{label}</span>
      <span
        style={{
          color: valueColor ?? "var(--fg-0)",
          fontFamily: "var(--mono)", fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </span>
    </div>
  );
}
