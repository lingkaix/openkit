import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import CiVitestSequencer from '../../scripts/ci-vitest-sequencer.mjs';

// Local CPU-slot runners export their held worker count; Vitest itself does not read this variable.
const slotWorkers = Number(process.env.VITEST_MAX_WORKERS);

export default defineConfig({
  test: {
    globalSetup: [
      fileURLToPath(new URL('../../tests/support/vitest-global-setup.mjs', import.meta.url)),
      fileURLToPath(new URL('./vitest-worker-setup.mjs', import.meta.url)),
    ],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**', 'src/storage/l-ops-load.test.ts'],
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    // CI collection and execution already share --shard; ordinary local runs keep Vitest defaults.
    ...(process.argv.some((arg) => arg.startsWith('--shard='))
      ? { sequence: { sequencer: CiVitestSequencer } }
      : {}),
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
