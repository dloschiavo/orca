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

  // Unattached directories
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
      return api.projects.create({ name: dirName, repoPath: `${root.replace(/\/+$/, "")}/${dirName}` });
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
    <div className="h-full flex flex-col">
      <PageHeader title={<Breadcrumb first="Orca" second="Add Project" />} />

      <div className="flex-1 overflow-y-auto p-6 space-y-8 max-w-xl">
        {/* New project form */}
        <div className="space-y-3">
          <h2 className="text-[11px] uppercase tracking-wider text-muted">New project</h2>
          <div>
            <label className="text-[11px] uppercase tracking-wider text-muted block mb-1">Name</label>
            <input
              className="input w-full"
              placeholder="my-project"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wider text-muted block mb-1">Repo path</label>
            <input
              className="input w-full font-mono text-sm"
              placeholder="/absolute/path/to/repo"
              value={newRepoPath}
              onChange={(e) => setNewRepoPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newName && newRepoPath)
                  createMut.mutate({ name: newName, repoPath: newRepoPath });
              }}
            />
          </div>
          <button
            className="btn btn-primary"
            disabled={!newName || !newRepoPath || createMut.isPending}
            onClick={() => createMut.mutate({ name: newName, repoPath: newRepoPath })}
          >
            {createMut.isPending ? "Creating…" : "Create"}
          </button>
        </div>

        {/* Unattached directories */}
        <div className="space-y-3 border-t border-border pt-6">
          <h2 className="text-[11px] uppercase tracking-wider text-muted">Unattached directories</h2>
          <div className="flex items-center gap-2">
            <input
              className="input flex-1 text-xs"
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
              className="btn btn-sm btn-primary text-xs shrink-0"
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
          {!unattachedQ.data?.companyRoot ? (
            <p className="text-[11px] text-muted">
              Set the company root to see unattached directories.
            </p>
          ) : unattachedQ.data.dirs.length === 0 ? (
            <p className="text-[11px] text-muted">All directories are attached.</p>
          ) : (
            <ul className="space-y-1">
              {unattachedQ.data.dirs.map((dir) => (
                <li key={dir} className="flex items-center gap-2">
                  <span className="flex-1 text-[11px] text-text truncate">{dir}</span>
                  <button
                    className="btn btn-sm btn-primary text-[10px] shrink-0"
                    disabled={promoteMut.isPending}
                    onClick={() => promoteMut.mutate(dir)}
                  >
                    Add
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
