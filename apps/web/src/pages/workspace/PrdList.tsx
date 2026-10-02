import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { PrdSummary } from "@orca/shared";
import { api } from "../../api.js";
import { relTime, ancestorFolders, agentVerb } from "../../utils/format.js";
import {
  ContextMenu,
  useContextMenu,
  type ContextMenuItem,
} from "../../components/ContextMenu.js";

export function PrdList({
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
  const [showMore, setShowMore] = useState(false);
  const [ctxPrd, setCtxPrd] = useState<PrdSummary | null>(null);
  const { menu, openMenu, closeMenu } = useContextMenu();

  const { data, isLoading } = useQuery({
    queryKey: ["prds", projectId],
    queryFn: () => api.prds.list({ projectId }),
    refetchInterval: 5000,
  });
  const prds = data?.prds ?? [];
  // Iceboxed PRDs sink below the regular ones (stable sort keeps the server's
  // recency order within each group).
  const visible = prds
    .filter((p) => !p.ignored && !p.completed)
    .sort((a, b) => Number(a.iceboxed) - Number(b.iceboxed));
  // Folded (hidden by default): completed PRDs sort above ignored ones. A PRD
  // that's both completed and ignored counts as completed. Stable sort keeps the
  // server's recency order within each group.
  const folded = prds
    .filter((p) => p.ignored || p.completed)
    .sort((a, b) => Number(!a.completed) - Number(!b.completed));

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["prds", projectId] });
  const ignoreMut = useMutation({ mutationFn: (id: string) => api.prds.ignore(id), onSuccess: invalidate });
  const unignoreMut = useMutation({ mutationFn: (id: string) => api.prds.unignore(id), onSuccess: invalidate });
  const ignoreFolderMut = useMutation({ mutationFn: (folder: string) => api.prds.ignoreFolder(projectId, folder), onSuccess: invalidate });
  const draftMut = useMutation({ mutationFn: (id: string) => api.prds.dispatch(id), onSuccess: invalidate });
  const implementMut = useMutation({ mutationFn: (id: string) => api.prds.implement(id), onSuccess: invalidate });

  const ctxItems = (p: PrdSummary): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];
    items.push(
      p.ignored
        ? { label: "Un-ignore file", onClick: () => unignoreMut.mutate(p.id) }
        : { label: "Ignore file", onClick: () => ignoreMut.mutate(p.id) },
    );
    // One "Ignore folder" per ancestor level — the true ignore is sometimes
    // 2+ folders up (e.g. ignore all of `web/` vs just `web/docs/`).
    for (const folder of ancestorFolders(p.relPath)) {
      items.push({ label: `Ignore folder  ${folder}/`, onClick: () => ignoreFolderMut.mutate(folder) });
    }
    items.push({ label: "Draft now", onClick: () => draftMut.mutate(p.id), disabled: p.dispatchPid != null });
    if (p.readyItems > 0) items.push({ label: "Implement ready items", onClick: () => implementMut.mutate(p.id), disabled: p.dispatchPid != null });
    return items;
  };

  return (
    <div className="macro-section">
      <div className="macro-head" onClick={() => setCollapsed((c) => !c)}>
        <span className="macro-chevron">{collapsed ? "▸" : "▾"}</span>
        <span className="macro-title">PRDs</span>
        <span className="macro-count">{isLoading ? "…" : visible.length}</span>
      </div>
      {!collapsed && (
        <>
          <div className="prd-head">
            <span>Title</span>
            <span style={{ textAlign: "right" }} title="line-items done / total">items</span>
            <span style={{ textAlign: "right" }} title="open questions">q</span>
            <span style={{ textAlign: "right" }}>upd</span>
            <span />
          </div>
          <div className="macro-rows">
            {!isLoading && visible.length === 0 && (
              <div className="macro-empty">∅ no active PRDs</div>
            )}
            {visible.map((p) => (
              <PrdRow
                key={p.id}
                prd={p}
                active={activeKind === "prd" && p.id === selectedId}
                onClick={() => navigate(`/prds/${p.id}`)}
                onContext={(e) => { setCtxPrd(p); openMenu(e); }}
              />
            ))}
            {folded.length > 0 && (
              <div className="macro-showmore" onClick={() => setShowMore((s) => !s)}>
                {showMore ? "▾" : "▸"} Show {folded.length} completed / ignored
              </div>
            )}
            {showMore &&
              folded.map((p) => (
                <PrdRow
                  key={p.id}
                  prd={p}
                  faded
                  active={activeKind === "prd" && p.id === selectedId}
                  onClick={() => navigate(`/prds/${p.id}`)}
                  onContext={(e) => { setCtxPrd(p); openMenu(e); }}
                />
              ))}
          </div>
        </>
      )}
      {menu && ctxPrd && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={ctxItems(ctxPrd)}
          onClose={() => { closeMenu(); setCtxPrd(null); }}
        />
      )}
    </div>
  );
}

function PrdRow({
  prd,
  active,
  faded,
  onClick,
  onContext,
}: {
  prd: PrdSummary;
  active: boolean;
  faded?: boolean;
  onClick: () => void;
  onContext: (e: React.MouseEvent) => void;
}) {
  const running = prd.dispatchPid != null;
  return (
    <div
      className={["prd-row", active ? "active" : "", faded ? "faded" : ""].filter(Boolean).join(" ")}
      onClick={onClick}
      onContextMenu={onContext}
      title={prd.relPath}
    >
      <div className="prd-cell-title">
        {prd.completed && <span className="prd-tag complete">COMPLETE</span>}
        {prd.ignored && <span className="prd-tag ignored">IGNORED</span>}
        {prd.iceboxed && <span className="prd-tag">ICEBOX</span>}
        <span className="prd-title-text">{prd.title}</span>
        {running && (
          <span className="row-agent-chip" data-verb={agentVerb(prd.activeAgent)} title={prd.activeAgent ?? "working"}>
            {agentVerb(prd.activeAgent)}
            <span className="typing"><i /><i /><i /></span>
          </span>
        )}
      </div>
      <PrdItemsCell done={prd.doneItems} total={prd.totalItems} />
      <div className="prd-cell-num">
        {prd.outstandingQuestions ? (
          <span className="prd-attn">{prd.outstandingQuestions}</span>
        ) : (
          <span className="prd-muted">—</span>
        )}
      </div>
      <div className="prd-cell-upd">{relTime(prd.lastModified)}</div>
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

/** Line-item completion: a fill bar + `done/total`. Empty (no items) → em-dash. */
function PrdItemsCell({ done, total }: { done: number; total: number }) {
  if (total === 0) {
    return (
      <div className="prd-cell-items">
        <span className="prd-muted">—</span>
      </div>
    );
  }
  const pct = Math.round((done / total) * 100);
  const complete = done >= total;
  return (
    <div className="prd-cell-items" title={`${done} of ${total} line-items done (${pct}%)`}>
      <span className="prd-bar-track">
        <span
          className={"prd-bar-fill" + (complete ? " complete" : "")}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="prd-bar-num">{done}/{total}</span>
    </div>
  );
}
