// test/unit/facilitators/solana-x402.test.ts
import { describe, it, expect, vi } from "vitest";
import { SolanaX402Facilitator } from "@/facilitators/solana-x402";
import type { PaymentRequirements } from "@/facilitators/types";

const REQS: PaymentRequirements = {
  amount_usdc: "0.005",
  recipient: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4", // base58 Solana pubkey
  resource: "https://blog.example.com/articles/foo",
  network: "solana-devnet",
};

const baseDeps = {
  network: "solana-devnet" as const,
  facilitatorUrl: "https://facilitator.example.test",
  feePayer: "EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd",
};

/** Builds a valid base64-encoded JSON PaymentPayload for a Solana X-PAYMENT header. */
function makeXPayment(overrides: Record<string, unknown> = {}): string {
  const payload = {
    x402Version: 2,
    resource: { url: REQS.resource, description: "", mimeType: "application/json" },
    accepted: {
      scheme: "exact",
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1O2pu1cLs6Cs",
      amount: "5000",
      payTo: REQS.recipient,
    },
    payload: { transaction: "AAAAAAAAAAAAA==" /* fake serialized partially-signed tx */ },
    ...overrides,
  };
  return btoa(JSON.stringify(payload));
}

describe("SolanaX402Facilitator.build402", () => {
  it("returns a 402 with x402 v2 envelope using solana network identifier", async () => {
    const fac = new SolanaX402Facilitator(baseDeps);
    const res = fac.build402(REQS);
    expect(res.status).toBe(402);
    expect(res.headers.get("WWW-Authenticate")).toMatch(/x402/i);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.x402Version).toBe(2);
    const accepts = body.accepts as Array<Record<string, unknown>>;
    expect(accepts[0]?.network).toBe("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1O2pu1cLs6Cs");
    expect(accepts[0]?.amount).toBe("5000"); // micro-USDC
    expect(accepts[0]?.asset).toBe("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"); // devnet USDC mint
    expect((accepts[0]?.extra as Record<string, unknown>).feePayer).toBe(baseDeps.feePayer);
  });

  it("uses mainnet USDC mint and genesis hash for solana-mainnet", async () => {
    const fac = new SolanaX402Facilitator({ ...baseDeps, network: "solana-mainnet" });
    const res = fac.build402({ ...REQS, network: "solana-mainnet" });
    const body = (await res.json()) as Record<string, unknown>;
    const accepts = body.accepts as Array<Record<string, unknown>>;
    expect(accepts[0]?.network).toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
    expect(accepts[0]?.asset).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  });

  it("includes top-level error field when supplied", async () => {
    const fac = new SolanaX402Facilitator(baseDeps);
    const res = fac.build402(REQS, "amount_mismatch");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("amount_mismatch");
  });

  it("has id 'x402-solana-devnet' for devnet config", () => {
    const fac = new SolanaX402Facilitator(baseDeps);
    expect(fac.id).toBe("x402-solana-devnet");
  });

  it("has id 'x402-solana-mainnet' for mainnet config", () => {
    const fac = new SolanaX402Facilitator({ ...baseDeps, network: "solana-mainnet" });
    expect(fac.id).toBe("x402-solana-mainnet");
  });
});

describe("SolanaX402Facilitator.verify", () => {
  it("returns valid: true on successful verify", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ isValid: true, payer: "8Pkst9Bp..." }), { status: 200 }),
    );
    const fac = new SolanaX402Facilitator({
      ...baseDeps,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const req = new Request("https://blog.example.com/foo", {
      headers: { "x-payment": makeXPayment() },
    });
    const r = await fac.verify(req, REQS);
    expect(r.valid).toBe(true);
    expect(r.payer).toBe("8Pkst9Bp...");
    expect(r.settlement_handle).toBeDefined();
  });

  it("posts to the configured facilitator URL with v2 wire format", async () => {
    let capturedUrl = "";
    let capturedBody: any;
    const fetchImpl = vi.fn(async (url, init) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ isValid: true }), { status: 200 });
    });
    const fac = new SolanaX402Facilitator({
      ...baseDeps,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await fac.verify(
      new Request("https://blog.example.com/foo", { headers: { "x-payment": makeXPayment() } }),
      REQS,
    );
    expect(capturedUrl).toBe("https://facilitator.example.test/verify");
    expect(capturedBody.x402Version).toBe(2);
    expect(typeof capturedBody.paymentPayload).toBe("object");
    expect(capturedBody.paymentRequirements.network).toBe(
      "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1O2pu1cLs6Cs",
    );
    expect(capturedBody.paymentRequirements.extra.feePayer).toBe(baseDeps.feePayer);
  });

  it("returns valid: false on rejection with the facilitator's reason", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ isValid: false, invalidReason: "duplicate_settlement" }), {
          status: 200,
        }),
    );
    const fac = new SolanaX402Facilitator({
      ...baseDeps,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const r = await fac.verify(
      new Request("https://blog.example.com/foo", { headers: { "x-payment": makeXPayment() } }),
      REQS,
    );
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("duplicate_settlement");
  });

  it("throws on non-2xx HTTP from facilitator", async () => {
    const fetchImpl = vi.fn(async () => new Response("oops", { status: 502 }));
    const fac = new SolanaX402Facilitator({
      ...baseDeps,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      fac.verify(
        new Request("https://blog.example.com/foo", { headers: { "x-payment": makeXPayment() } }),
        REQS,
      ),
    ).rejects.toThrow();
  });

  it("returns no_payment_header when X-PAYMENT is absent", async () => {
    const fetchImpl = vi.fn();
    const fac = new SolanaX402Facilitator({
      ...baseDeps,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const r = await fac.verify(new Request("https://blog.example.com/foo"), REQS);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("no_payment_header");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("SolanaX402Facilitator.settle", () => {
  it("returns tx_reference on success", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ success: true, transaction: "5h7Ts...solana_signature_base58" }),
          { status: 200 },
        ),
    );
    const fac = new SolanaX402Facilitator({
      ...baseDeps,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const r = await fac.settle({
      valid: true,
      settlement_handle: { paymentPayload: { x402Version: 2 }, requirements: REQS },
    });
    expect(r.success).toBe(true);
    expect(r.tx_reference).toBe("5h7Ts...solana_signature_base58");
  });

  it("returns failure with the facilitator's errorReason", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: false, errorReason: "blockhash_expired" }), {
          status: 200,
        }),
    );
    const fac = new SolanaX402Facilitator({
      ...baseDeps,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const r = await fac.settle({
      valid: true,
      settlement_handle: { paymentPayload: {}, requirements: REQS },
    });
    expect(r.success).toBe(false);
    expect(r.reason).toBe("blockhash_expired");
  });

  it("throws when settlement_handle is missing", async () => {
    const fac = new SolanaX402Facilitator(baseDeps);
    await expect(fac.settle({ valid: true })).rejects.toThrow();
  });
});
