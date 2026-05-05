// src/admin/index.ts
import { Hono } from "hono";
import type { Env } from "@/types";
import { buildAdminTenantRoutes } from "@/admin/tenants";

export function buildAdminApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/__admin", buildAdminTenantRoutes());
  return app;
}
