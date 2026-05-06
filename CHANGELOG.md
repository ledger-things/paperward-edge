# Changelog

All notable changes to this project will be documented in this file.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and adheres to [Semantic Versioning](https://semver.org/) once it leaves the `0.x` range.

## [Unreleased]

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
