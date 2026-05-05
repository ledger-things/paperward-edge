// src/logging/types.ts

export type Decision =
  | "allow"
  | "block"
  | "charge_paid"
  | "charge_no_payment"
  | "charge_verify_failed"
  | "charge_origin_failed"
  | "charge_unsettled"
  | "default_allow"
  | "would_allow"
  | "would_block"
  | "would_charge_paid"
  | "would_charge_no_payment"
  | "would_charge_verify_failed"
  | "would_default_allow"
  | "status_paused"
  | "status_suspended"
  | "tenant_unknown";

export type LogEntry = {
  id: string;
  ts: string;
  tenant_id: string;
  hostname: string;
  config_version: number;
  ray_id: string;
  method: string;
  path: string;
  agent_id: string | null;
  agent_signed: boolean;
  detector_id: string | null;
  decision: Decision;
  decision_reason: string | null;
  rule_id: string | null;
  price_usdc: string | null;
  paid: boolean;
  payment_tx: string | null;
  origin_status: number | null;
  latency_ms: number;
};
