// test/unit/facilitators/coinbase-x402.test.ts
import { describe, it, expect, vi } from "vitest";
import { CoinbaseX402Facilitator } from "@/facilitators/coinbase-x402";

const REQS = {
  amount_usdc: "0.005",
  recipient: "0xabc123",
  resource: "https://blog.example.com/articles/foo",
  network: "base-sepolia" as const,
};

describe("CoinbaseX402Facilitator.build402", () => {
  it("returns a 402 response with required x402 headers", () => {
    const fac = new CoinbaseX402Facilitator({ network: "base-sepolia" });
    const res = fac.build402(REQS);
    expect(res.status).toBe(402);
    expect(res.headers.get("WWW-Authenticate")).toMatch(/x402/i);
    // The x402 spec puts payment requirements in a JSON body; verify the body parses
    // and contains the recipient and amount.
    return res.json().then((body: any) => {
      expect(JSON.stringify(body)).toContain("0xabc123");
      expect(JSON.stringify(body)).toContain("0.005");
    });
  });

  it("includes an error reason when one is supplied", async () => {
    const fac = new CoinbaseX402Facilitator({ network: "base-sepolia" });
    const res = fac.build402(REQS, "invalid_amount");
    const body = (await res.json()) as Record<string, unknown>;
    expect(JSON.stringify(body)).toContain("invalid_amount");
  });
});

describe("CoinbaseX402Facilitator.verify", () => {
  it("returns valid: true with a settlement_handle on a successful verify", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ isValid: true, payer: "0xpayer" }), { status: 200 }),
    );
    const fac = new CoinbaseX402Facilitator({
      network: "base-sepolia",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const req = new Request("https://blog.example.com/foo", {
      headers: { "x-payment": "base64-of-payment-payload" },
    });
    const r = await fac.verify(req, REQS);
    expect(r.valid).toBe(true);
    expect(r.payer).toBe("0xpayer");
    expect(r.settlement_handle).toBeDefined();
  });

  it("returns valid: false with a reason when facilitator rejects", async () => {
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
    const req = new Request("https://blog.example.com/foo", { headers: { "x-payment": "base64" } });
    const r = await fac.verify(req, REQS);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("invalid_amount");
  });

  it("throws on non-2xx HTTP from the facilitator (treat as unreachable)", async () => {
    const fetchImpl = vi.fn(async () => new Response("error", { status: 500 }));
    const fac = new CoinbaseX402Facilitator({
      network: "base-sepolia",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const req = new Request("https://blog.example.com/foo", { headers: { "x-payment": "base64" } });
    await expect(fac.verify(req, REQS)).rejects.toThrow();
  });

  it("returns valid: false when X-PAYMENT header is missing (without calling facilitator)", async () => {
    const fetchImpl = vi.fn();
    const fac = new CoinbaseX402Facilitator({
      network: "base-sepolia",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const req = new Request("https://blog.example.com/foo");
    const r = await fac.verify(req, REQS);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("no_payment_header");
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
    const r = await fac.settle({ valid: true, settlement_handle: "abc" });
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
    const r = await fac.settle({ valid: true, settlement_handle: "abc" });
    expect(r.success).toBe(false);
    expect(r.reason).toBe("insufficient_funds");
  });

  it("throws on a verify result with no settlement_handle (programmer error)", async () => {
    const fac = new CoinbaseX402Facilitator({ network: "base-sepolia" });
    await expect(fac.settle({ valid: true })).rejects.toThrow();
  });
});
