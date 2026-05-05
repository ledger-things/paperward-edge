// test/mocks/facilitator.ts
import type { Facilitator, PaymentRequirements, VerifyResult, SettleResult } from "@/facilitators/types";

export class MockFacilitator implements Facilitator {
  readonly id = "coinbase-x402-base";
  verifyImpl: () => Promise<VerifyResult> = async () => ({ valid: true, settlement_handle: "h" });
  settleImpl: () => Promise<SettleResult> = async () => ({ success: true, tx_reference: "0xtx" });

  build402(req: PaymentRequirements, error?: string): Response {
    return new Response(JSON.stringify({ accepts: [{ resource: req.resource, payTo: req.recipient, error }] }), {
      status: 402,
      headers: { "WWW-Authenticate": "x402", "content-type": "application/json" },
    });
  }
  async verify(_req: Request, _r: PaymentRequirements): Promise<VerifyResult> { return this.verifyImpl(); }
  async settle(_v: VerifyResult): Promise<SettleResult> { return this.settleImpl(); }
}
