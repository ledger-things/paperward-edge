// test/unit/middleware/logger.test.ts
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { buildLoggerMiddleware } from "@/middleware/logger";
import type { Env, Vars } from "@/types";
import type { TenantConfig } from "@/config/types";

const t: TenantConfig = {
  schema_version: 1,
  tenant_id: "t1",
  hostname: "blog.example.com",
  origin: "https://o.example.com",
  status: "active",
  default_action: "allow",
  accepted_facilitators: [{ facilitator_id: "coinbase-x402-base", payout_address: "0xabc" }],
  pricing_rules: [],
  config_version: 7,
  created_at: "x",
  updated_at: "x",
};

describe("logger middleware", () => {
  it("writes a LogEntry to R2 with correct fields", async () => {
    const r2Put = vi.fn().mockResolvedValue(undefined);
    const aeWrite = vi.fn();
    const r2 = { put: r2Put } as unknown as R2Bucket;
    const ae = { writeDataPoint: aeWrite } as unknown as AnalyticsEngineDataset;
    const env = { R2_LOGS: r2, ANALYTICS: ae } as unknown as Env;

    const app = new Hono<{ Bindings: Env; Variables: Vars }>();
    app.use("*", buildLoggerMiddleware());
    app.use("*", async (c, next) => {
      c.set("tenant", t);
      c.set("detection", {
        agent_id: "human",
        signed: false,
        detector_id: "human",
        confidence: "high",
      });
      c.set("decision_state", {
        decision: "allow",
        decision_reason: null,
        rule_id: null,
        price_usdc: null,
        paid: false,
        payment_tx: null,
      });
      c.set("origin_status", 200);
      await next();
    });
    app.all("*", (c) => c.text("ok"));

    const waitUntilTasks: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(p: Promise<unknown>) {
        waitUntilTasks.push(p);
      },
      passThroughOnException() {},
    };
    await app.fetch(new Request("https://blog.example.com/foo"), env, ctx as any);
    await Promise.all(waitUntilTasks);

    expect(r2Put).toHaveBeenCalledTimes(1);
    const [, body] = r2Put.mock.calls[0]!;
    const entry = JSON.parse((body as string).trim());
    expect(entry.tenant_id).toBe("t1");
    expect(entry.config_version).toBe(7);
    expect(entry.decision).toBe("allow");
    expect(entry.agent_id).toBe("human");
    expect(typeof entry.latency_ms).toBe("number");
    expect(aeWrite).toHaveBeenCalled();
  });

  it("logs decision: tenant_unknown when tenant is not set", async () => {
    const r2Put = vi.fn().mockResolvedValue(undefined);
    const r2 = { put: r2Put } as unknown as R2Bucket;
    const ae = { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset;
    const env = { R2_LOGS: r2, ANALYTICS: ae } as unknown as Env;

    const app = new Hono<{ Bindings: Env; Variables: Vars }>();
    app.use("*", buildLoggerMiddleware());
    app.use("*", async (c, next) => {
      c.set("decision_state", {
        decision: "tenant_unknown",
        decision_reason: "kv_miss",
        rule_id: null,
        price_usdc: null,
        paid: false,
        payment_tx: null,
      });
      c.set("origin_status", null);
      await next();
    });
    app.all("*", (c) => c.text("nope", 503));

    const waitUntilTasks: Promise<unknown>[] = [];
    const ctx = {
      waitUntil(p: Promise<unknown>) {
        waitUntilTasks.push(p);
      },
      passThroughOnException() {},
    };
    await app.fetch(new Request("https://ghost.example.com/foo"), env, ctx as any);
    await Promise.all(waitUntilTasks);
    expect(r2Put).toHaveBeenCalledTimes(1);
    const entry = JSON.parse((r2Put.mock.calls[0]?.[1] as string).trim());
    expect(entry.decision).toBe("tenant_unknown");
    expect(entry.tenant_id).toBe("");
  });
});
