// test/unit/config/kv.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TenantConfigCache } from "@/config/kv";
import type { TenantConfig } from "@/config/types";

const SAMPLE: TenantConfig = {
  schema_version: 1,
  tenant_id: "00000000-0000-0000-0000-000000000001",
  hostname: "blog.example.com",
  origin: "https://internal.example.com",
  status: "active",
  default_action: "allow",
  facilitator_id: "coinbase-x402-base",
  payout_address: "0xabc",
  pricing_rules: [],
  config_version: 1,
  created_at: "2026-05-05T00:00:00Z",
  updated_at: "2026-05-05T00:00:00Z",
};

function mockKV(value: TenantConfig | null) {
  const get = vi.fn().mockResolvedValue(value === null ? null : JSON.stringify(value));
  return { get } as unknown as KVNamespace;
}

describe("TenantConfigCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-05T12:00:00Z"));
  });

  it("returns the config from KV on first lookup and caches it", async () => {
    const kv = mockKV(SAMPLE);
    const cache = new TenantConfigCache(kv);
    const r = await cache.get("blog.example.com");
    expect(r).toEqual(SAMPLE);
    expect((kv.get as any).mock.calls.length).toBe(1);

    const r2 = await cache.get("blog.example.com");
    expect(r2).toEqual(SAMPLE);
    expect((kv.get as any).mock.calls.length).toBe(1); // served from isolate cache
  });

  it("re-reads KV after the freshness window expires", async () => {
    const kv = mockKV(SAMPLE);
    const cache = new TenantConfigCache(kv);
    await cache.get("blog.example.com");

    vi.setSystemTime(new Date("2026-05-05T12:01:01Z")); // +61s
    await cache.get("blog.example.com");
    expect((kv.get as any).mock.calls.length).toBe(2);
  });

  it("returns null when KV has no entry for the hostname", async () => {
    const kv = mockKV(null);
    const cache = new TenantConfigCache(kv);
    const r = await cache.get("ghost.example.com");
    expect(r).toBeNull();
  });

  it("calls KV.get with cacheTtl: 60 (cf edge cache layer)", async () => {
    const kv = mockKV(SAMPLE);
    const cache = new TenantConfigCache(kv);
    await cache.get("blog.example.com");
    const opts = (kv.get as any).mock.calls[0][1];
    expect(opts).toMatchObject({ cacheTtl: 60 });
    expect((kv.get as any).mock.calls[0][0]).toBe("domains:blog.example.com");
  });

  it("falls back to a stale isolate-cache entry when KV times out", async () => {
    const kv = mockKV(SAMPLE);
    const cache = new TenantConfigCache(kv);
    await cache.get("blog.example.com"); // populate cache

    vi.setSystemTime(new Date("2026-05-05T12:05:00Z")); // +5min, stale
    (kv.get as any).mockRejectedValueOnce(new Error("kv_timeout"));

    const r = await cache.get("blog.example.com");
    expect(r).toEqual(SAMPLE); // served from stale cache
  });

  it("rethrows when KV times out and no stale cache exists", async () => {
    const kv = mockKV(SAMPLE);
    (kv.get as any).mockRejectedValueOnce(new Error("kv_timeout"));
    const cache = new TenantConfigCache(kv);

    await expect(cache.get("blog.example.com")).rejects.toThrow();
  });
});
