import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { AuditCheckSummary, AuditScheduleKind } from "@orca/shared";
import { api } from "../../api.js";
import { relTime, agentVerb } from "../../utils/format.js";
import {
  ContextMenu,
  useContextMenu,
  type ContextMenuItem,
} from "../../components/ContextMenu.js";

const DAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

export function AuditList({
  projectId,
  selectedId,
  activeKind,
}: {
  projectId: string;
  selectedId: string | null;
  activeKind: "story" | "prd" | "audit";
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState(false);
  const [ctxAudit, setCtxAudit] = useState<AuditCheckSummary | null>(null);
  const [scheduling, setScheduling] = useState<AuditCheckSummary | null>(null);
  const { menu, openMenu, closeMenu } = useContextMenu();

  const { data, isLoading } = useQuery({
    queryKey: ["audits", projectId],
    queryFn: () => api.audits.list({ projectId }),
    refetchInterval: 5000,
  });
  const audits = data?.audits ?? [];

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["audits", projectId] });
  const runMut = useMutation({ mutationFn: (id: string) => api.audits.run(id), onSuccess: invalidate });

  const ctxItems = (a: AuditCheckSummary): ContextMenuItem[] => [
    { label: "Run now", onClick: () => runMut.mutate(a.id), disabled: a.dispatchPid != null },
    { label: "Schedule…", onClick: () => setScheduling(a) },
  ];

  return (
    <div className="macro-section">
      <div className="macro-head" onClick={() => setCollapsed((c) => !c)}>
        <span className="macro-chevron">{collapsed ? "▸" : "▾"}</span>
        <span className="macro-title">Audits</span>
        <span className="macro-count">{isLoading ? "…" : audits.length}</span>
      </div>
      {!collapsed && (
        <>
          <div className="audit-head">
            <span>Audit</span>
            <span style={{ textAlign: "right" }} title="open questions">q</span>
            <span style={{ textAlign: "right" }} title="open fails">fails</span>
            <span style={{ textAlign: "right" }}>run</span>
            <span />
          </div>
          <div className="macro-rows">
            {!isLoading && audits.length === 0 && (
              <div className="macro-empty">∅ no audits</div>
            )}
            {audits.map((a) => (
              <AuditRow
                key={a.id}
                audit={a}
                active={activeKind === "audit" && a.id === selectedId}
                onClick={() => navigate(`/audits/${a.id}`)}
                onContext={(e) => { setCtxAudit(a); openMenu(e); }}
              />
            ))}
          </div>
        </>
      )}
      {menu && ctxAudit && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={ctxItems(ctxAudit)}
          onClose={() => { closeMenu(); setCtxAudit(null); }}
        />
      )}
      {scheduling && (
        <ScheduleDialog
          audit={scheduling}
          onClose={() => setScheduling(null)}
          onSaved={() => { setScheduling(null); invalidate(); }}
        />
      )}
    </div>
  );
}

function AuditRow({
  audit,
  active,
  onClick,
  onContext,
}: {
  audit: AuditCheckSummary;
  active: boolean;
  onClick: () => void;
  onContext: (e: React.MouseEvent) => void;
}) {
  const running = audit.dispatchPid != null;
  const sched =
    audit.scheduleKind === "manual"
      ? null
      : audit.scheduleKind === "daily"
        ? `daily ${audit.scheduleTime}`
        : `weekly ${audit.scheduleTime}`;
  return (
    <div
      className={["audit-row", active ? "active" : ""].filter(Boolean).join(" ")}
      onClick={onClick}
      onContextMenu={onContext}
    >
      <div className="audit-cell-title">
        <span className="audit-title-text">{audit.name}</span>
        {sched && <span className="audit-sched">{sched}</span>}
        {running && (
          <span className="row-agent-chip" data-verb={agentVerb(audit.activeAgent)} title={audit.activeAgent ?? "working"}>
            {agentVerb(audit.activeAgent)}
            <span className="typing"><i /><i /><i /></span>
          </span>
        )}
      </div>
      <div className="prd-cell-num">
        {audit.openQuestions ? <span className="prd-attn">{audit.openQuestions}</span> : <span className="prd-muted">—</span>}
      </div>
      <div className="prd-cell-num">
        {audit.openFails ? <span className="audit-fail">{audit.openFails}</span> : <span className="prd-muted">—</span>}
      </div>
      <div className="prd-cell-upd">{audit.lastRunAt ? relTime(audit.lastRunAt) : "never"}</div>
      <button
        className="row-kebab"
        title="Actions"
        aria-label="Row actions"
        onClick={onContext}
      >
        ⋯
      </button>
    </div>
  );
}

function ScheduleDialog({
  audit,
  onClose,
  onSaved,
}: {
  audit: AuditCheckSummary;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<AuditScheduleKind>(audit.scheduleKind);
  const [time, setTime] = useState(audit.scheduleTime ?? "09:00");
  const [days, setDays] = useState<number[]>(audit.scheduleDays.length ? audit.scheduleDays : [1]);
  const mut = useMutation({
    mutationFn: () =>
      api.audits.schedule(audit.id, {
        scheduleKind: kind,
        scheduleTime: kind === "manual" ? null : time,
        scheduleDays: days,
      }),
    onSuccess: onSaved,
  });

  return (
    <div
      className="modal-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal-panel" style={{ width: 360 }}>
        <div className="modal-header">Schedule “{audit.name}”</div>
        <div className="modal-body">
          <div className="sched-field">
            <label>Cadence</label>
            <select value={kind} onChange={(e) => setKind(e.target.value as AuditScheduleKind)}>
              <option value="manual">Manual (no schedule)</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </div>
          {kind !== "manual" && (
            <div className="sched-field">
              <label>Time</label>
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
          )}
          {kind === "weekly" && (
            <div className="sched-field">
              <label>Days</label>
              <div className="sched-days">
                {DAY_LABELS.map((d, i) => (
                  <button
                    key={i}
                    type="button"
                    className={"sched-day" + (days.includes(i) ? " on" : "")}
                    onClick={() =>
                      setDays((prev) => (prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i].sort()))
                    }
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={mut.isPending || (kind === "weekly" && days.length === 0)}
            onClick={() => mut.mutate()}
          >
            {mut.isPending ? "…" : "Save schedule"}
          </button>
        </div>
      </div>
    </div>
  );
}
