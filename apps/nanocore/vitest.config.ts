import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    include: ['src/**/*.test.ts'],
    testTimeout: 15_000,
    coverage: {
      exclude: [
        'dist/**',
        'src/index.ts',
        'src/runtime/codex/transport.ts',
        'src/runtime/host-adapter.ts',
        'src/runtime/opencode/command-session.ts',
      ],
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
