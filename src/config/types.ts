// src/config/types.ts

export type TenantStatus = "active" | "log_only" | "paused_by_publisher" | "suspended_by_paperward";

export type PricingAction = "charge" | "allow" | "block";

export type PricingRule = {
  id: string;
  priority: number;
  path_pattern: string;
  agent_pattern: string;
  action: PricingAction;
  price_usdc?: string;
  enabled: boolean;
};

export type TenantConfig = {
  schema_version: 1;
  tenant_id: string;
  hostname: string;
  origin: string;
  status: TenantStatus;
  default_action: "allow" | "block";
  facilitator_id: string;
  payout_address: string;
  pricing_rules: PricingRule[];
  config_version: number;
  created_at: string;
  updated_at: string;
};

export type AuditEntry = {
  id: string;
  ts: string;
  tenant_id: string;
  hostname: string;
  actor: string;
  before: TenantConfig | null;
  after: TenantConfig;
};
