import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // The package export points at dist. Tests must load the source they sit beside.
      '@openkit/knowledge-ui': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
  test: {
    // Keep Vitest 4 mock-history semantics (Vitest 5 clears before every test); suites assert history across tests.
    clearMocks: false,
    environment: 'jsdom',
    globalSetup: [
      fileURLToPath(new URL('../../tests/support/vitest-global-setup.mjs', import.meta.url)),
    ],
  },
});
