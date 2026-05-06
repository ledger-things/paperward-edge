// src/middleware/tenantResolver.ts
//
// Reads Host, looks up tenant config (cached via TenantConfigCache), attaches
// it to ctx, and branches on status. For paused/suspended statuses, sets the
// decision tag so the rest of the pipeline can skip detection and forward
// directly to origin via originForwarder. For tenant_unknown, returns 503.

import type { MiddlewareHandler } from "hono";
import type { Env, Vars } from "@/types";
import { TenantConfigCache } from "@/config/kv";
import { Metrics } from "@/metrics/analytics-engine";

// Module-scoped cache instance — survives across requests within an isolate.
let cache: TenantConfigCache | null = null;
function getCache(env: Env): TenantConfigCache {
  if (!cache) cache = new TenantConfigCache(env.KV_DOMAINS, env.ANALYTICS ? new Metrics(env.ANALYTICS) : undefined);
  return cache;
}

// For tests: reset the cache so each test starts fresh.
export function _resetTenantCache(): void { cache = null; }

export const tenantResolver: MiddlewareHandler<{ Bindings: Env; Variables: Vars }> = async (c, next) => {
  const host = (c.req.header("host") ?? "").toLowerCase();
  if (!host) {
    return c.text("Missing Host header", 400);
  }

  let tenant;
  try {
    tenant = await getCache(c.env).get(host);
  } catch (err) {
    console.error(JSON.stringify({ at: "tenantResolver", event: "kv_fail", err: String(err) }));
    c.var.sentry?.captureException(err);
    return c.text("upstream config unavailable", 503);
  }

  if (!tenant) {
    c.set("decision_state", { ...c.get("decision_state"), decision: "tenant_unknown", decision_reason: "kv_miss" });
    console.error(JSON.stringify({ at: "tenantResolver", event: "tenant_unknown", host }));
    c.var.sentry?.captureMessage(`tenant_unknown invariant violation for host: ${host}`, "error");
    return c.text("tenant not configured", 503);
  }

  c.set("tenant", tenant);

  if (tenant.status === "paused_by_publisher") {
    c.set("decision_state", { ...c.get("decision_state"), decision: "status_paused" });
  } else if (tenant.status === "suspended_by_paperward") {
    c.set("decision_state", { ...c.get("decision_state"), decision: "status_suspended" });
  }

  await next();
};
