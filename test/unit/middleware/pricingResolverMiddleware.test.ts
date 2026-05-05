// test/unit/middleware/pricingResolverMiddleware.test.ts
import { describe, it, expect } from "vitest";
import { pricingResolverMiddleware } from "@/middleware/pricingResolver";
import { runMiddleware } from "../../mocks/hono-context";
import type { TenantConfig } from "@/config/types";

const t: TenantConfig = {
  schema_version: 1, tenant_id: "t1", hostname: "blog.example.com",
  origin: "https://o", status: "active", default_action: "allow",
  facilitator_id: "coinbase-x402-base", payout_address: "0x",
  pricing_rules: [{ id: "r1", priority: 1, path_pattern: "/p", agent_pattern: "*", action: "allow", enabled: true }],
  config_version: 1, created_at: "x", updated_at: "x",
};

describe("pricingResolverMiddleware", () => {
  it("writes decision to ctx", async () => {
    const { vars } = await runMiddleware(
      pricingResolverMiddleware,
      new Request("https://blog.example.com/p"),
      {},
      { tenant: t, detection: null },
    );
    expect(vars.decision_state?.decision).toBe("allow");
    expect(vars.decision_state?.rule_id).toBe("r1");
  });

  it("skips on paused tenant", async () => {
    const initial = { decision: "status_paused" as const, decision_reason: null, rule_id: null, price_usdc: null, paid: false, payment_tx: null };
    const { vars } = await runMiddleware(
      pricingResolverMiddleware,
      new Request("https://blog.example.com/p"),
      {},
      { tenant: { ...t, status: "paused_by_publisher" }, detection: null, decision_state: initial },
    );
    // Decision is unchanged from what tenantResolver set
    expect(vars.decision_state?.decision).toBe("status_paused");
  });
});
