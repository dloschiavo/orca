import { useState } from "react";
import {
  useQuery,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { PrdParse, PrdQuestion } from "@orca/shared";
import { api } from "../../api.js";
import { useDebouncedAutosave } from "../../hooks/useDebouncedAutosave.js";
import { baseName, formatQuestionDetails, relTime } from "../../utils/format.js";
import { renderMarkdown, parseInlineMarkdown } from "../../utils/markdown.js";
import { TargetHistory } from "./TargetHistory.js";

type Tab = "questions" | "prd" | "history";

export function PrdDetailPanel({ id }: { id: string }) {
  const [tab, setTab] = useState<Tab>("questions");
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["prd", id],
    queryFn: () => api.prds.get(id),
    refetchInterval: 4000,
  });
  // History is loaded lazily (only while the tab is open) and paginated, so a
  // large feed never blocks the panel or the 4s poll above.
  const history = useInfiniteQuery({
    queryKey: ["prd-activity", id],
    enabled: tab === "history",
    refetchInterval: tab === "history" ? 4000 : false,
    initialPageParam: undefined as { before: string; beforeId: string } | undefined,
    queryFn: ({ pageParam }) => api.prds.activity(id, pageParam),
    getNextPageParam: (last) => {
      if (!last.hasMore || last.events.length === 0) return undefined;
      const oldest = last.events[last.events.length - 1]!;
      return { before: oldest.createdAt, beforeId: oldest.id };
    },
  });
  const stopMut = useMutation({
    mutationFn: () => api.prds.stop(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["prd", id] });
      queryClient.invalidateQueries({ queryKey: ["prds"] });
      queryClient.invalidateQueries({ queryKey: ["active-agents-sidebar"] });
    },
  });

  if (isLoading || !data) return <div className="sd-empty">loading…</div>;
  const { prd, content, parse } = data;
  const running = prd.dispatchPid != null;
  const openCount = parse.outstandingQuestions;

  return (
    <div className="sd">
      <div className="sd-head">
        <div className="sd-head-top">
          <span className="sd-title">{parse.title || baseName(prd.relPath)}</span>
          {parse.completed && <span className="prd-tag complete">COMPLETE</span>}
          {prd.ignoredAt != null && <span className="prd-tag ignored">IGNORED</span>}
          {parse.iceboxed && <span className="prd-tag">ICEBOX</span>}
        </div>
        <div className="sd-head-bot">
          <span className="sd-path">{prd.relPath}</span>
          <span className="sd-meta-sep">·</span>
          <span>{parse.bullets.outstanding} open · {parse.bullets.ready} ready · {parse.bullets.done} done</span>
        </div>
      </div>

      {running && (
        <div className="sd-agent-active" style={{ ["--ag" as string]: "var(--ag-spec)" } as React.CSSProperties}>
          <span className="sd-agent-active-stripe" />
          <span className="sd-agent-active-glyph">✎</span>
          <div className="sd-agent-active-body">
            <div className="sd-agent-active-head">
              <span className="sd-agent-active-label">
                <span className="sd-agent-active-name">agent on this PRD</span>
                <span className="sd-agent-active-status">working</span>
              </span>
              <span className="typing" style={{ color: "var(--ag-spec)" }}><i /><i /><i /></span>
            </div>
            <div className="sd-agent-active-task">
              {prd.dispatchedAt ? `started ${relTime(prd.dispatchedAt)} ago` : ""}
              {prd.dispatchPid != null ? `${prd.dispatchedAt ? " · " : ""}pid ${prd.dispatchPid}` : ""}
            </div>
          </div>
          <div className="sd-agent-active-meta">
            <button
              className="btn btn-sm btn-danger"
              disabled={stopMut.isPending}
              onClick={() => stopMut.mutate()}
            >
              {stopMut.isPending ? "…" : "Stop"}
            </button>
          </div>
        </div>
      )}

      <div className="sd-tabs">
        <span className={"sd-tab" + (tab === "questions" ? " active" : "")} onClick={() => setTab("questions")}>
          Questions
          {openCount > 0 && <span className="sd-tab-badge attn">{openCount}</span>}
        </span>
        <span className={"sd-tab" + (tab === "prd" ? " active" : "")} onClick={() => setTab("prd")}>
          PRD
        </span>
        <span className={"sd-tab" + (tab === "history" ? " active" : "")} onClick={() => setTab("history")}>
          History
          {data.activityCount > 0 && (
            <span className="sd-tab-badge muted">{data.activityCount}</span>
          )}
        </span>
      </div>

      <div className="sd-body">
        {tab === "questions" ? (
          <PrdQuestionsTab id={id} parse={parse} />
        ) : tab === "prd" ? (
          <PrdEditorTab id={id} content={content} />
        ) : history.isLoading ? (
          <div className="sd-soft">loading history…</div>
        ) : (
          <TargetHistory
            // Pages arrive newest-first; TargetHistory expects oldest-first
            // (it reverses internally for display), so flip the flattened feed.
            activity={[...(history.data?.pages.flatMap((p) => p.events) ?? [])].reverse()}
            workspace={history.data?.pages[0]?.workspace ?? undefined}
            hasMore={history.hasNextPage}
            onLoadMore={() => history.fetchNextPage()}
            loadingMore={history.isFetchingNextPage}
          />
        )}
      </div>
    </div>
  );
}

function PrdQuestionsTab({ id, parse }: { id: string; parse: PrdParse }) {
  return (
    <>
      <div className="sd-section-title">Questions</div>
      {parse.questions.length === 0 && (
        <div className="sd-soft">No questions in this PRD. The drafter adds them as it works.</div>
      )}
      {parse.questions.map((q, i) => (
        <PrdQuestionCard key={q.id ?? `noid-${i}`} prdId={id} q={q} />
      ))}
    </>
  );
}

function PrdQuestionCard({ prdId, q }: { prdId: string; q: PrdQuestion }) {
  const { text, setText, onFocus, onBlur, saving } = useDebouncedAutosave({
    value: q.answer,
    onSave: (v) => {
      if (q.id) return api.prds.answer(prdId, q.id, v);
    },
  });
  const resolved = q.answered;

  return (
    <div className={"inline-q" + (resolved ? " resolved" : "")}>
      <div className="inline-q-head">
        <span className="inline-q-glyph">❓</span>
        <span className="inline-q-who">drafter asks</span>
        {q.id && <span className="inline-q-time">{q.id}</span>}
        {resolved ? (
          <span className="inline-q-resolved-label">answered</span>
        ) : (
          <span className="inline-q-pending">waiting on you</span>
        )}
      </div>
      <div className="inline-q-text">{parseInlineMarkdown(q.question)}</div>
      {q.details && (
        <div className="inline-q-detail md">{renderMarkdown(formatQuestionDetails(q.details))}</div>
      )}
      {q.id ? (
        <div className="inline-q-input">
          <textarea
            placeholder="answer inline…"
            value={text}
            onFocus={onFocus}
            onBlur={onBlur}
            onChange={(e) => setText(e.target.value)}
          />
          <span className="inline-q-saving">{saving ? "saving…" : "autosaves"}</span>
        </div>
      ) : (
        <div className="inline-q-reason">(no answer block yet — the drafter will add one)</div>
      )}
    </div>
  );
}

function PrdEditorTab({ id, content }: { id: string; content: string }) {
  const { text, setText, onFocus, onBlur, saving, savedAt } = useDebouncedAutosave({
    value: content,
    onSave: (v) => api.prds.patchContent(id, v),
  });
  return (
    <div className="mono-editor-wrap">
      <div className="mono-editor-bar">
        <span>raw markdown</span>
        <span className="mono-editor-status">
          {saving ? "saving…" : savedAt ? "saved" : "autosaves"}
        </span>
      </div>
      <textarea
        className="mono-editor"
        value={text}
        spellCheck={false}
        onFocus={onFocus}
        onBlur={onBlur}
        onChange={(e) => setText(e.target.value)}
      />
    </div>
  );
}
