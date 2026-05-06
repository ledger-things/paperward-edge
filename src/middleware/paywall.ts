// src/middleware/paywall.ts
//
// Paywall middleware. Implements spec §5.4 (pre-origin) and §5.6 (post-origin).
//
// Multi-rail support: a tenant declares an `accepted_facilitators` list, each
// entry identifying a facilitator and the chain-appropriate payout address.
//   • On no X-PAYMENT: build a 402 with one `accepts[]` entry per accepted rail.
//   • On X-PAYMENT present: parse the inbound payload, read its `accepted.network`
//     field, and dispatch verify/settle to the matching facilitator.
//
// State transitions on c.var.decision_state are unchanged from the single-rail
// design; the only new failure mode is `charge_verify_failed` with reason
// `unsupported_network` when an agent pays on a rail the tenant didn't accept.

import type { MiddlewareHandler } from "hono";
import type { Env, Vars } from "@/types";
import type {
  Facilitator,
  PaymentRequirements,
  SettleResult,
  VerifyResult,
} from "@/facilitators/types";
import { networkFromX402 } from "@/facilitators/types";
import type { AcceptedFacilitator } from "@/config/types";
import { Metrics } from "@/metrics/analytics-engine";
import { decodePaymentHeader } from "@/facilitators/coinbase-x402";

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
      await next();
      return;
    }

    const registry = getRegistry(c.env);
    const accepted = tenant.accepted_facilitators;
    if (accepted.length === 0) {
      console.error(
        JSON.stringify({
          at: "paywall",
          event: "no_accepted_facilitators",
          tenant_id: tenant.tenant_id,
        }),
      );
      return c.text("misconfigured tenant: no accepted facilitators", 503);
    }

    // Validate that every accepted facilitator is actually registered.
    for (const af of accepted) {
      if (!registry.has(af.facilitator_id)) {
        console.error(
          JSON.stringify({
            at: "paywall",
            event: "unknown_facilitator",
            facilitator_id: af.facilitator_id,
          }),
        );
        return c.text("misconfigured tenant: unknown facilitator", 503);
      }
    }

    const metrics = c.env.ANALYTICS ? new Metrics(c.env.ANALYTICS) : null;
    const isLogOnly = tenant.status === "log_only";
    const xpayment = c.req.header("x-payment");

    // ── Pre-origin: no X-PAYMENT → build multi-rail 402 ──
    if (!xpayment) {
      if (isLogOnly) {
        // log_only must not return 402 — forward to origin and log "would_*".
        await next();
        return;
      }
      return buildMultiRail402(c.req.url, tenant.accepted_facilitators, registry, ds.price_usdc!);
    }

    // ── Pre-origin: X-PAYMENT present → pick the right facilitator and verify ──
    const decoded = decodePaymentHeader(xpayment);
    const network = readNetworkFromPaymentPayload(decoded);
    if (!network) {
      const reason = "malformed_payment_header";
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
      return c.text(reason, 400);
    }

    const match = pickFacilitatorForNetwork(accepted, registry, network);
    if (!match) {
      const reason = "unsupported_network";
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
      return buildMultiRail402(
        c.req.url,
        tenant.accepted_facilitators,
        registry,
        ds.price_usdc!,
        reason,
      );
    }

    const { facilitator, accepted: matchedAccepted } = match;
    const facilitator_id = facilitator.id;

    const requirements: PaymentRequirements = {
      amount_usdc: ds.price_usdc!,
      recipient: matchedAccepted.payout_address,
      resource: c.req.url,
      network: facilitator.supportedNetworks[0]!, // a facilitator instance is bound to one network
    };

    let verifyResult: VerifyResult;
    try {
      const verifyStart = Date.now();
      verifyResult = await facilitator.verify(c.req.raw, requirements);
      metrics?.verifyLatency({ facilitator_id, latency_ms: Date.now() - verifyStart });
    } catch (err) {
      console.error(JSON.stringify({ at: "paywall", event: "verify_threw", err: String(err) }));
      if (!isLogOnly) c.var.sentry?.captureException(err);
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
      return;
    }

    c.set("verify_result", verifyResult);
    // The same `facilitator` reference is closed over for the post-phase settle call below.
    await next();

    // ── Post-origin (active only): settle with the same facilitator we verified with ──
    const updated = c.var.decision_state;
    if (updated.decision === "charge_origin_failed") return;

    const originStatus = c.var.origin_status;
    if (originStatus === null || originStatus < 200 || originStatus >= 300) {
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

/**
 * Builds a 402 Response whose `accepts[]` array contains one entry per accepted
 * facilitator. The agent picks which rail to pay on by looking at the entries
 * and choosing one its wallet supports.
 */
function buildMultiRail402(
  resourceUrl: string,
  accepted: AcceptedFacilitator[],
  registry: Map<string, Facilitator>,
  amount_usdc: string,
  error?: string,
): Response {
  const acceptsEntries: Array<Record<string, unknown>> = [];
  for (const af of accepted) {
    const facilitator = registry.get(af.facilitator_id);
    if (!facilitator) continue;
    const network = facilitator.supportedNetworks[0]!;
    const requirements: PaymentRequirements = {
      amount_usdc,
      recipient: af.payout_address,
      resource: resourceUrl,
      network,
    };
    acceptsEntries.push(buildAcceptsEntryViaFacilitator(facilitator, requirements));
  }

  const body: Record<string, unknown> = {
    x402Version: 2,
    resource: { url: resourceUrl, description: "", mimeType: "application/json" },
    accepts: acceptsEntries,
  };
  if (error !== undefined) body.error = error;

  return new Response(JSON.stringify(body), {
    status: 402,
    headers: {
      "content-type": "application/json",
      "WWW-Authenticate": "x402",
    },
  });
}

/**
 * Calls the facilitator's `buildAcceptsEntry` if exposed, falling back to
 * extracting the entry from a single-facilitator `build402` body. All concrete
 * facilitators in this codebase expose `buildAcceptsEntry` directly; the
 * fallback exists only to keep the `Facilitator` interface minimal (no need to
 * widen it just for the multi-rail case).
 */
function buildAcceptsEntryViaFacilitator(
  facilitator: Facilitator,
  req: PaymentRequirements,
): Record<string, unknown> {
  const f = facilitator as Facilitator & {
    buildAcceptsEntry?: (req: PaymentRequirements) => Record<string, unknown>;
  };
  if (typeof f.buildAcceptsEntry === "function") {
    return f.buildAcceptsEntry(req);
  }
  // Fallback: invoke build402, parse body, return its first accepts entry.
  // Synchronous extraction isn't possible (Response.json is async), so this
  // path is a development-time placeholder. In practice every Facilitator
  // implementation exports buildAcceptsEntry directly.
  throw new Error(`facilitator ${facilitator.id} does not expose buildAcceptsEntry`);
}

/** Reads the `accepted.network` field from a decoded x402 v2 PaymentPayload. */
function readNetworkFromPaymentPayload(decoded: unknown): string | null {
  if (!decoded || typeof decoded !== "object") return null;
  const pp = decoded as Record<string, unknown>;
  const accepted = pp.accepted;
  if (!accepted || typeof accepted !== "object") return null;
  const network = (accepted as Record<string, unknown>).network;
  return typeof network === "string" ? network : null;
}

/**
 * Given the wire `network` from an inbound payment, find the accepted-facilitator
 * entry whose facilitator supports that network.
 */
function pickFacilitatorForNetwork(
  accepted: AcceptedFacilitator[],
  registry: Map<string, Facilitator>,
  wireNetwork: string,
): { facilitator: Facilitator; accepted: AcceptedFacilitator } | null {
  const friendly = networkFromX402(wireNetwork);
  if (!friendly) return null;
  for (const af of accepted) {
    const fac = registry.get(af.facilitator_id);
    if (!fac) continue;
    if (fac.supportedNetworks.includes(friendly)) {
      return { facilitator: fac, accepted: af };
    }
  }
  return null;
}
