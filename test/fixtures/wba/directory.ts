// test/fixtures/wba/directory.ts
//
// JSON shape Cloudflare/Stytch's web-bot-auth library expects from
// /.well-known/http-message-signatures-directory. The structure here matches
// the IETF draft revision pinned in package.json. If you bump web-bot-auth
// and tests fail with "directory schema mismatch," update this file to match
// the new draft.

import { FIXTURE_KEYS } from "./keys";

export const FIXTURE_DIRECTORY = {
  keys: [
    {
      kid: FIXTURE_KEYS.keyId,
      ...FIXTURE_KEYS.publicKeyJwk,
      use: "sig",
      alg: "EdDSA",
    },
  ],
};
