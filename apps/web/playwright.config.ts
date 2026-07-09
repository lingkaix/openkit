import { defineConfig, devices } from '@playwright/test';
import { seedDemoWorkspaceDataRoot } from './e2e/_lib/demo-data.js';

const coreUrl = 'http://127.0.0.1:3100';
const webUrl = 'http://127.0.0.1:4173';
const dataRoot = `/private/tmp/openkit-web-e2e-data-${Date.now()}`;

seedDemoWorkspaceDataRoot(dataRoot);

export default defineConfig({
  testDir: './e2e',
  testIgnore: ['staging/**'],
  timeout: 45_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: webUrl,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `pnpm --filter @openkit/nanocore build && OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR=1 OPENKIT_DATA_ROOT=${dataRoot} PORT=3100 pnpm --filter @openkit/nanocore start`,
      url: `${coreUrl}/api/meta`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: `VITE_CORE_URL=${coreUrl} pnpm build && VITE_CORE_URL=${coreUrl} pnpm preview --host 127.0.0.1 --port 4173`,
      url: webUrl,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
