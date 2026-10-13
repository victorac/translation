import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const uiPort = Number(process.env["LTW_UI_PORT"] ?? 5173);
const bridge = `http://127.0.0.1:${process.env["LTW_BRIDGE_PORT"] ?? 5174}`;

/** Browser dev mode: the window talks to the dev bridge instead of Electron. Ports can be changed with LTW_UI_PORT / LTW_BRIDGE_PORT. */
export default defineConfig({
  plugins: [react()],
  server: {
    port: uiPort,
    strictPort: true,
    proxy: { "/ipc": bridge, "/events": bridge },
  },
});
