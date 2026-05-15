import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { App } from "./App.js";
import { pushErrorToast } from "./components/ErrorToaster.js";
import { looksLikeNetworkError } from "./state/serverStatus.js";
import "./index.css";

// Surface every query / mutation failure as a toast. Without this, a 500 from
// the API resolves into an empty list and looks indistinguishable from "no
// data" — which is exactly how the missing-column bug went undetected.
function reportError(err: unknown) {
  // Network failures (server down) get the dedicated OfflineBanner instead —
  // stacking dozens of "Failed to fetch" toasts during an outage is noise.
  if (looksLikeNetworkError(err)) return;
  pushErrorToast(err instanceof Error ? err.message : String(err));
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: reportError }),
  mutationCache: new MutationCache({ onError: reportError }),
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 5_000,
    },
  },
});

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("root element missing");

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
