// test/e2e/sepolia-payment.ts
//
// Build an X-PAYMENT header value for the x402 protocol, paying USDC on Base
// Sepolia. The exact payload shape depends on the x402 spec revision pinned
// in package.json — read the x402-hono README and adapt the body of this
// file to whatever shape the verifier expects.
//
// At minimum, x402 v1 payments are EIP-712 typed data signing the transfer
// authorization for the recipient + amount. The payload is base64url-encoded
// JSON containing the signed authorization.

import { privateKeyToAccount } from "viem/accounts";
import { signTypedData } from "viem/actions";
import { createWalletClient, http } from "viem";
import { baseSepolia } from "viem/chains";

type X402Requirements = {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  payTo: string;
  resource: string;
  asset: string;
};

export async function makeSepoliaPayment(
  reqs: X402Requirements,
  privateKeyHex: string,
): Promise<string> {
  const account = privateKeyToAccount(privateKeyHex as `0x${string}`);
  const client = createWalletClient({ chain: baseSepolia, transport: http(), account });

  // x402 EIP-712 transferWithAuthorization typed data. Field names match the
  // EIP-3009 USDC standard. If the x402 spec revisions change the type names
  // or domain, update here.
  const validAfter = 0n;
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const nonce =
    `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}` as `0x${string}`;
  const amountWei = BigInt(Math.floor(parseFloat(reqs.maxAmountRequired) * 1_000_000)); // USDC has 6 decimals

  const domain = {
    name: "USD Coin",
    version: "2",
    chainId: baseSepolia.id,
    verifyingContract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as `0x${string}`, // USDC Sepolia
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
    x402Version: 1,
    scheme: "exact",
    network: reqs.network,
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
