/**
 * Development only: lets the app's window run in a normal browser tab (so it can be tried and checked
 * without Electron). It serves the same commands as the real app, on this computer only.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { createHandler } from "./handlers.js";
import { createThrottle } from "./notifier.js";
import { ProviderService } from "./provider-service.js";
import { ProjectService } from "./project-service.js";
import { FileSettingsStore, MemoryCredentialStore } from "./storage.js";

const PORT = Number(process.env["LTW_BRIDGE_PORT"] ?? 5174);
// Dev mode keeps the address in a local file but API keys only in memory (they are forgotten when this stops).
const provider = new ProviderService(new FileSettingsStore(new URL("../.dev-data/settings.json", import.meta.url).pathname), new MemoryCredentialStore());
// Dev mode has no native dialogs: projects are saved to, and opened from, one fixed folder.
const devData = new URL("../.dev-data/", import.meta.url).pathname;
const projects = new ProjectService({
  provider,
  recoveryPath: `${devData}recovery/unsaved-project.ltw.json`,
  dialogs: {
    chooseSavePath: async (name) => `${devData}projects/${name}`,
    chooseExportPath: async (name) => `${devData}exports/${name}`,
    chooseOpenPath: async () => {
      const dir = `${devData}projects`;
      const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".ltw.json")) : [];
      files.sort((a, b) => statSync(`${dir}/${b}`).mtimeMs - statSync(`${dir}/${a}`).mtimeMs);
      return files[0] ? `${dir}/${files[0]}` : undefined;
    },
  },
});
const service = projects.workspace;
const handle = createHandler(service, provider, projects);
const streams = new Set<ServerResponse>();
let seq = 0;
const notify = createThrottle(() => {
  const data = `data: ${JSON.stringify({ eventVersion: 1, seq: ++seq, type: "changed" })}\n\n`;
  for (const s of streams) s.write(data);
});
projects.onChange(notify);

const server = createServer((req, res) => {
  const host = req.headers.host ?? "";
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
    res.writeHead(403).end();
    return;
  }
  if (req.method === "GET" && req.url === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(": connected\n\n");
    streams.add(res);
    req.on("close", () => streams.delete(res));
    return;
  }
  if (req.method === "POST" && req.url === "/ipc") {
    // A custom header forces other websites to ask permission first, which they will not get.
    if (req.headers["x-ltw-dev"] !== "1") {
      res.writeHead(403).end();
      return;
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 8_000_000) req.destroy();
    });
    req.on("end", async () => {
      let result;
      try {
        const m = JSON.parse(body) as { requestId?: unknown; command?: unknown; payload?: unknown };
        result = await handle(m.requestId, m.command, m.payload);
      } catch {
        result = { requestId: "", ok: false, error: { code: "invalid_payload", message: "The request was malformed." } };
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    });
    return;
  }
  res.writeHead(404).end();
});

server.listen(PORT, "127.0.0.1", () => console.log(`dev bridge on http://127.0.0.1:${PORT}`));
