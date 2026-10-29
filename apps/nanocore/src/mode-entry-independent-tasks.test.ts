import { syncBuiltinESMExports } from 'node:module';
import { afterEach, describe, it, vi } from 'vitest';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { independentTasksAdmissionOwnership } from './test-support/mode-entry-fixture.js';

// Simulated continuity still resolves against explicit fixture-owned confirmed image evidence.
vi.mock('./runtime/agent-environment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtime/agent-environment.js')>();
  const { withTestPreparedNativeEnvironment } = await import(
    './test-support/native-environment.js'
  );
  return withTestPreparedNativeEnvironment(actual);
});

describe('route B queued Task receipts', () => {
  it(
    'gives two independent Tasks 202 while only the first native Turn has started',
    independentTasksAdmissionOwnership
  );
});

// Restore shared callables before native drain; a timed-out body can still finish later.
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await shutdownControlStoreWorkerClient();
});
