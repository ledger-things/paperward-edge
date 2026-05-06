// src/detectors/types.ts

export type Confidence = "high" | "medium" | "low";

export type DetectionResult = {
  agent_id: string; // "signed:{operator}" | "unsigned:{name}" | "human"
  signed: boolean;
  detector_id: string;
  confidence: Confidence;
};

export interface Detector {
  readonly id: string;
  readonly priority: number;
  detect(req: Request): Promise<DetectionResult | null>;
}
