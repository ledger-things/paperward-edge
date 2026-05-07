# Changelog

All notable changes to this project will be documented in this file.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and adheres to [Semantic Versioning](https://semver.org/) once it leaves the `0.x` range.

## [Unreleased]

### Added (2026-05-07)

**Staging deployment + full end-to-end validation on real Cloudflare + Base Sepolia.**

The v0 edge layer is now deployed to staging on the `paperward.com` Cloudflare zone and validated end-to-end against real cryptographic signing and real on-chain payment settlement.

- **Cloudflare staging environment provisioned:** Workers Paid plan, KV namespaces, R2 bucket, Analytics Engine dataset, Workers Custom Domains for admin/health/test-blog/e2e-test, sibling JWKS Worker (`paperward-agent-jwks-staging`) for WBA test fixture.
- **WBA detection + paywall stub validated** (Phase A): WBA-signed request → JWKS fetched from sibling Worker → Ed25519 signature verified → agent identified → pricing rule matches → 402 with x402 v2 payment requirements pointing at the publisher's payout address.
- **x402 verify + settle validated against the real Coinbase facilitator on Base Sepolia** (Phase B): real EIP-3009 transferWithAuthorization broadcast and confirmed on-chain (0.001 USDC moved from agent wallet to publisher payout, on-chain balance delta verified). Settlement returns `X-PAYMENT-RESPONSE` header.
- **Underpayment correctly rejected**: a payment with insufficient `value` returns `402 charge_verify_failed`, not 200.
- **SaaS Custom Hostnames + real third-party DNS** validated end-to-end against `test-blog.ltmd.it` (vhosting-it.com cPanel-managed). Required a `*/*` wildcard Workers Route on the zone — the canonical pattern; both Custom Domains and host-scoped Workers Routes match on Host header, which doesn't catch SaaS-forwarded traffic where Host is the customer's domain. Confirmed by Cloudflare support.
- **GitHub Actions deploy-staging workflow** runs on every push to `main`: lint → typecheck → 154 unit+integration tests → `wrangler deploy --env staging` → e2e suite (real Sepolia payments). E2E auto-skips if `E2E_SEPOLIA_PRIVATE_KEY` secret is unset, making the workflow useful even without the funded wallet configured.
- **Bug fixes uncovered during staging validation:**
  - Durable Object class must `extends DurableObject` from `cloudflare:workers` and use `new_sqlite_classes` migration (not legacy `new_classes`) — without both, every request returns 500/1101.
  - `boundedFetch` strips `content-encoding`/`content-length` from buffered responses to avoid double-decompression by the Workers runtime.
  - Both `CoinbaseX402Facilitator` and `SolanaX402Facilitator` now `fetch.bind(globalThis)` when storing the global fetch as an instance field — invoking `this.fetchImpl(...)` on the unbound global throws "Illegal invocation" on real CF Workers (mocks didn't catch this).
  - `bin/provision-tenant.ts` updated to send the multi-rail `accepted_facilitators[]` schema (was sending the obsolete v1 `facilitator_id` + `payout_address` pair) and to correctly parse the Cloudflare custom_hostnames API response shape.
  - `test/e2e/sepolia-payment.ts` rewritten for x402 v2 wire format (`amount` in micro-USDC under `accepted`, not `maxAmountRequired` decimal at top level) and now tolerates the Sepolia private key with or without `0x` prefix.

### Added (2026-05-06)

**Solana payment rail — interoperability with [pay.sh](https://pay.sh).**

- New `SolanaX402Facilitator` (`src/facilitators/solana-x402.ts`). Speaks x402 v2 wire format, calls a configurable hosted Solana facilitator's `/verify` and `/settle` endpoints. No `@solana/web3.js` in the Worker — the facilitator handles all chain interaction (transaction validation per spec §6.2 of `scheme_exact_svm.md`, fee-payer co-signing, broadcast).
- `TenantConfig` schema breaking change: `facilitator_id: string` + `payout_address: string` replaced with `accepted_facilitators: AcceptedFacilitator[]`. Each tenant now declares one or more accepted rails.
- Paywall middleware now multi-rail: 402 responses advertise every accepted rail in `accepts[]`; inbound payments are dispatched to the matching facilitator based on the `accepted.network` field.
- Coinbase (Base) facilitator brought to **x402 v2 wire format** for consistency with the Solana implementation. Network identifiers now use the canonical `eip155:<chainId>` (Base mainnet `eip155:8453`, Sepolia `eip155:84532`) and amounts are micro-USDC integers.
- Admin endpoint validates per-rail payout-address format (EVM = `0x` + 40 hex; Solana = base58, 32–44 chars).
- 21 net new tests (151 → 154 total): 12 Coinbase v2, 13 Solana, 2 admin format, 3 multi-rail integration scenarios, minus obsolete duplicates.
- New env vars: `SOLANA_FACILITATOR_URL`, `SOLANA_FACILITATOR_FEE_PAYER`, `SOLANA_FACILITATOR_API_KEY` (all optional; if URL+feePayer set, the SVM rail registers).
- Node bumped to ≥22 (already was; no change needed).

### Added

Initial v0 implementation of the Paperward edge layer.

- **Multi-tenant Cloudflare Worker** with Custom Hostnames routing, isolate-cached tenant configs (KV with `cf.cacheTtl` + stale fallback), and host-based dispatch into admin / health / tenant sub-apps.
- **Web Bot Auth (RFC 9421) detection** with full verification flow: `Signature-Agent` SSRF hardening (https-only, IP-literal rejection, public-TLD check, bounded-fetch caps), KV-cached public-key directories with in-flight deduplication, `@authority` matching against the original Host header, and ±60s timestamp window.
- **Human detection fallback** — browser-shaped UA + `Accept-Language`.
- **x402 paywall** via the public Coinbase facilitator (USDC on Base mainnet; Base Sepolia for staging) with the verify → forward → settle sequence and explicit handling for verify failures, origin failures, and settle failures (`charge_unsettled`).
- **Per-tenant pricing rules** with single `status` field (`active | log_only | paused_by_publisher | suspended_by_paperward`); rules support exact / prefix path patterns and rich agent patterns (`signed:*`, `signed:{operator}`, `unsigned:*`, `unsigned:{name}`, `human`, `unknown`, `*`).
- **Streamed origin forwarding** with payment-integrity-aware failure handling (skip settle on origin non-2xx) and header strip/add rules per spec §6.3.
- **R2 ND-JSON request logs** with prefix-sharded keys to spread writes across 4096 shards (avoids per-prefix rate limits).
- **Workers Analytics Engine** metrics: requests, verify/settle latency, settle failures, detector match counts, KV cache health, origin latency.
- **Sentry exception capture** via `toucan-js` with no-op fallback for empty DSN.
- **Admin endpoint** at `/__admin/*` with bearer-token auth and audit log; tenant CRUD with strict input validation (charge rules require `price_usdc`, origin must be HTTPS, etc.).
- **`bin/provision-tenant.ts` CLI** for end-to-end tenant onboarding (admin endpoint POST + Cloudflare Custom Hostnames API + DCV instructions).
- **Three Wrangler environments**: `dev`, `staging`, `production`.
- **133 unit + integration tests** covering all 17 `Decision` enum values through the full middleware pipeline.
- **CodeQL security scanning** workflow.
- **Dependabot** for weekly npm + GitHub Actions updates.
- **Biome** as the single tool for formatting and linting.
- **Apache 2.0 license**, public repo from commit 1.

### Documentation

- Detailed design specification at `docs/superpowers/specs/`.
- Implementation plan at `docs/superpowers/plans/`.
- Setup runbook (`docs/setup.md`) and production cutover checklist (`docs/production-cutover.md`).
- Community-health files: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`.
