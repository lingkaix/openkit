import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Opt-in native load instrument; its pure controls remain in the default CI suite. */
export default defineConfig({
  test: {
    globalSetup: [
      fileURLToPath(new URL('../../tests/support/vitest-global-setup.mjs', import.meta.url)),
      fileURLToPath(new URL('./vitest-worker-setup.mjs', import.meta.url)),
    ],
    include: ['src/storage/l-ops-load.test.ts'],
    pool: 'forks',
    testTimeout: 30_000,
  },
});
