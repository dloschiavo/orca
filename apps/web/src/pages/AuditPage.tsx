import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageHeader } from "../components/PageHeader.js";
import { Breadcrumb } from "../components/Breadcrumb.js";
import { useProjectContext } from "../state/ProjectContext.js";
import type {
  AuditCluster,
  AuditRow,
  AuditStatus,
} from "@orca/shared";

// The Implementation Audit — PM pipeline visibility surface.
// One row per thread of work this project should be thinking about.
// Human-driven; Scrum Master reads it as context, never as a gate.
//
// Default view groups by cluster with per-cluster completion bars.

const CLUSTER_ORDER: AuditCluster[] = [
  "core-infrastructure",
  "auth-identity",
  "monetization-billing",
  "observability-admin",
  "compliance-legal",
  "ux-content-shell",
  "error-handling-resilience",
  "performance",
  "seo-content",
  "notifications-comms",
  "devops-deployment",
  "saas-specific",
];

const CLUSTER_LABEL: Record<AuditCluster, string> = {
  "core-infrastructure": "Core Infrastructure",
  "auth-identity": "Auth & Identity",
  "monetization-billing": "Monetization & Billing",
  "observability-admin": "Observability & Admin",
  "compliance-legal": "Compliance & Legal",
  "ux-content-shell": "UX, Content, Shell",
  "error-handling-resilience": "Error Handling & Resilience",
  performance: "Performance",
  "seo-content": "SEO & Content",
  "notifications-comms": "Notifications & Comms",
  "devops-deployment": "DevOps & Deployment",
  "saas-specific": "SaaS-specific",
};

const STATUS_OPTIONS: AuditStatus[] = [
  "unaudited",
  "implemented",
  "partially-implemented",
  "not-implemented",
  "forgone",
  "substituted",
];

const STATUS_COLOR: Record<AuditStatus, string> = {
  unaudited: "text-muted",
  implemented: "text-done",
  "partially-implemented": "text-cert-medium",
  "not-implemented": "text-blocked",
  forgone: "text-canceled",
  substituted: "text-accent",
};

const STATUS_DOT_COLOR: Record<AuditStatus, string> = {
  unaudited: "bg-cert-medium",
  implemented: "bg-done",
  "partially-implemented": "bg-cert-medium",
  "not-implemented": "bg-blocked",
  forgone: "bg-canceled",
  substituted: "bg-accent",
};

const APPLICABILITY_ORDER: Record<string, number> = {
  universal: 0,
  "web-only": 1,
  "saas-only": 2,
  "native-only": 3,
  "commerce-only": 4,
};

function formatAgo(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function AuditPage() {
  const { activeProjectId, activeProject } = useProjectContext();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<Set<AuditCluster>>(
    () => new Set(CLUSTER_ORDER),
  );
  // Track which rows have an audit in flight
  const [auditing, setAuditing] = useState<Set<string>>(() => new Set());

  const { data, isLoading } = useQuery({
    queryKey: ["audit", activeProjectId],
    queryFn: () =>
      activeProjectId
        ? api.audit.list({ projectId: activeProjectId })
        : Promise.resolve({ rows: [] as AuditRow[] }),
    enabled: !!activeProjectId,
    // Poll while any audits are in flight so we pick up results
    refetchInterval: auditing.size > 0 ? 5000 : false,
  });

  const rows = data?.rows ?? [];
  const byCluster = useMemo(() => {
    const m = new Map<AuditCluster, AuditRow[]>();
    for (const c of CLUSTER_ORDER) m.set(c, []);
    for (const r of rows) {
      const arr = m.get(r.cluster) ?? [];
      arr.push(r);
      m.set(r.cluster, arr);
    }
    for (const arr of m.values()) {
      arr.sort((a, b) => {
        // Sort enhancements to bottom
        const typeA = a.recipeType === "enhancement" ? 1 : 0;
        const typeB = b.recipeType === "enhancement" ? 1 : 0;
        if (typeA !== typeB) return typeA - typeB;
        // Within same type, sort by applicability (universal first)
        const appA = APPLICABILITY_ORDER[a.applicability] ?? 99;
        const appB = APPLICABILITY_ORDER[b.applicability] ?? 99;
        if (appA !== appB) return appA - appB;
        return a.concernTitle.localeCompare(b.concernTitle);
      });
    }
    return m;
  }, [rows]);

  const total = rows.length;
  const reviewed = rows.filter((r) => r.status !== "unaudited").length;
  const applicable = rows.filter((r) => r.applicability === "universal").length;
  const coverage = applicable > 0 ? (reviewed / applicable) * 100 : 0;
  const staleCount = rows.filter(
    (r) => r.recipeStale && r.status !== "forgone" && r.status !== "substituted",
  ).length;

  const patchMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: AuditStatus }) =>
      api.audit.patch(id, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["audit"] });
    },
  });

  // Track lastAuditedAt per row when verify was kicked off, so we can detect completion
  const [auditSnapshots, setAuditSnapshots] = useState<Map<string, string | null>>(
    () => new Map(),
  );

  // Detect completed audits: if a row's lastAuditedAt changed from what we snapshotted, it's done
  useEffect(() => {
    if (auditing.size === 0) return;
    setAuditing((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const id of prev) {
        const row = rows.find((r) => r.id === id);
        if (!row) continue;
        const snap = auditSnapshots.get(id);
        if (row.lastAuditedAt !== snap) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [rows, auditing, auditSnapshots]);

  const verifyRow = (id: string) => {
    const row = rows.find((r) => r.id === id);
    setAuditSnapshots((prev) => new Map(prev).set(id, row?.lastAuditedAt ?? null));
    setAuditing((prev) => new Set(prev).add(id));
    api.audit
      .verify(id)
      .catch((err) => console.error("[orca] audit verify failed:", err));
  };

  const toggle = (c: AuditCluster) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  };

  return (
    <div className="h-full flex flex-col">
      <PageHeader
        title={<Breadcrumb first={activeProject?.name ?? "…"} second="Recipe Audit" />}
        actions={
          <div className="flex items-center gap-4">
            {staleCount > 0 && (
              <span className="text-[11px] text-cert-medium">
                {staleCount} stale
              </span>
            )}
            <span className="text-[11px] text-muted">
              coverage {coverage.toFixed(0)}% · {reviewed}/{total} reviewed
            </span>
          </div>
        }
      />
      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <div className="p-6 text-muted text-sm">loading…</div>
        )}
        {!isLoading && total === 0 && (
          <div className="p-6 text-muted text-sm">
            No audit rows yet. Create a project bound to a repo to seed the
            matrix from <code>_recipes</code>.
          </div>
        )}

        <div className="divide-y divide-border">
          {CLUSTER_ORDER.map((cluster) => {
            const clusterRows = byCluster.get(cluster) ?? [];
            if (clusterRows.length === 0) return null;
            const clusterReviewed = clusterRows.filter(
              (r) => r.status !== "unaudited",
            ).length;
            const isOpen = expanded.has(cluster);
            return (
              <div key={cluster}>
                <button
                  className="w-full flex items-center gap-3 px-6 py-3 hover:bg-surface transition-colors"
                  onClick={() => toggle(cluster)}
                >
                  <span className="text-muted text-xs w-4">
                    {isOpen ? "▾" : "▸"}
                  </span>
                  <span className="text-sm font-medium text-text flex-1 text-left">
                    {CLUSTER_LABEL[cluster]}
                  </span>
                  <div className="flex items-center gap-2">
                    <div className="w-24 h-1.5 rounded-full bg-surface2 overflow-hidden">
                      <div
                        className="h-full bg-done"
                        style={{
                          width: `${
                            (clusterReviewed / clusterRows.length) * 100
                          }%`,
                        }}
                      />
                    </div>
                    <span className="text-xs text-muted w-14 text-right">
                      {clusterReviewed}/{clusterRows.length}
                    </span>
                  </div>
                </button>
                {isOpen && (
                  <div className="bg-surface/30">
                    {clusterRows.map((r) => (
                      <AuditRowItem
                        key={r.id}
                        row={r}
                        isAuditing={auditing.has(r.id)}
                        onVerify={() => verifyRow(r.id)}
                        onStatusChange={(status) =>
                          patchMut.mutate({ id: r.id, status })
                        }
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function AuditRowItem({
  row: r,
  isAuditing,
  onVerify,
  onStatusChange,
}: {
  row: AuditRow;
  isAuditing: boolean;
  onVerify: () => void;
  onStatusChange: (status: AuditStatus) => void;
}) {
  return (
    <div className="grid grid-cols-[auto_1fr_5rem_5rem_5rem_4.5rem_7.5rem] items-center gap-2 px-12 py-2 border-t border-border/50">
      <span
        className={`inline-block w-2 h-2 rounded-full shrink-0 ${STATUS_DOT_COLOR[r.status]}`}
        title={r.status}
      />
      <span className="text-sm text-text truncate">
        {r.concernTitle}
        {r.recipeStale && r.status !== "forgone" && r.status !== "substituted" && (
          <span
            className="ml-2 text-[10px] text-cert-medium"
            title="Recipe updated since last review"
          >
            stale
          </span>
        )}
        {r.auditVerdict && (
          <span
            className="ml-2 text-[10px] text-muted cursor-help"
            title={r.auditVerdict}
          >
            (verdict)
          </span>
        )}
      </span>
      <span className="text-[10px] text-muted">
        {r.recipeType === "project" ? "core" : r.recipeType}
      </span>
      <span className="text-[10px] text-muted">{r.applicability}</span>
      <span
        className="text-[10px] text-muted text-right"
        title={
          r.lastAuditedAt
            ? `Last audited: ${new Date(r.lastAuditedAt).toLocaleString()}`
            : "Never audited by AI"
        }
      >
        {r.lastAuditedAt ? formatAgo(r.lastAuditedAt) : "—"}
      </span>
      {r.status !== "forgone" ? (
        <button
          className="px-2 py-0.5 text-[10px] rounded bg-surface2 border border-border hover:bg-surface3 transition-colors disabled:opacity-50 whitespace-nowrap"
          onClick={onVerify}
          disabled={isAuditing}
          title="Spawn AI agent to verify this recipe against the codebase"
        >
          {isAuditing ? "Auditing…" : "Audit"}
        </button>
      ) : (
        <span />
      )}
      <select
        className={`bg-surface2 border border-border rounded-md text-xs px-2 py-1 ${
          STATUS_COLOR[r.status]
        }`}
        value={r.status}
        onChange={(e) => onStatusChange(e.target.value as AuditStatus)}
      >
        {STATUS_OPTIONS.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    </div>
  );
}
