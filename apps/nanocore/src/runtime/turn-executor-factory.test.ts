import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { openCoreDb } from '../storage/db.js';
import { ensureLayout } from '../storage/fs-layout.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  createConfiguredTurnExecutor,
  createConfiguredWorkerLifecycleRuntime,
} from './turn-executor-factory.js';
import { WorkerControlGateway } from './worker-control-gateway.js';
import type {
  WorkerGovernanceBackend,
  WorkerGovernanceBackendSessionIdentity,
} from './worker-governance-backend.js';
import { WorkerGovernanceTurnExecutor } from './worker-governance-turn-executor.js';

/** Creates the durable deployment identity required by real executor construction. */
function createFactoryCoreDb() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-turn-executor-factory-'));
  ensureLayout(dataRoot);
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  return coreDb;
}

const factoryCoreDb = createFactoryCoreDb();

describe('createConfiguredTurnExecutor', () => {
  it('shares one OpenShell backend between execution and restart cleanup', async () => {
    const runtime = createConfiguredWorkerLifecycleRuntime({
      coreDb: factoryCoreDb,
      env: {},
      workerControlGateway: new WorkerControlGateway(),
    });
    expect(runtime.placement).toBe('local');
    const backend = (
      runtime.turnExecutor as unknown as {
        backend: Pick<WorkerGovernanceBackend, 'cleanupSession'>;
      }
    ).backend;
    const backendCleanup = vi.spyOn(backend, 'cleanupSession').mockResolvedValue();
    const identity: WorkerGovernanceBackendSessionIdentity = {
      agentSessionId: 'as_factory_cleanup',
      backendKind: 'openshell' as const,
      backendSessionId: 'sandbox_factory_cleanup',
      backendTarget: {
        cellTargetId: 'cell-test',
        gatewayEndpoint: null,
        gatewayName: 'openshell',
        placement: 'local' as const,
      },
      deploymentId: 'deployment_factory_cleanup',
      packageSnapshotId: 'aepsnap_factory_cleanup',
      stagingDirectoryRef: 'server/runtime/worker-backend-sessions/factory-cleanup',
      transientProviderInstanceId: null,
    };

    try {
      await runtime.cleanupBackendSession(identity);
      expect(backendCleanup).toHaveBeenCalledWith(identity);
    } finally {
      backendCleanup.mockRestore();
    }
  });

  it('defaults production execution to the OpenShell local-container executor', () => {
    const executor = createConfiguredTurnExecutor({
      coreDb: factoryCoreDb,
      env: {},
      workerControlGateway: new WorkerControlGateway(),
    });

    expect(executor).toBeInstanceOf(WorkerGovernanceTurnExecutor);
    expect(
      (executor as unknown as { awaitWorkerCompletion: unknown }).awaitWorkerCompletion
    ).toEqual(expect.any(Function));
    expect(
      (executor as unknown as { environmentBackend: { kind: string; placement?: string } })
        .environmentBackend
    ).toMatchObject({
      kind: 'openshell',
      placement: 'local',
    });
  });

  it('keeps the deterministic self-check executor override', () => {
    const executor = createConfiguredTurnExecutor({
      coreDb: factoryCoreDb,
      env: { OPENKIT_INTERNAL_SELF_CHECK_EXECUTOR: '1' },
      workerControlGateway: new WorkerControlGateway(),
    });

    expect(executor).toBeInstanceOf(SimulatedTurnExecutor);
  });

  it('selects the OpenShell local-container executor through the public worker runtime model', () => {
    const executor = createConfiguredTurnExecutor({
      coreDb: factoryCoreDb,
      env: {
        OPENKIT_CONTAINER_BACKEND: 'openshell',
        OPENKIT_CONTAINER_PLACEMENT: 'local',
        OPENKIT_OPENSHELL_WORKER_CONTROL_BASE_URL:
          'http://host.openshell.internal:54001/api/worker-control',
        OPENKIT_WORKER_RUNTIME: 'container',
      },
      workerControlGateway: new WorkerControlGateway(),
    });

    expect(executor).toBeInstanceOf(WorkerGovernanceTurnExecutor);
    expect(executor.capabilities).toMatchObject({
      approvals: false,
      artifacts: true,
      questions: false,
    });
    expect(
      (executor as unknown as { environmentBackend: object }).environmentBackend
    ).not.toHaveProperty('sandboxImageRef');
    expect(
      (executor as unknown as { environmentBackend: object }).environmentBackend
    ).not.toHaveProperty('codexModel');
    expect((executor as unknown as { backend: object }).backend).not.toHaveProperty(
      'codexConfigTomlPath'
    );
  });

  it('selects the OpenShell remote-container executor through the public worker runtime model', () => {
    const runtime = createConfiguredWorkerLifecycleRuntime({
      coreDb: factoryCoreDb,
      env: {
        OPENKIT_CONTAINER_BACKEND: 'openshell',
        OPENKIT_CONTAINER_PLACEMENT: 'remote',
        OPENKIT_OPENSHELL_CELL_SSH_TARGET: 'ubuntu@a1',
        OPENKIT_OPENSHELL_GATEWAY: 'a1-openkit',
        OPENKIT_OPENSHELL_GATEWAY_URL: 'http://127.0.0.1:27670',
        OPENKIT_OPENSHELL_WORKER_CONTROL_BASE_URL:
          'https://nanocore.example.com/api/worker-control',
        OPENKIT_WORKER_RUNTIME: 'container',
      },
      workerControlGateway: new WorkerControlGateway(),
    });
    const executor = runtime.turnExecutor;

    expect(runtime.placement).toBe('remote');
    expect(executor).toBeInstanceOf(WorkerGovernanceTurnExecutor);
    expect(
      (
        executor as unknown as {
          backend: {
            cellLifecycle: { sshTarget: string };
            gatewayName: string;
            gatewayUrl: string;
            placement: string;
          };
          environmentBackend: { gatewayUrl: string; placement: string };
        }
      ).backend
    ).toMatchObject({
      cellLifecycle: { sshTarget: 'ubuntu@a1' },
      gatewayName: 'a1-openkit',
      gatewayUrl: 'http://127.0.0.1:27670',
      placement: 'remote',
    });
    expect(
      (
        executor as unknown as {
          environmentBackend: { gatewayUrl: string; placement: string };
        }
      ).environmentBackend
    ).toMatchObject({ gatewayUrl: 'http://127.0.0.1:27670', placement: 'remote' });
  });

  it('uses the fixed loopback disposable Cell gateway for local placement', () => {
    const executor = createConfiguredTurnExecutor({
      coreDb: factoryCoreDb,
      env: {},
      workerControlGateway: new WorkerControlGateway(),
    });

    expect(
      (
        executor as unknown as {
          backend: { gatewayUrl: string };
          environmentBackend: { gatewayUrl: string; placement: string };
        }
      ).backend
    ).toMatchObject({ gatewayUrl: 'http://127.0.0.1:17670' });
    expect(
      (
        executor as unknown as {
          backend: { gatewayUrl: string };
          environmentBackend: { gatewayUrl: string; placement: string };
        }
      ).environmentBackend
    ).toMatchObject({ gatewayUrl: 'http://127.0.0.1:17670', placement: 'local' });
  });

  it.each([
    [
      'OPENKIT_OPENSHELL_CELL_SSH_TARGET',
      { OPENKIT_OPENSHELL_GATEWAY_URL: 'http://127.0.0.1:27670' },
    ],
    ['OPENKIT_OPENSHELL_GATEWAY_URL', { OPENKIT_OPENSHELL_CELL_SSH_TARGET: 'ubuntu@a1' }],
    [
      'OPENKIT_OPENSHELL_WORKER_CONTROL_BASE_URL',
      {
        OPENKIT_OPENSHELL_CELL_SSH_TARGET: 'ubuntu@a1',
        OPENKIT_OPENSHELL_GATEWAY_URL: 'http://127.0.0.1:27670',
      },
    ],
  ])('requires %s for remote-container placement', (expectedName, remoteEnv) => {
    expect(() =>
      createConfiguredTurnExecutor({
        coreDb: factoryCoreDb,
        env: {
          OPENKIT_CONTAINER_BACKEND: 'openshell',
          OPENKIT_CONTAINER_PLACEMENT: 'remote',
          OPENKIT_WORKER_RUNTIME: 'container',
          ...remoteEnv,
        },
        workerControlGateway: new WorkerControlGateway(),
      })
    ).toThrow(`${expectedName} is required when OPENKIT_CONTAINER_PLACEMENT=remote.`);
  });

  it('rejects a remote Gateway endpoint that bypasses the operator SSH tunnel', () => {
    expect(() =>
      createConfiguredTurnExecutor({
        coreDb: factoryCoreDb,
        env: {
          OPENKIT_CONTAINER_BACKEND: 'openshell',
          OPENKIT_CONTAINER_PLACEMENT: 'remote',
          OPENKIT_OPENSHELL_CELL_SSH_TARGET: 'ubuntu@a1',
          OPENKIT_OPENSHELL_GATEWAY_URL: 'https://a1.example.com:17670',
          OPENKIT_OPENSHELL_WORKER_CONTROL_BASE_URL:
            'https://nanocore.example.com/api/worker-control',
          OPENKIT_WORKER_RUNTIME: 'container',
        },
        workerControlGateway: new WorkerControlGateway(),
      })
    ).toThrow('OPENKIT_OPENSHELL_GATEWAY_URL must be a loopback HTTP origin.');
  });

  it('rejects a remote Gateway name that could be parsed as an OpenShell option', () => {
    expect(() =>
      createConfiguredTurnExecutor({
        coreDb: factoryCoreDb,
        env: {
          OPENKIT_CONTAINER_BACKEND: 'openshell',
          OPENKIT_CONTAINER_PLACEMENT: 'remote',
          OPENKIT_OPENSHELL_CELL_SSH_TARGET: 'ubuntu@a1',
          OPENKIT_OPENSHELL_GATEWAY: '--gateway-insecure',
          OPENKIT_OPENSHELL_GATEWAY_URL: 'http://127.0.0.1:27670',
          OPENKIT_OPENSHELL_WORKER_CONTROL_BASE_URL:
            'https://nanocore.example.com/api/worker-control',
          OPENKIT_WORKER_RUNTIME: 'container',
        },
        workerControlGateway: new WorkerControlGateway(),
      })
    ).toThrow('OPENKIT_OPENSHELL_GATEWAY must be a safe OpenShell gateway name.');
  });

  it.each([
    'https://user:secret@nanocore.example.com/api/worker-control',
    'file:///api/worker-control',
    'https://nanocore.example.com/private',
    'http://127.0.0.1:3000/api/worker-control',
    'http://localhost:3000/api/worker-control',
  ])('rejects an invalid remote worker-control URL: %s', (workerControlUrl) => {
    expect(() =>
      createConfiguredTurnExecutor({
        coreDb: factoryCoreDb,
        env: {
          OPENKIT_CONTAINER_BACKEND: 'openshell',
          OPENKIT_CONTAINER_PLACEMENT: 'remote',
          OPENKIT_OPENSHELL_CELL_SSH_TARGET: 'ubuntu@a1',
          OPENKIT_OPENSHELL_GATEWAY_URL: 'http://127.0.0.1:27670',
          OPENKIT_OPENSHELL_WORKER_CONTROL_BASE_URL: workerControlUrl,
          OPENKIT_WORKER_RUNTIME: 'container',
        },
        workerControlGateway: new WorkerControlGateway(),
      })
    ).toThrow(
      'OPENKIT_OPENSHELL_WORKER_CONTROL_BASE_URL must be a credential-free HTTP(S) /api/worker-control URL.'
    );
  });

  it('fails closed when container runtime selects an unsupported backend', () => {
    expect(() =>
      createConfiguredTurnExecutor({
        coreDb: factoryCoreDb,
        env: {
          OPENKIT_CONTAINER_BACKEND: 'docker',
          OPENKIT_CONTAINER_PLACEMENT: 'remote',
          OPENKIT_WORKER_RUNTIME: 'container',
        },
        workerControlGateway: new WorkerControlGateway(),
      })
    ).toThrow('Unsupported OPENKIT_CONTAINER_BACKEND: docker.');
  });

  it('rejects non-container worker runtime selection', () => {
    expect(() =>
      createConfiguredTurnExecutor({
        env: { OPENKIT_WORKER_RUNTIME: 'host' },
        workerControlGateway: new WorkerControlGateway(),
      })
    ).toThrow('Unsupported OPENKIT_WORKER_RUNTIME: host.');
  });
});
