#!/usr/bin/env node
import { runChecks, formatReport } from "./index.js";

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
  console.log(`usage: mcp-http-conformance <mcp-endpoint-url> [--json] [--header "Name: value"]... [--timeout ms]

Probes an MCP Streamable HTTP endpoint and reports MUST/SHOULD conformance against spec 2025-11-25.
Exit code 0 when all MUST checks pass, 1 otherwise, 2 on usage error.`);
  process.exit(args.length === 0 ? 2 : 0);
}
const url = args.find((a) => !a.startsWith("--") && /^https?:\/\//.test(a));
if (!url) {
  console.error("error: an http(s) endpoint URL is required");
  process.exit(2);
}
const headers = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--header" && args[i + 1]) {
    const [k, ...v] = args[++i].split(":");
    headers[k.trim().toLowerCase()] = v.join(":").trim();
  }
}
const timeoutMs = Number(args[args.indexOf("--timeout") + 1]) || undefined;
const report = await runChecks(url, { headers, timeoutMs });
if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
else console.log(formatReport(report, { color: process.stdout.isTTY }));
process.exit(report.summary.conformant ? 0 : 1);
