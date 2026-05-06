// test/unit/facilitators/coinbase-x402.test.ts
import { describe, it, expect, vi } from "vitest";
import { CoinbaseX402Facilitator } from "@/facilitators/coinbase-x402";
import type { PaymentRequirements } from "@/facilitators/types";

const REQS: PaymentRequirements = {
  amount_usdc: "0.005",
  recipient: "0xabc123",
  resource: "https://blog.example.com/articles/foo",
  network: "base-sepolia",
};

/** Builds a valid base64-encoded JSON PaymentPayload for the X-PAYMENT header. */
function makeXPayment(overrides: Record<string, unknown> = {}): string {
  const payload = {
    x402Version: 2,
    resource: { url: REQS.resource, description: "", mimeType: "application/json" },
    accepted: { scheme: "exact", network: "eip155:84532", amount: "5000", payTo: REQS.recipient },
    payload: {
      signature: "0xsig",
      authorization: { from: "0xfrom", to: REQS.recipient, value: "5000" },
    },
    ...overrides,
  };
  return btoa(JSON.stringify(payload));
}

describe("CoinbaseX402Facilitator.build402", () => {
  it("returns a 402 response with x402 v2 envelope", async () => {
    const fac = new CoinbaseX402Facilitator({ network: "base-sepolia" });
    const res = fac.build402(REQS);
    expect(res.status).toBe(402);
    expect(res.headers.get("WWW-Authenticate")).toMatch(/x402/i);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.x402Version).toBe(2);
    const accepts = body.accepts as Array<Record<string, unknown>>;
    expect(accepts[0]?.network).toBe("eip155:84532"); // wire identifier, not friendly name
    expect(accepts[0]?.amount).toBe("5000"); // micro-USDC: 0.005 * 10^6
    expect(accepts[0]?.payTo).toBe("0xabc123");
    expect(accepts[0]?.asset).toMatch(/^0x[0-9a-fA-F]{40}$/); // USDC contract address
  });

  it("translates base-mainnet network to eip155:8453 with mainnet USDC contract", async () => {
    const fac = new CoinbaseX402Facilitator({ network: "base-mainnet" });
    const res = fac.build402({ ...REQS, network: "base-mainnet" });
    const body = (await res.json()) as Record<string, unknown>;
    const accepts = body.accepts as Array<Record<string, unknown>>;
    expect(accepts[0]?.network).toBe("eip155:8453");
    expect(accepts[0]?.asset).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });

  it("includes an error field at the top level when one is supplied", async () => {
    const fac = new CoinbaseX402Facilitator({ network: "base-sepolia" });
    const res = fac.build402(REQS, "invalid_amount");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_amount");
  });
});

describe("CoinbaseX402Facilitator.verify", () => {
  it("returns valid: true with a settlement_handle on successful verify", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ isValid: true, payer: "0xpayer" }), { status: 200 }),
    );
    const fac = new CoinbaseX402Facilitator({
      network: "base-sepolia",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const req = new Request("https://blog.example.com/foo", {
      headers: { "x-payment": makeXPayment() },
    });
    const r = await fac.verify(req, REQS);
    expect(r.valid).toBe(true);
    expect(r.payer).toBe("0xpayer");
    expect(r.settlement_handle).toBeDefined();
  });

  it("sends x402 v2 wire format to /verify (paymentPayload object, paymentRequirements)", async () => {
    let capturedBody: any;
    const fetchImpl = vi.fn(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ isValid: true }), { status: 200 });
    });
    const fac = new CoinbaseX402Facilitator({
      network: "base-sepolia",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await fac.verify(
      new Request("https://blog.example.com/foo", { headers: { "x-payment": makeXPayment() } }),
      REQS,
    );
    expect(capturedBody.x402Version).toBe(2);
    expect(typeof capturedBody.paymentPayload).toBe("object");
    expect(capturedBody.paymentRequirements.network).toBe("eip155:84532");
    expect(capturedBody.paymentRequirements.amount).toBe("5000");
  });

  it("returns valid: false with reason when facilitator rejects", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ isValid: false, invalidReason: "invalid_amount" }), {
          status: 200,
        }),
    );
    const fac = new CoinbaseX402Facilitator({
      network: "base-sepolia",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const req = new Request("https://blog.example.com/foo", {
      headers: { "x-payment": makeXPayment() },
    });
    const r = await fac.verify(req, REQS);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("invalid_amount");
  });

  it("throws on non-2xx HTTP from the facilitator", async () => {
    const fetchImpl = vi.fn(async () => new Response("error", { status: 500 }));
    const fac = new CoinbaseX402Facilitator({
      network: "base-sepolia",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const req = new Request("https://blog.example.com/foo", {
      headers: { "x-payment": makeXPayment() },
    });
    await expect(fac.verify(req, REQS)).rejects.toThrow();
  });

  it("returns valid: false when X-PAYMENT is missing (no facilitator call)", async () => {
    const fetchImpl = vi.fn();
    const fac = new CoinbaseX402Facilitator({
      network: "base-sepolia",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const r = await fac.verify(new Request("https://blog.example.com/foo"), REQS);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("no_payment_header");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns valid: false when X-PAYMENT is malformed base64/JSON", async () => {
    const fetchImpl = vi.fn();
    const fac = new CoinbaseX402Facilitator({
      network: "base-sepolia",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const req = new Request("https://blog.example.com/foo", {
      headers: { "x-payment": "not-valid-base64-json!!!" },
    });
    const r = await fac.verify(req, REQS);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("malformed_payment_header");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("CoinbaseX402Facilitator.settle", () => {
  it("returns success with tx_reference on a successful settle", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ success: true, transaction: "0xdeadbeef", network: "base-sepolia" }),
          { status: 200 },
        ),
    );
    const fac = new CoinbaseX402Facilitator({
      network: "base-sepolia",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const r = await fac.settle({
      valid: true,
      settlement_handle: { paymentPayload: { x402Version: 2 }, requirements: REQS },
    });
    expect(r.success).toBe(true);
    expect(r.tx_reference).toBe("0xdeadbeef");
  });

  it("returns success: false with reason when facilitator settle fails", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: false, errorReason: "insufficient_funds" }), {
          status: 200,
        }),
    );
    const fac = new CoinbaseX402Facilitator({
      network: "base-sepolia",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const r = await fac.settle({
      valid: true,
      settlement_handle: { paymentPayload: {}, requirements: REQS },
    });
    expect(r.success).toBe(false);
    expect(r.reason).toBe("insufficient_funds");
  });

  it("throws when verify result has no settlement_handle", async () => {
    const fac = new CoinbaseX402Facilitator({ network: "base-sepolia" });
    await expect(fac.settle({ valid: true })).rejects.toThrow();
  });
});
