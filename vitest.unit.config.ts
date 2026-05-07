import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      // The Workers runtime provides `cloudflare:workers` natively; for Node-
      // based unit tests we alias it to a hand-rolled stub.
      "cloudflare:workers": fileURLToPath(
        new URL("./test/mocks/cloudflare-workers.ts", import.meta.url),
      ),
    },
  },
  test: {
    name: "unit",
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
  },
});
