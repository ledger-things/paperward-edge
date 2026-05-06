---
title: Paperward Edge Layer v0 — Design Spec
status: Draft v1.0 — pending user review
date: 2026-05-05
owner: Founder
parent_doc: ../../../PRD.md
license: Apache-2.0 (codebase published from commit 1)
---

# Paperward Edge Layer v0 — Design Spec

## 1. Context

This spec designs the v0 edge layer of Paperward, the agent-payments platform described in the project PRD (`../../../PRD.md`, §6–7.1). The edge layer sits between AI agents (or human visitors) and a publisher's origin, identifies agent traffic, applies pricing rules, charges via x402 when configured, and forwards approved traffic to the origin.

This is the first subsystem to be built. The PRD also describes a control plane, a WordPress plugin, a Next.js middleware package, and a Stripe-Connect-backed payouts pipeline; each will be designed and built in its own cycle, integrating against contracts established here.

### 1.1 Why this first

- The riskiest technical bet in the PRD: nothing else matters if Web Bot Auth (RFC 9421) and x402 (Coinbase facilitator) do not actually compose into a single working pipeline.
- No upstream dependencies; can be built and tested in isolation against a curl-able sandbox agent.
- All other subsystems integrate via contracts established here (KV config schema, log schema, admin endpoint API). Designing those contracts first prevents downstream rework.

### 1.2 Success criterion

A publisher domain (separate from `paperward.com`, supplied at provisioning time) is fronted by the edge layer with these observed behaviors:

1. A signed Web Bot Auth request without payment receives `402 Payment Required` with valid x402 payment-requirement headers.
2. A signed Web Bot Auth request with a valid x402 payment receives the requested content, settles USDC to the configured payout address, and returns `X-PAYMENT-RESPONSE`.
3. A browser request receives the publisher's content unchanged.
4. All three cases produce structured log records in durable storage.
5. The publisher can change pricing without redeploying the Worker.

### 1.3 Anti-goals

The v0 explicitly does not aim to be deployable by a non-technical publisher (that is the WordPress plugin's job, designed later) and explicitly does not aim to handle the full Tier 2/Tier 3 detection surface (those slot in via the `Detector` interface defined here).

## 2. Goals & non-goals

### 2.1 In scope (v0)

- Multi-tenant from day one — one Worker fronts many publisher hostnames via Cloudflare Custom Hostnames / SSL-for-SaaS.
- Web Bot Auth detection (Tier 1) per RFC 9421, using the `web-bot-auth` Stytch reference package.
- Human detection fallback (browser-shaped UA + presence of `Accept-Language` + absence of WBA signature).
- Pricing rule grammar with `charge | allow | block` actions and per-tenant `default_action`.
- x402 paywall via the public Coinbase x402 facilitator (`x402.org/facilitator`), USDC on Base mainnet (Sepolia for staging).
- Origin forwarding via streamed `fetch()`.
- Structured request logs to R2 (one ND-JSON object per request in v0; batched-via-Queues is a deferred extension).
- Operational logs via `console.*` to Workers Logs / `wrangler tail`.
- Sentry exception capture via `toucan-js`.
- Workers Analytics Engine for business-shaped metrics.
- Admin endpoint for KV-backed tenant config writes, auth'd via `ADMIN_TOKEN`.
- `bin/provision-tenant.ts` CLI wrapping the admin endpoint and Cloudflare Custom Hostnames API.
- Three Wrangler environments: `dev`, `staging`, `production`.
- Tenant-level `status: active | log_only | paused_by_publisher | suspended_by_paperward` for safe onboarding and kill-switching.
- Apache 2.0 license, public GitHub repo from commit 1.

### 2.2 Designed-for, not implemented

Each item below has its extension point reserved in the v0 architecture; the implementation is out of scope.

- Tier 2 detector (UA + IP-range matching against known agent registry).
- Tier 3 detector (TLS fingerprint, behavioral heuristics).
- Rate limiter (`RateLimiterDO` Durable Object slot).
- Settlement retry queue (CF Queues consumer for failed `Facilitator.settle()` calls).
- Origin response caching middleware.
- Additional facilitators (MPP, Skyfire, Mastercard Agent Pay).
- Per-tenant query-string capture in logs.
- Per-tenant facilitator override (the field exists; v0 only registers Coinbase).

### 2.3 Out of scope

- Multi-cloud / Fly.io fallback (PRD Phase 4).
- Pre-fund / pre-authorize agent API (PRD Phase 4).
- Webhooks for publishers.
- Origin retries.
- Response caching by Paperward.
- Payouts to publishers (a control-plane responsibility integrating against R2 logs).

## 3. Architecture overview

A single Cloudflare Worker hosts the entire edge pipeline. Hono middleware composes the request flow:

```
Inbound request
  ↓
1. tenantResolver       Host header → KV lookup → TenantConfig on ctx
  ↓
2. detectorPipeline     Ordered Detector[]; first match wins; produces DetectionResult
  ↓
3. pricingResolver      Rules walk + default_action → Decision (allow | block | charge)
  ↓
4. paywall (charge)     Facilitator.verify() → 402 or pass-through
  ↓
5. originForwarder      fetch() to TenantConfig.origin, streamed
  ↓
6. paywall.post (charge & origin 2xx)   Facilitator.settle() → X-PAYMENT-RESPONSE attached
  ↓
7. logger               executionCtx.waitUntil → R2 ND-JSON
  ↓
Outbound response
```

### 3.1 Bindings

| Binding | Type | Purpose |
|---|---|---|
| `KV_DOMAINS` | KV namespace | Tenant configs keyed `domains:{hostname}` |
| `KV_KEY_CACHE` | KV namespace | Cached Ed25519 public keys for WBA verification (TTL ~1h) |
| `KV_AUDIT` | KV namespace | Tenant config change audit records |
| `R2_LOGS` | R2 bucket | Request log objects |
| `ANALYTICS` | Analytics Engine dataset | Custom counters and latency histograms |
| `ENV` | plain var | `dev | staging | production` — drives network selection and other env-specific behavior |
| `ADMIN_HOSTNAME` | plain var | Hostname on which admin endpoints are mounted (Paperward production: `admin.paperward.com`; self-hosters configure their own); never a tenant hostname |
| `HEALTH_HOSTNAME` | plain var | Hostname on which health endpoints are mounted (Paperward production: `health.paperward.com`); never a tenant hostname |
| `RATE_LIMITER` (deferred) | Durable Object | Class declared and binding present so future deploys do not require schema migrations; not invoked from any middleware in v0 |
| `Q_SETTLE_RETRY` (deferred) | Queue producer | Binding declared in `wrangler.toml` only; no producer call site in v0 code (avoids shipping flag-gated dead code without an off-path test). Producer + consumer added together when settlement-retry feature is built. |

### 3.2 Why a single Worker

Single-Worker keeps cold-start and hop latency minimal and matches the request flow's natural sequence. Durable Object usage is reserved for future per-tenant stateful concerns (rate limiting, idempotency) but not required by any v0 feature. Splitting into RPC-bound service Workers is a future scaling option once any module's release cadence diverges from the others; in v0 the same modularity is achieved via TypeScript module boundaries.

## 4. Data model & contracts

These types are the final shape. v0 implements a subset of behaviors against them; future versions add behaviors without changing the shape.

### 4.1 Tenant configuration (`KV_DOMAINS`)

Key: `domains:{hostname}`

Value:

```ts
type TenantConfig = {
  schema_version: 1;
  tenant_id: string;                       // UUIDv4; survives hostname changes
  hostname: string;                        // matches the KV key suffix
  origin: string;                          // https://... — verified/free traffic forwards here
  status: TenantStatus;                    // single field replaces the old enabled+mode pair
  default_action: "allow" | "block";       // "charge" disallowed as default — write an explicit "*" rule instead
  facilitator_id: string;                  // "coinbase-x402-base" in v0
  payout_address: string;                  // USDC recipient address on Base
  pricing_rules: PricingRule[];            // evaluated in priority order; first match wins
  config_version: number;                  // monotonic; incremented on every write; recorded in each LogEntry for stale-cache correlation
  created_at: string;                      // ISO 8601
  updated_at: string;                      // ISO 8601
};

type TenantStatus =
  | "active"                               // full pipeline: detection + pricing + paywall (when applicable) + forward
  | "log_only"                             // full pipeline runs and verify is called read-only, but no 402 is ever issued and settle is skipped; always forward to origin
  | "paused_by_publisher"                  // publisher self-paused: bypass to origin, no detection, minimal log
  | "suspended_by_paperward";              // operator-side suspension (billing, abuse): bypass to origin, no detection, minimal log
```

#### 4.1.1 Status semantics

The single `status` field consolidates what would otherwise be `enabled: bool` plus `mode: enum`. Behavior per value:

- `active` — normal pipeline. The publisher has opted in to enforcement.
- `log_only` — onboarding / observation mode. Detection runs. Pricing runs. `paywall` invokes `verify()` *read-only* (so log entries can record whether agents *would* have paid), but no 402 is ever issued and `settle()` is never called. Origin always serves. Decision values use `would_*` prefixes.
- `paused_by_publisher` — publisher chose to suspend Paperward without uninstalling. Worker becomes a transparent pass-through; minimal log entry. Distinct from suspension because the publisher controls it.
- `suspended_by_paperward` — operator suspended the tenant (e.g., billing failure). Same traffic behavior as `paused_by_publisher`, different log decision so the cause is auditable.

The Worker NEVER breaks the publisher's site for `paused_by_publisher` or `suspended_by_paperward` — origin is always reachable through the proxy.

### 4.2 Pricing rules

```ts
type PricingRule = {
  id: string;                              // ULID
  priority: number;                        // lower runs first
  path_pattern: string;                    // exact ("/foo") or suffix wildcard ("/articles/*"); v0 stops here
  agent_pattern: string;                   // "*" | "signed:*" | "signed:openai.com" | "unsigned:*" | "unsigned:gptbot" | "human"
  action: "charge" | "allow" | "block";
  price_usdc?: string;                     // decimal string ("0.005"); required iff action === "charge"
  enabled: boolean;
};
```

Evaluation: rules walked in ascending `priority`; first rule whose `path_pattern` AND `agent_pattern` both match wins. No match → fall through to `default_action`. `enabled: false` rules are skipped.

`price_usdc` is a decimal string (not a JS number) to avoid float precision and to match how x402 represents amounts.

### 4.3 Pattern matchers

- **`path_pattern`**: exact match (`/foo`), or `*` for any path, or suffix wildcard (`/articles/*` matches `/articles/x` and `/articles/x/y`). No regex, no glob libraries. Implementation lives in `src/utils/patterns.ts`.
- **`agent_pattern`**: matches the `DetectionResult.agent_id` produced by the detector pipeline. Forms:
  - `*` matches any agent_id including null
  - `signed:*` matches any agent_id starting with `signed:`
  - `signed:{operator}` matches exactly (e.g., `signed:openai.com`)
  - `unsigned:*` matches any agent_id starting with `unsigned:`
  - `unsigned:{name}` matches exactly
  - `human` matches `agent_id === "human"`
  - `unknown` matches the explicit "fell through every detector" case (`agent_id === null`); separate from `*` so a publisher can write rules specifically for unidentified traffic without affecting all-agents rules

### 4.4 Detector interface

```ts
type DetectionResult = {
  agent_id: string;                        // "signed:{operator}" | "unsigned:{name}" | "human"
  signed: boolean;
  detector_id: string;
  confidence: "high" | "medium" | "low";
};

interface Detector {
  id: string;                              // unique, matches DetectionResult.detector_id
  priority: number;                        // ascending; first non-null wins
  detect(req: Request): Promise<DetectionResult | null>;
}
```

v0 registry (`src/detectors/registry.ts`):

| Detector | Priority | Behavior |
|---|---|---|
| `WebBotAuthDetector` | 10 | Verifies RFC 9421 signature; returns `signed:{operator}` on success, null otherwise |
| `HumanDetector` | 100 | Returns `human` if browser-shaped UA + `Accept-Language` present + no signature header; null otherwise |

Anything that falls through both detectors gets `agent_id: null`. The `pricingResolver` treats null as "unknown agent traffic" — falls through to `default_action`, which v0 leaves as `allow` (PRD §11 conservatism: false positives blocking real users is the higher-cost failure).

Tier 2 (`KnownAgentRegistryDetector`, priority 50) and Tier 3 (`HeuristicDetector`, priority 90) drop into the registry array later without pipeline changes.

### 4.5 Facilitator interface

```ts
type PaymentRequirements = {
  amount_usdc: string;                     // "0.005"
  recipient: string;                       // tenant.payout_address
  resource: string;                        // canonical URL of the resource being paid for
  network: "base-mainnet" | "base-sepolia";
};

type VerifyResult = {
  valid: boolean;
  payer?: string;
  reason?: string;
  settlement_handle?: unknown;             // facilitator-specific opaque token consumed by settle()
};

type SettleResult = {
  success: boolean;
  tx_reference?: string;
  reason?: string;
};

interface Facilitator {
  id: string;                              // matches TenantConfig.facilitator_id
  build402(req: PaymentRequirements, error?: string): Response;
  verify(req: Request, requirements: PaymentRequirements): Promise<VerifyResult>;
  settle(verify: VerifyResult): Promise<SettleResult>;
}
```

v0 ships `CoinbaseX402Facilitator` (id: `coinbase-x402-base`) wrapping `x402-hono` primitives. Tenant configs select via `facilitator_id`; future MPP/Skyfire/Mastercard implementations register into `src/facilitators/registry.ts` and are selectable per-tenant.

### 4.6 Request log entry

One ND-JSON object per request, written to R2 at:

```
requests/{ulid_prefix}/dt={YYYY-MM-DD}/tenant={tenant_id}/{ulid}.ndjson
```

Where `{ulid_prefix}` is the first 4 characters of the ULID. **Prefix-first ordering is deliberate**: R2 rate-limits PUTs per prefix (~1000 ops/sec ramping). Putting the time-sortable ULID prefix first spreads writes across 4096 prefix shards (`0000` … `ffff` lowercase hex) so a viral tenant cannot bottleneck on a single prefix. Date and tenant are still in the path so log readers can filter by either.

Each object contains a single line with this shape:

```ts
type LogEntry = {
  id: string;                              // ULID, sortable by time
  ts: string;                              // ISO 8601
  tenant_id: string;
  hostname: string;
  config_version: number;                  // copy of TenantConfig.config_version at decision time; lets log analysis correlate decisions with the config that produced them, including across stale-cache windows
  ray_id: string;                          // Cloudflare ray ID for cross-system tracing
  method: string;
  path: string;                            // query string stripped (privacy default)
  agent_id: string | null;
  agent_signed: boolean;
  detector_id: string | null;
  decision: Decision;
  decision_reason: string | null;          // populated for charge_verify_failed, charge_origin_failed, charge_unsettled, tenant_unknown — short token like "no_payment_header", "invalid_amount", "facilitator_unavailable", "origin_5xx", "origin_throw", "settle_failed"
  rule_id: string | null;
  price_usdc: string | null;
  paid: boolean;
  payment_tx: string | null;
  origin_status: number | null;
  latency_ms: number;
};

type Decision =
  | "allow"
  | "block"
  | "charge_paid"                          // verify ok, origin 2xx, settle ok; paid: true
  | "charge_no_payment"                    // X-PAYMENT header missing; 402 issued; paid: false
  | "charge_verify_failed"                 // X-PAYMENT present but verify rejected, OR facilitator unreachable; 402 (or 503) issued; paid: false
  | "charge_origin_failed"                 // verify ok, but origin throw/timeout/non-2xx; settle skipped; paid: false
  | "charge_unsettled"                     // verify ok, origin 2xx, settle failed; content streamed but no commit; paid: false
  | "default_allow"
  | "would_allow"
  | "would_block"
  | "would_charge_paid"                    // log_only mode; verify ran read-only and would have succeeded
  | "would_charge_no_payment"              // log_only mode; no X-PAYMENT header observed
  | "would_charge_verify_failed"           // log_only mode; verify ran read-only and would have rejected
  | "would_default_allow"
  | "status_paused"                        // status === "paused_by_publisher"
  | "status_suspended"                     // status === "suspended_by_paperward"
  | "tenant_unknown";                      // KV miss; invariant violation
```

The split of the old single `charge_unpaid` value into four (`charge_no_payment`, `charge_verify_failed`, `charge_origin_failed`, `charge_unsettled`) is deliberate — analytics and reconciliation need to distinguish "agent didn't try to pay" from "we couldn't deliver." `decision_reason` carries finer-grained tokens for downstream alerting.

`would_*` decisions exist only when `status === "log_only"` and require verify to run read-only so the publisher can actually see projected revenue. `status_paused` / `status_suspended` correspond to the two pass-through statuses. `tenant_unknown` is the invariant violation case (Custom Hostname routed to us but no KV entry).

The schema is final shape. The storage strategy (one R2 object per request) is a v0 simplification; the deferred Queue-batched writer produces R2 objects of the same shape.

### 4.7 Audit record (`KV_AUDIT`)

Key: `audit:{ulid}`

Value:

```ts
type AuditEntry = {
  id: string;                              // ULID
  ts: string;                              // ISO 8601
  tenant_id: string;
  hostname: string;
  actor: string;                           // identity of the writer (admin token holder, control-plane API, etc.)
  before: TenantConfig | null;             // null for first write
  after: TenantConfig;
};
```

Audit entries are written exclusively by the admin endpoint. Direct `wrangler kv:key put` edits bypass auditing — operationally discouraged; not enforced in v0.

## 5. Request flow

The middleware pipeline runs in fixed order. Each middleware reads the prior middleware's result from the Hono context and writes its own.

### 5.1 `tenantResolver`

1. Read `Host` request header.
2. Look up `domains:{hostname}` in `KV_DOMAINS` via the cached reader (§6.1).
3. If no entry: short-circuit with `503` and a `Decision: "tenant_unknown"` log entry. Sentry alert.
4. Attach `TenantConfig` to ctx.
5. Branch on `status`:
   - `paused_by_publisher` → call `originForwarder` directly with a minimal-log decision `status_paused`.
   - `suspended_by_paperward` → same with `status_suspended`.
   - `active` → continue with full pipeline.
   - `log_only` → continue with full pipeline; downstream middleware honors log-only semantics (verify runs read-only, no 402, no settle).
6. The Worker NEVER returns an error response for `paused_by_publisher` or `suspended_by_paperward`. The publisher's site stays reachable through the proxy regardless of Paperward's internal state.

### 5.2 `detectorPipeline`

1. Iterate the `Detector[]` registry in ascending priority order.
2. For each detector, call `detect(req)`. First non-null result wins.
3. Attach `DetectionResult | null` to ctx.
4. Failures inside any detector are caught at the middleware boundary, logged + Sentry'd, and treated as "this detector returned null" — pipeline continues.

### 5.3 `pricingResolver`

1. Walk `tenant.pricing_rules` in ascending `priority`.
2. For each enabled rule, evaluate `(path_pattern matches request path) AND (agent_pattern matches DetectionResult.agent_id)`. First match wins.
3. If no rule matches, use `tenant.default_action` (synthesizing a virtual rule for logging).
4. Attach `Decision` (action, price, matching rule id) to ctx.
5. If `status === "log_only"`: still attach the decision, but mark it as "would have been" so downstream middleware honors log-only behavior.

### 5.4 `paywall` (only when action is `charge`)

The same code path runs for both `active` and `log_only` statuses; the only difference is whether verify outcomes produce 402 / settle calls or merely populate log decisions.

#### 5.4.1 Common path (both statuses)

1. Build `PaymentRequirements { amount_usdc, recipient = tenant.payout_address, resource = canonical URL, network = env-driven }`.
2. Look up the facilitator by `tenant.facilitator_id` from the registry. If unknown: 503 + Sentry. (Same response in both statuses; an unknown facilitator is a config error, not a billing decision.)
3. Inspect `X-PAYMENT` header presence and call `verify` if present.

#### 5.4.2 `status === "active"`

1. If `X-PAYMENT` header is missing → return `facilitator.build402(requirements)`. Decision: `charge_no_payment`. End.
2. Call `await facilitator.verify(req, requirements)`.
3. If `verify` throws or is unreachable: 503, Sentry alert. Decision: `charge_verify_failed`, `decision_reason: "facilitator_unavailable"`. **Fail closed.** End.
4. If `verify` returns `valid: false`: return `facilitator.build402(requirements, reason)`. Decision: `charge_verify_failed`, `decision_reason: <facilitator-supplied reason>` (e.g., `"invalid_amount"`, `"expired"`, `"wrong_recipient"`). End.
5. Attach the `VerifyResult` to ctx; continue to `originForwarder`.

#### 5.4.3 `status === "log_only"`

`log_only` runs verify *read-only* — never issues 402, never calls settle, always forwards to origin. This gives publishers a true revenue projection during onboarding.

1. If `X-PAYMENT` header is missing → log decision `would_charge_no_payment`; continue to `originForwarder`.
2. Call `await facilitator.verify(req, requirements)`.
3. If `verify` throws or is unreachable: log decision `would_charge_verify_failed`, `decision_reason: "facilitator_unavailable"`; continue to `originForwarder`. (No 503 — log-only must not break the site.)
4. If `verify` returns `valid: true`: log decision `would_charge_paid`; continue to `originForwarder`. **Crucially, do NOT call settle.** The agent's payment was attested but no commit was attempted.
5. If `verify` returns `valid: false`: log decision `would_charge_verify_failed`, `decision_reason: <facilitator-supplied>`; continue to `originForwarder`.

Read-only verify in log-only mode is safe: x402 verification per the Coinbase facilitator design is a signature check, not an on-chain action — it does not create a hold, charge gas, or persist state on the agent's wallet.

#### 5.4.4 Time skew tolerance

Both verify outcomes can fail on time skew. The WBA `created` timestamp window is configured at 60s tolerance (matches Coinbase reference defaults); the x402 payment validity window is whatever Coinbase asserts. These are not adjustable per-tenant in v0; the `decision_reason` captures `"timestamp_out_of_window"` so operations can correlate skew issues with PoP geography.

### 5.5 `originForwarder`

1. Build a forwarded request:
   - URL: `tenant.origin` + request path + query
   - Method, body: preserved
   - Headers: cleaned (strip `X-PAYMENT`, `Signature`, `Signature-Input`, `Signature-Agent`, any `X-Paperward-*`); add `X-Paperward-Tenant-Id`, `X-Paperward-Agent-Id`, `X-Paperward-Decision`, `X-Forwarded-For`, `X-Forwarded-Proto`.
2. Call `fetch(origin, ...)` with the Workers default 30s timeout.
3. Stream the response body back to the client.
4. Failure handling:
   - If `fetch()` throws or times out: return 502 to the client. If charge path was taken in `active` mode, skip `settle()` and final decision is `charge_origin_failed` with `decision_reason: "origin_throw"` or `"origin_timeout"`.
   - If origin returns a non-2xx status (4xx or 5xx): stream the response back to the client unchanged. If charge path was taken in `active` mode, skip `settle()` and final decision is `charge_origin_failed` with `decision_reason: "origin_<status>"`. The publisher's site decided not to serve a successful response; we do not commit a payment for that.
   - If origin returns 2xx: continue to `paywall.post` if charge path was taken in `active` mode; otherwise finalize.
5. Attach `origin_status` to ctx for the logger.

Note that x402 verification per the Coinbase facilitator is a signature check, not an on-chain authorization hold — there is no auto-expiring hold to refund when we skip settle. The agent simply does not get charged for the failed delivery.

### 5.6 `paywall.post` (only when verify succeeded and origin returned 2xx)

Runs only when `status === "active"`, verify succeeded, and origin returned 2xx. (`log_only` never reaches this middleware.)

1. Call `await facilitator.settle(verifyResult)`.
2. If `settle` returns `success: true`: attach `X-PAYMENT-RESPONSE` (containing `tx_reference`) to the outgoing response. Decision: `charge_paid`. `paid: true`. `payment_tx` populated.
3. If `settle` returns `success: false` or throws: log + Sentry alert; **return the streamed response anyway** (the agent has likely already received some or all of the content). Decision: `charge_unsettled`, `decision_reason: "settle_failed"` or specific facilitator-supplied reason. `paid: false`. `payment_tx: null`. The metric `paywall_settle_failures_total` increments. Reconciliation is manual in v0; the deferred retry queue automates it later.

**Why settle-after-stream and not buffer-then-settle.** A stricter model would buffer the origin response in memory, call `settle()`, and only stream to the agent on settlement success. We reject that for v0 because: (a) Workers have a hard memory cap (~128 MB per request) that buffering would burn for large content; (b) it would add settlement latency to time-to-first-byte for *every* charged request, not just the rare settle-failure case; (c) the CF Workers streaming model is designed around `Response` objects whose body is consumed downstream, not buffered. We accept `charge_unsettled` as the explicit reconciliation case and track its rate via `paywall_settle_failures_total`. If real-world settle-failure rates exceed an acceptable threshold (e.g., >0.5%), the deferred retry-queue (§11.1) automates recovery.

The settle-after-origin order (verify → forward → settle) is deliberate. Verifying before serving protects against settlement risk (the payment is validated before content is delivered). Settling after origin success means we don't commit the payment if origin failed.

### 5.7 `logger`

`executionCtx.waitUntil(writeLog(entry))` where `writeLog` performs a single R2 PUT to the partitioned key. The PUT is fire-and-forget from the request's perspective. R2 write failures log + Sentry but do not affect the user response.

## 6. Implementation details

### 6.1 KV config cache

Two layers compose for KV reads:

1. **Module-scoped isolate cache.** A `Map<hostname, { config: TenantConfig, fetched_at: number }>` per Worker isolate. 60s freshness window.
2. **Cloudflare's KV edge cache.** All KV `get()` calls pass `{ cacheTtl: 60 }` so Cloudflare's documented edge cache layer also serves repeat reads from the same PoP without round-tripping to KV's origin store. Independent of isolate memory; survives isolate eviction.

Lookup order on each request:

1. If hostname in isolate-cache map AND `fetched_at` within 60s: return cached config.
2. Otherwise: KV `get()` with `cacheTtl: 60`. On success, populate isolate cache and return.
3. If KV read times out:
   - If a stale isolate-cache entry exists: return stale entry; emit warning metric `kv_config_cache{outcome=stale}`; Sentry warn.
   - Else: 503 + Sentry alert.

The two-layer cache is necessary because isolate caches are aggressively evicted (especially for low-traffic tenants); the cf.cacheTtl layer absorbs cold isolates without hitting KV's origin every time. The cost estimate "<$1/mo" assumes both layers are working; without cf.cacheTtl, KV reads scale linearly with cold-isolate traffic.

`TenantConfig.config_version` is copied into every `LogEntry` so analytics can correlate a decision with the config snapshot that produced it (especially useful during the up-to-60s stale-cache window after a publisher updates pricing). v0 does not use it for active invalidation; that becomes a control-plane concern later.

### 6.2 Web Bot Auth detector — verification, public-key fetch, hardening

#### 6.2.1 Verification flow

`WebBotAuthDetector.detect()`:

1. Read `Signature`, `Signature-Input`, `Signature-Agent` request headers. If any are missing, return `null` (not a WBA-signed request).
2. **Validate the `Signature-Agent` URL before any outbound fetch** (see 6.2.3 for SSRF rules). If validation fails, return `null` and log + Sentry.
3. Look up the public key for the agent (see 6.2.2).
4. Verify the Ed25519 signature over the declared components per RFC 9421.
5. **`@authority` matching**: the signed `@authority` component MUST match the *original* request's `Host` header (the publisher hostname the agent dialed), not any post-rewrite Host. This prevents an attacker from signing for `example.com` and replaying against `victim.com`. If the match fails, return `null` and log.
6. **Timestamp validity**: the signature `created` parameter must be within ±60s of the Worker's current time. Outside the window → return `null` with `decision_reason: "timestamp_out_of_window"` recorded.
7. On all checks passing, return `{ agent_id: "signed:{operator}", signed: true, detector_id: "web-bot-auth", confidence: "high" }`.

#### 6.2.2 Public-key cache

Public keys are fetched from `{Signature-Agent URL}/.well-known/http-message-signatures-directory`. To avoid hitting this per request:

1. Cache lookup in `KV_KEY_CACHE` keyed by the validated `Signature-Agent` URL with 1h TTL on success, 60s TTL on failure (negative cache).
2. On cache miss: HTTP fetch (with hardening per 6.2.3), parse the directory, cache the result, proceed.
3. If fetch fails (network, DNS, 5xx, timeout, response too large): write negative-cache entry, return `null` from `detect()` (treat as unsigned). Pipeline continues.
4. **In-flight dedupe** within an isolate: if multiple concurrent requests trigger a cache miss for the same `Signature-Agent` URL, only one outbound fetch runs; the others await the same `Promise`. Prevents amplification on cold-cache bursts.

#### 6.2.3 SSRF hardening on `Signature-Agent` fetch

`Signature-Agent` is attacker-controllable (the agent provides it). Without validation, the Worker becomes an SSRF amplifier. The validation rules, applied before any cache lookup or fetch:

- **Scheme** must be exactly `https://`. Reject `http`, `file`, `data`, etc.
- **Host** must be a public hostname:
  - Reject IP literals (both IPv4 and IPv6).
  - Reject hostnames resolving to private/reserved/loopback ranges (RFC 1918, link-local, CGNAT, ULA, etc.). Validation done by lexical inspection where possible; for hosts that look public, the fetch itself is bounded by the timeout/size caps below.
  - Reject hostnames without a public TLD (lexical: must contain a dot and have a TLD ≥ 2 chars).
- **Path** is fixed to `/.well-known/http-message-signatures-directory` — anything else in `Signature-Agent` is overridden. (We never honor an arbitrary path the agent supplies.)
- **Outbound fetch caps**:
  - Timeout: 5 seconds.
  - Response body size: 64 KB (truncate-and-fail anything larger).
  - HTTP redirects: not followed.
- **Negative-cache** any failure for 60s to prevent burst amplification: an attacker sending 10K signed requests with a victim URL incurs at most one outbound fetch per minute, plus the deduped in-flight one per isolate.

Validation failures are logged + Sentry'd at low frequency (rate-limited per source IP) so a flood of malformed signatures does not flood Sentry.

### 6.3 Origin forwarding header rules

| Direction | Header | Behavior |
|---|---|---|
| Inbound → Origin | `X-PAYMENT`, `Signature`, `Signature-Input`, `Signature-Agent` | Strip |
| Inbound → Origin | `X-Paperward-*` | Strip; only we may set these |
| Inbound → Origin | All other request headers | Pass through |
| Inbound → Origin | (Synthesized) | Add `X-Paperward-Tenant-Id`, `X-Paperward-Agent-Id`, `X-Paperward-Decision`, `X-Forwarded-For`, `X-Forwarded-Proto` |
| Origin → Outbound | All response headers | Pass through |
| Origin → Outbound | (Synthesized when applicable) | Add `X-PAYMENT-RESPONSE` (after successful `settle()`) |

### 6.4 Idempotency for x402

v0 relies on the Coinbase facilitator's nonce/replay protection: a payment payload with a previously-seen nonce is rejected at `verify()` time. The Worker does not maintain its own idempotency layer.

**Assumption being made:** the Coinbase facilitator's nonce-store is atomic per nonce (no eventually-consistent window during which a replay could be double-verified). This is the documented behavior; v0 trusts it.

**If real-world testing or facilitator behavior changes show this assumption fails:** add a Worker-side idempotency check by hashing `(tenant_id, X-PAYMENT payload)` and recording attempts in a Durable Object (the future `RateLimiterDO` slot can host this). The relevant signal would be `paywall_settle_failures_total{reason: "double_settle"}` or duplicate `payment_tx` references in `LogEntry` records — both observable from Analytics Engine + R2 logs.

This is documented as an accepted v0 risk, not a deferred-design item: the slot for the fix exists, and the metric to detect the failure is in place.

### 6.5 Privacy

- Strip query strings from `LogEntry.path`. Per-tenant opt-in to retain query strings is a deferred extension.
- Never log `Authorization`, `Cookie`, or `X-PAYMENT` header values.
- Never log request bodies.
- Tenant `payout_address` is stored in KV but never appears in request logs or operational logs.

## 7. Repo layout

```
edge/
  src/
    index.ts                      # Hono app + middleware composition; entry point
    middleware/
      tenantResolver.ts
      detectorPipeline.ts
      pricingResolver.ts
      paywall.ts                  # both pre-origin (verify, 402) and post-origin (settle) phases
      originForwarder.ts
      logger.ts
    detectors/
      types.ts                    # Detector, DetectionResult
      web-bot-auth.ts             # Tier 1
      human.ts                    # browser fallback
      registry.ts                 # exports active Detector[]
    facilitators/
      types.ts                    # Facilitator, PaymentRequirements, VerifyResult, SettleResult
      coinbase-x402.ts            # CoinbaseX402Facilitator wrapping x402-hono
      registry.ts                 # facilitator_id → impl
    config/
      kv.ts                       # KV read with isolate cache
      types.ts                    # TenantConfig, PricingRule
      patterns.ts                 # path/agent matching
    logging/
      types.ts                    # LogEntry, Decision
      r2-writer.ts                # ND-JSON PUT
      audit.ts                    # KV audit record writer
    admin/
      index.ts                    # Hono sub-app for /__admin/* routes
      auth.ts                     # ADMIN_TOKEN check
      tenants.ts                  # POST /tenants, PUT /tenants/{hostname}
    metrics/
      analytics-engine.ts         # custom counter helpers
  test/
    unit/                         # vitest, fast
    integration/                  # vitest + miniflare; pipelines through Hono with mocked bindings
    e2e/                          # node script run against the deployed staging Worker
    fixtures/
      wba/                        # Ed25519 keypair + signed-request generator
      x402/                       # known-good and known-bad payment headers
    mocks/
      facilitator.ts              # MockFacilitator with configurable verify/settle outcomes
      origin.ts                   # mock origin server for integration tests
  bin/
    provision-tenant.ts           # wraps admin endpoint + CF Custom Hostnames API; outputs DCV instructions
  wrangler.toml
  package.json
  tsconfig.json
  README.md                       # written for an external reader; explains self-host path
  LICENSE                         # Apache-2.0
  CONTRIBUTING.md                 # "PRs not accepted until v0 is stable; issues welcome"
```

The `admin/` sub-app is mounted at `/__admin/*` on an operator-owned hostname (Paperward production uses `admin.paperward.com`; self-hosters configure their own via the `ADMIN_HOSTNAME` env var in `wrangler.toml`). It is NEVER mounted on tenant hostnames. The Worker routes requests to admin handlers when `Host` matches the configured admin hostname; otherwise it routes to the tenant pipeline.

The admin endpoint is the single contract through which tenant configs are written; `bin/provision-tenant.ts` is the v0 CLI client; the v1 control plane will be the second client speaking the same contract.

## 8. Deployment topology

### 8.1 Cloudflare Custom Hostnames flow

Provisioning a tenant follows this sequence (driven by `bin/provision-tenant.ts`):

1. Operator runs `bin/provision-tenant.ts <hostname> <origin> [--payout-address=...] [--config=...]`.
2. The script POSTs the tenant config to the admin endpoint, which writes to `KV_DOMAINS` and writes an audit record to `KV_AUDIT`.
3. The script calls Cloudflare API `POST /zones/{zone_id}/custom_hostnames` with the hostname and DCV settings.
4. Cloudflare returns a TXT record value for ownership validation.
5. The script prints DCV instructions for the publisher: "add TXT record `_acme-challenge.{hostname}` with value `...`, then change `{hostname}` CNAME to `<our CF target>`."
6. Once DCV completes (operator monitors via `cf custom-hostnames status`), Cloudflare auto-issues a TLS cert and routes traffic to the Worker.
7. Worker receives requests with `Host: {hostname}`; `tenantResolver` finds the config.

Apex domain support (e.g., `example.com` rather than `blog.example.com`) works for publishers whose DNS is on Cloudflare (CNAME flattening) or via documented A records pointing to Cloudflare IPs. Both modes are supported without architectural change.

### 8.2 Environments

Three Wrangler environments declared in a single `wrangler.toml`:

| Env | KV namespaces | R2 bucket | Network | Notes |
|---|---|---|---|---|
| `dev` | `KV_DOMAINS_DEV`, `KV_KEY_CACHE_DEV`, `KV_AUDIT_DEV` | `R2_LOGS_DEV` | base-sepolia | Local `wrangler dev` + miniflare; mock signed-agent fixtures |
| `staging` | `KV_DOMAINS_STAGING`, `KV_KEY_CACHE_STAGING`, `KV_AUDIT_STAGING` | `R2_LOGS_STAGING` | base-sepolia | Deployed staging Worker; real DCV against a staging hostname; e2e tests run against this |
| `production` | `KV_DOMAINS_PROD`, `KV_KEY_CACHE_PROD`, `KV_AUDIT_PROD` | `R2_LOGS_PROD` | base-mainnet | Real publisher domains and real USDC |

Promotion: code change → merge to main → CI deploys to staging → e2e suite passes → manual `wrangler deploy --env production`.

### 8.3 Secrets

Stored via `wrangler secret put`, env-scoped:

| Secret | Purpose |
|---|---|
| `SENTRY_DSN` | Per-env Sentry project DSN (dev = noop) |
| `ADMIN_TOKEN` | Bearer token gating `/__admin/*` |
| `CF_API_TOKEN` | Token used by `bin/provision-tenant.ts` to call CF Custom Hostnames API (lives in operator's local env, not in the Worker) |
| `COINBASE_FACILITATOR_KEY` | Reserved; the public Coinbase facilitator at `x402.org/facilitator` is currently free + no auth required, but a placeholder is provisioned for future versions |

### 8.4 Cost estimate at v0 scale

At "10 closed-beta publishers, ~100K req/day" (~3M req/month):

| Line item | Estimate |
|---|---|
| Workers Paid plan | $5/mo (covers 10M req) |
| KV reads | <$1/mo (mostly isolate-cache hits) |
| R2 PUTs | ~$13.50/mo (3M PUTs at $4.50/M) |
| R2 storage | ~$0.02/mo (1.5GB at $0.015/GB) |
| Custom Hostnames | $0 (100 included) |
| Sentry | $0 (free tier) |
| **Total** | **~$20–25/mo** |

R2 PUT count is the line item that grows ugly at scale; that is the trigger to migrate to the Queue-batched writer.

## 9. Testing strategy

### 9.1 Test pyramid

**Unit tests** (`test/unit/`, vitest):
- Pattern matchers (path, agent) — pure functions
- Each `Detector` implementation against fixture requests
- `pricingResolver` against `(TenantConfig, DetectionResult)` table-driven cases
- `CoinbaseX402Facilitator` with stubbed `fetch` (DI'd)
- R2 log writer against an in-memory R2 mock
- Audit record writer

**Integration tests** (`test/integration/`, vitest + miniflare):
- Full middleware pipeline through Hono, with miniflare-provided KV/R2 bindings
- Pre-populated KV fixtures for tenant configs covering each `status` value (`active`, `log_only`, `paused_by_publisher`, `suspended_by_paperward`), multi-rule pricing, and the missing-tenant invariant violation
- Mock origin server in test setup
- `MockFacilitator` registered via the facilitator registry — verify/settle outcomes configured per test
- Every value in the `Decision` enum (§4.6) is reachable from a corresponding integration scenario; each scenario asserts both the response shape and the log entry shape

**End-to-end tests** (`test/e2e/`, plain Node script, run against staging Worker):
- A test agent uses the `web-bot-auth` package + a Sepolia x402 client to hit `e2e-test.staging.paperward.com`:
  - Signed, no payment → 402 with valid x402 headers
  - Signed, valid Sepolia payment → 200 with content streamed, `X-PAYMENT-RESPONSE` present, USDC received at the configured payout address
  - Browser-shaped request → 200
  - Signed, invalid payment (wrong amount) → 402 with error
- Pre-provisioned test tenant on staging with origin pointing to a controlled mock content server (also staging, also paperward-owned).

### 9.2 Fixtures and mocks

- `test/fixtures/wba/` — Ed25519 keypair + a script that generates signed requests on demand. No live external `Signature-Agent` URL during tests.
- `test/fixtures/x402/` — known-good and known-bad payment headers.
- `test/mocks/facilitator.ts` — `MockFacilitator` exposing setters for verify/settle outcomes per test.
- `test/mocks/origin.ts` — plain `http.createServer` returning configurable response shapes.
- DI pattern: `Detector`, `Facilitator`, and the R2 log writer accept their external dependencies (e.g., `fetch`, KV, R2) as constructor args. Production wires real implementations; tests wire mocks. No miniflare outbound-fetch interception required.

### 9.3 CI

GitHub Actions:
- **PR**: `npm test` (unit + integration). Target <60s runtime.
- **Merge to main**: unit + integration → `wrangler deploy --env staging` → e2e suite against staging. Promotion to production blocked on any failure.
- **Manual production deploy**: explicit `wrangler deploy --env production` from a green main.

### 9.4 Out of v0
- Property-based testing of pricing rule grammar (revisit when grammar grows beyond exact + suffix wildcard).
- Load / performance testing (Cloudflare's intrinsic latency is acceptable at v0; measure with real traffic, optimize then).
- Chaos / fault injection.
- Mutation testing.

## 10. Observability & error handling

### 10.1 Log streams

| Stream | Destination | Purpose | Consumer |
|---|---|---|---|
| Request log (per §4.6) | R2 ND-JSON | Business audit trail; revenue/analytics source | Control plane (later); manual S3 queries (v0) |
| Operational log (`console.*`) | Workers Logs + `wrangler tail` | Code-level debugging | Engineers |

Honeycomb/Axiom integration (PRD §14) is a v1 upgrade.

### 10.2 Sentry

`toucan-js` initialized per-isolate. Per-env DSN. Sample rate: 100% on errors, 10% on transactions.

Reportable events:
- Any unhandled exception in middleware
- `facilitator.verify()` / `facilitator.settle()` thrown errors
- R2 write failures
- WBA public-key fetch failures (rate-limited by negative cache, so noise is bounded)
- `tenant_unknown` invariant violations
- Stale-cache fallback warnings (warning level, not error)

### 10.3 Metrics (Workers Analytics Engine)

Emitted per request from the `logger` middleware:

- `requests_total{tenant_id, decision, agent_signed}` — counts by outcome
- `paywall_verify_latency_ms{facilitator_id}` — verify call latency histogram
- `paywall_settle_latency_ms{facilitator_id}` — settle call latency histogram
- `paywall_settle_failures_total{facilitator_id, reason}` — settlement failures (alert metric)
- `detector_match_total{detector_id, agent_id_class}` — what detectors are matching
- `kv_config_cache{outcome=hit|miss|stale}` — config cache health
- `origin_fetch_latency_ms{tenant_id}` — origin response latency

### 10.4 Health checks

Reserved on an operator-owned hostname (Paperward production uses `health.paperward.com`; self-hosters configure their own via the `HEALTH_HOSTNAME` env var). NOT mounted on tenant hostnames.

- `GET /healthz` → 200 with `{ build_sha, env, kv_ok, r2_ok, facilitator_reachable }`
- `GET /version` → build SHA only

External uptime monitor (UptimeRobot or BetterStack) hits `/healthz` every minute.

### 10.5 Fail-open vs fail-closed matrix

Principle: anything that compromises payment integrity = fail closed; anything else = fail open (do not break the publisher's site over our infrastructure flakiness).

| Failure | Mode | Response |
|---|---|---|
| KV miss for tenant (invariant violation) | Closed | 503 + Sentry alert |
| KV read timeout, no cache | Closed | 503 + Sentry alert |
| KV read timeout, stale cache available | Open | Serve from stale cache + Sentry warn |
| Detector throws | Open | Log + Sentry; treat as detector-returned-null |
| WBA public-key fetch fails | Open | Detector returns null (treat as unsigned); negative-cache 60s |
| Pricing resolver throws | Open | Log + Sentry; fall back to `default_action` |
| `facilitator.verify()` throws or unreachable (active mode) | Closed | 503 + Sentry alert; decision `charge_verify_failed`, `decision_reason: "facilitator_unavailable"` |
| `facilitator.verify()` throws or unreachable (log_only mode) | Open | Continue to origin; decision `would_charge_verify_failed`, `decision_reason: "facilitator_unavailable"` |
| `facilitator.settle()` throws or returns failure after origin 2xx | Open | Return streamed response; decision `charge_unsettled`; Sentry alert; reconciliation problem |
| Origin `fetch()` throws or times out | Open-ish | 502 to client; if charge path was taken in active mode, skip settle, decision `charge_origin_failed` (no charge committed) |
| Origin returns non-2xx | Open | Stream origin response unchanged; if charge path was taken in active mode, skip settle, decision `charge_origin_failed` |
| R2 log write fails | Open | Continue; Sentry alert; logs lost (acceptable for v0) |

## 11. Out-of-v0 stubs and extension points

### 11.1 Slot map

| Future feature | Extension point | What v0 has |
|---|---|---|
| Tier 2 detector | `Detector` interface + `detectors/registry.ts` array | Empty slot at priority 50 |
| Tier 3 detector | Same | Empty slot at priority 90 |
| Rate limiter / per-tenant counters | `rateLimiter` middleware between `tenantResolver` and `detectorPipeline`; `RateLimiterDO` Durable Object | DO class declared in `wrangler.toml` (zero-traffic stub binding); middleware not registered |
| Other payment rails (MPP, Skyfire, Mastercard Agent Pay) | `Facilitator` interface + `facilitators/registry.ts`; `tenant.facilitator_id` selects | `CoinbaseX402Facilitator` is the only registered impl |
| Origin response caching | A `cache` middleware between `paywall` and `originForwarder` | Not registered in v0; pipeline accepts insertion at that position |
| Settlement retry queue | `Q_SETTLE_RETRY` Queue producer; consumer Worker on cron | Binding declared in `wrangler.toml` only; producer call site and consumer Worker added together later (no flag-gated dead code in v0) |
| Per-tenant log query-string capture | `tenant.log_query_strings: boolean` field on `TenantConfig` | Field not yet added to schema; will be added in the same release that ships the feature |
| Tenant kill-switch automation | Reads `paywall_settle_failures_total` from Analytics Engine; sets `status` to `suspended_by_paperward` via admin endpoint | Hook-in via metric; automation is a separate Worker added later |

### 11.2 Integration map for downstream subsystems

| Subsystem | How it integrates with v0 contracts |
|---|---|
| Control plane (Next.js dashboard) | Reads R2 request logs (S3-compatible API) for analytics. Writes tenant config via the admin endpoint. Replaces `bin/provision-tenant.ts` as the primary admin client. |
| WordPress plugin | Onboarding wizard POSTs publisher's chosen pricing template to the admin endpoint. Revenue widget queries the control plane (which queries R2). |
| Next.js middleware (npm package) | Re-exports `edge/src/middleware/*` as a published package. Publisher imports them in their own Vercel deployment. Reads tenant config from a control-plane API call instead of KV. |
| Stripe Connect / payouts | Reads R2 `decision: "charge_paid"` records, sums per-tenant `price_usdc` over the payout window, computes the publisher's share after the platform take rate, and triggers Stripe Connect transfers. Lives in the control plane's job runner. |
| Citation tracker | Either a separate CF Worker bound on `/r/*` redirect paths or part of the control plane. No edge-layer slot needed. |

## 12. Open questions and decision log

### 12.1 Decisions made during brainstorming and review

| Decision | Rationale |
|---|---|
| Edge layer first, before control plane / WP plugin / Next.js middleware | Riskiest technical bet; no upstream dependencies; defines the contracts everything else integrates against |
| Multi-tenant from day one | Avoids rebuild when scaling from 1 → 10 → many publishers |
| Single Worker (not DO-per-tenant or RPC-bound service Workers) | Lowest cold-start and hop latency; modularity via TS modules; DO/service-Workers reserved for future scaling concerns |
| `status: active \| log_only \| paused_by_publisher \| suspended_by_paperward` (single field) | Consolidates the original `enabled: bool` + `mode: enum` into one field. Cleaner schema and unambiguous behavior per value. De-risks false-positive-blocking-real-users (PRD §11) by giving publishers a true-revenue-projecting `log_only` onboarding mode. |
| `log_only` runs `verify()` read-only | Lets publishers see projected revenue (`would_charge_paid` per signed-and-paying agent), not just "would have charged" counts. x402 verify is a signature check, not an on-chain action — safe to call read-only |
| Settle-after-origin (verify → fetch → settle) | Verifying before serving protects payment integrity; settling after origin success means failed origins do not result in commits |
| Settle failures after origin 2xx → return response anyway, decision = `charge_unsettled` | Content has already streamed; buffering trades latency and Workers memory cost for a rare reconciliation case. Distinct decision value enables alerting on the specific failure rate. |
| `charge_*` decision values split into `charge_paid`, `charge_no_payment`, `charge_verify_failed`, `charge_origin_failed`, `charge_unsettled` | Replaces a single overloaded `charge_unpaid` value; analytics needs to distinguish "agent didn't try to pay" from "we couldn't deliver" |
| `default_action: "charge"` removed from schema | If a publisher wants charge-by-default, they write a `*` rule with low priority and an explicit price; cleaner than introducing `default_price_usdc` |
| Default action for unknown unsigned traffic = `allow` | PRD §11 conservatism: false positives blocking real users is the higher-cost failure mode |
| `agent_pattern: "unknown"` token added | Lets publishers write rules specifically targeting unidentified traffic (e.g., "block agents we couldn't classify") without affecting all-agents rules |
| One R2 object per request (vs Queue-batched), prefix-first partitioning | Simplest v0 logging; prefix-first path (`{ulid_prefix}/dt=.../tenant=...`) spreads writes across 4096 R2 prefix shards to avoid the per-prefix rate limit at viral-tenant traffic |
| `config_version` copied into every `LogEntry` | Lets log analysis correlate decisions with the config snapshot that produced them, especially across the up-to-60s isolate-cache staleness window |
| Two-layer KV cache: isolate Map + `cf.cacheTtl` | Isolate caches are aggressively evicted; CF's documented edge-cache layer absorbs cold-isolate reads. Necessary for the cost estimate to hold |
| WBA `@authority` matching against original Host | Prevents replay-across-domains attacks where an attacker signs for one publisher and replays the request against another |
| SSRF hardening on `Signature-Agent` fetch | The `Signature-Agent` URL is attacker-controlled; without validation, the Worker becomes an SSRF amplifier. Specific rules in §6.2.3 |
| In-flight dedupe of public-key fetches per isolate | Prevents amplification on cold-cache bursts of identical signatures |
| WBA `created` timestamp window = ±60s | Matches Coinbase reference defaults; not per-tenant configurable in v0 |
| KV stale-cache fallback on timeout | KV tail-latency spikes should not cascade into 503s; staleness window bounded by 60s TTL |
| Workers Analytics Engine over OTel for metrics | CF-native, free, low-cardinality-friendly; OTel integration when multi-cloud or higher-cardinality queries are needed |
| Three Wrangler environments from day one | Catches integration bugs against real Workers semantics that miniflare cannot reproduce |
| Admin endpoint as primary config-write contract (CLI is a thin client); hostname env-configurable via `ADMIN_HOSTNAME` | Same contract the v1 control plane will speak; defining it now avoids retrofitting. Env-configurable for self-host friendliness |
| `Q_SETTLE_RETRY` binding declared but no producer code in v0 | Avoids shipping flag-gated dead code without an off-path test; producer + consumer ship together when the settle-retry feature is built |
| Trust Coinbase facilitator nonce atomicity for x402 replay protection | Documented behavior; v0 takes the dependency. If real-world testing shows lag, the fix slot exists (Worker-side payment-hash dedupe in `RateLimiterDO`) and the failure metric is in place |
| Realistic time budget: 4 weeks | Reviewer flagged 2.5–3 weeks as tight given WBA hardening, x402 e2e on Sepolia, Custom Hostnames provisioning script, and the integration matrix. 4 weeks is a more honest estimate; cutting `bin/provision-tenant.ts` to a runbook would shave 2–3 days but breaks the §1.2 success criterion |
| Apache 2.0, public from commit 1 | Trust signal in SMB segment is the actual moat; clone risk overstated; patent grant matters in payments-adjacent space |

#### 12.1.1 Explicit deviations from the PRD

These are points where the spec departs from the PRD wording. Recorded so future readers do not interpret them as oversights.

| PRD reference | PRD text | Spec choice | Why |
|---|---|---|---|
| §7.1 bullet 4 | "Look up pricing rules for the requested path from the control plane (cached per domain, refreshed on config change)" | Spec inverts the relationship: KV is the source of truth; the control plane is a future *client* of the admin endpoint. The edge never reads from a control plane | The control plane does not exist at edge-layer build time. KV-as-source-of-truth keeps the edge implementable in isolation; the control plane integrates by writing to KV via the admin endpoint (same write path as `bin/provision-tenant.ts`) |
| §7.1 bullet 7 | "Log every decision ... to a queue for the control plane" | Spec writes to R2 ND-JSON; the control plane reads from R2 (S3-compatible API) rather than consuming a queue | R2 is durable, queryable, and avoids the deferred Queue + consumer infrastructure for v0. Same data eventually flows to the control plane; just pull-based instead of push-based |
| §12 question 6 | "Edge component MIT licensed" | Apache 2.0 instead of MIT | Same trust signal, stronger patent grant in a payments-adjacent space. PRD treated MIT as illustrative rather than load-bearing |
| §4.1 (TenantConfig) | `facilitator_id: string` + `payout_address: string` (single rail per tenant) | Replaced with `accepted_facilitators: AcceptedFacilitator[]` (one entry per accepted rail, each with its own facilitator_id and chain-appropriate payout_address) | Added 2026-05-06 in response to pay.sh launching as a Solana-only agent client. Single-rail tenants would reject every Solana-paying agent and vice versa, costing real revenue. Multi-rail also lets the 402 advertise multiple `accepts[]` entries so the agent picks the rail it can pay on. |
| §4.5 (Facilitator interface) | x402 v1 wire format (`paymentHeader` field, friendly network names) | Bumped to x402 v2 (`paymentPayload` object, `eip155:<chainId>` and `solana:<base58-genesis>` network identifiers, `amount` in micro-USDC, `asset` as contract/mint, `extra` field). Added `supportedNetworks: readonly Network[]` to the interface so the multi-rail paywall can dispatch verify/settle by inbound network. | x402 v2 is the canonical spec; v1 is legacy. Both Coinbase (Base) and the new Solana facilitator now speak v2 consistently. |
| §5.4 (paywall middleware) | "look up the facilitator by `tenant.facilitator_id`" | "build the 402 with one `accepts[]` entry per `accepted_facilitators`; on inbound X-PAYMENT, decode and dispatch to the facilitator whose `supportedNetworks` matches `accepted.network`" | Multi-rail dispatch. New failure mode `charge_verify_failed`/`unsupported_network` when the agent pays on a rail the tenant didn't accept. |
| §11 (extension points) | "Other payment rails (MPP, Skyfire, Mastercard Agent Pay)" — designed-for, not implemented | **Solana implemented as of v0.0.2** via `SolanaX402Facilitator`. Speaks the same x402 v2 wire format; HTTP-only (no on-chain interaction in the Worker; the Solana facilitator service handles tx co-signing and broadcast). | Pay.sh launched May 5, 2026 with Google Cloud and Solana Foundation as a Solana-only agent client; interop is now valuable enough to justify shipping the rail in v0 rather than deferring. |

### 12.2 Deployment-time inputs (TBD; do not block design)

- The publisher-persona test domain. Separate from `paperward.com`; supplied at provisioning. Architecture does not depend on the choice.
- The Sepolia payout address for the e2e fixture tenant. Supplied at provisioning.
- The production payout address for the first real publisher. Supplied at production provisioning.

### 12.3 Resolved sub-items folded into the design

- `path_pattern` grammar in v0 = exact + suffix wildcard; final-shape grammar can grow.
- `agent_pattern` grammar in v0 covers `*`, `signed:*`, `signed:{operator}`, `unsigned:*`, `unsigned:{name}`, `human`.
- Cache TTL for KV configs = 60s; for WBA public keys = 1h positive / 60s negative.
- e2e suite runs on every staging deploy (not nightly); revisit if flakiness becomes noise.

### 12.4 Things explicitly NOT decided here

- Marketing site stack and hosting for `paperward.com` (out of scope; this spec covers the edge only).
- Pricing tier enforcement (free / pro / business per PRD §9) — that is a control-plane concern.
- Per-tenant facilitator selection UI — control-plane concern; the field exists in the schema for future use.
- Multi-cloud strategy — PRD Phase 4.

## 13. Glossary

- **Web Bot Auth (WBA)** — IETF-tracked standard for cryptographically signing automated HTTP requests via Ed25519 + RFC 9421 message signatures.
- **x402** — Open protocol for HTTP-native payments using the 402 status code. USDC settlement on Base by default.
- **Facilitator** — Optional service in x402 that verifies and settles payments. Coinbase runs the canonical public one at `x402.org/facilitator`.
- **DCV** — Domain Control Validation. Mechanism by which Cloudflare verifies a publisher controls a hostname before issuing a TLS cert and routing traffic.
- **Custom Hostnames / SSL-for-SaaS** — Cloudflare feature that lets a SaaS provider (us) accept traffic for customer-owned hostnames and serve them with auto-provisioned TLS.
- **Tenant** — A publisher domain registered in Paperward. Identified by `tenant_id`; routed by hostname.
- **Edge layer** — The Cloudflare Worker between agent/visitor and the publisher's origin. The subject of this spec.
- **Control plane** — The publisher-facing dashboard and configuration backend (PRD §7.2). Out of scope for this spec; integrates via the admin endpoint and R2 logs.

## 14. Known limitations

These are accepted v0 limitations — items that surfaced in design review where the right answer was "document, don't fix." Each is callable out as a future improvement when the conditions change.

### 14.1 Operational

- **Workers subrequest budget on hot path.** A charged request fans out to ≤6 subrequests (KV read on cold isolate, optional WBA key fetch, `verify`, `fetch(origin)`, `settle`, R2 PUT in `waitUntil`). Workers Paid plan allows 1000 per request — comfortable for v0. Adding the deferred Queue retry hook later puts it at ~7. Revisit if a future feature lifts the count meaningfully.
- **Cloudflare Custom Hostnames API rate limits.** `bin/provision-tenant.ts` may receive 429s during burst onboarding. v0 handles this with manual retry; automate with backoff before opening public signup.
- **R2 ND-JSON consumer must skip malformed lines.** A failed PUT mid-stream can leave a partial object. The consumer (control plane analytics, later) must tolerate and skip malformed lines. Document this as a contract on the R2 reader side.
- **Sepolia faucet exhaustion in CI.** The e2e suite uses real Sepolia USDC; faucets rate-limit and occasionally fail. Pre-fund the test agent wallet with enough Sepolia USDC for at least a year of CI runs; document the top-up procedure in `test/e2e/README.md`.
- **`bin/provision-tenant.ts` is Cloudflare-only by design.** Self-hosters who do not use Cloudflare cannot use the script as-is. The README documents the manual provisioning path. Multi-cloud provisioning is PRD Phase 4.

### 14.2 Security and abuse

- **Multi-tenant blast radius.** A bug in `pricingResolver` (e.g., infinite loop on a malformed rule) brings down the Worker for *all* tenants, not just the affected one. v0 has no per-tenant circuit breaker. Per-tenant fault isolation via Durable Objects is a future scaling lever; not justified at v0 traffic.
- **Human detector is intentionally weak.** Tier 1 fallback to "browser-shaped UA + `Accept-Language` + no signature" is trivially bypassable by an attacker who wants to fake a human. v0 accepts this because the goal is "do not block legitimate human visitors," not "detect agents pretending to be human." Tier 3 heuristic detection (designed-for) is the answer when this matters.
- **`ADMIN_TOKEN` is a single bearer token** — fine for one operator, awkward for multi-operator self-hosts. Multi-actor auth (per-operator credentials, per-action audit attribution) is deferred to v1.
- **`COINBASE_FACILITATOR_KEY` is reserved for future use** but ships as a declared secret. Self-hosters: leave unset for v0; the public `x402.org/facilitator` is currently auth-free.

### 14.3 Standards drift

- **Web Bot Auth IETF draft is moving.** The spec depends on `web-bot-auth` (Stytch reference impl) which tracks the current draft. Pin the package version in `package.json` and document the draft revision number in `package.json` comments. Re-validate signature compatibility on every `web-bot-auth` major version bump.
- **x402 `X-PAYMENT-RESPONSE` format is base64-encoded JSON in the current spec** but historically has changed encoding. Verify against the `x402-hono` version pinned at implementation time; the encoding is wrapped behind the `Facilitator` interface so a format change does not propagate beyond `CoinbaseX402Facilitator`.
- **`cf.rayId` access path** — the request ray ID is exposed as `request.cf?.rayId` in some Workers runtime versions and as `request.headers.get("CF-Ray")` in others. Verify and pin the access path during implementation; if neither works, fall back to the response `CF-Ray` header captured post-fetch.

### 14.4 Observability gaps

- **Sentry `traces_sample_rate` of 10%** assumes `toucan-js` performance traces are enabled. If the team chooses to omit performance instrumentation, that line is moot. Confirm at integration time.
- **Operational logs are unstructured** in v0 (`console.log`/`warn`/`error` to Workers Logs). Structured logging (Honeycomb / Axiom integration per PRD §14) is a v1 upgrade.

---

*Spec ends here. Next step: handoff to the writing-plans skill to produce a step-by-step implementation plan.*
