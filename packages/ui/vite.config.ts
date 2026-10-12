import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Browser dev mode: the window talks to the dev bridge instead of Electron. */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/ipc": "http://127.0.0.1:5174", "/events": "http://127.0.0.1:5174" },
  },
});
