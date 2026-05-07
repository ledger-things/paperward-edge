#!/usr/bin/env tsx
// bin/provision-tenant.ts
//
// Provisions a tenant end-to-end:
//   1. POST tenant config to the admin endpoint (writes to KV + audit)
//   2. POST hostname to Cloudflare Custom Hostnames API (kicks off DCV)
//   3. Print the DCV instructions for the operator to share with the publisher
//
// Required env vars:
//   ADMIN_BASE_URL    — e.g., https://admin.paperward.com or admin.staging.paperward.com
//   ADMIN_TOKEN       — bearer token for the admin endpoint
//   CF_API_TOKEN      — Cloudflare API token with Zone:SSL & Custom Hostnames write
//   CF_ZONE_ID        — Cloudflare zone hosting the SaaS fallback origin
//
// Usage:
//   tsx bin/provision-tenant.ts \
//     --hostname=blog.example.com \
//     --origin=https://internal.example.com \
//     --payout-address=0x... \
//     [--facilitator-id=coinbase-x402-base] \
//     [--cname-target=cname.staging.paperward.com] \
//     [--tenant-id=<uuid>] \
//     [--status=active|log_only|paused_by_publisher|suspended_by_paperward] \
//     [--default-action=allow|block] \
//     [--rules-file=path/to/rules.json]
//
// For multi-rail tenants (Base + Solana), provision with one rail and PUT
// the tenant later with the full accepted_facilitators[] array. Multi-rail
// CLI args are deferred until we have a real publisher who needs both.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

type Args = {
  hostname: string;
  origin: string;
  payout_address: string;
  facilitator_id: string;
  cname_target: string;
  tenant_id?: string;
  status?: "active" | "log_only" | "paused_by_publisher" | "suspended_by_paperward";
  default_action?: "allow" | "block";
  rules_file?: string;
};

function parseArgs(): Args {
  const out: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([\w-]+)=(.*)$/);
    if (!m || m[1] === undefined || m[2] === undefined) {
      console.error(`unrecognized argument: ${arg}`);
      process.exit(2);
    }
    out[m[1].replace(/-/g, "_")] = m[2];
  }
  for (const k of ["hostname", "origin", "payout_address"]) {
    if (!out[k]) {
      console.error(`required: --${k.replace(/_/g, "-")}=...`);
      process.exit(2);
    }
  }
  const status = out.status as Args["status"] | undefined;
  if (
    status &&
    !["active", "log_only", "paused_by_publisher", "suspended_by_paperward"].includes(status)
  ) {
    console.error(`invalid --status: ${status}`);
    process.exit(2);
  }
  const default_action = out.default_action as Args["default_action"] | undefined;
  if (default_action && !["allow", "block"].includes(default_action)) {
    console.error(`invalid --default-action: ${default_action}`);
    process.exit(2);
  }
  return {
    hostname: out.hostname!,
    origin: out.origin!,
    payout_address: out.payout_address!,
    facilitator_id: out.facilitator_id ?? "coinbase-x402-base",
    cname_target: out.cname_target ?? "cname.staging.paperward.com",
    ...(out.tenant_id !== undefined ? { tenant_id: out.tenant_id } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(default_action !== undefined ? { default_action } : {}),
    ...(out.rules_file !== undefined ? { rules_file: out.rules_file } : {}),
  };
}

function requireEnv(k: string): string {
  const v = process.env[k];
  if (!v) {
    console.error(`required env var: ${k}`);
    process.exit(2);
  }
  return v;
}

async function postAdminTenant(args: Args): Promise<{ tenant_id: string }> {
  const adminBase = requireEnv("ADMIN_BASE_URL");
  const adminToken = requireEnv("ADMIN_TOKEN");
  const tenant_id = args.tenant_id ?? randomUUID();
  const rules = args.rules_file ? JSON.parse(readFileSync(args.rules_file, "utf8")) : [];
  const body = {
    tenant_id,
    hostname: args.hostname,
    origin: args.origin,
    status: args.status ?? "active",
    default_action: args.default_action ?? "allow",
    accepted_facilitators: [
      {
        facilitator_id: args.facilitator_id,
        payout_address: args.payout_address,
      },
    ],
    pricing_rules: rules,
  };
  const r = await fetch(`${adminBase}/__admin/tenants`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    console.error(`admin POST failed: ${r.status} ${await r.text()}`);
    process.exit(1);
  }
  return { tenant_id };
}

type CfValidationRecord = { txt_name?: string; txt_value?: string };
type CfOwnershipVerification = { name?: string; type?: string; value?: string };
type CfCustomHostnameResult = {
  id: string;
  hostname: string;
  ssl?: { status: string; validation_records?: CfValidationRecord[] };
  ownership_verification?: CfOwnershipVerification;
};

async function registerCustomHostname(hostname: string): Promise<CfCustomHostnameResult> {
  const cfToken = requireEnv("CF_API_TOKEN");
  const zoneId = requireEnv("CF_ZONE_ID");
  const r = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/custom_hostnames`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      hostname,
      ssl: { method: "txt", type: "dv", settings: { min_tls_version: "1.2" } },
    }),
  });
  if (!r.ok) {
    console.error(`CF custom hostnames POST failed: ${r.status} ${await r.text()}`);
    process.exit(1);
  }
  const body = (await r.json()) as { result: CfCustomHostnameResult };
  return body.result;
}

async function main() {
  const args = parseArgs();
  console.log(`provisioning tenant ${args.hostname} → ${args.origin}`);

  const { tenant_id } = await postAdminTenant(args);
  console.log(`✔ admin: wrote tenant config (tenant_id=${tenant_id})`);

  const result = await registerCustomHostname(args.hostname);
  console.log(`✔ cloudflare: registered custom hostname; DCV pending`);

  console.log("");
  console.log("──────────────────────────────────────────────");
  console.log("Send these instructions to the publisher:");
  console.log("──────────────────────────────────────────────");

  // Hostname ownership verification (proves domain control to Cloudflare).
  const ov = result.ownership_verification;
  if (ov?.name && ov?.value) {
    console.log(`1. Add this DNS TXT record to ${args.hostname}'s DNS (hostname ownership):`);
    console.log(`   name:  ${ov.name}`);
    console.log(`   type:  ${ov.type ?? "TXT"}`);
    console.log(`   value: ${ov.value}`);
    console.log("");
  }

  // SSL DV — TXT record(s) for cert issuance.
  const sslRecords = result.ssl?.validation_records ?? [];
  if (sslRecords.length > 0 && sslRecords[0]?.txt_name && sslRecords[0]?.txt_value) {
    console.log(`2. Add this DNS TXT record (TLS cert validation):`);
    console.log(`   name:  ${sslRecords[0].txt_name}`);
    console.log(`   value: ${sslRecords[0].txt_value}`);
    console.log("");
  } else {
    console.log("2. (No TLS validation records returned yet — re-query the API in 30s.)");
    console.log("");
  }

  console.log(`3. Once Cloudflare reports validation success, change the DNS record for`);
  console.log(`   ${args.hostname} to point at the Paperward edge:`);
  console.log(`   ${args.hostname}  CNAME  ${args.cname_target}`);
  console.log(``);
  console.log(`Check status:`);
  console.log(`   curl -H "Authorization: Bearer $CF_API_TOKEN" \\`);
  console.log(
    `     https://api.cloudflare.com/client/v4/zones/${process.env.CF_ZONE_ID}/custom_hostnames`,
  );
  console.log("──────────────────────────────────────────────");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
