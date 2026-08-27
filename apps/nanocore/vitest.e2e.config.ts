import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['e2e/**/*.spec.ts'],
    // The real Codex smoke drives a worker runtime the test execution image
    // does not carry, so it is a host gate with its own config rather than a
    // member of this deterministic suite. See docs/toolchain.md Test Execution
    // Environment.
    exclude: ['e2e/codex-smoke.spec.ts'],
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
