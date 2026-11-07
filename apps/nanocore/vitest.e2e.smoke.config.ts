import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Keep Vitest 4 mock-history semantics (Vitest 5 clears before every test); suites assert history across tests.
    clearMocks: false,
    globalSetup: [
      fileURLToPath(new URL('../../tests/support/vitest-global-setup.mjs', import.meta.url)),
      fileURLToPath(new URL('./vitest-worker-setup.mjs', import.meta.url)),
    ],
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
