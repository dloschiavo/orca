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
    <div className="h-full flex flex-col">
      <PageHeader
        title={<Breadcrumb first="Orca" second="Agents" />}
        subtitle={`${activeAgents.length} active${archivedAgents.length > 0 ? `, ${archivedAgents.length} archived` : ""}`}
      />
      {isLoading && (
        <div className="p-6 text-sm text-muted">loading…</div>
      )}
      {!isLoading && activeAgents.length === 0 && !showArchived && (
        <div className="p-6 text-sm text-muted">
          No agents in the database. The migrator should have seeded
          the canonical list — check the server logs for migration errors.
        </div>
      )}

      {!isLoading && (
        <div className="flex-1 min-h-0 flex">
          <aside className="w-[260px] shrink-0 overflow-y-auto flex flex-col border-r border-border bg-surface">
            <div className="px-3 py-2 flex items-center gap-2 shrink-0 border-b border-border">
              <button
                onClick={() => setShowCreateForm(true)}
                className="btn btn-sm btn-primary flex-1"
              >
                + new agent
              </button>
              <button
                onClick={() => setShowArchived((v) => !v)}
                className={`btn btn-sm${showArchived ? " btn-active" : ""}`}
              >
                archived
              </button>
            </div>

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
                <div className="px-4 py-1.5 text-[10px] uppercase tracking-wider text-muted bg-surface2 border-t border-b border-border">
                  Archived
                </div>
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
          </aside>

          <div className="flex-1 min-w-0 overflow-y-auto">
            {showCreateForm ? (
              <CreateAgentForm
                onClose={() => setShowCreateForm(false)}
                onCreated={(name) => {
                  setShowCreateForm(false);
                  setSelectedAgent(name);
                }}
              />
            ) : !selected ? (
              <div className="flex items-center justify-center h-full text-sm font-mono text-muted/50">
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
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-4 py-3 transition-colors border-b border-border border-l-2 ${
        selected ? "bg-surface2" : "hover:bg-surface2/50"
      } ${agent.archivedAt ? "opacity-50" : ""}`}
      style={{ borderLeftColor: selected ? color : "transparent" }}
    >
      <div className="flex items-center gap-2">
        <FontAwesomeIcon icon={icon} className="text-[11px] shrink-0 w-3" style={{ color }} />
        <span className="font-mono text-[12px] font-medium" style={{ color }}>
          {agent.name}
        </span>
        {!agent.isCodeModifying && (
          <span className="text-[9px] uppercase text-muted/50">read-only</span>
        )}
        {agent.archivedAt && (
          <span className="text-[9px] uppercase text-muted/50">archived</span>
        )}
      </div>
      <div className="text-[11px] mt-1 pl-8 whitespace-normal text-muted">
        {agent.description}
      </div>
      {agent.model && (
        <div className="text-[10px] font-mono mt-0.5 pl-8 text-muted/50">
          {agent.model}
        </div>
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
    <div className="p-6 space-y-6 max-w-lg">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text">New Agent</h2>
        <button onClick={onClose} className="btn btn-sm btn-ghost">cancel</button>
      </div>

      <div>
        <label className="text-[10.5px] uppercase tracking-wider text-muted block mb-1.5">
          Name <span className="normal-case tracking-normal text-muted/50">(lowercase, hyphens only)</span>
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. my-agent"
          className={`w-full px-3 py-2 rounded-md text-sm font-mono outline-none bg-surface text-text border ${
            name && !nameValid ? "border-blocked" : "border-border"
          }`}
        />
        {name && !nameValid && (
          <div className="text-[11px] mt-1 text-blocked">
            Only lowercase letters, numbers, and hyphens allowed.
          </div>
        )}
      </div>

      <div>
        <label className="text-[10.5px] uppercase tracking-wider text-muted block mb-1.5">
          Description
        </label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="One-line description of what this agent does"
          className="w-full px-3 py-2 rounded-md text-sm outline-none bg-surface text-text border border-border"
        />
      </div>

      <div className="flex items-center gap-3">
        <input
          type="checkbox"
          id="isCodeModifying"
          checked={isCodeModifying}
          onChange={(e) => setIsCodeModifying(e.target.checked)}
          className="rounded"
        />
        <label htmlFor="isCodeModifying" className="text-sm cursor-pointer text-text/80">
          Code-modifying agent
        </label>
      </div>

      {createMutation.isError && (
        <div className="text-[12px] rounded-md px-3 py-2 text-blocked bg-blocked/10 border border-blocked/30">
          {(createMutation.error as Error)?.message ?? "Failed to create agent"}
        </div>
      )}

      <button
        onClick={() => createMutation.mutate()}
        disabled={!name || !nameValid || createMutation.isPending}
        className="btn btn-sm btn-primary"
      >
        {createMutation.isPending ? "creating…" : "create agent"}
      </button>
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
      className={`w-full px-3 py-2 rounded-md text-sm font-mono outline-none bg-surface text-text border ${
        dirty ? "border-done/50 ring-1 ring-done/20" : "border-border"
      }`}
    >
      <option value="">{defaultLabel}</option>
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.id}
        </option>
      ))}
      {hasUnknown && (
        <option value={value}>{value} (unknown)</option>
      )}
    </select>
  );
}

function AgentDetail({ agentName, agent }: { agentName: string; agent: Agent }) {
  const qc = useQueryClient();

  const [descDraft, setDescDraft] = useState(agent.description);
  const [modelDraft, setModelDraft] = useState(agent.model ?? "");
  const [fastModelDraft, setFastModelDraft] = useState(agent.fastModel ?? "");

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

  const isDirty = useMemo(() => {
    const descChanged = descDraft !== agent.description;
    const modelChanged = modelDraft !== (agent.model ?? "");
    const fastModelChanged = fastModelDraft !== (agent.fastModel ?? "");
    const systemChanged = effectiveSystemDraft !== fileSystem;
    const mainChanged = effectiveMainDraft !== fileMain;
    return descChanged || modelChanged || fastModelChanged || systemChanged || mainChanged;
  }, [descDraft, modelDraft, fastModelDraft, effectiveSystemDraft, effectiveMainDraft, agent, fileSystem, fileMain]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      await api.agents.patch(agentName, {
        description: descDraft,
        model: modelDraft.trim() || null,
        fastModel: fastModelDraft.trim() || null,
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

  const fieldClass = (dirty: boolean) =>
    dirty ? "border-done/50 ring-1 ring-done/20" : "border-border";

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {(() => {
            const { icon, color } = resolveAgentDisplay(agentName);
            return (
              <FontAwesomeIcon icon={icon} className="text-xl shrink-0" style={{ color }} />
            );
          })()}
          <div>
            <h2 className="text-sm font-semibold font-mono" style={{ color: resolveAgentDisplay(agentName).color }}>
              {agentName}
            </h2>
            <div className="text-[11px] mt-0.5 text-muted">
              v{agent.version}
              {agent.isCodeModifying ? " · code-modifying" : " · read-only"}
              {isArchived && <span className="text-blocked"> · archived</span>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
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

      <div>
        <label className="text-[10.5px] uppercase tracking-wider text-muted block mb-1.5">
          Description
        </label>
        <input
          type="text"
          value={descDraft}
          onChange={(e) => setDescDraft(e.target.value)}
          className={`w-full px-3 py-2 rounded-md text-sm outline-none bg-surface text-text border ${fieldClass(descDraft !== agent.description)}`}
        />
      </div>

      <div className="flex gap-4">
        <div className="flex-1">
          <label className="text-[10.5px] uppercase tracking-wider text-muted block mb-1.5">
            Model
          </label>
          <ModelSelect
            value={modelDraft}
            onChange={setModelDraft}
            defaultLabel="(default)"
            dirty={modelDraft !== (agent.model ?? "")}
          />
        </div>
        <div className="flex-1">
          <label className="text-[10.5px] uppercase tracking-wider text-muted block mb-1.5">
            Fast Model
          </label>
          <ModelSelect
            value={fastModelDraft}
            onChange={setFastModelDraft}
            defaultLabel="(none)"
            dirty={fastModelDraft !== (agent.fastModel ?? "")}
          />
        </div>
      </div>

      <div>
        <label className="text-[10.5px] uppercase tracking-wider text-muted block mb-1.5">
          Cached System Prompt
          <span className="ml-2 normal-case tracking-normal text-muted/50">
            ({effectiveSystemDraft.length.toLocaleString()} chars · cached)
          </span>
        </label>
        {!promptData ? (
          <div className="text-[12px] text-muted">loading…</div>
        ) : (
          <textarea
            value={effectiveSystemDraft}
            onChange={(e) => setSystemDraft(e.target.value)}
            placeholder="Agent instructions, directives, static context… Cached by Claude across all stories using this agent."
            className={`w-full min-h-[200px] px-3 py-2 rounded-md text-[12px] font-mono resize-y leading-relaxed outline-none bg-surface text-text border ${fieldClass(effectiveSystemDraft !== fileSystem)}`}
          />
        )}
      </div>

      <div>
        <label className="text-[10.5px] uppercase tracking-wider text-muted block mb-1.5">
          Uncached Prompt
          <span className="ml-2 normal-case tracking-normal text-muted/50">
            ({effectiveMainDraft.length.toLocaleString()} chars)
          </span>
        </label>
        {!promptData ? (
          <div className="text-[12px] text-muted">loading…</div>
        ) : (
          <textarea
            value={effectiveMainDraft}
            onChange={(e) => setMainDraft(e.target.value)}
            placeholder="Story-specific context: {story.title}, {story.spec}, {story.id}…"
            className={`w-full min-h-[300px] px-3 py-2 rounded-md text-[12px] font-mono resize-y leading-relaxed outline-none bg-surface text-text border ${fieldClass(effectiveMainDraft !== fileMain)}`}
          />
        )}
      </div>

      <div className="text-[10px] font-mono text-muted/50">
        File: prompts/{agentName}.md · saves write the file directly · git owns history
      </div>

      <InvocationLog agentName={agentName} />
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
      <div className="text-[10.5px] uppercase tracking-wider mb-3 text-muted">
        Invocation log ({invocations.length})
      </div>
      {isLoading && (
        <div className="text-[12px] text-muted">loading…</div>
      )}
      {!isLoading && invocations.length === 0 && (
        <div className="text-sm py-6 text-center rounded-md text-muted border border-dashed border-border">
          No invocations recorded yet.
        </div>
      )}
      <div className="space-y-2">
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
    if (r === "pass" || r === "clear" || r === "ok") return "bg-done/20 text-done";
    if (r === "fail" || r === "error" || r === "spawn_error") return "bg-blocked/20 text-blocked";
    return "bg-surface2 text-muted";
  };

  const actions = (
    <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="w-6 h-6 flex items-center justify-center rounded transition-colors text-[15px] leading-none text-muted hover:text-text"
          title="Actions"
        >
          ⋮
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-full z-50 mt-1 rounded-md shadow-lg min-w-[120px] py-1 bg-surface2 border border-border">
            <button
              onClick={() => { onCancel(); setMenuOpen(false); }}
              className="w-full text-left px-3 py-1.5 text-[12px] transition-colors text-blocked hover:bg-surface"
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
          className="w-6 h-6 flex items-center justify-center rounded transition-colors text-[14px]"
          style={{ color: "var(--ag-impl)" }}
        >
          ✓
        </button>
      )}
    </div>
  );

  const headerInner = (
    <>
      {!expanded && (
        <span className="text-[10px] text-muted/50">▶</span>
      )}
      <span className="text-[10px] font-mono text-muted/50">{inv.id.slice(0, 8)}</span>
      <span className="text-[11px] font-mono text-muted">
        {ts.toLocaleDateString()} {ts.toLocaleTimeString()}
      </span>
      <a
        href={`/stories/${inv.storyId}`}
        onClick={(e) => e.stopPropagation()}
        className="text-[11px] font-mono hover:underline"
        style={{ color: "var(--ag-impl)" }}
      >
        {inv.storyId.slice(0, 8)}
      </a>
      {result && (
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${resultClass(result)}`}>
          {result}
        </span>
      )}
      {isTimedOut && !result && (
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-blocked/20 text-blocked">
          timed out
        </span>
      )}
      <div className="ml-auto flex items-center gap-2 shrink-0">
        {elapsed !== null && (
          <span className="text-[10px] font-mono text-muted">{elapsed}s</span>
        )}
        {!hasResponse && !isTimedOut && (
          <span className="text-[10px] italic text-muted/50">pending…</span>
        )}
        {actions}
      </div>
    </>
  );

  return (
    <div className="rounded-md overflow-hidden border border-border">
      {expanded ? (
        <div className="px-4 py-2.5 flex items-center gap-3 bg-surface">
          {headerInner}
        </div>
      ) : (
        <button
          onClick={onToggle}
          className="w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors bg-surface hover:bg-surface2"
        >
          {headerInner}
        </button>
      )}
      {expanded && (
        <div className="flex min-h-[200px] border-t border-border">
          <div className="flex-1 flex flex-col min-w-0 border-r border-border">
            <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider bg-surface text-muted border-b border-border">
              Request
            </div>
            <div className="flex-1 overflow-auto max-h-[400px]">
              {inv.systemPrompt && (
                <div className="border-b border-border">
                  <div className="px-3 py-1 text-[10px] uppercase tracking-wider bg-surface text-muted/50">
                    System prompt
                  </div>
                  <pre className="px-3 py-2 text-[11px] font-mono whitespace-pre-wrap break-words text-muted">
                    {inv.systemPrompt}
                  </pre>
                </div>
              )}
              <div>
                {inv.systemPrompt && (
                  <div className="px-3 py-1 text-[10px] uppercase tracking-wider bg-surface text-muted/50">
                    Main prompt
                  </div>
                )}
                <pre className="px-3 py-2 text-[11px] font-mono whitespace-pre-wrap break-words text-text/80">
                  {inv.prompt}
                </pre>
              </div>
            </div>
          </div>
          <div className="flex-1 flex flex-col min-w-0">
            <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider bg-surface text-muted border-b border-border">
              Response
            </div>
            <pre className="flex-1 p-3 text-[11px] font-mono whitespace-pre-wrap break-words overflow-auto max-h-[400px] text-text/80">
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
