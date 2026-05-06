// src/facilitators/types.ts
//
// Facilitator interface — the contract every payment-rail wrapper implements.
// EVM (Base, Ethereum, etc.) and SVM (Solana) share this shape; only the
// network identifier and asset format differ on the wire.

/** Internal friendly names. Translated to x402 wire identifiers inside each Facilitator. */
export type Network = "base-mainnet" | "base-sepolia" | "solana-mainnet" | "solana-devnet";

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
  /** Opaque token consumed by `settle()` — typically the original payment payload. */
  settlement_handle?: unknown;
};

export type SettleResult = {
  success: boolean;
  tx_reference?: string;
  reason?: string;
};

/**
 * One facilitator handles one payment rail (network + asset). The same wire
 * shape (POST /verify, POST /settle, x402 v2 envelope) works across rails;
 * the Facilitator translates between our Network enum and the x402 spec's
 * network identifier (`eip155:<chainId>` or `solana:<base58-genesis>`).
 */
export interface Facilitator {
  readonly id: string;
  /** Networks this facilitator can verify/settle on. */
  readonly supportedNetworks: readonly Network[];
  build402(req: PaymentRequirements, error?: string): Response;
  verify(req: Request, requirements: PaymentRequirements): Promise<VerifyResult>;
  settle(verify: VerifyResult): Promise<SettleResult>;
}

// ---- x402 v2 wire types (shared by both EVM and SVM facilitators) ----

/** Translates our Network enum to x402 v2 wire `network` field. */
export function networkToX402(network: Network): string {
  switch (network) {
    case "base-mainnet":
      return "eip155:8453";
    case "base-sepolia":
      return "eip155:84532";
    case "solana-mainnet":
      return "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
    case "solana-devnet":
      return "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1O2pu1cLs6Cs";
  }
}

/** Inverse of `networkToX402` for parsing inbound X-PAYMENT headers. */
export function networkFromX402(wire: string): Network | null {
  switch (wire) {
    case "eip155:8453":
      return "base-mainnet";
    case "eip155:84532":
      return "base-sepolia";
    case "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp":
      return "solana-mainnet";
    case "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1O2pu1cLs6Cs":
      return "solana-devnet";
    default:
      return null;
  }
}
