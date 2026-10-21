/** Minimal Streamable HTTP servers used as fixtures: one conformant, one deliberately sloppy. */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

export function conformantServer({ withSessions = true } = {}) {
  const sessions = new Set();
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return end(res, 403, { jsonrpc: "2.0", error: { code: -32000, message: "forbidden origin" }, id: null });
    const pv = req.headers["mcp-protocol-version"];
    if (pv && !["2025-11-25", "2025-06-18", "2025-03-26"].includes(pv)) return end(res, 400, { jsonrpc: "2.0", error: { code: -32000, message: "unsupported protocol version" }, id: null });
    if (req.method === "GET") { res.writeHead(405); return res.end(); }
    if (req.method === "DELETE") { sessions.delete(req.headers["mcp-session-id"]); res.writeHead(204); return res.end(); }
    if (req.method !== "POST") { res.writeHead(405); return res.end(); }
    const accept = req.headers.accept ?? "";
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) return end(res, 406, { jsonrpc: "2.0", error: { code: -32000, message: "Accept must include application/json and text/event-stream" }, id: null });
    let body = "";
    for await (const c of req) body += c;
    let msg;
    try { msg = JSON.parse(body); } catch { return end(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "parse error" }, id: null }); }
    const sid = req.headers["mcp-session-id"];
    if (msg.method === "initialize") {
      const headers = {};
      if (withSessions) { const id = randomUUID(); sessions.add(id); headers["mcp-session-id"] = id; }
      const requested = msg.params?.protocolVersion;
      return end(res, 200, { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: requested === "2025-11-25" ? "2025-11-25" : "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } } }, headers);
    }
    if (withSessions) {
      if (!sid) return end(res, 400, { jsonrpc: "2.0", error: { code: -32000, message: "missing session" }, id: null });
      if (!sessions.has(sid)) return end(res, 404, { jsonrpc: "2.0", error: { code: -32001, message: "session not found" }, id: null });
    }
    if (msg.id === undefined) { res.writeHead(202); return res.end(); }
    if (msg.method === "tools/list") return end(res, 200, { jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } });
    return end(res, 200, { jsonrpc: "2.0", id: msg.id, result: {} });
  });
  return server;
}

/** Sloppy server: ignores Origin, no 202 for notifications, wrong id echo, accepts any protocol version. */
export function sloppyServer() {
  return createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    let msg = {};
    try { msg = JSON.parse(body); } catch { /* fallthrough */ }
    if (req.method === "GET") return end(res, 200, { hello: "world" });
    if (msg.method === "initialize") return end(res, 200, { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "sloppy" } } });
    return end(res, 200, { jsonrpc: "2.0", id: 999, result: {} });
  });
}

function end(res, status, obj, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(obj));
}
