# Production cutover checklist

Run through this list before the first `wrangler deploy --env production`. Each item must be checked off explicitly.

- [ ] All KV namespaces created (`KV_DOMAINS_PROD`, `KV_KEY_CACHE_PROD`, `KV_AUDIT_PROD`); IDs filled into `wrangler.toml`.
- [ ] R2 bucket `paperward-logs-prod` created.
- [ ] Analytics Engine dataset `paperward_edge_prod` created.
- [ ] Production secrets set: `SENTRY_DSN`, `ADMIN_TOKEN` (use a fresh strong token, NOT the staging token).
- [ ] `admin.paperward.com` and `health.paperward.com` DNS configured and routing to the Worker.
- [ ] `bin/provision-tenant.ts` tested end-to-end against staging.
- [ ] Sentry production project receiving events (test by triggering an unhandled exception via a misconfigured test tenant).
- [ ] First production payout wallet address verified (publisher's actual Base mainnet USDC receive address). Sent at least $0.001 USDC to it as a smoke test from a separate wallet to confirm receipt.
- [ ] Branch protection on `main` requires the GitHub Actions CI pass before merge.
- [ ] At least 2 weeks of staging dogfooding completed without unhandled errors.
- [ ] Operational runbook (this doc + `docs/setup.md`) reviewed by a second person.
- [ ] On-call rotation defined and documented (who responds to Sentry alerts).

## After first prod deploy

- [ ] Visit `https://health.paperward.com/healthz` and confirm `{ kv_ok: true, r2_ok: true }`.
- [ ] Provision the first real tenant via `bin/provision-tenant.ts`.
- [ ] Confirm DCV completes within 24h.
- [ ] Confirm a test request to the tenant returns expected behavior (signed = 402, browser = origin pass-through).
- [ ] Watch Sentry, Workers logs, and the `paywall_settle_failures_total` metric for the first 7 days.

## If you need to roll back

```bash
# List recent deploys
npx wrangler deployments list --env production

# Roll back to a previous version
npx wrangler rollback <deployment-id> --env production
```

Tenant configs in KV are unaffected by Worker rollback.
