import { defineConfig } from 'vitest/config';

// Only the Integration and Pi Harness files own the fixed 17892 listener. Keep that
// group sequential while unrelated worker-shim tests retain parallel scheduling.
const fixedListeners = ['src/integration-client.test.ts', 'src/adapters/pi-harness*.test.ts'];
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'parallel',
          exclude: [...fixedListeners, '**/node_modules/**'],
          include: ['src/**/*.test.ts'],
        },
      },
      { test: { name: 'fixed-listeners', include: fixedListeners, fileParallelism: false } },
    ],
  },
});
