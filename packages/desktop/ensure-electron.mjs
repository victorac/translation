// Makes sure Electron's program file has been downloaded before starting the app.
// pnpm skips Electron's own download step unless the install script is approved, which leaves
// "Electron uninstall" errors. This runs that step if (and only if) it is missing.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const dir = dirname(require.resolve("electron/package.json"));
if (existsSync(join(dir, "path.txt")) && existsSync(join(dir, "dist"))) process.exit(0);

console.log("Downloading Electron (first run only)...");
const r = spawnSync(process.execPath, [join(dir, "install.js")], { stdio: "inherit" });
if (r.status !== 0) {
  console.error("Could not download Electron. Check your internet connection and run the command again.");
  process.exit(r.status ?? 1);
}
