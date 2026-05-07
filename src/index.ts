// src/index.ts
//
// Top-level Worker entry. Routes by Host header into one of three sub-apps:
//   1. ADMIN_HOSTNAME → admin sub-app
//   2. HEALTH_HOSTNAME → health sub-app
//   3. otherwise → tenant pipeline
//
// The tenant pipeline composes the middleware chain in this order:
//   logger (outermost) → tenantResolver → detectorPipeline → pricingResolverMiddleware
//   → paywall (pre+post) → originForwarder (route handler).

import { Hono } from "hono";
import { DurableObject } from "cloudflare:workers";
import type { Env, Vars } from "@/types";
import { buildAdminApp } from "@/admin/index";
import { buildHealthApp } from "@/health/index";
import { buildLoggerMiddleware } from "@/middleware/logger";
import { tenantResolver } from "@/middleware/tenantResolver";
import { buildDetectorPipelineMiddleware } from "@/middleware/detectorPipeline";
import { pricingResolverMiddleware } from "@/middleware/pricingResolver";
import { buildPaywallMiddleware } from "@/middleware/paywall";
import { buildOriginForwarder } from "@/middleware/originForwarder";
import { buildDetectorRegistry } from "@/detectors/registry";
import type { Detector } from "@/detectors/types";
import { buildFacilitatorRegistry } from "@/facilitators/registry";
import type { Facilitator } from "@/facilitators/types";

// Build SHA injected at build time. wrangler can substitute via define; for v0,
// fall back to "dev" if not set.
const BUILD_SHA = (globalThis as any).__BUILD_SHA__ ?? "dev";

const adminApp = buildAdminApp();
const healthApp = buildHealthApp(BUILD_SHA);

// Per-isolate registry caches. Detectors and facilitators are stateful
// (WebBotAuthDetector has an inflight Map for request dedup) — building them
// once per isolate rather than per request preserves that state across requests.
// Same lifetime semantics as TenantConfigCache in tenantResolver.ts.
let detectorsCache: Detector[] | null = null;
function detectorsFor(env: Env): Detector[] {
  if (!detectorsCache) detectorsCache = buildDetectorRegistry({ wbaKeyCache: env.KV_KEY_CACHE });
  return detectorsCache;
}
export function _resetDetectorsCache(): void {
  detectorsCache = null;
}

let facilitatorsCache: Map<string, Facilitator> | null = null;
function facilitatorsFor(env: Env): Map<string, Facilitator> {
  if (!facilitatorsCache) {
    const deps: Parameters<typeof buildFacilitatorRegistry>[0] = { env: env.ENV };
    if (env.COINBASE_FACILITATOR_KEY !== undefined) {
      deps.coinbaseApiKey = env.COINBASE_FACILITATOR_KEY;
    }
    if (
      env.SOLANA_FACILITATOR_URL !== undefined &&
      env.SOLANA_FACILITATOR_FEE_PAYER !== undefined
    ) {
      deps.solanaFacilitatorUrl = env.SOLANA_FACILITATOR_URL;
      deps.solanaFeePayer = env.SOLANA_FACILITATOR_FEE_PAYER;
      if (env.SOLANA_FACILITATOR_API_KEY !== undefined) {
        deps.solanaApiKey = env.SOLANA_FACILITATOR_API_KEY;
      }
    }
    facilitatorsCache = buildFacilitatorRegistry(deps);
  }
  return facilitatorsCache;
}
export function _resetFacilitatorsCache(): void {
  facilitatorsCache = null;
}

const tenantApp = new Hono<{ Bindings: Env; Variables: Vars }>();

// Initial vars for every request
tenantApp.use("*", async (c, next) => {
  c.set("request_id", "");
  c.set("request_started_ms", Date.now());
  c.set("tenant", null);
  c.set("detection", null);
  c.set("verify_result", null);
  c.set("decision_state", {
    decision: "allow",
    decision_reason: null,
    rule_id: null,
    price_usdc: null,
    paid: false,
    payment_tx: null,
  });
  c.set("origin_status", null);
  await next();
});

tenantApp.use("*", buildLoggerMiddleware());
tenantApp.use("*", tenantResolver);
tenantApp.use("*", buildDetectorPipelineMiddleware(detectorsFor));
tenantApp.use("*", pricingResolverMiddleware);
tenantApp.use("*", buildPaywallMiddleware(facilitatorsFor));
tenantApp.all("*", buildOriginForwarder());

// Top-level dispatcher.
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.all("*", async (c) => {
  // Prefer the Host header (always present in Cloudflare Workers); fall back to
  // the URL hostname for unit-test contexts where Node's Request doesn't auto-set it.
  const rawHost = c.req.header("host");
  const host = (rawHost || new URL(c.req.url).hostname).toLowerCase();

  // Ensure the forwarded request always carries a Host header — needed by
  // sub-app middleware (e.g. tenantResolver) in environments (unit tests) where
  // the original Request was constructed without one.
  const req = rawHost
    ? c.req.raw
    : new Request(c.req.raw, { headers: { ...Object.fromEntries(c.req.raw.headers), host } });

  if (host === c.env.ADMIN_HOSTNAME.toLowerCase()) {
    return adminApp.fetch(req, c.env, c.executionCtx);
  }
  if (host === c.env.HEALTH_HOSTNAME.toLowerCase()) {
    return healthApp.fetch(req, c.env, c.executionCtx);
  }
  return tenantApp.fetch(req, c.env, c.executionCtx);
});

// Stub Durable Object class — not invoked in v0 but required because the
// wrangler.toml binding declares it. Must extend `DurableObject` because the
// migration uses `new_sqlite_classes` (SQLite-backed DOs require extension;
// plain classes are only valid for legacy KV-backed DOs). Class shape will
// be filled in when the rate-limiting feature is built.
export class RateLimiterDO extends DurableObject<Env> {
  async fetch(_req: Request): Promise<Response> {
    return new Response("rate limiter not implemented in v0", { status: 501 });
  }
}

export default app;
