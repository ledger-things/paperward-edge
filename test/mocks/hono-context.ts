// test/mocks/hono-context.ts
import { Hono } from "hono";
import type { Env, Vars } from "@/types";

export function buildTestApp(handler: (c: any) => Promise<Response | void>) {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();
  app.all("*", handler);
  return app;
}

export async function runMiddleware(
  middleware: (c: any, next: () => Promise<void>) => Promise<Response | void>,
  request: Request,
  env: Partial<Env>,
  initialVars: Partial<Vars>,
): Promise<{ response: Response; vars: Partial<Vars> }> {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();
  // Pre-populate vars
  app.use("*", async (c, next) => {
    for (const [k, v] of Object.entries(initialVars)) {
      c.set(k as keyof Vars, v as any);
    }
    await next();
  });
  app.use("*", middleware);
  let capturedVars: Partial<Vars> = {};
  app.all("*", (c) => {
    capturedVars = { ...c.var };
    return c.text("default-handler");
  });
  const response = await app.fetch(request, env as Env);
  return { response, vars: capturedVars };
}
