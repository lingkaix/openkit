import { syncBuiltinESMExports } from 'node:module';
import { afterEach, describe, it, vi } from 'vitest';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import {
  assertTaskDurableAdmissionResponse,
  TASK_DURABLE_ADMISSION_CASES,
} from './test-support/task-durable-admission-case.js';

// This public remote case owns a fresh Vitest worker; its exact oracle is shared with the other admission entries.
describe('Task durable admission response', () => {
  it.each(TASK_DURABLE_ADMISSION_CASES.filter(({ entry }) => entry === 'remote-mcp'))(
    'returns $entry admission for "$input" before the held worker finishes',
    assertTaskDurableAdmissionResponse,
    60_000
  );
});

// Restore shared callables before native drain, with the same original cleanup order.
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await shutdownControlStoreWorkerClient();
});
