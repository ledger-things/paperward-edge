// vitest.workspace.ts
// Orchestrates both the unit (Node.js) and integration (Workers/miniflare)
// test suites. Each project runs in its own isolated context:
//   - unit: plain Node.js environment, fast, no Workers runtime
//   - integration: full Workers runtime via @cloudflare/vitest-pool-workers
//
// Run all:           npm test
// Run unit only:     npm test -- --project unit
// Run integration:   npm test -- --project integration
import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "./vitest.unit.config.ts",
  "./vitest.integration.config.ts",
]);
