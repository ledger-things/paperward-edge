import { describe, it, expect } from "vitest";
import { validateSignatureAgentUrl } from "@/utils/safe-url";

describe("validateSignatureAgentUrl", () => {
  it("accepts a normal https URL on a public hostname", () => {
    const r = validateSignatureAgentUrl("https://openai.com/some/path");
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Path is forced to the well-known directory, not whatever the agent supplied
      expect(r.url).toBe("https://openai.com/.well-known/http-message-signatures-directory");
    }
  });

  it("rejects http://", () => {
    const r = validateSignatureAgentUrl("http://openai.com");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/scheme/i);
  });

  it("rejects file://, data:, javascript:", () => {
    expect(validateSignatureAgentUrl("file:///etc/passwd").ok).toBe(false);
    expect(validateSignatureAgentUrl("data:,foo").ok).toBe(false);
    expect(validateSignatureAgentUrl("javascript:alert(1)").ok).toBe(false);
  });

  it("rejects IPv4 literals (public and private)", () => {
    expect(validateSignatureAgentUrl("https://10.0.0.1/").ok).toBe(false);
    expect(validateSignatureAgentUrl("https://192.168.1.1/").ok).toBe(false);
    expect(validateSignatureAgentUrl("https://127.0.0.1/").ok).toBe(false);
    expect(validateSignatureAgentUrl("https://1.1.1.1/").ok).toBe(false);
  });

  it("rejects IPv6 literals", () => {
    expect(validateSignatureAgentUrl("https://[::1]/").ok).toBe(false);
    expect(validateSignatureAgentUrl("https://[fe80::1]/").ok).toBe(false);
    expect(validateSignatureAgentUrl("https://[2001:db8::1]/").ok).toBe(false);
  });

  it("rejects hostnames without a public TLD", () => {
    expect(validateSignatureAgentUrl("https://localhost/").ok).toBe(false);
    expect(validateSignatureAgentUrl("https://internal/").ok).toBe(false);
    expect(validateSignatureAgentUrl("https://x/").ok).toBe(false);
  });

  it("rejects malformed URLs", () => {
    expect(validateSignatureAgentUrl("not a url").ok).toBe(false);
    expect(validateSignatureAgentUrl("").ok).toBe(false);
  });

  it("forces the path to the well-known directory regardless of input", () => {
    const r = validateSignatureAgentUrl("https://openai.com/whatever/the/agent/sent");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url).toBe("https://openai.com/.well-known/http-message-signatures-directory");
    }
  });

  it("preserves nonstandard ports if explicitly given", () => {
    const r = validateSignatureAgentUrl("https://openai.com:8443/x");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url).toBe("https://openai.com:8443/.well-known/http-message-signatures-directory");
    }
  });
});
