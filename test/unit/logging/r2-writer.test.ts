// test/unit/logging/r2-writer.test.ts
import { describe, it, expect, vi } from "vitest";
import { writeLogToR2, logKey } from "@/logging/r2-writer";
import type { LogEntry } from "@/logging/types";

const SAMPLE: LogEntry = {
  id: "01H8XGJWBK1234ABCDEF", // ULID; first 4 chars = "01H8"
  ts: "2026-05-05T12:00:00Z",
  tenant_id: "tenant-uuid-1",
  hostname: "blog.example.com",
  config_version: 1,
  ray_id: "ray-1",
  method: "GET",
  path: "/foo",
  agent_id: "human",
  agent_signed: false,
  detector_id: "human",
  decision: "allow",
  decision_reason: null,
  rule_id: null,
  price_usdc: null,
  paid: false,
  payment_tx: null,
  origin_status: 200,
  latency_ms: 23,
};

describe("logKey", () => {
  it("uses prefix-first sharding so writes spread across {ulid_prefix}", () => {
    const k = logKey(SAMPLE);
    expect(k).toBe("requests/01H8/dt=2026-05-05/tenant=tenant-uuid-1/01H8XGJWBK1234ABCDEF.ndjson");
  });

  it("derives the date partition from LogEntry.ts (UTC)", () => {
    const k = logKey({ ...SAMPLE, ts: "2026-12-31T23:59:59Z" });
    expect(k).toContain("dt=2026-12-31");
  });

  it("lowercases hex-like prefix chars for consistent shard buckets", () => {
    const k = logKey({ ...SAMPLE, id: "ABCDXGJWBK1234ABCDEF" });
    expect(k.startsWith("requests/abcd/")).toBe(true);
  });
});

describe("writeLogToR2", () => {
  it("PUTs an ND-JSON line at the prefix-sharded key", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const r2 = { put } as unknown as R2Bucket;
    await writeLogToR2(r2, SAMPLE);
    expect(put).toHaveBeenCalledTimes(1);
    const [key, body, opts] = put.mock.calls[0]!;
    expect(key).toBe(logKey(SAMPLE));
    expect(typeof body).toBe("string");
    expect((body as string).endsWith("\n")).toBe(true);
    expect(JSON.parse((body as string).trim())).toEqual(SAMPLE);
    expect(opts).toMatchObject({ httpMetadata: { contentType: "application/x-ndjson" } });
  });

  it("does not throw on R2 errors — returns false", async () => {
    const put = vi.fn().mockRejectedValue(new Error("r2 down"));
    const r2 = { put } as unknown as R2Bucket;
    const ok = await writeLogToR2(r2, SAMPLE);
    expect(ok).toBe(false);
  });
});
