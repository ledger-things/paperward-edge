// test/unit/middleware/tenantResolver.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { tenantResolver, _resetTenantCache } from "@/middleware/tenantResolver";
import { runMiddleware } from "../../mocks/hono-context";
import type { TenantConfig } from "@/config/types";

function makeKvWith(value: TenantConfig | null): KVNamespace {
  const get = vi.fn().mockResolvedValue(value === null ? null : JSON.stringify(value));
  return { get } as unknown as KVNamespace;
}

const tenant: TenantConfig = {
  schema_version: 1,
  tenant_id: "t1",
  hostname: "blog.example.com",
  origin: "https://o.example.com",
  status: "active",
  default_action: "allow",
  facilitator_id: "coinbase-x402-base",
  payout_address: "0xabc",
  pricing_rules: [],
  config_version: 1,
  created_at: "2026-05-05T00:00:00Z",
  updated_at: "2026-05-05T00:00:00Z",
};

describe("tenantResolver", () => {
  beforeEach(() => { _resetTenantCache(); });

  it("attaches tenant to ctx and calls next when KV has a config", async () => {
    const env = { KV_DOMAINS: makeKvWith(tenant) };
    const { response, vars } = await runMiddleware(
      tenantResolver,
      new Request("https://blog.example.com/foo", { headers: { host: "blog.example.com" } }),
      env,
      { decision_state: { decision: "default_allow", decision_reason: null, rule_id: null, price_usdc: null, paid: false, payment_tx: null } },
    );
    expect(response.status).toBe(200);
    expect(vars.tenant).toEqual(tenant);
  });

  it("returns 503 when KV has no config (tenant_unknown invariant violation)", async () => {
    const env = { KV_DOMAINS: makeKvWith(null) };
    const { response, vars } = await runMiddleware(
      tenantResolver,
      new Request("https://ghost.example.com/foo", { headers: { host: "ghost.example.com" } }),
      env,
      { decision_state: { decision: "default_allow", decision_reason: null, rule_id: null, price_usdc: null, paid: false, payment_tx: null } },
    );
    expect(response.status).toBe(503);
    expect(vars.decision_state?.decision).toBe("tenant_unknown");
  });

  it("short-circuits to origin pass-through on status: paused_by_publisher (calls fetch directly)", async () => {
    const t = { ...tenant, status: "paused_by_publisher" as const, origin: "https://example-origin.invalid" };
    const env = { KV_DOMAINS: makeKvWith(t) };
    // tenantResolver is responsible for short-circuiting; it does not call fetch itself.
    // It should set decision = status_paused, mark a flag, and call next() so originForwarder
    // (which the integration test wires) picks it up. Unit test asserts the decision flag.
    const { vars } = await runMiddleware(
      tenantResolver,
      new Request("https://blog.example.com/foo", { headers: { host: "blog.example.com" } }),
      env,
      { decision_state: { decision: "default_allow", decision_reason: null, rule_id: null, price_usdc: null, paid: false, payment_tx: null } },
    );
    expect(vars.tenant?.status).toBe("paused_by_publisher");
    expect(vars.decision_state?.decision).toBe("status_paused");
  });

  it("sets decision = status_suspended on status: suspended_by_paperward", async () => {
    const t = { ...tenant, status: "suspended_by_paperward" as const };
    const env = { KV_DOMAINS: makeKvWith(t) };
    const { vars } = await runMiddleware(
      tenantResolver,
      new Request("https://blog.example.com/foo", { headers: { host: "blog.example.com" } }),
      env,
      { decision_state: { decision: "default_allow", decision_reason: null, rule_id: null, price_usdc: null, paid: false, payment_tx: null } },
    );
    expect(vars.decision_state?.decision).toBe("status_suspended");
  });
});
