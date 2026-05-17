# Paperward Edge

[![CI](https://github.com/ledger-things/paperward-edge/actions/workflows/ci.yml/badge.svg)](https://github.com/ledger-things/paperward-edge/actions/workflows/ci.yml)
[![CodeQL](https://github.com/ledger-things/paperward-edge/actions/workflows/codeql.yml/badge.svg)](https://github.com/ledger-things/paperward-edge/actions/workflows/codeql.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](./.nvmrc)
[![TypeScript](https://img.shields.io/badge/typescript-6.x-blue.svg)](./tsconfig.json)
[![Biome](https://img.shields.io/badge/lint-biome-60a5fa.svg)](https://biomejs.dev/)

> The open-source edge layer of [Paperward](./PRD.md) — an agent-payments platform for SMB publishers.

A Cloudflare Worker that fronts a publisher's origin, identifies AI agent traffic via [Web Bot Auth (RFC 9421)](https://datatracker.ietf.org/doc/draft-ietf-web-bot-auth-architecture/), charges per-fetch via [x402](https://www.x402.org/) (USDC on **Base** or **Solana** — multi-rail per tenant), and forwards approved traffic to the origin.

**Status:** Pre-v0. Code complete, pre-deployment.

---

## Table of contents

- [What this is](#what-this-is)
- [What this is NOT](#what-this-is-not)
- [Architecture](#architecture)
- [Getting started](#getting-started)
- [Development](#development)
- [Self-hosting](#self-hosting)
- [Repository layout](#repository-layout)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

---

## What this is

The Worker:

- Sits in front of a publisher's origin via Cloudflare **Custom Hostnames (SSL-for-SaaS)**.
- Verifies **WBA-signed** requests (RFC 9421) with SSRF-hardened public-key fetches and `@authority` matching.
- Applies **per-tenant pricing rules** (path × agent → `charge | allow | block`).
- Issues `HTTP 402` with x402 payment requirements when a charge is required, advertising **every payment rail the tenant accepts** in the same response.
- Verifies and settles **x402 v2 payments** across multiple rails:
  - **Base** (USDC, mainnet / Sepolia for staging) via the public [Coinbase facilitator](https://x402.org/facilitator).
  - **Solana** (USDC, mainnet / devnet for staging) via a configurable hosted facilitator (e.g. [pay.sh](https://pay.sh)) — no `@solana/web3.js` in the Worker; the facilitator co-signs and broadcasts.
- Streams the origin response back to the agent, attaching `X-PAYMENT-RESPONSE` after settlement.
- Writes a structured log entry to **R2** for every decision (revenue audit + future analytics).
- Emits **Workers Analytics Engine** metrics for verify/settle latency, settle failures, detector matches, etc.

## What this is NOT

- **Not a billing system.** Stripe Connect lives in the closed-source control plane.
- **Not a publisher dashboard.** Separate repo, closed source.
- **Not a WordPress plugin.** Separate repo, GPL-licensed.
- **Not a multi-cloud abstraction.** Cloudflare-only by design for v0.

## Architecture

```
   Agent / browser request
            │
            ▼
   ┌────────────────────────┐
   │  Cloudflare Worker     │
   │   (this repo)          │
   │                        │
   │  ┌──────────────────┐  │
   │  │ tenantResolver   │──┼─→ KV (per-tenant config, isolate-cached)
   │  ├──────────────────┤  │
   │  │ detectorPipeline │──┼─→ KV_KEY_CACHE (WBA public keys)
   │  ├──────────────────┤  │
   │  │ pricingResolver  │  │
   │  ├──────────────────┤  │
   │  │ paywall (verify) │──┼─→ Coinbase (Base) / Solana x402 facilitator
   │  ├──────────────────┤  │
   │  │ originForwarder  │──┼─→ Publisher origin (streamed)
   │  ├──────────────────┤  │
   │  │ paywall (settle) │──┼─→ Coinbase (Base) / Solana x402 facilitator
   │  ├──────────────────┤  │
   │  │ logger           │──┼─→ R2 (request logs) + Analytics Engine
   │  └──────────────────┘  │
   └────────────────────────┘
            │
            ▼
   Streamed response (with X-PAYMENT-RESPONSE on charge_paid)
```

Full design at [`docs/superpowers/specs/2026-05-05-edge-layer-v0-design.md`](./docs/superpowers/specs/2026-05-05-edge-layer-v0-design.md).
Implementation plan at [`docs/superpowers/plans/2026-05-05-paperward-edge-layer-v0.md`](./docs/superpowers/plans/2026-05-05-paperward-edge-layer-v0.md).

## Getting started

### Prerequisites

- Node.js ≥ 22 (see [`.nvmrc`](./.nvmrc))
- A Cloudflare account on the **Workers Paid plan** (required for KV, R2, Custom Hostnames, Analytics Engine)

### Setup

```bash
git clone https://github.com/ledger-things/paperward-edge.git
cd paperward-edge
npm install
cp .dev.vars.example .dev.vars   # then fill in values for local dev
```

### Run the test suite

```bash
npm test            # all 154 unit + integration tests
npm run typecheck   # strict TypeScript checking
npm run lint        # Biome lint
npm run format:check
```

### Run the Worker locally

```bash
npm run dev         # wrangler dev --env dev
```

## Development

| Script              | Purpose                                                     |
|---------------------|-------------------------------------------------------------|
| `npm test`          | Run unit + integration tests                                |
| `npm run test:watch`| Vitest in watch mode                                        |
| `npm run typecheck` | Regenerate `worker-configuration.d.ts` and run `tsc`        |
| `npm run lint`      | Biome lint                                                  |
| `npm run format`    | Biome formatter (writes changes)                            |
| `npm run check`     | Combined lint + format check                                |
| `npm run dev`       | `wrangler dev --env dev`                                    |
| `npm run deploy:staging`    | Deploy to staging                                   |
| `npm run deploy:production` | Deploy to production                                |
| `npm run provision-tenant`  | CLI to provision a tenant end-to-end                |

### Provision a tenant

```bash
ADMIN_BASE_URL=https://admin.staging.paperward.com \
ADMIN_TOKEN=... \
CF_API_TOKEN=... \
CF_ZONE_ID=... \
npm run provision-tenant -- \
  --hostname=blog.example.com \
  --origin=https://internal-origin.example.com \
  --payout-address=0x... \
  [--rules-file=rules.json]
```

The script writes the tenant config via the admin endpoint, registers the hostname with Cloudflare's Custom Hostnames API, and prints DCV instructions for the publisher.

## Self-hosting

You can run your own Paperward edge against your own Cloudflare account. See [`docs/setup.md`](./docs/setup.md) for the full runbook (KV namespaces, R2 buckets, Analytics Engine datasets, secrets, Custom Hostnames). Production cutover checklist at [`docs/production-cutover.md`](./docs/production-cutover.md).

### Optional bindings

#### Citation referrals (optional)

When the worker binding `PAPERWARD_REFERRALS` is configured, the edge detects
requests carrying a `Referer` header from a known LLM host (ChatGPT,
Perplexity, Claude, Gemini) and emits a `CitationReferralV1` event to that
queue. The Paperward control plane uses this signal to show which assistants
are sending the publisher traffic.

The binding is **optional**. OSS forks without it silently skip the emit —
detection logic still runs, but no event is sent. Source: `src/utils/llm-referers.ts`.

## Repository layout

```
.
├── src/
│   ├── index.ts                 # Top-level Worker entry; host-based routing
│   ├── middleware/              # Hono middleware (tenant, detector, pricing, paywall, origin, logger)
│   ├── detectors/               # WebBotAuthDetector, HumanDetector, registry
│   ├── facilitators/            # CoinbaseX402Facilitator, SolanaX402Facilitator, registry (x402 v2)
│   ├── config/                  # TenantConfig types + KV cache
│   ├── logging/                 # LogEntry, R2 writer, audit
│   ├── metrics/                 # Analytics Engine helper
│   ├── observability/           # Sentry init (toucan-js)
│   ├── admin/                   # /__admin endpoints (tenant CRUD)
│   ├── health/                  # /healthz, /version
│   ├── utils/                   # patterns, safe-url, bounded-fetch
│   └── types.ts                 # Env, Vars
├── test/
│   ├── unit/                    # vitest unit tests (Node)
│   ├── integration/             # vitest + miniflare integration tests
│   ├── e2e/                     # Real-staging e2e against Sepolia
│   ├── fixtures/                # WBA Ed25519 keypair, signed-request generator
│   └── mocks/                   # Mock Facilitator, Hono context helper
├── bin/
│   └── provision-tenant.ts      # End-to-end tenant provisioning CLI
├── docs/
│   ├── setup.md                 # Self-hosting / deploy runbook
│   ├── production-cutover.md    # First-prod-deploy checklist
│   └── superpowers/             # Spec + implementation plan
├── wrangler.toml                # Three Wrangler envs: dev, staging, production
└── biome.json                   # Lint + format config
```

## Roadmap

This repo is the **edge layer**, the first of several Paperward subsystems. See the project [PRD](./PRD.md) for the full picture. Coming next:

- **Control plane** — publisher signup, dashboard, pricing UI, Stripe Connect payouts. Closed source, separate repo.
- **WordPress plugin** — onboarding wizard for the ~40% of the web on WordPress. Separate GPL repo.
- **Next.js middleware** — npm package; same logic as this Worker, runs in publisher's own Vercel deployment.
- **Citation tracker** — adjacent feature; tracks AI-citation referral traffic.

## Contributing

Pull requests are **not** actively merged while v0 stabilizes. Issues, discussions, bug reports, and feedback are very welcome.

- [Open an issue](https://github.com/ledger-things/paperward-edge/issues/new/choose)
- Read the [Code of Conduct](./CODE_OF_CONDUCT.md)
- See [CONTRIBUTING.md](./CONTRIBUTING.md) for details

## Security

This Worker handles cryptographic verification and payment authorization. Please disclose vulnerabilities responsibly — do **not** file public issues. See [SECURITY.md](./SECURITY.md).

## License

Apache 2.0 — see [LICENSE](./LICENSE).

The "Paperward" name and brand are service marks. The code is forkable; the brand is not.

---

<details>
<summary><strong>Pinned dependencies</strong> (click to expand)</summary>

Core dependencies are pinned to keep behavior consistent across deployments and to avoid surprise updates from upstream draft churn:

| Package | Version | Notes |
|---|---|---|
| `hono` | 4.12.17 | Worker framework |
| `web-bot-auth` | 0.1.3 | RFC 9421 verification (Stytch reference) |
| `ulid` | 3.0.2 | ULID generation |
| `toucan-js` | 4.1.1 | Sentry SDK for Workers |
| `viem` | ≥ 2.48 | EIP-712 signing for the Sepolia e2e suite |
| `@cloudflare/workers-types` | 4.x | Workers ambient types |
| `wrangler` | 3.x | Workers CLI — pinned at 3.x; wrangler 4's transitive `lightningcss` platform-binary deps break `npm ci` on Linux runners. Re-evaluate once Cloudflare resolves [the issue upstream](https://github.com/cloudflare/workers-sdk/issues). |
| `typescript` | 6.x | |
| `vitest` | 2.x | Pinned at 2.x until [`@cloudflare/vitest-pool-workers`](https://www.npmjs.com/package/@cloudflare/vitest-pool-workers) ships vitest-3+ support |
| `@biomejs/biome` | 2.4.14 | Lint + format |

The `web-bot-auth` package targets a moving IETF draft. Re-validate signature compatibility on every major version bump.

</details>
