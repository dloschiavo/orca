import { useEffect, useState } from "react";
import { api } from "../api.js";
import type { ServerStatus } from "@orca/shared";

type Endpoint = ServerStatus["endpoints"][number];
type Stray = ServerStatus["strayProcesses"][number];

interface Props {
  projectId: string | null;
  endpoints: Endpoint[];
  strayProcesses: Stray[];
  /** Called after any mutation succeeds — parent should invalidate the
   *  server-status query so endpoints + strays refresh. */
  onChange?: () => void;
}

type MenuState =
  | { kind: "endpoint"; port: number; cwd?: string; running: boolean; x: number; y: number }
  | { kind: "strays"; x: number; y: number };

export function ServerEndpointPips({
  projectId,
  endpoints,
  strayProcesses,
  onChange,
}: Props) {
  const [menu, setMenu] = useState<MenuState | null>(null);

  // Close menu on outside click / Escape. Clicks inside the menu stop
  // propagation so the X-buttons can fire without dismissing the menu.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  function refresh(delay = 800) {
    if (!onChange) return;
    setTimeout(onChange, delay);
  }

  async function handleStart() {
    if (!menu || menu.kind !== "endpoint" || !projectId) return;
    const { port, cwd } = menu;
    setMenu(null);
    try {
      await api.projects.start(projectId, { port, cwd });
    } catch (err) {
      console.error("[pips] start failed", err);
    }
    refresh(1500);
  }

  async function handleStop() {
    if (!menu || menu.kind !== "endpoint" || !projectId) return;
    const { port } = menu;
    setMenu(null);
    try {
      await api.projects.stop(projectId, port);
    } catch (err) {
      console.error("[pips] stop failed", err);
    }
    refresh();
  }

  async function handleKillStray(pid: number) {
    if (!projectId) return;
    try {
      await api.projects.killPid(projectId, pid);
    } catch (err) {
      console.error("[pips] killPid failed", err);
    }
    refresh();
  }

  async function handleKillAllStrays() {
    if (!projectId || strayProcesses.length === 0) return;
    setMenu(null);
    // Fire all kills in parallel — the backend validates each PID is owned
    // by this project, so a stale PID just returns 404/403 without harm.
    await Promise.all(
      strayProcesses.map((p) =>
        api.projects.killPid(projectId, p.pid).catch((err) => {
          console.error(`[pips] killPid ${p.pid} failed`, err);
        }),
      ),
    );
    refresh();
  }

  function openEndpointMenu(ev: React.MouseEvent, e: Endpoint, useClientCoords: boolean) {
    ev.preventDefault();
    ev.stopPropagation();
    const pos = useClientCoords
      ? { x: ev.clientX, y: ev.clientY }
      : (() => {
          const r = ev.currentTarget.getBoundingClientRect();
          return { x: r.left, y: r.bottom + 4 };
        })();
    setMenu({ kind: "endpoint", port: e.port, cwd: e.cwd, running: e.running, ...pos });
  }

  function openStraysMenu(ev: React.MouseEvent, useClientCoords: boolean) {
    ev.preventDefault();
    ev.stopPropagation();
    const pos = useClientCoords
      ? { x: ev.clientX, y: ev.clientY }
      : (() => {
          const r = ev.currentTarget.getBoundingClientRect();
          return { x: r.left, y: r.bottom + 4 };
        })();
    setMenu({ kind: "strays", ...pos });
  }

  return (
    <>
      {endpoints.length === 0 && strayProcesses.length === 0 ? (
        <span className="tb-server-empty">no servers detected</span>
      ) : (
        <>
          {endpoints.map((e, i) => (
            <span
              key={`${e.framework}-${e.port}-${i}`}
              className="tb-server-pip"
              title={`${e.framework} :${e.port} — ${e.running ? "up" : "down"} (click for actions)`}
              onClick={(ev) => openEndpointMenu(ev, e, false)}
              onContextMenu={(ev) => openEndpointMenu(ev, e, true)}
            >
              <span
                className="tb-server-dot"
                style={{
                  background: e.running ? "var(--attn-done)" : "var(--attn-error)",
                  animation: e.running ? undefined : "none",
                }}
              />
              <span className="tb-server-label">
                {e.label ? `${e.framework} ${e.label}` : e.framework}
              </span>
              <code className="tb-server-host">:{e.port}</code>
            </span>
          ))}
          {strayProcesses.length > 0 && (
            <span
              className="tb-server-pip tb-server-pip-strays"
              title={`${strayProcesses.length} stray dev process${strayProcesses.length === 1 ? "" : "es"} in this project (click to kill)`}
              onClick={(ev) => openStraysMenu(ev, false)}
              onContextMenu={(ev) => openStraysMenu(ev, true)}
            >
              <span
                className="tb-server-dot"
                style={{ background: "var(--attn-mid)", animation: "none" }}
              />
              <span className="tb-server-label">strays</span>
              <code className="tb-server-host">{strayProcesses.length}</code>
            </span>
          )}
        </>
      )}

      {menu && menu.kind === "endpoint" && (
        <div
          className="tb-server-menu"
          role="menu"
          style={{ position: "fixed", left: menu.x, top: menu.y, zIndex: 1000 }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            disabled={menu.running}
            onClick={handleStart}
          >
            Start
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!menu.running}
            onClick={handleStop}
          >
            Stop
          </button>
        </div>
      )}

      {menu && menu.kind === "strays" && strayProcesses.length > 0 && (
        <div
          className="tb-server-menu"
          role="menu"
          style={{ position: "fixed", left: menu.x, top: menu.y, zIndex: 1000 }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="tb-server-menu-strayhdr">
            <span className="tb-server-menu-heading">
              strays in this project
            </span>
            <button
              type="button"
              className="tb-server-menu-killall"
              onClick={handleKillAllStrays}
            >
              Kill all
            </button>
          </div>
          {strayProcesses.map((p) => (
            <div key={p.pid} className="tb-server-menu-stray">
              <div className="tb-server-menu-stray-meta">
                <code className="tb-server-menu-pid">#{p.pid}</code>
                <span className="tb-server-menu-etime">{p.etime}</span>
                {p.port ? (
                  <code className="tb-server-menu-port">:{p.port}</code>
                ) : null}
              </div>
              <div className="tb-server-menu-stray-cmd" title={p.cmd}>
                {p.cwd ? <span className="tb-server-menu-cwd">{p.cwd}/ </span> : null}
                {prettyCmd(p.cmd)}
              </div>
              <button
                type="button"
                className="tb-server-menu-kill"
                title={`kill pid ${p.pid}`}
                onClick={() => handleKillStray(p.pid)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** Trim a noisy command line down to its meaningful tail. `ps` reports the
 *  full argv, which for Node-launched scripts is often a 200-char absolute
 *  path into node_modules. Keep just the basename of the executable + args. */
function prettyCmd(cmd: string): string {
  // Strip leading absolute paths like "/Users/.../node " or "/usr/local/bin/node "
  const stripped = cmd.replace(/^\/\S+\/(node|npm|pnpm|yarn|tsx|sh|zsh|bash)\b/, "$1");
  // For shell wrappers, just show the tail.
  if (/^(?:sh|zsh|bash)\s+-c\b/.test(stripped)) {
    const m = stripped.match(/['"]([^'"]+)['"]/);
    if (m?.[1]) return m[1];
  }
  return stripped.length > 90 ? stripped.slice(0, 87) + "…" : stripped;
}
