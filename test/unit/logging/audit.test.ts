// test/unit/logging/audit.test.ts
import { describe, it, expect, vi } from "vitest";
import { writeAuditEntry } from "@/logging/audit";
import type { TenantConfig } from "@/config/types";

const cfg: TenantConfig = {
  schema_version: 1,
  tenant_id: "t1",
  hostname: "blog.example.com",
  origin: "https://o.example.com",
  status: "active",
  default_action: "allow",
  facilitator_id: "coinbase-x402-base",
  payout_address: "0xabc",
  pricing_rules: [],
  config_version: 2,
  created_at: "2026-05-05T00:00:00Z",
  updated_at: "2026-05-05T00:00:01Z",
};

describe("writeAuditEntry", () => {
  it("writes an audit:{ulid} key with before+after snapshot", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const kv = { put } as unknown as KVNamespace;
    const id = await writeAuditEntry(kv, { actor: "admin-token-holder", before: null, after: cfg });
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/i); // ULID
    const [key, body] = put.mock.calls[0]!;
    expect(key).toBe(`audit:${id}`);
    const parsed = JSON.parse(body as string);
    expect(parsed.tenant_id).toBe("t1");
    expect(parsed.actor).toBe("admin-token-holder");
    expect(parsed.before).toBeNull();
    expect(parsed.after).toEqual(cfg);
    expect(parsed.id).toBe(id);
  });
});
