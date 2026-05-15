import { useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { api, type EnrichedFinding } from "../api.js";
import { PageHeader } from "../components/PageHeader.js";
import { Breadcrumb } from "../components/Breadcrumb.js";
import type {
  Classification,
  FindingDestination,
  FindingRootCause,
  FindingStatus,
} from "@orca/shared";

const ROOT_CAUSE_LABEL: Record<FindingRootCause, string> = {
  "pipeline-failure": "pipeline failure",
  "bad-spec": "bad spec",
  "missing-context": "missing context",
  "missing-constraint": "missing constraint",
  "missing-audit-row": "missing audit row",
  "tooling-gap": "tooling gap",
  "agent-failure": "agent failure",
  "agent-false-completion": "agent false completion",
  "user-error": "user error",
  unknown: "unknown",
};

const STATUS_FILTERS: { value: FindingStatus | "all"; label: string }[] = [
  { value: "all", label: "all" },
  { value: "pending", label: "pending" },
  { value: "triaged", label: "triaged" },
  { value: "applied", label: "applied" },
  { value: "dismissed", label: "dismissed" },
];

export function FindingsPage() {
  const [statusFilter, setStatusFilter] = useState<FindingStatus | "all">("all");

  const { data, isLoading } = useQuery({
    queryKey: ["findings", statusFilter],
    queryFn: () =>
      api.findings.list(statusFilter === "all" ? {} : { status: statusFilter }),
  });

  const findings = data?.findings ?? [];

  return (
    <div className="adm-page">
      <PageHeader
        title={<Breadcrumb first="Orca" second="Findings" />}
        subtitle={`${findings.length} total`}
      />

      <div className="adm-filterbar">
        <span className="adm-filterbar-lbl">status</span>
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setStatusFilter(f.value)}
            className={"pl-chip" + (statusFilter === f.value ? " active" : "")}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {isLoading && (
          <div className="adm-empty" style={{ padding: "22px var(--pad-x)", fontFamily: "var(--mono)" }}>
            loading…
          </div>
        )}
        {!isLoading && findings.length === 0 && (
          <div className="adm-empty" style={{ padding: "22px var(--pad-x)" }}>
            No findings yet. Findings are created by code-qa, the auditor, human
            comments, or the agent's self-critique.
          </div>
        )}

        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {findings.map((f) => (
            <FindingRow key={f.id} finding={f} />
          ))}
        </ul>
      </div>
    </div>
  );
}

function FindingRow({ finding }: { finding: EnrichedFinding }) {
  const queryClient = useQueryClient();
  const dismissMutation = useMutation({
    mutationFn: () => api.findings.dismiss(finding.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["findings"] });
    },
  });

  const isReliabilityFailure =
    finding.rootCause === "agent-failure" ||
    finding.rootCause === "agent-false-completion";

  return (
    <li className={"adm-finding" + (isReliabilityFailure ? " reliability" : "")}>
      <div>
        <div className="adm-finding-pills">
          <span className="adm-tag">{finding.source}</span>
          <span className={"adm-tag" + (isReliabilityFailure ? " adm-tag-error" : "")}>
            {ROOT_CAUSE_LABEL[finding.rootCause]}
          </span>
          <span className="adm-tag">{finding.status}</span>
          {finding.scope === "cross-project" && (
            <span className="adm-tag">cross-project</span>
          )}
        </div>
        <div className="adm-finding-body">{finding.body}</div>
        {finding.citation && (
          <div className="adm-finding-cite">
            {finding.citation.file}
            {finding.citation.line != null ? `:${finding.citation.line}` : ""}
          </div>
        )}
        <div className="adm-finding-meta">
          <span>
            {new Date(finding.createdAt).toLocaleString()} ·{" "}
            <a
              href={`/stories/${finding.storyId}`}
              style={{
                color: "var(--fg-1)",
                textDecoration: "underline",
                textDecorationStyle: "dotted",
                textUnderlineOffset: 2,
              }}
            >
              story
            </a>
          </span>
          {finding.status === "pending" && (
            <button
              onClick={() => dismissMutation.mutate()}
              disabled={dismissMutation.isPending}
              className="btn btn-sm"
            >
              {dismissMutation.isPending ? "dismissing…" : "dismiss"}
            </button>
          )}
        </div>
      </div>

      <WhatWeDid finding={finding} />
    </li>
  );
}

function WhatWeDid({ finding }: { finding: EnrichedFinding }) {
  if (finding.status === "applied") {
    return (
      <div style={{ color: "var(--fg-0)", fontSize: 13, lineHeight: 1.5 }}>
        <div className="adm-finding-resolved-label">applied</div>
        <div>
          Written back to{" "}
          <span style={{ fontFamily: "var(--mono)" }}>
            {describeDestination(finding.destination)}
          </span>
          {finding.appliedCommit && (
            <>
              {" "}in{" "}
              <span style={{ fontFamily: "var(--mono)", fontSize: 11 }}>
                {finding.appliedCommit.slice(0, 12)}
              </span>
            </>
          )}
          .
        </div>
        {finding.appliedAt && (
          <div className="adm-finding-cite" style={{ marginTop: 4 }}>
            {new Date(finding.appliedAt).toLocaleString()}
          </div>
        )}
      </div>
    );
  }

  if (finding.status === "dismissed") {
    return (
      <div style={{ color: "var(--fg-2)", fontSize: 13, lineHeight: 1.5 }}>
        <div className="adm-finding-resolved-label">dismissed</div>
        <div>Closed without write-back.</div>
      </div>
    );
  }

  if (finding.status === "triaged") {
    return (
      <div style={{ color: "var(--fg-0)", fontSize: 13, lineHeight: 1.5 }}>
        <div className="adm-finding-resolved-label">triaged — awaiting write-back</div>
        <div>
          Will write to{" "}
          <span style={{ fontFamily: "var(--mono)" }}>
            {describeDestination(finding.destination)}
          </span>
          .
        </div>
        {finding.latestClassification && (
          <ClassificationReasoning c={finding.latestClassification} />
        )}
      </div>
    );
  }

  if (finding.latestClassification) {
    return (
      <div style={{ color: "var(--fg-0)", fontSize: 13, lineHeight: 1.5 }}>
        <div className="adm-finding-resolved-label">classifier proposed</div>
        <div>
          {ROOT_CAUSE_LABEL[finding.latestClassification.proposedRootCause]} →{" "}
          <span style={{ fontFamily: "var(--mono)" }}>
            {describeDestination(finding.latestClassification.proposedDestination)}
          </span>
        </div>
        <ClassificationReasoning c={finding.latestClassification} />
      </div>
    );
  }

  return (
    <div style={{ color: "var(--fg-3)", fontSize: 13, fontStyle: "italic" }}>
      Awaiting classifier proposal.
    </div>
  );
}

function ClassificationReasoning({ c }: { c: Classification }) {
  const [expanded, setExpanded] = useState(false);
  if (!c.reasoning) return null;
  return (
    <div style={{ fontSize: 11.5, color: "var(--fg-2)", marginTop: 8 }}>
      <button
        onClick={() => setExpanded((e) => !e)}
        style={{
          background: "transparent", border: 0, padding: 0, font: "inherit",
          color: "var(--fg-1)",
          textDecoration: "underline", textDecorationStyle: "dotted",
          textUnderlineOffset: 2, cursor: "default",
        }}
      >
        {expanded ? "hide reasoning" : "show reasoning"}
      </button>
      {expanded && (
        <div style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>{c.reasoning}</div>
      )}
      <div style={{ marginTop: 4 }}>
        confidence {(c.confidence * 100).toFixed(0)}% · classifier {c.classifierVersion}
      </div>
    </div>
  );
}

function describeDestination(d: FindingDestination): string {
  if (d.path) return `${d.kind} ${d.path}`;
  return d.kind;
}
