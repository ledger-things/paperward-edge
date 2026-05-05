// src/middleware/pricingResolver.ts
//
// Pure function (with a thin Hono adapter) that walks the pricing rules and
// returns the initial DecisionState. The paywall middleware refines the
// decision afterward (charge_no_payment → charge_verify_failed → charge_paid
// etc.) but the resolver sets the starting point.

import type { TenantConfig } from "@/config/types";
import type { DetectionResult } from "@/detectors/types";
import type { DecisionState, Env, Vars } from "@/types";
import { matchPath, matchAgent } from "@/utils/patterns";
import type { Decision } from "@/logging/types";
import type { MiddlewareHandler } from "hono";

export function resolvePricing(
  tenant: TenantConfig,
  detection: DetectionResult | null,
  path: string,
): DecisionState {
  const rules = [...tenant.pricing_rules]
    .filter(r => r.enabled)
    .sort((a, b) => a.priority - b.priority);

  for (const rule of rules) {
    if (!matchPath(rule.path_pattern, path)) continue;
    if (!matchAgent(rule.agent_pattern, detection?.agent_id ?? null)) continue;

    return {
      decision: initialChargeDecisionForRule(rule.action, tenant.status),
      decision_reason: null,
      rule_id: rule.id,
      price_usdc: rule.price_usdc ?? null,
      paid: false,
      payment_tx: null,
    };
  }

  // No rule matched — apply default_action
  const def = tenant.default_action;
  return {
    decision:
      tenant.status === "log_only"
        ? def === "allow"
          ? "would_default_allow"
          : "would_block"
        : def === "allow"
          ? "default_allow"
          : "block",
    decision_reason: null,
    rule_id: null,
    price_usdc: null,
    paid: false,
    payment_tx: null,
  };
}

function initialChargeDecisionForRule(
  action: "charge" | "allow" | "block",
  status: TenantConfig["status"],
): Decision {
  if (action === "allow") return status === "log_only" ? "would_allow" : "allow";
  if (action === "block") return status === "log_only" ? "would_block" : "block";
  // action === "charge" — initial state assumes no payment header; paywall refines.
  // Initialize to charge_no_payment and let paywall upgrade to charge_paid on
  // settle success. That matches the "happy path is a final upgrade" model.
  return status === "log_only" ? "would_charge_no_payment" : "charge_no_payment";
}

export const pricingResolverMiddleware: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (c, next) => {
  const tenant = c.var.tenant;
  if (!tenant || tenant.status === "paused_by_publisher" || tenant.status === "suspended_by_paperward") {
    await next();
    return;
  }
  const path = new URL(c.req.url).pathname;
  const decision = resolvePricing(tenant, c.var.detection, path);
  c.set("decision_state", decision);

  // Enforce block decisions immediately — do not forward to origin.
  // (log_only mode produces would_block which still forwards; block is active enforcement.)
  if (decision.decision === "block") {
    return c.text("Forbidden", 403);
  }

  await next();
};
