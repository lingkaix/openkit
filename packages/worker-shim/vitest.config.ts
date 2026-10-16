import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The Integration and Pi Harness files share the fixed 17892 listener and run sequentially.
const fixedListeners = ['src/integration-client.test.ts', 'src/adapters/pi-harness*.test.ts'];
// Real DeepSeek startup must not compete with other native fixtures for its RPC deadline (#200).
const deepseekNative = [
  'src/adapters/deepseek.test.ts',
  'src/adapters/deepseek-native.test.ts',
  'src/adapters/deepseek-fault.test.ts',
  'src/adapters/deepseek-harness.test.ts',
  'src/adapters/concurrent-sessions.test.ts',
];
export default defineConfig({
  test: {
    globalSetup: [
      fileURLToPath(new URL('../../tests/support/vitest-global-setup.mjs', import.meta.url)),
    ],
    projects: [
      {
        test: {
          name: 'parallel',
          exclude: [...fixedListeners, ...deepseekNative, '**/node_modules/**'],
          include: ['src/**/*.test.ts'],
        },
      },
      { test: { name: 'fixed-listeners', include: fixedListeners, fileParallelism: false } },
      { test: { name: 'deepseek-native', include: deepseekNative, fileParallelism: false } },
    ],
  },
});
