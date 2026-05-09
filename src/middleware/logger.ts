// src/middleware/logger.ts
//
// Outermost middleware. Records start time before next(); after next(), builds
// the LogEntry and fire-and-forgets it to R2 via executionCtx.waitUntil(),
// plus emits Analytics Engine metrics. Errors here are logged + returned but
// never affect the request's response.

import type { MiddlewareHandler } from "hono";
import { ulid } from "ulid";
import { writeLogToR2 } from "@/logging/r2-writer";
import type { LogEntry } from "@/logging/types";
import { Metrics } from "@/metrics/analytics-engine";
import { getSentry } from "@/observability/sentry";
import type { Env, Vars } from "@/types";
import type { BotEventV1 } from "@/types/paperward-events";
import { shortHash } from "@/utils/hash";

export function buildLoggerMiddleware(): MiddlewareHandler<{ Bindings: Env; Variables: Vars }> {
  return async (c, next) => {
    const start = Date.now();
    const id = ulid();
    c.set("request_id", id);
    c.set("request_started_ms", start);

    // Build per-request Sentry instance and store on context before calling next()
    // so downstream middleware can use c.var.sentry?.captureException(...).
    const sentry = getSentry({ env: c.env, request: c.req.raw, executionCtx: c.executionCtx });
    c.set("sentry", sentry);

    await next();

    const tenant = c.var.tenant;
    const detection = c.var.detection;
    const ds = c.var.decision_state;
    const url = new URL(c.req.url);
    const path = url.pathname; // query stripped per spec §6.5

    const cf = (c.req.raw as any).cf as { colo?: string; country?: string } | undefined;
    const rayId = c.req.header("cf-ray") ?? `${cf?.colo ?? "unknown"}:unknown`;

    // Hash User-Agent and CF-Connecting-IP in parallel — both are SHA-256
    // truncated to 16 hex chars by `shortHash`. Each is `undefined` when the
    // corresponding header is missing, in which case we omit the field.
    const [uaHash, ipHash] = await Promise.all([
      shortHash(c.req.header("user-agent")),
      shortHash(c.req.header("cf-connecting-ip")),
    ]);

    const country = cf?.country;
    const rail = c.var.rail;
    const facilitator_status = c.var.facilitator_status;

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
      // Optional enrichment — spread conditionally so we don't write
      // explicit `undefined` under exactOptionalPropertyTypes.
      ...(rail !== undefined ? { rail } : {}),
      ...(country !== undefined ? { country } : {}),
      ...(uaHash !== undefined ? { ua_hash: uaHash } : {}),
      ...(ipHash !== undefined ? { ip_hash: ipHash } : {}),
      ...(facilitator_status !== undefined ? { facilitator_status } : {}),
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

    const capturedSentry = sentry;
    c.executionCtx.waitUntil(
      writeLogToR2(c.env.R2_LOGS, entry).catch((err) => {
        console.error(JSON.stringify({ at: "logger", event: "r2_write_failed", err: String(err) }));
        capturedSentry?.captureException(err);
      }),
    );

    // Optional: emit BotEventV1 to the Paperward control-plane Queue when
    // PAPERWARD_EVENTS is bound. Omitting the binding disables the feature;
    // OSS forks without the binding are unaffected.
    if (c.env.PAPERWARD_EVENTS) {
      const event: BotEventV1 = {
        v: 1,
        event_id: entry.id,
        ts: entry.ts,
        hostname: entry.hostname,
        agent_id: entry.agent_id,
        agent_name: agentNameFromId(entry.agent_id),
        signed: entry.agent_signed,
        path: entry.path,
        decision: entry.decision,
        // Structured price/payment per the canonical BotEventV1 shape.
        // Emitted only when all required sub-fields are present so the
        // control plane can rely on them being well-formed when set.
        ...(entry.price_usdc && entry.rail
          ? {
              price: {
                amount: entry.price_usdc,
                currency: "USDC" as const,
                rail: entry.rail,
              },
            }
          : {}),
        ...(entry.payment_tx && entry.facilitator_status
          ? {
              payment: {
                tx_id: entry.payment_tx,
                facilitator_status: entry.facilitator_status,
              },
            }
          : {}),
        client: {
          ...(entry.country !== undefined ? { country: entry.country } : {}),
          ...(entry.ua_hash !== undefined ? { ua_hash: entry.ua_hash } : {}),
          ...(entry.ip_hash !== undefined ? { ip_hash: entry.ip_hash } : {}),
        },
      };
      c.executionCtx.waitUntil(
        c.env.PAPERWARD_EVENTS.send(event).catch((err) => {
          // Never fail the request because of the analytics emit.
          console.error(
            JSON.stringify({
              at: "logger",
              event: "paperward_events_send_failed",
              err: String(err),
            }),
          );
        }),
      );
    }
  };
}

/**
 * Derives the human-readable agent name from `agent_id` for BotEventV1.
 *   "signed:gptbot"  → "gptbot"
 *   "unsigned:claude" → "claude"
 *   "human"           → "human"
 *   null              → "unknown"
 */
function agentNameFromId(agent_id: string | null): string {
  if (agent_id === null) return "unknown";
  const colon = agent_id.indexOf(":");
  return colon === -1 ? agent_id : agent_id.slice(colon + 1);
}

function classifyAgentId(agent_id: string): string {
  if (agent_id.startsWith("signed:")) return "signed";
  if (agent_id.startsWith("unsigned:")) return "unsigned";
  return agent_id; // "human"
}
