import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";
import type { Project } from "@orca/shared";

// Single-user, single-project-at-a-time selection state. The sidebar shows
// which project is active; switching projects re-scopes every list query.

interface ProjectContextValue {
  projects: Project[];
  activeProjectId: string | null;
  setActiveProjectId: (id: string | null) => void;
  activeProject: Project | null;
  isLoading: boolean;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

const STORAGE_KEY = "orca.activeProjectId";

export function ProjectProvider({ children }: { children: ReactNode }) {
  const { data, isLoading } = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.projects.list(),
    refetchInterval: 30_000, // pick up serverConfig backfills from server-status
  });
  const projects = data?.projects ?? [];

  const [activeProjectId, setActiveProjectIdState] = useState<string | null>(
    () => localStorage.getItem(STORAGE_KEY),
  );

  // Auto-select first project if nothing is set once the list loads.
  useEffect(() => {
    if (!activeProjectId && projects.length > 0 && projects[0]) {
      setActiveProjectIdState(projects[0].id);
      localStorage.setItem(STORAGE_KEY, projects[0].id);
    }
  }, [activeProjectId, projects]);

  const setActiveProjectId = (id: string | null) => {
    setActiveProjectIdState(id);
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  };

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );

  const value: ProjectContextValue = {
    projects,
    activeProjectId,
    setActiveProjectId,
    activeProject,
    isLoading,
  };

  return (
    <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
  );
}

export function useProjectContext(): ProjectContextValue {
  const v = useContext(ProjectContext);
  if (!v) throw new Error("useProjectContext outside provider");
  return v;
}
