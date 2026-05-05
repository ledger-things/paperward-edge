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
//     --tenant-id=<uuid> \
//     --payout-address=0x... \
//     [--status=active|log_only|paused_by_publisher|suspended_by_paperward] \
//     [--default-action=allow|block] \
//     [--rules-file=path/to/rules.json]

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

type Args = {
  hostname: string;
  origin: string;
  payout_address: string;
  tenant_id?: string;
  status?: "active" | "log_only" | "paused_by_publisher" | "suspended_by_paperward";
  default_action?: "allow" | "block";
  rules_file?: string;
};

function parseArgs(): Args {
  const out: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([\w-]+)=(.*)$/);
    if (!m) {
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
  if (status && !["active", "log_only", "paused_by_publisher", "suspended_by_paperward"].includes(status)) {
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
    tenant_id: out.tenant_id,
    status,
    default_action,
    rules_file: out.rules_file,
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
    facilitator_id: "coinbase-x402-base",
    payout_address: args.payout_address,
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

async function registerCustomHostname(hostname: string): Promise<{ ssl_validation: { type: string; status: string; txt_name?: string; txt_value?: string } }> {
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
  const body = await r.json() as any;
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
  console.log(`1. Add this DNS TXT record to ${args.hostname}'s DNS:`);
  if (result.ssl_validation.txt_name && result.ssl_validation.txt_value) {
    console.log(`   name:  ${result.ssl_validation.txt_name}`);
    console.log(`   value: ${result.ssl_validation.txt_value}`);
  } else {
    console.log("   (Cloudflare did not return TXT validation values; check the dashboard)");
  }
  console.log("");
  console.log(`2. Once Cloudflare reports validation success, change the DNS record for`);
  console.log(`   ${args.hostname} to point at the Paperward edge:`);
  console.log(`   ${args.hostname}  CNAME  paperward-edge.workers.dev`);
  console.log(``);
  console.log(`Check status:`);
  console.log(`   curl -H "Authorization: Bearer $CF_API_TOKEN" \\`);
  console.log(`     https://api.cloudflare.com/client/v4/zones/${process.env.CF_ZONE_ID}/custom_hostnames`);
  console.log("──────────────────────────────────────────────");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
