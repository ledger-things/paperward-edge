// src/detectors/web-bot-auth.ts
// Stub — full implementation comes in Task E3.
import type { Detector, DetectionResult } from "@/detectors/types";

export type WebBotAuthDeps = { keyCache: KVNamespace };

export class WebBotAuthDetector implements Detector {
  readonly id = "web-bot-auth";
  readonly priority = 10;
  constructor(_deps: WebBotAuthDeps) {}
  async detect(_req: Request): Promise<DetectionResult | null> {
    throw new Error("WebBotAuthDetector stub: implement in Task E3");
  }
}
