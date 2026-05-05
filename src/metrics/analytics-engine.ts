// src/metrics/analytics-engine.ts
//
// Workers Analytics Engine helper. Each method emits a single data point
// shaped per spec §10.3. Indexes are queryable; blobs are filterable;
// doubles are aggregatable.

export class Metrics {
  constructor(private readonly ds: AnalyticsEngineDataset) {}

  requestRecorded(args: { tenant_id: string; decision: string; agent_signed: boolean; latency_ms: number }): void {
    this.ds.writeDataPoint({
      indexes: [args.tenant_id],
      blobs: ["requests_total", args.decision, String(args.agent_signed)],
      doubles: [1, args.latency_ms],
    });
  }

  verifyLatency(args: { facilitator_id: string; latency_ms: number }): void {
    this.ds.writeDataPoint({
      indexes: [args.facilitator_id],
      blobs: ["paywall_verify_latency_ms"],
      doubles: [args.latency_ms],
    });
  }

  settleLatency(args: { facilitator_id: string; latency_ms: number }): void {
    this.ds.writeDataPoint({
      indexes: [args.facilitator_id],
      blobs: ["paywall_settle_latency_ms"],
      doubles: [args.latency_ms],
    });
  }

  settleFailure(args: { facilitator_id: string; reason: string }): void {
    this.ds.writeDataPoint({
      indexes: [args.facilitator_id],
      blobs: ["paywall_settle_failures_total", args.reason],
      doubles: [1],
    });
  }

  detectorMatch(args: { detector_id: string; agent_id_class: string }): void {
    this.ds.writeDataPoint({
      indexes: [args.detector_id],
      blobs: ["detector_match_total", args.agent_id_class],
      doubles: [1],
    });
  }

  configCache(args: { outcome: "hit" | "miss" | "stale" }): void {
    this.ds.writeDataPoint({
      indexes: ["kv_config_cache"],
      blobs: ["kv_config_cache", args.outcome],
      doubles: [1],
    });
  }

  originLatency(args: { tenant_id: string; latency_ms: number }): void {
    this.ds.writeDataPoint({
      indexes: [args.tenant_id],
      blobs: ["origin_fetch_latency_ms"],
      doubles: [args.latency_ms],
    });
  }
}
