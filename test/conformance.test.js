import { test } from "node:test";
import assert from "node:assert/strict";
import { runChecks, formatReport, parseSse } from "../src/index.js";
import { conformantServer, sloppyServer } from "./fixtures.js";

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}/mcp`)));
const close = (server) => new Promise((r) => server.close(() => r()));

test("a conformant stateful server passes every MUST and SHOULD", async () => {
  const s = conformantServer();
  const url = await listen(s);
  try {
    const report = await runChecks(url);
    const failed = report.results.filter((r) => !r.pass).map((r) => `${r.id}: ${r.detail}`);
    assert.deepEqual(failed, []);
    assert.equal(report.summary.conformant, true);
    assert.equal(report.endpoint.protocolVersion, "2025-11-25");
    assert.ok(report.results.some((r) => r.id === "unknown-session-404"));
    assert.match(formatReport(report, { color: false }), /CONFORMANT: MUST 12\/12, SHOULD 6\/6/);
    assert.ok(report.results.some((r) => r.id === "terminated-session-404" && r.pass));
  } finally {
    await close(s);
  }
});

test("a conformant stateless server skips session checks and still passes", async () => {
  const s = conformantServer({ withSessions: false });
  const url = await listen(s);
  try {
    const report = await runChecks(url);
    assert.equal(report.summary.conformant, true);
    assert.ok(report.results.some((r) => r.id === "stateless-mode"));
    assert.ok(!report.results.some((r) => r.id === "unknown-session-404"));
  } finally {
    await close(s);
  }
});

test("a sloppy server is reported NOT CONFORMANT with the right failures and clauses", async () => {
  const s = sloppyServer();
  const url = await listen(s);
  try {
    const report = await runChecks(url);
    assert.equal(report.summary.conformant, false);
    const failedIds = report.results.filter((r) => !r.pass).map((r) => r.id);
    for (const id of ["notification-202", "get-sse-or-405", "origin-validation", "bad-protocol-version-400", "jsonrpc-id-echo"]) assert.ok(failedIds.includes(id), `${id} should fail`);
    const origin = report.results.find((r) => r.id === "origin-validation");
    assert.match(origin.clause, /Security Warning/);
    assert.match(formatReport(report, { color: false }), /NOT CONFORMANT/);
  } finally {
    await close(s);
  }
});

test("unreachable endpoint fails fast without throwing", async () => {
  const report = await runChecks("http://127.0.0.1:1/mcp", { timeoutMs: 2000 });
  assert.equal(report.summary.conformant, false);
  assert.equal(report.results[0].id, "initialize");
  assert.equal(report.results[0].pass, false);
});

test("parseSse extracts JSON data events", () => {
  const events = parseSse('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\nid: 2\ndata: {"a":1}\n\n');
  assert.equal(events.length, 2);
  assert.equal(events[0].id, 1);
});

import { authServer, publicServer } from "./fixtures.js";

test("a protected endpoint is reported AUTH REQUIRED (not NOT CONFORMANT) and the 401 MUST carry WWW-Authenticate", async () => {
  const s = authServer();
  const url = await listen(s);
  try {
    const report = await runChecks(url);
    assert.equal(report.summary.authRequired, true);
    assert.equal(report.summary.conformant, false);
    assert.ok(report.results.find((r) => r.id === "www-authenticate-on-401").pass);
    assert.match(formatReport(report, { color: false }), /AUTH REQUIRED/);
    // With the token, the same server is fully assessed
    const withToken = await runChecks(url, { headers: { Authorization: "Bearer secret" } });
    assert.equal(withToken.summary.authRequired, false);
    assert.equal(withToken.summary.conformant, true);
  } finally {
    await close(s);
  }
});

test("a 401 without WWW-Authenticate fails that MUST", async () => {
  const s = authServer({ wwwAuthenticate: null });
  const url = await listen(s);
  try {
    const report = await runChecks(url);
    const r = report.results.find((r) => r.id === "www-authenticate-on-401");
    assert.equal(r.pass, false);
    assert.match(r.clause, /RFC 9728/);
  } finally {
    await close(s);
  }
});

test("--public downgrades the Origin check to SHOULD so an intentionally open endpoint can still be CONFORMANT", async () => {
  const s = publicServer();
  const url = await listen(s);
  try {
    const strict = await runChecks(url);
    assert.equal(strict.summary.conformant, false);
    assert.equal(strict.results.find((r) => r.id === "origin-validation").level, "MUST");
    const open = await runChecks(url, { publicEndpoint: true });
    assert.equal(open.summary.conformant, true);
    const r = open.results.find((r) => r.id === "origin-validation");
    assert.equal(r.level, "SHOULD");
    assert.equal(r.pass, false);
  } finally {
    await close(s);
  }
});

test("traces are attached on request and shown for failed checks in verbose output, with Authorization redacted", async () => {
  const s = sloppyServer();
  const url = await listen(s);
  try {
    const report = await runChecks(url, { trace: true, headers: { Authorization: "Bearer top-secret" } });
    const failed = report.results.find((r) => !r.pass);
    assert.ok(Array.isArray(failed.trace) && failed.trace.length > 0);
    assert.equal(failed.trace[0].requestHeaders.authorization, "Bearer <redacted>");
    const out = formatReport(report, { color: false, verbose: true });
    assert.match(out, /·\s+POST → 200/);
    assert.ok(!out.includes("top-secret"));
  } finally {
    await close(s);
  }
});

test("network errors are explained (connection refused)", async () => {
  const s = conformantServer();
  const url = await listen(s);
  await close(s); // the port is now free and nothing listens on it
  const report = await runChecks(url, { timeoutMs: 2000 });
  assert.match(report.results[0].detail, /connection refused|ECONNREFUSED/);
});
