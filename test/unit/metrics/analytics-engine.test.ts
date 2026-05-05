// test/unit/metrics/analytics-engine.test.ts
import { describe, it, expect, vi } from "vitest";
import { Metrics } from "@/metrics/analytics-engine";

describe("Metrics", () => {
  it("emits a request_total point with the right blobs and doubles", () => {
    const writeDataPoint = vi.fn();
    const ds = { writeDataPoint } as unknown as AnalyticsEngineDataset;
    const m = new Metrics(ds);
    m.requestRecorded({ tenant_id: "t1", decision: "charge_paid", agent_signed: true, latency_ms: 42 });
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
    const arg = writeDataPoint.mock.calls[0]![0];
    expect(arg.indexes).toEqual(["t1"]);
    expect(arg.blobs).toEqual(["requests_total", "charge_paid", "true"]);
    expect(arg.doubles).toEqual([1, 42]);
  });

  it("emits paywall_settle_failure points with reason as a blob", () => {
    const writeDataPoint = vi.fn();
    const ds = { writeDataPoint } as unknown as AnalyticsEngineDataset;
    const m = new Metrics(ds);
    m.settleFailure({ facilitator_id: "coinbase-x402-base", reason: "settle_failed" });
    const arg = writeDataPoint.mock.calls[0]![0];
    expect(arg.blobs).toContain("paywall_settle_failures_total");
    expect(arg.blobs).toContain("settle_failed");
  });
});
