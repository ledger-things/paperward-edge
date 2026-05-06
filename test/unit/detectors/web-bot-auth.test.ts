// test/unit/detectors/web-bot-auth.test.ts
import { describe, it, expect, vi } from "vitest";
import { WebBotAuthDetector } from "@/detectors/web-bot-auth";
import { signRequest } from "../../fixtures/wba/sign";
import { FIXTURE_DIRECTORY } from "../../fixtures/wba/directory";

function mockKeyCache() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
  } as unknown as KVNamespace;
}

function mockDirectoryFetch(directory: unknown = FIXTURE_DIRECTORY) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(directory), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(JSON.stringify(directory).length),
        },
      }),
  );
}

describe("WebBotAuthDetector", () => {
  it("returns signed:{operator} for a valid WBA-signed request", async () => {
    const fetchImpl = mockDirectoryFetch();
    const det = new WebBotAuthDetector({
      keyCache: mockKeyCache(),
      fetchImpl,
      now: () => Date.now(),
    });
    const req = await signRequest({ url: "https://blog.example.com/foo" });
    const r = await det.detect(req);
    expect(r).not.toBeNull();
    expect(r?.agent_id).toMatch(/^signed:test-agent\.local$/);
    expect(r?.signed).toBe(true);
    expect(r?.confidence).toBe("high");
  });

  it("returns null when WBA headers are missing", async () => {
    const det = new WebBotAuthDetector({
      keyCache: mockKeyCache(),
      fetchImpl: mockDirectoryFetch(),
      now: () => Date.now(),
    });
    const r = await det.detect(new Request("https://blog.example.com/foo"));
    expect(r).toBeNull();
  });

  it("returns null when Signature-Agent fails SSRF validation (private IP)", async () => {
    const det = new WebBotAuthDetector({
      keyCache: mockKeyCache(),
      fetchImpl: mockDirectoryFetch(),
      now: () => Date.now(),
    });
    const req = await signRequest({
      url: "https://blog.example.com/foo",
      signatureAgent: "https://192.168.1.1",
    });
    const r = await det.detect(req);
    expect(r).toBeNull();
  });

  it("returns null when @authority does not match request Host", async () => {
    const det = new WebBotAuthDetector({
      keyCache: mockKeyCache(),
      fetchImpl: mockDirectoryFetch(),
      now: () => Date.now(),
    });
    const req = await signRequest({ url: "https://blog.example.com/foo" });
    // Tamper: mutate the URL the detector sees so authority differs from what was signed
    const tampered = new Request("https://victim.com/foo", { headers: req.headers });
    const r = await det.detect(tampered);
    expect(r).toBeNull();
  });

  it("returns null when timestamp is outside ±60s window", async () => {
    const det = new WebBotAuthDetector({
      keyCache: mockKeyCache(),
      fetchImpl: mockDirectoryFetch(),
      now: () => Date.now(),
    });
    const req = await signRequest({ url: "https://blog.example.com/foo", createdSecondsAgo: 120 });
    const r = await det.detect(req);
    expect(r).toBeNull();
  });

  it("uses the KV cache on second call (no second fetch)", async () => {
    const fetchImpl = mockDirectoryFetch();
    const det = new WebBotAuthDetector({
      keyCache: mockKeyCache(),
      fetchImpl,
      now: () => Date.now(),
    });
    await det.detect(await signRequest({ url: "https://blog.example.com/foo" }));
    await det.detect(await signRequest({ url: "https://blog.example.com/bar" }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent in-flight key fetches within an isolate", async () => {
    let fetchCount = 0;
    const slowFetch = vi.fn(async () => {
      fetchCount++;
      await new Promise((r) => setTimeout(r, 30));
      return new Response(JSON.stringify(FIXTURE_DIRECTORY), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(JSON.stringify(FIXTURE_DIRECTORY).length),
        },
      });
    });
    const det = new WebBotAuthDetector({
      keyCache: mockKeyCache(),
      fetchImpl: slowFetch as unknown as typeof fetch,
      now: () => Date.now(),
    });
    await Promise.all([
      det.detect(await signRequest({ url: "https://blog.example.com/a" })),
      det.detect(await signRequest({ url: "https://blog.example.com/b" })),
      det.detect(await signRequest({ url: "https://blog.example.com/c" })),
    ]);
    expect(fetchCount).toBe(1);
  });

  it("returns null and writes negative cache when directory fetch fails", async () => {
    const cache = mockKeyCache();
    const failFetch = vi.fn(async () => new Response("nope", { status: 500 }));
    const det = new WebBotAuthDetector({
      keyCache: cache,
      fetchImpl: failFetch as unknown as typeof fetch,
      now: () => Date.now(),
    });
    const r = await det.detect(await signRequest({ url: "https://blog.example.com/foo" }));
    expect(r).toBeNull();
    // Negative cache entry written
    const putCalls = (cache.put as ReturnType<typeof vi.fn>).mock.calls;
    expect(putCalls.some((c: unknown[]) => String(c[1]).includes("negative"))).toBe(true);
  });

  it("priority is 10", () => {
    const det = new WebBotAuthDetector({
      keyCache: mockKeyCache(),
      fetchImpl: mockDirectoryFetch(),
      now: () => Date.now(),
    });
    expect(det.priority).toBe(10);
  });
});
