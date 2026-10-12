/**
 * Development only: lets the app's window run in a normal browser tab (so it can be tried and checked
 * without Electron). It serves the same commands as the real app, on this computer only.
 */
import { createServer, type ServerResponse } from "node:http";
import { createHandler } from "./handlers.js";
import { createThrottle } from "./notifier.js";
import { WorkspaceService } from "./service.js";

const PORT = Number(process.env["LTW_BRIDGE_PORT"] ?? 5174);
const service = new WorkspaceService();
const handle = createHandler(service);
const streams = new Set<ServerResponse>();
let seq = 0;
const notify = createThrottle(() => {
  const data = `data: ${JSON.stringify({ eventVersion: 1, seq: ++seq, type: "changed" })}\n\n`;
  for (const s of streams) s.write(data);
});
service.onChange(notify);

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
    req.on("end", () => {
      let result;
      try {
        const m = JSON.parse(body) as { requestId?: unknown; command?: unknown; payload?: unknown };
        result = handle(m.requestId, m.command, m.payload);
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
