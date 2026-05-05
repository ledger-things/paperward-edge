# Paperward Edge

The open-source edge layer of [Paperward](./PRD.md) — an agent-payments platform for SMB publishers. This Cloudflare Worker detects AI agent traffic via [Web Bot Auth](https://datatracker.ietf.org/doc/draft-ietf-web-bot-auth-architecture/) and charges per-fetch via [x402](https://www.x402.org/), then forwards traffic to publisher origins.

**Status:** Pre-v0; under active development.

**License:** Apache 2.0. The "Paperward" name and brand are service marks; code is forkable, the brand is not.

## What this is

This repo contains the Worker that:
- Sits in front of a publisher's origin via Cloudflare Custom Hostnames (SSL-for-SaaS)
- Verifies WBA-signed requests (RFC 9421)
- Applies per-tenant pricing rules
- Issues HTTP 402 with x402 payment requirements when a charge is required
- Verifies and settles x402 payments via the Coinbase facilitator (USDC on Base)
- Forwards all approved traffic to the publisher's origin
- Logs every decision to R2 for downstream analytics

## What this is NOT

- Not a billing system (Stripe Connect lives in the closed-source control plane)
- Not a publisher dashboard (separate repo, closed source)
- Not a WordPress plugin (separate repo, GPL)
- Not a multi-cloud abstraction (Cloudflare-only by design for v0)

## Self-hosting

You can run your own Paperward edge by deploying this Worker to your Cloudflare account. See `docs/setup.md` (TODO before public release).

## Contributing

Pull requests are not accepted while v0 is being stabilized. Issues, discussions, and feedback are welcome.

## Spec

Detailed design: `docs/superpowers/specs/2026-05-05-edge-layer-v0-design.md`.
Implementation plan: `docs/superpowers/plans/2026-05-05-paperward-edge-layer-v0.md`.
