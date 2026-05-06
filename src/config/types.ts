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

/**
 * One accepted payment rail for a tenant. A tenant can configure multiple of
 * these — the 402 response will advertise all of them and the paywall middleware
 * dispatches to the correct facilitator based on the inbound X-PAYMENT header's
 * network.
 *
 * `payout_address` is chain-appropriate format (hex 0x... for EVM, base58 for SVM)
 * and validated at admin write time to match the facilitator's expected shape.
 */
export type AcceptedFacilitator = {
  facilitator_id: string;
  payout_address: string;
};

export type TenantConfig = {
  schema_version: 1;
  tenant_id: string;
  hostname: string;
  origin: string;
  status: TenantStatus;
  default_action: "allow" | "block";
  /** Multi-rail support: one or more facilitator+payout pairs the tenant accepts. */
  accepted_facilitators: AcceptedFacilitator[];
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
