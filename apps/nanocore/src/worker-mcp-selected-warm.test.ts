// openkit-test-platform: posix
import { afterEach, describe, it } from 'vitest';
import { assertCapturedOutcome, capturedOutcomeCases } from '../worker-mcp-lifecycle.fixture.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';

// Each admitted lifecycle owns a file context so late cleanup cannot close the next scenario's writer.
describe('worker MCP routes', () => {
  it.for([capturedOutcomeCases[2]])(
    'starts a definition-derived $entry, observes attention, responds and delivers the captured outcome once',
    { timeout: 60_000 },
    assertCapturedOutcome
  );
});

// Drain the same native fixture owner before this file's isolated context is released.
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
});
