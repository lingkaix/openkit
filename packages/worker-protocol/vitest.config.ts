import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: [
      fileURLToPath(new URL('../../tests/support/vitest-global-setup.mjs', import.meta.url)),
    ],
  },
});
