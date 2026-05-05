// test/fixtures/wba/sign.ts
//
// Produces a Request with the WBA Signature, Signature-Input, and
// Signature-Agent headers populated using the fixture private key.
// We sign over @authority, @method, @path, @target-uri, and the
// `created` parameter, matching the components verified by the
// web-bot-auth library.

import { subtle } from "node:crypto";
import { FIXTURE_KEYS } from "./keys";

type SignOptions = {
  url: string;
  method?: string;
  signatureAgent?: string;
  createdSecondsAgo?: number;
  additionalHeaders?: Record<string, string>;
};

export async function signRequest(opts: SignOptions): Promise<Request> {
  const url = new URL(opts.url);
  const method = (opts.method ?? "GET").toUpperCase();
  const created = Math.floor(Date.now() / 1000) - (opts.createdSecondsAgo ?? 0);
  const signatureAgent = opts.signatureAgent ?? `https://${FIXTURE_KEYS.operator}`;

  const components = [
    `"@method": ${method}`,
    `"@authority": ${url.host}`,
    `"@path": ${url.pathname}`,
    `"@target-uri": ${url.toString()}`,
    `"@signature-params": ("@method" "@authority" "@path" "@target-uri");keyid="${FIXTURE_KEYS.keyId}";created=${created};alg="ed25519"`,
  ].join("\n");

  const privBytes = Buffer.from(FIXTURE_KEYS.privateKeyPkcs8Base64, "base64") as unknown as ArrayBuffer;
  const privKey = await subtle.importKey(
    "pkcs8",
    privBytes,
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  // Cast needed: node:crypto subtle.sign types clash with @cloudflare/workers-types BufferSource
  const msgBytes = new TextEncoder().encode(components) as unknown as ArrayBuffer;
  const sigBytes = await subtle.sign({ name: "Ed25519" }, privKey, msgBytes);
  const sigB64 = Buffer.from(sigBytes).toString("base64");

  const headers = new Headers(opts.additionalHeaders);
  headers.set(
    "signature-input",
    `sig1=("@method" "@authority" "@path" "@target-uri");keyid="${FIXTURE_KEYS.keyId}";created=${created};alg="ed25519"`,
  );
  headers.set("signature", `sig1=:${sigB64}:`);
  headers.set("signature-agent", signatureAgent);

  return new Request(opts.url, { method, headers });
}
