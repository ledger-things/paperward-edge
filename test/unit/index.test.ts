// test/unit/index.test.ts
import { describe, it, expect, vi } from "vitest";
import worker from "@/index";
import type { Env } from "@/types";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENV: "dev",
    ADMIN_HOSTNAME: "admin.test",
    HEALTH_HOSTNAME: "health.test",
    ADMIN_TOKEN: "secret",
    SENTRY_DSN: "",
    KV_DOMAINS: { get: vi.fn().mockResolvedValue(null), put: vi.fn() } as unknown as KVNamespace,
    KV_KEY_CACHE: { get: vi.fn(), put: vi.fn() } as unknown as KVNamespace,
    KV_AUDIT: { put: vi.fn() } as unknown as KVNamespace,
    R2_LOGS: { put: vi.fn().mockResolvedValue(undefined), head: vi.fn() } as unknown as R2Bucket,
    ANALYTICS: { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset,
    RATE_LIMITER: {} as unknown as DurableObjectNamespace,
    ...overrides,
  };
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };

describe("worker entry", () => {
  it("routes admin hostname to admin sub-app (401 for unauth admin call)", async () => {
    const r = await worker.fetch(
      new Request("https://admin.test/__admin/tenants/x"),
      makeEnv(),
      ctx as any,
    );
    expect(r.status).toBe(401);
  });

  it("routes health hostname to health sub-app", async () => {
    const r = await worker.fetch(new Request("https://health.test/version"), makeEnv(), ctx as any);
    expect(r.status).toBe(200);
  });

  it("routes everything else to tenant pipeline (503 for unknown tenant)", async () => {
    const r = await worker.fetch(
      new Request("https://random.example.com/foo"),
      makeEnv(),
      ctx as any,
    );
    expect(r.status).toBe(503);
  });
});
