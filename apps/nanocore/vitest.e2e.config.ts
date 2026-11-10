import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Reuse the unit runner's held CPU-slot count; Vitest does not read this variable.
const slotWorkers = Number(process.env.VITEST_MAX_WORKERS);

export default defineConfig({
  test: {
    // Keep Vitest 4 mock-history semantics (Vitest 5 clears before every test); suites assert history across tests.
    clearMocks: false,
    globalSetup: [
      fileURLToPath(new URL('../../tests/support/vitest-global-setup.mjs', import.meta.url)),
      fileURLToPath(new URL('./vitest-worker-setup.mjs', import.meta.url)),
    ],
    include: ['e2e/**/*.spec.ts'],
    // Codex native consumers need a host runtime or a local Docker namespace.
    // The synthetic Login component and real-account smoke stay in the existing
    // opt-in host config, never the ordinary deterministic image/unit gate.
    // See docs/toolchain.md Test Execution Environment.
    exclude: ['e2e/codex-smoke.spec.ts', 'e2e/codex-login-activation.spec.ts'],
    pool: 'forks',
    testTimeout: 60_000,
    ...(slotWorkers > 0 ? { maxWorkers: slotWorkers } : {}),
    hookTimeout: 30_000,
  },
});
