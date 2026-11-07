import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["packages/*/test/**/*.test.ts", "apps/api/test/unit/**/*.test.ts"] } },
      {
        plugins: [react()],
        resolve: { alias: { "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)) } },
        test: { name: "web", include: ["apps/web/test/**/*.test.{ts,tsx}"], environment: "jsdom" },
      },
      {
        test: {
          name: "integration",
          include: ["apps/api/test/integration/**/*.test.ts"],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
    // `npm run test:coverage`. Measures code executed inside the test processes only:
    // the API and worker *child processes* spawned by e2e/chaos tests are not instrumented.
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts", "apps/api/src/**/*.ts"],
      exclude: [
        // Process entry points: exercised only as child processes (see above).
        "apps/api/src/main.ts",
        "apps/api/src/admin.ts",
        "packages/db/src/migrate-cli.ts",
        // Consumed through the built package (dist/) by every integration test, so v8
        // never sees these source files execute; reporting them would show a false 0%.
        "packages/db/src/index.ts",
        "packages/db/src/migrate.ts",
        "packages/db/src/schema.ts",
      ],
      reporter: ["text-summary", "json-summary", "lcov", "html"],
      reportsDirectory: "coverage",
      // Ratchet: just under the levels measured when CI was introduced (2026-11-04).
      thresholds: { statements: 87, branches: 79, functions: 82, lines: 88 },
    },
  },
});
