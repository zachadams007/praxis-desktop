import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

const entry = (html: string) => fileURLToPath(new URL(html, import.meta.url));

// Vite config tuned for Tauri (fixed dev port, no clearing the Rust logs).
// Port 1430 (not Catalyzed's 1420) so both desktop apps can run side by side.
// https://tauri.app/start/frontend/vite/
// Build stamp baked into every bundle - the honest "which build am I on" answer
// (versions can repeat across same-day releases; this can't).
const BUILD_TS = new Date().toLocaleString('en-CA', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', '');

export default defineConfig({
  define: { __BUILD_TS__: JSON.stringify(BUILD_TS) },
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 1430,
    strictPort: true,
    // Pin to IPv4 so the Tauri webview (which hits 127.0.0.1 on Windows) can
    // reach the dev server. `host: false` binds only IPv6 [::1] and the desktop
    // window loads a blank page.
    host: "127.0.0.1",
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "es2021",
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      input: {
        // Praxis brain (main window) + Flight Deck + Memory Galaxy + Command Center
        // (each its own Tauri window / renderer process).
        main: entry("./index.html"),
        flightdeck: entry("./flightdeck.html"),
        knowledge: entry("./knowledge.html"),
        command: entry("./command.html"),
        voicepill: entry("./voicepill.html"),
      },
    },
  },
});
