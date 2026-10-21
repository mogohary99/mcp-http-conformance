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
    assert.match(formatReport(report, { color: false }), /CONFORMANT: MUST 9\/9/);
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
