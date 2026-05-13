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
    <div className="h-full flex flex-col">
      <PageHeader title={<Breadcrumb first="Orca" second="Settings" />} />

      {isLoading && (
        <div className="px-6 py-5 text-muted text-xs font-mono">loading…</div>
      )}

      {!isLoading && (
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="max-w-[560px]">

            <div className="text-[10.5px] font-medium tracking-[0.08em] uppercase text-muted mb-2.5">
              Throttling
            </div>
            <p className="text-[11.5px] text-muted mb-3 leading-relaxed">
              Limits how many stories the heartbeat dispatches concurrently.
              Changes take effect on the next heartbeat tick.
            </p>

            <div className="flex flex-col border border-border rounded-md bg-surface mb-3">
              <div className="grid grid-cols-[160px_1fr_auto] gap-3.5 px-3.5 py-2.5 items-center border-b border-border">
                <div>
                  <div className="font-mono text-[11px] text-muted uppercase tracking-[0.04em]">per-project</div>
                  <div className="text-[11px] text-muted/70 mt-0.5 leading-snug font-mono">
                    impl-pipeline dispatches per project
                  </div>
                </div>
                <div />
                <input
                  type="number"
                  min={1}
                  value={maxPerProject}
                  onChange={(e) => setMaxPerProject(e.target.value)}
                  onBlur={handlePerProjectBlur}
                  className="w-14 text-right font-mono text-sm text-text bg-bg border border-border rounded px-2 py-1 outline-none"
                />
              </div>

              <div className="grid grid-cols-[160px_1fr_auto] gap-3.5 px-3.5 py-2.5 items-center border-b border-border">
                <div>
                  <div className="font-mono text-[11px] text-muted uppercase tracking-[0.04em]">total</div>
                  <div className="text-[11px] text-muted/70 mt-0.5 leading-snug font-mono">
                    impl-pipeline dispatches across all projects
                  </div>
                </div>
                <div />
                <input
                  type="number"
                  min={1}
                  value={maxTotal}
                  onChange={(e) => setMaxTotal(e.target.value)}
                  onBlur={handleTotalBlur}
                  className="w-14 text-right font-mono text-sm text-text bg-bg border border-border rounded px-2 py-1 outline-none"
                />
              </div>

              <div className="grid grid-cols-[160px_1fr_auto] gap-3.5 px-3.5 py-2.5 items-center border-b border-border">
                <div>
                  <div className="font-mono text-[11px] text-muted uppercase tracking-[0.04em]">qa</div>
                  <div className="text-[11px] text-muted/70 mt-0.5 leading-snug font-mono">
                    qa-tester agents platform-wide (sub-cap of total)
                  </div>
                </div>
                <div />
                <input
                  type="number"
                  min={1}
                  value={maxQa}
                  onChange={(e) => setMaxQa(e.target.value)}
                  onBlur={handleQaBlur}
                  className="w-14 text-right font-mono text-sm text-text bg-bg border border-border rounded px-2 py-1 outline-none"
                />
              </div>

              <div className="grid grid-cols-[160px_1fr_auto] gap-3.5 px-3.5 py-2.5 items-center">
                <div>
                  <div className="font-mono text-[11px] text-muted uppercase tracking-[0.04em]">spec-writer</div>
                  <div className="text-[11px] text-muted/70 mt-0.5 leading-snug font-mono">
                    spec-writer agents platform-wide (independent cap)
                  </div>
                </div>
                <div />
                <input
                  type="number"
                  min={1}
                  value={maxSpecWriter}
                  onChange={(e) => setMaxSpecWriter(e.target.value)}
                  onBlur={handleSpecWriterBlur}
                  className="w-14 text-right font-mono text-sm text-text bg-bg border border-border rounded px-2 py-1 outline-none"
                />
              </div>
            </div>

            {patchMut.isError && (
              <div className="text-[11.5px] text-blocked mt-2 font-mono">
                failed to save: {String(patchMut.error)}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
