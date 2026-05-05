// src/admin/tenants.ts
import { Hono } from "hono";
import type { Env } from "@/types";
import type { TenantConfig } from "@/config/types";
import { adminAuth } from "@/admin/auth";
import { writeAuditEntry } from "@/logging/audit";

export function buildAdminTenantRoutes() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", adminAuth);

  app.post("/tenants", async (c) => {
    const body = await c.req.json().catch(() => null) as Partial<TenantConfig> | null;
    const valid = validateTenantInput(body);
    if (!valid.ok) return c.text(valid.reason, 400);
    const input = valid.config;

    const existing = await c.env.KV_DOMAINS.get(`domains:${input.hostname}`);
    if (existing !== null) return c.text("tenant already exists; use PUT to update", 409);

    const now = new Date().toISOString();
    const config: TenantConfig = {
      ...input,
      schema_version: 1,
      config_version: 1,
      created_at: now,
      updated_at: now,
    };
    await c.env.KV_DOMAINS.put(`domains:${config.hostname}`, JSON.stringify(config));
    await writeAuditEntry(c.env.KV_AUDIT, {
      actor: "admin-token",
      before: null,
      after: config,
    });
    return c.json(config, 201);
  });

  app.put("/tenants/:hostname", async (c) => {
    const hostname = c.req.param("hostname");
    const raw = await c.env.KV_DOMAINS.get(`domains:${hostname}`);
    if (raw === null) return c.text("not found", 404);
    const before = JSON.parse(raw) as TenantConfig;

    const body = await c.req.json().catch(() => null) as Partial<TenantConfig> | null;
    const valid = validateTenantInput(body);
    if (!valid.ok) return c.text(valid.reason, 400);
    if (valid.config.hostname !== hostname) return c.text("hostname in body must match URL", 400);

    const after: TenantConfig = {
      ...valid.config,
      schema_version: 1,
      config_version: before.config_version + 1,
      created_at: before.created_at,
      updated_at: new Date().toISOString(),
    };
    await c.env.KV_DOMAINS.put(`domains:${after.hostname}`, JSON.stringify(after));
    await writeAuditEntry(c.env.KV_AUDIT, { actor: "admin-token", before, after });
    return c.json(after, 200);
  });

  app.get("/tenants/:hostname", async (c) => {
    const hostname = c.req.param("hostname");
    const raw = await c.env.KV_DOMAINS.get(`domains:${hostname}`);
    if (raw === null) return c.text("not found", 404);
    return c.json(JSON.parse(raw), 200);
  });

  app.get("/healthz", (c) => c.json({ ok: true, env: c.env.ENV }));

  return app;
}

type ValidationResult =
  | { ok: true; config: Omit<TenantConfig, "schema_version" | "config_version" | "created_at" | "updated_at"> }
  | { ok: false; reason: string };

function validateTenantInput(body: unknown): ValidationResult {
  if (!body || typeof body !== "object") return { ok: false, reason: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  for (const k of ["tenant_id", "hostname", "origin", "status", "default_action", "facilitator_id", "payout_address"]) {
    if (typeof b[k] !== "string") return { ok: false, reason: `field ${k} required and must be a string` };
  }
  if (!["active", "log_only", "paused_by_publisher", "suspended_by_paperward"].includes(b.status as string)) {
    return { ok: false, reason: "invalid status" };
  }
  if (!["allow", "block"].includes(b.default_action as string)) {
    return { ok: false, reason: "default_action must be 'allow' or 'block'" };
  }
  if (!Array.isArray(b.pricing_rules)) {
    return { ok: false, reason: "pricing_rules must be an array" };
  }
  return {
    ok: true,
    config: {
      tenant_id: b.tenant_id as string,
      hostname: b.hostname as string,
      origin: b.origin as string,
      status: b.status as TenantConfig["status"],
      default_action: b.default_action as TenantConfig["default_action"],
      facilitator_id: b.facilitator_id as string,
      payout_address: b.payout_address as string,
      pricing_rules: b.pricing_rules as TenantConfig["pricing_rules"],
    },
  };
}
