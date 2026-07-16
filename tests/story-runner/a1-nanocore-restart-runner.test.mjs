import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateA1RestartConfig, runA1NanoCoreRestart } from './a1-nanocore-restart-runner.mjs';

const env = {
  OPENKIT_CONTAINER_BACKEND: 'openshell',
  OPENKIT_CONTAINER_PLACEMENT: 'remote',
  OPENKIT_L6_A1_RESTART: '1',
  OPENKIT_L6_A1_RESTART_PORT: '4317',
  OPENKIT_L6_ALLOW_PROVIDER_QUOTA: '1',
  OPENKIT_L6_NANOCORE_DATA_ROOT: '/tmp/openkit-a1-restart-test',
  OPENKIT_L6_TASK_REPO_ROOT: '/tmp/openkit-a1-restart-repo',
};

test('requires explicit opt-in and a fresh configured root', () => {
  assert.equal(evaluateA1RestartConfig({}, () => false).enabled, false);
  const decision = evaluateA1RestartConfig(env, (path) => path.endsWith('.git'));
  assert.equal(decision.enabled, true);
  assert.equal(decision.config.port, 4317);
});

test('kills, restarts, and verifies the same public backend handle', async () => {
  let barrierReads = 0;
  let restarted = false;
  const handle = { id: 'handle-1', workerSessionId: 'worker-1' };
  const core = {
    app: {
      getDiagnostics: async () => ({ boot: { acceptingProductWork: true } }),
      listBackendWorkspaceHandles: async () => ({
        items: [{ ...handle, cleanupStatus: restarted ? 'cleaned' : 'pending' }],
      }),
      startTaskMode: async () => ({}),
    },
    core: {
      createThread: async () => ({ id: 'thread-1' }),
      createWorkspace: async () => ({ id: 'workspace-1' }),
      listThreadItems: async () => ({
        items: [{ status: 'completed', type: 'assistant-message' }],
      }),
    },
    repositories: { setDefault: async () => ({}) },
  };
  const result = await runA1NanoCoreRestart({
    configureRuntime: async () => ({}),
    createClient: async () => core,
    env,
    fileExists: (path) => path.endsWith('.git'),
    mkdir: () => {},
    readReconnectBarrier: () =>
      restarted
        ? { backendState: 'cleaned', finalStatusCount: 1, lastWorkerSequence: 2 }
        : {
            backendState: 'launching',
            finalStatusCount: 0,
            handoffState: 'complete',
            lastWorkerSequence: barrierReads++,
            leaseStatus: 'active',
            workerProcessKeyHash: 'hash',
          },
    startProcess: () => ({
      crash: async () => {},
      restart: () => {
        assert.equal(barrierReads, 2);
        restarted = true;
      },
      stop: async () => {},
    }),
    wait: async () => {},
  });
  assert.deepEqual(result, { cleanupStatus: 'cleaned', sameWorker: true, status: 'ok' });
});
