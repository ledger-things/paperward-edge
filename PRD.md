# Paperward — Agent Payments Platform for SMB Publishers

**Brand:** Paperward
**Document owner:** Founder
**Status:** Draft v0.2 — naming locked, pre-development
**Last updated:** 2026-05-05

---

## 1. Problem

Independent publishers, bloggers, and SMB content sites are losing 30–90% of their organic traffic to AI search and zero-click answers. AI agents and fetchers consume their content to generate answers, but publishers receive no traffic, no ad impressions, and no payment. Existing solutions (Cloudflare Pay-per-Crawl, TollBit, Skyfire) target enterprise publishers with deal teams. The 99% of publishers without enterprise leverage have no way to get paid when AI agents access their content.

**The pain in numbers:**

- AI chatbot referrals drive ~96% less traffic than traditional search.
- Small publishers (1k–10k daily views) lost ~60% of search referral traffic over 2 years.
- Examples: Stereogum lost 70% of ad revenue; Charleston Crafted lost 70% of traffic; The Planet D shut down after 90% traffic drop.
- Web Bot Auth, x402, MPP, ACP, AP2, Skyfire, Visa TAP, Mastercard Agent Pay all shipped in 2025–2026 — but none of it is packaged for non-enterprise publishers.

## 2. Vision

**Paperward is the agent-payments layer for everyone who isn't on Cloudflare Enterprise.**

A drop-in product for WordPress, Next.js, Ghost, and Shopify sites that detects AI agent traffic, applies publisher-defined pricing rules, accepts payment via open agent payment protocols (starting with x402), and pays out in fiat to the publisher's bank account.

Think Vercel, not AWS. Think Plaid, not Visa. Think Shopify, not Salesforce.

## 3. Goals & non-goals

### Goals (v1)

- Let a non-technical publisher install in under 10 minutes.
- Detect cryptographically signed AI agents via Web Bot Auth (IETF standard).
- Detect common unsigned AI fetchers via a heuristic fallback (user-agent + IP ranges + behavioral signals).
- Charge agents per fetch in USDC via x402 protocol.
- Settle to publisher's bank account in fiat via Stripe Connect.
- Provide a dashboard with revenue, top-paying agents, and request analytics.
- Ship a WordPress plugin and a Next.js middleware as the first two integrations.

### Non-goals (v1)

- Not building a new payment protocol. We use existing open standards (x402 first; MPP/ACP/AP2/Skyfire later).
- Not building enterprise sales motion (Skyfire, TollBit, Cloudflare own that).
- Not building an analytics-only product (citation tracking is adjacent and may be a v2 add-on).
- Not custodying funds. The Coinbase facilitator handles settlement; we don't hold USDC.
- Not building a Stripe replacement. Payouts via Stripe Connect.
- Not solving full bot management (Cloudflare/Akamai/F5 own that).

## 4. Target users

### Primary

Independent and SMB publishers, in priority order:
1. WordPress publishers (~40% of the web; biggest TAM, most distribution leverage)
2. Next.js / Vercel-hosted publishers (modern, technical, early adopters)
3. Ghost publishers (premium content blogs, often paid newsletters)
4. Shopify content stores (later)

### Secondary

- WordPress hosting providers (WP Engine, Kinsta, Hostinger) as distribution partners
- Mid-size publisher networks who want a self-serve option

### Out of scope for v1

- Enterprise news organizations (have direct deals)
- E-commerce checkout flows (different problem; ACP handles it)

## 5. User stories

### Publisher

- *As a publisher,* I want to install a WordPress plugin and have it monetize agent traffic with default settings so I can earn passively without learning new infrastructure.
- *As a publisher,* I want to set per-path or per-content-type pricing (e.g., free for archive, $0.005 for premium) so I can match price to value.
- *As a publisher,* I want to whitelist specific agents (e.g., free for OpenAI, charge Perplexity) so I can balance visibility and revenue.
- *As a publisher,* I want a dashboard showing revenue, request volume, and top-paying agents so I can understand what's working.
- *As a publisher,* I want to receive payouts to my bank account weekly in my local currency so I don't have to deal with crypto.
- *As a publisher,* I want to know that human readers referred from AI answers won't be charged so I don't lose visitors.

### Agent operator (indirect)

- *As an agent operator,* I want to send a Web Bot Auth signature and a x402 payment header and reliably get a 200 response with the content.
- *As an agent operator,* I don't want to negotiate with each publisher individually — standardized rails only.

## 6. Architecture overview

Two-piece architecture: edge layer + control plane. The edge layer does the work; the control plane is how publishers configure it.

```
┌──────────────────────┐     ┌─────────────────────────────────────┐    ┌─────────────────────┐
│  AI Agent / Fetcher  │────▶│  EDGE LAYER (our infrastructure)    │───▶│  Publisher's Origin │
│  (signed via WBA)    │     │                                     │    │  (WordPress, Vercel,│
│  (carries x402 hdr)  │◀────│  • Web Bot Auth verification        │    │   Ghost, Shopify)   │
└──────────────────────┘     │  • Heuristic agent detection        │    └─────────────────────┘
                             │  • Pricing rule engine              │
                             │  • x402 paywall (HTTP 402 + verify) │
                             │  • Logs every request for analytics │
                             └─────────┬───────────────────────────┘
                                       │
                                       ▼
                             ┌─────────────────────────┐    ┌─────────────────────┐
                             │  CONTROL PLANE          │    │  Coinbase x402      │
                             │  (Next.js + Postgres)   │───▶│  Facilitator        │
                             │                         │    │  (USDC on Base)     │
                             │  • Publisher dashboard  │    └─────────────────────┘
                             │  • Pricing rule config  │
                             │  • Analytics & revenue  │    ┌─────────────────────┐
                             │  • Pushes config → edge │───▶│  Stripe Connect     │
                             └─────────────────────────┘    │  (USDC → fiat       │
                                       ▲                    │   weekly payout)    │
                                       │                    └─────────────────────┘
                       ┌───────────────┴───────────────┐
                       │                               │
              ┌────────────────┐              ┌────────────────┐
              │ WordPress      │              │ Next.js        │
              │ Plugin         │              │ Middleware     │
              │ (PHP)          │              │ (npm package)  │
              └────────────────┘              └────────────────┘
                       │                               │
              ┌────────────────┐              ┌────────────────┐
              │ Publisher's    │              │ Publisher's    │
              │ WordPress site │              │ Vercel deploy  │
              └────────────────┘              └────────────────┘
```

### Why two pieces, not just a plugin

WordPress plugins run inside PHP after WordPress bootstraps, after caching layers (WP Super Cache, WP Engine's Varnish edge) have already served the page. By that point we may not be able to cleanly issue 402 status codes or block traffic. The edge layer guarantees every request is inspected before it hits the origin. Plugins are the install surface and dashboard, not the enforcement point.

For self-hosted setups where DNS proxying isn't possible, the WordPress plugin runs a best-effort PHP fallback (lower accuracy, no caching protection).

## 7. Component breakdown

### 7.1 Edge layer

**Stack:** TypeScript, Hono framework, deployed on Cloudflare Workers (primary) and/or Fly.io (fallback for non-CF customers).

**Responsibilities:**
- Receive every request to a configured publisher domain.
- Run Web Bot Auth verification (RFC 9421) on requests with `Signature`, `Signature-Input`, `Signature-Agent` headers.
- Run heuristic agent detection on unsigned requests (user-agent matching against known AI bot list, IP range matching, behavioral signals).
- Look up pricing rules for the requested path from the control plane (cached per domain, refreshed on config change).
- For agent traffic without valid payment: return 402 with `PAYMENT-REQUIRED` header (x402 format).
- For agent traffic with valid `X-PAYMENT` header: call the x402 facilitator to verify, then forward to origin.
- For human traffic and free-tier agents: forward to origin transparently.
- Log every decision (agent identity, path, price, result) to a queue for the control plane.

**Key dependencies:**
- `web-bot-auth` npm package (Stytch-maintained reference implementation) for signature verification
- `x402-hono` middleware from Coinbase for x402 paywall
- Coinbase facilitator at `x402.org/facilitator` (USDC on Base, fee-free for v1)
- Cloudflare Workers KV (or equivalent) for cached publisher config

### 7.2 Control plane

**Stack:** Next.js 15 (App Router), Postgres (Neon), Drizzle ORM, Auth.js, deployed on Vercel.

**Responsibilities:**
- Publisher signup, onboarding wizard, billing.
- Dashboard: revenue chart, request volume, top-paying agents, top-monetized paths, payout history.
- Pricing rule configuration: simple UI (templates) and advanced (per-path, per-agent, per-content-type rules).
- Push config changes to edge layer via internal API.
- Receive request logs from edge, aggregate into analytics tables.
- Manage Stripe Connect onboarding for publishers.
- Reconcile USDC inflows → schedule fiat payouts via Stripe Connect.

**Key tables:**
- `publishers` (id, email, stripe_account_id, payout_method, created_at)
- `domains` (id, publisher_id, domain, edge_config_version, status)
- `pricing_rules` (id, domain_id, path_pattern, agent_pattern, price_usdc, action: charge|allow|block)
- `requests` (id, domain_id, agent_id, path, decision, price, paid, ts) — partitioned by month
- `agents` (id, kya_id_or_keyid, name, operator, signed: bool)
- `payouts` (id, publisher_id, amount, currency, stripe_transfer_id, status, ts)

### 7.3 WordPress plugin

**Stack:** PHP 7.4+, packaged for the WP Plugin Directory.

**Responsibilities:**
- Onboarding wizard inside WP Admin: connect account, choose pricing template, generate edge config.
- Optional DNS guidance for proxying through our edge (CNAME or full DNS delegation).
- For sites that don't proxy through edge (fallback mode): hook `init` action early to verify Web Bot Auth signatures in PHP and return 402 before WordPress renders. Note this is best-effort and bypassed by full-page caches.
- Sync pricing rule changes to the control plane via REST.
- Display revenue widget on the WP Admin dashboard.

**Open question:** How aggressively do we push edge proxying vs. PHP fallback? Edge is technically superior; PHP fallback is friction-free. Likely default to PHP for free tier, push edge for paid tier.

### 7.4 Next.js middleware

**Stack:** TypeScript npm package, distributed via npm.

**Responsibilities:**
- Single import in `middleware.ts` that wraps the request handler.
- Same verification + 402 logic as the edge layer, but runs in the publisher's own Vercel deployment.
- Pulls config from control plane on cold start, caches in memory.

This is the easiest integration; technical publishers will adopt it first and become reference customers.

## 8. Detection strategy

### Tier 1: Web Bot Auth (high confidence)

Verify the `Signature`, `Signature-Input`, `Signature-Agent` headers per RFC 9421:
1. Fetch public key from `Signature-Agent` URL + `/.well-known/http-message-signatures-directory`.
2. Verify Ed25519 signature over declared components.
3. Check timestamp validity and `@authority` matches our domain.
4. Result: high-confidence agent identity; trust the operator claim.

### Tier 2: Known agent registry (medium confidence)

Maintain a list of known AI agent signals:
- User-agent strings (GPTBot, ClaudeBot, PerplexityBot, Bytespider, etc.)
- Published IP ranges (OpenAI, Anthropic, Perplexity all publish CIDR blocks)
- Reverse DNS validation where applicable

Source from open lists: `darkvisitors.com`, Cloudflare verified bots, individual provider documentation.

### Tier 3: Heuristic fallback (low confidence)

Behavioral signals for agents that don't sign and aren't in the registry:
- TLS fingerprint (JA4)
- Request rate per IP
- Absence of Accept-Language, presence of automation user-agent patterns
- Request pattern (e.g., crawls many URLs in short time without rendering JS)

Tier 3 signals never block; they only flag for the publisher to review or apply soft rules.

### Distinguishing humans referred from AI answers

A human clicking a citation in ChatGPT or Perplexity should never see a 402. Detection rule: presence of `Referer` from known AI answer surfaces + absence of Web Bot Auth signature + browser-shaped user-agent and TLS fingerprint = human. Default rule: always allow.

## 9. Pricing model (the product, not the publisher)

- **Free tier:** Up to $20/month earned. We take 0%. "Powered by Paperward" footer link (defaulted on, removable in paid).
- **Pro tier:** $19/month flat OR 10% of agent revenue, whichever is greater. No branding. Multi-domain up to 3.
- **Business tier:** $99/month. Unlimited domains, custom pricing rules, priority detection updates, API access.

Rationale: Stripe model. Free until the publisher makes money, then we share upside. Aligns incentives — we only win when the publisher wins.

## 10. Success metrics

### North star (12 months)

- Number of domains with at least 1 paid agent transaction in the trailing 30 days.

### Activation

- Time from signup to first 402 served: target < 10 min for plugin, < 30 min for edge proxying.
- % of installs that complete onboarding (configure at least one pricing rule).

### Engagement

- Weekly active publishers (publishers who logged in or earned revenue).
- Median revenue per active publisher.

### Retention

- Month-2 retention of installs that earned > $1.
- Logo churn at 90 days.

### Business

- GMV (gross USDC settled to publishers).
- Take rate (effective % we capture across free + paid tiers).
- ARR.

## 11. Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Cloudflare ships a self-serve SMB product | Medium | High | Move fast; focus on multi-platform (Cloudflare is CF-only); be the obvious acquisition target by month 18 |
| Agent payment volumes stay small through 2027 | Medium | High | Bundle citation analytics in v2 so publishers get value even before payments scale |
| Stripe / WordPress / Vercel native this | Medium | Medium | Speed; partnerships; deep platform integrations they won't replicate |
| Web Bot Auth adoption stalls | Low | Medium | Tier 2 + Tier 3 detection covers the gap; standard is IETF-tracked with major adopters |
| x402 loses the protocol war to MPP/ACP | Medium | Low | We're rail-agnostic; add MPP/Skyfire after v1; abstraction is the moat |
| Publisher trust: putting our proxy in front of their site | High | High | Open-source the edge component; transparent uptime; SOC 2 by year 2; never modify content |
| Detection accuracy: false positives blocking real users | Medium | High | Conservative defaults; Tier 3 never blocks; aggressive monitoring; easy publisher override |
| Regulatory / KYC for stablecoin payouts | Low | Medium | Stripe Connect handles compliance for fiat payouts; we don't custody USDC |

## 12. Open questions

1. Edge platform: Cloudflare Workers (fast, cheap, but we depend on a competitor) vs. Fly.io / our own infra (more control, higher ops burden). Likely answer: Workers for v1 with a path to multi-cloud.
2. How aggressively do we push DNS proxying? It's required for cache-bypassing enforcement but adds onboarding friction.
3. Do we ship citation tracking in v1 (delivers value when payment volumes are still small) or save for v2 (faster initial ship)?
4. Pricing templates: what are the 3-5 starter templates that cover 80% of publishers?
5. Default behavior for unsigned, unknown agents: charge, allow, or block? Likely "allow with logging" by default; let publisher tighten.
6. Open-source strategy: edge component MIT licensed (trust + adoption), control plane closed source (commercial product)?

## 13. Phased roadmap

### Phase 0 — Validation (weeks 1–4, pre-build)

- 20 publisher interviews (small/mid bloggers losing traffic).
- 5 host/agency conversations (WP Engine, Kinsta, mid-size WP agencies).
- Landing page + waitlist + $500 ad spend; measure conversion.
- Sandbox test: charge a real x402 agent in dev environment.

### Phase 1 — MVP (weeks 5–12)

- Edge layer on Cloudflare Workers with Web Bot Auth + Tier 2 detection.
- x402 integration via Coinbase facilitator (USDC on Base).
- Control plane: signup, onboarding, basic dashboard, pricing rules.
- WordPress plugin (PHP fallback mode) + Next.js middleware.
- Stripe Connect for fiat payouts.
- Closed beta with 10 publishers.

### Phase 2 — Public launch (months 4–6)

- Public WordPress plugin directory listing.
- Vercel marketplace listing.
- Tier 3 heuristic detection.
- Pricing rule templates and per-path rules UI.
- Marketing site with case studies.

### Phase 3 — Expansion (months 7–12)

- Ghost integration.
- Shopify app.
- Add Skyfire and MPP rails.
- First host partnership (bundled with a hosting plan).
- Citation tracker as a free upsell.
- SOC 2 Type 1.

### Phase 4 — Scale (year 2)

- Multi-cloud edge.
- Enterprise tier.
- API for agent operators to pre-fund and pre-authorize.
- Move into adjacent verticals (commerce sites, API providers).

## 14. Stack summary (for Claude Code brainstorming)

- **Edge:** TypeScript, Hono, Cloudflare Workers (Wrangler), Workers KV, Durable Objects (for rate limiting and counters)
- **Control plane:** Next.js 15 App Router, TypeScript, Postgres (Neon), Drizzle ORM, Auth.js, Tailwind, shadcn/ui
- **WordPress plugin:** PHP 7.4+, WP Plugin Boilerplate
- **Next.js middleware:** TypeScript, distributed via npm
- **Payments:** x402 via Coinbase facilitator, Stripe Connect for payouts
- **Auth:** Auth.js (publishers), API keys (publisher → edge), Web Bot Auth (agents → edge)
- **Observability:** OpenTelemetry, Honeycomb or Axiom, Sentry
- **Infrastructure:** Vercel (control plane), Cloudflare Workers (edge), Neon (Postgres)
- **Open standards we depend on:** RFC 9421 (HTTP Message Signatures), Web Bot Auth IETF draft, x402 (Coinbase, open spec)

## 15. Glossary

- **Web Bot Auth (WBA):** IETF-tracked standard for cryptographically signing automated HTTP requests via Ed25519 + RFC 9421 message signatures.
- **x402:** Open protocol for HTTP-native payments using the 402 status code. USDC settlement on Base by default, chain-agnostic.
- **Facilitator:** Optional service in x402 that verifies and settles payments so resource servers don't need direct blockchain integration. Coinbase runs the canonical one.
- **KYA (Know Your Agent):** Skyfire's protocol for verifying agent identity tied to operator/principal. Future integration; not v1.
- **Edge layer:** The proxy/middleware between agent and origin where verification and gating happens.
- **Control plane:** The publisher-facing dashboard and configuration backend that pushes config to the edge.

---

**Next step:** Use this PRD as the seed for a Claude Code session. Suggested first prompts:
1. "Scaffold the Paperward edge layer with Hono + web-bot-auth + x402-hono, deployed to Cloudflare Workers."
2. "Scaffold the Paperward control plane Next.js app with Auth.js, Drizzle, and the data model from section 7.2."
3. "Generate the Paperward WordPress plugin skeleton with the PHP fallback verification flow."
