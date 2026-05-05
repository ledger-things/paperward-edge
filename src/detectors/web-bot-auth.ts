// src/detectors/web-bot-auth.ts
//
// Tier-1 detector: verifies an inbound request's RFC 9421 HTTP message
// signature using the keys advertised by the agent's well-known directory.
// Implements the full §6.2 flow:
//   1. Header presence
//   2. Signature-Agent SSRF validation
//   3. Public-key fetch with KV cache (positive 1h, negative 60s) + in-flight dedupe
//   4. Ed25519 signature verification (delegated to the web-bot-auth lib)
//   5. @authority matching against the original request Host (enforced by the
//      crypto primitive: the verifier rebuilds signed data from the actual URL,
//      so a tampered Host produces a signature mismatch and verify() throws)
//   6. created-timestamp window check (±60s)
//
// API adaptation note (web-bot-auth@0.1.x):
//   The library does NOT expose a `verifySignature(req, directory)` helper.
//   Instead it exports:
//     - verify(message, verifierFn)  — wraps http-message-sig verify with
//       tag/"web-bot-auth", created-in-future, and expires checks
//     - verifierFromJWK(jwk)         — from the `crypto` sub-module; builds
//       a verifier callback from a JsonWebKey
//   Our wrapper looks up the key by keyid from the directory, builds a
//   verifierFromJWK callback, and passes it to verify(). Everything else
//   (SSRF, time-skew, cache) is enforced here.

import type { Detector, DetectionResult } from "@/detectors/types";
import { validateSignatureAgentUrl } from "@/utils/safe-url";
import { boundedFetch } from "@/utils/bounded-fetch";
// The web-bot-auth package exports verify() from the main entry point and
// verifierFromJWK from the crypto sub-module (both CommonJS-compatible).
import { verify as wbaVerify } from "web-bot-auth";
import { verifierFromJWK } from "web-bot-auth/crypto";

const POSITIVE_TTL_S = 60 * 60;
const NEGATIVE_TTL_S = 60;
const TIMESTAMP_WINDOW_S = 60;
const FETCH_TIMEOUT_MS = 5_000;
const FETCH_MAX_BYTES = 64 * 1024;

type DirectoryKey = { kid?: string } & JsonWebKey;
type Directory = { keys: DirectoryKey[] };
type CacheValue =
  | { kind: "positive"; directory: Directory; expires_ms: number }
  | { kind: "negative"; reason: string; expires_ms: number };

export type WebBotAuthDeps = {
  keyCache: KVNamespace;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export class WebBotAuthDetector implements Detector {
  readonly id = "web-bot-auth";
  readonly priority = 10;

  // Instance-scoped: each isolate / detector instance has its own dedupe map.
  private readonly inflight = new Map<string, Promise<CacheValue>>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly deps: WebBotAuthDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? (() => Date.now());
  }

  async detect(req: Request): Promise<DetectionResult | null> {
    // Step 1: Header presence
    const sig = req.headers.get("signature");
    const sigInput = req.headers.get("signature-input");
    const sigAgent = req.headers.get("signature-agent");
    if (!sig || !sigInput || !sigAgent) return null;

    // Step 2: SSRF-validate the Signature-Agent URL
    const sigAgentValid = validateSignatureAgentUrl(sigAgent);
    if (!sigAgentValid.ok) {
      this.warn("signature_agent_invalid", { reason: sigAgentValid.reason });
      return null;
    }
    const directoryUrl = sigAgentValid.url;

    // Step 3: Fetch (or retrieve from cache) the operator's key directory
    const dirResult = await this.getDirectory(directoryUrl);
    if (dirResult.kind !== "positive") return null;

    // Step 4: Cryptographic verification via web-bot-auth
    // The verifier callback receives (data, signature, params) from the library.
    // We look up the key by params.keyid in the directory, then verify the
    // Ed25519 signature. The library's verify() also enforces:
    //   - tag === "web-bot-auth"
    //   - created is not in the future
    //   - signature has not expired
    // Authority integrity is implicit: the library rebuilds the signed data from
    // the ACTUAL request URL, so a tampered authority causes a signature mismatch.
    try {
      await wbaVerify(req, async (data, signature, params) => {
        const keyEntry = dirResult.directory.keys.find(k => k.kid === params.keyid);
        if (!keyEntry) {
          throw new Error(`key not found in directory: ${params.keyid}`);
        }
        const vfn = await verifierFromJWK(keyEntry);
        return vfn(data, signature, params);
      });
    } catch (err) {
      this.warn("verify_failed", { reason: String(err) });
      return null;
    }

    // Step 6: created-timestamp window check (±60s)
    // We extract `created=` from the Signature-Input header ourselves so that
    // we can apply our own stricter window policy independent of the library's
    // expires-based expiry.
    const createdMatch = sigInput.match(/created=(\d+)/);
    if (!createdMatch || !createdMatch[1]) return null;
    const createdSec = Number(createdMatch[1]);
    const nowSec = Math.floor(this.now() / 1000);
    if (Math.abs(nowSec - createdSec) > TIMESTAMP_WINDOW_S) return null;

    // Step 7: Build result — operator is the hostname of the validated directory URL
    const operator = new URL(directoryUrl).hostname;
    return {
      agent_id: `signed:${operator}`,
      signed: true,
      detector_id: this.id,
      confidence: "high",
    };
  }

  private async getDirectory(directoryUrl: string): Promise<CacheValue> {
    const key = `keycache:${directoryUrl}`;

    // KV cache read (Cloudflare edge-cache TTL = NEGATIVE_TTL_S so short-lived
    // negatives are evicted quickly; the in-process expires_ms check handles
    // the positive-TTL boundary independently of KV's own eviction).
    const cached = await this.deps.keyCache.get(key, { cacheTtl: NEGATIVE_TTL_S } as KVNamespaceGetOptions<"text">);
    if (cached) {
      const parsed = JSON.parse(cached) as CacheValue;
      if (parsed.expires_ms > this.now()) return parsed;
      // Expired in-process; fall through and refetch.
    }

    // In-flight dedupe: if another concurrent call is already fetching this
    // directory, await its result instead of issuing a second outbound request.
    const existing = this.inflight.get(directoryUrl);
    if (existing) return existing;

    const fetchPromise = this.doFetchDirectory(directoryUrl, key);
    this.inflight.set(directoryUrl, fetchPromise);
    try {
      return await fetchPromise;
    } finally {
      this.inflight.delete(directoryUrl);
    }
  }

  private async doFetchDirectory(directoryUrl: string, kvKey: string): Promise<CacheValue> {
    const fetched = await boundedFetch(
      directoryUrl,
      { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: FETCH_MAX_BYTES },
      this.fetchImpl,
    );

    if (!fetched.ok) {
      const neg: CacheValue = {
        kind: "negative",
        reason: fetched.reason,
        expires_ms: this.now() + NEGATIVE_TTL_S * 1000,
      };
      await this.deps.keyCache.put(kvKey, JSON.stringify(neg), { expirationTtl: NEGATIVE_TTL_S });
      return neg;
    }

    let directory: Directory;
    try {
      const text = await fetched.body.text();
      directory = JSON.parse(text) as Directory;
    } catch {
      const neg: CacheValue = {
        kind: "negative",
        reason: "directory_parse_failed",
        expires_ms: this.now() + NEGATIVE_TTL_S * 1000,
      };
      await this.deps.keyCache.put(kvKey, JSON.stringify(neg), { expirationTtl: NEGATIVE_TTL_S });
      return neg;
    }

    const pos: CacheValue = {
      kind: "positive",
      directory,
      expires_ms: this.now() + POSITIVE_TTL_S * 1000,
    };
    await this.deps.keyCache.put(kvKey, JSON.stringify(pos), { expirationTtl: POSITIVE_TTL_S });
    return pos;
  }

  private warn(event: string, data: Record<string, unknown>): void {
    console.warn(JSON.stringify({ at: "WebBotAuthDetector", event, ...data }));
  }
}
