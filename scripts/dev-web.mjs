// Starts the dev bridge and the window's dev server together, for trying the app in a browser tab.
import { spawn } from "node:child_process";

const run = (cmd, args, cwd) => spawn(cmd, args, { cwd, stdio: "inherit", shell: false });
const bridge = run("pnpm", ["--filter", "@ltw/desktop", "dev:bridge"]);
const ui = run("pnpm", ["--filter", "@ltw/ui", "dev"]);
const stop = () => {
  bridge.kill();
  ui.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of [bridge, ui]) child.on("exit", stop);
