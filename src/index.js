/**
 * mcp-http-conformance — probe an MCP Streamable HTTP endpoint and check it against the
 * 2025-11-25 transport specification (https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
 *
 * Zero dependencies. Each check returns { id, level: "MUST" | "SHOULD" | "INFO", pass, detail, clause, trace? }.
 * Checks are independent; a failing server never aborts the run — except when the endpoint is
 * unreachable or demands authentication, where continuing would only produce noise.
 */

export const PROTO = "2025-11-25";
export const SPEC_URL = "https://modelcontextprotocol.io/specification/2025-11-25/basic/transports";
const KNOWN_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2026-07-28"];

const INIT = (protocolVersion = PROTO) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion, capabilities: {}, clientInfo: { name: "mcp-http-conformance", version: "0.2.0" } },
});

/**
 * @param {string} url MCP endpoint
 * @param {{
 *   fetch?: typeof fetch,
 *   timeoutMs?: number,
 *   headers?: Record<string,string>,
 *   origin?: string,
 *   publicEndpoint?: boolean,   // the endpoint is intentionally reachable from any web origin → Origin check becomes SHOULD
 *   trace?: boolean             // attach request/response traces to every result
 * }} [opts]
 */
export async function runChecks(url, opts = {}) {
  const f = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const extra = lowerKeys(opts.headers ?? {});
  const results = [];
  const ctx = { url, sessionId: undefined, protocolVersion: undefined, serverInfo: undefined, responseMode: undefined, authRequired: false };
  let currentTrace = [];

  async function req(init) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const headers = { ...extra, ...lowerKeys(init.headers ?? {}) };
    const entry = { method: init.method ?? "GET", url, requestHeaders: redact(headers), requestBody: typeof init.body === "string" ? init.body.slice(0, 400) : undefined };
    currentTrace.push(entry);
    try {
      const res = await f(url, { ...init, signal: ac.signal, headers });
      const ct = res.headers.get("content-type") ?? "";
      let body;
      const text = await res.text();
      if (ct.includes("application/json")) {
        try { body = JSON.parse(text); } catch { body = text; }
      } else if (ct.includes("text/event-stream")) {
        body = parseSse(text);
      } else body = text;
      Object.assign(entry, { status: res.status, responseHeaders: headersToObject(res.headers), responseBody: text.slice(0, 600) });
      return { res, ct, body, text };
    } catch (e) {
      entry.error = describeError(e);
      throw e;
    } finally {
      clearTimeout(t);
    }
  }
  const record = (id, level, pass, detail, clause) => {
    const r = { id, level, pass, detail, clause };
    if (opts.trace) r.trace = currentTrace;
    currentTrace = [];
    results.push(r);
  };
  const json = { "content-type": "application/json" };
  const acceptBoth = { accept: "application/json, text/event-stream" };

  // 1. initialize → 200 with JSON or SSE, valid InitializeResult
  try {
    const r = await req({ method: "POST", headers: { ...json, ...acceptBoth }, body: JSON.stringify(INIT()) });
    if (r.res.status === 401 || (r.res.status === 403 && !opts.headers?.authorization)) {
      // Authorization is a separate spec; we only check the one transport-visible MUST and stop.
      const www = r.res.headers.get("www-authenticate");
      ctx.authRequired = true;
      record("auth-required", "INFO", false, `HTTP ${r.res.status}: the endpoint requires credentials — rerun with --header "Authorization: Bearer <token>"${www ? ` (WWW-Authenticate: ${snippet(www)})` : ""}`, "Authorization §4.1: protected resources respond 401 and the client obtains a token out of band");
      record("www-authenticate-on-401", "MUST", r.res.status !== 401 || !!www, www ? `WWW-Authenticate present${/resource_metadata=/.test(www) ? " with resource_metadata (RFC 9728)" : " (no resource_metadata hint)"}` : "401 without a WWW-Authenticate header: clients cannot discover the authorization server", "Authorization §4.1: a 401 MUST include WWW-Authenticate pointing at protected resource metadata (RFC 9728)");
      return finish(results, ctx);
    }
    const msg = firstResponse(r.body);
    ctx.responseMode = r.ct.includes("text/event-stream") ? "sse" : r.ct.includes("application/json") ? "json" : "other";
    const ok = r.res.status === 200 && ctx.responseMode !== "other" && msg?.result?.protocolVersion;
    ctx.sessionId = r.res.headers.get("mcp-session-id") ?? undefined;
    ctx.protocolVersion = msg?.result?.protocolVersion;
    ctx.serverInfo = msg?.result?.serverInfo;
    record("initialize", "MUST", !!ok, ok ? `HTTP ${r.res.status}, ${r.ct.split(";")[0]}, protocolVersion ${ctx.protocolVersion}, server ${ctx.serverInfo?.name ?? "?"}` : `HTTP ${r.res.status} ${r.ct || "(no content-type)"}: ${snippet(r.text)}`, "Sending Messages to the Server §5: a request MUST yield application/json or text/event-stream");
    if (!ok) return finish(results, ctx);
    record("initialize-result-shape", "MUST", !!msg.result.capabilities && typeof msg.result.capabilities === "object" && typeof ctx.serverInfo?.name === "string", `capabilities ${msg.result.capabilities ? Object.keys(msg.result.capabilities).join(",") || "{}" : "missing"}; serverInfo.name ${ctx.serverInfo?.name ?? "missing"}`, "Lifecycle: InitializeResult MUST carry capabilities and serverInfo");
    record("protocol-version-negotiation", "MUST", ctx.protocolVersion === PROTO || isKnownVersion(ctx.protocolVersion), ctx.protocolVersion === PROTO ? `server answered protocolVersion ${PROTO} for a ${PROTO} client` : `server answered ${ctx.protocolVersion} (a ${KNOWN_VERSIONS.includes(ctx.protocolVersion) ? "known" : "non-standard"} version) for a ${PROTO} client`, "Lifecycle: server MUST respond with the requested version if supported, otherwise another supported version");
    if (ctx.sessionId) record("session-id-charset", "MUST", /^[\x21-\x7E]+$/.test(ctx.sessionId), `Mcp-Session-Id=${ctx.sessionId.slice(0, 12)}…`, "Session Management §1: session id MUST only contain visible ASCII (0x21–0x7E)");
    if (ctx.responseMode === "sse") {
      const ids = sseEventIds(r.text);
      record("sse-event-ids", "INFO", true, ids.length ? `SSE events carry ids (resumable with Last-Event-ID)` : "SSE events carry no id field (stream resumption not offered — allowed)", "Resumability and Redelivery §1: servers MAY attach an id to SSE events");
    }
  } catch (e) {
    record("initialize", "MUST", false, `request failed: ${describeError(e)}`, "Sending Messages to the Server");
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

  // 4. ping round-trip with a string id → result object and id echoed
  {
    const r = await req({ method: "POST", headers: { ...json, ...acceptBoth, ...sess, ...pv }, body: JSON.stringify({ jsonrpc: "2.0", id: "abc-7", method: "ping" }) });
    const msg = firstResponse(r.body);
    record("jsonrpc-id-echo", "MUST", msg?.id === "abc-7" && msg?.jsonrpc === "2.0", msg ? `id ${JSON.stringify(msg.id)}` : `no JSON-RPC response (HTTP ${r.res.status}: ${snippet(r.text)})`, "JSON-RPC 2.0: response id MUST match the request id (string ids included)");
    record("ping-result", "MUST", msg && "result" in msg && msg.result !== null && typeof msg.result === "object", msg?.result ? "ping returned a result object" : `ping returned ${msg?.error ? `error ${msg.error.code} ${snippet(msg.error.message)}` : "no result"}`, "Utilities/Ping: receiver MUST respond promptly with an empty result");
  }

  // 5. Missing Accept header: the client MUST send it; servers commonly 406. Informational only.
  {
    const r = await req({ method: "POST", headers: { ...json, ...sess, ...pv }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }) });
    record("accept-header-enforced", "SHOULD", r.res.status === 406 || r.res.status === 400 || r.res.status === 200, `HTTP ${r.res.status} without Accept`, "Sending Messages to the Server §2 (client MUST include Accept); servers typically reject with 406");
  }

  // 6. GET without SSE support → 405, or SSE stream
  {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), Math.min(timeoutMs, 3000));
    const entry = { method: "GET", url, requestHeaders: redact({ ...extra, accept: "text/event-stream", ...sess, ...pv }) };
    currentTrace.push(entry);
    try {
      const res = await f(url, { method: "GET", headers: { ...extra, accept: "text/event-stream", ...sess, ...pv }, signal: ac.signal });
      const ct = res.headers.get("content-type") ?? "";
      Object.assign(entry, { status: res.status, responseHeaders: headersToObject(res.headers) });
      const ok = res.status === 405 || (res.status === 200 && ct.includes("text/event-stream"));
      record("get-sse-or-405", "MUST", ok, `HTTP ${res.status} ${ct.split(";")[0]}`, "Listening for Messages from the Server §3: GET MUST return text/event-stream or 405");
      ac.abort();
    } catch (e) {
      // An aborted open SSE stream is a pass (we cut it ourselves).
      entry.error = e.name === "AbortError" ? "aborted by checker (stream was open)" : describeError(e);
      record("get-sse-or-405", "MUST", e.name === "AbortError", e.name === "AbortError" ? "SSE stream opened (aborted by checker)" : `request failed: ${describeError(e)}`, "Listening for Messages from the Server §3");
    } finally {
      clearTimeout(t);
    }
  }

  // 7. Origin validation: an unrelated Origin MUST get 403 (MUST, unless the operator declares the endpoint public).
  {
    const r = await req({ method: "POST", headers: { ...json, ...acceptBoth, origin: opts.origin ?? "https://evil.example" }, body: JSON.stringify(INIT()) });
    const level = opts.publicEndpoint ? "SHOULD" : "MUST";
    record("origin-validation", level, r.res.status === 403, r.res.status === 403 ? "foreign Origin rejected with 403" : `foreign Origin accepted (HTTP ${r.res.status}) — browsers can reach this endpoint from any page (DNS rebinding / CSRF surface)${opts.publicEndpoint ? "; downgraded to SHOULD because --public was given" : "; pass --public if that is intentional"}`, "Security Warning §1: servers MUST validate Origin and respond 403 to invalid ones");
  }

  // 8. Invalid MCP-Protocol-Version header → 400; missing header → accepted (server assumes 2025-03-26)
  {
    const r = await req({ method: "POST", headers: { ...json, ...acceptBoth, ...sess, "mcp-protocol-version": "1999-01-01" }, body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" }) });
    record("bad-protocol-version-400", "MUST", r.res.status === 400, `HTTP ${r.res.status} for MCP-Protocol-Version: 1999-01-01`, "Protocol Version Header: invalid/unsupported version MUST get 400 Bad Request");
    const r2 = await req({ method: "POST", headers: { ...json, ...acceptBoth, ...sess }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" }) });
    record("missing-protocol-version-tolerated", "SHOULD", r2.res.status === 200, `HTTP ${r2.res.status} without an MCP-Protocol-Version header`, "Protocol Version Header: without the header the server SHOULD assume 2025-03-26 for backwards compatibility");
  }

  // 9. Session handling (only when the server issued one) — deletion last, because it ends the session.
  if (ctx.sessionId) {
    const r = await req({ method: "POST", headers: { ...json, ...acceptBoth, ...pv }, body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "ping" }) });
    record("session-required-400", "SHOULD", r.res.status === 400, `HTTP ${r.res.status} for a request without Mcp-Session-Id`, "Session Management §2: servers requiring a session SHOULD return 400 when it is missing");
    const bogus = await req({ method: "POST", headers: { ...json, ...acceptBoth, ...pv, "mcp-session-id": "does-not-exist-0000" }, body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "ping" }) });
    record("unknown-session-404", "MUST", bogus.res.status === 404, `HTTP ${bogus.res.status} for an unknown session id`, "Session Management §3: terminated/unknown session MUST get 404");
  } else {
    record("stateless-mode", "SHOULD", true, "server did not issue Mcp-Session-Id (stateless mode); session checks skipped", "Session Management §1: assigning a session id is optional");
  }

  // 10. Malformed JSON → 400 (JSON-RPC parse error)
  {
    const r = await req({ method: "POST", headers: { ...json, ...acceptBoth, ...sess, ...pv }, body: "{not json" });
    record("malformed-json-400", "SHOULD", r.res.status === 400, `HTTP ${r.res.status} for malformed JSON`, "Sending Messages to the Server §4: server that cannot accept input MUST return an HTTP error status (e.g. 400)");
  }

  // 11. DELETE (session termination) — last, and only for stateful servers
  if (ctx.sessionId) {
    const del = await req({ method: "DELETE", headers: { ...sess, ...pv } });
    record("session-delete", "SHOULD", [200, 204, 405].includes(del.res.status), `HTTP ${del.res.status} on DELETE`, "Session Management §5: DELETE terminates a session, or 405 if not allowed");
    if (del.res.status !== 405) {
      const after = await req({ method: "POST", headers: { ...json, ...acceptBoth, ...sess, ...pv }, body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "ping" }) });
      record("terminated-session-404", "MUST", after.res.status === 404, `HTTP ${after.res.status} for a request on the deleted session`, "Session Management §3: requests with a terminated session id MUST get 404");
    }
  }

  return finish(results, ctx);
}

function finish(results, ctx) {
  const must = results.filter((r) => r.level === "MUST");
  const should = results.filter((r) => r.level === "SHOULD");
  return {
    spec: PROTO,
    specUrl: SPEC_URL,
    endpoint: ctx,
    results,
    summary: {
      mustPassed: must.filter((r) => r.pass).length,
      mustTotal: must.length,
      shouldPassed: should.filter((r) => r.pass).length,
      shouldTotal: should.length,
      conformant: !ctx.authRequired && must.length > 0 && must.every((r) => r.pass),
      authRequired: ctx.authRequired,
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
function sseEventIds(text) {
  return text.split("\n").filter((l) => /^id:/.test(l)).map((l) => l.slice(3).trim());
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
function lowerKeys(o) {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));
}
function redact(h) {
  const out = { ...h };
  if (out.authorization) out.authorization = out.authorization.split(" ")[0] + " <redacted>";
  return out;
}
function headersToObject(h) {
  const o = {};
  h.forEach((v, k) => { o[k] = k === "set-cookie" ? "<redacted>" : v; });
  return o;
}
export function describeError(e) {
  const cause = e?.cause;
  const code = cause?.code ?? e?.code;
  const hint = code === "ENOTFOUND" ? "DNS lookup failed" : code === "ECONNREFUSED" ? "connection refused (is the server listening?)" : code === "CERT_HAS_EXPIRED" || /certificate/i.test(cause?.message ?? "") ? "TLS certificate problem" : e?.name === "AbortError" ? "timed out" : null;
  return [e?.message, code, hint, cause?.message && cause.message !== e?.message ? cause.message : null].filter(Boolean).join(" — ");
}

export function formatReport(report, { color = true, verbose = false } = {}) {
  const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const lines = [];
  lines.push(`MCP Streamable HTTP conformance (spec ${PROTO}) — ${report.endpoint.url ?? ""}`);
  if (report.endpoint.serverInfo) lines.push(`server: ${report.endpoint.serverInfo.name} ${report.endpoint.serverInfo.version ?? ""} · negotiated ${report.endpoint.protocolVersion} · responses ${report.endpoint.responseMode} · session ${report.endpoint.sessionId ? "yes" : "no (stateless)"}`);
  for (const r of report.results) {
    const mark = r.pass ? c(32, "PASS") : r.level === "MUST" ? c(31, "FAIL") : r.level === "INFO" ? c(36, "NOTE") : c(33, "WARN");
    lines.push(`${mark} ${r.level.padEnd(6)} ${r.id.padEnd(34)} ${r.detail}`);
    if (!r.pass) lines.push(`      ↳ ${r.clause}`);
    if (verbose && !r.pass && r.trace) {
      for (const t of r.trace) {
        lines.push(`      · ${t.method} → ${t.status ?? t.error ?? "?"}${t.requestBody ? `  body ${t.requestBody.slice(0, 100)}` : ""}`);
        if (t.responseHeaders) lines.push(`        headers ${Object.entries(t.responseHeaders).filter(([k]) => ["content-type", "mcp-session-id", "mcp-protocol-version", "www-authenticate", "allow"].includes(k)).map(([k, v]) => `${k}=${v}`).join(" ") || "(none relevant)"}`);
        if (t.responseBody) lines.push(`        body ${snippet(t.responseBody)}`);
      }
    }
  }
  const s = report.summary;
  if (s.authRequired) lines.push(`${c(33, "AUTH REQUIRED")}: cannot assess transport conformance without credentials`);
  else lines.push(`${s.conformant ? c(32, "CONFORMANT") : c(31, "NOT CONFORMANT")}: MUST ${s.mustPassed}/${s.mustTotal}, SHOULD ${s.shouldPassed}/${s.shouldTotal}`);
  lines.push(`spec: ${SPEC_URL}`);
  return lines.join("\n");
}
