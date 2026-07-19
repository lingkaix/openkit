import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { resolveAgentEnvironmentPackage } from './agent-environment.js';
import { OpenShellCellController } from './openshell-cell.js';
import { ChildProcessOpenShellRunner, OpenShellCli } from './openshell-cli.js';
import { WorkerControlGateway } from './worker-control-gateway.js';
import { OpenShellWorkerGovernanceBackend } from './worker-governance-backend.js';

const OPEN_SHELL_CELL_GATEWAY_URL = 'http://127.0.0.1:17670';
const OPEN_SHELL_CELL_E2E_TIMEOUT_MS = 1_200_000;
const OPEN_SHELL_OFFICIAL_BINARY = '/usr/bin/openshell';
const describeOpenShell = process.env.OPENKIT_E2E_OPENSHELL === '1' ? describe : describe.skip;
const describeRemoteOpenShell =
  process.env.OPENKIT_E2E_REMOTE_OPENSHELL === '1' ? describe : describe.skip;

describeOpenShell('real local disposable OpenShell Cell', () => {
  it('verifies the installed gateway and local sandbox prerequisites', async () => {
    const cli = createOpenShellCli();

    await withPreparedOpenShellCell(`aepsnap_e2e_prerequisites_${Date.now()}`, async () => {
      await expect(cli.version()).resolves.toBe('0.0.80');
      await expect(
        cli.status({ gateway: 'openshell', gatewayEndpoint: OPEN_SHELL_CELL_GATEWAY_URL })
      ).resolves.toMatchObject({
        gateway: 'openshell',
        status: 'connected',
        version: '0.0.80',
      });
      await expect(
        cli.gatewayInfo({ gateway: 'openshell', gatewayEndpoint: OPEN_SHELL_CELL_GATEWAY_URL })
      ).resolves.toMatchObject({
        endpoint: OPEN_SHELL_CELL_GATEWAY_URL,
        gateway: 'openshell',
      });
    });
  });

  it(
    'runs the generic worker shim dry run in a real OpenShell sandbox',
    async () => {
      const cli = createOpenShellCli();
      const sandboxName = `openkit-e2e-worker-shim-${Date.now()}`;
      const imageRef = process.env.OPENKIT_E2E_OPENSHELL_WORKER_IMAGE ?? 'openkit/worker-codex:dev';
      const tempDir = await mkdtemp(join(tmpdir(), 'openkit-openshell-worker-shim-'));
      const packagePath = join(tempDir, 'package.json');

      await writeFile(packagePath, '{}', 'utf8');
      try {
        await withPreparedOpenShellCell(`aepsnap_e2e_worker_shim_${Date.now()}`, async () => {
          await expect(
            cli.createSandbox({
              command: [
                'openkit-worker-shim',
                '--package',
                '/openkit/config/package.json',
                '--dry-run',
              ],
              env: { OPENKIT_SESSION_DIR: '/openkit/session' },
              from: imageRef,
              gateway: 'openshell',
              gatewayEndpoint: OPEN_SHELL_CELL_GATEWAY_URL,
              labels: { 'openkit.e2e': 'worker-shim' },
              name: sandboxName,
              noKeep: true,
              uploads: [
                {
                  sourcePath: packagePath,
                  targetPath: '/openkit/config/package.json',
                },
              ],
            })
          ).resolves.toMatchObject({ name: sandboxName });
        });
      } finally {
        await rm(tempDir, { force: true, recursive: true });
      }
    },
    OPEN_SHELL_CELL_E2E_TIMEOUT_MS
  );
});

describeRemoteOpenShell('real remote disposable OpenShell Cell', () => {
  it(
    'materializes one governed sandbox and recycles the remote Cell',
    async () => {
      const sshTarget = readRequiredE2eEnv(
        'OPENKIT_E2E_REMOTE_OPENSHELL_CELL_SSH_TARGET',
        process.env.OPENKIT_E2E_REMOTE_OPENSHELL_CELL_SSH_TARGET
      );
      const gatewayUrl = readRequiredE2eEnv(
        'OPENKIT_E2E_REMOTE_OPENSHELL_GATEWAY_URL',
        process.env.OPENKIT_E2E_REMOTE_OPENSHELL_GATEWAY_URL
      );
      const imageRef = readRequiredE2eEnv(
        'OPENKIT_E2E_REMOTE_OPENSHELL_WORKER_IMAGE',
        process.env.OPENKIT_E2E_REMOTE_OPENSHELL_WORKER_IMAGE
      );
      const binary = readRequiredE2eEnv(
        'OPENKIT_E2E_REMOTE_OPENSHELL_BINARY',
        process.env.OPENKIT_E2E_REMOTE_OPENSHELL_BINARY
      );
      const gateway = process.env.OPENKIT_E2E_REMOTE_OPENSHELL_GATEWAY?.trim() || 'openshell';
      const cli = createOpenShellCli(binary);
      const store = createDemoStore();
      const turn = store.createTurn('ws_demo', 'th_demo', 'Probe the remote disposable Cell.', {
        kind: 'user',
        id: 'user_local',
      });
      const environmentPackage = resolveAgentEnvironmentPackage({
        agentSetup: createTestAgentSetup({ imageRef }),
        agentSessionId: `as_remote_cell_e2e_${Date.now()}`,
        triggerActor: turn.triggerActor,
        backend: {
          gatewayUrl,
          kind: 'openshell',
          placement: 'remote',
          workerControlBaseUrl: 'https://nanocore.example.invalid/api/worker-control',
        },
        createdAt: '2026-07-15T00:00:00.000Z',
        requestId: 'req_remote_cell_e2e',
        turn,
        userId: 'user_local',
        workspaceCwd: '/workspace',
        workspaceRoots: [],
      });
      const dataRoot = await mkdtemp(join(tmpdir(), 'openkit-remote-cell-e2e-'));
      const backend = new OpenShellWorkerGovernanceBackend({
        cellLifecycle: new OpenShellCellController({ sshTarget }),
        cli,
        dataRoot,
        deploymentId: 'e2e-remote-cell',
        gatewayName: gateway,
        gatewayUrl,
        placement: 'remote',
        workerControlGateway: new WorkerControlGateway(),
      });
      let materialized = false;

      try {
        const materialization = await backend.materialize(environmentPackage);
        materialized = true;
        expect(materialization).toMatchObject({
          backendStatus: { health: 'ready', version: '0.0.80' },
          packageSnapshotId: environmentPackage.snapshotId,
          sandbox: { state: 'created' },
        });
      } finally {
        try {
          if (materialized) {
            await backend.cleanupSession(backend.planSession(environmentPackage));
          }
        } finally {
          await rm(dataRoot, { force: true, recursive: true });
        }
      }
    },
    OPEN_SHELL_CELL_E2E_TIMEOUT_MS
  );
});

/**
 * Creates an OpenShell adapter for the fixed stock binary.
 *
 * @param binary Exact official binary used by the test, defaulting to the Linux stock path.
 * @returns OpenShell CLI adapter.
 */
function createOpenShellCli(binary = OPEN_SHELL_OFFICIAL_BINARY): OpenShellCli {
  const runner = new ChildProcessOpenShellRunner(binary);

  return new OpenShellCli({
    runner: {
      run: (args, options = {}) =>
        runner.run(args, {
          ...options,
          timeoutMs: Math.min(options.timeoutMs ?? 90_000, 90_000),
        }),
    },
  });
}

/**
 * Claims one disposable Cell, runs an operation, and recycles the Cell.
 *
 * @param ownerId Unique Cell owner id.
 * @param operation Operation that requires the claimed Cell.
 * @returns Operation result.
 * @throws The operation failure, cleanup failure, or both as an aggregate.
 */
async function withPreparedOpenShellCell<T>(
  ownerId: string,
  operation: () => Promise<T>
): Promise<T> {
  const lifecycle = new OpenShellCellController();
  let cleanupError: unknown;
  let cleanupFailed = false;
  let operationFailed = false;
  let operationError: unknown;
  let result!: T;

  try {
    await lifecycle.prepare(ownerId);
    result = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  try {
    await lifecycle.recycle(ownerId);
  } catch (error) {
    cleanupFailed = true;
    cleanupError = error;
  }

  if (operationFailed && cleanupFailed) {
    throw new AggregateError(
      [operationError, cleanupError],
      'OpenShell Cell operation and recycle both failed.'
    );
  }
  if (operationFailed) {
    throw operationError;
  }
  if (cleanupFailed) {
    throw cleanupError;
  }

  return result;
}

/**
 * Reads one required opt-in E2E environment value.
 *
 * @param name Environment variable name.
 * @param value Raw environment value.
 * @returns Trimmed non-empty value.
 * @throws When the value is absent.
 */
function readRequiredE2eEnv(name: string, value: string | undefined): string {
  const normalized = value?.trim();

  if (!normalized) {
    throw new Error(`${name} is required for the remote OpenShell Cell E2E test.`);
  }
  return normalized;
}
