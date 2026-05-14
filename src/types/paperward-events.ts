// src/types/paperward-events.ts
//
// Mirror of `@paperward/shared` BotEventV1 (structured shape).
// Source of truth: paperward/packages/shared/src/events.ts
//
// Both repos must agree on the `EdgeDecision` union. The canonical shared
// schema only enumerates the four "happy-path" decisions the control plane
// cares about today (`allow` | `charge_paid` | `charge_unpaid` | `block`),
// but the edge has a richer Decision union (charge_no_payment,
// charge_verify_failed, log-only `would_*` mirrors, status_paused, etc.).
//
// Rather than collapse everything to the four-value canonical set, we emit
// the full edge Decision string and rely on the control plane to widen its
// own enum to match. Keeping the edge value verbatim preserves debug fidelity
// (e.g. the difference between `charge_unsettled` and `charge_origin_failed`
// matters for support).

import type { Decision } from "@/logging/types";

/**
 * Decision values emitted on BotEventV1. Equal to the edge's `Decision`
 * union — the control plane validator must accept every value listed in
 * `src/logging/types.ts`. Currently:
 *   allow, block, charge_paid, charge_no_payment, charge_verify_failed,
 *   charge_origin_failed, charge_unsettled, default_allow,
 *   would_allow, would_block, would_charge_paid, would_charge_no_payment,
 *   would_charge_verify_failed, would_default_allow,
 *   status_paused, status_suspended, tenant_unknown.
 */
export type EdgeDecision = Decision;

export interface BotEventV1 {
  v: 1;
  event_id: string;
  ts: string;
  hostname: string;
  agent_id: string | null;
  agent_name: string;
  signed: boolean;
  path: string;
  decision: EdgeDecision;
  price?: { amount: string; currency: "USDC"; rail: "base" | "solana" };
  payment?: { tx_id: string; facilitator_status: string };
  client: {
    country?: string;
    ua_hash?: string;
    ip_hash?: string;
  };
}

/**
 * Mirror of `@paperward/shared` CitationReferralV1Schema.
 *
 * Edge emits this alongside BotEventV1 whenever the request carries an LLM
 * referer host on the allowlist (see src/utils/llm-referers.ts).
 *
 * Source of truth: paperward/packages/shared/src/events.ts
 */
export interface CitationReferralV1 {
  v: 1;
  event_id: string;
  ts: string;
  hostname: string;
  landing_path: string;
  landing_url: string;
  referrer_host: string;
  assistant: 'perplexity' | 'openai' | 'anthropic' | 'google' | 'other';
  client: {
    country?: string;
    ua_hash: string;
    ip_hash: string;
  };
}
