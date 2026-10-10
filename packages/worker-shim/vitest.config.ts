import { defineConfig } from 'vitest/config';

// The Integration and Pi Harness files share the fixed 17892 listener and run sequentially.
const fixedListeners = ['src/integration-client.test.ts', 'src/adapters/pi-harness*.test.ts'];
// Real DeepSeek processes must not compete with the parallel native fixtures (#200).
const deepseekNative = ['src/adapters/deepseek.test.ts'];
export default defineConfig({
  test: {
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
