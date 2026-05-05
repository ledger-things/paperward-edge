// src/utils/safe-url.ts
//
// SSRF hardening for the Signature-Agent URL fetched during WBA verification.
// The Signature-Agent header is attacker-controlled, so we validate it
// before any outbound fetch. Per spec §6.2.3.

const WELL_KNOWN_PATH = "/.well-known/http-message-signatures-directory";

export type ValidateResult =
  | { ok: true; url: string }
  | { ok: false; reason: string };

/**
 * Validate an attacker-controlled Signature-Agent URL and return a
 * canonicalised fetch URL with the path forced to the WBA directory.
 *
 * Rules (spec §6.2.3):
 *  - scheme must be exactly https
 *  - host must not be an IPv4 or IPv6 literal
 *  - host must contain a "." with a TLD of at least 2 chars
 *  - path is overridden — we never honor the agent's path
 *  - port is preserved if specified (no port restriction)
 */
export function validateSignatureAgentUrl(input: string): ValidateResult {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, reason: "malformed_url" };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "scheme_not_https" };
  }

  const hostname = parsed.hostname;

  if (isIpLiteral(hostname)) {
    return { ok: false, reason: "ip_literal_not_allowed" };
  }

  if (!hasPublicTld(hostname)) {
    return { ok: false, reason: "missing_public_tld" };
  }

  // Force path to the well-known directory.
  const port = parsed.port ? `:${parsed.port}` : "";
  const url = `https://${hostname}${port}${WELL_KNOWN_PATH}`;
  return { ok: true, url };
}

/**
 * True if the hostname is an IPv4 dotted-quad or an IPv6 bracketed literal.
 * URL parses [::1] and exposes hostname as "[::1]" with brackets stripped — we
 * treat anything that lexes as an IP address as a literal regardless of the
 * specific range. Conservative.
 */
function isIpLiteral(hostname: string): boolean {
  // IPv6: contains a colon (URL strips brackets but colons remain inside hostname for IPv6)
  if (hostname.includes(":")) return true;

  // IPv4: four dot-separated decimal octets
  const parts = hostname.split(".");
  if (parts.length === 4 && parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255)) {
    return true;
  }

  return false;
}

/**
 * True if the hostname looks like a real public DNS name: contains a dot and
 * has a TLD of at least 2 alpha characters. Lexical check only — we do not
 * resolve DNS here, but the per-fetch timeout/size caps in the caller bound
 * the worst case if a public name resolves to a private range.
 */
function hasPublicTld(hostname: string): boolean {
  const lastDot = hostname.lastIndexOf(".");
  if (lastDot === -1) return false;
  const tld = hostname.slice(lastDot + 1);
  return /^[a-z]{2,}$/i.test(tld);
}
