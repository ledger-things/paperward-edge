// src/facilitators/registry.ts

import type { Facilitator, Network } from "@/facilitators/types";
import { CoinbaseX402Facilitator } from "@/facilitators/coinbase-x402";

export type FacilitatorRegistryDeps = {
  network: Network;
  coinbaseApiKey?: string;
};

export function buildFacilitatorRegistry(deps: FacilitatorRegistryDeps): Map<string, Facilitator> {
  const m = new Map<string, Facilitator>();
  const coinbaseDeps = deps.coinbaseApiKey !== undefined
    ? { network: deps.network, apiKey: deps.coinbaseApiKey }
    : { network: deps.network };
  m.set("coinbase-x402-base", new CoinbaseX402Facilitator(coinbaseDeps));
  return m;
}

export function networkForEnv(env: "dev" | "staging" | "production"): Network {
  return env === "production" ? "base-mainnet" : "base-sepolia";
}
