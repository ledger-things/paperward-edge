// test/fixtures/wba/keys.ts
//
// Pre-baked Ed25519 keypair used by tests. Generated once and committed.
// Public key is exposed via the fixture directory in directory.ts; the
// signing helper in sign.ts uses the private key to produce signed requests.
//
// To regenerate (rare): run `tsx test/fixtures/wba/keys.ts > /tmp/keys` and
// paste the output back into this file.

export const FIXTURE_KEYS = {
  publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: "7xC4LIQbAVOmg59vK4mXXRzdCGqbeY0cH21QylpTP6U" },
  privateKeyPkcs8Base64: "MC4CAQAwBQYDK2VwBCIEINSXSac2O1WWIXgNchs0sjlP19tlPicHvFlIReOuMP4S",
  keyId: "paperward-test-key-1",
  operator: "test-agent.local",
};

if (import.meta.url === `file://${process.argv[1]}`) {
  // Regen mode: print a fresh keypair to stdout in JSON for copy-paste.
  const { subtle } = await import("node:crypto");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const kp = (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as any;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  const pubJwk = await subtle.exportKey("jwk", kp.publicKey);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  const privPkcs8 = await subtle.exportKey("pkcs8", kp.privateKey);
  const privBase64 = Buffer.from(privPkcs8 as ArrayBuffer).toString("base64");
  console.log(JSON.stringify({ publicKeyJwk: pubJwk, privateKeyPkcs8Base64: privBase64 }, null, 2));
}
