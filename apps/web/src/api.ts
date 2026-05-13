// Thin, typed client over the Hono backend. All endpoints are relative to /api
// so the Vite dev proxy handles the cross-origin hop.

import type {
  Agent,
  AuditRow,
  AvailableModel,
  Classification,
  Finding,
  FindingStatus,
  Project,
  RefinementQuestion,
  ServerConfig,
  ServerStatus,
  Story,
  StoryStatus,
} from "@orca/shared";

// The /findings list endpoint enriches each Finding with its latest
// classifier proposal, so the FindingsPage can render the "what we did"
// column without an extra round-trip per row.
export type EnrichedFinding = Finding & {
  latestClassification: Classification | null;
};

export interface ActivityEvent {
  id: string;
  storyId: string;
  kind: string;
  actor: string;
  payload: Record<string, unknown>;
  createdAt: string;
  dispatchInstanceId?: string | null;
}

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const r = await fetch(`/api${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`${r.status} ${r.statusText}: ${body}`);
  }
  return (await r.json()) as T;
}

// --- projects ---
export const api = {
  projects: {
    list: () => request<{ projects: Project[] }>("/projects"),
    get: (id: string) => request<{ project: Project }>(`/projects/${id}`),
    create: (body: { name: string; repoPath: string; riderPath?: string }) =>
      request<{ project: Project; auditRowsSeeded: number }>("/projects", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    patch: (id: string, body: { name?: string; repoPath?: string; riderPath?: string | null; context?: string | null }) =>
      request<{ project: Project }>(`/projects/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    remove: (id: string) =>
      request<{ ok: true }>(`/projects/${id}`, { method: "DELETE" }),
    unattachedDirs: () =>
      request<{ dirs: string[]; companyRoot: string | null }>(
        "/projects/unattached-dirs/list",
      ),
    setCompanyRoot: (path: string) =>
      request<{ ok: true; companyRoot: string }>("/projects/company-root", {
        method: "PUT",
        body: JSON.stringify({ path }),
      }),
    getRiderPreview: (id: string) =>
      request<{ content: string | null; path: string }>(
        `/projects/${id}/rider-preview`,
      ),
    saveRider: (id: string, content: string) =>
      request<{ ok: boolean; path: string }>(`/projects/${id}/rider`, {
        method: "PUT",
        body: JSON.stringify({ content }),
      }),
    detectServerConfig: (id: string) =>
      request<{ serverConfig: ServerConfig }>(
        `/projects/${id}/detect-server-config`,
        { method: "POST" },
      ),
    serverStatus: () =>
      request<{ statuses: ServerStatus[] }>("/projects/server-status"),
    start: (id: string, kind?: "frontend" | "backend") =>
      request<{ ok: true; launched: string[] }>(`/projects/${id}/start`, {
        method: "POST",
        body: JSON.stringify(kind ? { kind } : {}),
      }),
  },

  // --- stories ---
  stories: {
    list: (params: { projectId?: string; status?: StoryStatus } = {}) => {
      const qs = new URLSearchParams();
      if (params.projectId) qs.set("projectId", params.projectId);
      if (params.status) qs.set("status", params.status);
      const q = qs.toString();
      return request<{ stories: Story[] }>(
        `/stories${q ? `?${q}` : ""}`,
      );
    },
    counts: () =>
      request<{
        counts: { projectId: string; status: string; count: number }[];
      }>("/stories/counts"),
    get: (id: string) =>
      request<{
        story: Story;
        // backend returns richer detail, but we type only what the UI needs
        acceptanceCard: unknown | null;
        refinementQuestions: RefinementQuestion[];
        workingMemory: unknown | null;
        activity: ActivityEvent[];
      }>(`/stories/${id}`),
    create: (body: {
      projectId: string;
      title: string;
      specMd?: string;
      status?: "icebox" | "planning" | "backlog";
      agent?: string;
      parentStoryId?: string | null;
      labels?: string[];
      priority?: number;
    }) =>
      request<{ story: Story }>("/stories", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    patch: (id: string, body: Partial<Story>) =>
      request<{ story: Story }>(`/stories/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    dispatch: (id: string) =>
      request<{ ok: true }>(`/stories/${id}/dispatch`, {
        method: "POST",
      }),
    stop: (id: string) =>
      request<{ ok: true }>(`/stories/${id}/stop`, {
        method: "POST",
      }),
    comment: (id: string, body: { body: string; interrupt?: boolean; actor?: string }) =>
      request<{ ok: true }>(`/stories/${id}/comment`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    remove: (id: string) =>
      request<{ ok: true }>(`/stories/${id}`, { method: "DELETE" }),
  },

  // --- audit ---
  audit: {
    list: (params: { projectId?: string } = {}) => {
      const qs = new URLSearchParams();
      if (params.projectId) qs.set("projectId", params.projectId);
      const q = qs.toString();
      return request<{ rows: AuditRow[] }>(`/audit${q ? `?${q}` : ""}`);
    },
    patch: (id: string, body: Partial<AuditRow>) =>
      request<{ row: AuditRow }>(`/audit/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    resync: (projectId: string) =>
      request<{
        inserted: number;
        markedStale: number;
        totalScanned: number;
      }>("/audit/resync", {
        method: "POST",
        body: JSON.stringify({ projectId }),
      }),
    verify: (id: string) =>
      request<{ ok: true; message: string }>(`/audit/${id}/verify`, {
        method: "POST",
      }),
  },

  // --- refinement Q&A ---
  refinementQuestions: {
    list: (params: { projectId?: string; includeAnswered?: boolean } = {}) => {
      const qs = new URLSearchParams();
      if (params.projectId) qs.set("projectId", params.projectId);
      if (params.includeAnswered) qs.set("includeAnswered", "1");
      const q = qs.toString();
      return request<{
        questions: {
          q: RefinementQuestion;
          storyTitle: string;
          storyStatus: StoryStatus;
          storyProjectId: string;
        }[];
      }>(`/refinement-questions${q ? `?${q}` : ""}`);
    },
    answer: (id: string, answer: string) =>
      request<{ question: RefinementQuestion }>(
        `/refinement-questions/${id}/answer`,
        {
          method: "POST",
          body: JSON.stringify({ answer }),
        },
      ),
    skip: (id: string) =>
      request<{ question: RefinementQuestion }>(
        `/refinement-questions/${id}/skip`,
        {
          method: "POST",
        },
      ),
  },

  // --- findings ---
  findings: {
    list: (params: { storyId?: string; status?: FindingStatus } = {}) => {
      const qs = new URLSearchParams();
      if (params.storyId) qs.set("storyId", params.storyId);
      if (params.status) qs.set("status", params.status);
      const q = qs.toString();
      return request<{ findings: EnrichedFinding[] }>(
        `/findings${q ? `?${q}` : ""}`,
      );
    },
    create: (body: {
      storyId: string;
      source: string;
      body: string;
      citation?: { file: string; line: number | null } | null;
      rootCause?: string;
    }) =>
      request<{ finding: Finding }>("/findings", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    dismiss: (id: string) =>
      request<{ finding: Finding }>(`/findings/${id}/dismiss`, {
        method: "POST",
      }),
  },

  // --- settings ---
  settings: {
    get: () =>
      request<{
        throttle: {
          maxConcurrentPerProject: number;
          maxConcurrentTotal: number;
          maxConcurrentQa: number;
          maxConcurrentSpecWriter: number;
        };
      }>("/settings"),
    patch: (body: {
      throttle?: {
        maxConcurrentPerProject?: number;
        maxConcurrentTotal?: number;
        maxConcurrentQa?: number;
        maxConcurrentSpecWriter?: number;
      };
    }) =>
      request<{
        throttle: {
          maxConcurrentPerProject: number;
          maxConcurrentTotal: number;
          maxConcurrentQa: number;
          maxConcurrentSpecWriter: number;
        };
      }>("/settings", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
  },

  // --- usage ---
  usage: {
    get: () =>
      request<{
        usage: { fraction: number; updatedAt: string } | null;
      }>("/rate-limit-usage"),
  },

  // --- agents ---
  agents: {
    list: (includeArchived = false) =>
      request<{ agents: Agent[] }>(`/agents${includeArchived ? "?includeArchived=true" : ""}`),
    create: (body: { name: string; description?: string; isCodeModifying?: boolean }) =>
      request<{ agent: Agent }>("/agents", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    patch: (name: string, body: { model?: string | null; fastModel?: string | null; description?: string; agentsMd?: string }) =>
      request<{ agent: Agent }>(`/agents/${name}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    archive: (name: string) =>
      request<{ agent: Agent }>(`/agents/${name}/archive`, { method: "POST" }),
    unarchive: (name: string) =>
      request<{ agent: Agent }>(`/agents/${name}/unarchive`, { method: "POST" }),
    getPrompt: (name: string) =>
      request<{ system: string | null; main: string | null; exists: boolean }>(
        `/agents/${name}/prompt`,
      ),
    savePrompt: (name: string, body: { system: string; main: string }) =>
      request<{ system: string; main: string; exists: boolean }>(
        `/agents/${name}/prompt`,
        { method: "PUT", body: JSON.stringify(body) },
      ),
    listInvocations: (name: string, limit = 50) =>
      request<{ invocations: AgentInvocation[] }>(`/agents/${name}/invocations?limit=${limit}`),
  },

  // --- models ---
  models: {
    list: () =>
      request<{
        models: AvailableModel[];
        status: {
          count: number;
          lastFetchedAt: string | null;
          lastError: string | null;
        };
      }>("/models"),
  },
};

export interface AgentInvocation {
  id: string;
  storyId: string;
  agent: string;
  promptAt: string;
  prompt: string;
  systemPrompt: string | null;
  responseAt: string | null;
  response: Record<string, unknown> | null;
}
