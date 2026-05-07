// test/mocks/cloudflare-workers.ts
//
// Stub for the `cloudflare:workers` runtime module so unit tests can import
// modules that extend `DurableObject` without booting miniflare. The runtime
// provides this module natively; in Node-based unit tests Vitest aliases this
// file in via vitest.unit.config.ts.

export class DurableObject<_Env = unknown> {
  // Match the runtime signature so subclasses with `super(state, env)` typecheck
  // and run identically under vitest's Node environment.
  constructor(
    public state: unknown,
    public env: unknown,
  ) {}
}
