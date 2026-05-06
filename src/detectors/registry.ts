// src/detectors/registry.ts
//
// Ordered list of active Detectors. Add Tier 2 / Tier 3 detectors here in
// the future at their reserved priorities (50 / 90); pipeline iterates them
// in ascending priority order and the first non-null detect() result wins.

import type { Detector } from "@/detectors/types";
import { WebBotAuthDetector } from "@/detectors/web-bot-auth";
import { HumanDetector } from "@/detectors/human";

export type DetectorRegistryDeps = {
  wbaKeyCache: KVNamespace;
};

export function buildDetectorRegistry(deps: DetectorRegistryDeps): Detector[] {
  return [new WebBotAuthDetector({ keyCache: deps.wbaKeyCache }), new HumanDetector()];
}
