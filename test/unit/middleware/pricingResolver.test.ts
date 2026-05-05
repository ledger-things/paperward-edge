// test/unit/middleware/pricingResolver.test.ts
import { describe, it, expect } from "vitest";
import { resolvePricing } from "@/middleware/pricingResolver";
import type { TenantConfig } from "@/config/types";
import type { DetectionResult } from "@/detectors/types";

const baseTenant: TenantConfig = {
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

const human: DetectionResult = { agent_id: "human", signed: false, detector_id: "human", confidence: "high" };
const oai: DetectionResult = { agent_id: "signed:openai.com", signed: true, detector_id: "web-bot-auth", confidence: "high" };

describe("resolvePricing", () => {
  it("returns default_allow when no rules match", () => {
    const r = resolvePricing(baseTenant, human, "/foo");
    expect(r).toMatchObject({
      decision: "default_allow",
      rule_id: null,
      price_usdc: null,
    });
  });

  it("returns default block decision when default_action is block and no rules match", () => {
    const t = { ...baseTenant, default_action: "block" as const };
    const r = resolvePricing(t, oai, "/foo");
    expect(r.decision).toBe("block");
  });

  it("walks rules in ascending priority and first match wins", () => {
    const t: TenantConfig = {
      ...baseTenant,
      pricing_rules: [
        { id: "r1", priority: 100, path_pattern: "*", agent_pattern: "*", action: "allow", enabled: true },
        { id: "r2", priority: 1, path_pattern: "/articles/*", agent_pattern: "signed:*", action: "charge", price_usdc: "0.005", enabled: true },
      ],
    };
    const r = resolvePricing(t, oai, "/articles/foo");
    expect(r.decision).toBe("charge_no_payment"); // initial state; paywall will refine
    expect(r.rule_id).toBe("r2");
    expect(r.price_usdc).toBe("0.005");
  });

  it("skips disabled rules", () => {
    const t: TenantConfig = {
      ...baseTenant,
      pricing_rules: [
        { id: "r1", priority: 1, path_pattern: "*", agent_pattern: "signed:*", action: "charge", price_usdc: "0.005", enabled: false },
      ],
    };
    const r = resolvePricing(t, oai, "/foo");
    expect(r.decision).toBe("default_allow");
  });

  it("returns 'allow' decision when matching rule has action=allow", () => {
    const t: TenantConfig = {
      ...baseTenant,
      pricing_rules: [{ id: "r1", priority: 1, path_pattern: "*", agent_pattern: "human", action: "allow", enabled: true }],
    };
    const r = resolvePricing(t, human, "/foo");
    expect(r.decision).toBe("allow");
    expect(r.rule_id).toBe("r1");
  });

  it("returns 'block' decision when matching rule has action=block", () => {
    const t: TenantConfig = {
      ...baseTenant,
      pricing_rules: [{ id: "r1", priority: 1, path_pattern: "*", agent_pattern: "unknown", action: "block", enabled: true }],
    };
    const r = resolvePricing(t, null, "/foo");
    expect(r.decision).toBe("block");
  });

  it("emits would_* prefix on log_only status", () => {
    const t: TenantConfig = { ...baseTenant, status: "log_only" };
    const r = resolvePricing(t, human, "/foo");
    expect(r.decision).toBe("would_default_allow");
  });

  it("emits would_charge_no_payment for log_only when matching a charge rule (paywall refines later)", () => {
    const t: TenantConfig = {
      ...baseTenant,
      status: "log_only",
      pricing_rules: [{ id: "r1", priority: 1, path_pattern: "*", agent_pattern: "signed:*", action: "charge", price_usdc: "0.01", enabled: true }],
    };
    const r = resolvePricing(t, oai, "/foo");
    expect(r.decision).toBe("would_charge_no_payment"); // initial state; paywall will refine to would_charge_paid if verify succeeds
    expect(r.rule_id).toBe("r1");
    expect(r.price_usdc).toBe("0.01");
  });
});
