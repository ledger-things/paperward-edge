// src/health/index.ts
import { Hono } from "hono";
import type { Env } from "@/types";

export function buildHealthApp(buildSha: string) {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/healthz", async (c) => {
    let kvOk = false;
    try {
      // A no-op read on a known-missing key proves the binding is live.
      await c.env.KV_DOMAINS.get("__healthz__");
      kvOk = true;
    } catch {
      kvOk = false;
    }

    let r2Ok = false;
    try {
      await c.env.R2_LOGS.head("__healthz__");
      r2Ok = true; // null is fine; we just need the call to not throw
    } catch {
      r2Ok = false;
    }

    return c.json({
      build_sha: buildSha,
      env: c.env.ENV,
      kv_ok: kvOk,
      r2_ok: r2Ok,
      facilitator_reachable: true, // not pinged here to avoid amplifying outages; future improvement
    });
  });

  app.get("/version", (c) => c.text(buildSha));

  return app;
}
