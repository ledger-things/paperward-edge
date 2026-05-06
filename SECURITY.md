# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.x     | Current development branch — security fixes backported as needed |

Once a stable v1 release is tagged, this table will be updated to reflect the supported range.

## Reporting a Vulnerability

**Please do NOT file a public GitHub issue for security vulnerabilities.**

Email **security@paperward.com** (TODO: confirm this address is monitored before the repo goes public) with:

- A description of the vulnerability and its potential impact
- Steps to reproduce (or a proof-of-concept)
- The affected version / commit hash
- Any suggested mitigations you have in mind

You will receive an acknowledgement within **30 days**. After a fix is developed and deployed, a public advisory will be published within **90 days** of the original report (or sooner if you consent).

If you do not hear back within 30 days, please send a follow-up to the same address.

## Why This Matters: Payments-Adjacent Code

Paperward Edge sits in the critical path of AI-agent payment flows. The Worker:

- Handles HTTP payment-authorization headers containing cryptographic proofs
- Calls out to the Coinbase x402 facilitator to settle USDC transactions on Base
- Verifies Ed25519 signatures from agent identity keys (Web Bot Auth / RFC 9421)
- Routes traffic and applies per-tenant pricing rules

A vulnerability in any of these paths could allow agents to bypass payment requirements,
drain facilitator balances, forge publisher identity, or manipulate pricing logic.
**Responsible disclosure is critical.** We ask that you give us a fair opportunity to fix
issues before publishing details publicly.

## Coordinated Disclosure Timeline

| Milestone | Target |
|-----------|--------|
| Acknowledgement | ≤ 30 days from report |
| Status update | ≤ 60 days from report |
| Fix deployed + advisory published | ≤ 90 days from report |

We will credit reporters in the advisory by default. If you prefer to remain anonymous,
please say so in your initial email.

## Scope

In scope:

- `src/` — all Worker source code
- `bin/provision-tenant.ts` — tenant provisioning CLI
- WBA signature verification logic
- x402 payment handling and settlement
- Admin endpoint authentication and authorization
- KV/R2 data access patterns

Out of scope:

- The Paperward control plane (closed-source, separate repo)
- The publisher dashboard (separate repo)
- Cloudflare infrastructure itself (report to Cloudflare)
- Issues that require physical access to a machine

## Acknowledgements

We are grateful to all researchers who responsibly disclose vulnerabilities. Thank you.
