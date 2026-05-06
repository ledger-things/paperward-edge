// test/mocks/facilitator.ts
import type {
  Facilitator,
  Network,
  PaymentRequirements,
  SettleResult,
  VerifyResult,
} from "@/facilitators/types";

export class MockFacilitator implements Facilitator {
  readonly id: string;
  readonly supportedNetworks: readonly Network[];
  verifyImpl: () => Promise<VerifyResult> = async () => ({ valid: true, settlement_handle: "h" });
  settleImpl: () => Promise<SettleResult> = async () => ({ success: true, tx_reference: "0xtx" });

  constructor(opts: { id?: string; supportedNetworks?: Network[] } = {}) {
    this.id = opts.id ?? "coinbase-x402-base";
    this.supportedNetworks = opts.supportedNetworks ?? ["base-sepolia"];
  }

  build402(req: PaymentRequirements, error?: string): Response {
    return new Response(
      JSON.stringify({ accepts: [{ resource: req.resource, payTo: req.recipient, error }] }),
      {
        status: 402,
        headers: { "WWW-Authenticate": "x402", "content-type": "application/json" },
      },
    );
  }
  /** Exposed for the multi-rail paywall middleware. */
  buildAcceptsEntry(req: PaymentRequirements): Record<string, unknown> {
    return { scheme: "exact", network: req.network, payTo: req.recipient, asset: "USDC" };
  }
  async verify(_req: Request, _r: PaymentRequirements): Promise<VerifyResult> {
    return this.verifyImpl();
  }
  async settle(_v: VerifyResult): Promise<SettleResult> {
    return this.settleImpl();
  }
}
