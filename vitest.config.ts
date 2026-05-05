import { defineConfig } from "vitest/config";
import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    projects: [
      {
        // Unit tests: plain Node, fast, no Workers runtime
        extends: false,
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      defineWorkersProject({
        // Integration tests: full Workers runtime via Miniflare
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
      }),
    ],
  },
});
