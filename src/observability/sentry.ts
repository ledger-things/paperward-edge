// src/observability/sentry.ts
//
// toucan-js@4.1.1 wrapper. Returns a Sentry-compatible object with
// captureException, captureMessage, setTag, setUser methods.
//
// API notes (toucan-js@4.1.1):
//   - Constructor option is `context` (not `executionCtx`) of type
//     `{ waitUntil: ExecutionContext['waitUntil'] }`.
//   - `tracesSampleRate` and `sampleRate` are accepted via CoreOptions.
//   - `Toucan` extends `Scope`, so captureException / captureMessage /
//     setTag / setUser are all present on the instance directly.
//
// When SENTRY_DSN is empty (dev / unit tests), a no-op stub is returned
// so callers never have to branch on environment.

import { Toucan } from "toucan-js";
import type { Env } from "@/types";

export type SentryLike = {
  captureException(err: unknown): void;
  captureMessage(msg: string, level?: "warning" | "error" | "info"): void;
  setTag(key: string, value: string): void;
  setUser(user: { id?: string; ip_address?: string }): void;
};

const NOOP: SentryLike = {
  captureException(err) {
    if (err instanceof Error) console.error(`[sentry-noop] ${err.message}`);
    else console.error(`[sentry-noop] ${String(err)}`);
  },
  captureMessage() {},
  setTag() {},
  setUser() {},
};

type Args = {
  env: Env;
  request: Request;
  executionCtx: ExecutionContext;
};

export function getSentry(args: Args): SentryLike {
  if (!args.env.SENTRY_DSN) return NOOP;
  return new Toucan({
    dsn: args.env.SENTRY_DSN,
    environment: args.env.ENV,
    request: args.request,
    context: args.executionCtx,
    tracesSampleRate: 0.1,
    sampleRate: 1.0,
  });
}
