# E2E test suite

These tests run against the deployed **staging** Paperward edge Worker on **Base Sepolia testnet**.

## Prerequisites

1. The staging Worker must be deployed (`wrangler deploy --env staging`).
2. A test tenant must be provisioned at `e2e-test.staging.paperward.com` (see Phase N1 of the implementation plan).
3. A test agent's Sepolia USDC wallet must be funded with at least 1 USDC to cover repeated test runs. Top up via:
   - https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet (Base Sepolia ETH for gas)
   - https://faucet.circle.com/ (USDC on Sepolia)

## Required environment variables

- `E2E_HOSTNAME` — `e2e-test.staging.paperward.com`
- `E2E_SEPOLIA_PRIVATE_KEY` — Sepolia wallet private key for the test agent (0x... hex)
- `E2E_TEST_AGENT_KEY` — optional override for the WBA signing key; defaults to `test/fixtures/wba/keys.ts`

## Run

```bash
npm run test:e2e
```

## What's tested

1. Browser request → 200 from origin
2. Signed request without payment → 402 with x402 headers
3. Signed request with valid Sepolia payment → 200 + `X-PAYMENT-RESPONSE`
4. Signed request with insufficient amount → 402 charge_verify_failed

## Top-up cadence

The test wallet should hold ~50 USDC for one year of CI runs (3M-USDC-microtransfers/year × $0.001 each = $3000 worst case). Faucets give 10 USDC/day. Top up monthly. Document the top-up in your team's calendar.
