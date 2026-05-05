// src/middleware/originForwarder.ts
//
// Route handler at the end of the tenant pipeline. Forwards the request to
// tenant.origin via fetch(), streams the response back, and tags decision
// state for origin failures so the paywall.post phase knows whether to settle.

import type { Handler } from "hono";
import type { Env, Vars } from "@/types";

const STRIP_REQUEST_HEADERS = new Set([
  "x-payment", "signature", "signature-input", "signature-agent",
]);

export function buildOriginForwarder(fetchImpl: typeof fetch = fetch): Handler<{ Bindings: Env; Variables: Vars }> {
  return async (c) => {
    const tenant = c.var.tenant;
    if (!tenant) {
      // Should never reach here without a tenant; tenantResolver ensures.
      return c.text("internal: no tenant", 500);
    }

    const inboundUrl = new URL(c.req.url);
    const originUrl = new URL(tenant.origin);
    const forwardedUrl = `${originUrl.origin}${inboundUrl.pathname}${inboundUrl.search}`;

    // Build outgoing headers: strip sensitive + X-Paperward-*; pass through rest; add ours.
    const headers = new Headers();
    for (const [k, v] of c.req.raw.headers.entries()) {
      const kl = k.toLowerCase();
      if (STRIP_REQUEST_HEADERS.has(kl)) continue;
      if (kl.startsWith("x-paperward-")) continue;
      headers.set(k, v);
    }
    headers.set("x-paperward-tenant-id", tenant.tenant_id);
    headers.set("x-paperward-decision", c.var.decision_state.decision);
    headers.set("x-paperward-agent-id", c.var.detection?.agent_id ?? "");
    headers.set("x-forwarded-for", c.req.header("cf-connecting-ip") ?? "");
    headers.set("x-forwarded-proto", "https");

    const init: RequestInit = {
      method: c.req.method,
      headers,
    };
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      init.body = c.req.raw.body;
    }

    let resp: Response;
    try {
      resp = await fetchImpl(forwardedUrl, init);
    } catch (err) {
      console.error(JSON.stringify({ at: "originForwarder", event: "fetch_threw", err: String(err) }));
      c.set("origin_status", null);
      const ds = c.var.decision_state;
      if (ds.decision === "charge_no_payment") {
        c.set("decision_state", { ...ds, decision: "charge_origin_failed", decision_reason: "origin_throw" });
      }
      return c.text("Bad Gateway", 502);
    }

    c.set("origin_status", resp.status);

    if (resp.status >= 400) {
      const ds = c.var.decision_state;
      if (ds.decision === "charge_no_payment") {
        c.set("decision_state", { ...ds, decision: "charge_origin_failed", decision_reason: `origin_${resp.status}` });
      }
    }

    return resp;
  };
}
