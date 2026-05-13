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

  // Throttle field state
  const [maxPerProject, setMaxPerProject] = useState<string>("");
  const [maxTotal, setMaxTotal] = useState<string>("");
  const [maxQa, setMaxQa] = useState<string>("");
  const [maxSpecWriter, setMaxSpecWriter] = useState<string>("");
  const [initialized, setInitialized] = useState(false);

  // Seed from server once loaded
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
    if (isNaN(n) || n < 1) {
      // Reset to server value on invalid input
      setMaxPerProject(String(data?.throttle.maxConcurrentPerProject ?? 2));
      return;
    }
    if (n === data?.throttle.maxConcurrentPerProject) return; // no change
    patchMut.mutate({ throttle: { maxConcurrentPerProject: n } });
  }

  function handleTotalBlur() {
    const n = parseInt(maxTotal, 10);
    if (isNaN(n) || n < 1) {
      setMaxTotal(String(data?.throttle.maxConcurrentTotal ?? 3));
      return;
    }
    if (n === data?.throttle.maxConcurrentTotal) return; // no change
    patchMut.mutate({ throttle: { maxConcurrentTotal: n } });
  }

  function handleQaBlur() {
    const n = parseInt(maxQa, 10);
    if (isNaN(n) || n < 1) {
      setMaxQa(String(data?.throttle.maxConcurrentQa ?? 2));
      return;
    }
    if (n === data?.throttle.maxConcurrentQa) return;
    patchMut.mutate({ throttle: { maxConcurrentQa: n } });
  }

  function handleSpecWriterBlur() {
    const n = parseInt(maxSpecWriter, 10);
    if (isNaN(n) || n < 1) {
      setMaxSpecWriter(String(data?.throttle.maxConcurrentSpecWriter ?? 4));
      return;
    }
    if (n === data?.throttle.maxConcurrentSpecWriter) return;
    patchMut.mutate({ throttle: { maxConcurrentSpecWriter: n } });
  }

  return (
    <div className="h-full flex flex-col">
      <PageHeader title={<Breadcrumb first="Orca" second="Settings" />} />

      {isLoading && (
        <div className="text-muted text-sm p-6">loading…</div>
      )}

      {!isLoading && (
        <div className="flex-1 min-h-0 overflow-y-auto p-6">
          <div className="max-w-2xl space-y-8">
            {/* ── Throttling section ────────────────────────────────── */}
            <section>
              <h2 className="text-sm font-semibold text-text mb-1">
                Throttling
              </h2>
              <p className="text-xs text-muted mb-4">
                Limits how many stories the heartbeat dispatches concurrently.
                Changes take effect on the next heartbeat tick.
              </p>

              <div className="bg-surface border border-border rounded-md divide-y divide-border">
                {/* Max per project */}
                <div className="flex items-center justify-between px-4 py-3 gap-4">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-text">
                      Max concurrent implementations per project
                    </div>
                    <div className="text-[11px] text-muted mt-0.5">
                      Maximum number of implementing-pipeline dispatches
                      (frontend / backend / qa-tester etc.) allowed per
                      project at any one time. Spec-writer dispatches have
                      their own cap below.
                    </div>
                  </div>
                  <input
                    type="number"
                    min={1}
                    value={maxPerProject}
                    onChange={(e) => setMaxPerProject(e.target.value)}
                    onBlur={handlePerProjectBlur}
                    className="w-20 shrink-0 text-right text-sm bg-bg border border-border rounded px-2 py-1 text-text focus:outline-none focus:ring-1 focus:ring-accent/50"
                  />
                </div>

                {/* Max total */}
                <div className="flex items-center justify-between px-4 py-3 gap-4">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-text">
                      Max concurrent implementations total
                    </div>
                    <div className="text-[11px] text-muted mt-0.5">
                      Maximum number of implementing-pipeline dispatches
                      allowed across all projects at any one time.
                      Spec-writer dispatches have their own cap below.
                    </div>
                  </div>
                  <input
                    type="number"
                    min={1}
                    value={maxTotal}
                    onChange={(e) => setMaxTotal(e.target.value)}
                    onBlur={handleTotalBlur}
                    className="w-20 shrink-0 text-right text-sm bg-bg border border-border rounded px-2 py-1 text-text focus:outline-none focus:ring-1 focus:ring-accent/50"
                  />
                </div>

                {/* Max concurrent QA */}
                <div className="flex items-center justify-between px-4 py-3 gap-4">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-text">
                      Max concurrent QA
                    </div>
                    <div className="text-[11px] text-muted mt-0.5">
                      Maximum number of qa-tester agents running simultaneously
                      (platform-wide). Stories beyond this cap remain in{" "}
                      <span className="font-mono">qa</span> until a slot
                      opens. Sub-cap within total — does not add to it.
                    </div>
                  </div>
                  <input
                    type="number"
                    min={1}
                    value={maxQa}
                    onChange={(e) => setMaxQa(e.target.value)}
                    onBlur={handleQaBlur}
                    className="w-20 shrink-0 text-right text-sm bg-bg border border-border rounded px-2 py-1 text-text focus:outline-none focus:ring-1 focus:ring-accent/50"
                  />
                </div>

                {/* Max concurrent spec-writer */}
                <div className="flex items-center justify-between px-4 py-3 gap-4">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-text">
                      Max concurrent spec-writer
                    </div>
                    <div className="text-[11px] text-muted mt-0.5">
                      Maximum number of spec-writer agents running
                      simultaneously. Independent of the implementing-pipeline
                      caps above — spec-writer dispatches don't compete for
                      per-project or total slots.
                    </div>
                  </div>
                  <input
                    type="number"
                    min={1}
                    value={maxSpecWriter}
                    onChange={(e) => setMaxSpecWriter(e.target.value)}
                    onBlur={handleSpecWriterBlur}
                    className="w-20 shrink-0 text-right text-sm bg-bg border border-border rounded px-2 py-1 text-text focus:outline-none focus:ring-1 focus:ring-accent/50"
                  />
                </div>
              </div>

              {patchMut.isError && (
                <p className="text-xs text-red-400 mt-2">
                  Failed to save: {String(patchMut.error)}
                </p>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
