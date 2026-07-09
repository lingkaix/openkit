import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { AgentEnvironmentPackageSchema } from '@openkit/config-schema';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { FsStore } from '../lib/store.js';
import { resolveAgentEnvironmentPackage } from './agent-environment.js';
import { OpenShellCli } from './openshell-cli.js';
import { renderOpenShellWorkerPolicy } from './openshell-policy.js';
import { WorkerControlGateway } from './worker-control-gateway.js';
import { OpenShellWorkerGovernanceBackend } from './worker-governance-backend.js';
import { importWorkerTranscript } from './worker-transcript.js';

const runOpenShellE2e = process.env.OPENKIT_E2E_OPENSHELL === '1';
const describeOpenShell = runOpenShellE2e ? describe : describe.skip;
const runRemoteOpenShellE2e = process.env.OPENKIT_E2E_REMOTE_OPENSHELL === '1';
const describeRemoteOpenShell = runRemoteOpenShellE2e ? describe : describe.skip;

describeOpenShell('real OpenShell CLI preflight', () => {
  it('verifies the installed gateway and local sandbox prerequisites', async () => {
    const cli = new OpenShellCli();

    await expect(cli.version()).resolves.toMatch(/^\d+\.\d+\.\d+/);
    await expect(cli.status()).resolves.toMatchObject({
      gateway: 'openshell',
      status: 'connected',
    });
    await expect(cli.gatewayInfo()).resolves.toMatchObject({
      endpoint: 'https://127.0.0.1:17670',
      gateway: 'openshell',
    });
    await expect(cli.doctorCheck()).resolves.toMatchObject({
      ok: true,
    });
  });

  it('runs the OpenKit worker shim in a real OpenShell sandbox', async () => {
    const cli = new OpenShellCli();
    const sandboxName = `openkit-e2e-worker-shim-${Date.now()}`;
    const imageRef = process.env.OPENKIT_E2E_OPENSHELL_WORKER_IMAGE ?? 'openkit/worker-codex:dev';

    await expect(
      cli.createSandbox({
        command: ['openkit-codex-shim', '--package', '/openkit/config/package.json', '--dry-run'],
        env: {
          OPENKIT_SESSION_DIR: '/openkit/session',
        },
        from: imageRef,
        gateway: 'openshell',
        labels: {
          'openkit.e2e': 'worker-shim',
        },
        name: sandboxName,
        noKeep: true,
      })
    ).resolves.toMatchObject({
      name: sandboxName,
    });
  }, 120_000);

  it('runs Codex supervision and downloads worker transcript records', async () => {
    const cli = new OpenShellCli();
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
    } finally {
      await cli.deleteSandbox({ gateway: 'openshell', name: sandboxName }).catch(() => undefined);
    }
  }, 120_000);

  it('relays a sidecar heartbeat to NanoCore worker control routes', async () => {
    const cli = new OpenShellCli();
    const gateway = new WorkerControlGateway();
    const store = new FsStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run sidecar relay.');
    const agent = store.getAgent('ws_demo', 'agent_codex_host');
    const server = await startWorkerControlServer(store, gateway);
    const tempDir = await mkdtemp(join(tmpdir(), 'openkit-openshell-sidecar-'));
    const policyPath = join(tempDir, 'policy.yaml');
    const environmentPackage = AgentEnvironmentPackageSchema.parse(
      resolveAgentEnvironmentPackage({
        agent,
        agentSessionId: 'as_e2e_sidecar',
        backend: {
          controlRelayUpstream: `${server.workerRelayBaseUrl}/api/worker-control`,
          kind: 'openshell',
          sandboxImageRef:
            process.env.OPENKIT_E2E_OPENSHELL_WORKER_IMAGE ?? 'openkit/worker-codex:dev',
        },
        createdAt: '2026-06-16T00:00:00.000Z',
        requestId: 'req_e2e_sidecar',
        turn,
        workspaceCwd: '/workspace',
        workspaceRoots: [],
      })
    );
    const registration = gateway.registerSession(environmentPackage);
    gateway.enqueueApprovalResult(environmentPackage.snapshotId, {
      approvalRequestId: 'approval_e2e_sidecar_1',
      decision: 'granted',
    });
    gateway.enqueueTerminalCommand(environmentPackage.snapshotId, {
      argv: ['pwd'],
      commandId: 'term_e2e_sidecar_1',
      cwd: '/workspace',
    });
    await writeFile(
      policyPath,
      renderOpenShellWorkerPolicy({
        relayUpstream: `${server.workerRelayBaseUrl}/api/worker-control`,
      }),
      'utf8'
    );
    const sandboxName = `openkit-e2e-sidecar-${Date.now()}`;

    try {
      await cli.createSandbox({
        command: [
          'openkit-worker-sidecar',
          '--control-base-url',
          'https://control.local/v1/worker-control',
          '--relay-upstream',
          `${server.workerRelayBaseUrl}/api/worker-control`,
          '--once',
        ],
        env: {
          OPENKIT_AGENT_SESSION_ID: environmentPackage.scope.agentSessionId,
          OPENKIT_CONTROL_TOKEN: registration.token,
          OPENKIT_PACKAGE_SNAPSHOT_ID: environmentPackage.snapshotId,
          OPENKIT_REQUEST_ID: environmentPackage.scope.requestId ?? '',
          OPENKIT_THREAD_ID: environmentPackage.scope.threadId,
          OPENKIT_TURN_ID: environmentPackage.scope.turnId,
          OPENKIT_WORKSPACE_ID: environmentPackage.scope.workspaceId,
        },
        from: process.env.OPENKIT_E2E_OPENSHELL_WORKER_IMAGE ?? 'openkit/worker-codex:dev',
        gateway: 'openshell',
        labels: {
          'openkit.e2e': 'sidecar-relay',
        },
        name: sandboxName,
        noKeep: true,
        policyPath,
      });

      expect(gateway.getSessionSnapshot(environmentPackage.snapshotId)).toMatchObject({
        commands: [
          expect.objectContaining({
            approvalRequestId: 'approval_e2e_sidecar_1',
            deliveredAt: expect.any(String),
            kind: 'approval-result',
          }),
          expect.objectContaining({
            commandId: 'term_e2e_sidecar_1',
            deliveredAt: expect.any(String),
            kind: 'terminal-command',
          }),
        ],
        heartbeat: {
          sequence: 0,
          status: 'starting',
        },
        terminalResults: [
          expect.objectContaining({
            commandId: 'term_e2e_sidecar_1',
            exitCode: 0,
          }),
        ],
      });
    } finally {
      await cli.deleteSandbox({ gateway: 'openshell', name: sandboxName }).catch(() => undefined);
      await server.close();
    }
  }, 120_000);

  it('imports transcript records from a real OpenShell governed worker session', async () => {
    const cli = new OpenShellCli();
    const store = new FsStore();
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
      backend: {
        controlRelayUpstream: 'http://127.0.0.1:9/api/worker-control',
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
      extensions: {
        ...resolvedPackage.extensions,
        openkit: {
          ...(resolvedPackage.extensions.openkit as Record<string, unknown>),
          codexCommand: ['node', '-e', workerScript],
          resultMessagePath: '/openkit/session/final-message.txt',
        },
      },
    });
    const backend = new OpenShellWorkerGovernanceBackend({
      cli,
      gatewayName: 'openshell',
      retainSandboxes: true,
      sandboxSource: imageRef,
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
      await backend.teardown(environmentPackage.snapshotId).catch(() => undefined);
    }
  }, 120_000);

  it('collects workspace changes from a real OpenShell governed worker session', async () => {
    const cli = new OpenShellCli();
    const store = new FsStore();
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
    const workerScript = [
      "const fs = require('node:fs');",
      "fs.mkdirSync('/workspace/openkit/temp/research', { recursive: true });",
      "fs.writeFileSync('/workspace/openkit/temp/research/e2e_workspace_probe.md', '# E2E Workspace Probe\\n');",
      "fs.mkdirSync('/openkit/session', { recursive: true });",
      "fs.writeFileSync('/openkit/session/final-message.txt', 'Wrote E2E workspace probe.\\n');",
    ].join('\n');
    const sessionId = `as_e2e_workspace_changes_${Date.now()}`;
    const environmentPackage = AgentEnvironmentPackageSchema.parse({
      ...resolveAgentEnvironmentPackage({
        agent,
        agentSessionId: sessionId,
        backend: {
          controlRelayUpstream: 'http://127.0.0.1:9/api/worker-control',
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
      }),
      extensions: {
        openkit: {
          codexCommand: ['node', '-e', workerScript],
          resultMessagePath: '/openkit/session/final-message.txt',
        },
      },
    });
    const backend = new OpenShellWorkerGovernanceBackend({
      cli,
      gatewayName: 'openshell',
      retainSandboxes: true,
      sandboxSource: imageRef,
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

      await expect(backend.collectWorkspaceChanges(environmentPackage.snapshotId)).resolves.toEqual(
        [
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
        ]
      );
    } finally {
      await backend.teardown(environmentPackage.snapshotId).catch(() => undefined);
    }
  }, 120_000);
});

describeRemoteOpenShell('real remote OpenShell backend lifecycle', () => {
  it('runs a no-quota remote governed worker session and collects workspace changes', async () => {
    const cli = new OpenShellCli();
    const store = new FsStore();
    const gateway = new WorkerControlGateway();
    const relayPort = readRequiredIntegerEnv(
      'OPENKIT_E2E_REMOTE_OPENSHELL_LOCAL_RELAY_PORT',
      process.env.OPENKIT_E2E_REMOTE_OPENSHELL_LOCAL_RELAY_PORT
    );
    const controlRelayUpstream = readRequiredEnv(
      'OPENKIT_E2E_REMOTE_OPENSHELL_CONTROL_RELAY_UPSTREAM',
      process.env.OPENKIT_E2E_REMOTE_OPENSHELL_CONTROL_RELAY_UPSTREAM
    );
    const gatewayUrl = readRequiredEnv(
      'OPENKIT_E2E_REMOTE_OPENSHELL_GATEWAY_URL',
      process.env.OPENKIT_E2E_REMOTE_OPENSHELL_GATEWAY_URL
    );
    const turn = store.createTurn('ws_demo', 'th_demo', 'Collect remote workspace changes.');
    const agent = store.getAgent('ws_demo', 'agent_codex_host');
    const imageRef =
      process.env.OPENKIT_E2E_REMOTE_OPENSHELL_WORKER_IMAGE ??
      process.env.OPENKIT_E2E_OPENSHELL_WORKER_IMAGE ??
      'openkit/worker-codex:dev';
    const repoDir = await mkdtemp(join(tmpdir(), 'openkit-remote-openshell-workspace-repo-'));
    await writeFile(join(repoDir, 'README.md'), '# Remote Workspace\n', 'utf8');
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'openkit@example.com'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'OpenKit Remote E2E'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    execFileSync('git', ['add', 'README.md'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'Initial remote workspace'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    const workerScript = [
      "const fs = require('node:fs');",
      "fs.mkdirSync('/workspace/openkit/temp/research', { recursive: true });",
      "fs.writeFileSync('/workspace/openkit/temp/research/remote_openshell_e2e_probe.md', '# Remote OpenShell E2E Probe\\n');",
      "fs.mkdirSync('/openkit/session', { recursive: true });",
      "fs.writeFileSync('/openkit/session/final-message.txt', 'Wrote remote OpenShell E2E workspace probe.\\n');",
    ].join('\n');
    const sessionId = `as_e2e_remote_workspace_changes_${Date.now()}`;
    const environmentPackage = AgentEnvironmentPackageSchema.parse({
      ...resolveAgentEnvironmentPackage({
        agent,
        agentSessionId: sessionId,
        backend: {
          controlRelayUpstream,
          gatewayUrl,
          kind: 'openshell',
          placement: 'remote',
          sandboxImageRef: imageRef,
        },
        createdAt: '2026-06-16T00:00:00.000Z',
        requestId: 'req_e2e_remote_workspace_changes',
        turn,
        turnInput: 'Collect remote workspace changes.',
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
      }),
      extensions: {
        openkit: {
          codexCommand: ['node', '-e', workerScript],
          resultMessagePath: '/openkit/session/final-message.txt',
        },
      },
    });
    const backend = new OpenShellWorkerGovernanceBackend({
      cli,
      gatewayName: process.env.OPENKIT_E2E_REMOTE_OPENSHELL_GATEWAY ?? 'a1-openkit',
      gatewayUrl,
      gatewayInsecure: process.env.OPENKIT_E2E_REMOTE_OPENSHELL_GATEWAY_INSECURE === '1',
      placement: 'remote',
      retainSandboxes: false,
      sandboxSource: imageRef,
      workerControlGateway: gateway,
    });
    const relayServer = await startWorkerControlServer(store, gateway, {
      port: relayPort,
      workerRelayBaseUrl: new URL(controlRelayUpstream).origin,
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

      await expect(backend.collectWorkspaceChanges(environmentPackage.snapshotId)).resolves.toEqual(
        [
          expect.objectContaining({
            changeSet: expect.objectContaining({
              changedPaths: [
                expect.objectContaining({
                  path: 'temp/research/remote_openshell_e2e_probe.md',
                  status: 'added',
                }),
              ],
            }),
            review: expect.objectContaining({
              status: 'pending',
            }),
            patchPayload: expect.objectContaining({
              mediaType: 'text/x-diff',
              text: expect.stringContaining('temp/research/remote_openshell_e2e_probe.md'),
            }),
          }),
        ]
      );
    } finally {
      await backend.teardown(environmentPackage.snapshotId).catch(() => undefined);
      await relayServer.close();
    }
  }, 180_000);
});

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
 * Reads a required string environment variable for an opt-in e2e test.
 *
 * @param name Environment variable name.
 * @param value Environment variable value.
 * @returns Non-empty environment variable value.
 * @throws Error when the variable is missing.
 */
function readRequiredEnv(name: string, value: string | undefined): string {
  const normalized = value?.trim();

  if (!normalized) {
    throw new Error(`${name} is required when OPENKIT_E2E_REMOTE_OPENSHELL=1.`);
  }

  return normalized;
}

/**
 * Reads a required positive integer environment variable for an opt-in e2e test.
 *
 * @param name Environment variable name.
 * @param value Environment variable value.
 * @returns Parsed integer.
 * @throws Error when the variable is missing or invalid.
 */
function readRequiredIntegerEnv(name: string, value: string | undefined): number {
  const parsed = Number.parseInt(readRequiredEnv(name, value), 10);

  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`${name} must be a TCP port number when OPENKIT_E2E_REMOTE_OPENSHELL=1.`);
  }

  return parsed;
}

/**
 * Starts a temporary NanoCore HTTP server for real sandbox worker-control relay tests.
 *
 * @param store Store used by the app.
 * @param gateway Worker control gateway registered by the test.
 * @param options Optional bind and worker-visible URL settings.
 * @returns Worker-visible relay base URL and close function.
 */
async function startWorkerControlServer(
  store: FsStore,
  gateway: WorkerControlGateway,
  options: { port?: number; workerRelayBaseUrl?: string } = {}
): Promise<{ close: () => Promise<void>; workerRelayBaseUrl: string }> {
  const app = createApp({ mode: 'server', store, workerControlGateway: gateway });

  return new Promise((resolve) => {
    const server = serve(
      {
        fetch: app.fetch,
        hostname: '0.0.0.0',
        port: options.port ?? 0,
      },
      (info) => {
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
          workerRelayBaseUrl:
            options.workerRelayBaseUrl ??
            `http://${process.env.OPENKIT_E2E_OPENSHELL_RELAY_HOST ?? 'host.openshell.internal'}:${info.port}`,
        });
      }
    );
  });
}
