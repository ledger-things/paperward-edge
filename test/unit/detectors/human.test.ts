// test/unit/detectors/human.test.ts
import { describe, it, expect } from "vitest";
import { HumanDetector } from "@/detectors/human";

const det = new HumanDetector();

function req(headers: Record<string, string>): Request {
  return new Request("https://blog.example.com/foo", { headers });
}

describe("HumanDetector", () => {
  it("returns human for a Chrome-like request with Accept-Language", async () => {
    const r = await det.detect(req({
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      "accept-language": "en-US,en;q=0.9",
    }));
    expect(r).not.toBeNull();
    expect(r?.agent_id).toBe("human");
    expect(r?.signed).toBe(false);
    expect(r?.detector_id).toBe("human");
  });

  it("returns null for a Firefox-like request with no Accept-Language", async () => {
    const r = await det.detect(req({
      "user-agent": "Mozilla/5.0 (X11; Linux) Firefox/120",
    }));
    expect(r).toBeNull();
  });

  it("returns null when a WBA Signature header is present (signed agent, not human)", async () => {
    const r = await det.detect(req({
      "user-agent": "Mozilla/5.0 (X11; Linux) Firefox/120",
      "accept-language": "en-US",
      "signature": "sig=..", // presence alone is enough to bail
    }));
    expect(r).toBeNull();
  });

  it("returns null for a curl-shaped UA", async () => {
    const r = await det.detect(req({
      "user-agent": "curl/8.4.0",
      "accept-language": "en-US",
    }));
    expect(r).toBeNull();
  });

  it("returns null for known bot user-agents even with Accept-Language", async () => {
    const r = await det.detect(req({
      "user-agent": "GPTBot/1.0",
      "accept-language": "en-US",
    }));
    expect(r).toBeNull();
  });

  it("returns null when no UA at all", async () => {
    const r = await det.detect(req({}));
    expect(r).toBeNull();
  });

  it("has priority 100", () => {
    expect(det.priority).toBe(100);
  });
});
