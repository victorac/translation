import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { resolve } from "node:path";

/** Locks the window's page down in the packaged app. (Not applied in dev, where Vite needs inline scripts.) */
const csp = {
  name: "ltw-csp",
  apply: "build" as const,
  transformIndexHtml: (html: string) =>
    html.replace(
      "<!--CSP-->",
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'">`,
    ),
};

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: ["@ltw/domain", "@ltw/providers"] },
      rollupOptions: { input: { index: resolve("src/main/index.ts") } },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve("src/preload/index.ts") },
        // A sandboxed preload must be CommonJS.
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve("../ui"),
    plugins: [react(), csp],
    build: { outDir: resolve("out/renderer"), rollupOptions: { input: resolve("../ui/index.html") } },
  },
});
