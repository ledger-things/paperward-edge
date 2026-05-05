import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    // Exclude integration tests from the root Vite context — they run in the
    // Workers miniflare pool via vitest.integration.config.ts. The root config's
    // Vite instance does not have the @cloudflare/vitest-pool-workers plugin, so
    // cloudflare:test imports would fail if integration tests were collected here.
    exclude: ["**/node_modules/**", "test/integration/**"],
    projects: [
      // Unit tests: plain Node, fast, no Workers runtime — config in vitest.unit.config.ts
      "./vitest.unit.config.ts",
      // Integration tests: full Workers runtime via Miniflare — config in vitest.integration.config.ts
      "./vitest.integration.config.ts",
    ],
  },
});
