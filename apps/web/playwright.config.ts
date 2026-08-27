import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for L4 Web e2e smoke tests.
 *
 * Specs under `e2e/` start an isolated NanoCore + Vite stack on dynamic ports
 * (see `e2e/_lib/servers.ts`); this config does not pin fixed ports.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  use: {
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
  },
});
