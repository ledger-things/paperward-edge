// test/unit/middleware/logger-queue.test.ts
//
// Verifies the optional BotEventV1 queue emit in buildLoggerMiddleware().
// Cases:
//   (a) no PAPERWARD_EVENTS binding → no-op (no throw, no emit)
//   (b) charge_paid with rail + facilitator_status → structured price + payment
//   (c) client.country / client.ua_hash / client.ip_hash populated from cf + headers

import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { TenantConfig } from "@/config/types";
import type { DetectionResult } from "@/detectors/types";
import { buildLoggerMiddleware } from "@/middleware/logger";
import type { DecisionState, Env, Vars } from "@/types";

const tenant: TenantConfig = {
  schema_version: 1,
  tenant_id: "t-queue-test",
  hostname: "example.com",
  origin: "https://o.example.com",
  status: "active",
  default_action: "allow",
  accepted_facilitators: [{ facilitator_id: "coinbase-x402-base", payout_address: "0xabc" }],
  pricing_rules: [],
  config_version: 1,
  created_at: "x",
  updated_at: "x",
};

type SeedVars = {
  detection?: DetectionResult;
  decision_state?: DecisionState;
  rail?: "base" | "solana";
  facilitator_status?: string;
};

function makeApp(seed: SeedVars = {}) {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();

  app.use("*", buildLoggerMiddleware());

  // Set up context vars after the logger middleware registers (it reads them after next())
  app.use("*", async (c, next) => {
    c.set("tenant", tenant);
    c.set(
      "detection",
      seed.detection ?? {
        agent_id: "signed:gptbot",
        signed: true,
        detector_id: "wba",
        confidence: "high",
      },
    );
    c.set(
      "decision_state",
      seed.decision_state ?? {
        decision: "allow",
        decision_reason: null,
        rule_id: null,
        price_usdc: null,
        paid: false,
        payment_tx: null,
      },
    );
    if (seed.rail !== undefined) c.set("rail", seed.rail);
    if (seed.facilitator_status !== undefined) c.set("facilitator_status", seed.facilitator_status);
    c.set("origin_status", 200);
    await next();
  });

  app.all("*", (c) => c.text("ok"));
  return app;
}

type RunOptions = {
  request?: Request;
  seed?: SeedVars;
};

async function runApp(
  env: Partial<Env>,
  opts: RunOptions = {},
): Promise<{ waitUntilTasks: Promise<unknown>[] }> {
  const app = makeApp(opts.seed);
  const waitUntilTasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      waitUntilTasks.push(p);
    },
    passThroughOnException() {},
  };
  const req =
    opts.request ??
    new Request("https://example.com/article", { headers: { host: "example.com" } });
  await app.fetch(req, env as Env, ctx as any);
  return { waitUntilTasks };
}

describe("loggerMiddleware — Queue emit", () => {
  it("does not emit when PAPERWARD_EVENTS binding is absent", async () => {
    const r2Put = vi.fn().mockResolvedValue(undefined);
    const r2 = { put: r2Put } as unknown as R2Bucket;
    const ae = { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset;

    const env = { R2_LOGS: r2, ANALYTICS: ae } as unknown as Partial<Env>;
    const { waitUntilTasks } = await runApp(env);
    await Promise.all(waitUntilTasks);

    // Only the R2 write task — no queue send task
    expect(r2Put).toHaveBeenCalledTimes(1);
  });

  it("emits structured price and payment for charge_paid with rail + facilitator_status", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const r2Put = vi.fn().mockResolvedValue(undefined);
    const r2 = { put: r2Put } as unknown as R2Bucket;
    const ae = { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset;
    const queue = { send } as unknown as Queue<unknown>;

    const env = {
      R2_LOGS: r2,
      ANALYTICS: ae,
      PAPERWARD_EVENTS: queue,
    } as unknown as Partial<Env>;

    const { waitUntilTasks } = await runApp(env, {
      seed: {
        decision_state: {
          decision: "charge_paid",
          decision_reason: null,
          rule_id: "rule-1",
          price_usdc: "0.005",
          paid: true,
          payment_tx: "0xdeadbeef",
        },
        rail: "base",
        facilitator_status: "success",
      },
    });
    await Promise.all(waitUntilTasks);

    expect(send).toHaveBeenCalledTimes(1);
    const event = send.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event.v).toBe(1);
    expect(event.decision).toBe("charge_paid");
    expect(event.price).toEqual({ amount: "0.005", currency: "USDC", rail: "base" });
    expect(event.payment).toEqual({ tx_id: "0xdeadbeef", facilitator_status: "success" });
    // agent_name is derived from agent_id ("signed:gptbot" → "gptbot").
    expect(event.agent_name).toBe("gptbot");
  });

  it("populates client.country / ua_hash / ip_hash from cf + headers", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const r2Put = vi.fn().mockResolvedValue(undefined);
    const r2 = { put: r2Put } as unknown as R2Bucket;
    const ae = { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset;
    const queue = { send } as unknown as Queue<unknown>;

    const env = {
      R2_LOGS: r2,
      ANALYTICS: ae,
      PAPERWARD_EVENTS: queue,
    } as unknown as Partial<Env>;

    // Build a Request whose `cf` property is populated (the Workers runtime
    // exposes geo info this way; in unit tests we attach it manually).
    const baseReq = new Request("https://example.com/article", {
      headers: {
        host: "example.com",
        "user-agent": "Mozilla/5.0 (test)",
        "cf-connecting-ip": "203.0.113.42",
      },
    });
    Object.defineProperty(baseReq, "cf", {
      value: { country: "DE", colo: "FRA" },
      enumerable: true,
    });

    const { waitUntilTasks } = await runApp(env, { request: baseReq });
    await Promise.all(waitUntilTasks);

    expect(send).toHaveBeenCalledTimes(1);
    const event = send.mock.calls[0]?.[0] as { client: Record<string, unknown> };
    expect(event.client.country).toBe("DE");
    // 16 hex chars (first half of SHA-256) — exact value not asserted to avoid
    // brittleness, but it must be present and a 16-char hex string.
    expect(typeof event.client.ua_hash).toBe("string");
    expect((event.client.ua_hash as string).length).toBe(16);
    expect(event.client.ua_hash as string).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof event.client.ip_hash).toBe("string");
    expect((event.client.ip_hash as string).length).toBe(16);
    expect(event.client.ip_hash as string).toMatch(/^[0-9a-f]{16}$/);
  });
});
