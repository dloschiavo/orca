import { useState } from "react";

interface NewStoryModalProps {
  onClose: () => void;
  onSubmit: (body: { title: string; specMd: string; status: "icebox" | "backlog"; agent: string }) => void;
  submitting: boolean;
  agents: { name: string }[];
}

export function NewStoryModal({ onClose, onSubmit, submitting, agents }: NewStoryModalProps) {
  const [title, setTitle] = useState("");
  const [specMd, setSpecMd] = useState("");
  const [status, setStatus] = useState<"icebox" | "backlog">("backlog");
  const [agent, setAgent] = useState("triage");

  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center pt-24 z-50">
      <div className="bg-surface border border-border rounded-lg w-[640px] max-w-full shadow-2xl">
        <div className="px-4 py-3 border-b border-border text-sm font-medium">
          New story
        </div>
        <div className="p-4 space-y-3">
          <input
            className="input text-base"
            placeholder="Story title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
          <textarea
            className="input text-sm h-40 resize-none"
            placeholder="Spec (markdown)."
            value={specMd}
            onChange={(e) => setSpecMd(e.target.value)}
          />
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted">State</label>
              <select
                className="input text-sm w-auto"
                value={status}
                onChange={(e) => setStatus(e.target.value as "icebox" | "backlog")}
              >
                <option value="backlog">Backlog</option>
                <option value="icebox">Icebox</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted">Agent</label>
              <select
                className="input text-sm w-auto"
                value={agent}
                onChange={(e) => setAgent(e.target.value)}
              >
                {agents.length > 0
                  ? agents.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)
                  : <option value="triage">triage</option>
                }
              </select>
            </div>
          </div>
        </div>
        <div className="px-4 py-3 border-t border-border flex items-center justify-end gap-2">
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
