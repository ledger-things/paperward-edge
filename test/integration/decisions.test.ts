// test/integration/decisions.test.ts
//
// Full-pipeline integration tests. Each test exercises one Decision enum value
// through worker.fetch(request, env, ctx), asserts the HTTP response, and
// asserts the LogEntry decision field written to R2.
//
// Mocking strategy:
// - KV/R2 bindings are real Miniflare in-memory bindings (from vitest.config.ts).
// - WBA directory fetches and origin calls are intercepted via vi.spyOn(globalThis, "fetch").
// - The CoinbaseX402Facilitator also uses globalThis.fetch for verify/settle calls.
//
// Isolation strategy:
// - Every test uses a unique hostname to avoid the module-scoped TenantConfigCache
//   poisoning subsequent tests. The _resetTenantCache() export from tenantResolver
//   is called in beforeEach as belt-and-suspenders.
// - R2 objects are cleared before each test.
// - vi.spyOn is restored after each test in afterEach.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "@/index";
import { seedTenant, readLogs, makeTenant } from "./_helpers";
import { _resetTenantCache } from "@/middleware/tenantResolver";
import { signRequest } from "../fixtures/wba/sign";
import { FIXTURE_DIRECTORY } from "../fixtures/wba/directory";
import { FIXTURE_KEYS } from "../fixtures/wba/keys";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Human-shaped request (browser UA + Accept-Language). */
function humanRequest(url: string, extraHeaders?: Record<string, string>): Request {
  return new Request(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "accept-language": "en-US,en;q=0.9",
      ...extraHeaders,
    },
  });
}

/** Signed agent request via WBA fixture keypair. */
async function agentRequest(
  url: string,
  extraHeaders?: Record<string, string>,
): Promise<Request> {
  return signRequest({ url, additionalHeaders: extraHeaders });
}

/** Standard fetch spy that handles facilitator + WBA directory + origin calls. */
function makePaymentFetchSpy(opts: {
  verifyValid?: boolean;
  verifyReason?: string;
  settleSuccess?: boolean;
  settleReason?: string;
  originStatus?: number;
  originBody?: string;
} = {}) {
  const {
    verifyValid = true,
    verifyReason,
    settleSuccess = true,
    settleReason,
    originStatus = 200,
    originBody = "origin content",
  } = opts;

  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(typeof input === "string" ? input : (input as Request).url);

    // WBA key directory
    if (url.includes("/.well-known/http-message-signatures-directory")) {
      return new Response(JSON.stringify(FIXTURE_DIRECTORY), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // Facilitator verify
    if (url.startsWith("https://x402.org/facilitator/verify")) {
      if (verifyValid) {
        return new Response(
          JSON.stringify({ isValid: true, payer: "0xpayer" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ isValid: false, invalidReason: verifyReason ?? "amount_mismatch" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    // Facilitator settle
    if (url.startsWith("https://x402.org/facilitator/settle")) {
      if (settleSuccess) {
        return new Response(
          JSON.stringify({ success: true, transaction: "0xtxhash" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ success: false, errorReason: settleReason ?? "settle_rejected" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    // Origin fallthrough
    return new Response(originBody, { status: originStatus });
  });
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  _resetTenantCache();
  const list = await (env.R2_LOGS as R2Bucket).list();
  for (const o of list.objects) {
    await (env.R2_LOGS as R2Bucket).delete(o.key);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. allow — pricing rule with action=allow + human agent
// ---------------------------------------------------------------------------
describe("Decision: allow", () => {
  it("forwards to origin and logs decision=allow when rule action=allow matches human", async () => {
    await seedTenant(makeTenant({
      hostname: "allow.test.example.com",
      origin: "https://origin.allow.test.example.com",
      pricing_rules: [{
        id: "r-allow", priority: 1,
        path_pattern: "*", agent_pattern: "*",
        action: "allow", enabled: true,
      }],
    }));

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("origin says hi", { status: 200 }),
    );

    const ctx = createExecutionContext();
    const r = await worker.fetch(
      humanRequest("https://allow.test.example.com/foo"),
      env as any,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(r.status).toBe(200);
    expect(await r.text()).toBe("origin says hi");
    fetchSpy.mockRestore();

    const logs = await readLogs();
    expect(logs.some(l => l.decision === "allow")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. block — pricing rule with action=block
// ---------------------------------------------------------------------------
describe("Decision: block", () => {
  it("returns 403 and logs decision=block when rule action=block", async () => {
    await seedTenant(makeTenant({
      hostname: "block.test.example.com",
      origin: "https://origin.block.test.example.com",
      pricing_rules: [{
        id: "r-block", priority: 1,
        path_pattern: "*", agent_pattern: "*",
        action: "block", enabled: true,
      }],
    }));

    const ctx = createExecutionContext();
    const r = await worker.fetch(
      humanRequest("https://block.test.example.com/foo"),
      env as any,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(r.status).toBe(403);

    const logs = await readLogs();
    expect(logs.some(l => l.decision === "block")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. charge_paid — charge rule + valid X-PAYMENT + verify ok + settle ok
// ---------------------------------------------------------------------------
describe("Decision: charge_paid", () => {
  it("returns 200 with X-PAYMENT-RESPONSE and logs decision=charge_paid", async () => {
    await seedTenant(makeTenant({
      hostname: "charge-paid.test.example.com",
      origin: "https://origin.charge-paid.test.example.com",
      pricing_rules: [{
        id: "r-charge", priority: 1,
        path_pattern: "*", agent_pattern: "*",
        action: "charge", price_usdc: "0.01", enabled: true,
      }],
    }));

    const fetchSpy = makePaymentFetchSpy({ verifyValid: true, settleSuccess: true });

    const req = await agentRequest("https://charge-paid.test.example.com/foo", {
      "x-payment": "mock-payment-header",
    });

    const ctx = createExecutionContext();
    const r = await worker.fetch(req, env as any, ctx);
    await waitOnExecutionContext(ctx);

    fetchSpy.mockRestore();

    expect(r.status).toBe(200);
    expect(r.headers.get("x-payment-response")).not.toBeNull();

    const logs = await readLogs();
    expect(logs.some(l => l.decision === "charge_paid")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. charge_no_payment — charge rule + no X-PAYMENT
// ---------------------------------------------------------------------------
describe("Decision: charge_no_payment", () => {
  it("returns 402 with no X-PAYMENT and logs decision=charge_no_payment", async () => {
    await seedTenant(makeTenant({
      hostname: "charge-nopay.test.example.com",
      origin: "https://origin.charge-nopay.test.example.com",
      pricing_rules: [{
        id: "r-charge", priority: 1,
        path_pattern: "*", agent_pattern: "*",
        action: "charge", price_usdc: "0.01", enabled: true,
      }],
    }));

    const ctx = createExecutionContext();
    const r = await worker.fetch(
      new Request("https://charge-nopay.test.example.com/foo"),
      env as any,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(r.status).toBe(402);

    const logs = await readLogs();
    expect(logs.some(l => l.decision === "charge_no_payment")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. charge_verify_failed — charge rule + X-PAYMENT but verify rejects
// ---------------------------------------------------------------------------
describe("Decision: charge_verify_failed", () => {
  it("returns 402 with invalid reason and logs decision=charge_verify_failed", async () => {
    await seedTenant(makeTenant({
      hostname: "charge-verifyfail.test.example.com",
      origin: "https://origin.charge-verifyfail.test.example.com",
      pricing_rules: [{
        id: "r-charge", priority: 1,
        path_pattern: "*", agent_pattern: "*",
        action: "charge", price_usdc: "0.01", enabled: true,
      }],
    }));

    const fetchSpy = makePaymentFetchSpy({ verifyValid: false, verifyReason: "amount_mismatch" });

    const req = await agentRequest("https://charge-verifyfail.test.example.com/foo", {
      "x-payment": "bad-payment-header",
    });

    const ctx = createExecutionContext();
    const r = await worker.fetch(req, env as any, ctx);
    await waitOnExecutionContext(ctx);

    fetchSpy.mockRestore();

    expect(r.status).toBe(402);

    const logs = await readLogs();
    expect(logs.some(l => l.decision === "charge_verify_failed")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. charge_origin_failed — charge rule + valid X-PAYMENT + origin 5xx
// ---------------------------------------------------------------------------
describe("Decision: charge_origin_failed", () => {
  it("logs decision=charge_origin_failed when origin returns 5xx after verify ok", async () => {
    await seedTenant(makeTenant({
      hostname: "charge-originfail.test.example.com",
      origin: "https://origin.charge-originfail.test.example.com",
      pricing_rules: [{
        id: "r-charge", priority: 1,
        path_pattern: "*", agent_pattern: "*",
        action: "charge", price_usdc: "0.01", enabled: true,
      }],
    }));

    // Verify succeeds but origin returns 500
    const fetchSpy = makePaymentFetchSpy({ verifyValid: true, originStatus: 500, originBody: "server error" });

    const req = await agentRequest("https://charge-originfail.test.example.com/foo", {
      "x-payment": "mock-payment-header",
    });

    const ctx = createExecutionContext();
    const r = await worker.fetch(req, env as any, ctx);
    await waitOnExecutionContext(ctx);

    fetchSpy.mockRestore();

    // The origin response (500) is forwarded; paywall does not settle on origin failure.
    expect(r.status).toBe(500);

    const logs = await readLogs();
    expect(logs.some(l => l.decision === "charge_origin_failed")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. charge_unsettled — charge rule + valid X-PAYMENT + origin 2xx + settle fails
// ---------------------------------------------------------------------------
describe("Decision: charge_unsettled", () => {
  it("logs decision=charge_unsettled when settle returns failure after successful verify+origin", async () => {
    await seedTenant(makeTenant({
      hostname: "charge-unsettled.test.example.com",
      origin: "https://origin.charge-unsettled.test.example.com",
      pricing_rules: [{
        id: "r-charge", priority: 1,
        path_pattern: "*", agent_pattern: "*",
        action: "charge", price_usdc: "0.01", enabled: true,
      }],
    }));

    // Verify ok, origin 200, settle fails
    const fetchSpy = makePaymentFetchSpy({
      verifyValid: true,
      settleSuccess: false,
      settleReason: "network_error",
      originStatus: 200,
    });

    const req = await agentRequest("https://charge-unsettled.test.example.com/foo", {
      "x-payment": "mock-payment-header",
    });

    const ctx = createExecutionContext();
    const r = await worker.fetch(req, env as any, ctx);
    await waitOnExecutionContext(ctx);

    fetchSpy.mockRestore();

    // Response body came from origin (200), but logger captures charge_unsettled.
    // The paywall post-phase sets the decision but does not change the response
    // (it returns without setting c.res since no unsettled response override exists).
    // The origin response (200) is returned.
    expect(r.status).toBe(200);

    const logs = await readLogs();
    expect(logs.some(l => l.decision === "charge_unsettled")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. default_allow — no rules match + default_action=allow + human traffic
// ---------------------------------------------------------------------------
describe("Decision: default_allow", () => {
  it("forwards to origin and logs decision=default_allow when no rules match and default=allow", async () => {
    await seedTenant(makeTenant({
      hostname: "default-allow.test.example.com",
      origin: "https://origin.default-allow.test.example.com",
      default_action: "allow",
      pricing_rules: [], // no rules
    }));

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("default allowed", { status: 200 }),
    );

    const ctx = createExecutionContext();
    const r = await worker.fetch(
      humanRequest("https://default-allow.test.example.com/foo"),
      env as any,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    fetchSpy.mockRestore();

    expect(r.status).toBe(200);

    const logs = await readLogs();
    expect(logs.some(l => l.decision === "default_allow")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. would_allow — log_only status + allow rule
// ---------------------------------------------------------------------------
describe("Decision: would_allow", () => {
  it("forwards to origin and logs decision=would_allow for log_only tenant with allow rule", async () => {
    await seedTenant(makeTenant({
      hostname: "would-allow.test.example.com",
      origin: "https://origin.would-allow.test.example.com",
      status: "log_only",
      pricing_rules: [{
        id: "r-allow", priority: 1,
        path_pattern: "*", agent_pattern: "*",
        action: "allow", enabled: true,
      }],
    }));

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("log only allow", { status: 200 }),
    );

    const ctx = createExecutionContext();
    const r = await worker.fetch(
      humanRequest("https://would-allow.test.example.com/foo"),
      env as any,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    fetchSpy.mockRestore();

    expect(r.status).toBe(200);

    const logs = await readLogs();
    expect(logs.some(l => l.decision === "would_allow")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. would_block — log_only status + block rule
// ---------------------------------------------------------------------------
describe("Decision: would_block", () => {
  it("forwards to origin and logs decision=would_block for log_only tenant with block rule", async () => {
    await seedTenant(makeTenant({
      hostname: "would-block.test.example.com",
      origin: "https://origin.would-block.test.example.com",
      status: "log_only",
      pricing_rules: [{
        id: "r-block", priority: 1,
        path_pattern: "*", agent_pattern: "*",
        action: "block", enabled: true,
      }],
    }));

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("would have blocked", { status: 200 }),
    );

    const ctx = createExecutionContext();
    const r = await worker.fetch(
      humanRequest("https://would-block.test.example.com/foo"),
      env as any,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    fetchSpy.mockRestore();

    // In log_only mode with block rule, traffic still forwards (would_block is observational)
    expect(r.status).toBe(200);

    const logs = await readLogs();
    expect(logs.some(l => l.decision === "would_block")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 11. would_charge_no_payment — log_only status + charge rule + no X-PAYMENT
// ---------------------------------------------------------------------------
describe("Decision: would_charge_no_payment", () => {
  it("forwards to origin and logs decision=would_charge_no_payment for log_only tenant with charge rule and no payment", async () => {
    await seedTenant(makeTenant({
      hostname: "would-charge-nopay.test.example.com",
      origin: "https://origin.would-charge-nopay.test.example.com",
      status: "log_only",
      pricing_rules: [{
        id: "r-charge", priority: 1,
        path_pattern: "*", agent_pattern: "*",
        action: "charge", price_usdc: "0.01", enabled: true,
      }],
    }));

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("would have charged", { status: 200 }),
    );

    const ctx = createExecutionContext();
    const r = await worker.fetch(
      new Request("https://would-charge-nopay.test.example.com/foo"),
      env as any,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    fetchSpy.mockRestore();

    expect(r.status).toBe(200);

    const logs = await readLogs();
    expect(logs.some(l => l.decision === "would_charge_no_payment")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 12. would_charge_paid — log_only status + charge rule + valid X-PAYMENT + verify ok
// ---------------------------------------------------------------------------
describe("Decision: would_charge_paid", () => {
  it("forwards to origin and logs decision=would_charge_paid for log_only with valid X-PAYMENT", async () => {
    await seedTenant(makeTenant({
      hostname: "would-charge-paid.test.example.com",
      origin: "https://origin.would-charge-paid.test.example.com",
      status: "log_only",
      pricing_rules: [{
        id: "r-charge", priority: 1,
        path_pattern: "*", agent_pattern: "*",
        action: "charge", price_usdc: "0.01", enabled: true,
      }],
    }));

    const fetchSpy = makePaymentFetchSpy({ verifyValid: true, originStatus: 200 });

    const req = await agentRequest("https://would-charge-paid.test.example.com/foo", {
      "x-payment": "mock-payment-header",
    });

    const ctx = createExecutionContext();
    const r = await worker.fetch(req, env as any, ctx);
    await waitOnExecutionContext(ctx);

    fetchSpy.mockRestore();

    expect(r.status).toBe(200);

    const logs = await readLogs();
    expect(logs.some(l => l.decision === "would_charge_paid")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 13. would_charge_verify_failed — log_only status + charge rule + invalid X-PAYMENT
// ---------------------------------------------------------------------------
describe("Decision: would_charge_verify_failed", () => {
  it("forwards to origin and logs decision=would_charge_verify_failed for log_only with bad payment", async () => {
    await seedTenant(makeTenant({
      hostname: "would-charge-verifyfail.test.example.com",
      origin: "https://origin.would-charge-verifyfail.test.example.com",
      status: "log_only",
      pricing_rules: [{
        id: "r-charge", priority: 1,
        path_pattern: "*", agent_pattern: "*",
        action: "charge", price_usdc: "0.01", enabled: true,
      }],
    }));

    const fetchSpy = makePaymentFetchSpy({
      verifyValid: false,
      verifyReason: "signature_invalid",
      originStatus: 200,
    });

    const req = await agentRequest("https://would-charge-verifyfail.test.example.com/foo", {
      "x-payment": "bad-payment-header",
    });

    const ctx = createExecutionContext();
    const r = await worker.fetch(req, env as any, ctx);
    await waitOnExecutionContext(ctx);

    fetchSpy.mockRestore();

    expect(r.status).toBe(200);

    const logs = await readLogs();
    expect(logs.some(l => l.decision === "would_charge_verify_failed")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 14. would_default_allow — log_only status + no rules + default_action=allow
// ---------------------------------------------------------------------------
describe("Decision: would_default_allow", () => {
  it("forwards to origin and logs decision=would_default_allow for log_only with no rules", async () => {
    await seedTenant(makeTenant({
      hostname: "would-default-allow.test.example.com",
      origin: "https://origin.would-default-allow.test.example.com",
      status: "log_only",
      default_action: "allow",
      pricing_rules: [],
    }));

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("would default allow", { status: 200 }),
    );

    const ctx = createExecutionContext();
    const r = await worker.fetch(
      humanRequest("https://would-default-allow.test.example.com/foo"),
      env as any,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    fetchSpy.mockRestore();

    expect(r.status).toBe(200);

    const logs = await readLogs();
    expect(logs.some(l => l.decision === "would_default_allow")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 15. status_paused — tenant.status=paused_by_publisher (forwards to origin)
// ---------------------------------------------------------------------------
describe("Decision: status_paused", () => {
  it("forwards to origin and logs decision=status_paused for paused_by_publisher tenant", async () => {
    await seedTenant(makeTenant({
      hostname: "status-paused.test.example.com",
      origin: "https://origin.status-paused.test.example.com",
      status: "paused_by_publisher",
    }));

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("paused origin", { status: 200 }),
    );

    const ctx = createExecutionContext();
    const r = await worker.fetch(
      humanRequest("https://status-paused.test.example.com/foo"),
      env as any,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    fetchSpy.mockRestore();

    expect(r.status).toBe(200);

    const logs = await readLogs();
    expect(logs.some(l => l.decision === "status_paused")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 16. status_suspended — tenant.status=suspended_by_paperward (forwards to origin)
// ---------------------------------------------------------------------------
describe("Decision: status_suspended", () => {
  it("forwards to origin and logs decision=status_suspended for suspended_by_paperward tenant", async () => {
    await seedTenant(makeTenant({
      hostname: "status-suspended.test.example.com",
      origin: "https://origin.status-suspended.test.example.com",
      status: "suspended_by_paperward",
    }));

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("suspended origin", { status: 200 }),
    );

    const ctx = createExecutionContext();
    const r = await worker.fetch(
      humanRequest("https://status-suspended.test.example.com/foo"),
      env as any,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    fetchSpy.mockRestore();

    expect(r.status).toBe(200);

    const logs = await readLogs();
    expect(logs.some(l => l.decision === "status_suspended")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 17. tenant_unknown — request to unconfigured hostname
// ---------------------------------------------------------------------------
describe("Decision: tenant_unknown", () => {
  it("returns 503 and logs decision=tenant_unknown for an unconfigured hostname", async () => {
    const ctx = createExecutionContext();
    const r = await worker.fetch(
      new Request("https://nonexistent-tenant.example.com/foo"),
      env as any,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(r.status).toBe(503);

    const logs = await readLogs();
    expect(logs.some(l => l.decision === "tenant_unknown")).toBe(true);
  });
});
