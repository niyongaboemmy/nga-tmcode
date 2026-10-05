import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1431 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  worker: { format: "es" },
  build: {
    target: ["es2022", "safari16"],
    chunkSizeWarningLimit: 8000,
    sourcemap: false,
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
});
