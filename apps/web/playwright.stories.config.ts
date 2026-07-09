import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '../../tests/story-runner',
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  use: {
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
  },
});
