import { useState, useMemo, useRef, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { api } from "../api.js";
import type { AgentInvocation } from "../api.js";
import { PageHeader } from "../components/PageHeader.js";
import { Breadcrumb } from "../components/Breadcrumb.js";
import { AVAILABLE_MODELS_FALLBACK, type Agent, type AvailableModel } from "@orca/shared";
import { agentColors, agentIcon } from "../utils/agentStyle.js";

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
        <div className="text-muted text-sm p-6">loading…</div>
      )}
      {!isLoading && activeAgents.length === 0 && !showArchived && (
        <div className="text-muted text-sm p-6">
          No agents in the database. The migrator should have seeded
          the canonical list — check the server logs for migration errors.
        </div>
      )}

      {!isLoading && (
        <div className="flex-1 min-h-0 flex">
          <aside className="w-[280px] shrink-0 border-r border-border overflow-y-auto flex flex-col">
            {/* Sidebar toolbar */}
            <div className="px-3 py-2 border-b border-border flex items-center gap-2 shrink-0">
              <button
                onClick={() => setShowCreateForm(true)}
                className="flex-1 text-center text-[11px] px-2 py-1.5 rounded bg-accent/20 text-accent hover:bg-accent/30 transition-colors"
              >
                + new agent
              </button>
              <button
                onClick={() => setShowArchived((v) => !v)}
                className={`text-[11px] px-2 py-1.5 rounded transition-colors ${
                  showArchived
                    ? "bg-muted/30 text-text"
                    : "bg-transparent text-muted hover:text-text"
                }`}
                title="Toggle archived agents"
              >
                archived
              </button>
            </div>

            {/* Active agents */}
            {activeAgents.map((a) => (
              <AgentSidebarRow
                key={a.id}
                agent={a}
                selected={selectedAgent === a.name}
                onSelect={() => setSelectedAgent(a.name)}
              />
            ))}

            {/* Archived agents section */}
            {showArchived && archivedAgents.length > 0 && (
              <>
                <div className="px-4 py-1.5 text-[10px] uppercase tracking-wider text-muted bg-surface/50 border-y border-border">
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
              <div className="flex items-center justify-center h-full text-muted text-sm">
                Select an agent to view details
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
  const colors = agentColors(agent.name);
  const icon = agentIcon(agent.name);
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-4 py-3 border-b border-border transition-colors ${
        selected
          ? "bg-text/10 border-l-2 border-l-accent"
          : "hover:bg-surface border-l-2 border-l-transparent"
      } ${agent.archivedAt ? "opacity-50" : ""}`}
    >
      <div className="flex items-center gap-2">
        <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full shrink-0 ${colors.bg} ${colors.text}`}>
          <FontAwesomeIcon icon={icon} className="text-[10px]" />
        </span>
        <span className={`font-mono text-[12px] font-medium ${colors.text}`}>
          {agent.name}
        </span>
        {!agent.isCodeModifying && (
          <span className="text-[9px] uppercase text-muted">read-only</span>
        )}
        {agent.archivedAt && (
          <span className="text-[9px] uppercase text-muted">archived</span>
        )}
      </div>
      <div className="text-[11px] text-muted mt-1 whitespace-normal pl-8">
        {agent.description}
      </div>
      {agent.model && (
        <div className="text-[10px] text-muted/60 font-mono mt-0.5 pl-8">
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
        <h2 className="text-lg font-medium text-text">New Agent</h2>
        <button
          onClick={onClose}
          className="text-muted text-sm hover:text-text transition-colors"
        >
          cancel
        </button>
      </div>

      <div>
        <label className="text-[11px] uppercase tracking-wider text-muted block mb-1">
          Name <span className="normal-case tracking-normal text-muted/60">(lowercase, hyphens only)</span>
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. my-agent"
          className={`w-full px-3 py-2 border rounded-md text-sm font-mono text-text bg-surface ${
            name && !nameValid ? "border-blocked" : "border-border"
          }`}
        />
        {name && !nameValid && (
          <div className="text-[11px] text-blocked mt-1">
            Only lowercase letters, numbers, and hyphens allowed.
          </div>
        )}
      </div>

      <div>
        <label className="text-[11px] uppercase tracking-wider text-muted block mb-1">
          Description
        </label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="One-line description of what this agent does"
          className="w-full px-3 py-2 border border-border rounded-md text-sm text-text bg-surface"
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
        <label htmlFor="isCodeModifying" className="text-sm text-text cursor-pointer">
          Code-modifying agent
        </label>
      </div>

      {createMutation.isError && (
        <div className="text-[12px] text-blocked bg-blocked/10 border border-blocked/30 rounded px-3 py-2">
          {(createMutation.error as Error)?.message ?? "Failed to create agent"}
        </div>
      )}

      <button
        onClick={() => createMutation.mutate()}
        disabled={!name || !nameValid || createMutation.isPending}
        className={`px-4 py-2 text-sm rounded-md transition-colors ${
          name && nameValid
            ? "bg-done text-white hover:bg-done/90"
            : "bg-text/10 text-muted cursor-not-allowed"
        }`}
      >
        {createMutation.isPending ? "creating…" : "create agent"}
      </button>
    </div>
  );
}

function useAvailableModels(): readonly AvailableModel[] {
  // Refresh every 10 minutes so a server-side bump shows up without a
  // manual reload. The server itself polls Anthropic hourly; the UI just
  // mirrors whatever the server has cached.
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
  fieldClass,
}: {
  value: string;
  onChange: (v: string) => void;
  defaultLabel: string;
  dirty: boolean;
  fieldClass: (dirty: boolean) => string;
}) {
  const models = useAvailableModels();
  const knownIds = models.map((m) => m.id);
  const hasUnknown = value !== "" && !knownIds.includes(value);
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`w-full px-3 py-2 border rounded-md text-sm text-text font-mono ${fieldClass(dirty)}`}
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

  // Prompt sections live in <repo>/prompts/<agent>.md as a single file
  // split on [SYSTEM] / [MAIN]. The save endpoint writes both at once;
  // git owns history.
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
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["agents"] });
    },
  });

  const unarchiveMutation = useMutation({
    mutationFn: () => api.agents.unarchive(agentName),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["agents"] });
    },
  });

  const isArchived = agent.archivedAt !== null;

  // Field-level dirty helpers
  const fieldClass = (dirty: boolean) =>
    dirty
      ? "bg-surface border-done/50 ring-1 ring-done/20"
      : "bg-surface border-border";

  return (
    <div className="p-6 space-y-6">
      {/* Header + save */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {(() => {
            const colors = agentColors(agentName);
            const icon = agentIcon(agentName);
            return (
              <span className={`inline-flex items-center justify-center w-10 h-10 rounded-full shrink-0 ${colors.bg} ${colors.text}`}>
                <FontAwesomeIcon icon={icon} className="text-lg" />
              </span>
            );
          })()}
          <div>
            <h2 className={`text-lg font-medium font-mono ${agentColors(agentName).text}`}>{agentName}</h2>
            <div className="text-[11px] text-muted mt-0.5">
              v{agent.version}
              {agent.isCodeModifying ? " · code-modifying" : " · read-only"}
              {isArchived && (
                <span className="ml-2 text-blocked">· archived</span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isArchived ? (
            <button
              onClick={() => unarchiveMutation.mutate()}
              disabled={unarchiveMutation.isPending}
              className="px-3 py-2 text-sm rounded-md bg-done/20 text-done hover:bg-done/30 transition-colors"
            >
              {unarchiveMutation.isPending ? "restoring…" : "unarchive"}
            </button>
          ) : (
            <button
              onClick={() => archiveMutation.mutate()}
              disabled={archiveMutation.isPending}
              className="px-3 py-2 text-sm rounded-md bg-text/10 text-muted hover:bg-blocked/20 hover:text-blocked transition-colors"
            >
              {archiveMutation.isPending ? "archiving…" : "archive"}
            </button>
          )}
          <button
            onClick={() => saveMutation.mutate()}
            disabled={!isDirty || saveMutation.isPending}
            className={`px-4 py-2 text-sm rounded-md transition-colors ${
              isDirty
                ? "bg-done text-white hover:bg-done/90"
                : "bg-text/10 text-muted cursor-not-allowed"
            }`}
          >
            {saveMutation.isPending ? "saving…" : "save"}
          </button>
        </div>
      </div>

      {/* Description */}
      <div>
        <label className="text-[11px] uppercase tracking-wider text-muted block mb-1">
          Description
        </label>
        <input
          type="text"
          value={descDraft}
          onChange={(e) => setDescDraft(e.target.value)}
          className={`w-full px-3 py-2 border rounded-md text-sm text-text ${fieldClass(descDraft !== agent.description)}`}
        />
      </div>

      {/* Model + Fast Model */}
      <div className="flex gap-4">
        <div className="flex-1">
          <label className="text-[11px] uppercase tracking-wider text-muted block mb-1">
            Model
          </label>
          <ModelSelect
            value={modelDraft}
            onChange={setModelDraft}
            defaultLabel="(default)"
            dirty={modelDraft !== (agent.model ?? "")}
            fieldClass={fieldClass}
          />
        </div>
        <div className="flex-1">
          <label className="text-[11px] uppercase tracking-wider text-muted block mb-1">
            Fast Model
          </label>
          <ModelSelect
            value={fastModelDraft}
            onChange={setFastModelDraft}
            defaultLabel="(none)"
            dirty={fastModelDraft !== (agent.fastModel ?? "")}
            fieldClass={fieldClass}
          />
        </div>
      </div>

      {/* Cached System Prompt — backed by [SYSTEM] section of prompts/<agent>.md */}
      <div>
        <label className="text-[11px] uppercase tracking-wider text-muted block mb-1">
          Cached System Prompt
          <span className="ml-2 normal-case tracking-normal text-muted/60">
            ({effectiveSystemDraft.length.toLocaleString()} chars · cached)
          </span>
        </label>
        {!promptData ? (
          <div className="text-muted text-[12px]">loading…</div>
        ) : (
          <textarea
            value={effectiveSystemDraft}
            onChange={(e) => setSystemDraft(e.target.value)}
            placeholder="Agent instructions, directives, static context… Cached by Claude across all stories using this agent."
            className={`w-full min-h-[200px] px-3 py-2 border rounded-md text-[12px] font-mono text-text resize-y leading-relaxed ${fieldClass(effectiveSystemDraft !== fileSystem)}`}
          />
        )}
      </div>

      {/* Uncached Prompt — backed by [MAIN] section of prompts/<agent>.md */}
      <div>
        <label className="text-[11px] uppercase tracking-wider text-muted block mb-1">
          Uncached Prompt
          <span className="ml-2 normal-case tracking-normal">
            ({effectiveMainDraft.length.toLocaleString()} chars)
          </span>
        </label>
        {!promptData ? (
          <div className="text-muted text-[12px]">loading…</div>
        ) : (
          <textarea
            value={effectiveMainDraft}
            onChange={(e) => setMainDraft(e.target.value)}
            placeholder="Story-specific context: {story.title}, {story.spec}, {story.id}…"
            className={`w-full min-h-[300px] px-3 py-2 border rounded-md text-[12px] font-mono text-text resize-y leading-relaxed ${fieldClass(effectiveMainDraft !== fileMain)}`}
          />
        )}
      </div>

      <div className="text-[10px] text-muted/60 font-mono">
        File: prompts/{agentName}.md · saves write the file directly · git owns history
      </div>

      {/* Invocation log */}
      <InvocationLog agentName={agentName} />
    </div>
  );
}

const INVOCATION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes; swap for agent.llmTimeoutMs when that field exists

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
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["agent-invocations", agentName] });
    },
  });

  return (
    <div>
      <label className="text-[11px] uppercase tracking-wider text-muted block mb-2">
        Invocation log ({invocations.length})
      </label>
      {isLoading && (
        <div className="text-muted text-[12px]">loading…</div>
      )}
      {!isLoading && invocations.length === 0 && (
        <div className="text-muted text-sm py-4 border border-dashed border-border rounded-md text-center">
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

  // Actions cluster — stopPropagation so clicks here don't bubble to the
  // collapsed-header button and accidentally toggle expand/collapse.
  const actions = (
    <div
      className="flex items-center gap-1 shrink-0"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Context menu */}
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="w-6 h-6 flex items-center justify-center text-muted hover:text-text rounded hover:bg-text/10 transition-colors text-[15px] leading-none"
          title="Actions"
        >
          ⋮
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-full z-50 mt-1 bg-surface border border-border rounded shadow-lg min-w-[120px] py-1">
            <button
              onClick={() => { onCancel(); setMenuOpen(false); }}
              className="w-full text-left px-3 py-1.5 text-[12px] text-blocked hover:bg-text/5 transition-colors"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
      {/* Tick — collapses the row; only shown when expanded */}
      {expanded && (
        <button
          onClick={onToggle}
          title="Collapse"
          className="w-6 h-6 flex items-center justify-center text-done hover:text-done/70 rounded hover:bg-done/10 transition-colors text-[14px]"
        >
          ✓
        </button>
      )}
    </div>
  );

  const headerInner = (
    <>
      {!expanded && (
        <span className="text-muted text-[10px]">▶</span>
      )}
      <span className="text-[10px] font-mono text-muted/50">{inv.id.slice(0, 8)}</span>
      <span className="text-[11px] text-muted font-mono">
        {ts.toLocaleDateString()} {ts.toLocaleTimeString()}
      </span>
      <a
        href={`/stories/${inv.storyId}`}
        onClick={(e) => e.stopPropagation()}
        className="text-[11px] text-accent hover:underline font-mono"
      >
        {inv.storyId.slice(0, 8)}
      </a>
      {result && (
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${
          result === "pass" || result === "clear" || result === "ok"
            ? "bg-done/20 text-done"
            : result === "fail" || result === "error" || result === "spawn_error"
              ? "bg-blocked/20 text-blocked"
              : "bg-muted/20 text-muted"
        }`}>
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
          <span className="text-[10px] text-muted">{elapsed}s</span>
        )}
        {!hasResponse && !isTimedOut && (
          <span className="text-[10px] text-muted/50 italic">pending…</span>
        )}
        {actions}
      </div>
    </>
  );

  return (
    <div className="border border-border rounded-md overflow-hidden">
      {/* Collapsed: entire header row is the expand trigger.
          Expanded: plain div — only the ✓ tick button collapses. */}
      {expanded ? (
        <div className="px-4 py-2.5 bg-text/5 flex items-center gap-3">
          {headerInner}
        </div>
      ) : (
        <button
          onClick={onToggle}
          className="w-full text-left px-4 py-2.5 bg-text/5 hover:bg-text/10 transition-colors flex items-center gap-3"
        >
          {headerInner}
        </button>
      )}
      {expanded && (
        <div className="border-t border-border flex min-h-[200px]">
          <div className="flex-1 border-r border-border flex flex-col min-w-0">
            <div className="px-3 py-1.5 bg-text/5 text-[10px] uppercase tracking-wider text-muted border-b border-border">
              Request
            </div>
            <div className="flex-1 overflow-auto max-h-[400px]">
              {inv.systemPrompt && (
                <div className="border-b border-border">
                  <div className="px-3 py-1 bg-text/[0.03] text-[10px] uppercase tracking-wider text-muted/70">
                    System prompt
                  </div>
                  <pre className="px-3 py-2 text-[11px] font-mono text-muted whitespace-pre-wrap break-words">
                    {inv.systemPrompt}
                  </pre>
                </div>
              )}
              <div>
                {inv.systemPrompt && (
                  <div className="px-3 py-1 bg-text/[0.03] text-[10px] uppercase tracking-wider text-muted/70">
                    Main prompt
                  </div>
                )}
                <pre className="px-3 py-2 text-[11px] font-mono text-text whitespace-pre-wrap break-words">
                  {inv.prompt}
                </pre>
              </div>
            </div>
          </div>
          <div className="flex-1 flex flex-col min-w-0">
            <div className="px-3 py-1.5 bg-text/5 text-[10px] uppercase tracking-wider text-muted border-b border-border">
              Response
            </div>
            <pre className="flex-1 p-3 text-[11px] font-mono text-text whitespace-pre-wrap break-words overflow-auto max-h-[400px]">
              {inv.response
                ? formatResponse(inv.response)
                : "(awaiting response)"}
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
