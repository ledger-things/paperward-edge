#!/usr/bin/env tsx
// test/e2e/run.ts
//
// End-to-end tests against the deployed staging Worker. Drives real WBA-signed
// requests + real Sepolia x402 payments via the Coinbase facilitator.
//
// Required env vars:
//   E2E_HOSTNAME            — e.g., e2e-test.staging.paperward.com
//   E2E_SEPOLIA_PRIVATE_KEY — agent's Sepolia wallet private key (USDC payer)
//   E2E_TEST_AGENT_KEY      — Ed25519 private key bytes for WBA signing
//                              (defaults to test/fixtures/wba/keys.ts)
//   E2E_AGENT_OPERATOR      — hostname of the standalone JWKS Worker that
//                              hosts the agent's public-key directory.
//                              Defaults to the staging fixture Worker.

import { signRequest } from "../fixtures/wba/sign";

const HOST = process.env.E2E_HOSTNAME;
if (!HOST) {
  console.error("E2E_HOSTNAME required");
  process.exit(2);
}

const AGENT_OPERATOR =
  process.env.E2E_AGENT_OPERATOR ??
  "paperward-agent-jwks-staging.billowing-thunder-3549.workers.dev";
const SIG_AGENT = `https://${AGENT_OPERATOR}`;

// The full suite needs a funded Sepolia wallet to make real x402 payments.
// In CI, the secret may not be set yet (intentionally — the wallet costs real
// effort to set up and top up). When the key is absent, skip cleanly with
// exit 0 so the workflow stays green; the suite auto-enables once the secret
// is configured.
if (!process.env.E2E_SEPOLIA_PRIVATE_KEY) {
  console.log("E2E_SEPOLIA_PRIVATE_KEY not set — skipping e2e (no funded test wallet)");
  process.exit(0);
}

let failures = 0;

async function expect(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`✔ ${name}`);
  } catch (err) {
    failures++;
    console.error(`✘ ${name}\n  ${err instanceof Error ? err.message : String(err)}`);
  }
}

await expect("browser request returns 200", async () => {
  const r = await fetch(`https://${HOST}/`, {
    headers: { "user-agent": "Mozilla/5.0 (X11; Linux) Firefox/120", "accept-language": "en-US" },
  });
  if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
});

await expect("signed request without payment returns 402 with x402 headers", async () => {
  const req = await signRequest({
    url: `https://${HOST}/paid/article-1`,
    signatureAgent: SIG_AGENT,
  });
  const r = await fetch(req);
  if (r.status !== 402) throw new Error(`expected 402, got ${r.status}`);
  const auth = r.headers.get("WWW-Authenticate") ?? "";
  if (!/x402/i.test(auth)) throw new Error(`expected WWW-Authenticate: x402, got ${auth}`);
  const body = (await r.json()) as any;
  if (!body.accepts?.[0]?.maxAmountRequired) {
    throw new Error(`expected accepts[0].maxAmountRequired in body`);
  }
});

await expect("signed request with valid Sepolia x402 payment returns 200", async () => {
  // 1. First call to get the payment requirements
  const probe = await fetch(
    await signRequest({ url: `https://${HOST}/paid/article-1`, signatureAgent: SIG_AGENT }),
  );
  const reqs = ((await probe.json()) as any).accepts[0];
  // 2. Build a Sepolia x402 payment payload using viem (or whatever the
  //    x402 client library exposes). This is a multi-line block — see the
  //    "Sepolia x402 payment helper" section in test/e2e/README.md for the
  //    expected shape. The helper is named makeSepoliaPayment(reqs).
  const { makeSepoliaPayment } = await import("./sepolia-payment");
  const xPayment = await makeSepoliaPayment(reqs, process.env.E2E_SEPOLIA_PRIVATE_KEY!);
  // 3. Re-issue the request with the X-PAYMENT header
  const signed = await signRequest({
    url: `https://${HOST}/paid/article-1`,
    signatureAgent: SIG_AGENT,
    additionalHeaders: { "x-payment": xPayment },
  });
  const r = await fetch(signed);
  if (r.status !== 200) throw new Error(`expected 200, got ${r.status}: ${await r.text()}`);
  const xpr = r.headers.get("X-PAYMENT-RESPONSE");
  if (!xpr) throw new Error("missing X-PAYMENT-RESPONSE header");
});

await expect("signed request with wrong amount returns 402 charge_verify_failed", async () => {
  const probe = await fetch(
    await signRequest({ url: `https://${HOST}/paid/article-1`, signatureAgent: SIG_AGENT }),
  );
  const reqs = ((await probe.json()) as any).accepts[0];
  const { makeSepoliaPayment } = await import("./sepolia-payment");
  // Pay 1 wei — way too low
  const xPayment = await makeSepoliaPayment(
    { ...reqs, maxAmountRequired: "0.000000001" },
    process.env.E2E_SEPOLIA_PRIVATE_KEY!,
  );
  const signed = await signRequest({
    url: `https://${HOST}/paid/article-1`,
    signatureAgent: SIG_AGENT,
    additionalHeaders: { "x-payment": xPayment },
  });
  const r = await fetch(signed);
  if (r.status !== 402) throw new Error(`expected 402, got ${r.status}`);
});

if (failures > 0) {
  console.error(`\n${failures} e2e check(s) failed`);
  process.exit(1);
} else {
  console.log("\nall e2e checks passed");
}
