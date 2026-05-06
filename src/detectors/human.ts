// src/detectors/human.ts
//
// Tier-1 fallback detector: identifies a request as a "human" visitor when
// the request looks browser-shaped and is NOT WBA-signed.
//
// Spec §14.2 documents this as intentionally weak — the goal is "do not
// block legitimate humans," not "detect agents pretending to be human."

import type { Detector, DetectionResult } from "@/detectors/types";

const BROWSER_UA_PATTERN = /\b(Mozilla|AppleWebKit|Chrome|Safari|Edge|Firefox)\b/i;
const KNOWN_BOT_PATTERN =
  /\b(GPTBot|ClaudeBot|PerplexityBot|Bytespider|CCBot|Googlebot|Bingbot|Applebot)\b/i;

export class HumanDetector implements Detector {
  readonly id = "human";
  readonly priority = 100;

  async detect(req: Request): Promise<DetectionResult | null> {
    // Bail if the request claims to be WBA-signed — that is the WBA detector's
    // territory, not ours. We only fire on truly unsigned, browser-shaped traffic.
    if (req.headers.get("signature") !== null) return null;
    if (req.headers.get("signature-input") !== null) return null;
    if (req.headers.get("signature-agent") !== null) return null;

    const ua = req.headers.get("user-agent") ?? "";
    if (!ua) return null;
    if (KNOWN_BOT_PATTERN.test(ua)) return null;
    if (!BROWSER_UA_PATTERN.test(ua)) return null;

    // A browser sends Accept-Language by default; bots usually don't bother.
    const al = req.headers.get("accept-language");
    if (!al) return null;

    return {
      agent_id: "human",
      signed: false,
      detector_id: this.id,
      confidence: "high",
    };
  }
}
