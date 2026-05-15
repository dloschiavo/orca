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
      <div className="adm-page">
        <div
          className="adm-empty"
          style={{
            margin: "auto", padding: 40, textAlign: "center",
            fontFamily: "var(--mono)",
          }}
        >
          {activeProjectId ? "Loading…" : "No project selected"}
        </div>
      </div>
    );
  }

  return (
    <div className="adm-page">
      <PageHeader
        title={<Breadcrumb first={activeProject.name} second="Project Settings" />}
      />
      <div className="adm-body" style={{ maxWidth: 960 }}>
        <ProjectDetail key={activeProject.id} project={activeProject} onRemoved={() => {}} />
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
  const instructionsChanged =
    instructionsInitialized.current &&
    instructionsDraft !== (riderData?.content ?? "");
  const isDirty = nameChanged || instructionsChanged;

  const saveNameMut = useMutation({
    mutationFn: () =>
      api.projects.patch(project.id, { name: nameDraft.trim() || project.name }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["projects"] }); },
  });

  const saveRiderMut = useMutation({
    mutationFn: () => api.projects.saveRider(project.id, instructionsDraft),
    onSuccess: () => { void refetchRider(); },
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
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["server-status"] }); },
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
    <>
      <section>
        <div className="adm-section">
          <span>Identity</span>
          <span className="adm-section-rule" />
          <button
            onClick={handleSave}
            disabled={!isDirty || isSaving}
            className="btn btn-sm btn-primary"
          >
            {isSaving ? "Saving…" : "Save"}
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label className="adm-label">Name</label>
            <input
              type="text"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              className={"input" + (nameChanged ? " adm-dirty" : "")}
            />
          </div>

          <div>
            <label className="adm-label">Repo path</label>
            <div className="adm-value">{project.repoPath}</div>
          </div>
        </div>
      </section>

      <section>
        <div className="adm-section">
          <span>Instructions</span>
          <span className="adm-label-aux" style={{ marginLeft: 0 }}>
            {"{project.instructions}"}
          </span>
          <span className="adm-section-rule" />
        </div>
        <p className="adm-section-hint">
          File: <code style={{ fontFamily: "var(--mono)" }}>{riderPath}</code>
        </p>
        {riderData === undefined ? (
          <div className="adm-empty" style={{ fontFamily: "var(--mono)" }}>loading…</div>
        ) : (
          <textarea
            value={instructionsDraft}
            onChange={(e) => setInstructionsDraft(e.target.value)}
            rows={16}
            className={"adm-textarea" + (instructionsChanged ? " adm-dirty" : "")}
          />
        )}
      </section>

      <section>
        <div className="adm-section">
          <span>File tree</span>
          <span className="adm-label-aux" style={{ marginLeft: 0 }}>
            {"{project.file_tree}"}
          </span>
          <span className="adm-section-rule" />
        </div>
        <p className="adm-section-hint">
          Auto-generated by <code style={{ fontFamily: "var(--mono)" }}>find . -maxdepth 3</code> at
          triage time (first 200 entries, excludes node_modules / .git / dist). Not editable.
        </p>
      </section>

      <section>
        <div className="adm-section">
          <span>Server endpoints</span>
          <span className="adm-section-rule" />
          <button
            className="btn btn-sm"
            onClick={() => detectMut.mutate()}
            disabled={detectMut.isPending}
          >
            {detectMut.isPending ? "Detecting…" : "Detect"}
          </button>
        </div>

        {!project.serverConfig?.endpoints?.length ? (
          <div
            className="adm-empty"
            style={{
              padding: 14, textAlign: "center", fontFamily: "var(--mono)",
              border: "1px dashed var(--border-1)", borderRadius: "var(--r-md)",
            }}
          >
            No endpoints configured. Click Detect to auto-discover.
          </div>
        ) : (
          <div className="adm-rows">
            {(status?.endpoints ?? project.serverConfig.endpoints).map((ep) => {
              const running = "running" in ep ? ep.running : false;
              return (
                <div key={`${ep.kind}-${ep.port}`} className="adm-row">
                  <span
                    style={{
                      width: 7, height: 7, borderRadius: "50%",
                      background: running ? "var(--attn-mid)" : "var(--attn-error)",
                      flexShrink: 0,
                      animation: running ? "dot-blink 2.4s ease-in-out infinite" : "none",
                    }}
                  />
                  <div className="adm-row-label">
                    <span
                      style={{
                        fontFamily: "var(--mono)", fontSize: 12,
                        color: "var(--fg-0)",
                      }}
                    >
                      {ep.label ?? ep.kind} · {ep.framework}:{ep.port}
                    </span>
                  </div>
                  <div className="adm-row-aux">
                    {!running && (
                      <button
                        className="btn btn-sm"
                        onClick={() => startMut.mutate(ep.kind)}
                        disabled={startMut.isPending}
                      >
                        Start
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <div className="adm-section">
          <span>Danger zone</span>
          <span className="adm-section-rule" />
        </div>
        <button
          className="btn btn-sm btn-danger"
          disabled={removeMut.isPending}
          onClick={() => {
            if (confirm(`Remove "${project.name}" from orca? (No files will be deleted.)`))
              removeMut.mutate();
          }}
        >
          {removeMut.isPending ? "Removing…" : "Remove project"}
        </button>
      </section>
    </>
  );
}
