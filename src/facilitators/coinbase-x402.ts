// src/facilitators/coinbase-x402.ts
//
// EVM x402 facilitator wrapper, configured for Base by default.
// Speaks x402 v2 wire format — see specs/x402-specification-v2.md and
// specs/schemes/exact/scheme_exact_evm.md in coinbase/x402.
//
// Architecture:
//   • Resource server (this Worker) calls a hosted facilitator's /verify and
//     /settle endpoints.
//   • Facilitator handles the chain interaction (broadcasting EIP-3009
//     transferWithAuthorization). Resource server is HTTP-only.
//
// The 402 `accepts[]` entry returned to the agent uses the x402 v2 wire
// format: `eip155:<chainId>` for network, USDC contract address for asset,
// `amount` (in micro-USDC, integer string) instead of decimal `amount_usdc`.

import type {
  Facilitator,
  Network,
  PaymentRequirements,
  SettleResult,
  VerifyResult,
} from "@/facilitators/types";
import { networkToX402 } from "@/facilitators/types";

const DEFAULT_FACILITATOR_BASE = "https://x402.org/facilitator";

/** USDC contract addresses per EVM network. Source: Circle docs. */
const USDC_CONTRACT: Record<Extract<Network, "base-mainnet" | "base-sepolia">, string> = {
  "base-mainnet": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

export type CoinbaseX402Deps = {
  network: "base-mainnet" | "base-sepolia";
  /** Override the facilitator service URL. Default: x402.org/facilitator. */
  facilitatorUrl?: string;
  fetchImpl?: typeof fetch;
  apiKey?: string;
};

export class CoinbaseX402Facilitator implements Facilitator {
  readonly id = "coinbase-x402-base";
  readonly supportedNetworks: readonly Network[];
  private readonly fetchImpl: typeof fetch;
  private readonly facilitatorUrl: string;

  constructor(private readonly deps: CoinbaseX402Deps) {
    // Bind fetch to globalThis: invoking it as `this.fetchImpl(...)` (a method
    // call) would otherwise pass the facilitator instance as `this` and the CF
    // Workers runtime throws "Illegal invocation". Injected fetchImpl (for
    // tests) is used as-is — test mocks don't have the same constraint.
    this.fetchImpl = deps.fetchImpl ?? fetch.bind(globalThis);
    this.facilitatorUrl = deps.facilitatorUrl ?? DEFAULT_FACILITATOR_BASE;
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

  /**
   * Builds a single `accepts[]` entry. Exposed so the multi-rail paywall
   * middleware can compose entries from several facilitators into one 402.
   */
  buildAcceptsEntry(req: PaymentRequirements): Record<string, unknown> {
    return {
      scheme: "exact",
      network: networkToX402(req.network),
      amount: usdcDecimalToMicro(req.amount_usdc),
      asset: USDC_CONTRACT[this.deps.network],
      payTo: req.recipient,
      maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2" },
    };
  }

  async verify(req: Request, requirements: PaymentRequirements): Promise<VerifyResult> {
    const payment = req.headers.get("x-payment");
    if (!payment) return { valid: false, reason: "no_payment_header" };

    const paymentPayload = decodePaymentHeader(payment);
    if (!paymentPayload) return { valid: false, reason: "malformed_payment_header" };

    const r = await this.fetchImpl(`${this.facilitatorUrl}/verify`, {
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
        // settlement_handle carries the decoded payload + original requirements;
        // settle() re-uses both when calling the facilitator.
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

    const r = await this.fetchImpl(`${this.facilitatorUrl}/settle`, {
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

/**
 * USDC has 6 decimal places. Spec wants integer string of micro-USDC.
 * "0.005" → "5000". Tolerates leading/trailing whitespace, optional sign rejected.
 */
function usdcDecimalToMicro(decimal: string): string {
  const trimmed = decimal.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) {
    throw new Error(`invalid_usdc_amount: ${decimal}`);
  }
  const [whole, frac = ""] = trimmed.split(".");
  const padded = (frac + "000000").slice(0, 6);
  // Strip leading zeros from concatenation, but keep at least "0".
  const result = `${whole}${padded}`.replace(/^0+(?=\d)/, "") || "0";
  return result;
}

/** X-PAYMENT header is base64(JSON(PaymentPayload)). Returns the parsed object or null. */
export function decodePaymentHeader(header: string): unknown {
  try {
    const json = atob(header);
    return JSON.parse(json);
  } catch {
    return null;
  }
}
