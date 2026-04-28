export interface ServerEndpoint {
  kind: "frontend" | "backend";
  framework: string; // e.g. "next", "expo", "vite", "express", "fastapi", "tauri"
  port: number;
  label?: string;
  /** Shell command to start this endpoint (e.g. "pnpm dev:web") */
  startCommand?: string;
  /** Working directory for startCommand, relative to project repoPath */
  cwd?: string;
}

export interface ServerConfig {
  endpoints: ServerEndpoint[];
}

export interface ServerStatus {
  projectId: string;
  endpoints: Array<ServerEndpoint & { running: boolean }>;
}

export interface Project {
  id: string;
  name: string;
  repoPath: string;
  riderPath: string | null;
  context: string | null;
  capabilities: string[];
  heartbeatDefaultIntervalMs: number;
  serverConfig: ServerConfig | null;
  createdAt: string;
  updatedAt: string;
}
