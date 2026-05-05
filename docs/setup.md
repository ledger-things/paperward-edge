# Paperward Edge — Self-Hosting / Initial Deployment Setup

These steps prepare a Cloudflare account to host the Paperward edge Worker. They are manual one-time tasks; once complete, deployment is automated via `wrangler`.

## Prerequisites

- Cloudflare account with the **Workers Paid plan** ($5/mo) — required for KV, R2, Custom Hostnames, and Analytics Engine.
- A zone (domain) on Cloudflare for the Worker's "fallback origin" (e.g., `paperward-edge.workers.dev` is fine; using your own zone is preferred).
- An email + Sentry project (optional for v0; required if you want exception alerts).
- A funded Base wallet (Sepolia for staging, Base mainnet for production) for receiving USDC payouts during e2e tests.

## 1. Create KV namespaces (one per env, three per env)

```bash
npx wrangler kv:namespace create KV_DOMAINS_DEV
npx wrangler kv:namespace create KV_KEY_CACHE_DEV
npx wrangler kv:namespace create KV_AUDIT_DEV
npx wrangler kv:namespace create KV_DOMAINS_STAGING
npx wrangler kv:namespace create KV_KEY_CACHE_STAGING
npx wrangler kv:namespace create KV_AUDIT_STAGING
npx wrangler kv:namespace create KV_DOMAINS_PROD
npx wrangler kv:namespace create KV_KEY_CACHE_PROD
npx wrangler kv:namespace create KV_AUDIT_PROD
```

Take each output `id` and replace the corresponding `REPLACE_ME_*` value in `wrangler.toml`.

## 2. Create R2 buckets

```bash
npx wrangler r2 bucket create paperward-logs-dev
npx wrangler r2 bucket create paperward-logs-staging
npx wrangler r2 bucket create paperward-logs-prod
```

## 3. Create Analytics Engine datasets

Visit the Cloudflare dashboard → Workers & Pages → Analytics Engine, and create datasets:
- `paperward_edge_dev`
- `paperward_edge_staging`
- `paperward_edge_prod`

## 4. Set secrets per environment

For each of `dev`, `staging`, `production`:

```bash
npx wrangler secret put SENTRY_DSN --env <env>
npx wrangler secret put ADMIN_TOKEN --env <env>
```

Generate a strong `ADMIN_TOKEN` (e.g., `openssl rand -base64 32`) and store it in your password manager.

## 5. Configure Custom Hostnames (SSL-for-SaaS)

In the Cloudflare dashboard, on a zone you own:
- SSL/TLS → Custom Hostnames → enable.
- Note the **fallback origin** (CNAME target) Cloudflare provides for your zone.

Update `bin/provision-tenant.ts`'s output text to use that CNAME target instead of the default `paperward-edge.workers.dev`.

## 6. Set up DNS for admin/health/staging hostnames

For Paperward production, configure `admin.paperward.com`, `health.paperward.com`, and (during staging) `admin.staging.paperward.com`, etc., as routes pointing to the Worker:

```bash
# Optional, if you want explicit routes rather than relying on Workers' default routing
npx wrangler route create "admin.paperward.com/*" paperward-edge --env production
```

## 7. First deploy

```bash
npx wrangler deploy --env staging
```

Smoke test:

```bash
curl https://admin.staging.paperward.com/__admin/healthz \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
# Expect: 200 with {"ok": true, "env": "staging"}

curl https://health.staging.paperward.com/version
# Expect: build SHA
```

If both succeed, the Worker is deployed correctly and ready to provision its first tenant.
