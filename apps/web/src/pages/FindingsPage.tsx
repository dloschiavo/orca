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

// Findings inbox.
//
// Flat list, newest first. Two columns per row: the issue (body + citation
// + source/root-cause/status badges) and "what we did" (the latest
// classifier proposal, the human-confirmed classification, or the applied
// commit, depending on status). No more bands — the user wanted a single
// list of issues plus the resolution beside each.
//
// `agent-failure` and `agent-false-completion` are highlighted in red
// because they are the load-bearing reliability signal: they cannot be
// fixed by rider edits and the count is itself the metric for whether
// the agent can be trusted.

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
  const [statusFilter, setStatusFilter] = useState<FindingStatus | "all">(
    "all",
  );

  const { data, isLoading } = useQuery({
    queryKey: ["findings", statusFilter],
    queryFn: () =>
      api.findings.list(
        statusFilter === "all" ? {} : { status: statusFilter },
      ),
  });

  const findings = data?.findings ?? [];

  return (
    <div className="h-full flex flex-col">
      <PageHeader title={<Breadcrumb first="Orca" second="Findings" />} subtitle={`${findings.length} total`} />

      <div className="px-6 py-2 border-b border-border bg-surface flex items-center gap-1 text-[11px]">
        <span className="text-muted uppercase tracking-wider mr-2">
          status
        </span>
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setStatusFilter(f.value)}
            className={`px-2 py-0.5 rounded ${
              statusFilter === f.value
                ? "bg-text/10 text-text"
                : "text-muted hover:text-text"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <div className="p-6 text-muted text-sm">loading…</div>
        )}
        {!isLoading && findings.length === 0 && (
          <div className="p-6 text-muted text-sm">
            No findings yet. Findings are created by code-qa, the auditor,
            human comments, or the agent's self-critique.
          </div>
        )}

        <ul className="divide-y divide-border">
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
    <li
      className={`px-6 py-4 grid grid-cols-1 md:grid-cols-[1fr_1fr] gap-4 hover:bg-surface/30 ${
        isReliabilityFailure ? "border-l-2 border-l-red-500" : ""
      }`}
    >
      <div>
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <span className="pill text-[10px]">{finding.source}</span>
          <span
            className={`pill text-[10px] ${
              isReliabilityFailure ? "bg-red-500/10 text-red-400" : ""
            }`}
          >
            {ROOT_CAUSE_LABEL[finding.rootCause]}
          </span>
          <span className="pill text-[10px]">{finding.status}</span>
          {finding.scope === "cross-project" && (
            <span className="pill text-[10px]">cross-project</span>
          )}
        </div>
        <div className="text-sm text-text whitespace-pre-wrap">
          {finding.body}
        </div>
        {finding.citation && (
          <div className="text-[11px] text-muted mt-1 font-mono">
            {finding.citation.file}
            {finding.citation.line != null ? `:${finding.citation.line}` : ""}
          </div>
        )}
        <div className="text-[10px] text-muted mt-2 flex items-center gap-2">
          <span>
            {new Date(finding.createdAt).toLocaleString()} ·{" "}
            <a
              href={`/stories/${finding.storyId}`}
              className="underline decoration-dotted underline-offset-2"
            >
              story
            </a>
          </span>
          {finding.status === "pending" && (
            <button
              onClick={() => dismissMutation.mutate()}
              disabled={dismissMutation.isPending}
              className="btn text-xs"
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
  // The right-hand column shows the resolution state in plain English,
  // depending on the finding's lifecycle position. The intent: a glance
  // tells you whether anything has actually been done about this issue.

  if (finding.status === "applied") {
    return (
      <div className="text-sm text-text">
        <div className="text-[10px] uppercase tracking-wider text-muted mb-1">
          applied
        </div>
        <div>
          Written back to{" "}
          <span className="font-mono">{describeDestination(finding.destination)}</span>
          {finding.appliedCommit && (
            <>
              {" "}
              in{" "}
              <span className="font-mono text-[11px]">
                {finding.appliedCommit.slice(0, 12)}
              </span>
            </>
          )}
          .
        </div>
        {finding.appliedAt && (
          <div className="text-[10px] text-muted mt-1">
            {new Date(finding.appliedAt).toLocaleString()}
          </div>
        )}
      </div>
    );
  }

  if (finding.status === "dismissed") {
    return (
      <div className="text-sm text-muted">
        <div className="text-[10px] uppercase tracking-wider mb-1">
          dismissed
        </div>
        <div>Closed without write-back.</div>
      </div>
    );
  }

  if (finding.status === "triaged") {
    return (
      <div className="text-sm text-text">
        <div className="text-[10px] uppercase tracking-wider text-muted mb-1">
          triaged — awaiting write-back
        </div>
        <div>
          Will write to{" "}
          <span className="font-mono">{describeDestination(finding.destination)}</span>
          .
        </div>
        {finding.latestClassification && (
          <ClassificationReasoning c={finding.latestClassification} />
        )}
      </div>
    );
  }

  // pending
  if (finding.latestClassification) {
    return (
      <div className="text-sm text-text">
        <div className="text-[10px] uppercase tracking-wider text-muted mb-1">
          classifier proposed
        </div>
        <div>
          {ROOT_CAUSE_LABEL[finding.latestClassification.proposedRootCause]} →{" "}
          <span className="font-mono">
            {describeDestination(finding.latestClassification.proposedDestination)}
          </span>
        </div>
        <ClassificationReasoning c={finding.latestClassification} />
      </div>
    );
  }

  return (
    <div className="text-sm text-muted italic">
      Awaiting classifier proposal.
    </div>
  );
}

function ClassificationReasoning({ c }: { c: Classification }) {
  const [expanded, setExpanded] = useState(false);
  if (!c.reasoning) return null;
  return (
    <div className="text-[11px] text-muted mt-2">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="underline decoration-dotted underline-offset-2"
      >
        {expanded ? "hide reasoning" : "show reasoning"}
      </button>
      {expanded && (
        <div className="mt-1 whitespace-pre-wrap">{c.reasoning}</div>
      )}
      <div className="mt-1">
        confidence {(c.confidence * 100).toFixed(0)}% · classifier{" "}
        {c.classifierVersion}
      </div>
    </div>
  );
}

function describeDestination(d: FindingDestination): string {
  if (d.path) return `${d.kind} ${d.path}`;
  return d.kind;
}
