import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.js";
import { PageHeader } from "../components/PageHeader.js";
import { Breadcrumb } from "../components/Breadcrumb.js";

export function SettingsPage() {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.settings.get(),
  });

  const patchMut = useMutation({
    mutationFn: api.settings.patch,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });

  const [maxPerProject, setMaxPerProject] = useState<string>("");
  const [maxTotal, setMaxTotal] = useState<string>("");
  const [maxQa, setMaxQa] = useState<string>("");
  const [maxSpecWriter, setMaxSpecWriter] = useState<string>("");
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (data && !initialized) {
      setMaxPerProject(String(data.throttle.maxConcurrentPerProject));
      setMaxTotal(String(data.throttle.maxConcurrentTotal));
      setMaxQa(String(data.throttle.maxConcurrentQa));
      setMaxSpecWriter(String(data.throttle.maxConcurrentSpecWriter));
      setInitialized(true);
    }
  }, [data, initialized]);

  function handlePerProjectBlur() {
    const n = parseInt(maxPerProject, 10);
    if (isNaN(n) || n < 1) { setMaxPerProject(String(data?.throttle.maxConcurrentPerProject ?? 2)); return; }
    if (n === data?.throttle.maxConcurrentPerProject) return;
    patchMut.mutate({ throttle: { maxConcurrentPerProject: n } });
  }
  function handleTotalBlur() {
    const n = parseInt(maxTotal, 10);
    if (isNaN(n) || n < 1) { setMaxTotal(String(data?.throttle.maxConcurrentTotal ?? 3)); return; }
    if (n === data?.throttle.maxConcurrentTotal) return;
    patchMut.mutate({ throttle: { maxConcurrentTotal: n } });
  }
  function handleQaBlur() {
    const n = parseInt(maxQa, 10);
    if (isNaN(n) || n < 1) { setMaxQa(String(data?.throttle.maxConcurrentQa ?? 2)); return; }
    if (n === data?.throttle.maxConcurrentQa) return;
    patchMut.mutate({ throttle: { maxConcurrentQa: n } });
  }
  function handleSpecWriterBlur() {
    const n = parseInt(maxSpecWriter, 10);
    if (isNaN(n) || n < 1) { setMaxSpecWriter(String(data?.throttle.maxConcurrentSpecWriter ?? 4)); return; }
    if (n === data?.throttle.maxConcurrentSpecWriter) return;
    patchMut.mutate({ throttle: { maxConcurrentSpecWriter: n } });
  }

  return (
    <div className="adm-page">
      <PageHeader title={<Breadcrumb first="Orca" second="Settings" />} />

      <div className="adm-body adm-body-narrow">
        {isLoading ? (
          <div className="adm-empty" style={{ fontFamily: "var(--mono)" }}>loading…</div>
        ) : (
          <section>
            <div className="adm-section">
              <span>Throttling</span>
              <span className="adm-section-rule" />
            </div>
            <p className="adm-section-hint">
              Limits how many stories the heartbeat dispatches concurrently.
              Changes take effect on the next heartbeat tick.
            </p>

            <div className="adm-rows">
              <ThrottleRow
                name="per-project"
                hint="impl-pipeline dispatches per project"
                value={maxPerProject}
                onChange={setMaxPerProject}
                onCommit={handlePerProjectBlur}
              />
              <ThrottleRow
                name="total"
                hint="impl-pipeline dispatches across all projects"
                value={maxTotal}
                onChange={setMaxTotal}
                onCommit={handleTotalBlur}
              />
              <ThrottleRow
                name="qa"
                hint="qa-tester agents platform-wide (independent cap)"
                value={maxQa}
                onChange={setMaxQa}
                onCommit={handleQaBlur}
              />
              <ThrottleRow
                name="spec-writer"
                hint="spec-writer agents platform-wide (independent cap)"
                value={maxSpecWriter}
                onChange={setMaxSpecWriter}
                onCommit={handleSpecWriterBlur}
              />
            </div>

            {patchMut.isError && (
              <div
                className="adm-section-hint"
                style={{ color: "var(--attn-error)", marginTop: 12 }}
              >
                failed to save: {String(patchMut.error)}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function ThrottleRow({
  name, hint, value, onChange, onCommit,
}: {
  name: string; hint: string;
  value: string; onChange: (v: string) => void; onCommit: () => void;
}) {
  return (
    <div className="adm-row">
      <div className="adm-row-label">
        <div className="adm-row-name">{name}</div>
        <div className="adm-row-hint">{hint}</div>
      </div>
      <div className="adm-row-aux">
        <input
          type="number"
          min={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onCommit}
          className="adm-num"
        />
      </div>
    </div>
  );
}
