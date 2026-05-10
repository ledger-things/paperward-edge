// src/utils/hash.ts
//
// Helpers for short SHA-256 fingerprints used in BotEventV1 enrichment.
// `crypto.subtle.digest` is available globally in the Workers runtime — no
// imports required.

/**
 * Returns the first 16 hex chars of SHA-256(input). Returns `undefined` when
 * the input is `undefined`/empty so callers can spread/forward straight into
 * optional fields under `exactOptionalPropertyTypes`.
 */
export async function shortHash(input: string | undefined): Promise<string | undefined> {
  if (!input) return undefined;
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 16);
}
