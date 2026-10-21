# mcp-http-conformance

**A zero-dependency CLI that checks any MCP server's Streamable HTTP endpoint against the
[2025-11-25 transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
and tells you exactly which MUST/SHOULD clause you violate.**

```sh
npx github:mogohary99/mcp-http-conformance https://your-server.example/mcp
```

```
MCP Streamable HTTP conformance (spec 2025-11-25) — https://docs.mcp.cloudflare.com/mcp
server: docs-ai-search 0.4.14 · negotiated 2025-11-25 · responses sse · session no (stateless)
PASS MUST   initialize                         HTTP 200, text/event-stream, protocolVersion 2025-11-25, server docs-ai-search
PASS MUST   initialize-result-shape            capabilities tools; serverInfo.name docs-ai-search
PASS MUST   protocol-version-negotiation       server answered protocolVersion 2025-11-25 for a 2025-11-25 client
NOTE INFO   sse-event-ids                      SSE events carry no id field (stream resumption not offered — allowed)
PASS MUST   notification-202                   HTTP 202
PASS SHOULD tools-list                         2 tools
PASS MUST   jsonrpc-id-echo                    id "abc-7"
PASS MUST   ping-result                        ping returned a result object
PASS SHOULD accept-header-enforced             HTTP 406 without Accept
PASS MUST   get-sse-or-405                     HTTP 405 application/json
PASS MUST   origin-validation                  foreign Origin rejected with 403
PASS MUST   bad-protocol-version-400           HTTP 400 for MCP-Protocol-Version: 1999-01-01
PASS SHOULD missing-protocol-version-tolerated HTTP 200 without an MCP-Protocol-Version header
PASS SHOULD stateless-mode                     server did not issue Mcp-Session-Id (stateless mode); session checks skipped
PASS SHOULD malformed-json-400                 HTTP 400 for malformed JSON
CONFORMANT: MUST 9/9, SHOULD 5/5
```

## Why this exists

Alexa+ add-ons, Claude, ChatGPT, Cursor and every other MCP host talk to remote servers over
Streamable HTTP. The spec is short but has sharp edges — Origin validation, 202 for notifications,
400 for bad protocol versions, 404 for dead sessions — and most frameworks get at least one wrong.
Until now the only way to find out was to plug the server into a host and watch it fail.

This tool was built during the Amazon Developer Hackathon 2026 to validate
[HomeMend](https://github.com/mogohary99/homemend), an Alexa+ MCP server. It is deliberately
general: **no dependencies, Node ≥ 20, one file, runs in CI**, and every failure prints the spec clause.

## What it found in the wild (2026-10-21)

| Server | Result | Notes |
|---|---|---|
| `https://docs.mcp.cloudflare.com/mcp` | **CONFORMANT** 9/9 MUST | Cloudflare's docs server (SSE responses, stateless) |
| `https://mcp.deepwiki.com/mcp` | 8/9 MUST | accepts a foreign `Origin` (DNS-rebinding/CSRF surface); pass `--public` if intentional |
| `https://mcp.context7.com/mcp` | 8/9 MUST | same Origin finding |
| `https://mcp.semgrep.ai/mcp` | AUTH REQUIRED (exit 3) | 401 with `WWW-Authenticate` — rerun with `--header "Authorization: Bearer …"` |
| HomeMend (Node, Express) and HomeMend (Cloudflare Worker) | **CONFORMANT** | the two runtimes behave identically on the wire |

## Checks

| id | level | spec clause |
|---|---|---|
| `initialize` | MUST | POST yields `application/json` or `text/event-stream` with an `InitializeResult` |
| `initialize-result-shape` | MUST | result carries `capabilities` and `serverInfo` |
| `protocol-version-negotiation` | MUST | server answers the requested version or another supported one |
| `session-id-charset` | MUST | `Mcp-Session-Id` is visible ASCII only *(stateful servers)* |
| `sse-event-ids` | INFO | whether SSE events carry `id` (resumability is optional) |
| `notification-202` | MUST | accepted notification → `202 Accepted`, no body |
| `tools-list` | SHOULD | sanity: the session works |
| `jsonrpc-id-echo` | MUST | response `id` matches the request `id` (string ids too) |
| `ping-result` | MUST | `ping` returns a result object |
| `accept-header-enforced` | SHOULD | request without `Accept` is rejected (406) or tolerated |
| `get-sse-or-405` | MUST | `GET` opens an SSE stream or returns 405 |
| `origin-validation` | MUST (SHOULD with `--public`) | foreign `Origin` → 403 |
| `bad-protocol-version-400` | MUST | unsupported `MCP-Protocol-Version` → 400 |
| `missing-protocol-version-tolerated` | SHOULD | no header → server assumes 2025-03-26 and answers |
| `session-required-400` | SHOULD | missing session id → 400 *(stateful)* |
| `unknown-session-404` | MUST | unknown session id → 404 *(stateful)* |
| `malformed-json-400` | SHOULD | unparsable body → 400 |
| `session-delete` | SHOULD | `DELETE` terminates the session or returns 405 *(stateful)* |
| `terminated-session-404` | MUST | requests on a deleted session → 404 *(stateful)* |
| `auth-required` / `www-authenticate-on-401` | INFO / MUST | protected endpoints: the 401 must carry `WWW-Authenticate` (RFC 9728) |

Stateless servers get the applicable subset (the summary counts only what was run).

## Usage

```
mcp-http-conformance <mcp-endpoint-url> [options]

  --header "Name: value"   add a request header (repeatable; e.g. Authorization)
  --timeout <ms>           per-request timeout (default 10000)
  --origin <url>           the foreign Origin used for the DNS-rebinding check
  --public                 the endpoint is intentionally reachable from any web origin → Origin check becomes SHOULD
  --verbose                print request/response traces for failed checks
  --json                   machine-readable report (includes traces, Authorization redacted)
  --no-color

exit codes: 0 all MUST pass · 1 a MUST failed or unreachable · 2 usage error · 3 authentication required
```

`--verbose` shows what was sent and what came back for every failed check, so the fix is obvious:

```
FAIL MUST   notification-202                   HTTP 200 with body
      ↳ Sending Messages to the Server §4: accepted notification MUST return 202 Accepted with no body
      · POST → 200  body {"jsonrpc":"2.0","method":"notifications/initialized"}
        headers content-type=application/json
        body {"jsonrpc":"2.0","id":999,"result":{}}
```

### In CI (GitHub Actions)

```yaml
- run: npx github:mogohary99/mcp-http-conformance https://staging.example.com/mcp --header "Authorization: Bearer ${{ secrets.MCP_TOKEN }}"
```

The job fails on any MUST violation.

### As a library

```js
import { runChecks, formatReport } from "mcp-http-conformance";
const report = await runChecks("http://127.0.0.1:3001/mcp", { headers: { "X-Tenant": "demo" }, trace: true });
console.log(formatReport(report, { verbose: true }));
report.results.filter((r) => !r.pass); // [{ id, level, pass, detail, clause, trace }]
```

## Development

```sh
npm test       # 10 tests: conformant stateful/stateless fixtures, a sloppy server, an auth-protected server,
               # a deliberately public server, trace redaction, network-error wording
```

Fixtures live in `test/fixtures.js` and are tiny hand-written servers — useful on their own as
reference implementations of the status codes the spec requires.

## Scope and limits

- Checks the **transport** (HTTP semantics, headers, status codes, session lifecycle). It does not
  validate tool schemas, prompts or resources beyond a `tools/list` sanity call.
- Authorization is only checked at the boundary (401 + `WWW-Authenticate`); pass a token to assess
  the rest.
- Resumability (`Last-Event-ID` replay) is reported, not exercised.

## License

MIT
