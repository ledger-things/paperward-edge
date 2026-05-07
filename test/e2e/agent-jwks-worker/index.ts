// test/e2e/agent-jwks-worker/index.ts
//
// Standalone tiny Worker that hosts the WBA JWKS for the e2e test fixture.
// Lives in its own deployment (paperward-agent-jwks-staging) so the main
// edge Worker can fetch its public key directory without hitting the
// Worker-to-itself self-loop limitation that returns 522 on the same script.
//
// Public JWK MUST match test/fixtures/wba/keys.ts FIXTURE_KEYS.publicKeyJwk.

const JWKS = {
  keys: [
    {
      kid: "paperward-test-key-1",
      kty: "OKP",
      crv: "Ed25519",
      x: "7xC4LIQbAVOmg59vK4mXXRzdCGqbeY0cH21QylpTP6U",
      use: "sig",
      alg: "EdDSA",
    },
  ],
};

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/.well-known/http-message-signatures-directory") {
      return new Response(JSON.stringify(JWKS), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("Not Found", { status: 404 });
  },
};
