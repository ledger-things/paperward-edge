// src/middleware/paywall.ts
//
// Paywall middleware. Implements spec §5.4 (pre-origin) and §5.6 (post-origin).
//
// The middleware honors active and log_only statuses. It is a no-op for
// pause/suspended (those don't reach a charge decision because tenantResolver
// has already set status_paused/status_suspended).
//
// State transitions on c.var.decision_state:
//   initial:  charge_no_payment (or would_charge_no_payment in log_only)
//   pre-next: → charge_verify_failed if verify rejects
//             → 503 if facilitator unreachable (active mode)
//             → continues with verify_result attached if verify ok
//   originForwarder may set charge_origin_failed
//   post-next: charge_no_payment + verify_result + origin_2xx → charge_paid (settle ok)
//                                                              → charge_unsettled (settle fail)

import type { MiddlewareHandler } from "hono";
import type { Env, Vars } from "@/types";
import type {
  Facilitator,
  PaymentRequirements,
  SettleResult,
  VerifyResult,
} from "@/facilitators/types";
import { Metrics } from "@/metrics/analytics-engine";

export function buildPaywallMiddleware(
  getRegistry: (env: Env) => Map<string, Facilitator>,
): MiddlewareHandler<{ Bindings: Env; Variables: Vars }> {
  return async (c, next) => {
    const tenant = c.var.tenant;
    const ds = c.var.decision_state;
    if (!tenant) {
      await next();
      return;
    }

    const isCharge =
      ds.decision === "charge_no_payment" || ds.decision === "would_charge_no_payment";
    if (!isCharge) {
      // not a charge path; let the rest of the pipeline run unmodified
      await next();
      return;
    }

    const facilitator = getRegistry(c.env).get(tenant.facilitator_id);
    if (!facilitator) {
      console.error(
        JSON.stringify({
          at: "paywall",
          event: "unknown_facilitator",
          facilitator_id: tenant.facilitator_id,
        }),
      );
      return c.text("misconfigured tenant", 503);
    }

    const metrics = c.env.ANALYTICS ? new Metrics(c.env.ANALYTICS) : null;
    const facilitator_id = tenant.facilitator_id;

    const requirements: PaymentRequirements = {
      amount_usdc: ds.price_usdc!,
      recipient: tenant.payout_address,
      resource: c.req.url,
      network: c.env.ENV === "production" ? "base-mainnet" : "base-sepolia",
    };

    const isLogOnly = tenant.status === "log_only";
    const xpayment = c.req.header("x-payment");

    // ── Pre-origin phase ──
    if (!xpayment) {
      if (isLogOnly) {
        // log_only with no X-PAYMENT: leave decision = would_charge_no_payment, forward to origin
        await next();
        return;
      }
      // active mode: 402
      return facilitator.build402(requirements);
    }

    let verifyResult: VerifyResult;
    try {
      const verifyStart = Date.now();
      verifyResult = await facilitator.verify(c.req.raw, requirements);
      metrics?.verifyLatency({ facilitator_id, latency_ms: Date.now() - verifyStart });
    } catch (err) {
      console.error(JSON.stringify({ at: "paywall", event: "verify_threw", err: String(err) }));
      if (!isLogOnly) {
        c.var.sentry?.captureException(err);
      }
      if (isLogOnly) {
        c.set("decision_state", {
          ...ds,
          decision: "would_charge_verify_failed",
          decision_reason: "facilitator_unavailable",
        });
        await next();
        return;
      }
      c.set("decision_state", {
        ...ds,
        decision: "charge_verify_failed",
        decision_reason: "facilitator_unavailable",
      });
      return c.text("payment service unavailable", 503);
    }

    if (!verifyResult.valid) {
      const reason = verifyResult.reason ?? "verify_rejected";
      if (isLogOnly) {
        c.set("decision_state", {
          ...ds,
          decision: "would_charge_verify_failed",
          decision_reason: reason,
        });
        await next();
        return;
      }
      c.set("decision_state", { ...ds, decision: "charge_verify_failed", decision_reason: reason });
      return facilitator.build402(requirements, reason);
    }

    // verify ok
    if (isLogOnly) {
      c.set("decision_state", { ...ds, decision: "would_charge_paid", decision_reason: null });
      await next();
      return; // log_only never settles
    }

    c.set("verify_result", verifyResult);
    await next();

    // ── Post-origin phase (active only) ──
    const updated = c.var.decision_state;
    if (updated.decision === "charge_origin_failed") {
      // origin failed; do not settle
      return;
    }
    const originStatus = c.var.origin_status;
    if (originStatus === null || originStatus < 200 || originStatus >= 300) {
      // origin produced a non-2xx that originForwarder didn't already tag; treat as origin failure
      c.set("decision_state", {
        ...updated,
        decision: "charge_origin_failed",
        decision_reason: `origin_${originStatus ?? "unknown"}`,
      });
      return;
    }

    let settleResult: SettleResult;
    try {
      const settleStart = Date.now();
      settleResult = await facilitator.settle(verifyResult);
      metrics?.settleLatency({ facilitator_id, latency_ms: Date.now() - settleStart });
    } catch (err) {
      console.error(JSON.stringify({ at: "paywall", event: "settle_threw", err: String(err) }));
      c.var.sentry?.captureException(err);
      metrics?.settleFailure({ facilitator_id, reason: "settle_threw" });
      c.set("decision_state", {
        ...updated,
        decision: "charge_unsettled",
        decision_reason: "settle_threw",
      });
      return;
    }

    if (!settleResult.success) {
      const reason = settleResult.reason ?? "settle_failed";
      metrics?.settleFailure({ facilitator_id, reason });
      c.var.sentry?.captureException(new Error(`settle failed: ${reason}`));
      c.set("decision_state", {
        ...updated,
        decision: "charge_unsettled",
        decision_reason: reason,
      });
      return;
    }

    c.set("decision_state", {
      ...updated,
      decision: "charge_paid",
      decision_reason: null,
      paid: true,
      payment_tx: settleResult.tx_reference ?? null,
    });

    // Attach X-PAYMENT-RESPONSE to outgoing response.
    // Hono's c.res is the response from the route handler; we need to clone it
    // with the additional header.
    const res = c.res;
    const newHeaders = new Headers(res.headers);
    newHeaders.set(
      "X-PAYMENT-RESPONSE",
      btoa(JSON.stringify({ tx_reference: settleResult.tx_reference })),
    );
    c.res = new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: newHeaders,
    });
  };
}
