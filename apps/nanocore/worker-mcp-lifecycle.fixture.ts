import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  ListHumanAttentionResponseSchema,
  StartTaskModeResponseSchema,
  SubmitConversationResponseSchema,
} from '@openkit/app-api-schemas';
import { parseWorkspaceMcpServerCatalog } from '@openkit/config-schema';
import { deriveEntityId, workspaceIdForOwner } from '@openkit/protocol';
import { buildWorkerCanonicalTerminalEventRecord } from '@openkit/worker-protocol';
import type { TestContext } from 'vitest';
import { expect, vi } from 'vitest';
import { createCoreClient } from '../../packages/core-client/src/index.js';
import { createDefaultWorkerControlGateway } from './src/app.js';
import {
  listWorkspaceCapabilityCalls,
  listWorkspaceUsageRecords,
} from './src/capability/usage-ledger.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from './src/config/runtime-config.js';
import { ProviderRegistry } from './src/providers/registry.js';
import { listSchedulerExecutionAttemptsForTurn } from './src/runtime/execution-attempt-records.js';
import {
  dispatchNanoHostHarnessOperation,
  settleNanoHostHarnessOperation,
} from './src/runtime/nanohost-harness-records.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  upsertNanoHostRuntimeTarget,
} from './src/runtime/nanohost-runtime-target.js';
import type {
  NanoHostSessionDispatch,
  NanoHostSessionEffectRequest,
} from './src/runtime/nanohost-session-dispatch.js';
import {
  executionCallIdForRequest,
  listThreadPendingRequests,
  pendingRequestItemId,
  readPendingRequest,
} from './src/runtime/pending-requests.js';
import { createConfiguredWorkerLifecycleRuntime } from './src/runtime/turn-executor-factory.js';
import { createDefaultWorkerMcpGateway } from './src/runtime/worker-mcp-gateway.js';
import { listSchedulerAdmissionEntriesForWorkspace } from './src/scheduler-records.js';
import { FileStorageAdmission } from './src/storage/artifacts/file-admission.js';
import { shutdownControlStoreWorkerClient } from './src/storage/control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './src/storage/db.js';
import { applyMigrations } from './src/storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from './src/test-support/agent-environment.js';
import {
  createAppWithLocalIdentity as createApp,
  createLoopbackAppFetch,
} from './src/test-support/app.js';
import { createDemoStore } from './src/test-support/demo-store.js';
import { testEntityId } from './src/test-support/entity-ids.js';
import { ensureLocalUser } from './src/test-support/local-user.js';
import { admitTestMcpApproval } from './src/test-support/mcp-tool-policy.js';
import { admitTestNativeEnvironment } from './src/test-support/native-environment.js';
import { observeNativeTaskStartup } from './src/test-support/native-task-admission.js';
import { operationRequest } from './src/test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from './src/workspace-membership.js';
import { WorkspaceMutationAdmission } from './src/workspace-mutation-admission.js';

// openkit-test-platform: posix

/** Original scenarios retain their request inputs and independent case bounds. */
export const capturedOutcomeCases = [
  {
    transientPreparation: false,
    entry: 'direct Task',
    refuseFirst: false,

    decision: 'granted' as const,
    ownerCommand: 'task.start',
  },
  {
    transientPreparation: false,
    entry: 'refused warm Worker conversation',
    refuseFirst: true,

    decision: 'granted' as const,
    ownerCommand: 'conversation.submit',
  },
  {
    transientPreparation: false,
    entry: 'selected warm Worker conversation',
    refuseFirst: false,

    decision: 'granted' as const,
    ownerCommand: 'conversation.submit',
  },
  {
    transientPreparation: true,
    entry: 'transient preparation refused Worker conversation',
    refuseFirst: true,

    decision: 'granted' as const,
    ownerCommand: 'conversation.submit',
  },
] as const;

/** Runs the original public captured-outcome predicates in one isolated file context. */
export async function assertCapturedOutcome(
  {
    transientPreparation,
    ownerCommand,
    refuseFirst,
    decision,
  }: (typeof capturedOutcomeCases)[number],
  { signal: caseSignal }: TestContext
) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-mcp-lifecycle-'));
  const exportRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-mcp-lifecycle-export-'));
  const callFile = join(dataRoot, 'mcp-calls.txt');
  const coreDb = openCoreDb(dataRoot);
  const fileAdmission = new FileStorageAdmission(dataRoot, () => 1_000_000n);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  });
  const agentSetup = createTestAgentSetup({
    requiredCapabilities: ['trusted-worker-inference-relay'],
    mcpIds: ['echo'],
  });
  admitTestNativeEnvironment(coreDb, agentSetup.manifest);
  let repositoryApprovalId: string | null = null;
  const catalog = parseWorkspaceMcpServerCatalog({
    schemaVersion: 1,
    servers: [
      {
        allowedTools: ['echo'],
        enabled: true,
        id: 'echo',
        schemaPolicy: 'tracking',
        timeoutMs: 2_000,
        transport: {
          args: [
            fileURLToPath(new URL('./src/test-support/mcp-stdio-stub.mjs', import.meta.url)),
            callFile,
          ],
          command: process.execPath,
          kind: 'stdio',
        },
      },
    ],
  });
  const lifecyclePolicy = admitTestMcpApproval({
    coreDb,
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    serverId: 'echo',
    toolName: 'echo',
    userId: 'usr_00000000-0000-7000-8000-000000000001',
    threadId: 'th_00000000-0000-7000-8000-000000000001',
    turnId: testEntityId('tu', 'lifecycle-policy'),
  });
  const runtimeConfigManager = createRuntimeConfigManager({
    dataRoot,
    initialSnapshot: createInMemoryRuntimeConfigSnapshot({
      agentManifests: [agentSetup.manifest],
      dataRoot,
      gatewayConfig: createTestGatewayConfig(),
      openKitConfig: {
        defaults: { defaultAgentId: agentSetup.manifest.id },
        policy: { mediation: lifecyclePolicy },
      },
      providerRegistry: new ProviderRegistry([
        {
          displayName: 'Agent OpenRouter',
          id: 'agent-openrouter',
          kind: 'local',
          models: ['openai/gpt-5.2'],
        },
      ]),
      workspaceConfigs: [
        {
          config: {
            schemaVersion: 1,
            workspace: {
              agents: [{ agentId: agentSetup.manifest.id, profileId: 'default' }],
              defaultAgentId: agentSetup.manifest.id,
              name: 'Demo Workspace',
            },
          },
          path: join(
            dataRoot,
            'workspaces',
            'ws_00000000-0000-7000-8000-000000000001',
            'config',
            'workspace.jsonc'
          ),
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        },
      ],
      workspaceMcpServerCatalogs: [
        {
          catalog,
          path: join(
            dataRoot,
            'workspaces',
            'ws_00000000-0000-7000-8000-000000000001',
            'config',
            'catalog/catalog.json'
          ),
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        },
      ],
    }),
  });
  const target = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
    deploymentId: 'deployment_mcp_lifecycle',
    identityId: 'identity_mcp_lifecycle',
    observedAt: '2026-09-03T00:00:00.000Z',
    targetId: 'target_local',
  });
  upsertNanoHostRuntimeTarget(coreDb, {
    ...target,
    freshEmpty: true,
    observedAt: '2026-09-03T00:00:01.000Z',
    physicalEpoch: 'a'.repeat(64),
    predecessorFenced: true,
    ready: true,
  });
  const terminalEvents = new Map<string, Buffer>();
  let liveCaptureCount = 0;
  const sandboxSessionRoot = join(dataRoot, 'sandbox-sessions');
  let liveFilePath = '';
  const nanoHostSessionDispatch: NanoHostSessionDispatch = {
    async effect(
      requestOrConnection: object,
      carriedRequest?: NanoHostSessionEffectRequest
    ): Promise<unknown> {
      const request = carriedRequest ?? (requestOrConnection as NanoHostSessionEffectRequest);
      if (request.kind === 'image.acquire') return { digest: `sha256:${'a'.repeat(64)}` };
      if (request.kind === 'image.inspect') {
        return {
          digest: request.input.imageDigest,
          environmentDefaults: {
            defaultsDigest:
              'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
            values: {},
          },
          platform: { architecture: 'arm64', os: 'linux' },
          storageLayout: {
            family: 'openkit-worker',
            gid: 1000,
            targets: [{ target: '/openkit/threads' }, { target: '/workspace' }],
            uid: 1000,
            version: '1',
            workingDirectory: '/workspace',
          },
        };
      }
      if (request.kind === 'sandbox.create') {
        return {
          sandboxId: request.input.sandboxId,
          state: 'created',
          storage: {
            ...request.input.storage,
            targets: request.input.storage.targets.map((target) => ({
              ...target,
              initialized: true,
            })),
          },
        };
      }
      if (request.kind === 'workspace.collect') {
        // This source-less fixture accepts the real empty baseline before native Turn admission.
        return request.input.mode === 'baseline'
          ? {
              requestId: request.requestId,
              outcome: 'baseline',
              head: {
                tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
                manifest: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
              },
            }
          : { requestId: request.requestId, outcome: 'no_new_head', unstable: false };
      }
      if (request.kind === 'reference.import') return { state: 'imported' };
      if (request.kind === 'bridge.open') {
        return { accepted: true, integrationReady: true, state: 'open' };
      }
      if (request.kind === 'file.export') {
        if (request.input.purpose === 'artifact-submission') {
          expect(request.signal).toBeInstanceOf(AbortSignal);
          liveCaptureCount += 1;
          expect(request.input.maxByteLength).toBe(1_000_000_001);
          const directory = mkdtempSync(join(exportRoot, 'live-'));
          const stagingPath = join(directory, 'body');
          expect(request.input.slot).toBe('turn-output');
          expect(request.input.relativePath).toMatch(/^[A-Za-z0-9_-]+\/outputs\/submitted\.md$/);
          expect(join(sandboxSessionRoot, request.input.relativePath)).toBe(liveFilePath);
          const liveFileBytes = readFileSync(liveFilePath);
          writeFileSync(stagingPath, liveFileBytes);
          return {
            stagingPath,
            byteLength: liveFileBytes.length,
            sha256: `sha256:${createHash('sha256').update(liveFileBytes).digest('hex')}`,
          };
        }
        if (request.input.presence === 'optional') return { state: 'absent' };
        const relativePath = String(request.input.relativePath);
        const packageSnapshotId = String(request.input.packageSnapshotId);
        const bytes = relativePath.endsWith('events.jsonl')
          ? terminalEvents.get(packageSnapshotId)
          : Buffer.alloc(0);
        if (!bytes) throw new Error('The terminal transcript is unavailable.');
        const directory = mkdtempSync(join(exportRoot, 'result-'));
        const stagingPath = join(directory, 'payload');
        writeFileSync(stagingPath, bytes);
        return {
          byteLength: bytes.byteLength,
          sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          stagingPath,
        };
      }
      if (request.kind === 'bridge.close' || request.kind === 'sandbox.delete') {
        return { state: 'deleted' };
      }
      throw new Error(`Unexpected NanoHost effect: ${request.kind}`);
    },
    async poll() {
      return null;
    },
    async result() {},
    async route() {
      throw new Error('Unexpected semantic route.');
    },
  };
  const workerControlGateway = createDefaultWorkerControlGateway(coreDb);
  const workerMcpGateway = createDefaultWorkerMcpGateway(coreDb);
  const workspaceMutationAdmission = new WorkspaceMutationAdmission();
  const startup = observeNativeTaskStartup(store);
  const workerLifecycleRuntime = createConfiguredWorkerLifecycleRuntime({
    fileAdmission,
    coreDb,
    readRuntimeConfig: () => runtimeConfigManager.current(),
    env: {},
    nanoHostSessionDispatch,
    store,
    workerControlGateway,
    workspaceMutationAdmission,
  });
  const execution = vi.spyOn(workerLifecycleRuntime.turnExecutor, 'startTurn');
  let firstTurnId: string | undefined;
  const firstResult = Promise.withResolvers<void>();
  void firstResult.promise.catch(() => undefined);
  const updateItem = store.updateItem.bind(store);
  const resultPublication = vi
    .spyOn(store, 'updateItem')
    .mockImplementation((id, input, admission) => {
      const publication = updateItem(id, input, admission);
      if (
        firstTurnId &&
        id === deriveEntityId('it', ['worker-result', firstTurnId]) &&
        'level' in input &&
        input.level === 'info'
      ) {
        void publication.then(() => firstResult.resolve(), firstResult.reject);
      }
      return publication;
    });
  const app = createApp({
    fileAdmission,
    coreDb,
    dataRoot,
    nanoHostSessionDispatch,
    runtimeConfigManager,
    store,
    workerControlGateway,
    workerLifecycleRuntime,
    workerMcpGateway,
    workspaceMutationAdmission,
  });

  const dispatchNext = async (
    operation:
      | 'session.open'
      | 'turn.start'
      | 'turn.interrupt'
      | 'session.inspect'
      | 'session.close'
  ) => {
    while (!caseSignal.aborted) {
      const bindings = coreDb.sqlite
        .prepare(`SELECT sandbox_integration_binding_ref AS integrationRef
            FROM sandbox_runtime_records`)
        .all() as { integrationRef: string }[];
      let binding: { integrationRef: string } | undefined;
      let command: ReturnType<typeof dispatchNanoHostHarnessOperation> = null;
      for (const candidate of bindings) {
        command = dispatchNanoHostHarnessOperation(coreDb, {
          sandboxIntegrationBindingRef: candidate.integrationRef,
        });
        if (command) {
          binding = candidate;
          break;
        }
      }
      if (command) {
        if (operation === 'turn.start' && command.operation === 'session.inspect') {
          command = await workerLifecycleRuntime.acceptNanoHostHarnessCommand(command);
          await settle(
            { command, integrationRef: binding!.integrationRef },
            {
              childState: 'absent',
              cleanupState: 'clean',
              nativeHandleDigest: 'b'.repeat(64),
              nativeHandleState: 'ready',
              state: 'open',
            }
          );
          continue;
        }
        expect(command.operation).toBe(operation);
        command = await workerLifecycleRuntime.acceptNanoHostHarnessCommand(command);
        return { command, integrationRef: binding!.integrationRef };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    throw new Error(
      `Expected queued NanoHost Harness operation: ${operation}; Turns: ${JSON.stringify(
        store
          .listThreads('ws_00000000-0000-7000-8000-000000000001')
          .flatMap((thread) => store.listThreadTurns(workspaceIdForOwner(thread.owner), thread.id))
          .map((turn) => ({ id: turn.id, status: turn.status, error: turn.error }))
      )}; Queue: ${JSON.stringify(coreDb.sqlite.prepare('SELECT status, denial_reason FROM scheduler_admission_entries').all())}`
    );
  };
  const settle = async (
    dispatched: Awaited<ReturnType<typeof dispatchNext>>,
    body: Readonly<Record<string, unknown>>
  ) => {
    const result = {
      body,
      disposition: 'succeeded' as const,
      harnessInstanceId: dispatched.command.harnessInstanceId,
      operationId: dispatched.command.operationId,
      schemaVersion: 2 as const,
      sequence: dispatched.command.sequence,
    };
    settleNanoHostHarnessOperation(coreDb, {
      result,
      sandboxIntegrationBindingRef: dispatched.integrationRef,
      timestamp: new Date().toISOString(),
    });
    await workerLifecycleRuntime.acceptNanoHostHarnessResult(result);
  };
  const driveTask = async (blocked: boolean) => {
    if (blocked) {
      const opened = await dispatchNext('session.open');
      await settle(opened, {
        maxActiveTurns: opened.command.body.maxActiveTurns,
        nativeHandleDigest: null,
        nativeHandleState: 'pending',
        state: 'open',
      });
    }
    const started = await dispatchNext('turn.start');
    await settle(started, {
      nativeHandleDigest: blocked ? null : 'b'.repeat(64),
      nativeHandleState: blocked ? 'pending' : 'ready',
      state: 'started',
    });
    const commandBody = started.command.body as Record<string, unknown>;
    const capabilityToken = String(commandBody.capabilityToken);
    const workerControlToken = String(commandBody.workerControlToken);
    const environmentPackage = workerControlGateway.authenticatePackageToken(
      `Bearer ${capabilityToken}`,
      { tokenFamily: 'capability' }
    );
    await startup.waitFor(environmentPackage.scope.turnId);
    expect(environmentPackage.workspace.inputs.every((input) => input.kind === 'generated')).toBe(
      true
    );
    expect(environmentPackage.workspace.outputs).toEqual([
      {
        id: 'turn-output-root',
        path: `/openkit/sessions/${environmentPackage.scope.agentSessionId}/outputs`,
        registerAsArtifacts: true,
        retention: 'sync-on-turn-end',
      },
    ]);
    const localOutputRoot = join(
      sandboxSessionRoot,
      environmentPackage.scope.agentSessionId,
      'outputs'
    );
    mkdirSync(localOutputRoot, { recursive: true });
    liveFilePath = join(localOutputRoot, 'submitted.md');
    writeFileSync(liveFilePath, 'Captured by the existing configured runtime.\n');
    const lineage = {
      agentSessionId: environmentPackage.scope.agentSessionId,
      packageSnapshotId: environmentPackage.snapshotId,
      requestId: environmentPackage.scope.requestId,
      threadId: environmentPackage.scope.threadId,
      turnId: environmentPackage.scope.turnId,
      workspaceId: environmentPackage.scope.workspaceId,
    };
    const processKey = createHash('sha256')
      .update(`process:${environmentPackage.snapshotId}`)
      .digest('base64url');
    const heartbeat = await app.request('/api/worker-control/heartbeat', {
      body: JSON.stringify({
        body: {
          message: null,
          processKeyHash: createHash('sha256')
            .update(Buffer.from(processKey, 'base64url'))
            .digest('base64url'),
          status: 'starting',
        },
        lineage,
        operation: 'heartbeat',
        schemaVersion: 2,
        sequence: 0,
      }),
      headers: {
        authorization: `Bearer ${workerControlToken}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    expect(heartbeat.status, await heartbeat.clone().text()).toBe(200);

    const work = new Client({ name: 'submission-composition-test', version: '1.0.0' });
    await work.connect(
      new StreamableHTTPClientTransport(
        new URL('http://nanocore.test/api/worker-capabilities/mcp/openkit-work'),
        {
          fetch: (request, init) => app.fetch(new Request(request, init)),
          requestInit: { headers: { authorization: `Bearer ${capabilityToken}` } },
        }
      )
    );
    const discovery = await work.listTools();
    expect(
      discovery.tools.find((tool) => tool.name === 'work_artifact_submit')?.description
    ).toContain(environmentPackage.workspace.outputs[0]!.path);
    const submission = {
      requestId: `capture-${environmentPackage.scope.turnId}`,
      path: `${environmentPackage.workspace.outputs[0]!.path}/submitted.md`,
      kind: 'report',
      title: 'Captured report',
      mediaType: 'text/markdown',
    };
    const beforeRefusal = liveCaptureCount;
    await expect(
      work.callTool({
        name: 'work_artifact_submit',
        arguments: {
          ...submission,
          requestId: `path-refusal-${environmentPackage.scope.turnId}`,
          path: '/workspace/.openkit/cache/escape.md',
        },
      })
    ).rejects.toMatchObject({ data: { code: 'invalid_request' } });
    expect(liveCaptureCount).toBe(beforeRefusal);
    const originalBytes = readFileSync(liveFilePath);
    writeFileSync(liveFilePath, capabilityToken);
    await expect(
      work.callTool({
        name: 'work_artifact_submit',
        arguments: {
          ...submission,
          requestId: `credential-refusal-${environmentPackage.scope.turnId}`,
        },
      })
    ).rejects.toMatchObject({ data: { code: 'invalid_request' } });
    expect(
      store
        .listArtifacts('ws_00000000-0000-7000-8000-000000000001')
        .filter((artifact) => artifact.turnId === environmentPackage.scope.turnId)
    ).toHaveLength(0);
    expect(store.getTurnById(environmentPackage.scope.turnId).status).toBe('running');
    writeFileSync(liveFilePath, originalBytes);
    const capturesBefore = liveCaptureCount;
    const submitted = await work.callTool({
      name: 'work_artifact_submit',
      arguments: submission,
    });
    expect(submitted.isError).toBe(false);
    const artifactId = String(submitted.structuredContent!.artifactId);
    const readback = await app.request(
      ...operationRequest('artifact.read', {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        artifactId,
      })
    );
    expect(readback.status).toBe(200);
    expect(await readback.json()).toMatchObject({
      id: artifactId,
      content: {
        format: 'file',
        mediaType: 'text/markdown',
        byteLength: originalBytes.byteLength,
      },
    });
    // The public descriptor is not a byte oracle; read the exact immutable original.
    const downloadOriginal = async () => {
      const downloaded = await app.request(
        `/api/app/operations/artifact.download?${new URLSearchParams({
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          artifactId,
          artifactVersion: '1',
        })}`
      );
      expect(downloaded.status).toBe(200);
      expect(downloaded.headers.get('x-openkit-content-digest')).toBe(
        `sha256:${createHash('sha256').update(originalBytes).digest('hex')}`
      );
      return Buffer.from(await downloaded.arrayBuffer());
    };
    expect(await downloadOriginal()).toEqual(originalBytes);
    const publishedBytes = readFileSync(liveFilePath);
    writeFileSync(liveFilePath, 'A later edit cannot mutate the committed output.');
    expect(
      (await work.callTool({ name: 'work_artifact_submit', arguments: submission }))
        .structuredContent!.artifactId
    ).toBe(artifactId);
    expect(liveCaptureCount).toBe(capturesBefore + 1);
    expect(await downloadOriginal()).toEqual(publishedBytes);
    await work.close();
    const client = new Client({ name: 'public-task-lifecycle-test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://nanocore.test/api/worker-capabilities/mcp/${'echo'}`),
        {
          fetch: (request, init) => app.fetch(new Request(request, init)),
          requestInit: { headers: { authorization: `Bearer ${capabilityToken}` } },
        }
      )
    );
    await client.listTools();
    let toolCall: unknown = null;
    if (blocked) {
      const result = await client.callTool({
        name: 'echo',
        arguments: { message: 'public-task' },
      });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { status: 'pending-approval' },
      });
      repositoryApprovalId = String(result.structuredContent!.requestId);
      toolCall = result;
      expect(existsSync(callFile)).toBe(false);
    } else {
      const deliveryDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      try {
        expect(readPendingRequest(deliveryDb.sqlite, repositoryApprovalId!)?.delivery).toBe(
          'delivered'
        );
        const inputText = JSON.stringify(environmentPackage);
        expect(inputText).toContain(repositoryApprovalId);
        if (refuseFirst) expect(inputText).toContain('Continue after refused admission.');
      } finally {
        deliveryDb.sqlite.close();
      }
    }
    await client.close();
    const terminalBody = {
      evidenceManifestDigests: {},
      status: 'completed' as const,
      stopReason: 'completed',
    };
    terminalEvents.set(
      environmentPackage.snapshotId,
      Buffer.from(
        `${JSON.stringify(
          buildWorkerCanonicalTerminalEventRecord({
            data: terminalBody,
            lineage,
            sequence: 1,
          })
        )}\n`
      )
    );
    const finalStatus = await app.request('/api/worker-control/final-status', {
      body: JSON.stringify({
        body: terminalBody,
        lineage,
        operation: 'final_status',
        schemaVersion: 2,
        sequence: 1,
      }),
      headers: {
        authorization: `Bearer ${workerControlToken}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });
    expect(finalStatus.status, await finalStatus.clone().text()).toBe(200);
    const inspected = await dispatchNext('session.inspect');
    await settle(inspected, {
      childState: 'absent',
      cleanupState: 'clean',
      nativeHandleDigest: 'b'.repeat(64),
      nativeHandleState: 'ready',
      state: 'open',
    });
    // The inspection result releases the executor; join its publication before fixture teardown.
    const running = execution.mock.calls.findIndex(
      ([, turnId]) => turnId === environmentPackage.scope.turnId
    );
    if (running < 0) throw new Error('Expected the admitted Task execution.');
    await execution.mock.results[running]!.value;
    return { agentSessionId: environmentPackage.scope.agentSessionId, toolCall };
  };

  try {
    const firstRequest = app.request(
      ...operationRequest(
        ownerCommand,
        {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
        },
        {
          body: JSON.stringify({
            input: 'Implement the bounded MCP Task fix.',
            requestId: '0190f4c8-0000-7000-8000-000000000501',
            ...(ownerCommand === 'conversation.submit'
              ? {
                  artifactRefs: [],
                  targetRef: `warm-worker:${agentSetup.manifest.id}:default`,
                }
              : {}),
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      )
    );
    const admittedFirstRequest = firstRequest.then(async (response) => {
      expect(response.status, await response.clone().text()).toBe(202);
      return response;
    });
    // Observe Harness dispatch after durable admission.
    const firstResponse = await admittedFirstRequest;
    expect(firstResponse.status, await firstResponse.clone().text()).toBe(202);
    const firstTask =
      ownerCommand === 'conversation.submit'
        ? SubmitConversationResponseSchema.parse(await firstResponse.json())
        : StartTaskModeResponseSchema.parse(await firstResponse.json());
    firstTurnId = firstTask.turn.id;
    const firstRun = await driveTask(true);
    // Task closeout includes native release and the conversation's final display publication.
    const started = execution.mock.calls.findIndex(([, turnId]) => turnId === firstTask.turn.id);
    expect(started).toBeGreaterThanOrEqual(0);
    await execution.mock.results[started]!.value;
    if (ownerCommand === 'conversation.submit') await firstResult.promise;
    expect(
      listSchedulerExecutionAttemptsForTurn(coreDb, {
        workspaceId: workspaceIdForOwner(firstTask.turn.owner),
        threadId: firstTask.turn.threadId,
        turnId: firstTask.turn.id,
      }).every((attempt) => attempt.phase === 'closed')
    ).toBe(true);
    const durableTurn = store.getTurnById(firstTask.turn.id);
    if (ownerCommand === 'conversation.submit') {
      expect(durableTurn.threadId).not.toBe('th_00000000-0000-7000-8000-000000000001');
      expect(
        store.getThread(workspaceIdForOwner(durableTurn.owner), durableTurn.threadId).parentThreadId
      ).toBe('th_00000000-0000-7000-8000-000000000001');
    }
    expect(durableTurn.status).toBe('completed');
    if ('outcome' in firstTask) expect(firstTask.outcome).toBe('accepted');
    expect(store.getAgentSession(firstRun.agentSessionId).status).toBe('idle');
    expect(
      store
        .listCommandRequests()
        .filter(
          (receipt) => receipt.response.kind === 'turn' && receipt.response.id === firstTask.turn.id
        )
        .map((receipt) => receipt.command)
    ).toEqual([ownerCommand]);
    // Settled owner replay is compared across all three projections without another Worker launch.
    const replayInput = {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: 'th_00000000-0000-7000-8000-000000000001',
      input: 'Implement the bounded MCP Task fix.',
      requestId: '0190f4c8-0000-7000-8000-000000000501',
      ...(ownerCommand === 'conversation.submit'
        ? { artifactRefs: [], targetRef: `warm-worker:${agentSetup.manifest.id}:default` }
        : {}),
    };
    const nativeClient = createCoreClient({
      baseUrl: 'http://nanocore.test',
      fetch: createLoopbackAppFetch(app),
    });
    const replayResponse = await app.request(
      ...operationRequest(ownerCommand, {}, { body: JSON.stringify(replayInput) })
    );
    expect(replayResponse.status, await replayResponse.clone().text()).toBe(202);
    const replayResult = await replayResponse.json();
    expect(await nativeClient.operations[ownerCommand](replayInput as never)).toEqual(replayResult);
    const { operationCatalog } = await import(
      new URL('../../skills/openkit-operations.mjs', import.meta.url).href
    );
    const cliOperation = operationCatalog.find(
      (entry: { id: string }) => entry.id === ownerCommand
    )!;
    expect(
      await cliOperation.handler(
        { client: nativeClient },
        cliOperation.inputSchema.parse(replayInput)
      )
    ).toEqual(replayResult);
    expect(repositoryApprovalId).not.toBeNull();
    const attentionResponse = await app.request(
      ...operationRequest(
        'attention.list',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        undefined
      )
    );
    expect(
      ListHumanAttentionResponseSchema.parse(await attentionResponse.json()).items
    ).toContainEqual(
      expect.objectContaining({
        id: `approval:${repositoryApprovalId}`,
        actions: expect.arrayContaining([expect.objectContaining({ kind: 'grant_approval' })]),
      })
    );
    const originalSnapshot = runtimeConfigManager.current();
    const preparationFailure = new Error('Transient pending outcome preparation failure');
    const preparationFault = transientPreparation
      ? vi
          .spyOn(workerLifecycleRuntime.turnExecutor, 'prepareAgentSessionForTurn')
          .mockRejectedValue(preparationFailure)
      : undefined;
    const providerFault =
      refuseFirst && !transientPreparation
        ? vi.spyOn(runtimeConfigManager, 'current').mockReturnValue({
            ...originalSnapshot,
            providerRegistry: new ProviderRegistry([]),
          })
        : undefined;
    const detailResponse = await app.request('/api/app/operations/thread.dashboard', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        threadId: firstTask.turn.threadId,
      }),
    });
    expect(detailResponse.status, await detailResponse.clone().text()).toBe(200);
    const detailDashboard = await detailResponse.json();
    expect(
      detailDashboard.pendingRequests.find(
        (row: { requestId: string }) => row.requestId === repositoryApprovalId
      )
    ).toMatchObject({ approvalEffect: { status: 'available' }, canRespond: true });
    const responseInput = {
      decision,
      requestId: '0190f4c8-0000-7000-8000-000000000502',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: firstTask.turn.threadId,
      turnId: firstTask.turn.id,
    };
    const approvalResponse = app.request(
      ...operationRequest(
        'approval.respond',
        { approvalRequestId: repositoryApprovalId },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(responseInput),
        }
      )
    );
    let responded: Response;
    let refusedExecutionCalls: ReturnType<typeof listWorkspaceCapabilityCalls> | undefined;
    let callsBeforeReplay: ReturnType<typeof listWorkspaceCapabilityCalls> | undefined;
    let continuation: Awaited<ReturnType<typeof driveTask>>;
    if (refuseFirst) {
      responded = await approvalResponse;
      const reviewDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
      for (let n = 0; n < 2000; n++) {
        const record = readPendingRequest(reviewDb.sqlite, repositoryApprovalId!);
        if (record?.delivery === 'undelivered' && record.publicationTurnId) {
          const publication = store.getTurnById(record.publicationTurnId);
          if (publication.status !== 'pending' && publication.status !== 'running') break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      const refused = readPendingRequest(reviewDb.sqlite, repositoryApprovalId!)!;
      if (transientPreparation) {
        expect(responded.status, await responded.clone().text()).toBe(200);
        // Preparation refuses before any effect-capable operation, so delivery is definitely absent.
        expect(refused.delivery).toBe('undelivered');
        expect(store.getTurnById(refused.publicationTurnId!)).toMatchObject({
          status: 'failed',
          error: { code: 'worker_preparation_failed' },
        });
        expect(preparationFault).toHaveBeenCalledTimes(1);
        expect(
          listSchedulerAdmissionEntriesForWorkspace(coreDb, {
            workspaceId: refused.workspaceId,
            statuses: ['admitted'],
          })
        ).toContainEqual(expect.objectContaining({ turnId: refused.publicationTurnId }));
        expect(
          listSchedulerExecutionAttemptsForTurn(coreDb, {
            workspaceId: refused.workspaceId,
            threadId: refused.threadId,
            turnId: refused.publicationTurnId!,
          })
        ).toContainEqual(
          expect.objectContaining({
            phase: 'closed',
            disposition: 'not_accepted',
            operationId: null,
          })
        );
        const count = store.listThreadTurns(
          'ws_00000000-0000-7000-8000-000000000001',
          firstTask.turn.threadId
        ).length;
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(
          store.listThreadTurns('ws_00000000-0000-7000-8000-000000000001', firstTask.turn.threadId)
        ).toHaveLength(count);
        preparationFault!.mockRestore();
        reviewDb.sqlite.close();
        return;
      }
      // Pending Requests: Main refusal after the native claim is a known execution error.
      expect(refused).toMatchObject({
        state: 'resolved',
        resolution: 'granted',
        claim: 'finished',
        disposition: 'execution-error',
        delivery: 'undelivered',
        executionCallId: executionCallIdForRequest(repositoryApprovalId!),
      });
      refusedExecutionCalls = listWorkspaceCapabilityCalls(reviewDb, refused.workspaceId).filter(
        (call) => call.family === 'mcp'
      );
      expect(refusedExecutionCalls.filter((call) => call.id === refused.executionCallId)).toEqual([
        expect.objectContaining({
          requestId: responseInput.requestId,
          status: 'failed',
          upstreamContacted: false,
        }),
      ]);
      expect(
        listWorkspaceUsageRecords(reviewDb, refused.workspaceId).filter(
          (usage) => usage.capabilityCallId === refused.executionCallId
        )
      ).toEqual([]);
      expect(existsSync(callFile)).toBe(false);
      const publication = store.getTurnById(refused.publicationTurnId!);
      expect(publication.status).toBe('failed');
      expect(publication.items).toContainEqual(
        expect.objectContaining({
          id: pendingRequestItemId(repositoryApprovalId!, 'disposition'),
          type: 'tool-call',
          result: 'execution-error',
        })
      );
      expect(
        listThreadPendingRequests(reviewDb.sqlite, refused.workspaceId, refused.threadId).filter(
          (record) => record.delivery === 'frozen'
        )
      ).toEqual([]);
      expect(
        listSchedulerAdmissionEntriesForWorkspace(coreDb, {
          workspaceId: refused.workspaceId,
          statuses: ['queued'],
        }).filter((entry) => entry.turnId === refused.publicationTurnId)
      ).toEqual([]);
      const count = store.listThreadTurns(
        'ws_00000000-0000-7000-8000-000000000001',
        firstTask.turn.threadId
      ).length;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(
        store.listThreadTurns('ws_00000000-0000-7000-8000-000000000001', firstTask.turn.threadId)
      ).toHaveLength(count);
      providerFault!.mockRestore();
      const user = app.request(
        ...operationRequest(
          'conversation.submit',
          {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: firstTask.turn.threadId,
          },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              input: 'Continue after refused admission.',
              requestId: '0190f4c8-0000-7000-8000-000000000599',
              artifactRefs: [],
              targetRef: `running-worker:${encodeURIComponent(firstTask.turn.threadId)}:${encodeURIComponent(agentSetup.manifest.id)}`,
            }),
          }
        )
      );
      const [userResponse, resumed] = await Promise.all([user, driveTask(false)]);
      expect(userResponse.status, await userResponse.clone().text()).toBe(202);
      continuation = resumed;
      const delivered = readPendingRequest(reviewDb.sqlite, repositoryApprovalId!)!;
      expect(delivered.delivery).toBe('delivered');
      expect(delivered).toMatchObject({
        executionCallId: refused.executionCallId,
        claim: 'finished',
        disposition: 'execution-error',
      });
      expect(delivered.publicationTurnId).toBe(refused.publicationTurnId);
      expect(delivered.deliveryTurnId).not.toBe(refused.publicationTurnId);
      expect(store.getTurnById(delivered.deliveryTurnId!).items).toContainEqual(
        expect.objectContaining({
          type: 'user-message',
          text: expect.stringContaining('Continue after refused admission.'),
        })
      );
      expect(store.getTurnById(refused.publicationTurnId!).items).toEqual(publication.items);
      expect(store.getTurnById(delivered.deliveryTurnId!).items).not.toContainEqual(
        expect.objectContaining({
          id: pendingRequestItemId(repositoryApprovalId!, 'disposition'),
        })
      );
      callsBeforeReplay = listWorkspaceCapabilityCalls(reviewDb, refused.workspaceId).filter(
        (call) => call.family === 'mcp'
      );
      // Later user work owns its calls; carrying the outcome preserves the original execution.
      expect(callsBeforeReplay.filter((call) => call.turnId !== delivered.deliveryTurnId)).toEqual(
        refusedExecutionCalls
      );
      expect(
        callsBeforeReplay.filter((call) => call.requestId === responseInput.requestId)
      ).toEqual(refusedExecutionCalls.filter((call) => call.requestId === responseInput.requestId));
      reviewDb.sqlite.close();
    } else {
      [responded, continuation] = await Promise.all([approvalResponse, driveTask(false)]);
    }
    expect(responded.status, await responded.clone().text()).toBe(200);
    expect(store.getTurnById(firstTask.turn.id).status).toBe('completed');
    expect(continuation.agentSessionId).toBe(firstRun.agentSessionId);
    const replay = await app.request(
      ...operationRequest(
        'approval.respond',
        { approvalRequestId: repositoryApprovalId },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(responseInput),
        }
      )
    );
    expect(replay.status).toBe(200);
    if (refuseFirst) expect(await replay.json()).toEqual(await responded.clone().json());
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
    try {
      if (refuseFirst) {
        expect(
          listWorkspaceCapabilityCalls(workspaceDb, responseInput.workspaceId).filter(
            (call) => call.family === 'mcp'
          )
        ).toEqual(callsBeforeReplay);
        expect(
          listWorkspaceUsageRecords(workspaceDb, responseInput.workspaceId).filter(
            (usage) => usage.capabilityCallId === executionCallIdForRequest(repositoryApprovalId!)
          )
        ).toEqual([]);
      }
      expect(readPendingRequest(workspaceDb.sqlite, repositoryApprovalId!)?.delivery).toBe(
        'delivered'
      );
      expect(
        store
          .listThreadItems('ws_00000000-0000-7000-8000-000000000001', firstTask.turn.threadId)
          .filter(
            (item) =>
              item.type === 'approval-decision' && item.approvalRequestId === repositoryApprovalId
          )
      ).toHaveLength(1);
      expect(
        store
          .listThreadTurns('ws_00000000-0000-7000-8000-000000000001', firstTask.turn.threadId)
          .filter((turn) => turn.triggerSource?.kind === 'approval-resolution')
      ).toHaveLength(1);
    } finally {
      workspaceDb.sqlite.close();
    }
    if (!refuseFirst)
      expect(readFileSync(callFile, 'utf8').trim().split('\n')).toEqual(['public-task']);
    else expect(existsSync(callFile)).toBe(false);
  } finally {
    resultPublication.mockRestore();
    startup.restore();
    execution.mockRestore();
    await workerMcpGateway.close();
    await shutdownControlStoreWorkerClient();
    coreDb.sqlite.close();
    rmSync(exportRoot, { force: true, recursive: true });
    rmSync(dataRoot, { force: true, recursive: true });
  }
}

// Supply the same confirmed image evidence as the original MCP fixture.
vi.mock('./src/runtime/agent-environment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./src/runtime/agent-environment.js')>();
  const { withTestPreparedNativeEnvironment } = await import(
    './src/test-support/native-environment.js'
  );
  return withTestPreparedNativeEnvironment(actual);
});
