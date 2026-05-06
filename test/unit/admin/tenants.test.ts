// test/unit/admin/tenants.test.ts
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { buildAdminTenantRoutes } from "@/admin/tenants";
import type { Env } from "@/types";

const VALID_EVM = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";
const VALID_EVM_ALT = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

function envWithKv() {
  const store = new Map<string, string>();
  const get = vi.fn(async (k: string) => store.get(k) ?? null);
  const put = vi.fn(async (k: string, v: string) => {
    store.set(k, v);
  });
  const kv = { get, put } as unknown as KVNamespace;
  const auditStore = new Map<string, string>();
  const auditPut = vi.fn(async (k: string, v: string) => {
    auditStore.set(k, v);
  });
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
      accepted_facilitators: [{ facilitator_id: "coinbase-x402-base", payout_address: VALID_EVM }],
      pricing_rules: [],
    };
    const r = await a.fetch(
      new Request("https://x/__admin/tenants", {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
    );
    expect(r.status).toBe(201);
    const saved = (await r.json()) as Record<string, unknown>;
    expect(saved.tenant_id).toBe("t1");
    expect(saved.config_version).toBe(1);
    expect(typeof saved.created_at).toBe("string");
    expect(Array.isArray(saved.accepted_facilitators)).toBe(true);
    expect(store.get("domains:blog.example.com")).toBeTruthy();
    expect(auditStore.size).toBe(1);
  });

  it("PUT /tenants/:hostname increments config_version and writes audit", async () => {
    const { env, auditStore } = envWithKv();
    const a = new Hono<{ Bindings: Env }>();
    a.route("/__admin", buildAdminTenantRoutes());
    const initial = {
      tenant_id: "t1",
      hostname: "blog.example.com",
      origin: "https://o.example.com",
      status: "active",
      default_action: "allow",
      accepted_facilitators: [{ facilitator_id: "coinbase-x402-base", payout_address: VALID_EVM }],
      pricing_rules: [],
    };
    await a.fetch(
      new Request("https://x/__admin/tenants", {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify(initial),
      }),
      env,
    );

    const updated = {
      ...initial,
      accepted_facilitators: [
        { facilitator_id: "coinbase-x402-base", payout_address: VALID_EVM_ALT },
      ],
    };
    const r = await a.fetch(
      new Request("https://x/__admin/tenants/blog.example.com", {
        method: "PUT",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify(updated),
      }),
      env,
    );
    expect(r.status).toBe(200);
    const saved = (await r.json()) as Record<string, any>;
    expect(saved.config_version).toBe(2);
    expect(saved.accepted_facilitators[0].payout_address).toBe(VALID_EVM_ALT);
    expect(auditStore.size).toBe(2);
  });

  it("PUT returns 404 if hostname doesn't exist", async () => {
    const { env } = envWithKv();
    const a = new Hono<{ Bindings: Env }>();
    a.route("/__admin", buildAdminTenantRoutes());
    const r = await a.fetch(
      new Request("https://x/__admin/tenants/missing.example.com", {
        method: "PUT",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify({
          tenant_id: "x",
          hostname: "missing.example.com",
          origin: "https://o.example.com",
          status: "active",
          default_action: "allow",
          accepted_facilitators: [
            { facilitator_id: "coinbase-x402-base", payout_address: VALID_EVM },
          ],
          pricing_rules: [],
        }),
      }),
      env,
    );
    expect(r.status).toBe(404);
  });

  it("GET /tenants/:hostname returns the saved config", async () => {
    const { env } = envWithKv();
    const a = new Hono<{ Bindings: Env }>();
    a.route("/__admin", buildAdminTenantRoutes());
    const initial = {
      tenant_id: "t1",
      hostname: "blog.example.com",
      origin: "https://o.example.com",
      status: "active",
      default_action: "allow",
      accepted_facilitators: [{ facilitator_id: "coinbase-x402-base", payout_address: VALID_EVM }],
      pricing_rules: [],
    };
    await a.fetch(
      new Request("https://x/__admin/tenants", {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify(initial),
      }),
      env,
    );
    const r = await a.fetch(
      new Request("https://x/__admin/tenants/blog.example.com", {
        headers: { authorization: "Bearer secret" },
      }),
      env,
    );
    expect(r.status).toBe(200);
    const saved = (await r.json()) as Record<string, unknown>;
    expect(saved.tenant_id).toBe("t1");
  });

  it("rejects requests without correct bearer", async () => {
    const { env } = envWithKv();
    const a = new Hono<{ Bindings: Env }>();
    a.route("/__admin", buildAdminTenantRoutes());
    const r = await a.fetch(
      new Request("https://x/__admin/tenants/x", { headers: { authorization: "Bearer wrong" } }),
      env,
    );
    expect(r.status).toBe(401);
  });

  it("rejects bodies missing required fields with 400", async () => {
    const { env } = envWithKv();
    const a = new Hono<{ Bindings: Env }>();
    a.route("/__admin", buildAdminTenantRoutes());
    const r = await a.fetch(
      new Request("https://x/__admin/tenants", {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify({ hostname: "x.example.com" }),
      }),
      env,
    );
    expect(r.status).toBe(400);
  });

  it("rejects an EVM payout_address that isn't 0x + 40 hex chars", async () => {
    const { env } = envWithKv();
    const a = new Hono<{ Bindings: Env }>();
    a.route("/__admin", buildAdminTenantRoutes());
    const r = await a.fetch(
      new Request("https://x/__admin/tenants", {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify({
          tenant_id: "t1",
          hostname: "blog.example.com",
          origin: "https://o.example.com",
          status: "active",
          default_action: "allow",
          accepted_facilitators: [
            { facilitator_id: "coinbase-x402-base", payout_address: "0xtoo-short" },
          ],
          pricing_rules: [],
        }),
      }),
      env,
    );
    expect(r.status).toBe(400);
  });

  it("accepts a base58 Solana payout_address", async () => {
    const { env } = envWithKv();
    const a = new Hono<{ Bindings: Env }>();
    a.route("/__admin", buildAdminTenantRoutes());
    const r = await a.fetch(
      new Request("https://x/__admin/tenants", {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify({
          tenant_id: "t-sol",
          hostname: "sol.example.com",
          origin: "https://o.example.com",
          status: "active",
          default_action: "allow",
          accepted_facilitators: [
            {
              facilitator_id: "x402-solana-devnet",
              payout_address: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4",
            },
          ],
          pricing_rules: [],
        }),
      }),
      env,
    );
    expect(r.status).toBe(201);
  });
});
