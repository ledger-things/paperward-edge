// src/types.ts
//
// Top-level types for the Worker bindings (Env) and the per-request
// context state propagated through Hono middleware (Vars).

import type { TenantConfig } from "@/config/types";
import type { DetectionResult } from "@/detectors/types";
import type { VerifyResult } from "@/facilitators/types";
import type { Decision } from "@/logging/types";
import type { SentryLike } from "@/observability/sentry";

export type Env = {
  // Plain vars
  ENV: "dev" | "staging" | "production";
  ADMIN_HOSTNAME: string;
  HEALTH_HOSTNAME: string;

  // Secrets (set via wrangler secret put)
  ADMIN_TOKEN: string;
  SENTRY_DSN: string;
  COINBASE_FACILITATOR_KEY?: string;
  /** Optional Solana x402 facilitator URL; with SOLANA_FACILITATOR_FEE_PAYER, registers the SVM rail. */
  SOLANA_FACILITATOR_URL?: string;
  /** Pubkey of the Solana facilitator (advertised as `feePayer` in 402 responses). */
  SOLANA_FACILITATOR_FEE_PAYER?: string;
  /** Optional API key for the Solana facilitator. */
  SOLANA_FACILITATOR_API_KEY?: string;

  // Bindings
  KV_DOMAINS: KVNamespace;
  KV_KEY_CACHE: KVNamespace;
  KV_AUDIT: KVNamespace;
  R2_LOGS: R2Bucket;
  ANALYTICS: AnalyticsEngineDataset;
  RATE_LIMITER: DurableObjectNamespace;
  /** Optional: when bound, every decision is enqueued as BotEventV1 for ingestion. OSS forks without the binding are unaffected. */
  PAPERWARD_EVENTS?: Queue<unknown>;
  /** Optional: when bound, LLM-host referrals are enqueued as CitationReferralV1 for ingestion. OSS forks without the binding are unaffected. */
  PAPERWARD_REFERRALS?: Queue<unknown>;
};

export type DecisionState = {
  decision: Decision;
  decision_reason: string | null;
  rule_id: string | null;
  price_usdc: string | null;
  paid: boolean;
  payment_tx: string | null;
};

export type Vars = {
  request_id: string; // ULID, used as LogEntry.id
  request_started_ms: number; // performance.now() at entry
  tenant: TenantConfig | null; // null for the tenant_unknown short-circuit
  detection: DetectionResult | null;
  verify_result: VerifyResult | null;
  decision_state: DecisionState;
  origin_status: number | null;
  sentry: SentryLike; // per-request Sentry instance (set by logger middleware)
  /** Set by paywall middleware once a facilitator is selected — short rail name for BotEventV1.price.rail. */
  rail?: "base" | "solana";
  /** Set by paywall middleware after settle completes (successfully or otherwise) — facilitator-reported status string for BotEventV1.payment.facilitator_status. */
  facilitator_status?: string;
};
