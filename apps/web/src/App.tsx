import { Navigate, Route, Routes } from "react-router-dom";
import { Sidebar } from "./components/Sidebar.js";
import { ErrorToaster } from "./components/ErrorToaster.js";
import { ProjectProvider } from "./state/ProjectContext.js";
import { StoriesPage } from "./pages/StoriesPage.js";
import { StoryDetailPage } from "./pages/StoryDetailPage.js";
import { RefinementQAPage } from "./pages/RefinementQAPage.js";
import { FindingsPage } from "./pages/FindingsPage.js";
import { AuditPage } from "./pages/AuditPage.js";
import { TriggersPage } from "./pages/TriggersPage.js";
import { ProjectsPage } from "./pages/ProjectsPage.js";
import { AddProjectPage } from "./pages/AddProjectPage.js";
import { AgentsPage } from "./pages/AgentsPage.js";
import { RecipesPage } from "./pages/RecipesPage.js";

export function App() {
  return (
    <ProjectProvider>
      <ErrorToaster />
      <div className="flex h-full w-full">
        <Sidebar />
        <main className="flex-1 min-w-0 overflow-auto bg-bg">
          <Routes>
            <Route path="/" element={<Navigate to="/stories" replace />} />
            <Route path="/stories" element={<StoriesPage />} />
            <Route path="/stories/:id" element={<StoryDetailPage />} />
            <Route path="/refinement-qa" element={<RefinementQAPage />} />
            <Route path="/findings" element={<FindingsPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/triggers" element={<TriggersPage />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/projects/add" element={<AddProjectPage />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/recipes" element={<RecipesPage />} />
          </Routes>
        </main>
      </div>
    </ProjectProvider>
  );
}
