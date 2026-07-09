import { defineConfig, devices } from '@playwright/test';

const appUrl = process.env.OPENKIT_APP_E2E_BASE_URL ?? 'http://127.0.0.1:18081';

export default defineConfig({
  testDir: './e2e/staging',
  timeout: 60_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: appUrl,
    trace: 'retain-on-failure',
  },
});
