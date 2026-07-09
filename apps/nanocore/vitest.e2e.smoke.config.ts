import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'e2e/boot-empty.spec.ts',
      'e2e/server-boot.spec.ts',
      'e2e/server-unauth-rejection.spec.ts',
      'e2e/agent-readiness.spec.ts',
    ],
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
