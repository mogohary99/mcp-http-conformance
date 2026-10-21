#!/usr/bin/env node
import { runChecks, formatReport } from "./index.js";

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
  console.log(`usage: mcp-http-conformance <mcp-endpoint-url> [options]

Probes an MCP Streamable HTTP endpoint and reports MUST/SHOULD conformance against spec 2025-11-25.

options:
  --header "Name: value"   add a request header (repeatable; e.g. Authorization)
  --timeout <ms>           per-request timeout (default 10000)
  --origin <url>           the foreign Origin used for the DNS-rebinding check (default https://evil.example)
  --public                 the endpoint is intentionally reachable from any web origin: the Origin check becomes SHOULD
  --verbose                print request/response traces for failed checks
  --json                   machine-readable report (includes traces)
  --no-color               plain output

exit codes: 0 all MUST checks pass · 1 a MUST check failed or the endpoint is unreachable · 2 usage error · 3 authentication required`);
  process.exit(args.length === 0 ? 2 : 0);
}
const url = args.find((a) => !a.startsWith("--") && /^https?:\/\//.test(a));
if (!url) {
  console.error("error: an http(s) endpoint URL is required");
  process.exit(2);
}
const headers = {};
let origin;
let timeoutMs;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--header" && args[i + 1]) {
    const [k, ...v] = args[++i].split(":");
    headers[k.trim().toLowerCase()] = v.join(":").trim();
  } else if (args[i] === "--origin" && args[i + 1]) origin = args[++i];
  else if (args[i] === "--timeout" && args[i + 1]) timeoutMs = Number(args[++i]) || undefined;
}
const report = await runChecks(url, { headers, timeoutMs, origin, publicEndpoint: args.includes("--public"), trace: true });
if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
else console.log(formatReport(report, { color: process.stdout.isTTY && !args.includes("--no-color"), verbose: args.includes("--verbose") }));
process.exit(report.summary.authRequired ? 3 : report.summary.conformant ? 0 : 1);
