// src/facilitators/registry.ts
//
// Registers every Facilitator the Worker can invoke. The registry maps from
// stable string ids (which tenants reference in their config) to live
// Facilitator instances. Adding a new payment rail = adding a class + an
// entry here.

import type { Facilitator, Network } from "@/facilitators/types";
import { CoinbaseX402Facilitator } from "@/facilitators/coinbase-x402";
import { SolanaX402Facilitator } from "@/facilitators/solana-x402";

export type FacilitatorRegistryDeps = {
  /** Drives env-specific network selection (testnet for dev/staging, mainnet for prod). */
  env: "dev" | "staging" | "production";
  coinbaseApiKey?: string;
  /** Solana facilitator service URL — required if Solana facilitator is used. */
  solanaFacilitatorUrl?: string;
  /** Solana facilitator's pubkey, embedded in 402 responses as feePayer. */
  solanaFeePayer?: string;
  solanaApiKey?: string;
};

export function buildFacilitatorRegistry(deps: FacilitatorRegistryDeps): Map<string, Facilitator> {
  const m = new Map<string, Facilitator>();

  // EVM (Base) — always registered.
  const evmNetwork = deps.env === "production" ? "base-mainnet" : "base-sepolia";
  const coinbaseDeps =
    deps.coinbaseApiKey !== undefined
      ? { network: evmNetwork, apiKey: deps.coinbaseApiKey }
      : { network: evmNetwork };
  m.set("coinbase-x402-base", new CoinbaseX402Facilitator(coinbaseDeps as never));

  // Solana — only registered if the operator has configured a facilitator URL
  // and a feePayer pubkey (since both are required for a working SVM rail).
  if (deps.solanaFacilitatorUrl && deps.solanaFeePayer) {
    const svmNetwork = deps.env === "production" ? "solana-mainnet" : "solana-devnet";
    const solDeps: ConstructorParameters<typeof SolanaX402Facilitator>[0] = {
      network: svmNetwork,
      facilitatorUrl: deps.solanaFacilitatorUrl,
      feePayer: deps.solanaFeePayer,
    };
    if (deps.solanaApiKey !== undefined) solDeps.apiKey = deps.solanaApiKey;
    const sol = new SolanaX402Facilitator(solDeps);
    m.set(sol.id, sol);
  }

  return m;
}

/**
 * Default network for a given env. Retained for callers that need a single
 * Network value (e.g. legacy tests). Multi-rail tenants should not use this.
 */
export function networkForEnv(env: "dev" | "staging" | "production"): Network {
  return env === "production" ? "base-mainnet" : "base-sepolia";
}
