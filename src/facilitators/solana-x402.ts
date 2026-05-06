// src/facilitators/solana-x402.ts
//
// Solana (SVM) x402 facilitator wrapper. Speaks x402 v2 wire format —
// see specs/schemes/exact/scheme_exact_svm.md in the coinbase/x402 repo.
//
// Architecture (identical to the EVM facilitator):
//   • Resource server (this Worker) calls a hosted facilitator's /verify and
//     /settle endpoints. No `@solana/web3.js` in the Worker.
//   • The facilitator decodes the partially-signed Solana transaction, runs
//     the spec's MUST checks (instruction layout, fee-payer safety, transfer
//     intent, etc.), co-signs as feePayer, and broadcasts.
//
// What's different from EVM on the wire:
//   • `network` is `solana:<base58 genesis hash>` (not `eip155:<chainId>`).
//   • `asset` is the SPL token mint pubkey (e.g. USDC mint), not a contract.
//   • `payload.transaction` is base64-encoded serialized partially-signed tx,
//     not (signature + EIP-3009 authorization).
//   • `extra.feePayer` MUST be set in the 402 PaymentRequirements — it's the
//     facilitator's pubkey that will co-sign and pay gas.
//
// The Facilitator interface and HTTP shape stay identical to EVM.

import type {
  Facilitator,
  Network,
  PaymentRequirements,
  SettleResult,
  VerifyResult,
} from "@/facilitators/types";
import { networkToX402 } from "@/facilitators/types";
import { decodePaymentHeader } from "@/facilitators/coinbase-x402";

/** USDC SPL mint addresses per Solana cluster. */
const USDC_MINT: Record<Extract<Network, "solana-mainnet" | "solana-devnet">, string> = {
  "solana-mainnet": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  // Devnet USDC has no canonical mint; pick one used by Circle's faucet or by
  // your facilitator. This is the most-used devnet test mint and matches what
  // pay.sh / Solana ecosystem references default to.
  "solana-devnet": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
};

export type SolanaX402Deps = {
  network: "solana-mainnet" | "solana-devnet";
  /** The facilitator's Solana pubkey — embedded in 402 responses as feePayer. */
  feePayer: string;
  /** Facilitator service URL. No public default yet; operator must configure. */
  facilitatorUrl: string;
  fetchImpl?: typeof fetch;
  apiKey?: string;
};

export class SolanaX402Facilitator implements Facilitator {
  readonly id: string;
  readonly supportedNetworks: readonly Network[];
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: SolanaX402Deps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.id = `x402-${deps.network}`;
    this.supportedNetworks = [deps.network];
  }

  build402(req: PaymentRequirements, error?: string): Response {
    const body: Record<string, unknown> = {
      x402Version: 2,
      resource: {
        url: req.resource,
        description: "",
        mimeType: "application/json",
      },
      accepts: [this.buildAcceptsEntry(req)],
    };
    if (error !== undefined) body.error = error;

    return new Response(JSON.stringify(body), {
      status: 402,
      headers: {
        "content-type": "application/json",
        "WWW-Authenticate": "x402",
      },
    });
  }

  /** Builds a single `accepts[]` entry. Composable into multi-rail 402 responses. */
  buildAcceptsEntry(req: PaymentRequirements): Record<string, unknown> {
    return {
      scheme: "exact",
      network: networkToX402(req.network),
      amount: usdcDecimalToMicro(req.amount_usdc),
      asset: USDC_MINT[this.deps.network],
      payTo: req.recipient,
      maxTimeoutSeconds: 60,
      extra: { feePayer: this.deps.feePayer },
    };
  }

  async verify(req: Request, requirements: PaymentRequirements): Promise<VerifyResult> {
    const payment = req.headers.get("x-payment");
    if (!payment) return { valid: false, reason: "no_payment_header" };

    const paymentPayload = decodePaymentHeader(payment);
    if (!paymentPayload) return { valid: false, reason: "malformed_payment_header" };

    const r = await this.fetchImpl(`${this.deps.facilitatorUrl}/verify`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload,
        paymentRequirements: this.buildAcceptsEntry(requirements),
      }),
    });

    if (!r.ok) throw new Error(`facilitator_verify_http_${r.status}`);

    const body = (await r.json()) as Record<string, unknown>;

    if (body.isValid === true) {
      const result: VerifyResult = {
        valid: true,
        settlement_handle: { paymentPayload, requirements },
      };
      if (typeof body.payer === "string") result.payer = body.payer;
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
    const handle = verify.settlement_handle as {
      paymentPayload: unknown;
      requirements: PaymentRequirements;
    };

    const r = await this.fetchImpl(`${this.deps.facilitatorUrl}/settle`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        x402Version: 2,
        paymentPayload: handle.paymentPayload,
        paymentRequirements: this.buildAcceptsEntry(handle.requirements),
      }),
    });

    if (!r.ok) throw new Error(`facilitator_settle_http_${r.status}`);

    const body = (await r.json()) as Record<string, unknown>;

    if (body.success === true) {
      const result: SettleResult = { success: true };
      if (typeof body.transaction === "string") result.tx_reference = body.transaction;
      return result;
    }

    return {
      success: false,
      reason: typeof body.errorReason === "string" ? body.errorReason : "settle_rejected",
    };
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.deps.apiKey !== undefined) h.authorization = `Bearer ${this.deps.apiKey}`;
    return h;
  }
}

/** USDC has 6 decimal places. "0.005" → "5000". */
function usdcDecimalToMicro(decimal: string): string {
  const trimmed = decimal.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) {
    throw new Error(`invalid_usdc_amount: ${decimal}`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  const padded = (frac + "000000").slice(0, 6);
  const result = `${whole}${padded}`.replace(/^0+(?=\d)/, "") || "0";
  return result;
}
