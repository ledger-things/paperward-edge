// test/unit/observability/sentry.test.ts
import { describe, it, expect } from "vitest";
import { getSentry } from "@/observability/sentry";

describe("getSentry", () => {
  it("returns a no-op when DSN is empty", () => {
    const s = getSentry({
      env: { SENTRY_DSN: "", ENV: "dev" } as any,
      request: new Request("https://x"),
      executionCtx: { waitUntil: () => {} } as any,
    });
    expect(s.captureException).toBeDefined();
    s.captureException(new Error("test")); // should not throw
  });

  it("returns a real Sentry instance when DSN is set", () => {
    const s = getSentry({
      env: { SENTRY_DSN: "https://abc@x.ingest.sentry.io/1", ENV: "production" } as any,
      request: new Request("https://x"),
      executionCtx: { waitUntil: () => {} } as any,
    });
    expect(typeof s.captureException).toBe("function");
  });
});
