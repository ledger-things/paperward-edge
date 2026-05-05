// test/unit/utils/bounded-fetch.test.ts
import { describe, it, expect, vi } from "vitest";
import { boundedFetch } from "@/utils/bounded-fetch";

describe("boundedFetch", () => {
  it("returns the response on a small successful fetch", async () => {
    const stub = vi.fn().mockResolvedValue(
      new Response("hello", { status: 200, headers: { "content-length": "5" } })
    );
    const r = await boundedFetch("https://example.com", { timeoutMs: 1000, maxBytes: 1024 }, stub);
    expect(r.ok).toBe(true);
    if (r.ok) expect(await r.body.text()).toBe("hello");
  });

  it("rejects responses with content-length above the cap", async () => {
    const stub = vi.fn().mockResolvedValue(
      new Response("x".repeat(100), { status: 200, headers: { "content-length": "100" } })
    );
    const r = await boundedFetch("https://example.com", { timeoutMs: 1000, maxBytes: 50 }, stub);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/too_large/i);
  });

  it("times out fetches that take too long", async () => {
    const stub = vi.fn().mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve(new Response("late")), 200))
    );
    const r = await boundedFetch("https://example.com", { timeoutMs: 50, maxBytes: 1024 }, stub);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/timeout/i);
  });

  it("does not follow redirects (passes redirect: 'manual')", async () => {
    const stub = vi.fn().mockResolvedValue(
      new Response(null, { status: 301, headers: { location: "https://elsewhere/" } })
    );
    const r = await boundedFetch("https://example.com", { timeoutMs: 1000, maxBytes: 1024 }, stub);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/redirect/i);
    expect(stub.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("rejects fetches that throw", async () => {
    const stub = vi.fn().mockRejectedValue(new Error("DNS failure"));
    const r = await boundedFetch("https://example.com", { timeoutMs: 1000, maxBytes: 1024 }, stub);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/fetch_failed/i);
  });
});
