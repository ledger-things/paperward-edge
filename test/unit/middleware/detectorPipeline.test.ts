// test/unit/middleware/detectorPipeline.test.ts
import { describe, it, expect, vi } from "vitest";
import { buildDetectorPipelineMiddleware } from "@/middleware/detectorPipeline";
import { runMiddleware } from "../../mocks/hono-context";
import type { Detector } from "@/detectors/types";
import type { TenantConfig } from "@/config/types";

const tenantActive: TenantConfig = {
  schema_version: 1, tenant_id: "t1", hostname: "blog.example.com",
  origin: "https://o", status: "active", default_action: "allow",
  facilitator_id: "coinbase-x402-base", payout_address: "0x", pricing_rules: [],
  config_version: 1, created_at: "x", updated_at: "x",
};

const tenantPaused: TenantConfig = { ...tenantActive, status: "paused_by_publisher" };

function det(id: string, priority: number, returns: any | null): Detector {
  return { id, priority, detect: vi.fn().mockResolvedValue(returns) };
}

describe("detectorPipeline", () => {
  it("returns first non-null detection from priority-ordered detectors", async () => {
    const detectors = [
      det("low", 100, null),
      det("high", 10, { agent_id: "signed:openai.com", signed: true, detector_id: "high", confidence: "high" }),
      det("mid", 50, { agent_id: "signed:wrong", signed: true, detector_id: "mid", confidence: "high" }),
    ];
    const mw = buildDetectorPipelineMiddleware(() => detectors);
    const { vars } = await runMiddleware(mw, new Request("https://blog.example.com/x"), {}, { tenant: tenantActive });
    expect(vars.detection?.detector_id).toBe("high");
  });

  it("leaves detection: null when all detectors return null", async () => {
    const mw = buildDetectorPipelineMiddleware(() => [det("a", 10, null), det("b", 100, null)]);
    const { vars } = await runMiddleware(mw, new Request("https://blog.example.com/x"), {}, { tenant: tenantActive });
    expect(vars.detection).toBeNull();
  });

  it("skips detection entirely when tenant.status is paused_by_publisher", async () => {
    const dector = det("a", 10, { agent_id: "signed:x", signed: true, detector_id: "a", confidence: "high" });
    const mw = buildDetectorPipelineMiddleware(() => [dector]);
    await runMiddleware(mw, new Request("https://blog.example.com/x"), {}, { tenant: tenantPaused });
    expect(dector.detect).not.toHaveBeenCalled();
  });

  it("treats detect() throws as null and continues", async () => {
    const throwing: Detector = { id: "boom", priority: 1, detect: vi.fn().mockRejectedValue(new Error("nope")) };
    const ok: Detector = det("ok", 100, { agent_id: "human", signed: false, detector_id: "ok", confidence: "high" });
    const mw = buildDetectorPipelineMiddleware(() => [throwing, ok]);
    const { vars } = await runMiddleware(mw, new Request("https://blog.example.com/x"), {}, { tenant: tenantActive });
    expect(vars.detection?.detector_id).toBe("ok");
  });
});
