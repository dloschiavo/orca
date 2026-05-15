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

export interface StrayProcess {
  pid: number;
  /** Full command line as reported by `ps -o command=`. */
  cmd: string;
  /** Elapsed wall-clock time as `ps -o etime=` reports it (e.g. "01:23:45"). */
  etime: string;
  /** Effective working directory, relative to the project's repoPath. */
  cwd: string;
  /** If this process is also listening on a TCP port, that port. */
  port?: number;
}

export interface ServerStatus {
  projectId: string;
  endpoints: Array<ServerEndpoint & { running: boolean }>;
  /** Dev-server-ish processes rooted inside this project's repoPath that
   *  aren't represented by an endpoint pip — e.g. orphaned npm/concurrently
   *  wrappers left behind after a prior session was killed messily. */
  strayProcesses: StrayProcess[];
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
