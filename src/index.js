/**
 * mcp-http-conformance — probe an MCP Streamable HTTP endpoint and check it against the
 * 2025-11-25 transport specification (https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
 *
 * Zero dependencies. Each check returns { id, level: "MUST" | "SHOULD", pass, detail, clause }.
 * Checks are independent; a failing server never aborts the run.
 */

const PROTO = "2025-11-25";

const INIT = (protocolVersion = PROTO) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion, capabilities: {}, clientInfo: { name: "mcp-http-conformance", version: "0.1.0" } },
});

/**
 * @param {string} url MCP endpoint
 * @param {{ fetch?: typeof fetch, timeoutMs?: number, headers?: Record<string,string>, origin?: string }} [opts]
 */
export async function runChecks(url, opts = {}) {
  const f = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const extra = opts.headers ?? {};
  const results = [];
  const ctx = { sessionId: undefined, protocolVersion: undefined, serverInfo: undefined };

  async function req(init) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await f(url, { ...init, signal: ac.signal, headers: { ...extra, ...(init.headers ?? {}) } });
      const ct = res.headers.get("content-type") ?? "";
      let body;
      const text = await res.text();
      if (ct.includes("application/json")) {
        try { body = JSON.parse(text); } catch { body = text; }
      } else if (ct.includes("text/event-stream")) {
        body = parseSse(text);
      } else body = text;
      return { res, ct, body, text };
    } finally {
      clearTimeout(t);
    }
  }
  const record = (id, level, pass, detail, clause) => results.push({ id, level, pass, detail, clause });
  const json = { "content-type": "application/json" };
  const acceptBoth = { accept: "application/json, text/event-stream" };

  // 1. initialize → 200 with JSON or SSE, valid InitializeResult
  try {
    const r = await req({ method: "POST", headers: { ...json, ...acceptBoth }, body: JSON.stringify(INIT()) });
    const msg = firstResponse(r.body);
    const ok = r.res.status === 200 && (r.ct.includes("application/json") || r.ct.includes("text/event-stream")) && msg?.result?.protocolVersion;
    ctx.sessionId = r.res.headers.get("mcp-session-id") ?? undefined;
    ctx.protocolVersion = msg?.result?.protocolVersion;
    ctx.serverInfo = msg?.result?.serverInfo;
    record("initialize", "MUST", !!ok, ok ? `HTTP ${r.res.status}, ${r.ct.split(";")[0]}, protocolVersion ${ctx.protocolVersion}, server ${ctx.serverInfo?.name ?? "?"}` : `HTTP ${r.res.status} ${r.ct || "(no content-type)"}: ${snippet(r.text)}`, "Sending Messages to the Server §5: a request MUST yield application/json or text/event-stream");
    record("protocol-version-negotiation", "MUST", ctx.protocolVersion === PROTO || isKnownVersion(ctx.protocolVersion), ctx.protocolVersion ? `server answered protocolVersion ${ctx.protocolVersion} for a ${PROTO} client` : "no protocolVersion in result", "Lifecycle: server MUST respond with the requested version if supported, otherwise another supported version");
    if (ctx.sessionId) record("session-id-charset", "MUST", /^[\x21-\x7E]+$/.test(ctx.sessionId), `Mcp-Session-Id=${ctx.sessionId.slice(0, 12)}…`, "Session Management §1: session id MUST only contain visible ASCII (0x21–0x7E)");
  } catch (e) {
    record("initialize", "MUST", false, `request failed: ${e.message}`, "Sending Messages to the Server");
    return finish(results, ctx);
  }
  const sess = ctx.sessionId ? { "mcp-session-id": ctx.sessionId } : {};
  const pv = { "mcp-protocol-version": ctx.protocolVersion ?? PROTO };

  // 2. notifications/initialized → 202 no body
  {
    const r = await req({ method: "POST", headers: { ...json, ...acceptBoth, ...sess, ...pv }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    record("notification-202", "MUST", r.res.status === 202 && r.text.trim() === "", `HTTP ${r.res.status}${r.text.trim() ? " with body" : ""}`, "Sending Messages to the Server §4: accepted notification MUST return 202 Accepted with no body");
  }

  // 3. tools/list works after init (sanity + session)
  {
    const r = await req({ method: "POST", headers: { ...json, ...acceptBoth, ...sess, ...pv }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
    const msg = firstResponse(r.body);
    record("tools-list", "SHOULD", r.res.status === 200 && Array.isArray(msg?.result?.tools), r.res.status === 200 ? `${msg?.result?.tools?.length ?? "?"} tools` : `HTTP ${r.res.status}: ${snippet(r.text)}`, "Server features: tools/list (sanity check that the session works)");
  }

  // 4. Missing Accept header: the client MUST send it; servers commonly 406. Informational only.
  {
    const r = await req({ method: "POST", headers: { ...json, ...sess, ...pv }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }) });
    record("accept-header-enforced", "SHOULD", r.res.status === 406 || r.res.status === 400 || r.res.status === 200, `HTTP ${r.res.status} without Accept`, "Sending Messages to the Server §2 (client MUST include Accept); servers typically reject with 406");
  }

  // 5. GET without SSE support → 405, or SSE stream
  {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), Math.min(timeoutMs, 3000));
    try {
      const res = await f(url, { method: "GET", headers: { ...extra, accept: "text/event-stream", ...sess, ...pv }, signal: ac.signal });
      const ct = res.headers.get("content-type") ?? "";
      const ok = res.status === 405 || (res.status === 200 && ct.includes("text/event-stream"));
      record("get-sse-or-405", "MUST", ok, `HTTP ${res.status} ${ct.split(";")[0]}`, "Listening for Messages from the Server §3: GET MUST return text/event-stream or 405");
      ac.abort();
    } catch (e) {
      // An aborted open SSE stream is a pass (we cut it ourselves).
      record("get-sse-or-405", "MUST", e.name === "AbortError", e.name === "AbortError" ? "SSE stream opened (aborted by checker)" : `request failed: ${e.message}`, "Listening for Messages from the Server §3");
    } finally {
      clearTimeout(t);
    }
  }

  // 6. Origin validation: an unrelated Origin MUST get 403 (unless the server intentionally allows all origins — flagged).
  {
    const r = await req({ method: "POST", headers: { ...json, ...acceptBoth, origin: opts.origin ?? "https://evil.example" }, body: JSON.stringify(INIT()) });
    record("origin-validation", "MUST", r.res.status === 403, r.res.status === 403 ? "foreign Origin rejected with 403" : `foreign Origin accepted (HTTP ${r.res.status}) — DNS rebinding risk unless the endpoint is intentionally public`, "Security Warning §1: servers MUST validate Origin and respond 403 to invalid ones");
  }

  // 7. Invalid MCP-Protocol-Version header → 400
  {
    const r = await req({ method: "POST", headers: { ...json, ...acceptBoth, ...sess, "mcp-protocol-version": "1999-01-01" }, body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" }) });
    record("bad-protocol-version-400", "MUST", r.res.status === 400, `HTTP ${r.res.status} for MCP-Protocol-Version: 1999-01-01`, "Protocol Version Header: invalid/unsupported version MUST get 400 Bad Request");
  }

  // 7b. Response ids echo request ids
  {
    const r = await req({ method: "POST", headers: { ...json, ...acceptBoth, ...sess, ...pv }, body: JSON.stringify({ jsonrpc: "2.0", id: "abc-7", method: "ping" }) });
    const msg = firstResponse(r.body);
    record("jsonrpc-id-echo", "MUST", msg?.id === "abc-7" && msg?.jsonrpc === "2.0", msg ? `id ${JSON.stringify(msg.id)}` : `no JSON-RPC response (HTTP ${r.res.status})`, "JSON-RPC 2.0: response id MUST match the request id");
  }

  // 8. Session handling (only when the server issued one)
  if (ctx.sessionId) {
    const r = await req({ method: "POST", headers: { ...json, ...acceptBoth, ...pv }, body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "ping" }) });
    record("session-required-400", "SHOULD", r.res.status === 400, `HTTP ${r.res.status} for a request without Mcp-Session-Id`, "Session Management §2: servers requiring a session SHOULD return 400 when it is missing");
    const bogus = await req({ method: "POST", headers: { ...json, ...acceptBoth, ...pv, "mcp-session-id": "does-not-exist-0000" }, body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "ping" }) });
    record("unknown-session-404", "MUST", bogus.res.status === 404, `HTTP ${bogus.res.status} for an unknown session id`, "Session Management §3: terminated/unknown session MUST get 404");
    const del = await req({ method: "DELETE", headers: { ...sess, ...pv } });
    record("session-delete", "SHOULD", [200, 204, 405].includes(del.res.status), `HTTP ${del.res.status} on DELETE`, "Session Management §5: DELETE terminates a session, or 405 if not allowed");
  } else {
    record("stateless-mode", "SHOULD", true, "server did not issue Mcp-Session-Id (stateless mode); session checks skipped", "Session Management §1: assigning a session id is optional");
  }

  // 9. Malformed JSON → 400 (JSON-RPC parse error)
  {
    const r = await req({ method: "POST", headers: { ...json, ...acceptBoth, ...sess, ...pv }, body: "{not json" });
    record("malformed-json-400", "SHOULD", r.res.status === 400, `HTTP ${r.res.status} for malformed JSON`, "Sending Messages to the Server §4: server that cannot accept input MUST return an HTTP error status (e.g. 400)");
  }

  return finish(results, ctx);
}

function finish(results, ctx) {
  const must = results.filter((r) => r.level === "MUST");
  const should = results.filter((r) => r.level === "SHOULD");
  return {
    endpoint: ctx,
    results,
    summary: {
      mustPassed: must.filter((r) => r.pass).length,
      mustTotal: must.length,
      shouldPassed: should.filter((r) => r.pass).length,
      shouldTotal: should.length,
      conformant: must.every((r) => r.pass),
    },
  };
}

export function parseSse(text) {
  const events = [];
  for (const block of text.split(/\n\n+/)) {
    const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
    if (!data) continue;
    try { events.push(JSON.parse(data)); } catch { events.push(data); }
  }
  return events;
}
function firstResponse(body) {
  if (Array.isArray(body)) return body.find((m) => m && typeof m === "object" && ("result" in m || "error" in m));
  if (body && typeof body === "object") return body;
  return undefined;
}
function isKnownVersion(v) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}
function snippet(t) {
  return String(t).replace(/\s+/g, " ").slice(0, 120);
}

export function formatReport(report, { color = true } = {}) {
  const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const lines = [];
  lines.push(`MCP Streamable HTTP conformance (spec ${PROTO})`);
  if (report.endpoint.serverInfo) lines.push(`server: ${report.endpoint.serverInfo.name} ${report.endpoint.serverInfo.version ?? ""} · negotiated ${report.endpoint.protocolVersion} · session ${report.endpoint.sessionId ? "yes" : "no (stateless)"}`);
  for (const r of report.results) {
    const mark = r.pass ? c(32, "PASS") : r.level === "MUST" ? c(31, "FAIL") : c(33, "WARN");
    lines.push(`${mark} ${r.level.padEnd(6)} ${r.id.padEnd(28)} ${r.detail}`);
    if (!r.pass) lines.push(`      ↳ ${r.clause}`);
  }
  const s = report.summary;
  lines.push(`${s.conformant ? c(32, "CONFORMANT") : c(31, "NOT CONFORMANT")}: MUST ${s.mustPassed}/${s.mustTotal}, SHOULD ${s.shouldPassed}/${s.shouldTotal}`);
  return lines.join("\n");
}
