import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { AgentEnvironmentPackageSchema } from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import type { FsStore } from '../lib/store.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { resolveAgentEnvironmentPackage } from './agent-environment.js';
import { OpenShellCellController } from './openshell-cell.js';
import { ChildProcessOpenShellRunner, OpenShellCli } from './openshell-cli.js';
import { renderOpenShellWorkerPolicy } from './openshell-policy.js';
import { WorkerControlGateway } from './worker-control-gateway.js';
import { OpenShellWorkerGovernanceBackend } from './worker-governance-backend.js';
import { importWorkerTranscript } from './worker-transcript.js';

const OPEN_SHELL_CELL_GATEWAY_URL = 'http://127.0.0.1:17670';
const OPEN_SHELL_CELL_E2E_TIMEOUT_MS = 1_200_000;
const OPEN_SHELL_OFFICIAL_BINARY = '/usr/bin/openshell';
const runOpenShellE2e = process.env.OPENKIT_E2E_OPENSHELL === '1';
const describeOpenShell = runOpenShellE2e ? describe : describe.skip;
const runRemoteOpenShellE2e = process.env.OPENKIT_E2E_REMOTE_OPENSHELL === '1';
const describeRemoteOpenShell = runRemoteOpenShellE2e ? describe : describe.skip;
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
    'runs the OpenKit worker shim in a real OpenShell sandbox',
    async () => {
      const cli = createOpenShellCli();
      const sandboxName = `openkit-e2e-worker-shim-${Date.now()}`;
      const imageRef = process.env.OPENKIT_E2E_OPENSHELL_WORKER_IMAGE ?? 'openkit/worker-codex:dev';
      const tempDir = await mkdtemp(join(tmpdir(), 'openkit-openshell-worker-shim-'));
      const packagePath = join(tempDir, 'package.json');
      await writeFile(
        packagePath,
        JSON.stringify({
          control: { mode: 'direct-nanocore' },
          runtime: { command: { workingDirectory: '/workspace' } },
        }),
        'utf8'
      );

      try {
        await withPreparedOpenShellCell(`aepsnap_e2e_worker_shim_${Date.now()}`, async () => {
          await expect(
            cli.createSandbox({
              command: [
                'openkit-codex-shim',
                '--package',
                '/openkit/config/package.json',
                '--dry-run',
              ],
              env: {
                OPENKIT_SESSION_DIR: '/openkit/session',
              },
              from: imageRef,
              gateway: 'openshell',
              gatewayEndpoint: OPEN_SHELL_CELL_GATEWAY_URL,
              labels: {
                'openkit.e2e': 'worker-shim',
              },
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

  it(
    'runs Codex supervision and downloads worker transcript records',
    async () => {
      const cli = createOpenShellCli();
      const sandboxName = `openkit-e2e-codex-supervision-${Date.now()}`;
      const imageRef = process.env.OPENKIT_E2E_OPENSHELL_WORKER_IMAGE ?? 'openkit/worker-codex:dev';
      const tempDir = await mkdtemp(join(tmpdir(), 'openkit-openshell-supervision-'));
      const packagePath = join(tempDir, 'package.json');
      const eventsPath = join(tempDir, 'events.jsonl');
      await writeFile(
        packagePath,
        JSON.stringify({
          runtime: {
            command: {
              workingDirectory: '/workspace',
            },
          },
        }),
        'utf8'
      );

      try {
        await withPreparedOpenShellCell(`aepsnap_e2e_supervision_${Date.now()}`, async () => {
          await cli.createSandbox({
            command: [
              'openkit-codex-shim',
              '--package',
              '/openkit/config/package.json',
              '--session-dir',
              '/openkit/session',
            ],
            env: {
              OPENKIT_AGENT_SESSION_ID: 'as_e2e_supervision',
              OPENKIT_CODEX_COMMAND: '["codex","--version"]',
              OPENKIT_CONTROL_TOKEN: 'token_e2e_supervision',
              OPENKIT_PACKAGE_SNAPSHOT_ID: 'aepsnap_e2e_supervision',
              OPENKIT_REQUEST_ID: 'req_e2e_supervision',
              OPENKIT_THREAD_ID: 'th_e2e_supervision',
              OPENKIT_TURN_ID: 'turn_e2e_supervision',
              OPENKIT_WORKSPACE_ID: 'ws_e2e_supervision',
            },
            from: imageRef,
            gateway: 'openshell',
            gatewayEndpoint: OPEN_SHELL_CELL_GATEWAY_URL,
            labels: {
              'openkit.e2e': 'codex-supervision',
            },
            name: sandboxName,
            uploads: [
              {
                sourcePath: packagePath,
                targetPath: '/openkit/config/package.json',
              },
            ],
          });
          await cli.downloadFile({
            destinationPath: eventsPath,
            gateway: 'openshell',
            gatewayEndpoint: OPEN_SHELL_CELL_GATEWAY_URL,
            name: sandboxName,
            sandboxPath: '/sandbox/openkit/session/events.jsonl',
          });

          expect(readJsonl(await readFile(eventsPath, 'utf8'))).toEqual([
            expect.objectContaining({
              event: expect.objectContaining({
                data: expect.objectContaining({
                  argv: ['codex', '--version'],
                  cwd: '/workspace',
                }),
                type: 'worker.started',
              }),
            }),
            expect.objectContaining({
              event: expect.objectContaining({
                data: expect.objectContaining({
                  exitCode: 0,
                  signal: null,
                }),
                type: 'codex.process.exited',
              }),
            }),
            expect.objectContaining({
              terminal: {
                status: 'completed',
              },
            }),
          ]);
        });
      } finally {
        await rm(tempDir, { force: true, recursive: true });
      }
    },
    OPEN_SHELL_CELL_E2E_TIMEOUT_MS
  );

  it(
    'runs direct worker control through the supervised Codex shim',
    async () => {
      const cli = createOpenShellCli();
      const gateway = new WorkerControlGateway();
      const store = createDemoStore();
      const turn = store.createTurn('ws_demo', 'th_demo', 'Run direct worker control.');
      const agent = store.getAgent('ws_demo', 'agent_codex_host');
      const tempDir = await mkdtemp(join(tmpdir(), 'openkit-openshell-direct-control-'));

      try {
        const server = await startWorkerControlServer(store, gateway);
        try {
          const packagePath = join(tempDir, 'package.json');
          const policyPath = join(tempDir, 'policy.yaml');
          const environmentPackage = AgentEnvironmentPackageSchema.parse(
            resolveAgentEnvironmentPackage({
              agent,
              agentSessionId: 'as_e2e_direct_control',
              userId: 'user_local',
              backend: {
                workerControlBaseUrl: `${server.workerFacingBaseUrl}/api/worker-control`,
                kind: 'openshell',
                sandboxImageRef:
                  process.env.OPENKIT_E2E_OPENSHELL_WORKER_IMAGE ?? 'openkit/worker-codex:dev',
              },
              createdAt: '2026-06-16T00:00:00.000Z',
              requestId: 'req_e2e_direct_control',
              turn,
              workspaceCwd: '/workspace',
              workspaceRoots: [],
            })
          );

          await withPreparedOpenShellCell(`aepsnap_e2e_direct_control_${Date.now()}`, async () => {
            const registration = gateway.registerSession(environmentPackage);
            try {
              gateway.enqueueInterrupt(
                environmentPackage.snapshotId,
                'Stop direct worker control.'
              );
              await writeFile(packagePath, JSON.stringify(environmentPackage), 'utf8');
              await writeFile(
                policyPath,
                renderOpenShellWorkerPolicy({
                  controlBaseUrl: `${server.workerFacingBaseUrl}/api/worker-control`,
                }),
                'utf8'
              );
              await cli.createSandbox({
                command: [
                  'openkit-codex-shim',
                  '--package',
                  '/openkit/config/package.json',
                  '--session-dir',
                  '/openkit/session',
                ],
                env: {
                  OPENKIT_AGENT_SESSION_ID: environmentPackage.scope.agentSessionId,
                  OPENKIT_CODEX_COMMAND: '["sh","-c","sleep 30"]',
                  OPENKIT_CONTROL_BASE_URL: `${server.workerFacingBaseUrl}/api/worker-control`,
                  OPENKIT_CONTROL_TOKEN: registration.token,
                  OPENKIT_PACKAGE_SNAPSHOT_ID: environmentPackage.snapshotId,
                  OPENKIT_REQUEST_ID: environmentPackage.scope.requestId ?? '',
                  OPENKIT_THREAD_ID: environmentPackage.scope.threadId,
                  OPENKIT_TURN_ID: environmentPackage.scope.turnId,
                  OPENKIT_WORKSPACE_ID: environmentPackage.scope.workspaceId,
                },
                from: process.env.OPENKIT_E2E_OPENSHELL_WORKER_IMAGE ?? 'openkit/worker-codex:dev',
                gateway: 'openshell',
                gatewayEndpoint: OPEN_SHELL_CELL_GATEWAY_URL,
                labels: {
                  'openkit.e2e': 'direct-control',
                },
                name: `openkit-e2e-direct-control-${Date.now()}`,
                noKeep: true,
                policyPath,
                uploads: [
                  {
                    sourcePath: packagePath,
                    targetPath: '/openkit/config/package.json',
                  },
                ],
              });

              expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)).toMatchObject({
                commands: [],
                events: expect.arrayContaining([
                  expect.objectContaining({
                    event: expect.objectContaining({
                      data: expect.objectContaining({ status: 'interrupted' }),
                      type: 'turn.failed',
                    }),
                  }),
                ]),
                heartbeat: {
                  sequence: 0,
                  status: 'starting',
                },
              });
            } finally {
              gateway.unregisterSession(environmentPackage.snapshotId);
            }
          });
        } finally {
          await server.close();
        }
      } finally {
        await rm(tempDir, { force: true, recursive: true });
      }
    },
    OPEN_SHELL_CELL_E2E_TIMEOUT_MS
  );

  it(
    'imports transcript records from a real OpenShell governed worker session',
    async () => {
      const cli = createOpenShellCli();
      const store = createDemoStore();
      const turn = store.createTurn('ws_demo', 'th_demo', 'Import a real OpenShell transcript.');
      const agent = store.getAgent('ws_demo', 'agent_codex_host');
      const sessionId = `as_e2e_import_${Date.now()}`;
      const imageRef = process.env.OPENKIT_E2E_OPENSHELL_WORKER_IMAGE ?? 'openkit/worker-codex:dev';
      const workerScript = [
        "const fs = require('node:fs');",
        "fs.mkdirSync('/openkit/session', { recursive: true });",
        "fs.mkdirSync('/openkit/artifacts', { recursive: true });",
        "fs.writeFileSync('/openkit/session/final-message.txt', 'Real OpenShell worker completed the governed turn.\\n');",
        "fs.writeFileSync('/openkit/artifacts/report.md', '# Real OpenShell Report\\n');",
        'const env = process.env;',
        "fs.appendFileSync('/openkit/session/artifacts.jsonl', JSON.stringify({ schemaVersion: 1, kind: 'artifact', workspaceId: env.OPENKIT_WORKSPACE_ID, threadId: env.OPENKIT_THREAD_ID, turnId: env.OPENKIT_TURN_ID, agentSessionId: env.OPENKIT_AGENT_SESSION_ID, packageSnapshotId: env.OPENKIT_PACKAGE_SNAPSHOT_ID, requestId: env.OPENKIT_REQUEST_ID, sequence: 7, artifact: { kind: 'report', title: 'Real OpenShell report', path: '/openkit/artifacts/report.md', mediaType: 'text/markdown' } }) + '\\n');",
      ].join('\n');
      const resolvedPackage = resolveAgentEnvironmentPackage({
        agent,
        agentSessionId: sessionId,
        userId: 'user_local',
        backend: {
          workerControlBaseUrl: 'http://127.0.0.1:9/api/worker-control',
          kind: 'openshell',
          sandboxImageRef: imageRef,
        },
        createdAt: '2026-06-16T00:00:00.000Z',
        requestId: 'req_e2e_import',
        turn,
        turnInput: 'Import a real OpenShell transcript.',
        workspaceCwd: '/workspace',
        workspaceRoots: [],
      });
      const environmentPackage = AgentEnvironmentPackageSchema.parse({
        ...resolvedPackage,
        runtime: {
          ...resolvedPackage.runtime,
          command: {
            ...resolvedPackage.runtime.command,
            argv: ['node', '-e', workerScript],
          },
        },
        extensions: {
          ...resolvedPackage.extensions,
          openkit: {
            ...(resolvedPackage.extensions.openkit as Record<string, unknown>),
            resultMessagePath: '/openkit/session/final-message.txt',
          },
        },
      });
      const dataRoot = await mkdtemp(join(tmpdir(), 'openkit-openshell-import-backend-'));
      const backend = new OpenShellWorkerGovernanceBackend({
        cellLifecycle: new OpenShellCellController(),
        cli,
        dataRoot,
        deploymentId: 'e2e-local-cell',
        gatewayName: 'openshell',
        gatewayUrl: OPEN_SHELL_CELL_GATEWAY_URL,
        workerControlGateway: new WorkerControlGateway(),
      });

      try {
        const materialization = await backend.materialize(environmentPackage);
        await backend.launch(materialization);
        const transcript = await backend.collectTranscript(environmentPackage.snapshotId);
        const importResult = importWorkerTranscript(store, environmentPackage, transcript);

        expect(importResult).toMatchObject({
          artifactIds: [expect.stringMatching(/^ar_worker_/)],
          diagnostics: [],
          itemIds: [expect.stringMatching(/^it_worker_/)],
        });
        expect(
          store
            .listThreadItems('ws_demo', 'th_demo')
            .filter((item) => item.type === 'assistant-message')
        ).toEqual([
          expect.objectContaining({
            text: 'Real OpenShell worker completed the governed turn.',
          }),
        ]);
        expect(store.listArtifacts('ws_demo')).toEqual([
          expect.objectContaining({
            title: 'Real OpenShell report',
            turnId: turn.id,
          }),
        ]);
      } finally {
        try {
          await backend.cleanupSession(backend.planSession(environmentPackage));
        } finally {
          await rm(dataRoot, { force: true, recursive: true });
        }
      }
    },
    OPEN_SHELL_CELL_E2E_TIMEOUT_MS
  );

  it(
    'collects workspace changes from a real OpenShell governed worker session',
    async () => {
      const cli = createOpenShellCli();
      const store = createDemoStore();
      const turn = store.createTurn('ws_demo', 'th_demo', 'Collect real workspace changes.');
      const agent = store.getAgent('ws_demo', 'agent_codex_host');
      const imageRef = process.env.OPENKIT_E2E_OPENSHELL_WORKER_IMAGE ?? 'openkit/worker-codex:dev';
      const repoDir = await mkdtemp(join(tmpdir(), 'openkit-openshell-workspace-repo-'));
      await writeFile(join(repoDir, 'README.md'), '# Workspace\n', 'utf8');
      execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'openkit@example.com'], {
        cwd: repoDir,
        stdio: 'ignore',
      });
      execFileSync('git', ['config', 'user.name', 'OpenKit E2E'], {
        cwd: repoDir,
        stdio: 'ignore',
      });
      execFileSync('git', ['add', 'README.md'], { cwd: repoDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'Initial workspace'], { cwd: repoDir, stdio: 'ignore' });
      const sessionId = `as_e2e_workspace_changes_${Date.now()}`;
      const resolvedEnvironmentPackage = resolveAgentEnvironmentPackage({
        agent,
        agentSessionId: sessionId,
        userId: 'user_local',
        backend: {
          workerControlBaseUrl: 'http://127.0.0.1:9/api/worker-control',
          kind: 'openshell',
          sandboxImageRef: imageRef,
        },
        createdAt: '2026-06-16T00:00:00.000Z',
        requestId: 'req_e2e_workspace_changes',
        turn,
        turnInput: 'Collect real workspace changes.',
        workspaceCwd: '/workspace/openkit',
        workspaceRoots: [
          {
            access: 'read-write',
            id: 'repo',
            sourceKind: 'host-dir',
            sourcePath: repoDir,
            workerPath: '/workspace/openkit',
          },
        ],
      });
      const repoTarget = resolvedEnvironmentPackage.workspace.inputs.find(
        (workspaceInput) => workspaceInput.id === 'repo'
      )?.target;
      if (!repoTarget) {
        throw new Error('Resolved local OpenShell workspace package omitted the repo target.');
      }
      const workerScript = [
        "const fs = require('node:fs');",
        `const repoRoot = ${JSON.stringify(repoTarget)};`,
        "fs.mkdirSync(repoRoot + '/temp/research', { recursive: true });",
        "fs.writeFileSync(repoRoot + '/temp/research/e2e_workspace_probe.md', '# E2E Workspace Probe\\n');",
        "fs.mkdirSync('/openkit/session', { recursive: true });",
        "fs.writeFileSync('/openkit/session/final-message.txt', 'Wrote E2E workspace probe.\\n');",
      ].join('\n');
      const environmentPackage = AgentEnvironmentPackageSchema.parse({
        ...resolvedEnvironmentPackage,
        runtime: {
          ...resolvedEnvironmentPackage.runtime,
          command: {
            ...resolvedEnvironmentPackage.runtime.command,
            argv: ['node', '-e', workerScript],
          },
        },
        extensions: {
          ...resolvedEnvironmentPackage.extensions,
          openkit: {
            ...(resolvedEnvironmentPackage.extensions.openkit as Record<string, unknown>),
            resultMessagePath: '/openkit/session/final-message.txt',
          },
        },
      });
      const dataRoot = await mkdtemp(join(tmpdir(), 'openkit-openshell-workspace-backend-'));
      const backend = new OpenShellWorkerGovernanceBackend({
        cellLifecycle: new OpenShellCellController(),
        cli,
        dataRoot,
        deploymentId: 'e2e-local-cell',
        gatewayName: 'openshell',
        gatewayUrl: OPEN_SHELL_CELL_GATEWAY_URL,
        workerControlGateway: new WorkerControlGateway(),
      });

      try {
        const materialization = await backend.materialize(environmentPackage, {
          workspaceRoots: [
            {
              access: 'read-write',
              id: 'repo',
              sourceKind: 'host-dir',
              sourcePath: repoDir,
              workerPath: '/workspace/openkit',
            },
          ],
        });
        await backend.launch(materialization);

        await expect(
          backend.collectWorkspaceChanges(environmentPackage.snapshotId)
        ).resolves.toEqual([
          expect.objectContaining({
            changeSet: expect.objectContaining({
              changedPaths: [
                expect.objectContaining({
                  path: 'temp/research/e2e_workspace_probe.md',
                  status: 'added',
                }),
              ],
            }),
            review: expect.objectContaining({
              status: 'pending',
            }),
            patchPayload: expect.objectContaining({
              mediaType: 'text/x-diff',
              text: expect.stringContaining('temp/research/e2e_workspace_probe.md'),
            }),
          }),
        ]);
      } finally {
        try {
          await backend.cleanupSession(backend.planSession(environmentPackage));
        } finally {
          await Promise.all([
            rm(dataRoot, { force: true, recursive: true }),
            rm(repoDir, { force: true, recursive: true }),
          ]);
        }
      }
    },
    OPEN_SHELL_CELL_E2E_TIMEOUT_MS
  );
});

describeRemoteOpenShell('real remote disposable OpenShell Cell', () => {
  it(
    'materializes through the NanoCore backend and recycles the remote Cell',
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
      const turn = store.createTurn('ws_demo', 'th_demo', 'Probe the remote disposable Cell.');
      const agent = store.getAgent('ws_demo', 'agent_codex_host');
      const resolvedPackage = resolveAgentEnvironmentPackage({
        agent,
        agentSessionId: `as_remote_cell_e2e_${Date.now()}`,
        userId: 'user_local',
        backend: {
          gatewayUrl,
          kind: 'openshell',
          placement: 'remote',
          sandboxImageRef: imageRef,
          workerControlBaseUrl: 'https://nanocore.example.invalid/api/worker-control',
        },
        createdAt: '2026-07-15T00:00:00.000Z',
        requestId: 'req_remote_cell_e2e',
        turn,
        workspaceCwd: '/workspace',
        workspaceRoots: [],
      });
      const environmentPackage = AgentEnvironmentPackageSchema.parse({
        ...resolvedPackage,
        runtime: {
          ...resolvedPackage.runtime,
          command: {
            ...resolvedPackage.runtime.command,
            argv: [
              'node',
              '-e',
              "const fs=require('node:fs');fs.mkdirSync('/openkit/session',{recursive:true});fs.writeFileSync('/openkit/session/remote-gateway-probe.txt','remote sandbox executed\\n')",
            ],
          },
        },
      });
      const dataRoot = await mkdtemp(join(tmpdir(), 'openkit-remote-cell-e2e-'));
      const probePath = join(dataRoot, 'remote-gateway-probe.txt');
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
        const launch = await backend.launch(materialization);
        await cli.downloadFile({
          destinationPath: probePath,
          gateway,
          gatewayEndpoint: gatewayUrl,
          name: backend.planSession(environmentPackage).backendSessionId,
          sandboxPath: '/sandbox/openkit/session/remote-gateway-probe.txt',
        });
        expect(materialization).toMatchObject({
          backendStatus: {
            health: 'ready',
            version: '0.0.80',
          },
          packageSnapshotId: environmentPackage.snapshotId,
          sandbox: { state: 'created' },
        });
        expect(launch.kind).toBe('openshell.launch.delegated');
        await expect(readFile(probePath, 'utf8')).resolves.toBe('remote sandbox executed\n');
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
 * Parses JSONL text.
 *
 * @param text JSONL text.
 * @returns Parsed records.
 */
function readJsonl(text: string): unknown[] {
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
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

/** Running worker-control fixture and its worker-visible address. */
interface WorkerControlServer {
  /** Closes the local HTTP listener. */
  readonly close: () => Promise<void>;
  /** Origin visible from the worker sandbox. */
  readonly workerFacingBaseUrl: string;
}

/**
 * Starts a temporary NanoCore HTTP server for real sandbox worker-control tests.
 *
 * @param store Store used by the app.
 * @param gateway Worker control gateway registered by the test.
 * @returns Worker-visible base URL and close function.
 */
async function startWorkerControlServer(
  store: FsStore,
  gateway: WorkerControlGateway
): Promise<WorkerControlServer> {
  const app = createApp({
    mode: 'server',
    store,
    workerControlGateway: gateway,
  });

  return new Promise((resolve, reject) => {
    const server = serve(
      {
        fetch: app.fetch,
        hostname: '0.0.0.0',
        port: 0,
      },
      (info) => {
        server.off('error', reject);
        resolve({
          close: () =>
            new Promise((closeResolve, closeReject) => {
              server.close((error?: Error) => {
                if (error) {
                  closeReject(error);
                  return;
                }
                closeResolve();
              });
            }),
          workerFacingBaseUrl: `http://host.openshell.internal:${info.port}`,
        });
      }
    );
    server.once('error', reject);
  });
}
