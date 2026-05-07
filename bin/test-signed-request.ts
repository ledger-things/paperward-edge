#!/usr/bin/env tsx
// bin/test-signed-request.ts
//
// Operator/test helper: send a WBA-signed request to a deployed Paperward
// edge Worker using the test fixture keys, and print the response. Useful
// for smoke-testing the WBA detection + paywall flow against staging
// without setting up a full Sepolia-funded e2e wallet.
//
// Usage:
//   tsx bin/test-signed-request.ts \
//     --host=test-blog.paperward.com \
//     --path=/anything \
//     [--operator=agent.staging.paperward.com] \
//     [--method=GET]
//
// The `operator` value MUST match a Worker that serves the matching JWKS at
// https://<operator>/.well-known/http-message-signatures-directory.
// In staging, that's agent.staging.paperward.com (served by the Worker's
// agent_fixture sub-app).

import { signRequest } from "../test/fixtures/wba/sign";

type Args = { host: string; path: string; operator: string; method: string };

function parseArgs(): Args {
  const out: Record<string, string> = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([\w-]+)=(.*)$/);
    if (!m || m[1] === undefined || m[2] === undefined) {
      console.error(`bad arg: ${a}`);
      process.exit(2);
    }
    out[m[1].replace(/-/g, "_")] = m[2];
  }
  if (!out.host) {
    console.error("required: --host=...");
    process.exit(2);
  }
  return {
    host: out.host,
    path: out.path ?? "/anything",
    operator: out.operator ?? "paperward-agent-jwks-staging.billowing-thunder-3549.workers.dev",
    method: out.method ?? "GET",
  };
}

const args = parseArgs();
const url = `https://${args.host}${args.path}`;
console.log(`→ ${args.method} ${url}`);
console.log(`  Signature-Agent: https://${args.operator}`);
console.log("");

const req = await signRequest({
  url,
  method: args.method,
  signatureAgent: `https://${args.operator}`,
});

const r = await fetch(req);

console.log(`← HTTP ${r.status}`);
console.log("Headers:");
for (const [k, v] of r.headers.entries()) {
  if (k.toLowerCase().startsWith("report-to")) continue; // noisy
  console.log(`  ${k}: ${v}`);
}
console.log("");

const text = await r.text();
try {
  const json = JSON.parse(text);
  console.log("Body (parsed JSON):");
  console.log(JSON.stringify(json, null, 2));
} catch {
  console.log("Body (raw):");
  console.log(text);
}
