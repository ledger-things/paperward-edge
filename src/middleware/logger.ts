// src/middleware/logger.ts
//
// Outermost middleware. Records start time before next(); after next(), builds
// the LogEntry and fire-and-forgets it to R2 via executionCtx.waitUntil(),
// plus emits Analytics Engine metrics. Errors here are logged + returned but
// never affect the request's response.

import type { MiddlewareHandler } from "hono";
import { ulid } from "ulid";
import type { Env, Vars } from "@/types";
import type { LogEntry } from "@/logging/types";
import { writeLogToR2 } from "@/logging/r2-writer";
import { Metrics } from "@/metrics/analytics-engine";

export function buildLoggerMiddleware(): MiddlewareHandler<{ Bindings: Env; Variables: Vars }> {
  return async (c, next) => {
    const start = Date.now();
    const id = ulid();
    c.set("request_id", id);
    c.set("request_started_ms", start);

    await next();

    const tenant = c.var.tenant;
    const detection = c.var.detection;
    const ds = c.var.decision_state;
    const url = new URL(c.req.url);
    const path = url.pathname; // query stripped per spec §6.5

    const cf = (c.req.raw as any).cf as { colo?: string } | undefined;
    const rayId = c.req.header("cf-ray") ?? `${cf?.colo ?? "unknown"}:unknown`;

    const entry: LogEntry = {
      id,
      ts: new Date(start).toISOString(),
      tenant_id: tenant?.tenant_id ?? "",
      hostname: (c.req.header("host") ?? "").toLowerCase(),
      config_version: tenant?.config_version ?? 0,
      ray_id: rayId,
      method: c.req.method,
      path,
      agent_id: detection?.agent_id ?? null,
      agent_signed: detection?.signed ?? false,
      detector_id: detection?.detector_id ?? null,
      decision: ds.decision,
      decision_reason: ds.decision_reason,
      rule_id: ds.rule_id,
      price_usdc: ds.price_usdc,
      paid: ds.paid,
      payment_tx: ds.payment_tx,
      origin_status: c.var.origin_status,
      latency_ms: Date.now() - start,
    };

    // ANALYTICS may be absent in environments where the binding is not
    // provisioned (e.g. integration test miniflare without analytics support).
    if (c.env.ANALYTICS) {
      const metrics = new Metrics(c.env.ANALYTICS);
      metrics.requestRecorded({
        tenant_id: entry.tenant_id || "unknown",
        decision: entry.decision,
        agent_signed: entry.agent_signed,
        latency_ms: entry.latency_ms,
      });
      if (detection) {
        metrics.detectorMatch({
          detector_id: detection.detector_id,
          agent_id_class: classifyAgentId(detection.agent_id),
        });
      }
    }

    c.executionCtx.waitUntil(writeLogToR2(c.env.R2_LOGS, entry));
  };
}

function classifyAgentId(agent_id: string): string {
  if (agent_id.startsWith("signed:")) return "signed";
  if (agent_id.startsWith("unsigned:")) return "unsigned";
  return agent_id; // "human"
}
