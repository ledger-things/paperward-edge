import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import path from "node:path";

export default defineWorkersConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    name: "integration",
    include: ["test/integration/**/*.test.ts"],
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          kvNamespaces: ["KV_DOMAINS", "KV_KEY_CACHE", "KV_AUDIT"],
          r2Buckets: ["R2_LOGS"],
          analyticsEngineDatasets: { ANALYTICS: { dataset: "paperward_edge_test" } },
          bindings: {
            ENV: "test",
            ADMIN_HOSTNAME: "admin.test.paperward.local",
            HEALTH_HOSTNAME: "health.test.paperward.local",
            ADMIN_TOKEN: "test-admin-token",
            SENTRY_DSN: "",
          },
        },
      },
    },
  },
});
