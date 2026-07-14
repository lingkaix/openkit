import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import type { AgentEnvironmentPackage } from '@openkit/config-schema';
import { AgentEnvironmentPackageSchema } from '@openkit/config-schema';
import {
  WorkerRuntimeNativeOriginIndexEntrySchema,
  WorkerRuntimeRawStreamManifestSchema,
} from '@openkit/worker-protocol';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import type { FsStore } from '../lib/store.js';
import type {
  OpenAICompatibleChatCompletionRequest,
  OpenAICompatibleChatCompletionResponse,
  OpenAICompatibleResponsesRequest,
  OpenAICompatibleResponsesResponse,
} from '../llm/openai-compatible-client.js';
import type {
  LLMGatewayDispatchContext,
  LLMGatewayProviderDispatcher,
} from '../llm/provider-dispatcher.js';
import type { ResolvedLLMProviderConfig } from '../providers/llm-config.js';
import { ProviderRegistry } from '../providers/registry.js';
import { type CoreDb, openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { resolveAgentEnvironmentPackage } from './agent-environment.js';
import { ChildProcessOpenShellRunner, OpenShellCli } from './openshell-cli.js';
import { renderOpenShellWorkerPolicy } from './openshell-policy.js';
import { WorkerControlGateway } from './worker-control-gateway.js';
import { OpenShellWorkerGovernanceBackend } from './worker-governance-backend.js';
import { createWorkerRuntimeOriginRef } from './worker-runtime-provenance.js';
import { importWorkerTranscript } from './worker-transcript.js';

const runOpenShellE2e = process.env.OPENKIT_E2E_OPENSHELL === '1';
const describeOpenShell = runOpenShellE2e ? describe : describe.skip;
const runRemoteOpenShellE2e = process.env.OPENKIT_E2E_REMOTE_OPENSHELL === '1';
const describeRemoteOpenShell = runRemoteOpenShellE2e ? describe : describe.skip;

/** Expected byte-preserved stream returned to the raw transport identity probe. */
const RAW_IDENTITY_SSE =
  'data: {"type":"response.completed","response":{"id":"resp_raw_identity","status":"completed"}}\n\n';

/** One worker-inference dispatch observed by the same-target probe. */
interface SameTargetDispatchCall {
  /** AEP-authoritative provider selected by NanoCore. */
  readonly provider: ResolvedLLMProviderConfig;
  /** Sanitized request dispatched by NanoCore. */
  readonly request: OpenAICompatibleChatCompletionRequest | OpenAICompatibleResponsesRequest;
}

/** Product-safe transport metadata observed at the local relay boundary. */
interface WorkerInferenceRequestObservation {
  /** Whether the request carried one of the fixture's live bearer tokens. */
  readonly authenticated: boolean;
  /** Request content encoding, when declared. */
  readonly contentEncoding: string | null;
  /** HTTP method observed by the local relay. */
  readonly method: string;
  /** Worker-inference path observed by the local relay. */
  readonly path: string;
}

/** Deterministic zero-quota dispatcher used by the same-target executable probe. */
class SameTargetProbeDispatcher {
  /** Worker-inference calls accepted by the dispatcher. */
  public readonly calls: SameTargetDispatchCall[] = [];
  /** Number of upstream streams cancelled by the raw transport probe. */
  public cancellationCount = 0;

  /**
   * Returns one deterministic non-stream Chat Completions payload.
   *
   * @param provider AEP-selected provider.
   * @param request Sanitized worker request.
   * @param context Derived dispatch context.
   * @returns OpenAI-compatible zero-quota completion.
   */
  public async createChatCompletion(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleChatCompletionRequest,
    context: LLMGatewayDispatchContext = {}
  ): Promise<OpenAICompatibleChatCompletionResponse> {
    this.calls.push({ provider, request });
    context.onUsage?.({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });

    return {
      choices: [
        {
          finish_reason: 'stop',
          index: 0,
          message: { content: 'RAW_CHAT_OK', role: 'assistant' },
        },
      ],
      created: 1,
      id: 'chatcmpl_raw',
      model: request.model,
      object: 'chat.completion',
    };
  }

  /**
   * Returns one deterministic non-stream Responses payload.
   *
   * @param provider AEP-selected provider.
   * @param request Sanitized worker request.
   * @param context Derived dispatch context.
   * @returns OpenAI-compatible zero-quota response.
   */
  public async createResponses(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleResponsesRequest,
    context: LLMGatewayDispatchContext = {}
  ): Promise<OpenAICompatibleResponsesResponse> {
    this.calls.push({ provider, request });
    context.onUsage?.({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });

    return {
      id: 'resp_raw_zstd',
      model: request.model,
      object: 'response',
      output: [],
      status: 'completed',
    };
  }

  /**
   * Returns the pinned Codex success stream, a raw identity stream, or a cancellable stream.
   *
   * @param provider AEP-selected provider.
   * @param request Sanitized worker request.
   * @param context Derived dispatch context.
   * @returns OpenAI-compatible SSE bytes.
   */
  public async createResponsesStream(
    provider: ResolvedLLMProviderConfig,
    request: OpenAICompatibleResponsesRequest,
    context: LLMGatewayDispatchContext = {}
  ): Promise<ReadableStream<Uint8Array>> {
    this.calls.push({ provider, request });

    if (request.input === 'RAW_IDENTITY') {
      context.onUsage?.({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });
      return streamText(RAW_IDENTITY_SSE);
    }
    if (request.input === 'RAW_CANCEL') {
      const owner = this;

      return new ReadableStream<Uint8Array>({
        cancel() {
          owner.cancellationCount += 1;
        },
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"response.created","response":{"id":"resp_raw_cancel","status":"in_progress"}}\n\n'
            )
          );
        },
      });
    }

    context.onUsage?.({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });
    return streamText(codexSuccessSse('REMOTE_RELAY_OK'));
  }
}

describeOpenShell('real OpenShell CLI preflight', () => {
  it('verifies the installed gateway and local sandbox prerequisites', async () => {
    const cli = createOpenShellCli();

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
    const cli = createOpenShellCli();
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

  it('runs direct worker control through the supervised Codex shim', async () => {
    const cli = createOpenShellCli();
    const gateway = new WorkerControlGateway();
    const store = createDemoStore();
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run direct worker control.');
    const agent = store.getAgent('ws_demo', 'agent_codex_host');
    const server = await startWorkerControlServer(store, gateway);
    const tempDir = await mkdtemp(join(tmpdir(), 'openkit-openshell-direct-control-'));
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
    const registration = gateway.registerSession(environmentPackage);
    gateway.enqueueTerminalCommand(environmentPackage.snapshotId, {
      argv: ['pwd'],
      commandId: 'term_e2e_direct_control_1',
      cwd: '/workspace',
    });
    await writeFile(packagePath, JSON.stringify(environmentPackage), 'utf8');
    await writeFile(
      policyPath,
      renderOpenShellWorkerPolicy({
        controlBaseUrl: `${server.workerFacingBaseUrl}/api/worker-control`,
      }),
      'utf8'
    );
    const sandboxName = `openkit-e2e-direct-control-${Date.now()}`;

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
          OPENKIT_AGENT_SESSION_ID: environmentPackage.scope.agentSessionId,
          OPENKIT_CODEX_COMMAND: '["true"]',
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
        labels: {
          'openkit.e2e': 'direct-control',
        },
        name: sandboxName,
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
        commands: [
          expect.objectContaining({
            commandId: 'term_e2e_direct_control_1',
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
            commandId: 'term_e2e_direct_control_1',
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
  it('proves the pinned trusted relay on one remote gateway target', async () => {
    const openShellBinary = readRequiredEnv(
      'OPENKIT_OPENSHELL_BINARY',
      process.env.OPENKIT_OPENSHELL_BINARY
    );
    const gatewayName = readRequiredEnv(
      'OPENKIT_E2E_REMOTE_OPENSHELL_GATEWAY',
      process.env.OPENKIT_E2E_REMOTE_OPENSHELL_GATEWAY
    );
    const gatewayUrl = readRequiredEnv(
      'OPENKIT_E2E_REMOTE_OPENSHELL_GATEWAY_URL',
      process.env.OPENKIT_E2E_REMOTE_OPENSHELL_GATEWAY_URL
    );
    const workerControlBaseUrl = readRequiredEnv(
      'OPENKIT_E2E_REMOTE_OPENSHELL_WORKER_CONTROL_BASE_URL',
      process.env.OPENKIT_E2E_REMOTE_OPENSHELL_WORKER_CONTROL_BASE_URL
    );
    const workerControlPort = readRequiredIntegerEnv(
      'OPENKIT_E2E_REMOTE_OPENSHELL_LOCAL_RELAY_PORT',
      process.env.OPENKIT_E2E_REMOTE_OPENSHELL_LOCAL_RELAY_PORT
    );
    if (process.env.OPENKIT_E2E_REMOTE_OPENSHELL_GATEWAY_INSECURE === '1') {
      throw new Error('The same-target relay probe requires verified gateway TLS.');
    }
    const imageRef = readRequiredEnv(
      'OPENKIT_E2E_REMOTE_OPENSHELL_WORKER_IMAGE',
      process.env.OPENKIT_E2E_REMOTE_OPENSHELL_WORKER_IMAGE
    );
    const relayProbeImageRef = readRequiredEnv(
      'OPENKIT_E2E_REMOTE_OPENSHELL_RELAY_PROBE_IMAGE',
      process.env.OPENKIT_E2E_REMOTE_OPENSHELL_RELAY_PROBE_IMAGE
    );
    expect(imageRef).toBe('openkit/worker-codex:dev');
    expect(relayProbeImageRef).toBe('openkit/worker-relay-probe:dev');
    const gatewayTarget = {
      gateway: gatewayName,
      gatewayEndpoint: gatewayUrl,
    };
    const cli = createOpenShellCli(openShellBinary);
    const providerProfileBaseline = readOpenShellProviderProfileIds(openShellBinary, gatewayName);

    await expect(cli.version()).resolves.toBe('0.0.80');
    await expect(cli.status(gatewayTarget)).resolves.toMatchObject({
      gateway: gatewayName,
      status: 'connected',
      version: '0.0.80',
    });
    await expect(cli.gatewayInfo(gatewayTarget)).resolves.toMatchObject({
      endpoint: gatewayUrl,
      gateway: gatewayName,
    });
    expect(readOpenShellResourceNames(openShellBinary, gatewayName, 'provider')).toEqual([]);
    expect(readOpenShellResourceNames(openShellBinary, gatewayName, 'sandbox')).toEqual([]);

    let coreDb: CoreDb | null = null;
    let dataRoot: string | null = null;
    let downloadDir: string | null = null;
    let liveTokens: string[] = [];
    let relayServer: WorkerControlServer | null = null;
    let restoreProfileSpy: (() => void) | null = null;
    let restoreUpsertSpy: (() => void) | null = null;
    let workerControlGateway: WorkerControlGateway | null = null;
    const cleanupErrors: unknown[] = [];
    const dispatcher = new SameTargetProbeDispatcher();
    const materializedSessions: Array<[OpenShellWorkerGovernanceBackend, string]> = [];
    const observations: WorkerInferenceRequestObservation[] = [];
    const providerUpserts: Array<{
      credentialPresent: boolean;
      name: string;
      providerType: string;
    }> = [];
    const providerProfiles: Array<Record<string, unknown>> = [];
    let testError: unknown = null;

    try {
      dataRoot = await mkdtemp(join(tmpdir(), 'openkit-same-target-relay-data-'));
      downloadDir = await mkdtemp(join(tmpdir(), 'openkit-same-target-relay-downloads-'));
      coreDb = openCoreDb(dataRoot);
      applyMigrations(coreDb);
      const store = createDemoStore();
      liveTokens = Array.from(
        { length: 2 },
        () => `lease-binding:${randomBytes(32).toString('hex')}`
      );
      let nextToken = 0;
      workerControlGateway = new WorkerControlGateway({
        createToken: () => {
          const token = liveTokens[nextToken++];
          if (!token) {
            throw new Error('Same-target probe attempted to register more than two packages.');
          }
          return token;
        },
        resolveTokenBinding: () => ({ status: 'accepted' }),
      });
      relayServer = await startWorkerControlServer(store, workerControlGateway, {
        coreDb,
        hostname: '127.0.0.1',
        llmGatewayDispatcher: dispatcher as unknown as LLMGatewayProviderDispatcher,
        onRequest: (request) => {
          const path = new URL(request.url).pathname;

          if (!path.startsWith('/api/worker-inference/')) {
            return;
          }
          const authorization = request.headers.get('authorization');
          observations.push({
            authenticated: liveTokens.some((token) => authorization === `Bearer ${token}`),
            contentEncoding: request.headers.get('content-encoding'),
            method: request.method,
            path,
          });
        },
        port: workerControlPort,
        providerRegistry: new ProviderRegistry([
          {
            defaultModel: 'gpt-5.6-sol',
            displayName: 'Same Target Probe',
            id: 'same-target-probe',
            kind: 'gateway',
            models: ['gpt-5.6-sol'],
            vendor: 'openrouter',
          },
        ]),
        workerFacingBaseUrl: new URL(workerControlBaseUrl).origin,
      });
      const upsertProvider = cli.upsertProvider.bind(cli);
      const ensureProviderProfile = cli.ensureProviderProfile.bind(cli);
      const upsertSpy = vi.spyOn(cli, 'upsertProvider').mockImplementation(async (input) => {
        const result = await upsertProvider(input);
        providerUpserts.push({
          credentialPresent: input.credentialValue.length > 0,
          name: input.name,
          providerType: input.providerType,
        });
        return result;
      });
      restoreUpsertSpy = () => upsertSpy.mockRestore();
      const profileSpy = vi
        .spyOn(cli, 'ensureProviderProfile')
        .mockImplementation(async (input) => {
          providerProfiles.push(
            JSON.parse(await readFile(input.path, 'utf8')) as Record<string, unknown>
          );
          return ensureProviderProfile(input);
        });
      restoreProfileSpy = () => profileSpy.mockRestore();
      const codexBackend = new OpenShellWorkerGovernanceBackend({
        cli,
        gatewayName,
        gatewayUrl,
        placement: 'remote',
        retainSandboxes: false,
        sandboxSource: imageRef,
        workerControlGateway,
      });

      const codexPackage = createSameTargetRelayPackage({
        agentSessionId: `as_same_target_codex_${Date.now()}`,
        gatewayUrl,
        imageRef,
        requiredCapabilities: ['trusted-worker-inference-relay', 'worker.runtime-provenance.v1'],
        store,
        turnInput: 'Reply exactly REMOTE_RELAY_OK.',
        workerControlBaseUrl,
      });
      const codexMaterialization = await codexBackend.materialize(codexPackage);
      materializedSessions.push([codexBackend, codexPackage.snapshotId]);
      await codexBackend.launch(codexMaterialization);
      const codexTranscript = await codexBackend.collectTranscript(codexPackage.snapshotId);
      const codexFinalPath = join(downloadDir, 'codex-final-message.txt');
      await cli.downloadFile({
        destinationPath: codexFinalPath,
        ...gatewayTarget,
        name: codexMaterialization.sandbox?.name ?? '',
        sandboxPath: '/sandbox/openkit/session/final-message.txt',
      });

      await expect(readFile(codexFinalPath, 'utf8')).resolves.toBe('REMOTE_RELAY_OK');
      expect(codexTranscript.runtimeProvenance).toMatchObject({
        diagnostics: [],
        manifestPath: expect.any(String),
        missingPaths: [],
      });
      const runtimeManifestPath = codexTranscript.runtimeProvenance?.manifestPath;
      expect(runtimeManifestPath).not.toBeNull();
      const runtimeManifest = WorkerRuntimeRawStreamManifestSchema.parse(
        JSON.parse(await readFile(runtimeManifestPath ?? '', 'utf8')) as unknown
      );
      expect(runtimeManifest).toMatchObject({
        adapterVersion: '0.144.1',
        captureStatus: 'complete',
        runtimeFamily: 'codex',
      });
      expect(runtimeManifest.streams[0]).toMatchObject({
        captureStatus: 'complete',
        sourceKind: 'primary',
        stableTerminal: true,
        streamRef: 'stream-0000.jsonl',
      });
      const nativeOriginIndexPath = codexTranscript.runtimeProvenance?.nativeOriginIndexPath;
      expect(nativeOriginIndexPath).not.toBeNull();
      const nativeOrigins = readJsonl(await readFile(nativeOriginIndexPath ?? '', 'utf8')).map(
        (entry) => WorkerRuntimeNativeOriginIndexEntrySchema.parse(entry)
      );
      const nativeThreadIds = [
        ...new Set(
          nativeOrigins.flatMap((entry) => (entry.nativeThreadId ? [entry.nativeThreadId] : []))
        ),
      ];
      expect(nativeThreadIds).toHaveLength(1);
      const codexRuntimeOriginRef = createWorkerRuntimeOriginRef(
        codexPackage.snapshotId,
        nativeThreadIds[0] ?? ''
      );
      const codexCalls = dispatcher.calls.slice();
      const codexObservations = observations.slice();
      expect(codexCalls.length).toBeGreaterThan(0);
      for (const call of codexCalls) {
        expect(call).toMatchObject({
          provider: { id: 'same-target-probe' },
          request: { model: 'gpt-5.6-sol', stream: true },
        });
      }
      expect(codexObservations.length).toBeGreaterThan(0);
      for (const observation of codexObservations) {
        expect(observation).toMatchObject({
          authenticated: true,
          method: 'POST',
          path: '/api/worker-inference/v1/responses',
        });
      }

      const rawObservationStart = observations.length;
      const rawCallStart = dispatcher.calls.length;
      const relayProbeBackend = new OpenShellWorkerGovernanceBackend({
        cli,
        gatewayName,
        gatewayUrl,
        placement: 'remote',
        retainSandboxes: false,
        sandboxSource: relayProbeImageRef,
        workerControlGateway,
      });
      const rawPackage = createSameTargetRelayPackage({
        agentSessionId: `as_same_target_raw_${Date.now()}`,
        codexCommand: ['/usr/local/bin/codex', '-e', rawTransportProbeScript()],
        gatewayUrl,
        imageRef: relayProbeImageRef,
        requiredCapabilities: ['trusted-worker-inference-relay'],
        store,
        turnInput: 'Run the raw worker-inference transport probe.',
        workerControlBaseUrl,
      });
      expect(rawPackage.runtime.command.argv).toEqual([
        '/usr/local/bin/codex',
        '-e',
        rawTransportProbeScript(),
      ]);
      const rawMaterialization = await relayProbeBackend.materialize(rawPackage);
      materializedSessions.push([relayProbeBackend, rawPackage.snapshotId]);
      await relayProbeBackend.launch(rawMaterialization);
      const rawResultPath = join(downloadDir, 'transport-probe.json');
      await cli.downloadFile({
        destinationPath: rawResultPath,
        ...gatewayTarget,
        name: rawMaterialization.sandbox?.name ?? '',
        sandboxPath: '/sandbox/openkit/session/transport-probe.json',
      });
      const rawResult = JSON.parse(await readFile(rawResultPath, 'utf8')) as unknown;

      expect(rawResult).toEqual({
        cancelChunkReceived: true,
        cancelStatus: 200,
        chatContent: 'RAW_CHAT_OK',
        chatStatus: 200,
        codexVersion: 'codex-cli 0.144.1',
        directEgressDenied: true,
        getStatus: 403,
        identityBytesPreserved: true,
        identityStatus: 200,
        workerInferenceTokenPlaceholderPresent: true,
        wrongPathStatus: 403,
        zstdStatus: 200,
      });
      const rawCalls = dispatcher.calls.slice(rawCallStart);
      expect(rawCalls).toHaveLength(4);
      for (const call of rawCalls) {
        expect(call).toMatchObject({
          provider: { id: 'same-target-probe' },
          request: { model: 'gpt-5.6-sol' },
        });
      }
      await vi.waitFor(
        () => {
          expect(dispatcher.cancellationCount).toBe(1);
        },
        { timeout: 5000 }
      );
      expect(observations.slice(rawObservationStart)).toEqual([
        {
          authenticated: true,
          contentEncoding: null,
          method: 'POST',
          path: '/api/worker-inference/v1/chat/completions',
        },
        {
          authenticated: true,
          contentEncoding: null,
          method: 'POST',
          path: '/api/worker-inference/v1/responses',
        },
        {
          authenticated: true,
          contentEncoding: 'zstd',
          method: 'POST',
          path: '/api/worker-inference/v1/responses',
        },
        {
          authenticated: true,
          contentEncoding: null,
          method: 'POST',
          path: '/api/worker-inference/v1/responses',
        },
      ]);

      expect(providerUpserts).toHaveLength(2);
      expect(providerUpserts.every((provider) => provider.credentialPresent)).toBe(true);
      expect(providerUpserts.map((provider) => provider.providerType)).toEqual([
        expect.stringMatching(/^okp-local-worker-inference-[0-9a-f]{16}$/),
        providerUpserts[0]?.providerType,
      ]);
      expect(new Set(providerUpserts.map((provider) => provider.name)).size).toBe(2);
      expect(providerUpserts.map((provider) => provider.name)).toEqual([
        expect.stringMatching(/^openkit-worker-inference-[0-9a-f]{16}$/),
        expect.stringMatching(/^openkit-worker-inference-[0-9a-f]{16}$/),
      ]);
      expect(providerProfiles).toHaveLength(2);
      const relayUrl = new URL(workerControlBaseUrl);
      expect(providerProfiles[0]).toEqual({
        binaries: ['/usr/local/bin/codex', '/usr/local/lib/codex/bin/codex'],
        category: 'inference',
        credentials: [
          {
            auth_style: 'bearer',
            description: 'Package-bound scheduler lease token',
            env_vars: ['OPENKIT_WORKER_INFERENCE_TOKEN'],
            header_name: 'Authorization',
            name: 'session_token',
            query_param: '',
            required: true,
          },
        ],
        description: 'Package-bound NanoCore worker inference relay',
        display_name: 'OpenKit Worker Inference',
        endpoints: [
          {
            enforcement: 'enforce',
            host: relayUrl.hostname,
            port: Number(relayUrl.port || (relayUrl.protocol === 'https:' ? '443' : '80')),
            protocol: 'rest',
            rules: [
              { allow: { method: 'POST', path: '/api/worker-inference/v1/chat/completions' } },
              { allow: { method: 'POST', path: '/api/worker-inference/v1/responses' } },
            ],
          },
        ],
        id: providerUpserts[0]?.providerType,
        inference_capable: false,
      });
      expect(providerProfiles[1]).toEqual(providerProfiles[0]);

      const workspaceDb = openWorkspaceDb(dataRoot, 'user_local', 'ws_demo');
      try {
        applyScopedMigrations(workspaceDb);
        const calls = workspaceDb.sqlite
          .prepare(
            `SELECT call_id AS callId, package_snapshot_id AS packageSnapshotId,
                    provider_ref AS providerRef, runtime_origin_ref AS runtimeOriginRef,
                    status
             FROM capability_calls
             WHERE service_ref = 'worker-inference-gateway'
             ORDER BY started_at ASC, call_id ASC`
          )
          .all() as Array<Record<string, unknown>>;
        const codexLedgerCalls = calls.filter(
          (call) => call.packageSnapshotId === codexPackage.snapshotId
        );
        const rawLedgerCalls = calls.filter(
          (call) => call.packageSnapshotId === rawPackage.snapshotId
        );

        expect(codexLedgerCalls).toHaveLength(codexCalls.length);
        for (const call of codexLedgerCalls) {
          expect(call).toMatchObject({
            providerRef: 'same-target-probe',
            runtimeOriginRef: codexRuntimeOriginRef,
            status: 'succeeded',
          });
        }
        expect(rawLedgerCalls).toHaveLength(4);
        expect(rawLedgerCalls.map((call) => call.status)).toEqual([
          'succeeded',
          'succeeded',
          'succeeded',
          'cancelled',
        ]);
        expect(rawLedgerCalls.every((call) => call.runtimeOriginRef === null)).toBe(true);
        const audits = workspaceDb.sqlite
          .prepare(
            `SELECT outcome, error_code AS errorCode
             FROM audit_events
             WHERE action = 'capability.finish'
             ORDER BY created_at ASC, audit_event_id ASC`
          )
          .all() as Array<Record<string, unknown>>;

        expect(audits).toHaveLength(calls.length);
        expect(audits).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ outcome: 'succeeded' }),
            expect.objectContaining({
              errorCode: 'worker_inference_cancelled',
              outcome: 'cancelled',
            }),
          ])
        );
      } finally {
        workspaceDb.sqlite.close();
      }
    } catch (error) {
      testError = error;
    } finally {
      for (const [sessionBackend, packageSnapshotId] of materializedSessions.toReversed()) {
        try {
          await sessionBackend.teardown(packageSnapshotId);
        } catch (error) {
          cleanupErrors.push(error);
          await captureCleanupError(cleanupErrors, () =>
            sessionBackend.teardown(packageSnapshotId)
          );
        }
      }

      const probeProfileIds = [
        ...new Set(
          providerProfiles
            .map((profile) => profile.id)
            .filter((id): id is string => typeof id === 'string')
        ),
      ];
      for (const profileId of probeProfileIds) {
        if (!providerProfileBaseline.includes(profileId)) {
          await captureCleanupError(cleanupErrors, () =>
            deleteOpenShellProviderProfile(openShellBinary, gatewayName, profileId)
          );
        }
      }

      const cleanupGateway = workerControlGateway;
      const cleanupRelayServer = relayServer;
      if (cleanupGateway && cleanupRelayServer) {
        await captureCleanupError(cleanupErrors, async () => {
          for (const [, packageSnapshotId] of materializedSessions) {
            expect(cleanupGateway.getSessionSnapshot(packageSnapshotId)).toBeNull();
          }
          for (const token of liveTokens) {
            const response = await cleanupRelayServer.app.request(
              '/api/worker-inference/v1/responses',
              {
                body: JSON.stringify({ input: 'revoked', model: 'gpt-5.6-sol' }),
                headers: {
                  authorization: `Bearer ${token}`,
                  'content-type': 'application/json',
                },
                method: 'POST',
              }
            );
            expect(response.status).toBe(401);
          }
        });
      }
      await captureCleanupError(cleanupErrors, () => {
        expect(readOpenShellResourceNames(openShellBinary, gatewayName, 'provider')).toEqual([]);
        expect(readOpenShellResourceNames(openShellBinary, gatewayName, 'sandbox')).toEqual([]);
        expect(readOpenShellProviderProfileIds(openShellBinary, gatewayName)).toEqual(
          providerProfileBaseline
        );
      });
      if (cleanupRelayServer) {
        await captureCleanupError(cleanupErrors, () => cleanupRelayServer.close());
      }
      restoreProfileSpy?.();
      restoreUpsertSpy?.();
      const cleanupCoreDb = coreDb;
      if (cleanupCoreDb) {
        await captureCleanupError(cleanupErrors, () => cleanupCoreDb.sqlite.close());
      }
      if (dataRoot) {
        await captureCleanupError(cleanupErrors, () =>
          rm(dataRoot as string, { force: true, recursive: true })
        );
      }
      if (downloadDir) {
        await captureCleanupError(cleanupErrors, () =>
          rm(downloadDir as string, { force: true, recursive: true })
        );
      }
    }

    if (testError || cleanupErrors.length > 0) {
      throw new AggregateError(
        [...(testError ? [testError] : []), ...cleanupErrors],
        'Same-target OpenShell relay probe failed.'
      );
    }
  }, 300_000);
});

/** Inputs that define one package in the same-target executable probe. */
interface SameTargetRelayPackageInput {
  /** Unique worker session identity. */
  readonly agentSessionId: string;
  /** Optional command replacing the default Codex invocation. */
  readonly codexCommand?: string[];
  /** Remote gateway URL retained in backend metadata. */
  readonly gatewayUrl: string;
  /** Remote sandbox image. */
  readonly imageRef: string;
  /** Capabilities that the executable probe must exercise. */
  readonly requiredCapabilities: AgentEnvironmentPackage['backend']['requiredCapabilities'];
  /** Store owning the probe turn. */
  readonly store: FsStore;
  /** Prompt or probe description. */
  readonly turnInput: string;
  /** Worker-visible relay base URL. */
  readonly workerControlBaseUrl: string;
}

/**
 * Creates one remote trusted-relay package for the same-target executable probe.
 *
 * @param input Session, runtime, relay, and capability inputs.
 * @returns Canonical Agent Environment Package.
 */
function createSameTargetRelayPackage(input: SameTargetRelayPackageInput): AgentEnvironmentPackage {
  const turn = input.store.createTurn('ws_demo', 'th_demo', input.turnInput);
  const resolved = resolveAgentEnvironmentPackage({
    agent: input.store.getAgent('ws_demo', 'agent_codex_host'),
    agentSessionId: input.agentSessionId,
    backend: {
      gatewayUrl: input.gatewayUrl,
      kind: 'openshell',
      placement: 'remote',
      sandboxImageRef: input.imageRef,
      workerControlBaseUrl: input.workerControlBaseUrl,
    },
    backendRequirements: {
      allowedKinds: ['openshell'],
      preferred: 'openshell',
      requiredCapabilities: input.requiredCapabilities,
    },
    createdAt: new Date().toISOString(),
    providerSelection: {
      model: 'gpt-5.6-sol',
      providerId: 'same-target-probe',
    },
    requestId: `req_${input.agentSessionId}`,
    turn,
    turnInput: input.turnInput,
    userId: 'user_local',
    workspaceCwd: '/workspace',
    workspaceRoots: [],
  });

  if (!input.codexCommand) {
    return AgentEnvironmentPackageSchema.parse(resolved);
  }

  return AgentEnvironmentPackageSchema.parse({
    ...resolved,
    runtime: {
      ...resolved.runtime,
      command: {
        ...resolved.runtime.command,
        argv: input.codexCommand,
      },
    },
  });
}

/**
 * Builds the authoritative pinned-Codex Responses stream without a legacy done sentinel.
 *
 * @param text Final assistant text.
 * @returns OpenAI-compatible SSE bytes.
 */
function codexSuccessSse(text: string): string {
  const responseId = 'resp_same_target_codex';
  const item = {
    content: [{ annotations: [], text, type: 'output_text' }],
    id: 'msg_same_target_codex',
    role: 'assistant',
    status: 'completed',
    type: 'message',
  };
  const created = {
    response: {
      id: responseId,
      object: 'response',
      output: [],
      status: 'in_progress',
    },
    sequence_number: 0,
    type: 'response.created',
  };
  const outputDone = {
    item,
    output_index: 0,
    sequence_number: 1,
    type: 'response.output_item.done',
  };
  const completed = {
    response: {
      id: responseId,
      object: 'response',
      output: [item],
      status: 'completed',
      usage: {
        input_tokens: 0,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 0,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 0,
      },
    },
    sequence_number: 2,
    type: 'response.completed',
  };

  return [created, outputDone, completed]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
}

/**
 * Creates one byte-preserving UTF-8 stream.
 *
 * @param value Text emitted once.
 * @returns Readable byte stream.
 */
function streamText(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

/**
 * Builds the sandboxed Node transport canary executed by the worker shim.
 *
 * @returns Node script covering identity, zstd, cancellation, routing, and denied egress.
 */
function rawTransportProbeScript(): string {
  const identitySseLiteral = JSON.stringify(RAW_IDENTITY_SSE);

  return [
    "const { execFileSync } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const http = require('node:http');",
    "const { zstdCompressSync } = require('node:zlib');",
    "const { setTimeout: wait } = require('node:timers/promises');",
    'const check = (condition, message) => { if (!condition) throw new Error(message); };',
    'const fetchSignal = () => AbortSignal.timeout(15000);',
    "const waitForPackage = async () => { for (let attempt = 0; attempt < 150; attempt += 1) { if (fs.existsSync('/openkit/config/package.json')) return; await wait(100); } throw new Error('package upload deadline'); };",
    'const control = new URL(process.env.OPENKIT_CONTROL_BASE_URL);',
    "const baseUrl = control.origin + '/api/worker-inference/v1';",
    'const workerInferenceToken = process.env.OPENKIT_WORKER_INFERENCE_TOKEN;',
    "const workerInferenceTokenPlaceholderPresent = typeof workerInferenceToken === 'string' && workerInferenceToken.startsWith('openshell:resolve:');",
    "const authorization = 'Bearer ' + workerInferenceToken;",
    "const headers = { authorization, 'content-type': 'application/json' };",
    '(async () => {',
    '  await waitForPackage();',
    "  check(workerInferenceTokenPlaceholderPresent, 'worker inference token placeholder');",
    "  const codexVersion = execFileSync('/usr/local/lib/codex/bin/codex', ['--version'], { encoding: 'utf8' }).trim();",
    "  check(codexVersion === 'codex-cli 0.144.1', 'codex version');",
    "  const chat = await fetch(baseUrl + '/chat/completions', { method: 'POST', headers, body: JSON.stringify({ messages: [{ content: 'RAW_CHAT', role: 'user' }], model: 'gpt-5.6-sol', stream: false }), signal: fetchSignal() });",
    "  check(chat.status === 200, 'chat status');",
    '  const chatPayload = await chat.json();',
    "  check(chatPayload.choices?.[0]?.message?.content === 'RAW_CHAT_OK', 'chat response');",
    "  const identity = await fetch(baseUrl + '/responses', { method: 'POST', headers, body: JSON.stringify({ input: 'RAW_IDENTITY', model: 'gpt-5.6-sol', stream: true }), signal: fetchSignal() });",
    '  const identityText = await identity.text();',
    "  check(identity.status === 200, 'identity status');",
    `  check(identityText === ${identitySseLiteral}, 'identity bytes');`,
    "  const compressed = zstdCompressSync(Buffer.from(JSON.stringify({ input: 'RAW_ZSTD', model: 'gpt-5.6-sol', stream: false })));",
    "  const zstd = await fetch(baseUrl + '/responses', { method: 'POST', headers: { ...headers, 'content-encoding': 'zstd' }, body: compressed, signal: fetchSignal() });",
    "  check(zstd.status === 200, 'zstd status');",
    "  check((await zstd.json()).id === 'resp_raw_zstd', 'zstd response');",
    "  const cancelBody = JSON.stringify({ input: 'RAW_CANCEL', model: 'gpt-5.6-sol', stream: true });",
    '  const cancel = await new Promise((resolve, reject) => {',
    '    let settled = false;',
    "    const request = http.request(baseUrl + '/responses', { method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(cancelBody) } }, (response) => {",
    "      response.once('data', (chunk) => { settled = true; resolve({ chunk, status: response.statusCode }); response.destroy(); request.destroy(); });",
    "      response.once('error', (error) => { if (!settled) reject(error); });",
    '    });',
    "    request.setTimeout(15000, () => request.destroy(new Error('cancel request deadline')));",
    "    request.once('error', (error) => { if (!settled) reject(error); });",
    '    request.end(cancelBody);',
    '  });',
    "  check(cancel.status === 200 && cancel.chunk.length > 0, 'cancel stream');",
    '  await wait(250);',
    "  const get = await fetch(baseUrl + '/responses', { method: 'GET', headers: { authorization }, signal: fetchSignal() });",
    "  const wrongPath = await fetch(baseUrl + '/wrong-path', { method: 'POST', headers, body: '{}', signal: fetchSignal() });",
    '  let directEgressError;',
    "  try { await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: fetchSignal() }); } catch (error) { directEgressError = error; }",
    "  const directEgressDenied = directEgressError instanceof TypeError && directEgressError.message === 'fetch failed';",
    "  check(directEgressDenied, 'direct egress policy denial');",
    "  fs.mkdirSync('/openkit/session', { recursive: true });",
    `  fs.writeFileSync('/openkit/session/transport-probe.json', JSON.stringify({ cancelChunkReceived: cancel.chunk.length > 0, cancelStatus: cancel.status, chatContent: chatPayload.choices?.[0]?.message?.content, chatStatus: chat.status, codexVersion, directEgressDenied, getStatus: get.status, identityBytesPreserved: identityText === ${identitySseLiteral}, identityStatus: identity.status, workerInferenceTokenPlaceholderPresent, wrongPathStatus: wrongPath.status, zstdStatus: zstd.status }));`,
    "  fs.writeFileSync('/openkit/session/final-message.txt', 'Raw transport probe completed.\\n');",
    '})().catch((error) => {',
    "  fs.mkdirSync('/openkit/session', { recursive: true });",
    "  fs.writeFileSync('/openkit/session/transport-probe.json', JSON.stringify({ error: error instanceof Error ? error.message : 'raw transport probe failed' }));",
    "  fs.writeFileSync('/openkit/session/final-message.txt', 'Raw transport probe failed.\\n');",
    '});',
  ].join('\n');
}

/**
 * Creates an OpenShell adapter that honors the configured exact binary path.
 *
 * @param binary Optional explicit binary path.
 * @returns OpenShell CLI adapter.
 */
function createOpenShellCli(binary = process.env.OPENKIT_OPENSHELL_BINARY?.trim()): OpenShellCli {
  const runner = new ChildProcessOpenShellRunner(binary || 'openshell');

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
 * Reads exact resource names through the selected mTLS gateway profile.
 *
 * @param binary Exact OpenShell binary path.
 * @param gateway Gateway profile name.
 * @param resource OpenShell resource family.
 * @returns Exact resource names.
 */
function readOpenShellResourceNames(
  binary: string,
  gateway: string,
  resource: 'provider' | 'sandbox'
): string[] {
  return execFileSync(
    binary,
    [resource, 'list', '--names', '--limit', '1000', '--gateway', gateway],
    { encoding: 'utf8', killSignal: 'SIGKILL', timeout: 30_000 }
  )
    .split('\n')
    .map((name) => name.trim())
    .filter(Boolean);
}

/**
 * Reads exact provider profile ids through the selected mTLS gateway profile.
 *
 * @param binary Exact OpenShell binary path.
 * @param gateway Gateway profile name.
 * @returns Sorted built-in and custom provider profile ids.
 */
function readOpenShellProviderProfileIds(binary: string, gateway: string): string[] {
  const profiles = JSON.parse(
    execFileSync(binary, ['provider', 'list-profiles', '--output', 'json', '--gateway', gateway], {
      encoding: 'utf8',
      killSignal: 'SIGKILL',
      timeout: 30_000,
    })
  ) as Array<{ readonly id?: unknown }>;

  return profiles
    .flatMap((profile) => (typeof profile.id === 'string' ? [profile.id] : []))
    .toSorted();
}

/**
 * Deletes one custom provider profile created only for the executable probe.
 *
 * @param binary Exact OpenShell binary path.
 * @param gateway Gateway profile name.
 * @param profileId Custom provider profile id.
 */
function deleteOpenShellProviderProfile(binary: string, gateway: string, profileId: string): void {
  execFileSync(binary, ['provider', 'profile', 'delete', profileId, '--gateway', gateway], {
    encoding: 'utf8',
    killSignal: 'SIGKILL',
    timeout: 30_000,
  });
}

/**
 * Runs one cleanup step while retaining its failure for the final aggregate.
 *
 * @param errors Mutable cleanup error list.
 * @param operation Cleanup operation.
 */
async function captureCleanupError(
  errors: unknown[],
  operation: () => Promise<unknown> | unknown
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    errors.push(error);
  }
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

/** Optional dependencies and network settings for a real worker-control fixture. */
interface WorkerControlServerOptions {
  /** Core database used by durable worker inference attribution. */
  readonly coreDb?: CoreDb;
  /** Dispatcher serving authoritative worker inference responses. */
  readonly llmGatewayDispatcher?: LLMGatewayProviderDispatcher;
  /** Local interface used by the temporary relay server. */
  readonly hostname?: string;
  /** Product-safe request observer. */
  readonly onRequest?: (request: Request) => void;
  /** Local bind port. */
  readonly port?: number;
  /** Provider registry serving AEP-selected providers. */
  readonly providerRegistry?: ProviderRegistry;
  /** Worker-visible origin routed through the reverse SSH tunnel. */
  readonly workerFacingBaseUrl?: string;
}

/** Running worker-control fixture and its worker-visible address. */
interface WorkerControlServer {
  /** In-process Hono app used for post-teardown token checks. */
  readonly app: ReturnType<typeof createApp>;
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
 * @param options Optional bind and worker-visible URL settings.
 * @returns Worker-visible base URL and close function.
 */
async function startWorkerControlServer(
  store: FsStore,
  gateway: WorkerControlGateway,
  options: WorkerControlServerOptions = {}
): Promise<WorkerControlServer> {
  const app = createApp({
    ...(options.coreDb ? { coreDb: options.coreDb } : {}),
    ...(options.llmGatewayDispatcher ? { llmGatewayDispatcher: options.llmGatewayDispatcher } : {}),
    mode: 'server',
    ...(options.providerRegistry ? { providerRegistry: options.providerRegistry } : {}),
    store,
    workerControlGateway: gateway,
  });

  return new Promise((resolve, reject) => {
    const server = serve(
      {
        fetch: (request) => {
          options.onRequest?.(request);
          return app.fetch(request);
        },
        hostname: options.hostname ?? '0.0.0.0',
        port: options.port ?? 0,
      },
      (info) => {
        server.off('error', reject);
        resolve({
          app,
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
          workerFacingBaseUrl:
            options.workerFacingBaseUrl ??
            `http://${process.env.OPENKIT_E2E_OPENSHELL_RELAY_HOST ?? 'host.openshell.internal'}:${info.port}`,
        });
      }
    );
    server.once('error', reject);
  });
}
