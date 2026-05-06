// src/facilitators/coinbase-x402.ts
//
// Coinbase x402 facilitator wrapper. Translates the public Coinbase
// facilitator API (https://x402.org/facilitator) into our Facilitator
// interface. v0 is the only registered impl; future facilitators (MPP,
// Skyfire, Mastercard Agent Pay) plug into facilitators/registry.ts
// without changing the rest of the Worker.
//
// Wire-format choice: hand-rolled fetch against x402.org/facilitator.
//
// x402-hono@1.2.0 exposes only a `paymentMiddleware` Hono factory — no
// naked verify/settle helpers — so the library cannot be used here.
// The sibling `x402` package (^1.2.0) does expose `verify` / `settle`,
// but they require a Viem/Solana wallet signer and operate on the
// blockchain directly, not on the Coinbase-hosted facilitator endpoint.
// That means hand-rolling the HTTP calls is both necessary and correct.
//
// The actual x402.org/facilitator wire format differs from the plan's
// pseudocode in several fields:
//   • Request uses `paymentHeader` (not `paymentPayload`)
//   • VerifyResponse uses `isValid` (not `valid`) and `invalidReason`
//     (not `reason`)
//   • SettleResponse uses `errorReason` (not `reason`) and
//     `transaction` (not `tx_reference`)
// These details are encapsulated here; the Facilitator interface
// exposed to the rest of the Worker uses our own terminology.

import type {
  Facilitator,
  PaymentRequirements,
  VerifyResult,
  SettleResult,
  Network,
} from "@/facilitators/types";

const FACILITATOR_BASE = "https://x402.org/facilitator";

export type CoinbaseX402Deps = {
  network: Network;
  fetchImpl?: typeof fetch;
  apiKey?: string; // reserved; the public facilitator is auth-free in v0
};

export class CoinbaseX402Facilitator implements Facilitator {
  readonly id = "coinbase-x402-base";
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: CoinbaseX402Deps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  build402(req: PaymentRequirements, error?: string): Response {
    const body = {
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          network: req.network,
          maxAmountRequired: req.amount_usdc,
          resource: req.resource,
          payTo: req.recipient,
          asset: "USDC",
          ...(error !== undefined ? { error } : {}),
        },
      ],
    };
    return new Response(JSON.stringify(body), {
      status: 402,
      headers: {
        "content-type": "application/json",
        "WWW-Authenticate": "x402",
      },
    });
  }

  async verify(req: Request, requirements: PaymentRequirements): Promise<VerifyResult> {
    const payment = req.headers.get("x-payment");
    if (!payment) {
      return { valid: false, reason: "no_payment_header" };
    }

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.deps.apiKey !== undefined) {
      headers.authorization = `Bearer ${this.deps.apiKey}`;
    }

    const r = await this.fetchImpl(`${FACILITATOR_BASE}/verify`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        x402Version: 1,
        paymentHeader: payment,
        paymentRequirements: {
          scheme: "exact",
          network: requirements.network,
          maxAmountRequired: requirements.amount_usdc,
          resource: requirements.resource,
          payTo: requirements.recipient,
          asset: "USDC",
          description: "",
          mimeType: "application/json",
          maxTimeoutSeconds: 60,
        },
      }),
    });

    if (!r.ok) {
      throw new Error(`facilitator_verify_http_${r.status}`);
    }

    const body = (await r.json()) as Record<string, unknown>;

    if (body.isValid === true) {
      const result: VerifyResult = {
        valid: true,
        // settlement_handle carries the original payment header; the settle
        // endpoint needs it to look up the on-chain transaction to broadcast.
        settlement_handle: payment,
      };
      if (typeof body.payer === "string") {
        result.payer = body.payer;
      }
      return result;
    }

    return {
      valid: false,
      reason: typeof body.invalidReason === "string" ? body.invalidReason : "verify_rejected",
    };
  }

  async settle(verify: VerifyResult): Promise<SettleResult> {
    if (verify.settlement_handle === undefined || verify.settlement_handle === null) {
      throw new Error("settle_called_without_handle");
    }

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.deps.apiKey !== undefined) {
      headers.authorization = `Bearer ${this.deps.apiKey}`;
    }

    const r = await this.fetchImpl(`${FACILITATOR_BASE}/settle`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        x402Version: 1,
        paymentHeader: verify.settlement_handle,
      }),
    });

    if (!r.ok) {
      throw new Error(`facilitator_settle_http_${r.status}`);
    }

    const body = (await r.json()) as Record<string, unknown>;

    if (body.success === true) {
      const result: SettleResult = { success: true };
      if (typeof body.transaction === "string") {
        result.tx_reference = body.transaction;
      }
      return result;
    }

    return {
      success: false,
      reason: typeof body.errorReason === "string" ? body.errorReason : "settle_rejected",
    };
  }
}
