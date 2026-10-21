# mcp-http-conformance

A zero-dependency CLI that probes an **MCP Streamable HTTP** endpoint and reports **MUST / SHOULD** conformance against the [2025-11-25 transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), citing the spec clause for every failure.

Why: Alexa+ add-ons, Claude, Cursor and every other MCP host talk to self-hosted servers over this transport, and the failure modes are subtle (a server that forgets to reject foreign `Origin` headers is exposed to DNS rebinding; one that returns `200` with a body for notifications breaks clients that expect `202`). Until now you verified this by hand with curl. This tool makes it a one-liner you can put in CI.

```bash
npx mcp-http-conformance http://127.0.0.1:3001/mcp
```

```
MCP Streamable HTTP conformance (spec 2025-11-25)
server: homemend 0.1.0 · negotiated 2025-11-25 · session no (stateless)
PASS MUST   initialize                   HTTP 200, application/json, protocolVersion 2025-11-25, server homemend
PASS MUST   protocol-version-negotiation server answered protocolVersion 2025-11-25 for a 2025-11-25 client
PASS MUST   notification-202             HTTP 202
PASS SHOULD tools-list                   10 tools
PASS SHOULD accept-header-enforced       HTTP 406 without Accept
PASS MUST   get-sse-or-405               HTTP 200 text/event-stream
PASS MUST   origin-validation            foreign Origin rejected with 403
PASS MUST   bad-protocol-version-400     HTTP 400 for MCP-Protocol-Version: 1999-01-01
PASS MUST   jsonrpc-id-echo              id "abc-7"
PASS SHOULD stateless-mode               server did not issue Mcp-Session-Id (stateless mode); session checks skipped
PASS SHOULD malformed-json-400           HTTP 400 for malformed JSON
CONFORMANT: MUST 7/7, SHOULD 4/4
```

## Checks

| id | level | spec clause |
|---|---|---|
| `initialize` | MUST | POST request yields `application/json` or `text/event-stream` with a valid `InitializeResult` |
| `protocol-version-negotiation` | MUST | server echoes the requested version or another supported one |
| `session-id-charset` | MUST | `Mcp-Session-Id` is visible ASCII only (when issued) |
| `notification-202` | MUST | accepted notification → `202 Accepted`, empty body |
| `tools-list` | SHOULD | session works for a normal request |
| `accept-header-enforced` | SHOULD | clients must send `Accept`; servers typically `406` without it |
| `get-sse-or-405` | MUST | `GET` returns an SSE stream or `405` |
| `origin-validation` | MUST | foreign `Origin` → `403` (DNS rebinding protection) |
| `bad-protocol-version-400` | MUST | unsupported `MCP-Protocol-Version` → `400` |
| `jsonrpc-id-echo` | MUST | response `id` matches the request `id` |
| `session-required-400` / `unknown-session-404` / `session-delete` | SHOULD / MUST / SHOULD | session lifecycle (only when the server issues sessions) |
| `malformed-json-400` | SHOULD | unparsable body → HTTP error status |

Exit code `0` when every MUST passes, `1` otherwise, `2` on usage error. `--json` prints the full report; `--header "Authorization: Bearer …"` adds headers to every probe.

## Use as a library

```js
import { runChecks, formatReport } from "mcp-http-conformance";
const report = await runChecks("https://example.com/mcp", { headers: { authorization: "Bearer …" } });
console.log(formatReport(report));
if (!report.summary.conformant) process.exit(1);
```

## Development

```bash
npm test   # node --test; fixtures include a conformant stateful server, a stateless one, and a deliberately sloppy one
```

Built during the Amazon Developer Hackathon 2026 and dogfooded on the [HomeMend](https://github.com/mogohary99/homemend) Alexa+ MCP server. MIT.
