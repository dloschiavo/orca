import { useState, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageHeader } from "../components/PageHeader.js";
import { Breadcrumb } from "../components/Breadcrumb.js";
import { useProjectContext } from "../state/ProjectContext.js";
import type { Project, ServerStatus } from "@orca/shared";

export function ProjectsPage() {
  const { activeProjectId, activeProject } = useProjectContext();

  if (!activeProject) {
    return (
      <div className="h-full flex items-center justify-center text-muted text-sm">
        {activeProjectId ? "Loading…" : "No project selected"}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <PageHeader
        title={<Breadcrumb first={activeProject.name} second="Project Settings" />}
      />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <ProjectDetail
          key={activeProject.id}
          project={activeProject}
          onRemoved={() => {}}
        />
      </div>
    </div>
  );
}

function ProjectDetail({
  project,
  onRemoved,
}: {
  project: Project;
  onRemoved: () => void;
}) {
  const qc = useQueryClient();

  const [nameDraft, setNameDraft] = useState(project.name);
  const [instructionsDraft, setInstructionsDraft] = useState<string>("");
  const instructionsInitialized = useRef(false);

  // Rider file — load once, then track edits locally
  const { data: riderData, refetch: refetchRider } = useQuery({
    queryKey: ["project-rider", project.id],
    queryFn: () => api.projects.getRiderPreview(project.id),
  });

  useEffect(() => {
    if (riderData !== undefined && !instructionsInitialized.current) {
      setInstructionsDraft(riderData.content ?? "");
      instructionsInitialized.current = true;
    }
  }, [riderData]);

  const riderPath = riderData?.path ?? `${project.repoPath}/CLAUDE.md`;
  const nameChanged = nameDraft !== project.name;
  const instructionsChanged = instructionsInitialized.current &&
    instructionsDraft !== (riderData?.content ?? "");
  const isDirty = nameChanged || instructionsChanged;

  const fieldClass = (dirty: boolean) =>
    dirty
      ? "bg-surface border-done/50 ring-1 ring-done/20"
      : "bg-surface border-border";

  const saveNameMut = useMutation({
    mutationFn: () =>
      api.projects.patch(project.id, { name: nameDraft.trim() || project.name }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  const saveRiderMut = useMutation({
    mutationFn: () => api.projects.saveRider(project.id, instructionsDraft),
    onSuccess: () => {
      void refetchRider();
    },
  });

  async function handleSave() {
    const tasks: Promise<unknown>[] = [];
    if (nameChanged) tasks.push(saveNameMut.mutateAsync());
    if (instructionsChanged) tasks.push(saveRiderMut.mutateAsync());
    await Promise.all(tasks);
  }

  const isSaving = saveNameMut.isPending || saveRiderMut.isPending;

  const detectMut = useMutation({
    mutationFn: () => api.projects.detectServerConfig(project.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["projects"] });
      void qc.invalidateQueries({ queryKey: ["server-status"] });
    },
  });

  const { data: statusData } = useQuery({
    queryKey: ["server-status"],
    queryFn: () => api.projects.serverStatus(),
    refetchInterval: 10_000,
  });
  const statusMap = new Map<string, ServerStatus>(
    (statusData?.statuses ?? []).map((s) => [s.projectId, s]),
  );
  const status = statusMap.get(project.id);

  const startMut = useMutation({
    mutationFn: (kind?: "frontend" | "backend") =>
      api.projects.start(project.id, kind),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["server-status"] });
    },
  });

  const removeMut = useMutation({
    mutationFn: () => api.projects.remove(project.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["projects"] });
      void qc.invalidateQueries({ queryKey: ["unattached-dirs"] });
      onRemoved();
    },
  });

  return (
    <div className="p-6 space-y-6 max-w-[1000px]">
      {/* Header: name + save */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <label className="text-[11px] uppercase tracking-wider text-muted block mb-1">
            Name
          </label>
          <input
            type="text"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            className={`w-full px-3 py-2 border rounded-md text-sm text-text ${fieldClass(nameDraft !== project.name)}`}
          />
        </div>
        <div className="pt-5">
          <button
            onClick={handleSave}
            disabled={!isDirty || isSaving}
            className={`px-4 py-2 text-sm rounded-md transition-colors ${
              isDirty
                ? "bg-done text-white hover:bg-done/90"
                : "bg-text/10 text-muted cursor-not-allowed"
            }`}
          >
            {isSaving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {/* Repo path (read-only) */}
      <div>
        <label className="text-[11px] uppercase tracking-wider text-muted block mb-1">
          Repo path
        </label>
        <div className="px-3 py-2 bg-surface border border-border rounded-md text-sm font-mono text-muted">
          {project.repoPath}
        </div>
      </div>

      {/* Instructions — editable rider file */}
      <div>
        <label className="text-[11px] uppercase tracking-wider text-muted block mb-1">
          Instructions
          <span className="ml-2 normal-case tracking-normal font-mono text-muted/60">
            {"{project.instructions}"}
          </span>
        </label>
        <p className="text-[11px] text-muted mb-2">
          File: <code className="font-mono">{riderPath}</code>
        </p>
        {riderData === undefined ? (
          <div className="text-muted text-[12px]">loading…</div>
        ) : (
          <textarea
            value={instructionsDraft}
            onChange={(e) => setInstructionsDraft(e.target.value)}
            rows={16}
            className={`w-full px-3 py-2 border rounded-md text-[12px] font-mono text-text resize-y leading-relaxed ${fieldClass(instructionsChanged)}`}
          />
        )}
      </div>

      {/* File tree note */}
      <div>
        <label className="text-[11px] uppercase tracking-wider text-muted block mb-1">
          File tree
          <span className="ml-2 normal-case tracking-normal font-mono text-muted/60">
            {"{project.file_tree}"}
          </span>
        </label>
        <p className="text-[11px] text-muted">
          Auto-generated by <code className="font-mono">find . -maxdepth 3</code> at triage time
          (first 200 entries, excludes node_modules/.git/dist). Not editable.
        </p>
      </div>

      {/* Server endpoints */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-[11px] uppercase tracking-wider text-muted">
            Server endpoints
          </label>
          <button
            className="btn btn-sm text-xs"
            onClick={() => detectMut.mutate()}
            disabled={detectMut.isPending}
          >
            {detectMut.isPending ? "Detecting…" : "Detect"}
          </button>
        </div>
        {!project.serverConfig?.endpoints?.length ? (
          <div className="px-3 py-3 bg-surface border border-dashed border-border rounded-md text-[12px] text-muted text-center">
            No endpoints configured. Click Detect to auto-discover.
          </div>
        ) : (
          <div className="space-y-1.5">
            {(status?.endpoints ?? project.serverConfig.endpoints).map((ep) => {
              const running = "running" in ep ? ep.running : false;
              return (
                <div
                  key={`${ep.kind}-${ep.port}`}
                  className="flex items-center gap-3 px-3 py-2 bg-surface border border-border rounded-md"
                >
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${running ? "bg-done" : "bg-red-500"}`}
                  />
                  <span className="text-sm text-text font-mono flex-1">
                    {ep.label ?? ep.kind} · {ep.framework}:{ep.port}
                  </span>
                  {!running && (
                    <button
                      className="btn btn-sm text-[10px]"
                      onClick={() => startMut.mutate(ep.kind)}
                      disabled={startMut.isPending}
                    >
                      Start
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Danger zone */}
      <div className="border-t border-border pt-6">
        <label className="text-[11px] uppercase tracking-wider text-muted block mb-2">
          Danger zone
        </label>
        <button
          className="px-3 py-1.5 text-sm text-red-400 border border-red-400/30 rounded-md hover:bg-red-400/10 transition-colors"
          disabled={removeMut.isPending}
          onClick={() => {
            if (confirm(`Remove "${project.name}" from orca? (No files will be deleted.)`))
              removeMut.mutate();
          }}
        >
          {removeMut.isPending ? "Removing…" : "Remove project"}
        </button>
      </div>
    </div>
  );
}
