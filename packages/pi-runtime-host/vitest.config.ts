import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Keep Vitest 4 mock-history semantics (Vitest 5 clears before every test); suites assert history across tests.
    clearMocks: false,
    globalSetup: [
      fileURLToPath(new URL('../../tests/support/vitest-global-setup.mjs', import.meta.url)),
    ],
  },
});
