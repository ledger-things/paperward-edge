// test/e2e/sepolia-payment.ts
//
// Build an X-PAYMENT header value for the x402 protocol v2, paying USDC on
// Base Sepolia. v2 wire format: amount is micro-USDC integer string, network
// is `eip155:<chainId>`, asset is the USDC contract address. The agent signs
// EIP-712 transferWithAuthorization (EIP-3009) and the facilitator broadcasts.
//
// The X-PAYMENT header is base64(JSON(paymentPayload)) where paymentPayload
// has the shape `{ x402Version, scheme, network, payload: { signature, authorization } }`.

import { privateKeyToAccount } from "viem/accounts";
import { signTypedData } from "viem/actions";
import { createWalletClient, http } from "viem";
import { baseSepolia } from "viem/chains";

/**
 * Shape of one entry in the 402 response's `accepts[]` array (x402 v2).
 * Matches what CoinbaseX402Facilitator.buildAcceptsEntry returns.
 */
type X402AcceptsEntry = {
  scheme: string;
  network: string; // e.g. "eip155:84532"
  amount: string; // micro-USDC integer string, e.g. "1000" = 0.001 USDC
  asset: string; // ERC-20 contract address
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string };
};

export async function makeSepoliaPayment(
  reqs: X402AcceptsEntry,
  privateKeyHex: string,
): Promise<string> {
  const account = privateKeyToAccount(privateKeyHex as `0x${string}`);
  const client = createWalletClient({ chain: baseSepolia, transport: http(), account });

  const validAfter = 0n;
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const nonce =
    `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}` as `0x${string}`;
  // v2 amount is already an integer string in the asset's smallest unit (micro-USDC).
  const amountWei = BigInt(reqs.amount);

  const domain = {
    name: reqs.extra?.name ?? "USD Coin",
    version: reqs.extra?.version ?? "2",
    chainId: baseSepolia.id,
    verifyingContract: reqs.asset as `0x${string}`,
  };
  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  };
  const message = {
    from: account.address,
    to: reqs.payTo as `0x${string}`,
    value: amountWei,
    validAfter,
    validBefore,
    nonce,
  };

  const signature = await signTypedData(client, {
    account,
    domain,
    types,
    primaryType: "TransferWithAuthorization",
    message,
  });

  const payload = {
    x402Version: 2,
    scheme: "exact",
    // The agent echoes back the chosen accepts[] entry under `accepted` —
    // this is how the multi-rail paywall middleware (paywall.ts) selects
    // which facilitator to dispatch to via accepted.network.
    accepted: reqs,
    payload: {
      signature,
      authorization: {
        ...message,
        value: message.value.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
      },
    },
  };

  return Buffer.from(JSON.stringify(payload)).toString("base64");
}
