// test/unit/middleware/originForwarder.test.ts
import { describe, it, expect, vi } from "vitest";
import { buildOriginForwarder } from "@/middleware/originForwarder";
import { Hono } from "hono";
import type { Env, Vars } from "@/types";
import type { TenantConfig } from "@/config/types";

const t: TenantConfig = {
  schema_version: 1,
  tenant_id: "t1",
  hostname: "blog.example.com",
  origin: "https://origin.example.com",
  status: "active",
  default_action: "allow",
  facilitator_id: "coinbase-x402-base",
  payout_address: "0xabc",
  pricing_rules: [],
  config_version: 1,
  created_at: "x",
  updated_at: "x",
};

function setup(opts: {
  fetchImpl: typeof fetch;
  initialDecision: string;
  tenantStatus?: TenantConfig["status"];
}) {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();
  const tenant = { ...t, status: opts.tenantStatus ?? t.status };
  app.use("*", async (c, next) => {
    c.set("tenant", tenant);
    c.set("decision_state", {
      decision: opts.initialDecision as any,
      decision_reason: null,
      rule_id: null,
      price_usdc: null,
      paid: false,
      payment_tx: null,
    });
    c.set("origin_status", null);
    await next();
  });
  app.all("*", buildOriginForwarder(opts.fetchImpl));
  return app;
}

describe("originForwarder", () => {
  it("forwards GET to origin and streams response", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toBe("https://origin.example.com/foo?x=1");
      return new Response("hello", { status: 200, headers: { "x-from-origin": "yes" } });
    });
    const app = setup({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      initialDecision: "allow",
    });
    const r = await app.fetch(new Request("https://blog.example.com/foo?x=1"), {} as Env);
    expect(r.status).toBe(200);
    expect(r.headers.get("x-from-origin")).toBe("yes");
    expect(await r.text()).toBe("hello");
  });

  it("strips X-PAYMENT, Signature*, X-Paperward-* from inbound; adds X-Paperward-* and X-Forwarded-*", async () => {
    let captured: Headers = new Headers();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Headers(init?.headers);
      return new Response("ok", { status: 200 });
    });
    const app = setup({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      initialDecision: "charge_no_payment",
    });
    await app.fetch(
      new Request("https://blog.example.com/foo", {
        headers: {
          "x-payment": "secret",
          signature: "secret",
          "signature-input": "secret",
          "signature-agent": "https://agent.com",
          "x-paperward-foo": "should be stripped",
          "user-agent": "Mozilla/5.0",
        },
      }),
      {} as Env,
    );
    expect(captured.get("x-payment")).toBeNull();
    expect(captured.get("signature")).toBeNull();
    expect(captured.get("signature-input")).toBeNull();
    expect(captured.get("signature-agent")).toBeNull();
    expect(captured.get("x-paperward-foo")).toBeNull();
    expect(captured.get("user-agent")).toBe("Mozilla/5.0");
    expect(captured.get("x-paperward-tenant-id")).toBe("t1");
    expect(captured.get("x-paperward-decision")).toBe("charge_no_payment");
    expect(captured.get("x-forwarded-proto")).toBe("https");
  });

  it("returns 502 when fetch throws and tags charge_origin_failed for charge paths", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("dns down");
    });
    const app = setup({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      initialDecision: "charge_no_payment",
    });
    const r = await app.fetch(new Request("https://blog.example.com/foo"), {} as Env);
    expect(r.status).toBe(502);
  });

  it("tags charge_origin_failed when origin returns 5xx (charge path)", async () => {
    let capturedDecision = "";
    const fetchImpl = vi.fn(async () => new Response("oops", { status: 503 }));
    const app = new Hono<{ Bindings: Env; Variables: Vars }>();
    app.use("*", async (c, next) => {
      c.set("tenant", t);
      c.set("decision_state", {
        decision: "charge_no_payment",
        decision_reason: null,
        rule_id: null,
        price_usdc: "0.005",
        paid: false,
        payment_tx: null,
      });
      c.set("origin_status", null);
      await next();
      capturedDecision = c.var.decision_state.decision;
    });
    app.all("*", buildOriginForwarder(fetchImpl as unknown as typeof fetch));
    const r = await app.fetch(new Request("https://blog.example.com/foo"), {} as Env);
    expect(r.status).toBe(503);
    expect(capturedDecision).toBe("charge_origin_failed");
  });
});
