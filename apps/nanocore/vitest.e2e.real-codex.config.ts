import { defineConfig } from 'vitest/config';

/**
 * Host gate for the real Codex smoke.
 *
 * It is separated from `vitest.e2e.config.ts` because it needs a Codex CLI and
 * a provider credential on the machine that runs it. The test execution image
 * carries no worker runtime, so this suite runs under
 * `scripts/test-env.sh host` alongside the other real-runtime gates.
 */
export default defineConfig({
  test: {
    include: ['e2e/codex-smoke.spec.ts'],
    pool: 'forks',
    testTimeout: 140_000,
    hookTimeout: 30_000,
  },
});
