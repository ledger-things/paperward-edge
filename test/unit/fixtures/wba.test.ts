import { describe, it, expect } from "vitest";
import { signRequest } from "../../fixtures/wba/sign";

describe("WBA fixture signing", () => {
  it("produces a request with WBA headers", async () => {
    const r = await signRequest({ url: "https://blog.example.com/foo" });
    expect(r.headers.get("signature")).toMatch(/^sig1=:.*:$/);
    expect(r.headers.get("signature-input")).toContain("keyid=");
    expect(r.headers.get("signature-agent")).toContain("test-agent.local");
  });
});
