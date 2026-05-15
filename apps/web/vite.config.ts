import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const serverUrl = process.env.ORCA_SERVER_URL;
if (!serverUrl) {
  throw new Error(
    "[orca] ORCA_SERVER_URL is not set. Run via `pnpm dev` so service-ports.mjs discovers the backend peer and injects this env var. Direct `vite` invocations are not supported.",
  );
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/api": {
        target: serverUrl,
        changeOrigin: true,
      },
      "/health": {
        target: serverUrl,
        changeOrigin: true,
      },
    },
  },
});
