import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { reactVendorPlugin } from "./build/reactVendorPlugin";

const host = process.env.TAURI_DEV_HOST;

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [react(), reactVendorPlugin()],
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1431 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  worker: { format: "es" },
  // Pre-bundle lazily imported deps so the dev server never reloads mid-session.
  optimizeDeps: {
    include: [
      "esbuild-wasm",
      "@xterm/xterm",
      "@xterm/addon-fit",
      "allotment",
      "zustand",
      "zod",
    ],
  },
  build: {
    target: ["es2022", "safari16"],
    chunkSizeWarningLimit: 8000,
    sourcemap: false,
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
});
