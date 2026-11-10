import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Opt-in host gate for the real Codex smoke and synthetic native Login component.
 *
 * The smoke needs a Codex CLI and a provider credential. The separately selected
 * Login component instead uses only synthetic material and an explicit local
 * immutable Worker image, with no account or physical-placement qualification.
 * Both stay outside ordinary image/unit gates and use `scripts/test-env.sh host`.
 */
export default defineConfig({
  test: {
    // Keep Vitest 4 mock-history semantics (Vitest 5 clears before every test); suites assert history across tests.
    clearMocks: false,
    globalSetup: [
      fileURLToPath(new URL('../../tests/support/vitest-global-setup.mjs', import.meta.url)),
      fileURLToPath(new URL('./vitest-worker-setup.mjs', import.meta.url)),
    ],
    include: ['e2e/codex-smoke.spec.ts', 'e2e/codex-login-activation.spec.ts'],
    pool: 'forks',
    testTimeout: 140_000,
    hookTimeout: 30_000,
  },
});
