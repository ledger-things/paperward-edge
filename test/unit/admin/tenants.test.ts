// test/unit/admin/tenants.test.ts
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { buildAdminTenantRoutes } from "@/admin/tenants";
import type { Env } from "@/types";

function envWithKv() {
  const store = new Map<string, string>();
  const get = vi.fn(async (k: string) => store.get(k) ?? null);
  const put = vi.fn(async (k: string, v: string) => { store.set(k, v); });
  const kv = { get, put } as unknown as KVNamespace;
  const auditStore = new Map<string, string>();
  const auditPut = vi.fn(async (k: string, v: string) => { auditStore.set(k, v); });
  const auditKv = { put: auditPut } as unknown as KVNamespace;
  const env = {
    KV_DOMAINS: kv,
    KV_AUDIT: auditKv,
    ADMIN_TOKEN: "secret",
  } as unknown as Env;
  return { env, store, auditStore };
}

describe("admin tenants routes", () => {
  it("POST /tenants creates a tenant and writes an audit record", async () => {
    const { env, store, auditStore } = envWithKv();
    const a = new Hono<{ Bindings: Env }>();
    a.route("/__admin", buildAdminTenantRoutes());
    const body = {
      tenant_id: "t1",
      hostname: "blog.example.com",
      origin: "https://o.example.com",
      status: "active",
      default_action: "allow",
      facilitator_id: "coinbase-x402-base",
      payout_address: "0xabc",
      pricing_rules: [],
    };
    const r = await a.fetch(new Request("https://x/__admin/tenants", {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify(body),
    }), env);
    expect(r.status).toBe(201);
    const saved = await r.json() as any;
    expect(saved.tenant_id).toBe("t1");
    expect(saved.config_version).toBe(1);
    expect(typeof saved.created_at).toBe("string");
    expect(store.get("domains:blog.example.com")).toBeTruthy();
    expect(auditStore.size).toBe(1);
  });

  it("PUT /tenants/:hostname increments config_version and writes audit", async () => {
    const { env, store, auditStore } = envWithKv();
    const a = new Hono<{ Bindings: Env }>();
    a.route("/__admin", buildAdminTenantRoutes());
    const initial = {
      tenant_id: "t1", hostname: "blog.example.com", origin: "https://o", status: "active",
      default_action: "allow", facilitator_id: "coinbase-x402-base", payout_address: "0x",
      pricing_rules: [],
    };
    await a.fetch(new Request("https://x/__admin/tenants", {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify(initial),
    }), env);

    const updated = { ...initial, payout_address: "0xnew" };
    const r = await a.fetch(new Request("https://x/__admin/tenants/blog.example.com", {
      method: "PUT",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify(updated),
    }), env);
    expect(r.status).toBe(200);
    const saved = await r.json() as any;
    expect(saved.config_version).toBe(2);
    expect(saved.payout_address).toBe("0xnew");
    expect(auditStore.size).toBe(2);
  });

  it("PUT returns 404 if hostname doesn't exist", async () => {
    const { env } = envWithKv();
    const a = new Hono<{ Bindings: Env }>();
    a.route("/__admin", buildAdminTenantRoutes());
    const r = await a.fetch(new Request("https://x/__admin/tenants/missing.example.com", {
      method: "PUT",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ tenant_id: "x", hostname: "missing.example.com", origin: "https://o", status: "active", default_action: "allow", facilitator_id: "coinbase-x402-base", payout_address: "0x", pricing_rules: [] }),
    }), env);
    expect(r.status).toBe(404);
  });

  it("GET /tenants/:hostname returns the saved config", async () => {
    const { env } = envWithKv();
    const a = new Hono<{ Bindings: Env }>();
    a.route("/__admin", buildAdminTenantRoutes());
    const initial = {
      tenant_id: "t1", hostname: "blog.example.com", origin: "https://o", status: "active",
      default_action: "allow", facilitator_id: "coinbase-x402-base", payout_address: "0x",
      pricing_rules: [],
    };
    await a.fetch(new Request("https://x/__admin/tenants", {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify(initial),
    }), env);
    const r = await a.fetch(new Request("https://x/__admin/tenants/blog.example.com", {
      headers: { authorization: "Bearer secret" },
    }), env);
    expect(r.status).toBe(200);
    const saved = await r.json() as any;
    expect(saved.tenant_id).toBe("t1");
  });

  it("rejects requests without correct bearer", async () => {
    const { env } = envWithKv();
    const a = new Hono<{ Bindings: Env }>();
    a.route("/__admin", buildAdminTenantRoutes());
    const r = await a.fetch(new Request("https://x/__admin/tenants/x", { headers: { authorization: "Bearer wrong" } }), env);
    expect(r.status).toBe(401);
  });

  it("rejects bodies missing required fields with 400", async () => {
    const { env } = envWithKv();
    const a = new Hono<{ Bindings: Env }>();
    a.route("/__admin", buildAdminTenantRoutes());
    const r = await a.fetch(new Request("https://x/__admin/tenants", {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ hostname: "x.example.com" }),
    }), env);
    expect(r.status).toBe(400);
  });
});
