// test/integration/_helpers.ts
import { env } from "cloudflare:test";
import type { TenantConfig } from "@/config/types";

export async function seedTenant(tenant: TenantConfig): Promise<void> {
  await (env.KV_DOMAINS as KVNamespace).put(`domains:${tenant.hostname}`, JSON.stringify(tenant));
}

export async function readLogs(): Promise<any[]> {
  const list = await (env.R2_LOGS as R2Bucket).list();
  const entries = [];
  for (const obj of list.objects) {
    const body = await (env.R2_LOGS as R2Bucket).get(obj.key);
    if (body) {
      const text = await body.text();
      for (const line of text.split("\n")) {
        if (line.trim()) entries.push(JSON.parse(line));
      }
    }
  }
  return entries;
}

export function makeTenant(overrides: Partial<TenantConfig> = {}): TenantConfig {
  return {
    schema_version: 1,
    tenant_id: "test-tenant",
    hostname: "test.example.com",
    origin: "https://origin.test.example.com",
    status: "active",
    default_action: "allow",
    accepted_facilitators: [{ facilitator_id: "coinbase-x402-base", payout_address: "0xabc" }],
    pricing_rules: [],
    config_version: 1,
    created_at: "2026-05-05T00:00:00Z",
    updated_at: "2026-05-05T00:00:00Z",
    ...overrides,
  };
}
