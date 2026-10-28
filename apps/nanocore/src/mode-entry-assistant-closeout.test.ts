import { syncBuiltinESMExports } from 'node:module';
import { afterEach, describe, it, vi } from 'vitest';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { taskTerminalReplayCloseoutOwnership } from './test-support/mode-entry-fixture.js';

vi.mock('./runtime/agent-environment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtime/agent-environment.js')>();
  const { withTestPreparedNativeEnvironment } = await import(
    './test-support/native-environment.js'
  );
  return withTestPreparedNativeEnvironment(actual);
});

describe('Task terminal replay closeout ownership', () => {
  it.each([{ entry: 'assistant', failCollection: true }] as const)(
    'preserves $entry closeout ownership during exact replay (failure=$failCollection)',
    taskTerminalReplayCloseoutOwnership
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await shutdownControlStoreWorkerClient();
});
