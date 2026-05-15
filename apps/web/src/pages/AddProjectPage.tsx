import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageHeader } from "../components/PageHeader.js";
import { Breadcrumb } from "../components/Breadcrumb.js";
import { useProjectContext } from "../state/ProjectContext.js";

export function AddProjectPage() {
  const { setActiveProjectId } = useProjectContext();
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState("");
  const [newRepoPath, setNewRepoPath] = useState("");

  const createMut = useMutation({
    mutationFn: (body: { name: string; repoPath: string }) =>
      api.projects.create(body),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({ queryKey: ["unattached-dirs"] });
      setNewName("");
      setNewRepoPath("");
      setActiveProjectId(res.project.id);
    },
  });

  const [companyRootInput, setCompanyRootInput] = useState("");
  const [companyRootDirty, setCompanyRootDirty] = useState(false);

  const unattachedQ = useQuery({
    queryKey: ["unattached-dirs"],
    queryFn: () => api.projects.unattachedDirs(),
  });

  useEffect(() => {
    if (unattachedQ.data?.companyRoot && !companyRootDirty) {
      setCompanyRootInput(unattachedQ.data.companyRoot);
    }
  }, [unattachedQ.data?.companyRoot, companyRootDirty]);

  const setCompanyRootMut = useMutation({
    mutationFn: (path: string) => api.projects.setCompanyRoot(path),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["unattached-dirs"] });
      setCompanyRootDirty(false);
    },
  });

  const promoteMut = useMutation({
    mutationFn: (dirName: string) => {
      const root = unattachedQ.data?.companyRoot;
      if (!root) throw new Error("no company root configured");
      return api.projects.create({
        name: dirName,
        repoPath: `${root.replace(/\/+$/, "")}/${dirName}`,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({ queryKey: ["unattached-dirs"] });
    },
  });

  function saveCompanyRoot() {
    const trimmed = companyRootInput.trim();
    if (trimmed) setCompanyRootMut.mutate(trimmed);
  }

  return (
    <div className="adm-page">
      <PageHeader title={<Breadcrumb first="Orca" second="Add Project" />} />

      <div className="adm-body adm-body-narrow">
        <section>
          <div className="adm-section">
            <span>New project</span>
            <span className="adm-section-rule" />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <label className="adm-label">Name</label>
              <input
                className="input"
                placeholder="my-project"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                autoFocus
              />
            </div>
            <div>
              <label className="adm-label">Repo path</label>
              <input
                className="input"
                style={{ fontFamily: "var(--mono)" }}
                placeholder="/absolute/path/to/repo"
                value={newRepoPath}
                onChange={(e) => setNewRepoPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newName && newRepoPath)
                    createMut.mutate({ name: newName, repoPath: newRepoPath });
                }}
              />
            </div>
            <div>
              <button
                className="btn btn-sm btn-primary"
                disabled={!newName || !newRepoPath || createMut.isPending}
                onClick={() => createMut.mutate({ name: newName, repoPath: newRepoPath })}
              >
                {createMut.isPending ? "Creating…" : "Create"}
              </button>
            </div>
          </div>
        </section>

        <section>
          <div className="adm-section">
            <span>Unattached directories</span>
            <span className="adm-section-rule" />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div>
              <label className="adm-label">Company root</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  className="input"
                  style={{ flex: 1, fontFamily: "var(--mono)" }}
                  placeholder="/path/to/company"
                  value={companyRootInput}
                  onChange={(e) => {
                    setCompanyRootInput(e.target.value);
                    setCompanyRootDirty(true);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveCompanyRoot();
                  }}
                />
                <button
                  className="btn btn-sm btn-primary"
                  disabled={
                    !companyRootInput.trim() ||
                    setCompanyRootMut.isPending ||
                    companyRootInput.trim() === (unattachedQ.data?.companyRoot ?? "")
                  }
                  onClick={saveCompanyRoot}
                >
                  {setCompanyRootMut.isPending ? "…" : "Set"}
                </button>
              </div>
            </div>

            {!unattachedQ.data?.companyRoot ? (
              <p className="adm-section-hint">
                Set the company root to see unattached directories.
              </p>
            ) : unattachedQ.data.dirs.length === 0 ? (
              <p className="adm-section-hint">All directories are attached.</p>
            ) : (
              <div className="adm-rows">
                {unattachedQ.data.dirs.map((dir) => (
                  <div key={dir} className="adm-row">
                    <span
                      className="adm-row-label"
                      style={{
                        fontFamily: "var(--mono)", fontSize: 12,
                        color: "var(--fg-1)", overflow: "hidden",
                        textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}
                    >
                      {dir}
                    </span>
                    <div className="adm-row-aux">
                      <button
                        className="btn btn-sm btn-primary"
                        disabled={promoteMut.isPending}
                        onClick={() => promoteMut.mutate(dir)}
                      >
                        Add
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
