import { useState, useMemo, useRef, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { api } from "../api.js";
import type { AgentInvocation } from "../api.js";
import { PageHeader } from "../components/PageHeader.js";
import { Breadcrumb } from "../components/Breadcrumb.js";
import { AVAILABLE_MODELS_FALLBACK, type Agent, type AvailableModel } from "@orca/shared";
import { resolveAgentDisplay } from "../utils/agentStyle.js";

export function AgentsPage() {
  const [showArchived, setShowArchived] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["agents", showArchived],
    queryFn: () => api.agents.list(showArchived),
  });

  const agents = data?.agents ?? [];
  const activeAgents = agents.filter((a) => a.archivedAt === null);
  const archivedAgents = agents.filter((a) => a.archivedAt !== null);

  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const selected = agents.find((a) => a.name === selectedAgent);

  return (
    <div className="adm-page">
      <PageHeader
        title={<Breadcrumb first="Orca" second="Agents" />}
        subtitle={`${activeAgents.length} active${archivedAgents.length > 0 ? `, ${archivedAgents.length} archived` : ""}`}
      />

      {isLoading && (
        <div className="adm-empty" style={{ padding: "22px var(--pad-x)", fontFamily: "var(--mono)" }}>
          loading…
        </div>
      )}
      {!isLoading && activeAgents.length === 0 && !showArchived && (
        <div className="adm-empty" style={{ padding: "22px var(--pad-x)" }}>
          No agents in the database. The migrator should have seeded the
          canonical list — check the server logs for migration errors.
        </div>
      )}

      {!isLoading && (
        <div className="adm-split">
          <aside className="adm-split-aside">
            <div className="adm-split-aside-head">
              <button
                onClick={() => setShowCreateForm(true)}
                className="btn btn-sm btn-primary"
                style={{ flex: 1 }}
              >
                + new agent
              </button>
              <button
                onClick={() => setShowArchived((v) => !v)}
                className={"btn btn-sm" + (showArchived ? " btn-active" : "")}
              >
                archived
              </button>
            </div>

            <div className="adm-split-aside-scroll">
              {activeAgents.map((a) => (
                <AgentSidebarRow
                  key={a.id}
                  agent={a}
                  selected={selectedAgent === a.name}
                  onSelect={() => setSelectedAgent(a.name)}
                />
              ))}

              {showArchived && archivedAgents.length > 0 && (
                <>
                  <div className="adm-split-aside-section">Archived</div>
                  {archivedAgents.map((a) => (
                    <AgentSidebarRow
                      key={a.id}
                      agent={a}
                      selected={selectedAgent === a.name}
                      onSelect={() => setSelectedAgent(a.name)}
                    />
                  ))}
                </>
              )}
            </div>
          </aside>

          <div className="adm-split-main">
            {showCreateForm ? (
              <CreateAgentForm
                onClose={() => setShowCreateForm(false)}
                onCreated={(name) => {
                  setShowCreateForm(false);
                  setSelectedAgent(name);
                }}
              />
            ) : !selected ? (
              <div
                className="adm-empty"
                style={{
                  height: "100%",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontFamily: "var(--mono)",
                }}
              >
                select an agent
              </div>
            ) : (
              <AgentDetail
                key={selected.name}
                agentName={selected.name}
                agent={selected}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function AgentSidebarRow({
  agent,
  selected,
  onSelect,
}: {
  agent: Agent;
  selected: boolean;
  onSelect: () => void;
}) {
  const { icon, color } = resolveAgentDisplay(agent.name);
  const classes = [
    "adm-listitem",
    selected ? "active" : "",
    agent.archivedAt ? "archived" : "",
  ].filter(Boolean).join(" ");
  return (
    <button
      onClick={onSelect}
      className={classes}
      style={{ borderLeftColor: selected ? color : "transparent" }}
    >
      <div className="adm-listitem-head">
        <FontAwesomeIcon
          icon={icon}
          style={{ color, fontSize: 11, width: 12, flexShrink: 0 }}
        />
        <span className="adm-listitem-name" style={{ color }}>
          {agent.name}
        </span>
        {!agent.isCodeModifying && (
          <span className="adm-listitem-aux">read-only</span>
        )}
        {agent.archivedAt && (
          <span className="adm-listitem-aux">archived</span>
        )}
      </div>
      <div className="adm-listitem-desc">{agent.description}</div>
      {agent.model && (
        <div className="adm-listitem-meta">{agent.model}</div>
      )}
    </button>
  );
}

function CreateAgentForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isCodeModifying, setIsCodeModifying] = useState(false);

  const createMutation = useMutation({
    mutationFn: () => api.agents.create({ name, description, isCodeModifying }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ["agents"] });
      onCreated(data.agent.name);
    },
  });

  const nameValid = /^[a-z0-9-]+$/.test(name);

  return (
    <div className="adm-body adm-body-narrow">
      <section>
        <div className="adm-section">
          <span>New agent</span>
          <span className="adm-section-rule" />
          <button onClick={onClose} className="btn btn-sm btn-ghost">cancel</button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label className="adm-label">
              Name
              <span className="adm-label-aux">(lowercase, hyphens only)</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. my-agent"
              className="input"
              style={{
                fontFamily: "var(--mono)",
                borderColor: name && !nameValid ? "var(--attn-error)" : undefined,
              }}
            />
            {name && !nameValid && (
              <div style={{ fontSize: 11, color: "var(--attn-error)", marginTop: 4 }}>
                Only lowercase letters, numbers, and hyphens allowed.
              </div>
            )}
          </div>

          <div>
            <label className="adm-label">Description</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="One-line description of what this agent does"
              className="input"
            />
          </div>

          <label
            style={{
              display: "flex", alignItems: "center", gap: 8,
              fontSize: 12.5, color: "var(--fg-1)", cursor: "default",
            }}
          >
            <input
              type="checkbox"
              checked={isCodeModifying}
              onChange={(e) => setIsCodeModifying(e.target.checked)}
              style={{ accentColor: "var(--ag-impl)" }}
            />
            Code-modifying agent
          </label>

          {createMutation.isError && (
            <div
              className="adm-tag adm-tag-error"
              style={{
                padding: "8px 10px", fontSize: 12, fontFamily: "inherit",
                whiteSpace: "normal",
              }}
            >
              {(createMutation.error as Error)?.message ?? "Failed to create agent"}
            </div>
          )}

          <div>
            <button
              onClick={() => createMutation.mutate()}
              disabled={!name || !nameValid || createMutation.isPending}
              className="btn btn-sm btn-primary"
            >
              {createMutation.isPending ? "creating…" : "create agent"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function useAvailableModels(): readonly AvailableModel[] {
  const { data } = useQuery({
    queryKey: ["models"],
    queryFn: () => api.models.list(),
    staleTime: 10 * 60 * 1000,
    refetchInterval: 10 * 60 * 1000,
  });
  return data?.models ?? AVAILABLE_MODELS_FALLBACK;
}

function ModelSelect({
  value,
  onChange,
  defaultLabel,
  dirty,
}: {
  value: string;
  onChange: (v: string) => void;
  defaultLabel: string;
  dirty: boolean;
}) {
  const models = useAvailableModels();
  const knownIds = models.map((m) => m.id);
  const hasUnknown = value !== "" && !knownIds.includes(value);
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={"input" + (dirty ? " adm-dirty" : "")}
      style={{ fontFamily: "var(--mono)" }}
    >
      <option value="">{defaultLabel}</option>
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.id}
        </option>
      ))}
      {hasUnknown && <option value={value}>{value} (unknown)</option>}
    </select>
  );
}

function AgentDetail({ agentName, agent }: { agentName: string; agent: Agent }) {
  const qc = useQueryClient();

  const [descDraft, setDescDraft] = useState(agent.description);
  const [modelDraft, setModelDraft] = useState(agent.model ?? "");
  const [fastModelDraft, setFastModelDraft] = useState(agent.fastModel ?? "");
  const [maxTurnsDraft, setMaxTurnsDraft] = useState<string>(
    agent.maxTurns != null ? String(agent.maxTurns) : "",
  );

  const { data: promptData } = useQuery({
    queryKey: ["agent-prompt", agentName],
    queryFn: () => api.agents.getPrompt(agentName),
  });
  const fileSystem = promptData?.system ?? "";
  const fileMain = promptData?.main ?? "";

  const [systemDraft, setSystemDraft] = useState<string | null>(null);
  const [mainDraft, setMainDraft] = useState<string | null>(null);

  const effectiveSystemDraft = systemDraft ?? fileSystem;
  const effectiveMainDraft = mainDraft ?? fileMain;

  const maxTurnsCurrent = agent.maxTurns != null ? String(agent.maxTurns) : "";
  const isDirty = useMemo(() => {
    const descChanged = descDraft !== agent.description;
    const modelChanged = modelDraft !== (agent.model ?? "");
    const fastModelChanged = fastModelDraft !== (agent.fastModel ?? "");
    const maxTurnsChanged = maxTurnsDraft !== maxTurnsCurrent;
    const systemChanged = effectiveSystemDraft !== fileSystem;
    const mainChanged = effectiveMainDraft !== fileMain;
    return descChanged || modelChanged || fastModelChanged || maxTurnsChanged || systemChanged || mainChanged;
  }, [descDraft, modelDraft, fastModelDraft, maxTurnsDraft, maxTurnsCurrent, effectiveSystemDraft, effectiveMainDraft, agent, fileSystem, fileMain]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const maxTurnsTrim = maxTurnsDraft.trim();
      const maxTurnsValue =
        maxTurnsTrim === "" ? null : Math.max(1, Math.floor(Number(maxTurnsTrim) || 0));
      await api.agents.patch(agentName, {
        description: descDraft,
        model: modelDraft.trim() || null,
        fastModel: fastModelDraft.trim() || null,
        maxTurns: maxTurnsValue,
      });
      const systemChanged = effectiveSystemDraft !== fileSystem;
      const mainChanged = effectiveMainDraft !== fileMain;
      if (systemChanged || mainChanged) {
        await api.agents.savePrompt(agentName, {
          system: effectiveSystemDraft,
          main: effectiveMainDraft,
        });
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["agents"] });
      void qc.invalidateQueries({ queryKey: ["agent-prompt", agentName] });
      setSystemDraft(null);
      setMainDraft(null);
    },
  });

  const archiveMutation = useMutation({
    mutationFn: () => api.agents.archive(agentName),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["agents"] }); },
  });

  const unarchiveMutation = useMutation({
    mutationFn: () => api.agents.unarchive(agentName),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["agents"] }); },
  });

  const isArchived = agent.archivedAt !== null;
  const { icon, color } = resolveAgentDisplay(agentName);

  return (
    <div className="adm-body" style={{ maxWidth: 900 }}>
      <section>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <FontAwesomeIcon icon={icon} style={{ color, fontSize: 22, flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <h2
                style={{
                  fontFamily: "var(--mono)", fontSize: 15, fontWeight: 600,
                  color, margin: 0,
                }}
              >
                {agentName}
              </h2>
              <span className="adm-listitem-meta" style={{ margin: 0 }}>
                v{agent.version}
                {agent.isCodeModifying ? " · code-modifying" : " · read-only"}
                {isArchived && (
                  <span style={{ color: "var(--attn-error)" }}> · archived</span>
                )}
              </span>
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            {isArchived ? (
              <button
                onClick={() => unarchiveMutation.mutate()}
                disabled={unarchiveMutation.isPending}
                className="btn btn-sm"
              >
                {unarchiveMutation.isPending ? "restoring…" : "unarchive"}
              </button>
            ) : (
              <button
                onClick={() => archiveMutation.mutate()}
                disabled={archiveMutation.isPending}
                className="btn btn-sm btn-danger"
              >
                {archiveMutation.isPending ? "archiving…" : "archive"}
              </button>
            )}
            <button
              onClick={() => saveMutation.mutate()}
              disabled={!isDirty || saveMutation.isPending}
              className="btn btn-sm btn-primary"
            >
              {saveMutation.isPending ? "saving…" : "save"}
            </button>
          </div>
        </div>
      </section>

      <section>
        <label className="adm-label">Description</label>
        <input
          type="text"
          value={descDraft}
          onChange={(e) => setDescDraft(e.target.value)}
          className={"input" + (descDraft !== agent.description ? " adm-dirty" : "")}
        />
      </section>

      <section>
        <div className="adm-grid-2">
          <div>
            <label className="adm-label">Model</label>
            <ModelSelect
              value={modelDraft}
              onChange={setModelDraft}
              defaultLabel="(default)"
              dirty={modelDraft !== (agent.model ?? "")}
            />
          </div>
          <div>
            <label className="adm-label">Fast model</label>
            <ModelSelect
              value={fastModelDraft}
              onChange={setFastModelDraft}
              defaultLabel="(none)"
              dirty={fastModelDraft !== (agent.fastModel ?? "")}
            />
          </div>
        </div>
      </section>

      <section>
        <label className="adm-label">
          Max turns
          <span className="adm-label-aux">
            (caps `--max-turns`; blank = no cap. Lower = less context accumulation per dispatch.)
          </span>
        </label>
        <input
          type="number"
          min={1}
          step={1}
          value={maxTurnsDraft}
          onChange={(e) => setMaxTurnsDraft(e.target.value)}
          placeholder="(no cap)"
          className={"input" + (maxTurnsDraft !== maxTurnsCurrent ? " adm-dirty" : "")}
          style={{ fontFamily: "var(--mono)", maxWidth: 160 }}
        />
      </section>

      <section>
        <label className="adm-label">
          Cached system prompt
          <span className="adm-label-aux">
            ({effectiveSystemDraft.length.toLocaleString()} chars · cached)
          </span>
        </label>
        {!promptData ? (
          <div className="adm-empty" style={{ fontFamily: "var(--mono)" }}>loading…</div>
        ) : (
          <textarea
            value={effectiveSystemDraft}
            onChange={(e) => setSystemDraft(e.target.value)}
            placeholder="Agent instructions, directives, static context… Cached by Claude across all stories using this agent."
            className={"adm-textarea" + (effectiveSystemDraft !== fileSystem ? " adm-dirty" : "")}
            style={{ minHeight: 200 }}
          />
        )}
      </section>

      <section>
        <label className="adm-label">
          Uncached prompt
          <span className="adm-label-aux">
            ({effectiveMainDraft.length.toLocaleString()} chars)
          </span>
        </label>
        {!promptData ? (
          <div className="adm-empty" style={{ fontFamily: "var(--mono)" }}>loading…</div>
        ) : (
          <textarea
            value={effectiveMainDraft}
            onChange={(e) => setMainDraft(e.target.value)}
            placeholder="Story-specific context: {story.title}, {story.spec}, {story.id}…"
            className={"adm-textarea" + (effectiveMainDraft !== fileMain ? " adm-dirty" : "")}
            style={{ minHeight: 300 }}
          />
        )}
      </section>

      <section>
        <div className="adm-listitem-meta">
          File: prompts/{agentName}.md · saves write the file directly · git owns history
        </div>
      </section>

      <section>
        <InvocationLog agentName={agentName} />
      </section>
    </div>
  );
}

const INVOCATION_TIMEOUT_MS = 10 * 60 * 1000;

function InvocationLog({ agentName }: { agentName: string }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["agent-invocations", agentName],
    queryFn: () => api.agents.listInvocations(agentName, 50),
    refetchInterval: 15_000,
  });
  const invocations = data?.invocations ?? [];
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const cancelMutation = useMutation({
    mutationFn: (storyId: string) => api.stories.stop(storyId),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["agent-invocations", agentName] }); },
  });

  return (
    <div>
      <div className="adm-section">
        <span>Invocation log</span>
        <span className="adm-section-rule" />
        <span className="adm-head-sub">{invocations.length}</span>
      </div>

      {isLoading && (
        <div className="adm-empty" style={{ fontFamily: "var(--mono)" }}>loading…</div>
      )}
      {!isLoading && invocations.length === 0 && (
        <div
          className="adm-empty"
          style={{
            padding: 18, textAlign: "center", fontFamily: "var(--mono)",
            border: "1px dashed var(--border-1)", borderRadius: "var(--r-md)",
          }}
        >
          No invocations recorded yet.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {invocations.map((inv) => (
          <InvocationRow
            key={inv.id}
            inv={inv}
            expanded={expandedId === inv.id}
            onToggle={() => setExpandedId(expandedId === inv.id ? null : inv.id)}
            onCancel={() => cancelMutation.mutate(inv.storyId)}
          />
        ))}
      </div>
    </div>
  );
}

function InvocationRow({
  inv,
  expanded,
  onToggle,
  onCancel,
}: {
  inv: AgentInvocation;
  expanded: boolean;
  onToggle: () => void;
  onCancel: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const ts = new Date(inv.promptAt);
  const elapsed = inv.responseAt
    ? Math.round((new Date(inv.responseAt).getTime() - ts.getTime()) / 1000)
    : null;
  const hasResponse = inv.response !== null;
  const result = inv.response?.result as string | undefined;
  const isTimedOut = !hasResponse && Date.now() - ts.getTime() > INVOCATION_TIMEOUT_MS;

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  const resultClass = (r: string) => {
    if (r === "pass" || r === "clear" || r === "ok") return "adm-tag adm-tag-done";
    if (r === "fail" || r === "error" || r === "spawn_error") return "adm-tag adm-tag-error";
    return "adm-tag";
  };

  const headerInner = (
    <>
      {!expanded && (
        <span style={{ color: "var(--fg-4)", fontSize: 10 }}>▶</span>
      )}
      <span
        style={{
          fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-4)",
        }}
      >
        {inv.id.slice(0, 8)}
      </span>
      <span
        style={{
          fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-2)",
        }}
      >
        {ts.toLocaleDateString()} {ts.toLocaleTimeString()}
      </span>
      <a
        href={`/stories/${inv.storyId}`}
        onClick={(e) => e.stopPropagation()}
        style={{
          fontFamily: "var(--mono)", fontSize: 11,
          color: "var(--ag-impl)", textDecoration: "none",
        }}
      >
        {inv.storyId.slice(0, 8)}
      </a>
      {result && <span className={resultClass(result)}>{result}</span>}
      {isTimedOut && !result && (
        <span className="adm-tag adm-tag-error">timed out</span>
      )}
      <div
        style={{
          marginLeft: "auto", display: "flex", alignItems: "center",
          gap: 8, flexShrink: 0,
        }}
      >
        {elapsed !== null && (
          <span
            style={{
              fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-2)",
            }}
          >
            {elapsed}s
          </span>
        )}
        {!hasResponse && !isTimedOut && (
          <span
            style={{ fontSize: 10.5, fontStyle: "italic", color: "var(--fg-3)" }}
          >
            pending…
          </span>
        )}
        <div
          style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div ref={menuRef} style={{ position: "relative" }}>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              title="Actions"
              style={{
                width: 22, height: 22, display: "flex",
                alignItems: "center", justifyContent: "center",
                borderRadius: "var(--r-sm)",
                fontSize: 15, lineHeight: 1, color: "var(--fg-3)",
                background: "transparent", border: 0, cursor: "default",
              }}
            >
              ⋮
            </button>
            {menuOpen && (
              <div
                style={{
                  position: "absolute", right: 0, top: "100%", marginTop: 4,
                  zIndex: 50, minWidth: 120,
                  background: "var(--bg-2)", border: "1px solid var(--border-1)",
                  borderRadius: "var(--r-md)", boxShadow: "0 8px 24px rgba(0,0,0,.45)",
                  padding: "4px 0",
                }}
              >
                <button
                  onClick={() => { onCancel(); setMenuOpen(false); }}
                  style={{
                    display: "flex", width: "100%", padding: "6px 12px",
                    background: "transparent", border: 0, textAlign: "left",
                    color: "var(--attn-error)", fontSize: 12.5, cursor: "default",
                  }}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
          {expanded && (
            <button
              onClick={onToggle}
              title="Collapse"
              style={{
                width: 22, height: 22, display: "flex",
                alignItems: "center", justifyContent: "center",
                background: "transparent", border: 0, cursor: "default",
                color: "var(--ag-impl)", fontSize: 14,
              }}
            >
              ✓
            </button>
          )}
        </div>
      </div>
    </>
  );

  return (
    <div
      style={{
        borderRadius: "var(--r-md)", overflow: "hidden",
        border: "1px solid var(--border-1)",
        background: "var(--bg-1)",
      }}
    >
      {expanded ? (
        <div
          style={{
            padding: "8px 12px", display: "flex", alignItems: "center", gap: 10,
            background: "var(--bg-2)",
          }}
        >
          {headerInner}
        </div>
      ) : (
        <div
          role="button"
          tabIndex={0}
          onClick={onToggle}
          style={{
            width: "100%", padding: "8px 12px",
            display: "flex", alignItems: "center", gap: 10,
            background: "var(--bg-1)", cursor: "default",
            color: "var(--fg-1)",
          }}
        >
          {headerInner}
        </div>
      )}
      {expanded && (
        <div
          style={{
            display: "flex", minHeight: 200,
            borderTop: "1px solid var(--border-0)",
          }}
        >
          <div
            style={{
              flex: 1, display: "flex", flexDirection: "column", minWidth: 0,
              borderRight: "1px solid var(--border-0)",
            }}
          >
            <div
              style={{
                padding: "5px 12px", background: "var(--bg-2)",
                color: "var(--fg-3)", fontSize: 10, textTransform: "uppercase",
                letterSpacing: "0.06em",
                borderBottom: "1px solid var(--border-0)",
              }}
            >
              Request
            </div>
            <div style={{ flex: 1, overflow: "auto", maxHeight: 400 }}>
              {inv.systemPrompt && (
                <div style={{ borderBottom: "1px solid var(--border-0)" }}>
                  <div
                    style={{
                      padding: "3px 12px", background: "var(--bg-2)",
                      color: "var(--fg-4)", fontSize: 10,
                      textTransform: "uppercase", letterSpacing: "0.06em",
                    }}
                  >
                    System prompt
                  </div>
                  <pre
                    style={{
                      margin: 0, padding: "8px 12px",
                      fontFamily: "var(--mono)", fontSize: 11.5,
                      whiteSpace: "pre-wrap", wordBreak: "break-word",
                      color: "var(--fg-2)",
                    }}
                  >
                    {inv.systemPrompt}
                  </pre>
                </div>
              )}
              <div>
                {inv.systemPrompt && (
                  <div
                    style={{
                      padding: "3px 12px", background: "var(--bg-2)",
                      color: "var(--fg-4)", fontSize: 10,
                      textTransform: "uppercase", letterSpacing: "0.06em",
                    }}
                  >
                    Main prompt
                  </div>
                )}
                <pre
                  style={{
                    margin: 0, padding: "8px 12px",
                    fontFamily: "var(--mono)", fontSize: 11.5,
                    whiteSpace: "pre-wrap", wordBreak: "break-word",
                    color: "var(--fg-1)",
                  }}
                >
                  {inv.prompt}
                </pre>
              </div>
            </div>
          </div>
          <div
            style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}
          >
            <div
              style={{
                padding: "5px 12px", background: "var(--bg-2)",
                color: "var(--fg-3)", fontSize: 10,
                textTransform: "uppercase", letterSpacing: "0.06em",
                borderBottom: "1px solid var(--border-0)",
              }}
            >
              Response
            </div>
            <pre
              style={{
                flex: 1, margin: 0, padding: 12,
                fontFamily: "var(--mono)", fontSize: 11.5,
                whiteSpace: "pre-wrap", wordBreak: "break-word",
                overflow: "auto", maxHeight: 400, color: "var(--fg-1)",
              }}
            >
              {inv.response ? formatResponse(inv.response) : "(awaiting response)"}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function formatResponse(response: Record<string, unknown>): string {
  if (typeof response.rawResponse === "string") {
    return response.rawResponse;
  }
  return JSON.stringify(response, null, 2);
}
