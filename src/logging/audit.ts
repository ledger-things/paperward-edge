// src/logging/audit.ts
import { ulid } from "ulid";
import type { TenantConfig, AuditEntry } from "@/config/types";

export type WriteAuditArgs = {
  actor: string;
  before: TenantConfig | null;
  after: TenantConfig;
};

export async function writeAuditEntry(kv: KVNamespace, args: WriteAuditArgs): Promise<string> {
  const id = ulid();
  const entry: AuditEntry = {
    id,
    ts: new Date().toISOString(),
    tenant_id: args.after.tenant_id,
    hostname: args.after.hostname,
    actor: args.actor,
    before: args.before,
    after: args.after,
  };
  await kv.put(`audit:${id}`, JSON.stringify(entry));
  return id;
}
