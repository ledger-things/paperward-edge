// test/fixtures/wba/sign.ts
//
// Produces a Request with the WBA Signature, Signature-Input, and
// Signature-Agent headers populated using the fixture private key.
// We sign over @authority, @method, @path, @target-uri, and the
// `created` parameter, matching the components verified by the
// web-bot-auth library.
//
// The Signature-Input includes `expires` and `tag="web-bot-auth"` because
// the web-bot-auth@0.1.x `verify()` wrapper checks both:
//   - params.expires.getTime() (throws if expires is missing)
//   - params.tag !== "web-bot-auth" (throws if tag is wrong)

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
  // expires = 5 minutes after created; still valid even if request is slightly stale
  const expires = created + 300;
  const signatureAgent = opts.signatureAgent ?? `https://${FIXTURE_KEYS.operator}`;

  // Signature-Input parameter string — must match what we sign over
  const sigParamStr = `("@method" "@authority" "@path" "@target-uri");keyid="${FIXTURE_KEYS.keyId}";created=${created};expires=${expires};alg="ed25519";tag="web-bot-auth"`;

  const components = [
    `"@method": ${method}`,
    `"@authority": ${url.host}`,
    `"@path": ${url.pathname}`,
    `"@target-uri": ${url.toString()}`,
    `"@signature-params": ${sigParamStr}`,
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
  headers.set("signature-input", `sig1=${sigParamStr}`);
  headers.set("signature", `sig1=:${sigB64}:`);
  headers.set("signature-agent", signatureAgent);

  return new Request(opts.url, { method, headers });
}
