import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      // Only measure first-party source — keep stray root/config files out of the denominator.
      include: ["src/**/*.{ts,tsx}"],
      reporter: ["text", "json-summary", "lcov"],
      // Still write the report even when a threshold fails.
      reportOnFailure: true,
      thresholds: { statements: 90, branches: 85, functions: 85, lines: 90 },
    },
  },
});
