// src/admin/auth.ts
import type { MiddlewareHandler } from "hono";

export const adminAuth: MiddlewareHandler<{ Bindings: { ADMIN_TOKEN: string } }> = async (c, next) => {
  const auth = c.req.header("authorization") ?? "";
  const m = auth.match(/^Bearer (.+)$/);
  if (!m || !m[1]) return c.text("unauthorized", 401);
  if (!constantTimeEqual(m[1], c.env.ADMIN_TOKEN)) return c.text("unauthorized", 401);
  await next();
};

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
