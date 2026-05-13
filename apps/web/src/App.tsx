import { useState, useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Topbar } from "./components/Topbar.js";
import { Sidebar } from "./components/Sidebar.js";
import { ErrorToaster } from "./components/ErrorToaster.js";
import { ClaudeAuthGate } from "./components/ClaudeAuthGate.js";
import { ProjectProvider } from "./state/ProjectContext.js";
import { StoriesWorkspacePage } from "./pages/StoriesWorkspacePage.js";
import { RefinementQAPage } from "./pages/RefinementQAPage.js";
import { FindingsPage } from "./pages/FindingsPage.js";
import { TriggersPage } from "./pages/TriggersPage.js";
import { ProjectsPage } from "./pages/ProjectsPage.js";
import { AddProjectPage } from "./pages/AddProjectPage.js";
import { AgentsPage } from "./pages/AgentsPage.js";
import { RecipesPage } from "./pages/RecipesPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { api } from "./api.js";

function AppShell() {
  const [nextTickIn, setNextTickIn] = useState(30);
  const CADENCE_SEC = 30;

  useEffect(() => {
    setNextTickIn(CADENCE_SEC);
    const id = setInterval(() => {
      setNextTickIn((prev) => (prev <= 1 ? CADENCE_SEC : prev - 1));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Global story counts for topbar counters
  const { data: storyCounts } = useQuery({
    queryKey: ["story-counts"],
    queryFn: () => api.stories.counts(),
    refetchInterval: 5_000,
  });

  const allCounts = storyCounts?.counts ?? [];
  const activeCount = allCounts
    .filter((c) => c.status === "implementing")
    .reduce((sum, c) => sum + c.count, 0);
  const queueDepth = allCounts
    .filter((c) => !["done", "canceled"].includes(c.status))
    .reduce((sum, c) => sum + c.count, 0);
  const shippedToday = allCounts
    .filter((c) => c.status === "done")
    .reduce((sum, c) => sum + c.count, 0);

  return (
    <div className="app">
      <Topbar
        activeCount={activeCount}
        queueDepth={queueDepth}
        nextTickIn={nextTickIn}
        shippedToday={shippedToday}
      />
      <Sidebar />
      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/stories" replace />} />
          <Route path="/stories" element={<StoriesWorkspacePage />} />
          <Route path="/stories/:id" element={<StoriesWorkspacePage />} />
          <Route path="/refinement-qa" element={<ScrollPage><RefinementQAPage /></ScrollPage>} />
          <Route path="/findings" element={<ScrollPage><FindingsPage /></ScrollPage>} />
          <Route path="/triggers" element={<ScrollPage><TriggersPage /></ScrollPage>} />
          <Route path="/projects" element={<ScrollPage><ProjectsPage /></ScrollPage>} />
          <Route path="/projects/add" element={<ScrollPage><AddProjectPage /></ScrollPage>} />
          <Route path="/agents" element={<ScrollPage><AgentsPage /></ScrollPage>} />
          <Route path="/recipes" element={<ScrollPage><RecipesPage /></ScrollPage>} />
          <Route path="/settings" element={<ScrollPage><SettingsPage /></ScrollPage>} />
        </Routes>
      </main>
    </div>
  );
}

function ScrollPage({ children }: { children: React.ReactNode }) {
  return <div className="main-scroll">{children}</div>;
}

export function App() {
  return (
    <ProjectProvider>
      <ClaudeAuthGate>
        <ErrorToaster />
        <AppShell />
      </ClaudeAuthGate>
    </ProjectProvider>
  );
}
