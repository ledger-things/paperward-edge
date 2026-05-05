// src/middleware/detectorPipeline.ts

import type { MiddlewareHandler } from "hono";
import type { Env, Vars } from "@/types";
import type { Detector } from "@/detectors/types";

export function buildDetectorPipelineMiddleware(
  getDetectors: (env: Env) => Detector[],
): MiddlewareHandler<{ Bindings: Env; Variables: Vars }> {
  return async (c, next) => {
    const tenant = c.var.tenant;
    if (!tenant || tenant.status === "paused_by_publisher" || tenant.status === "suspended_by_paperward") {
      c.set("detection", null);
      await next();
      return;
    }

    const detectors = [...getDetectors(c.env)].sort((a, b) => a.priority - b.priority);
    let detection = null;
    for (const d of detectors) {
      try {
        const r = await d.detect(c.req.raw);
        if (r !== null) { detection = r; break; }
      } catch (err) {
        console.error(JSON.stringify({ at: "detectorPipeline", detector: d.id, err: String(err) }));
        // continue to next detector
      }
    }
    c.set("detection", detection);
    await next();
  };
}
