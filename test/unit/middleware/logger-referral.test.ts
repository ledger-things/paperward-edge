// test/unit/middleware/logger-referral.test.ts
//
// Verifies the CitationReferralV1 queue emit in buildLoggerMiddleware().
// Cases:
//   (a) Referer is chat.openai.com → CitationReferralV1 emitted to PAPERWARD_REFERRALS
//       and BotEventV1 still emitted to PAPERWARD_EVENTS
//   (b) No Referer header → no emit to PAPERWARD_REFERRALS
//   (c) PAPERWARD_REFERRALS binding absent → no emit (no throw)

import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { TenantConfig } from "@/config/types";
import type { DetectionResult } from "@/detectors/types";
import { buildLoggerMiddleware } from "@/middleware/logger";
import type { DecisionState, Env, Vars } from "@/types";

const tenant: TenantConfig = {
  schema_version: 1,
  tenant_id: "t-referral-test",
  hostname: "blog.example.com",
  origin: "https://o.example.com",
  status: "active",
  default_action: "allow",
  accepted_facilitators: [{ facilitator_id: "coinbase-x402-base", payout_address: "0xabc" }],
  pricing_rules: [],
  config_version: 1,
  created_at: "x",
  updated_at: "x",
};

const defaultDetection: DetectionResult = {
  agent_id: "human",
  signed: false,
  detector_id: "human",
  confidence: "high",
};

const defaultDecisionState: DecisionState = {
  decision: "allow",
  decision_reason: null,
  rule_id: null,
  price_usdc: null,
  paid: false,
  payment_tx: null,
};

function makeApp() {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();

  app.use("*", buildLoggerMiddleware());

  app.use("*", async (c, next) => {
    c.set("tenant", tenant);
    c.set("detection", defaultDetection);
    c.set("decision_state", defaultDecisionState);
    c.set("origin_status", 200);
    await next();
  });

  app.all("*", (c) => c.text("ok"));
  return app;
}

async function runApp(
  env: Partial<Env>,
  request: Request,
): Promise<{ waitUntilTasks: Promise<unknown>[] }> {
  const app = makeApp();
  const waitUntilTasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(p: Promise<unknown>) {
      waitUntilTasks.push(p);
    },
    passThroughOnException() {},
  };
  await app.fetch(request, env as Env, ctx as any);
  return { waitUntilTasks };
}

describe("loggerMiddleware — CitationReferralV1 emit", () => {
  it("emits CitationReferralV1 when Referer is chat.openai.com (and BotEventV1 still fires)", async () => {
    const referralSend = vi.fn().mockResolvedValue(undefined);
    const eventsSend = vi.fn().mockResolvedValue(undefined);
    const r2Put = vi.fn().mockResolvedValue(undefined);
    const r2 = { put: r2Put } as unknown as R2Bucket;
    const ae = { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset;

    const env: Partial<Env> = {
      R2_LOGS: r2,
      ANALYTICS: ae,
      PAPERWARD_REFERRALS: { send: referralSend } as unknown as Queue<unknown>,
      PAPERWARD_EVENTS: { send: eventsSend } as unknown as Queue<unknown>,
    };

    const req = new Request("https://blog.example.com/article", {
      headers: {
        host: "blog.example.com",
        referer: "https://chat.openai.com/c/abc123",
      },
    });

    const { waitUntilTasks } = await runApp(env, req);
    await Promise.all(waitUntilTasks);

    // CitationReferralV1 emitted to PAPERWARD_REFERRALS
    expect(referralSend).toHaveBeenCalledTimes(1);
    const referral = referralSend.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(referral.v).toBe(1);
    expect(referral.assistant).toBe("openai");
    expect(referral.referrer_host).toBe("chat.openai.com");
    expect(referral.landing_path).toBe("/article");
    expect(referral.hostname).toBe("blog.example.com");
    expect(typeof referral.event_id).toBe("string");
    expect(typeof referral.ts).toBe("string");
    expect(typeof referral.landing_url).toBe("string");
    expect((referral.landing_url as string)).toContain("/article");
    const client = referral.client as Record<string, unknown>;
    expect(typeof client.ua_hash).toBe("string");
    expect(typeof client.ip_hash).toBe("string");

    // BotEventV1 still emitted alongside
    expect(eventsSend).toHaveBeenCalledTimes(1);
  });

  it("does not emit to PAPERWARD_REFERRALS when Referer header is absent", async () => {
    const referralSend = vi.fn().mockResolvedValue(undefined);
    const r2Put = vi.fn().mockResolvedValue(undefined);
    const r2 = { put: r2Put } as unknown as R2Bucket;
    const ae = { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset;

    const env: Partial<Env> = {
      R2_LOGS: r2,
      ANALYTICS: ae,
      PAPERWARD_REFERRALS: { send: referralSend } as unknown as Queue<unknown>,
    };

    const req = new Request("https://blog.example.com/article", {
      headers: { host: "blog.example.com" },
    });

    const { waitUntilTasks } = await runApp(env, req);
    await Promise.all(waitUntilTasks);

    expect(referralSend).not.toHaveBeenCalled();
  });

  it("does not emit when PAPERWARD_REFERRALS binding is absent (even with matching Referer)", async () => {
    const r2Put = vi.fn().mockResolvedValue(undefined);
    const r2 = { put: r2Put } as unknown as R2Bucket;
    const ae = { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset;

    // No PAPERWARD_REFERRALS binding
    const env: Partial<Env> = {
      R2_LOGS: r2,
      ANALYTICS: ae,
    };

    const req = new Request("https://blog.example.com/article", {
      headers: {
        host: "blog.example.com",
        referer: "https://chat.openai.com/c/abc123",
      },
    });

    const { waitUntilTasks } = await runApp(env, req);
    // Should not throw
    await Promise.all(waitUntilTasks);

    // R2 write still happens; no referral queue send
    expect(r2Put).toHaveBeenCalledTimes(1);
  });
});
