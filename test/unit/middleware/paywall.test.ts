// test/unit/middleware/paywall.test.ts
import { describe, it, expect, vi } from "vitest";
import { buildPaywallMiddleware } from "@/middleware/paywall";
import { runMiddleware } from "../../mocks/hono-context";
import type { TenantConfig } from "@/config/types";
import type {
  Facilitator,
  VerifyResult,
  SettleResult,
  PaymentRequirements,
} from "@/facilitators/types";

const t: TenantConfig = {
  schema_version: 1,
  tenant_id: "t1",
  hostname: "blog.example.com",
  origin: "https://o",
  status: "active",
  default_action: "allow",
  accepted_facilitators: [{ facilitator_id: "coinbase-x402-base", payout_address: "0xabc" }],
  pricing_rules: [],
  config_version: 1,
  created_at: "x",
  updated_at: "x",
};

type FacWithAccepts = Facilitator & {
  buildAcceptsEntry: (r: PaymentRequirements) => Record<string, unknown>;
};

function fac(opts: {
  verify?: VerifyResult | (() => Promise<VerifyResult>);
  verifyThrows?: Error;
  settle?: SettleResult;
  settleThrows?: Error;
}): FacWithAccepts {
  return {
    id: "coinbase-x402-base",
    supportedNetworks: ["base-sepolia"] as const,
    build402: (req: PaymentRequirements, error?: string) =>
      new Response(
        JSON.stringify({ accepts: [{ resource: req.resource, payTo: req.recipient, error }] }),
        {
          status: 402,
          headers: { "WWW-Authenticate": "x402", "content-type": "application/json" },
        },
      ),
    buildAcceptsEntry: (r: PaymentRequirements) => ({
      scheme: "exact",
      network: r.network,
      payTo: r.recipient,
    }),
    verify: vi.fn(async () => {
      if (opts.verifyThrows) throw opts.verifyThrows;
      if (typeof opts.verify === "function") return opts.verify();
      return opts.verify ?? { valid: false, reason: "no_payment_header" };
    }),
    settle: vi.fn(async () => {
      if (opts.settleThrows) throw opts.settleThrows;
      return opts.settle ?? { success: true, tx_reference: "0xtx" };
    }),
  };
}

/** Build a valid base64-encoded JSON X-PAYMENT for base-sepolia. */
function xPaymentForBaseSepolia(): string {
  const payload = {
    x402Version: 2,
    accepted: { network: "eip155:84532", scheme: "exact" },
    payload: { signature: "0xsig" },
  };
  return btoa(JSON.stringify(payload));
}

const initialChargeState = {
  decision: "charge_no_payment" as const,
  decision_reason: null,
  rule_id: "r1",
  price_usdc: "0.005",
  paid: false,
  payment_tx: null,
};

describe("paywall (active mode)", () => {
  it("returns 402 when no X-PAYMENT header is present", async () => {
    const f = fac({});
    const mw = buildPaywallMiddleware(() => new Map([[f.id, f]]));
    const { response, vars } = await runMiddleware(
      mw,
      new Request("https://blog.example.com/x"),
      {},
      {
        tenant: t,
        decision_state: initialChargeState,
      },
    );
    expect(response.status).toBe(402);
    expect(vars.decision_state?.decision).toBe("charge_no_payment");
  });

  it("returns 402 with verify_failed when verify rejects", async () => {
    const f = fac({ verify: { valid: false, reason: "invalid_amount" } });
    const mw = buildPaywallMiddleware(() => new Map([[f.id, f]]));
    const { response, vars } = await runMiddleware(
      mw,
      new Request("https://blog.example.com/x", {
        headers: { "x-payment": xPaymentForBaseSepolia() },
      }),
      {},
      {
        tenant: t,
        decision_state: initialChargeState,
      },
    );
    expect(response.status).toBe(402);
    expect(vars.decision_state?.decision).toBe("charge_verify_failed");
    expect(vars.decision_state?.decision_reason).toBe("invalid_amount");
  });

  it("returns 503 when verify throws (facilitator unreachable)", async () => {
    const f = fac({ verifyThrows: new Error("net err") });
    const mw = buildPaywallMiddleware(() => new Map([[f.id, f]]));
    const { response, vars } = await runMiddleware(
      mw,
      new Request("https://blog.example.com/x", {
        headers: { "x-payment": xPaymentForBaseSepolia() },
      }),
      {},
      {
        tenant: t,
        decision_state: initialChargeState,
      },
    );
    expect(response.status).toBe(503);
    expect(vars.decision_state?.decision).toBe("charge_verify_failed");
    expect(vars.decision_state?.decision_reason).toBe("facilitator_unavailable");
  });

  it("calls settle and sets charge_paid on success after origin 2xx", async () => {
    // The originForwarder is faked: the test app's default handler returns 200.
    const f = fac({
      verify: { valid: true, settlement_handle: "h" },
      settle: { success: true, tx_reference: "0xtx" },
    });
    const mw = buildPaywallMiddleware(() => new Map([[f.id, f]]));
    const { response, vars } = await runMiddleware(
      mw,
      new Request("https://blog.example.com/x", {
        headers: { "x-payment": xPaymentForBaseSepolia() },
      }),
      {},
      {
        tenant: t,
        decision_state: initialChargeState,
        origin_status: 200, // simulate originForwarder having set this
      },
    );
    expect(response.status).toBe(200);
    expect(vars.decision_state?.decision).toBe("charge_paid");
    expect(vars.decision_state?.paid).toBe(true);
    expect(vars.decision_state?.payment_tx).toBe("0xtx");
    expect(response.headers.get("X-PAYMENT-RESPONSE")).toBeTruthy();
  });

  it("sets charge_unsettled when settle returns failure after origin 2xx", async () => {
    const f = fac({
      verify: { valid: true, settlement_handle: "h" },
      settle: { success: false, reason: "settle_failed" },
    });
    const mw = buildPaywallMiddleware(() => new Map([[f.id, f]]));
    const { vars } = await runMiddleware(
      mw,
      new Request("https://blog.example.com/x", {
        headers: { "x-payment": xPaymentForBaseSepolia() },
      }),
      {},
      {
        tenant: t,
        decision_state: initialChargeState,
        origin_status: 200,
      },
    );
    expect(vars.decision_state?.decision).toBe("charge_unsettled");
    expect(vars.decision_state?.paid).toBe(false);
  });

  it("does NOT call settle when origin returned non-2xx (charge_origin_failed left as-is)", async () => {
    const f = fac({
      verify: { valid: true, settlement_handle: "h" },
      settle: { success: true, tx_reference: "0xtx" },
    });
    const mw = buildPaywallMiddleware(() => new Map([[f.id, f]]));
    await runMiddleware(
      mw,
      new Request("https://blog.example.com/x", {
        headers: { "x-payment": xPaymentForBaseSepolia() },
      }),
      {},
      {
        tenant: t,
        decision_state: {
          ...initialChargeState,
          decision: "charge_origin_failed",
          decision_reason: "origin_500",
        },
        origin_status: 500,
      },
    );
    expect((f.settle as any).mock.calls.length).toBe(0);
  });
});

describe("paywall (log_only mode)", () => {
  const tlog = { ...t, status: "log_only" as const };
  const initial = {
    decision: "would_charge_no_payment" as const,
    decision_reason: null,
    rule_id: "r1",
    price_usdc: "0.01",
    paid: false,
    payment_tx: null,
  };

  it("never returns 402, even with no X-PAYMENT", async () => {
    const f = fac({});
    const mw = buildPaywallMiddleware(() => new Map([[f.id, f]]));
    const { response, vars } = await runMiddleware(
      mw,
      new Request("https://blog.example.com/x"),
      {},
      {
        tenant: tlog,
        decision_state: initial,
      },
    );
    expect(response.status).toBe(200);
    expect(vars.decision_state?.decision).toBe("would_charge_no_payment");
  });

  it("calls verify read-only and records would_charge_paid on valid", async () => {
    const f = fac({
      verify: { valid: true, settlement_handle: "h" },
      settle: { success: true, tx_reference: "0xtx" },
    });
    const mw = buildPaywallMiddleware(() => new Map([[f.id, f]]));
    const { vars } = await runMiddleware(
      mw,
      new Request("https://blog.example.com/x", {
        headers: { "x-payment": xPaymentForBaseSepolia() },
      }),
      {},
      {
        tenant: tlog,
        decision_state: initial,
      },
    );
    expect(vars.decision_state?.decision).toBe("would_charge_paid");
    expect((f.settle as any).mock.calls.length).toBe(0); // never settle in log_only
  });

  it("records would_charge_verify_failed on invalid verify", async () => {
    const f = fac({ verify: { valid: false, reason: "expired" } });
    const mw = buildPaywallMiddleware(() => new Map([[f.id, f]]));
    const { vars } = await runMiddleware(
      mw,
      new Request("https://blog.example.com/x", {
        headers: { "x-payment": xPaymentForBaseSepolia() },
      }),
      {},
      {
        tenant: tlog,
        decision_state: initial,
      },
    );
    expect(vars.decision_state?.decision).toBe("would_charge_verify_failed");
    expect(vars.decision_state?.decision_reason).toBe("expired");
  });
});
