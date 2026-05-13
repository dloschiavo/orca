import { Navigate, Route, Routes } from "react-router-dom";
import { Sidebar } from "./components/Sidebar.js";
import { ErrorToaster } from "./components/ErrorToaster.js";
import { ProjectProvider } from "./state/ProjectContext.js";
import { StoriesWorkspacePage } from "./pages/StoriesWorkspacePage.js";
import { RefinementQAPage } from "./pages/RefinementQAPage.js";
import { FindingsPage } from "./pages/FindingsPage.js";
import { AuditPage } from "./pages/AuditPage.js";
import { TriggersPage } from "./pages/TriggersPage.js";
import { ProjectsPage } from "./pages/ProjectsPage.js";
import { AddProjectPage } from "./pages/AddProjectPage.js";
import { AgentsPage } from "./pages/AgentsPage.js";
import { RecipesPage } from "./pages/RecipesPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";

export function App() {
  return (
    <ProjectProvider>
      <ErrorToaster />
      <div className="flex h-full w-full">
        <Sidebar />
        <main className="flex-1 min-w-0 overflow-auto bg-bg">
          <Routes>
            <Route path="/" element={<Navigate to="/stories" replace />} />
            <Route path="/stories" element={<StoriesWorkspacePage />} />
            <Route path="/stories/:id" element={<StoriesWorkspacePage />} />
            <Route path="/refinement-qa" element={<RefinementQAPage />} />
            <Route path="/findings" element={<FindingsPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/triggers" element={<TriggersPage />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/projects/add" element={<AddProjectPage />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/recipes" element={<RecipesPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
      </div>
    </ProjectProvider>
  );
}
