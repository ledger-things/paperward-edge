// test/unit/health/index.test.ts
import { describe, it, expect, vi } from "vitest";
import { buildHealthApp } from "@/health/index";
import type { Env } from "@/types";

describe("health endpoints", () => {
  it("GET /healthz returns 200 with build info", async () => {
    const env = {
      ENV: "staging",
      KV_DOMAINS: { get: vi.fn().mockResolvedValue(null) } as unknown as KVNamespace,
      R2_LOGS: { head: vi.fn().mockResolvedValue(null) } as unknown as R2Bucket,
    } as unknown as Env;
    const app = buildHealthApp("abc123");
    const r = await app.fetch(new Request("https://x/healthz"), env);
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.build_sha).toBe("abc123");
    expect(body.env).toBe("staging");
    expect(body.kv_ok).toBe(true);
  });

  it("GET /version returns build SHA only", async () => {
    const app = buildHealthApp("abc123");
    const r = await app.fetch(new Request("https://x/version"), {} as Env);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("abc123");
  });
});
