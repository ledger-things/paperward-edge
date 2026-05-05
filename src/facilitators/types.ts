// src/facilitators/types.ts

export type Network = "base-mainnet" | "base-sepolia";

export type PaymentRequirements = {
  amount_usdc: string;
  recipient: string;
  resource: string;
  network: Network;
};

export type VerifyResult = {
  valid: boolean;
  payer?: string;
  reason?: string;
  settlement_handle?: unknown;
};

export type SettleResult = {
  success: boolean;
  tx_reference?: string;
  reason?: string;
};

export interface Facilitator {
  readonly id: string;
  build402(req: PaymentRequirements, error?: string): Response;
  verify(req: Request, requirements: PaymentRequirements): Promise<VerifyResult>;
  settle(verify: VerifyResult): Promise<SettleResult>;
}
