import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "scripts/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    globals: false,
    coverage: {
      reporter: ["text", "html"],
      // Floor set just below the measured baseline (statements 75.25%,
      // branches 63.03%, functions 77.96%, lines 75.41% as of the
      // security-hardening branch) so normal variance doesn't flake CI, but a
      // real regression still fails the build. Ratchet these up over time
      // rather than down.
      thresholds: {
        statements: 73,
        branches: 60,
        functions: 75,
        lines: 73
      }
    }
  }
});
