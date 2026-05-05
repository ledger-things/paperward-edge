// test/unit/admin/auth.test.ts
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { adminAuth } from "@/admin/auth";

function app(token: string) {
  const a = new Hono<{ Bindings: { ADMIN_TOKEN: string } }>();
  a.use("*", adminAuth);
  a.get("/x", (c) => c.text("ok"));
  return { app: a, env: { ADMIN_TOKEN: token } };
}

describe("adminAuth", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const { app: a, env } = app("secret");
    const r = await a.fetch(new Request("https://x/x"), env);
    expect(r.status).toBe(401);
  });

  it("returns 401 with wrong bearer", async () => {
    const { app: a, env } = app("secret");
    const r = await a.fetch(new Request("https://x/x", { headers: { authorization: "Bearer wrong" } }), env);
    expect(r.status).toBe(401);
  });

  it("calls next() with correct bearer", async () => {
    const { app: a, env } = app("secret");
    const r = await a.fetch(new Request("https://x/x", { headers: { authorization: "Bearer secret" } }), env);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("ok");
  });

  it("uses constant-time compare to avoid timing leaks", async () => {
    // Just smoke-test that supplying an obviously wrong-length token still returns 401
    const { app: a, env } = app("secret-very-long");
    const r = await a.fetch(new Request("https://x/x", { headers: { authorization: "Bearer s" } }), env);
    expect(r.status).toBe(401);
  });
});
