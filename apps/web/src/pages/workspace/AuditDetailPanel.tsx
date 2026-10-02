import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { AuditFinding } from "@orca/shared";
import { api } from "../../api.js";
import { useDebouncedAutosave } from "../../hooks/useDebouncedAutosave.js";
import { relTime, formatQuestionDetails } from "../../utils/format.js";
import { renderMarkdown, parseInlineMarkdown } from "../../utils/markdown.js";
import { TargetHistory } from "./TargetHistory.js";

type Tab = "findings" | "prompt" | "history";

export function AuditDetailPanel({ id }: { id: string }) {
  const [tab, setTab] = useState<Tab>("findings");
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["audit", id],
    queryFn: () => api.audits.get(id),
    refetchInterval: 4000,
  });
  const runMut = useMutation({
    mutationFn: () => api.audits.run(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["audit", id] }),
  });
  const stopMut = useMutation({
    mutationFn: () => api.audits.stop(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["audit", id] });
      queryClient.invalidateQueries({ queryKey: ["audits"] });
      queryClient.invalidateQueries({ queryKey: ["active-agents-sidebar"] });
    },
  });

  if (isLoading || !data) return <div className="sd-empty">loading…</div>;
  const { audit, prompt, findings, activity } = data;
  const running = audit.dispatchPid != null;
  const openQuestions = findings.filter((f) => f.kind === "question" && f.status === "open");
  const openFails = findings.filter((f) => f.kind === "fail" && f.status === "open");

  return (
    <div className="sd">
      <div className="sd-head">
        <div className="sd-head-top">
          <span className="sd-title">{audit.name}</span>
          <button
            className="btn btn-sm btn-primary"
            style={{ marginLeft: "auto" }}
            disabled={running || runMut.isPending}
            onClick={() => runMut.mutate()}
          >
            {running ? "running…" : "Run now"}
          </button>
        </div>
        <div className="sd-head-bot">
          <span>last run: {audit.lastRunAt ? relTime(audit.lastRunAt) + " ago" : "never"}</span>
          {audit.scheduleKind !== "manual" && (
            <>
              <span className="sd-meta-sep">·</span>
              <span>{audit.scheduleKind} {audit.scheduleTime}</span>
            </>
          )}
        </div>
      </div>

      {running && (
        <div className="sd-agent-active" style={{ ["--ag" as string]: "var(--ag-impl)" } as React.CSSProperties}>
          <span className="sd-agent-active-stripe" />
          <span className="sd-agent-active-glyph">⚙</span>
          <div className="sd-agent-active-body">
            <div className="sd-agent-active-head">
              <span className="sd-agent-active-label">
                <span className="sd-agent-active-name">audit running</span>
                <span className="sd-agent-active-status">working</span>
              </span>
              <span className="typing" style={{ color: "var(--ag-impl)" }}><i /><i /><i /></span>
            </div>
            <div className="sd-agent-active-task">
              {audit.dispatchedAt ? `started ${relTime(audit.dispatchedAt)} ago` : ""}
              {audit.dispatchPid != null ? `${audit.dispatchedAt ? " · " : ""}pid ${audit.dispatchPid}` : ""}
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
        <span className={"sd-tab" + (tab === "findings" ? " active" : "")} onClick={() => setTab("findings")}>
          Findings
          {openQuestions.length + openFails.length > 0 && (
            <span className="sd-tab-badge attn">{openQuestions.length + openFails.length}</span>
          )}
        </span>
        <span className={"sd-tab" + (tab === "prompt" ? " active" : "")} onClick={() => setTab("prompt")}>
          Prompt
        </span>
        <span className={"sd-tab" + (tab === "history" ? " active" : "")} onClick={() => setTab("history")}>
          History
          {activity.length > 0 && <span className="sd-tab-badge muted">{activity.length}</span>}
        </span>
      </div>

      <div className="sd-body">
        {tab === "findings" ? (
          <FindingsTab auditId={id} openQuestions={openQuestions} openFails={openFails} />
        ) : tab === "prompt" ? (
          <PromptEditorTab id={id} prompt={prompt} />
        ) : (
          <TargetHistory activity={activity} />
        )}
      </div>
    </div>
  );
}

function FindingsTab({
  auditId,
  openQuestions,
  openFails,
}: {
  auditId: string;
  openQuestions: AuditFinding[];
  openFails: AuditFinding[];
}) {
  return (
    <>
      <div className="sd-section-title">Outstanding questions</div>
      {openQuestions.length === 0 && <div className="sd-soft">no open questions</div>}
      {openQuestions.map((f) => (
        <AuditQuestionCard key={f.id} auditId={auditId} finding={f} />
      ))}

      <div className="sd-section-title" style={{ marginTop: 22 }}>Outstanding fails</div>
      {openFails.length === 0 && <div className="sd-soft">no open fails</div>}
      {openFails.map((f) => (
        <AuditFailCard key={f.id} auditId={auditId} finding={f} />
      ))}
    </>
  );
}

function AuditQuestionCard({ auditId, finding }: { auditId: string; finding: AuditFinding }) {
  const queryClient = useQueryClient();
  const [answer, setAnswer] = useState("");
  const [target, setTarget] = useState(finding.targetPrdRelPath ?? "");
  const mut = useMutation({
    mutationFn: () => api.audits.answerFinding(finding.id, answer, target || undefined),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["audit", auditId] }),
  });
  return (
    <div className="inline-q">
      <div className="inline-q-head">
        <span className="inline-q-glyph">❓</span>
        <span className="inline-q-who">audit asks</span>
        <span className="inline-q-pending">needs a decision</span>
      </div>
      <div className="inline-q-text">{parseInlineMarkdown(finding.title)}</div>
      {finding.detail && (
        <div className="inline-q-detail md">{renderMarkdown(formatQuestionDetails(finding.detail))}</div>
      )}
      <div className="inline-q-input" style={{ flexDirection: "column", gap: 8 }}>
        <textarea
          placeholder="answer — folds into the target PRD…"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          style={{ width: "100%" }}
        />
        <div style={{ display: "flex", gap: 8, alignItems: "center", width: "100%" }}>
          <input
            className="audit-target-input"
            placeholder="target PRD (e.g. docs/foo.md) — optional"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
          <button
            className="btn btn-sm btn-primary"
            disabled={!answer.trim() || mut.isPending}
            onClick={() => mut.mutate()}
          >
            {mut.isPending ? "…" : "Answer"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AuditFailCard({ auditId, finding }: { auditId: string; finding: AuditFinding }) {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["audit", auditId] });
  const resolveMut = useMutation({ mutationFn: () => api.audits.resolveFinding(finding.id), onSuccess: invalidate });
  const dismissMut = useMutation({ mutationFn: () => api.audits.dismissFinding(finding.id), onSuccess: invalidate });
  return (
    <div className="audit-fail-card">
      <div className="audit-fail-head">
        <span className="audit-fail-glyph">✕</span>
        <span className="audit-fail-title">{finding.title}</span>
        <div className="audit-fail-actions">
          <button className="btn btn-sm" disabled={dismissMut.isPending} onClick={() => dismissMut.mutate()}>dismiss</button>
          <button className="btn btn-sm btn-primary" disabled={resolveMut.isPending} onClick={() => resolveMut.mutate()}>resolve</button>
        </div>
      </div>
      {finding.detail && <div className="audit-fail-detail">{finding.detail}</div>}
      {finding.proposedFix && (
        <div className="audit-fail-fix"><span className="audit-fail-fix-label">fix</span> {finding.proposedFix}</div>
      )}
    </div>
  );
}

function PromptEditorTab({ id, prompt }: { id: string; prompt: string }) {
  const { text, setText, onFocus, onBlur, saving, savedAt } = useDebouncedAutosave({
    value: prompt,
    onSave: (v) => api.audits.savePrompt(id, v),
  });
  return (
    <div className="mono-editor-wrap">
      <div className="mono-editor-bar">
        <span>audit prompt (rarely edited)</span>
        <span className="mono-editor-status">{saving ? "saving…" : savedAt ? "saved" : "autosaves"}</span>
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
