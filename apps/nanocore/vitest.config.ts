import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Local CPU-slot runners export their held worker count; Vitest itself does not read this variable.
const slotWorkers = Number(process.env.VITEST_MAX_WORKERS);

export default defineConfig({
  test: {
    globalSetup: [
      fileURLToPath(new URL('../../tests/support/vitest-global-setup.mjs', import.meta.url)),
    ],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    ...(slotWorkers > 0 ? { maxWorkers: slotWorkers } : {}),
    coverage: {
      exclude: ['dist/**', 'src/index.ts'],
      provider: 'v8',
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
        statements: 70,
      },
    },
  },
});
