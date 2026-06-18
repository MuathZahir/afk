/**
 * Phase 4 — the local dashboard server. A dependency-free `node:http` server the daemon runs on
 * localhost: it serves the SPA, the current state snapshot, a live SSE event stream, and the handful
 * of actions (pause/resume, retry an escalation, merge a ready PR, answer a question). Every action
 * earns its place against "could you just do this in GitHub?" — merge and retry are one-click here
 * because they're the whole point of a monitoring surface; everything else stays in GitHub.
 */
import * as http from "node:http";
import { Daemon } from "./daemon.js";
import { SPA } from "./dashboard.js";

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}

export function serveDashboard(daemon: Daemon, port: number): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (code: number, body: string, type = "application/json") =>
      res.writeHead(code, { "content-type": type, "cache-control": "no-store" }).end(body);

    // ── static + state ──
    if (req.method === "GET" && url.pathname === "/") return send(200, SPA, "text/html; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/api/state") return send(200, JSON.stringify(daemon.store.snapshot()));

    // ── live stream (SSE) ──
    if (req.method === "GET" && url.pathname === "/api/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(`event: snapshot\ndata: ${JSON.stringify(daemon.store.snapshot())}\n\n`);
      const unsub = daemon.store.subscribe((e) => res.write(`event: event\ndata: ${JSON.stringify(e)}\n\n`));
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => { unsub(); clearInterval(ping); });
      return;
    }

    // ── actions ──
    if (req.method === "POST") {
      const body = await readBody(req);
      switch (url.pathname) {
        case "/api/pause": daemon.pause(); return send(200, "{}");
        case "/api/resume": daemon.resume(); return send(200, "{}");
        case "/api/retry": daemon.retry(Number(body.issue)); return send(200, "{}");
        case "/api/answer": daemon.answer(String(body.id), String(body.text ?? "")); return send(200, "{}");
        case "/api/merge": return send(200, JSON.stringify(daemon.merge(String(body.feature))));
      }
    }
    send(404, JSON.stringify({ error: "not found" }));
  });
  server.listen(port, "127.0.0.1", () => {
    const addr = server.address();
    const bound = typeof addr === "object" && addr ? addr.port : port;
    console.log(`📊 Dashboard: http://localhost:${bound}`);
  });
  return server;
}
