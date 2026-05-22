import { useEffect, useRef, useState } from "react";
import { clearDraft, loadDraft, saveDraft } from "../utils/draftStorage.js";

interface NewStoryModalProps {
  onClose: () => void;
  onSubmit: (body: { title: string; specMd: string; status: "icebox" | "planning" | "backlog"; agent: string }) => void;
  submitting: boolean;
  agents: { name: string }[];
  projectId: string;
}

type DraftStatus = "icebox" | "planning" | "backlog";
interface NewStoryDraft {
  title: string;
  specMd: string;
  status: DraftStatus;
  agent: string;
}

function draftKey(projectId: string) {
  return `newStory:${projectId}`;
}

export function NewStoryModal({ onClose, onSubmit, submitting, agents, projectId }: NewStoryModalProps) {
  const initial = useRef<NewStoryDraft | null>(loadDraft<NewStoryDraft>(draftKey(projectId)));
  const [title, setTitle] = useState(initial.current?.title ?? "");
  const [specMd, setSpecMd] = useState(initial.current?.specMd ?? "");
  const [status, setStatus] = useState<DraftStatus>(initial.current?.status ?? "planning");
  const [agent, setAgent] = useState(initial.current?.agent ?? "spec-writer");

  useEffect(() => {
    if (!title.trim() && !specMd.trim()) {
      clearDraft(draftKey(projectId));
      return;
    }
    saveDraft<NewStoryDraft>(draftKey(projectId), { title, specMd, status, agent });
  }, [projectId, title, specMd, status, agent]);

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-panel">
        <div className="modal-header">New story</div>
        <div className="modal-body">
          <input
            className="input"
            style={{ fontSize: 14 }}
            placeholder="Story title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
          <textarea
            className="input"
            style={{ fontSize: 13, height: 160, resize: "none" }}
            placeholder="Spec (markdown)."
            value={specMd}
            onChange={(e) => setSpecMd(e.target.value)}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>State</span>
              <select
                className="input"
                style={{ width: "auto", fontSize: 12 }}
                value={status}
                onChange={(e) => setStatus(e.target.value as "icebox" | "planning" | "backlog")}
              >
                <option value="icebox">Icebox</option>
                <option value="planning">Planning</option>
                <option value="backlog">Backlog</option>
              </select>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Agent</span>
              <select
                className="input"
                style={{ width: "auto", fontSize: 12 }}
                value={agent}
                onChange={(e) => setAgent(e.target.value)}
              >
                {agents.length > 0
                  ? agents.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)
                  : <option value="spec-writer">spec-writer</option>
                }
              </select>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={() => title && onSubmit({ title, specMd, status, agent })}
            disabled={!title || submitting}
          >
            {submitting ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
