import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect as connectHttp2, createServer as createHttp2Server } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  ListHumanAttentionResponseSchema,
  StartTaskModeResponseSchema,
  SubmitConversationResponseSchema,
  WorkspaceExportResponseSchema,
} from '@openkit/app-api-schemas';
import {
  type AgentEnvironmentPackage,
  parseWorkspaceMcpServerCatalog,
  resolveWorkspaceMcpServer,
} from '@openkit/config-schema';
import { buildWorkerCanonicalTerminalEventRecord } from '@openkit/worker-protocol';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createCoreClient } from '../../../packages/core-client/src/index.js';
import { createApp, createDefaultWorkerControlGateway } from './app.js';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { ensureLocalUser } from './auth/identity.js';
import {
  createNanoHostTransportSessionAuthority,
  readNanoHostPhysicalConnectionContext,
} from './auth/nanohost-transport-session.js';
import { finishCapabilityCall, startCapabilityCall } from './capability/usage-ledger.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from './config/runtime-config.js';
import { retainWorkObservationBody } from './evidence-bundles.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { FsStore } from './lib/store.js';
import { ProviderRegistry } from './providers/registry.js';
import { recordAgentEnvironmentPackageSnapshot } from './runtime/aep-snapshot-ledger.js';
import {
  acceptSchedulerExecutionObservation,
  closeSchedulerExecutionAttemptWithFence,
  markSchedulerExecutionAttemptClosing,
  schedulerExecutionCorrelation,
} from './runtime/execution-attempt-records.js';
import {
  importMcpToolSchemaSnapshots,
  mcpToolSchemaContentDigest,
  readCurrentMcpToolSchemaSnapshot,
  recordMcpToolSchemaSnapshot,
} from './runtime/mcp-tool-schema-snapshots.js';
import {
  createNanoHostHarnessRuntime,
  dispatchNanoHostHarnessOperation,
  openNanoHostAgentSessionBinding,
  settleNanoHostHarnessOperation,
} from './runtime/nanohost-harness-records.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  upsertNanoHostRuntimeTarget,
} from './runtime/nanohost-runtime-target.js';
import {
  createNanoHostSessionDispatch,
  type NanoHostSessionDispatch,
  type NanoHostSessionEffectRequest,
} from './runtime/nanohost-session-dispatch.js';
import { approvalCardCopy, projectApprovalEffect } from './runtime/pending-request-disclosure.js';
import { readPendingRequest } from './runtime/pending-requests.js';
import { createConfiguredWorkerLifecycleRuntime } from './runtime/turn-executor-factory.js';
import type { WorkerControlGateway } from './runtime/worker-control-gateway.js';
import type { WorkerMcpGateway } from './runtime/worker-mcp-gateway.js';
import {
  createDefaultWorkerMcpGateway,
  MCP_RESULT_TOO_LARGE_MESSAGE,
  WorkerMcpGatewayCallError,
} from './runtime/worker-mcp-gateway.js';
import { createSchedulerAdmissionEntry } from './scheduler-records.js';
import { lightAppDbPath } from './storage/app-db.js';
import {
  openCoreDb,
  openWorkspaceDb,
  verifyAndMigrateExistingScopedDatabases,
} from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
  recordTestAgentEnvironmentPackage,
} from './test-support/agent-environment.js';
import { createDemoStore } from './test-support/demo-store.js';
import { recordTestExecutionAttempt } from './test-support/execution-attempt.js';
import { createMcpHttpStub } from './test-support/mcp-http-stub.js';
import { admitTestNativeEnvironment } from './test-support/native-environment.js';
import { operationRequest } from './test-support/operation-request.js';
import { resolveAgentEnvironmentPackage } from './test-support/prepared-agent-environment.js';
import { createVaultGrant, revokeVaultGrant } from './vault/vault-grants.js';
import { createVaultReference } from './vault/vault-references.js';
import { createVaultUnlockState } from './vault/vault-unlock-state.js';
import { reconcileWorkerMcpItems, registerWorkerMcpRoutes } from './worker-mcp-routes.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

/** Records the admission and lease that own a manually resolved MCP worker package. */
function recordMcpWorkerLineage(
  coreDb: ReturnType<typeof openCoreDb>,
  environmentPackage: AgentEnvironmentPackage,
  serverAdminTokenId: string | null = null
): void {
  const scope = environmentPackage.scope;
  const entry = createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    queueEntryId: `queue_${scope.turnId}`,
    requestId: scope.requestId,
    triggerActor: scope.triggerActor,
    serverAdminTokenId,
    workspaceId: scope.workspaceId,
    threadId: scope.threadId,
    turnId: scope.turnId,
    turnInput: 'Call MCP tool',
    requestedAgentId: environmentPackage.agent.agentId,
  });
  const submittedAttempt = recordTestExecutionAttempt(coreDb, {
    entry,
    attemptId: `lease_${scope.turnId}`,
    agentSessionId: scope.agentSessionId,
    inputRef: environmentPackage.snapshotId,
    bindingRef: `binding_${scope.turnId}`,
    sessionCompatibilityKey: 'fixture-compatibility',
    now: () => new Date().toISOString(),
    operationId: `fixture-submit:${`lease_${scope.turnId}`}`,
  });
  expect(
    acceptSchedulerExecutionObservation(coreDb, {
      ...schedulerExecutionCorrelation(submittedAttempt),
      disposition: 'accepted',
      execution: 'running',
      fenceRef: null,
      outcomeRef: null,
    })?.disposition
  ).toBe('accepted');
}

describe('worker MCP routes', () => {
  it.each([
    'abort',
    'expiry',
  ] as const)('releases the Tool handler and Workspace admission after accepted unresolved capture %s', async (ending) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-capture-wait-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
    const turn = store.createTurn('ws_demo', 'th_demo', 'Submit one file', {
      id: 'user_local',
      kind: 'user',
    });
    store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: '2026-10-05T00:00:00.000Z',
      id: 'as_capture_wait',
      message: null,
      status: 'busy',
      threadId: turn.threadId,
      updatedAt: '2026-10-05T00:00:00.000Z',
      workspaceId: turn.workspaceId,
    });
    store.updateTurn(turn.id, {
      agentSessionId: 'as_capture_wait',
      agentId: 'agent_codex_host',
      status: 'running',
    });
    const pkg = resolveAgentEnvironmentPackage({
      captureCoverage: { scope: 'server', value: 'off' },
      agentSessionId: 'as_capture_wait',
      agentSetup: createTestAgentSetup(),
      backend: { kind: 'openshell' },
      createdAt: '2026-10-05T00:00:00.000Z',
      requestId: 'req_capture_wait',
      triggerActor: turn.triggerActor,
      turn,
      workspaceCwd: '/workspace',
      workspaceRoots: [],
    });
    pkg.workspace.outputs = [
      {
        id: 'output',
        path: '/workspace/output',
        registerAsArtifacts: true,
        retention: 'sync-on-turn-end',
      },
    ];
    recordMcpWorkerLineage(coreDb, pkg);
    const authority = createNanoHostTransportSessionAuthority();
    const target = {
      deploymentId: 'capture-wait',
      identityId: 'capture-wait',
      targetId: 'capture-wait',
    };
    allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
      ...target,
      observedAt: '2026-10-05T00:00:00.000Z',
    });
    let admit!: (physical: object) => void;
    const physicalReady = new Promise<object>((resolve) => {
      admit = resolve;
    });
    const server = createHttp2Server((request, response) => {
      admit(readNanoHostPhysicalConnectionContext(request)!);
      response.writeHead(204).end();
    });
    const dispatch = createNanoHostSessionDispatch({ coreDb, sessionAuthority: authority });
    const admission = new WorkspaceMutationAdmission();
    const gateway = createDefaultWorkerMcpGateway(coreDb);
    const client = new Client({ name: 'capture-wait', version: '1.0.0' });
    let nativeClient: ReturnType<typeof connectHttp2> | undefined;
    let physical: object | undefined;
    let entered!: () => void;
    const captureEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let captureCount = 0;
    const effectRequest = {
      kind: 'file.export',
      requestId: 'b'.repeat(64),
      input: {
        purpose: 'artifact-submission',
        submissionRequestId: 'capture-wait',
        turnId: turn.id,
        agentSessionId: pkg.scope.agentSessionId,
        packageSnapshotId: pkg.snapshotId,
        leaseId: `lease_${turn.id}`,
        backendSessionId: 'backend_capture_wait',
        sandboxId: 'sandbox_capture_wait',
        maxByteLength: 1024,
        presence: 'optional',
        relativePath: 'report.md',
        slot: 'output',
      },
    };
    const app = new Hono();
    registerWorkerMcpRoutes({
      app,
      coreDb,
      store,
      workspaceMutationAdmission: admission,
      runtimeConfig: () =>
        createInMemoryRuntimeConfigSnapshot({
          dataRoot,
          agentManifests: [],
          workspaceMcpServerCatalogs: [],
        }),
      workerControlGateway: {
        authenticatePackageToken: vi.fn(() => pkg),
      } as unknown as WorkerControlGateway,
      workerMcpGateway: gateway,
      captureArtifact: async (input) => {
        captureCount += 1;
        const result = dispatch.effect({ ...effectRequest, signal: input.signal });
        entered();
        await result;
        throw new Error('An abandoned capture must never return bytes to publication.');
      },
    });
    let closed = false;
    let closing: Promise<void> | undefined;
    let call: Promise<unknown> | undefined;
    let accepted = false;
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing capture address.');
      nativeClient = connectHttp2(`http://127.0.0.1:${address.port}`);
      nativeClient
        .request({ ':method': 'POST', ':path': '/' })
        .on('data', () => {})
        .end();
      physical = await physicalReady;
      authority.admit({
        connectionGeneration: 1,
        identityId: target.identityId,
        physicalConnection: physical,
      });
      await dispatch.readiness!(
        physical,
        Buffer.from(JSON.stringify({ physicalEpoch: 'a'.repeat(64) })),
        { ...target, coreDb }
      );
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL('http://nanocore.test/api/worker-capabilities/mcp/openkit-work'),
          {
            fetch: (input, init) => app.fetch(new Request(input, init)),
            requestInit: { headers: { authorization: 'Bearer capability-token' } },
          }
        )
      );
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const abort = new AbortController();
      call = client.callTool(
        {
          name: 'work_submit_artifact',
          arguments: {
            requestId: 'capture-wait',
            path: '/workspace/output/report.md',
            title: 'Report',
            kind: 'file',
            mediaType: 'text/markdown',
          },
        },
        { signal: abort.signal, timeout: 400_000 }
      );
      void call.catch(() => undefined);
      await Promise.race([
        captureEntered,
        call.then(() => {
          throw new Error('Capture was not entered.');
        }),
      ]);
      expect(await dispatch.poll(physical, 'file.export')).toMatchObject({
        requestId: effectRequest.requestId,
      });
      accepted = true;
      closing = admission.close('ws_demo').then(() => {
        closed = true;
      });
      expect(closed).toBe(false);
      if (ending === 'abort') abort.abort();
      else await vi.advanceTimersByTimeAsync(300_000);
      vi.useRealTimers();
      // Closing cannot finish until the actual route's finally closes its database and releases its permit.
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1000, interval: 10 });
      if (ending === 'expiry')
        await expect(call).rejects.toMatchObject({ data: { code: 'recovery_required' } });
      else await expect(call).rejects.toThrow(/abort/i);
      expect(captureCount).toBe(1);
      await expect(
        dispatch.effect({ ...effectRequest, requestId: 'c'.repeat(64) })
      ).rejects.toMatchObject({ code: 'artifact_capture_busy' });
      const bytes = Buffer.from('# Late result');
      await dispatch.fileExportResult!(
        physical,
        new Request('http://nanocore.test/file', {
          method: 'POST',
          body: bytes,
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(bytes.length),
            'x-openkit-request-id': effectRequest.requestId,
            'x-openkit-relative-path': 'report.md',
            'x-openkit-slot': 'output',
            'x-openkit-byte-length': String(bytes.length),
            'x-openkit-sha256': `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          },
        })
      );
      accepted = false;
      const next = dispatch.effect({ ...effectRequest, requestId: 'c'.repeat(64) });
      expect(await dispatch.poll(physical, 'file.export')).toMatchObject({
        requestId: 'c'.repeat(64),
      });
      await dispatch.result(physical, 'file.export', {
        requestId: 'c'.repeat(64),
        state: 'absent',
      });
      await expect(next).resolves.toMatchObject({ state: 'absent' });
      expect(store.listArtifacts('ws_demo')).toEqual([]);
      expect(
        store
          .listThreadItems('ws_demo', 'th_demo')
          .filter((item) => item.type === 'artifact-reference')
      ).toEqual([]);
      const db = openWorkspaceDb(dataRoot, 'ws_demo');
      try {
        expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM artifact_reviews').get()).toEqual({
          count: 0,
        });
        expect(store.listCommandRequests()).toEqual([]);
      } finally {
        db.sqlite.close();
      }
      admission.reopen('ws_demo');
      expect(
        (await client.listTools()).tools.some((tool) => tool.name === 'work_submit_artifact')
      ).toBe(true);
    } finally {
      vi.useRealTimers();
      if (accepted && physical)
        await dispatch.result(physical, 'file.export', {
          requestId: effectRequest.requestId,
          state: 'absent',
        });
      await call?.catch(() => undefined);
      await closing;
      await client.close().catch(() => undefined);
      await gateway.close();
      nativeClient?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      coreDb.sqlite.close();
    }
  });

  it('serves one stateless-era client and one session-era client on the worker MCP route', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-mcp-era-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
    const turn = store.createTurn('ws_demo', 'th_demo', 'List generative MCP tools', {
      id: 'user_local',
      kind: 'user',
    });
    store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: '2026-09-03T00:00:00.000Z',
      id: 'as_mcp_era',
      message: null,
      status: 'busy',
      threadId: turn.threadId,
      updatedAt: '2026-09-03T00:00:00.000Z',
      workspaceId: turn.workspaceId,
    });
    store.updateTurn(turn.id, { agentSessionId: 'as_mcp_era' });
    const environmentPackage = resolveAgentEnvironmentPackage({
      captureCoverage: { scope: 'server', value: 'off' },
      agentSessionId: 'as_mcp_era',
      agentSetup: createTestAgentSetup(),
      backend: { kind: 'openshell' },
      createdAt: '2026-09-03T00:00:00.000Z',
      requestId: 'req_mcp_era',
      triggerActor: turn.triggerActor,
      turn,
      workspaceCwd: '/workspace',
      workspaceRoots: [],
    });
    recordMcpWorkerLineage(coreDb, environmentPackage);
    const workerMcpGateway = createDefaultWorkerMcpGateway(coreDb);
    const app = new Hono();
    registerWorkerMcpRoutes({
      app,
      coreDb,
      runtimeConfig: () =>
        createInMemoryRuntimeConfigSnapshot({
          dataRoot,
          agentManifests: [],
          workspaceMcpServerCatalogs: [],
        }),
      store,
      workerControlGateway: {
        authenticatePackageToken: vi.fn(() => environmentPackage),
      } as unknown as WorkerControlGateway,
      workerMcpGateway,
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    });
    const rpcErrors: unknown[] = [];
    const fetchMcp = async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await app.fetch(new Request(input, init));
      if (response.headers.get('content-type')?.includes('application/json')) {
        const payload = (await response.clone().json()) as { error?: unknown };
        if (payload.error) rpcErrors.push(payload.error);
      }
      return response;
    };
    const sessionClient = new Client(
      { name: 'session-era', version: '1.0.0' },
      { versionNegotiation: { mode: 'legacy' } }
    );
    const statelessClient = new Client(
      { name: 'stateless-era', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } }
    );
    const endpoint = new URL('http://nanocore.test/api/worker-capabilities/mcp/openkit-generative');
    const sessionTransport = new StreamableHTTPClientTransport(endpoint, {
      fetch: fetchMcp,
      requestInit: { headers: { authorization: 'Bearer capability-token' } },
    });
    const statelessTransport = new StreamableHTTPClientTransport(endpoint, {
      fetch: fetchMcp,
      requestInit: { headers: { authorization: 'Bearer capability-token' } },
    });
    const workClient = new Client({ name: 'work-input', version: '1.0.0' });
    const workTransport = new StreamableHTTPClientTransport(
      new URL('http://nanocore.test/api/worker-capabilities/mcp/openkit-work'),
      {
        fetch: fetchMcp,
        requestInit: { headers: { authorization: 'Bearer capability-token' } },
      }
    );
    try {
      await sessionClient.connect(sessionTransport);
      await statelessClient.connect(statelessTransport);
      await workClient.connect(workTransport);
      expect(sessionClient.getProtocolEra()).toBe('legacy');
      expect(statelessClient.getProtocolEra()).toBe('modern');
      const sessionTools = await sessionClient.listTools();
      const statelessTools = await statelessClient.listTools();
      expect(sessionTools.tools.map((tool) => tool.name)).toContain('kernel_apps_list');
      expect(statelessTools.tools.map((tool) => tool.name)).toContain('kernel_apps_list');
      expect((await workClient.listTools()).tools.map((tool) => tool.name)).toEqual([
        'work_request_input',
        'work_list_peers',
        'work_read_peer',
        'work_submit_artifact',
      ]);
      // Owner refusals cross the selected HTTP relay and retain their established JSON-RPC envelope.
      const refusalDb = openWorkspaceDb(dataRoot, turn.workspaceId);
      try {
        applyScopedMigrations(refusalDb);
        const errorsBefore = rpcErrors.length;
        const itemsBefore = store.listThreadItems(turn.workspaceId, turn.threadId);
        const turnBefore = store.getTurnById(turn.id);
        const presentationsBefore = refusalDb.sqlite
          .prepare('SELECT * FROM generative_presentations')
          .all();
        const receiptsBefore = refusalDb.sqlite.prepare('SELECT * FROM idempotency_requests').all();
        const missingAppId = '00000000-0000-4000-8000-000000000701';
        const missingPresentationId = '00000000-0000-4000-8000-000000000702';
        expect(existsSync(lightAppDbPath(dataRoot, turn.workspaceId, missingAppId))).toBe(false);
        await expect(
          sessionClient.callTool({
            name: 'kernel_apps_retire',
            arguments: { appId: missingAppId, expectedAppRevision: 1 },
          })
        ).rejects.toMatchObject({
          code: -32600,
          message: expect.stringContaining('App authority is missing.'),
          data: { code: 'unavailable' },
        });
        await expect(
          statelessClient.callTool({
            name: 'generative_ui_action',
            arguments: {
              presentationId: missingPresentationId,
              version: 'v0.9',
              action: {
                name: 'update',
                surfaceId: 'missing-surface',
                sourceComponentId: 'missing-button',
                timestamp: '2026-09-03T00:00:00.000Z',
              },
            },
          })
        ).rejects.toMatchObject({
          code: -32600,
          message: expect.stringContaining('Presentation was not found.'),
          data: { code: 'not_found' },
        });
        expect(rpcErrors.slice(errorsBefore)).toEqual([
          {
            code: -32600,
            message: 'App authority is missing.',
            data: { code: 'unavailable', message: 'App authority is missing.', status: 503 },
          },
          {
            code: -32600,
            message: 'Presentation was not found.',
            data: { code: 'not_found', message: 'Presentation was not found.', status: 404 },
          },
        ]);
        expect(
          refusalDb.sqlite
            .prepare(`
          SELECT capability_id, status, error_code, turn_id, package_snapshot_id
          FROM capability_calls WHERE capability_id IN (?, ?) ORDER BY capability_id
        `)
            .all('mcp.call_tool.generative_ui_action', 'mcp.call_tool.kernel_apps_retire')
        ).toEqual([
          {
            capability_id: 'mcp.call_tool.generative_ui_action',
            status: 'failed',
            error_code: 'not_found',
            turn_id: turn.id,
            package_snapshot_id: environmentPackage.snapshotId,
          },
          {
            capability_id: 'mcp.call_tool.kernel_apps_retire',
            status: 'failed',
            error_code: 'unavailable',
            turn_id: turn.id,
            package_snapshot_id: environmentPackage.snapshotId,
          },
        ]);
        expect(refusalDb.sqlite.prepare('SELECT * FROM generative_presentations').all()).toEqual(
          presentationsBefore
        );
        expect(refusalDb.sqlite.prepare('SELECT * FROM idempotency_requests').all()).toEqual(
          receiptsBefore
        );
        expect(store.listThreadItems(turn.workspaceId, turn.threadId)).toEqual(itemsBefore);
        expect(store.getTurnById(turn.id)).toEqual(turnBefore);
        expect(existsSync(lightAppDbPath(dataRoot, turn.workspaceId, missingAppId))).toBe(false);
      } finally {
        refusalDb.sqlite.close();
      }
      const pending = await workClient.callTool({
        name: 'work_request_input',
        arguments: {
          requestId: '00000000-0000-4000-8000-000000000144',
          prompt: 'Choose a direction.',
          futureSafeField: 'ignored-metadata',
          questions: [
            {
              id: 'direction',
              header: 'Direction',
              question: 'Which direction should the worker take?',
              options: null,
              isOther: false,
              isSecret: false,
            },
          ],
        },
      });
      expect(pending.isError).toBe(false);
      expect(pending.structuredContent).toMatchObject({
        status: 'pending-input',
        requestId: '00000000-0000-4000-8000-000000000144',
      });
      const questionArgs = (index: number) => ({
        requestId: `00000000-0000-4000-8000-${String(144 + index).padStart(12, '0')}`,
        prompt: `Choose direction ${index}.`,
        questions: [
          {
            id: `direction_${index}`,
            header: 'Direction',
            question: `Which direction ${index}?`,
            options: null,
            isOther: false,
            isSecret: false,
          },
        ],
      });
      for (let index = 1; index < 16; index += 1) {
        expect(
          (
            await workClient.callTool({
              name: 'work_request_input',
              arguments: questionArgs(index),
            })
          ).isError
        ).toBe(false);
      }
      const countDb = openWorkspaceDb(dataRoot, 'ws_demo');
      const beforeCalls = (
        countDb.sqlite.prepare('SELECT COUNT(*) AS count FROM capability_calls').get() as {
          count: number;
        }
      ).count;
      await expect(
        workClient.callTool({ name: 'work_request_input', arguments: questionArgs(16) })
      ).rejects.toMatchObject({ data: { code: 'request_limit_reached' } });
      expect(
        (
          countDb.sqlite.prepare('SELECT COUNT(*) AS count FROM capability_calls').get() as {
            count: number;
          }
        ).count
      ).toBe(beforeCalls);
      const duplicate = await workClient.callTool({
        name: 'work_request_input',
        arguments: questionArgs(15),
      });
      expect(duplicate.structuredContent).toMatchObject({ requestId: questionArgs(15).requestId });
      expect(
        (
          countDb.sqlite.prepare('SELECT COUNT(*) AS count FROM capability_calls').get() as {
            count: number;
          }
        ).count
      ).toBe(beforeCalls);
      expect(
        JSON.stringify(countDb.sqlite.prepare('SELECT * FROM pending_requests').all())
      ).not.toContain('ignored-metadata');
      countDb.sqlite.close();
      expect(store.getTurnById(turn.id).status).toBe('running');
      expect(
        store
          .listThreadItems('ws_demo', 'th_demo')
          .filter((item) => item.type === 'user-input-request')
      ).toHaveLength(16);
    } finally {
      await workClient.close().catch(() => undefined);
      await sessionClient.close().catch(() => undefined);
      await statelessClient.close().catch(() => undefined);
      await workerMcpGateway.close();
      coreDb.sqlite.close();
    }
  });

  it('reads only current same-Sandbox peers through Turn-scoped handles without changing their records', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-work-peers-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    let store = createDemoStore();
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
    const timestamp = '2026-09-30T00:00:00.000Z';
    const physicalEpoch = 'e'.repeat(64);
    coreDb.sqlite
      .prepare(`INSERT INTO nanohost_runtime_targets (
      target_id, identity_id, deployment_id, connection_generation,
      predecessor_fenced, ready, fresh_empty, physical_epoch, observed_at, slot_count
    ) VALUES ('target_test', 'target_test', 'deployment_test', 1, 1, 1, 1, ?, ?, 1)`)
      .run(physicalEpoch, timestamp);
    for (const sandbox of ['shared', 'foreign']) {
      createNanoHostHarnessRuntime(coreDb, {
        adapterId: 'codex',
        adapterVersion: 'test',
        harnessBindingRef: `harness_binding_${sandbox}`,
        harnessCompatibilityKey: 'b'.repeat(64),
        harnessInstanceId: `harness_${sandbox}`,
        imageDigest: `sha256:${'f'.repeat(64)}`,
        originPhysicalEpoch: physicalEpoch,
        sandboxBindingRef: `sandbox_binding_${sandbox}`,
        sandboxCompatibilityKey: 'a'.repeat(64),
        sandboxIntegrationBindingRef: `integration_${sandbox}`,
        sandboxRuntimeId: `sandbox_${sandbox}`,
        runtimeTargetId: 'target_test',
        timestamp,
      });
    }
    const threads = ['caller', 'peer', 'private', 'foreign'].map((name) =>
      store.createThread(
        'ws_demo',
        name,
        `th_peers_${name}`,
        'conversation',
        name === 'private'
          ? { visibility: 'private', privateOwnerUserId: 'user_other' }
          : { visibility: 'workspace' }
      )
    );
    const otherWorkspace = store.createWorkspace('Unreadable peer Workspace');
    coreDb.sqlite
      .prepare(`INSERT INTO users
      (id, display_name, email, email_verified, created_at, updated_at, kind, status)
      VALUES ('user_other', 'Foreign worker owner', 'other@example.invalid', 0, ?, ?, 'human', 'active')`)
      .run(Date.parse(timestamp), Date.parse(timestamp));
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_other',
      workspaceId: otherWorkspace.id,
    });
    threads.push(store.createThread(otherWorkspace.id, 'external', 'th_peers_external'));
    for (let index = 0; index < 3; index += 1) {
      const history = store.createTurn('ws_demo', threads[1]!.id, 'Earlier work', {
        kind: 'user',
        id: 'user_local',
      });
      store.updateTurn(history.id, {
        status: 'completed',
        completedAt: timestamp,
        triggerSource: { kind: 'user-input', summary: 'Earlier work' },
      });
    }
    const turns = threads.map((thread) => {
      const turn = store.createTurn(thread.workspaceId, thread.id, 'Read peers', {
        kind: 'user',
        id: thread.workspaceId === otherWorkspace.id ? 'user_other' : 'user_local',
      });
      const sessionId = `as_native_${thread.name}`;
      store.createAgentSession({
        id: sessionId,
        agentId: 'agent_codex_host',
        workspaceId: thread.workspaceId,
        threadId: thread.id,
        status: 'busy',
        message: 'native-state-canary credential-canary',
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      store.updateTurn(turn.id, {
        agentSessionId: sessionId,
        agentId: 'agent_codex_host',
        triggerSource: { kind: 'user-input', summary: 'Read peers' },
      });
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: 'c'.repeat(64),
        agentSessionId: sessionId,
        agentSessionRuntimeBindingId: `binding_${thread.name}`,
        effectiveSetupGeneration: 1,
        harnessInstanceId: thread.name === 'foreign' ? 'harness_foreign' : 'harness_shared',
        workspaceId: thread.workspaceId,
        threadId: thread.id,
        timestamp,
      });
      return store.getTurnById(turn.id);
    });
    const peer = turns[1]!;
    const itemFields = {
      workspaceId: 'ws_demo',
      threadId: peer.threadId,
      turnId: peer.id,
      status: 'completed' as const,
      createdAt: timestamp,
      completedAt: timestamp,
    };
    for (let index = 0; index < 23; index += 1) {
      store.createItem({
        ...itemFields,
        id: `it_peer_${String(index).padStart(2, '0')}`,
        createdAt: `2026-09-30T00:00:${String(index).padStart(2, '0')}.000Z`,
        type: 'assistant-message',
        text: `Product message ${index}`,
      });
    }
    store.createItem({
      ...itemFields,
      id: 'it_peer_plan',
      type: 'plan',
      title: 'Product plan',
      summary: null,
      steps: [],
    });
    store.createItem({
      ...itemFields,
      id: 'it_peer_tool',
      type: 'tool-call',
      tool: 'test',
      server: null,
      arguments: null,
      result: 'Product tool summary',
      error: null,
      durationMs: 1,
    });
    store.createItem({
      ...itemFields,
      id: 'it_peer_status',
      type: 'status',
      title: 'Product status',
      summary: null,
      level: 'info',
    });
    store.createItem({
      ...itemFields,
      id: 'it_peer_reasoning',
      type: 'reasoning',
      summary: [],
      content: ['restricted-evidence-canary'],
    });
    // Seed in memory and publish each complete Workspace once; the oracle still reads real persisted bytes.
    const seeded = store;
    store = new FsStore({ dataRoot });
    for (const workspace of seeded.listWorkspaces()) {
      const workspaceThreads = seeded.listThreads(workspace.id);
      const workspaceTurns = workspaceThreads.flatMap((thread) =>
        seeded.listThreadTurns(workspace.id, thread.id)
      );
      store.importWorkspaceSnapshot({
        workspace,
        threads: workspaceThreads,
        turns: workspaceTurns,
        knowledge: seeded.getWorkspaceResources(workspace.id).knowledge,
        itemRevisions: workspaceTurns.flatMap((turn) => turn.items),
        artifacts: [],
        agentSessions: seeded.listWorkspaceAgentSessions(workspace.id),
        turnEvents: workspaceTurns.map((turn) => [turn.id, seeded.getTurnEventsForExport(turn.id)]),
        turnCaptureCoverage: new Map(
          workspaceTurns.map((turn) => [turn.id, seeded.getTurnCaptureCoverage(turn.id)!])
        ),
      });
    }
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
    applyScopedMigrations(workspaceDb);
    const rawEvidence = Buffer.from('restricted-raw-canary credential-canary');
    retainWorkObservationBody(workspaceDb, {
      bundleId: 'evidence_peer_private',
      threadId: peer.threadId,
      turnId: peer.id,
      createdAt: timestamp,
      sha256: createHash('sha256').update(rawEvidence).digest('hex'),
      bytes: rawEvidence,
    });
    let environmentPackage: AgentEnvironmentPackage;
    const packages = turns.map((turn) => {
      const resolved = resolveAgentEnvironmentPackage({
        captureCoverage: { scope: 'server', value: 'off' },
        agentSessionId: turn.agentSessionId!,
        agentSetup: createTestAgentSetup(),
        backend: { kind: 'openshell' },
        createdAt: timestamp,
        requestId: `req_${turn.id}`,
        triggerActor: turn.triggerActor,
        turn,
        workspaceCwd: '/workspace',
        workspaceRoots: [],
      });
      recordMcpWorkerLineage(coreDb, resolved);
      return resolved;
    });
    environmentPackage = packages[0]!;
    const workerMcpGateway = createDefaultWorkerMcpGateway(coreDb);
    const app = new Hono();
    registerWorkerMcpRoutes({
      app,
      coreDb,
      store,
      workerMcpGateway,
      workerControlGateway: {
        authenticatePackageToken: () => environmentPackage,
      } as unknown as WorkerControlGateway,
      runtimeConfig: () =>
        createInMemoryRuntimeConfigSnapshot({
          dataRoot,
          agentManifests: [],
          workspaceMcpServerCatalogs: [],
        }),
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    });
    const client = new Client({ name: 'work-peers', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL('http://nanocore.test/api/worker-capabilities/mcp/openkit-work'),
      {
        fetch: (input, init) => app.fetch(new Request(input, init)),
        requestInit: { headers: { authorization: 'Bearer test' } },
      }
    );
    try {
      await client.connect(transport);
      environmentPackage = packages[1]!;
      await client.callTool({
        name: 'work_request_input',
        arguments: {
          requestId: '00000000-0000-4000-8000-000000000255',
          prompt: 'Keep this pending.',
          questions: [
            {
              id: 'peer_question',
              header: 'Peer',
              question: 'Which next step?',
              options: null,
              isOther: false,
              isSecret: false,
            },
          ],
        },
      });
      environmentPackage = packages[0]!;
      // The owner requires peer reads to leave Turns, Items, requests, and bindings unchanged.
      // The brief requires byte-identical peer records, including retained Turn and Item file bytes.
      const peerTurnFiles = threads
        .slice(1)
        .flatMap((thread) =>
          store
            .listThreadTurns(thread.workspaceId, thread.id)
            .flatMap((turn) =>
              ['turn.json', 'items.jsonl'].map((name) =>
                join(
                  dataRoot,
                  'workspaces',
                  thread.workspaceId,
                  'threads',
                  thread.id,
                  'turns',
                  turn.id,
                  name
                )
              )
            )
        );
      const before = JSON.stringify({
        files: peerTurnFiles.map((path) => readFileSync(path).toString('base64')),
        turns: threads
          .slice(1)
          .flatMap((thread) => store.listThreadTurns(thread.workspaceId, thread.id)),
        items: threads
          .slice(1)
          .flatMap((thread) => store.listThreadItems(thread.workspaceId, thread.id)),
        requests: workspaceDb.sqlite.prepare('SELECT * FROM pending_requests').all(),
        bindings: coreDb.sqlite.prepare('SELECT * FROM agent_session_runtime_bindings').all(),
      });
      expect(workspaceDb.sqlite.prepare('SELECT * FROM pending_requests').all()).toHaveLength(1);
      const tools = (await client.listTools()).tools;
      expect(tools.map((tool) => tool.name)).toEqual([
        'work_request_input',
        'work_list_peers',
        'work_read_peer',
        'work_submit_artifact',
      ]);
      const readSchema = tools.find((tool) => tool.name === 'work_read_peer')!.inputSchema;
      expect(readSchema.required).toEqual(['handle']);
      expect(readSchema.additionalProperties).not.toBe(false);
      const listed = await client.callTool({
        name: 'work_list_peers',
        arguments: {
          future: 'additive-canary',
          agentSessionId: 'as_native_foreign',
          requestId: '00000000-0000-4000-8000-000000000256',
          prompt: 'additive-canary',
          questions: [
            {
              id: 'ignored',
              header: 'Ignored',
              question: 'additive-canary',
              options: null,
              isOther: false,
              isSecret: true,
            },
          ],
        },
      });
      expect(listed.isError).toBe(false);
      const peers = listed.structuredContent!.peers as Array<Record<string, unknown>>;
      expect(peers).toHaveLength(3);
      const readable = peers.find((entry) => entry.title === 'peer')!;
      expect(readable).toMatchObject({
        agentId: 'agent_codex_host',
        runtime: 'codex',
        activeTurn: true,
      });
      const hiddenPeers = peers.filter((entry) => !('title' in entry));
      expect(hiddenPeers).toHaveLength(2);
      for (const entry of hiddenPeers)
        expect(Object.keys(entry).sort()).toEqual(['agentId', 'handle', 'runtime']);
      expect(JSON.stringify(listed)).not.toMatch(
        /as_native_|binding_|private|foreign|external|additive-canary/
      );
      const callsBefore = workspaceDb.sqlite.prepare('SELECT * FROM capability_calls').all().length;
      const defaultRead = await client.callTool({
        name: 'work_read_peer',
        arguments: { handle: readable.handle },
      });
      expect(defaultRead.structuredContent!.items).toHaveLength(20);
      const read = await client.callTool({
        name: 'work_read_peer',
        arguments: { handle: readable.handle, limit: 2, future: 'additive-canary' },
      });
      expect(read.structuredContent).toMatchObject({
        turns: [
          { id: peer.id, status: 'running', triggerSource: { kind: 'user-input' } },
          { status: 'completed' },
        ],
        items: [{ id: 'it_peer_22' }, { id: 'it_peer_21' }],
        nextCursor: '2',
      });
      const next = await client.callTool({
        name: 'work_read_peer',
        arguments: { handle: readable.handle, cursor: '2', limit: 50 },
      });
      expect(
        (next.structuredContent!.items as Array<{ type: string }>).map((item) => item.type)
      ).toEqual(expect.arrayContaining(['assistant-message', 'plan', 'tool-call', 'status']));
      expect(next.structuredContent!.nextCursor).toBeNull();
      expect(JSON.stringify([read, next])).not.toMatch(
        /agentSessionId|as_native_|native-state-canary|restricted-evidence-canary|restricted-raw-canary|additive-canary|credential/
      );
      for (const hiddenPeer of hiddenPeers) {
        await expect(
          client.callTool({ name: 'work_read_peer', arguments: { handle: hiddenPeer.handle } })
        ).rejects.toMatchObject({ data: { code: 'peer_not_found' } });
      }
      await expect(
        client.callTool({ name: 'work_read_peer', arguments: { handle: 'as_native_peer' } })
      ).rejects.toMatchObject({ data: { code: 'peer_not_found' } });
      expect(workspaceDb.sqlite.prepare('SELECT * FROM capability_calls').all()).toHaveLength(
        callsBefore + 6
      );
      expect(
        (
          workspaceDb.sqlite
            .prepare('SELECT status FROM capability_calls ORDER BY rowid')
            .all() as Array<{
            status: string;
          }>
        )
          .slice(callsBefore)
          .map((call) => call.status)
      ).toEqual(['succeeded', 'succeeded', 'succeeded', 'failed', 'failed', 'failed']);
      for (const argumentsOverride of [
        { handle: '' },
        { handle: 1 },
        { cursor: '-1' },
        { cursor: '01' },
        { cursor: 'not-a-cursor' },
        { limit: 0 },
        { limit: 51 },
        { limit: 1.5 },
      ]) {
        await expect(
          client.callTool({
            name: 'work_read_peer',
            arguments: { handle: readable.handle, ...argumentsOverride },
          })
        ).rejects.toMatchObject({ data: { code: 'mcp-call-failed' } });
      }
      expect(
        JSON.stringify(workspaceDb.sqlite.prepare('SELECT * FROM capability_calls').all())
      ).not.toContain('additive-canary');
      const after = JSON.stringify({
        files: peerTurnFiles.map((path) => readFileSync(path).toString('base64')),
        turns: threads
          .slice(1)
          .flatMap((thread) => store.listThreadTurns(thread.workspaceId, thread.id)),
        items: threads
          .slice(1)
          .flatMap((thread) => store.listThreadItems(thread.workspaceId, thread.id)),
        requests: workspaceDb.sqlite.prepare('SELECT * FROM pending_requests').all(),
        bindings: coreDb.sqlite.prepare('SELECT * FROM agent_session_runtime_bindings').all(),
      });
      expect(after).toBe(before);
      store.updateTurn(peer.id, { status: 'pending' });
      const pendingPeers = (await client.callTool({ name: 'work_list_peers', arguments: {} }))
        .structuredContent!.peers as Array<Record<string, unknown>>;
      expect(pendingPeers.find((entry) => entry.handle === readable.handle)).toMatchObject({
        activeTurn: true,
      });
      store.updateTurn(peer.id, { status: 'running' });
      environmentPackage = packages[1]!;
      const reverse = (await client.callTool({ name: 'work_list_peers', arguments: {} }))
        .structuredContent!.peers as Array<Record<string, unknown>>;
      expect(reverse.map((entry) => entry.title)).toContain('caller');
      expect(reverse.map((entry) => entry.title)).not.toContain('peer');
      environmentPackage = packages[0]!;
      Object.assign(store.getThread('ws_demo', peer.threadId), {
        visibility: 'private',
        privateOwnerUserId: 'user_other',
      });
      await expect(
        client.callTool({ name: 'work_read_peer', arguments: { handle: readable.handle } })
      ).rejects.toMatchObject({ data: { code: 'peer_not_found' } });
      const relisted = (await client.callTool({ name: 'work_list_peers', arguments: {} }))
        .structuredContent!.peers as Array<Record<string, unknown>>;
      expect(
        Object.keys(relisted.find((entry) => entry.handle === readable.handle)!).sort()
      ).toEqual(['agentId', 'handle', 'runtime']);
      Object.assign(store.getThread('ws_demo', peer.threadId), {
        visibility: 'workspace',
        privateOwnerUserId: undefined,
      });
      store.createItem({
        ...itemFields,
        id: 'it_peer_oversized',
        createdAt: '2026-09-30T01:00:00.000Z',
        type: 'assistant-message',
        text: 'x'.repeat(524_288),
      });
      await expect(
        client.callTool({ name: 'work_read_peer', arguments: { handle: readable.handle } })
      ).rejects.toMatchObject({
        data: { code: 'mcp-result-too-large' },
        message: expect.stringContaining('Route bulk output through artifacts or the data plane.'),
      });
      coreDb.sqlite
        .prepare('DELETE FROM agent_session_runtime_bindings WHERE agent_session_id = ?')
        .run('as_native_peer');
      await expect(
        client.callTool({ name: 'work_read_peer', arguments: { handle: readable.handle } })
      ).rejects.toMatchObject({ data: { code: 'peer_not_found' } });
      // Restore the same binding; a later Turn still cannot use its predecessor's handle.
      openNanoHostAgentSessionBinding(coreDb, {
        agentSessionCompatibilityKey: 'c'.repeat(64),
        agentSessionId: 'as_native_peer',
        agentSessionRuntimeBindingId: 'binding_peer',
        effectiveSetupGeneration: 1,
        harnessInstanceId: 'harness_shared',
        workspaceId: 'ws_demo',
        threadId: peer.threadId,
        timestamp,
      });
      store.updateTurn(turns[0]!.id, { status: 'completed', completedAt: timestamp });
      // Product terminal alone does not release execution. This metadata-only worker fixture
      // owns no Native operation or output stream; its caller binding is still unoccupied.
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT current_attempt_id, current_turn_id FROM agent_session_runtime_bindings WHERE agent_session_id = ?'
          )
          .get('as_native_caller')
      ).toEqual({ current_attempt_id: null, current_turn_id: null });
      const closedCaller = markSchedulerExecutionAttemptClosing(coreDb, {
        attemptId: `lease_${turns[0]!.id}`,
        cause: 'worker-final-status',
        outcomeRef: 'fixture-caller:completed',
      });
      const proof = {
        terminalHandoff: true,
        output: true,
        evidence: true,
        outsideWorkspaceCollection: true,
        integrationDrain: true,
        routesRevoked: true,
      } as const;
      const correlation = schedulerExecutionCorrelation(closedCaller);
      const release = await new SimulatedTurnExecutor({ coreDb }).release({
        ...correlation,
        proof,
      });
      closeSchedulerExecutionAttemptWithFence(coreDb, {
        correlation,
        proof,
        fenceRef: release.fenceRef!,
      });
      coreDb.sqlite
        .prepare(`INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind, status)
        VALUES ('user_peer_admin', 'Peer Admin', 'peer-admin@example.com', 0, ?, ?, 'human', 'active')`)
        .run(Date.now(), Date.now());
      const later = store.createTurn('ws_demo', turns[0]!.threadId, 'Later read', {
        kind: 'user',
        id: 'user_peer_admin',
      });
      store.updateTurn(later.id, { agentSessionId: 'as_native_caller' });
      environmentPackage = resolveAgentEnvironmentPackage({
        captureCoverage: { scope: 'server', value: 'off' },
        agentSessionId: 'as_native_caller',
        agentSetup: createTestAgentSetup(),
        backend: { kind: 'openshell' },
        createdAt: timestamp,
        requestId: 'req_later_peers',
        triggerActor: later.triggerActor,
        turn: later,
        workspaceCwd: '/workspace',
        workspaceRoots: [],
      });
      const adminToken = createOpenKitAccessTokenRecord(coreDb, {
        expiresAt: '2099-01-01T00:00:00.000Z',
        ownerUserId: 'user_peer_admin',
        scope: 'server-admin',
        workspaceIds: [],
      });
      recordMcpWorkerLineage(coreDb, environmentPackage, adminToken.tokenId);
      await expect(
        client.callTool({ name: 'work_read_peer', arguments: { handle: readable.handle } })
      ).rejects.toMatchObject({ data: { code: 'peer_not_found' } });
      const adminPeers = (await client.callTool({ name: 'work_list_peers', arguments: {} }))
        .structuredContent!.peers as Array<Record<string, unknown>>;
      const adminPeer = adminPeers.find((entry) => entry.title === 'peer');
      expect(adminPeer).toMatchObject({
        title: 'peer',
        agentId: 'agent_codex_host',
        runtime: 'codex',
      });
      // Core Permissions' Administrator Eligibility applies to the exact bearer retained
      // by this admission, including another user's private Thread. The Sandbox limit
      // still excludes the foreign physical peer.
      expect(adminPeers.find((entry) => entry.title === 'external')).toMatchObject({
        title: 'external',
        agentId: 'agent_codex_host',
        runtime: 'codex',
      });
      expect.soft(adminPeers.find((entry) => entry.title === 'private')).toMatchObject({
        title: 'private',
        agentId: 'agent_codex_host',
        runtime: 'codex',
      });
      expect.soft(adminPeers.filter((entry) => !('title' in entry))).toHaveLength(0);
      const adminRead = await client.callTool({
        name: 'work_read_peer',
        arguments: { handle: adminPeer!.handle, cursor: '1', limit: 1 },
      });
      expect(adminRead.structuredContent!.items).toHaveLength(1);
    } finally {
      await client.close();
      await workerMcpGateway.close();
      workspaceDb.sqlite.close();
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('uses the admitted admin bearer for nonmember tool calls and denies revocation or lineage drift', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-mcp-admin-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
    const now = Date.now();
    coreDb.sqlite
      .prepare(
        "INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind, status) VALUES ('user_mcp_admin', 'MCP Admin', 'mcp-admin@example.com', false, ?, ?, 'human', 'active')"
      )
      .run(now, now);
    createOpenKitAccessTokenRecord(coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'user_mcp_admin',
      scope: 'server-admin',
      tokenId: 'token_mcp_admin',
      workspaceIds: [],
    });
    const turn = store.createTurn('ws_demo', 'th_demo', 'Call MCP as admin', {
      id: 'user_mcp_admin',
      kind: 'user',
    });
    const catalog = {
      schemaVersion: 1 as const,
      servers: [
        {
          allowedTools: ['echo'],
          approvalRequiredTools: [],
          credentialBindings: [],
          deniedTools: [],
          enabled: true,
          id: 'echo',
          pinnedSchemaSnapshotId: null,
          schemaPolicy: 'tracking' as const,
          timeoutMs: 2_000,
          transport: {
            args: [fileURLToPath(new URL('./test-support/mcp-stdio-stub.mjs', import.meta.url))],
            command: process.execPath,
            environment: {},
            kind: 'stdio' as const,
          },
        },
      ],
    };
    const environmentPackage = resolveAgentEnvironmentPackage({
      captureCoverage: { scope: 'server', value: 'off' },
      agentSessionId: 'as_mcp_admin',
      agentSetup: createTestAgentSetup({ mcpIds: ['echo'] }),
      backend: { kind: 'openshell' },
      createdAt: new Date().toISOString(),
      requestId: 'req_mcp_admin',
      triggerActor: turn.triggerActor,
      turn,
      workspaceCwd: '/workspace',
      workspaceMcpServerCatalog: catalog,
      workspaceRoots: [],
    });
    recordMcpWorkerLineage(coreDb, environmentPackage, 'token_mcp_admin');
    const workerMcpGateway = createDefaultWorkerMcpGateway(coreDb);
    const callTool = vi.spyOn(workerMcpGateway, 'callTool');
    const app = new Hono();
    registerWorkerMcpRoutes({
      app,
      coreDb,
      runtimeConfig: () =>
        createInMemoryRuntimeConfigSnapshot({
          dataRoot,
          agentManifests: [],
          workspaceMcpServerCatalogs: [
            { catalog, path: join(dataRoot, 'catalog/catalog.json'), workspaceId: 'ws_demo' },
          ],
        }),
      store,
      workerControlGateway: {
        authenticatePackageToken: vi.fn(() => environmentPackage),
      } as unknown as WorkerControlGateway,
      workerMcpGateway,
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    });
    const client = new Client({ name: 'admin-route-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL('http://nanocore.test/api/worker-capabilities/mcp/echo'),
      {
        fetch: (input, init) => app.fetch(new Request(input, init)),
        requestInit: { headers: { authorization: 'Bearer capability-token' } },
      }
    );
    const generativeClient = new Client({ name: 'admin-generative-route-test', version: '1.0.0' });
    const generativeTransport = new StreamableHTTPClientTransport(
      new URL('http://nanocore.test/api/worker-capabilities/mcp/openkit-generative'),
      {
        fetch: (input, init) => app.fetch(new Request(input, init)),
        requestInit: { headers: { authorization: 'Bearer capability-token' } },
      }
    );
    try {
      await client.connect(transport);
      await generativeClient.connect(generativeTransport);
      await expect(
        client.callTool({ arguments: { message: 'admin allowed' }, name: 'echo' })
      ).resolves.toMatchObject({ content: [{ text: 'admin allowed' }] });
      await expect(
        generativeClient.callTool({ arguments: {}, name: 'kernel_apps_list' })
      ).resolves.toMatchObject({ structuredContent: { items: [] } });
      expect(callTool).toHaveBeenCalledTimes(1);

      coreDb.sqlite
        .prepare(
          "UPDATE openkit_access_tokens SET status = 'revoked', revoked_at = ? WHERE token_id = 'token_mcp_admin'"
        )
        .run(new Date().toISOString());
      await expect(
        client.callTool({ arguments: { message: 'revoked' }, name: 'echo' })
      ).rejects.toMatchObject({ data: { code: 'mcp-denied' } });
      expect(callTool).toHaveBeenCalledTimes(1);

      coreDb.sqlite
        .prepare(
          "UPDATE openkit_access_tokens SET status = 'active', revoked_at = NULL WHERE token_id = 'token_mcp_admin'"
        )
        .run();
      coreDb.sqlite
        .prepare('UPDATE scheduler_execution_attempts SET input_ref = ? WHERE turn_id = ?')
        .run('pkg_other', turn.id);
      await expect(
        client.callTool({ arguments: { message: 'mismatched' }, name: 'echo' })
      ).rejects.toMatchObject({ data: { code: 'mcp-denied' } });
      expect(callTool).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await generativeClient.close();
      await workerMcpGateway.close();
      coreDb.sqlite.close();
    }
  });

  it.each([
    'unchanged',
    'deny',
    'revoke',
    'schema-drift',
    'tool-removed',
    'agent-removed',
    'known-error',
    'unknown-effect',
    'no-contact',
    'credential-before-claim',
    'credential-after-claim',
  ] as const)('re-evaluates current authority before granting a captured MCP call: %s', async (change) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-pending-mcp-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
    const turn = store.createTurn('ws_demo', 'th_demo', 'Call echo', {
      kind: 'user',
      id: 'user_local',
    });
    store.createAgentSession({
      id: 'as_pending_echo',
      agentId: 'agent_codex_host',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      status: 'busy',
      message: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    store.updateTurn(turn.id, { agentId: 'agent_codex_host', agentSessionId: 'as_pending_echo' });
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 7) });
    vaultUnlockState.backend().store({
      material: 'pending-secret-canary',
      metadata: { ownerScope: 'workspace', workspaceId: 'ws_demo' },
      referenceId: 'vault_pending_echo',
    });
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://workspace/ws_demo/vault/vault_pending_echo',
      displayName: 'Pending echo credential',
      ownerScope: 'workspace',
      referenceId: 'vault_pending_echo',
      secretKind: 'api-key',
      workspaceId: 'ws_demo',
    });
    const issuer = createApp({ coreDb, dataRoot, store, vaultUnlockState });
    const grantResponse = await issuer.request(
      ...operationRequest(
        'vault.grant-create',
        { workspaceId: 'ws_demo' },
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            referenceId: 'vault_pending_echo',
            injectionPath: 'gateway-only',
          }),
        }
      )
    );
    expect(grantResponse.status).toBe(200);
    const publicGrant = await grantResponse.json();
    expect(publicGrant.allowedInjectionPaths).toEqual(['gateway-only']);
    expect(JSON.stringify(publicGrant)).not.toContain('pending-secret-canary');
    const catalog = {
      schemaVersion: 1 as const,
      servers: [
        {
          id: 'echo',
          enabled: true,
          allowedTools: ['echo'],
          deniedTools: [],
          approvalRequiredTools: ['echo'],
          credentialBindings: [
            {
              sink: { kind: 'env' as const, name: 'PENDING_ECHO_SECRET' },
              slot: 'auth',
              vaultGrantId: publicGrant.grantId,
            },
          ],
          pinnedSchemaSnapshotId: null,
          schemaPolicy: 'tracking' as const,
          timeoutMs: 2_000,
          transport: {
            kind: 'stdio' as const,
            command: process.execPath,
            args: [fileURLToPath(new URL('./test-support/mcp-stdio-stub.mjs', import.meta.url))],
            environment: {},
          },
        },
      ],
    };
    const environmentPackage = resolveAgentEnvironmentPackage({
      captureCoverage: { scope: 'server', value: 'off' },
      agentSessionId: 'as_pending_echo',
      agentSetup: createTestAgentSetup({ mcpIds: ['echo'] }),
      backend: { kind: 'openshell' },
      createdAt: new Date().toISOString(),
      requestId: 'req_pending_echo',
      triggerActor: turn.triggerActor,
      turn,
      workspaceCwd: '/workspace',
      workspaceRoots: [],
      workspaceMcpServerCatalog: catalog,
    });
    expect(JSON.stringify(environmentPackage)).not.toContain('pending-secret-canary');
    recordMcpWorkerLineage(coreDb, environmentPackage);
    const snapshot = createInMemoryRuntimeConfigSnapshot({
      gatewayConfig: createTestGatewayConfig(),
      providerRegistry: new ProviderRegistry([
        {
          id: 'agent-openrouter',
          displayName: 'Agent OpenRouter',
          kind: 'local',
          models: ['openai/gpt-5.2'],
        },
      ]),
      dataRoot,
      agentManifests: [createTestAgentSetup({ mcpIds: ['echo'] }).manifest],
      workspaceMcpServerCatalogs: [
        { catalog, path: join(dataRoot, 'catalog.json'), workspaceId: 'ws_demo' },
      ],
    });
    const workerMcpGateway = createDefaultWorkerMcpGateway(coreDb);
    const originalCallTool = workerMcpGateway.callTool.bind(workerMcpGateway);
    const upstream = vi.spyOn(workerMcpGateway, 'callTool');
    const route = new Hono();
    registerWorkerMcpRoutes({
      app: route,
      coreDb,
      runtimeConfig: () => snapshot,
      store,
      workerControlGateway: {
        authenticatePackageToken: vi.fn(() => environmentPackage),
      } as unknown as WorkerControlGateway,
      workerMcpGateway,
      vaultUnlockState,
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    });
    const client = new Client({ name: 'pending-echo', version: '1' });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL('http://nanocore.test/api/worker-capabilities/mcp/echo'),
          {
            fetch: (input, init) => route.fetch(new Request(input, init)),
            requestInit: { headers: { authorization: 'Bearer capability-token' } },
          }
        )
      );
      await client.listTools();
      const pending = await client.callTool({
        name: 'echo',
        arguments: { message: 'captured effect' },
      });
      expect(pending.isError).toBe(true);
      expect(pending.structuredContent).toMatchObject({ status: 'pending-approval' });
      expect(upstream).not.toHaveBeenCalled();
      if (change === 'unchanged') {
        const boundDb = openWorkspaceDb(dataRoot, 'ws_demo');
        const countCalls = () =>
          (
            boundDb.sqlite.prepare('SELECT COUNT(*) AS count FROM capability_calls').get() as {
              count: number;
            }
          ).count;
        const beforeDuplicate = countCalls();
        const duplicate = await client.callTool({
          name: 'echo',
          arguments: { message: 'captured effect' },
        });
        expect(duplicate.structuredContent).toEqual(pending.structuredContent);
        expect(countCalls()).toBe(beforeDuplicate);
        for (let index = 1; index < 16; index += 1)
          expect(
            (
              await client.callTool({
                name: 'echo',
                arguments: { message: `different captured ${index}` },
              })
            ).isError
          ).toBe(true);
        const beforeLimit = countCalls();
        await expect(
          client.callTool({ name: 'echo', arguments: { message: 'seventeenth captured' } })
        ).rejects.toMatchObject({ data: { code: 'request_limit_reached' } });
        expect(countCalls()).toBe(beforeLimit);
        boundDb.sqlite.close();
      }
      if (change === 'unchanged') {
        const evidenceDb = openWorkspaceDb(dataRoot, 'ws_demo');
        const captured = evidenceDb.sqlite
          .prepare('SELECT request_id FROM pending_requests ORDER BY request_id')
          .all() as { request_id: string }[];
        const project = (id: string, userId = 'user_local') =>
          projectApprovalEffect({
            record: readPendingRequest(evidenceDb.sqlite, id)!,
            store,
            coreDb,
            actor: { kind: 'local', userId },
          });
        const details = captured.map((row) => project(row.request_id));
        expect(details.every((detail) => detail.status === 'available')).toBe(true);
        expect(
          new Set(details.map((detail) => detail.status === 'available' && detail.detail)).size
        ).toBe(16);
        expect(project(captured[0]!.request_id, 'another-user')).toEqual({
          status: 'unavailable',
          reason: 'Current Thread access is unavailable.',
        });
        const beforeRead = evidenceDb.sqlite
          .prepare('SELECT * FROM pending_requests ORDER BY request_id')
          .all();
        project(captured[0]!.request_id);
        expect(
          evidenceDb.sqlite.prepare('SELECT * FROM pending_requests ORDER BY request_id').all()
        ).toEqual(beforeRead);
        expect(JSON.stringify(details)).not.toContain('pending-secret-canary');
        expect(JSON.stringify(store.listAllItems())).not.toContain('captured effect');
        const copy = approvalCardCopy('多'.repeat(4000), '🙂'.repeat(4000));
        expect(Buffer.byteLength(`${copy.title}\n${copy.description}`)).toBeLessThanOrEqual(2048);
        expect(copy.title).toMatch(/^Summary:/);
        evidenceDb.sqlite.close();
      }
      expect(store.getTurnById(turn.id).status).toBe('running');
      const approvalItem = store
        .listThreadItems('ws_demo', 'th_demo')
        .find((item) => item.type === 'approval-request');
      if (!approvalItem || approvalItem.type !== 'approval-request')
        throw new Error('Missing approval request.');
      store.updateTurn(turn.id, { status: 'completed', completedAt: new Date().toISOString() });
      if (change === 'revoke') revokeVaultGrant(coreDb, { grantId: publicGrant.grantId });
      if (change === 'schema-drift') {
        const schemaDb = openWorkspaceDb(dataRoot, 'ws_demo');
        try {
          recordMcpToolSchemaSnapshot({
            environmentPackage,
            serverId: 'echo',
            source: 'live',
            schemaSnapshotId: 'mcpsnap_changed_before_grant',
            tools: [{ name: 'echo', inputSchema: { type: 'object', required: ['newField'] } }],
            workspaceDb: schemaDb,
            workspaceId: 'ws_demo',
          });
        } finally {
          schemaDb.sqlite.close();
        }
      }
      const currentSnapshot = {
        ...snapshot,
        agentManifests:
          change === 'agent-removed'
            ? []
            : snapshot.agentManifests.map((manifest) =>
                change === 'tool-removed' ? { ...manifest, mcp: [] } : manifest
              ),
      };
      const app = createApp({
        coreDb,
        store,
        workerMcpGateway,
        vaultUnlockState,
        runtimeConfigManager: createRuntimeConfigManager({
          dataRoot: null,
          initialSnapshot: currentSnapshot,
        }),
      });
      const backend = vaultUnlockState.backend();
      const resolve = backend.resolve.bind(backend);
      const resolved = vi.spyOn(backend, 'resolve').mockImplementation((input) => {
        const material = resolve(input);
        if (change === 'credential-before-claim') currentSnapshot.agentManifests.splice(0);
        return material;
      });
      if (change === 'credential-after-claim') {
        const callTool = originalCallTool;
        upstream.mockImplementationOnce(async (input) => {
          expect(resolved).toHaveBeenCalled();
          const db = openWorkspaceDb(dataRoot, 'ws_demo');
          try {
            expect(
              db.sqlite
                .prepare('SELECT claim FROM pending_requests WHERE request_id = ?')
                .get(approvalItem.approvalRequestId)
            ).toMatchObject({ claim: 'claimed' });
          } finally {
            db.sqlite.close();
          }
          currentSnapshot.agentManifests.splice(0);
          return callTool(input);
        });
      }
      if (change === 'known-error' || change === 'unknown-effect' || change === 'no-contact') {
        upstream.mockRejectedValueOnce(
          new WorkerMcpGatewayCallError(
            'mcp-call-failed',
            'Synthetic captured failure.',
            502,
            change === 'known-error'
              ? 'contacted'
              : change === 'no-contact'
                ? 'not-contacted'
                : 'unknown'
          )
        );
      }
      const executed =
        change !== 'tool-removed' &&
        change !== 'agent-removed' &&
        change !== 'credential-before-claim' &&
        change !== 'deny' &&
        change !== 'revoke' &&
        change !== 'schema-drift';
      const disposition =
        change === 'unknown-effect'
          ? 'outcome-unknown'
          : change === 'known-error' || change === 'no-contact'
            ? 'execution-error'
            : 'approved-executed';
      const response = await app.request(
        ...operationRequest(
          'approval.respond',
          { approvalRequestId: approvalItem.approvalRequestId },
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              workspaceId: 'ws_demo',
              threadId: 'th_demo',
              turnId: turn.id,
              requestId: '00000000-0000-4000-8000-000000000117',
              decision: change === 'deny' ? 'denied' : 'granted',
            }),
          }
        )
      );
      resolved.mockRestore();
      expect(response.status, await response.clone().text()).toBe(200);
      expect(upstream).toHaveBeenCalledTimes(executed ? 1 : 0);
      if (change === 'unchanged') {
        expect(upstream.mock.calls[0]?.[0]).toMatchObject({
          toolName: 'echo',
          arguments: { message: 'captured effect' },
          credentials: { environment: { PENDING_ECHO_SECRET: 'pending-secret-canary' } },
        });
      }
      const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
      try {
        if (executed) {
          expect(
            workspaceDb.sqlite
              .prepare(
                'SELECT status FROM capability_calls WHERE call_id = (SELECT execution_call_id FROM pending_requests WHERE request_id = ?)'
              )
              .get(approvalItem.approvalRequestId)
          ).toMatchObject({
            status:
              disposition === 'approved-executed'
                ? 'succeeded'
                : disposition === 'outcome-unknown'
                  ? 'unknown'
                  : 'failed',
          });
          expect(
            workspaceDb.sqlite
              .prepare(
                'SELECT count(*) AS count FROM usage_records WHERE capability_call_id = (SELECT execution_call_id FROM pending_requests WHERE request_id = ?)'
              )
              .get(approvalItem.approvalRequestId)
          ).toMatchObject({ count: change === 'no-contact' ? 0 : 1 });
          expect(
            workspaceDb.sqlite
              .prepare(
                'SELECT count(*) AS count FROM permission_decisions WHERE approval_id = ? AND result = ?'
              )
              .get(approvalItem.approvalRequestId, 'allow')
          ).toMatchObject({ count: 1 });
        }
        expect(
          workspaceDb.sqlite
            .prepare(
              'SELECT state, resolution, disposition FROM pending_requests WHERE request_id = ?'
            )
            .get(approvalItem.approvalRequestId)
        ).toMatchObject(
          change === 'agent-removed' || change === 'credential-before-claim'
            ? { state: 'ended', resolution: null }
            : {
                state: 'resolved',
                resolution: change === 'deny' ? 'denied' : 'granted',
                disposition: ['tool-removed', 'deny', 'revoke', 'schema-drift'].includes(change)
                  ? 'denied-not-executed'
                  : disposition,
              }
        );
        expect(
          workspaceDb.sqlite
            .prepare('SELECT source, catalog_entry_id FROM mcp_tool_schema_snapshots')
            .all()
        ).toEqual(
          Array.from({ length: change === 'schema-drift' ? 2 : 1 }, () => ({
            catalog_entry_id: 'echo',
            source: 'live',
          }))
        );
        const fixedNow = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-03T01:00:00Z'));
        try {
          for (const label of ['a', 'b', 'a']) {
            const tools = [{ inputSchema: { const: label }, name: 'echo' }];
            recordMcpToolSchemaSnapshot({
              environmentPackage,
              schemaSnapshotId: `mcpsnap_${label}`,
              serverId: 'echo',
              source: 'live',
              tools,
              workspaceDb,
              workspaceId: 'ws_demo',
            });
          }
        } finally {
          fixedNow.mockRestore();
        }
        expect(
          readCurrentMcpToolSchemaSnapshot({
            catalogEntryId: 'echo',
            pinnedSchemaSnapshotId: null,
            workspaceDb,
            workspaceId: 'ws_demo',
          })
        ).toMatchObject({ schemaSnapshotId: 'mcpsnap_a' });
        const importedTools = [{ inputSchema: { type: 'object' }, name: 'imported' }];
        const crossCatalogTools = [{ inputSchema: { const: 'cross' }, name: 'cross' }];
        importMcpToolSchemaSnapshots(workspaceDb, [
          {
            capturedAt: '2099-01-01T00:00:00.000Z',
            catalogEntryId: 'echo',
            contentDigest: mcpToolSchemaContentDigest(importedTools),
            schemaSnapshotId: 'mcpsnap_imported_history',
            serverVersion: '1.0.0',
            source: 'live',
            sourceRef: null,
            tools: importedTools,
            workspaceId: 'ws_demo',
          },
        ]);
        expect(
          readCurrentMcpToolSchemaSnapshot({
            catalogEntryId: 'echo',
            pinnedSchemaSnapshotId: null,
            workspaceDb,
            workspaceId: 'ws_demo',
          })
        ).not.toMatchObject({ schemaSnapshotId: 'mcpsnap_imported_history' });
        const captureCountBeforePromotion = workspaceDb.sqlite
          .prepare(
            `SELECT COUNT(*) AS count FROM audit_events
             WHERE action = 'mcp.schema.capture' AND resource = ?`
          )
          .get('mcp-schema:mcpsnap_imported_history');
        recordMcpToolSchemaSnapshot({
          environmentPackage,
          schemaSnapshotId: 'mcpsnap_imported_history',
          serverId: 'echo',
          source: 'live',
          tools: importedTools,
          workspaceDb,
          workspaceId: 'ws_demo',
        });
        recordMcpToolSchemaSnapshot({
          environmentPackage,
          schemaSnapshotId: 'mcpsnap_imported_history',
          serverId: 'echo',
          source: 'live',
          tools: importedTools,
          workspaceDb,
          workspaceId: 'ws_demo',
        });
        expect(
          workspaceDb.sqlite
            .prepare(
              `SELECT COUNT(*) AS count FROM audit_events
               WHERE action = 'mcp.schema.capture' AND resource = ?`
            )
            .get('mcp-schema:mcpsnap_imported_history')
        ).toEqual({
          count: (captureCountBeforePromotion as { count: number }).count + 1,
        });
        expect(
          readCurrentMcpToolSchemaSnapshot({
            catalogEntryId: 'echo',
            pinnedSchemaSnapshotId: null,
            workspaceDb,
            workspaceId: 'ws_demo',
          })
        ).toMatchObject({ schemaSnapshotId: 'mcpsnap_imported_history' });
        importMcpToolSchemaSnapshots(workspaceDb, [
          {
            capturedAt: '2099-01-02T00:00:00.000Z',
            catalogEntryId: 'other',
            contentDigest: mcpToolSchemaContentDigest(crossCatalogTools),
            schemaSnapshotId: 'mcpsnap_cross_catalog',
            serverVersion: '1.0.0',
            source: 'aep',
            sourceRef: 'aep_history',
            tools: crossCatalogTools,
            workspaceId: 'ws_demo',
          },
        ]);
        expect(() =>
          recordMcpToolSchemaSnapshot({
            environmentPackage,
            schemaSnapshotId: 'mcpsnap_cross_catalog',
            serverId: 'echo',
            source: 'live',
            tools: importedTools,
            workspaceDb,
            workspaceId: 'ws_demo',
          })
        ).toThrow('MCP schema snapshot identity conflicts');
        expect(
          workspaceDb.sqlite
            .prepare(
              `SELECT catalog_entry_id, source
               FROM mcp_tool_schema_snapshots
               WHERE snapshot_id = 'mcpsnap_cross_catalog'`
            )
            .get()
        ).toEqual({ catalog_entry_id: 'other', source: 'aep' });
        workspaceDb.sqlite
          .prepare(
            "DELETE FROM mcp_tool_schema_snapshots WHERE snapshot_id = 'mcpsnap_cross_catalog'"
          )
          .run();
        for (let index = 0; index < 10; index += 1) {
          recordMcpToolSchemaSnapshot({
            environmentPackage,
            schemaSnapshotId: `mcpsnap_retention_${String(index).padStart(2, '0')}`,
            serverId: 'echo',
            source: 'live',
            tools: [{ inputSchema: { const: index }, name: 'echo' }],
            workspaceDb,
            workspaceId: 'ws_demo',
          });
        }
        expect(
          workspaceDb.sqlite
            .prepare('SELECT COUNT(*) AS count FROM mcp_tool_schema_snapshots')
            .get()
        ).toEqual({ count: 9 });
      } finally {
        workspaceDb.sqlite.close();
      }
    } finally {
      await client.close().catch(() => undefined);
      await workerMcpGateway.close();
      coreDb.sqlite.close();
    }
  });

  it.each([
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
  ])('starts a definition-derived $entry, observes attention, responds and delivers the captured outcome once', async ({
    transientPreparation,
    ownerCommand,
    refuseFirst,
    decision,
  }) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-mcp-lifecycle-'));
    const exportRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-mcp-lifecycle-export-'));
    const callFile = join(dataRoot, 'mcp-calls.txt');
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
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
          approvalRequiredTools: ['echo'],
          enabled: true,
          id: 'echo',
          schemaPolicy: 'tracking',
          timeoutMs: 2_000,
          transport: {
            args: [
              fileURLToPath(new URL('./test-support/mcp-stdio-stub.mjs', import.meta.url)),
              callFile,
            ],
            command: process.execPath,
            kind: 'stdio',
          },
        },
      ],
    });
    const runtimeConfigManager = createRuntimeConfigManager({
      dataRoot,
      initialSnapshot: createInMemoryRuntimeConfigSnapshot({
        agentManifests: [agentSetup.manifest],
        dataRoot,
        gatewayConfig: createTestGatewayConfig(),
        openKitConfig: { defaults: { defaultAgentId: agentSetup.manifest.id } },
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
            path: join(dataRoot, 'workspaces', 'ws_demo', 'config', 'workspace.jsonc'),
            workspaceId: 'ws_demo',
          },
        ],
        workspaceMcpServerCatalogs: [
          {
            catalog,
            path: join(dataRoot, 'workspaces', 'ws_demo', 'config', 'catalog/catalog.json'),
            workspaceId: 'ws_demo',
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
              targets: [{ target: '/workspace' }],
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
            expect(request.input.maxByteLength).toBeLessThanOrEqual(16 * 1024 * 1024 + 1);
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
    const workerLifecycleRuntime = createConfiguredWorkerLifecycleRuntime({
      coreDb,
      env: {},
      nanoHostSessionDispatch,
      store,
      workerControlGateway,
      workspaceMutationAdmission,
    });
    const app = createApp({
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
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        const binding = coreDb.sqlite
          .prepare(
            `SELECT sandbox_integration_binding_ref AS integrationRef
             FROM sandbox_runtime_records
             LIMIT 1`
          )
          .get() as { integrationRef: string } | undefined;
        const command = binding
          ? dispatchNanoHostHarnessOperation(coreDb, {
              sandboxIntegrationBindingRef: binding.integrationRef,
            })
          : null;
        if (command) {
          if (operation === 'turn.start' && command.operation === 'session.inspect') {
            workerLifecycleRuntime.acceptNanoHostHarnessCommand(command);
            settle(
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
          workerLifecycleRuntime.acceptNanoHostHarnessCommand(command);
          return { command, integrationRef: binding!.integrationRef };
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }
      throw new Error(
        `Expected queued NanoHost Harness operation: ${operation}; Turns: ${JSON.stringify(store.listThreadTurns('ws_demo', 'th_demo').map((turn) => ({ id: turn.id, status: turn.status, error: turn.error })))}; Queue: ${JSON.stringify(coreDb.sqlite.prepare('SELECT status, denial_reason FROM scheduler_admission_entries').all())}`
      );
    };
    const settle = (
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
      workerLifecycleRuntime.acceptNanoHostHarnessResult(result);
    };
    const driveTask = async (blocked: boolean) => {
      if (blocked) {
        const opened = await dispatchNext('session.open');
        settle(opened, {
          maxActiveTurns: 1,
          nativeHandleDigest: null,
          nativeHandleState: 'pending',
          state: 'open',
        });
      }
      const started = await dispatchNext('turn.start');
      settle(started, {
        nativeHandleDigest: blocked ? null : 'b'.repeat(64),
        nativeHandleState: blocked ? 'pending' : 'ready',
        state: 'started',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const commandBody = started.command.body as Record<string, unknown>;
      const capabilityToken = String(commandBody.capabilityToken);
      const workerControlToken = String(commandBody.workerControlToken);
      const environmentPackage = workerControlGateway.authenticatePackageToken(
        `Bearer ${capabilityToken}`,
        { tokenFamily: 'capability' }
      );
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
        discovery.tools.find((tool) => tool.name === 'work_submit_artifact')?.description
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
          name: 'work_submit_artifact',
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
          name: 'work_submit_artifact',
          arguments: {
            ...submission,
            requestId: `credential-refusal-${environmentPackage.scope.turnId}`,
          },
        })
      ).rejects.toMatchObject({ data: { code: 'invalid_request' } });
      expect(
        store
          .listArtifacts('ws_demo')
          .filter((artifact) => artifact.turnId === environmentPackage.scope.turnId)
      ).toHaveLength(0);
      expect(store.getTurnById(environmentPackage.scope.turnId).status).toBe('running');
      writeFileSync(liveFilePath, originalBytes);
      const capturesBefore = liveCaptureCount;
      const submitted = await work.callTool({
        name: 'work_submit_artifact',
        arguments: submission,
      });
      expect(submitted.isError).toBe(false);
      const artifactId = String(submitted.structuredContent!.artifactId);
      const readback = await app.request(
        ...operationRequest('artifact.read', { workspaceId: 'ws_demo', artifactId })
      );
      expect(readback.status).toBe(200);
      expect(await readback.json()).toMatchObject({
        id: artifactId,
        content: { body: readFileSync(liveFilePath, 'utf8') },
      });

      expect(store.getArtifact('ws_demo', artifactId).content.body).toBe(
        readFileSync(liveFilePath, 'utf8')
      );
      const publishedBytes = readFileSync(liveFilePath);
      writeFileSync(liveFilePath, 'A later edit cannot mutate the committed output.');
      expect(
        (await work.callTool({ name: 'work_submit_artifact', arguments: submission }))
          .structuredContent!.artifactId
      ).toBe(artifactId);
      expect(liveCaptureCount).toBe(capturesBefore + 1);
      expect(store.getArtifact('ws_demo', artifactId).content.body).toBe(
        publishedBytes.toString('utf8')
      );
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
        const deliveryDb = openWorkspaceDb(dataRoot, 'ws_demo');
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
      settle(inspected, {
        childState: 'absent',
        cleanupState: 'clean',
        nativeHandleDigest: 'b'.repeat(64),
        nativeHandleState: 'ready',
        state: 'open',
      });
      return { agentSessionId: environmentPackage.scope.agentSessionId, toolCall };
    };

    try {
      const firstRequest = app.request(
        ...operationRequest(
          ownerCommand,
          { workspaceId: 'ws_demo', threadId: 'th_demo' },
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
      const [firstResponse, firstRun] = await Promise.all([firstRequest, driveTask(true)]);
      expect(firstResponse.status, await firstResponse.clone().text()).toBe(202);
      const firstTask =
        ownerCommand === 'conversation.submit'
          ? SubmitConversationResponseSchema.parse(await firstResponse.json())
          : StartTaskModeResponseSchema.parse(await firstResponse.json());
      for (
        let attempt = 0;
        attempt < 1000 && store.getTurnById(firstTask.turn.id).status === 'running';
        attempt += 1
      )
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      const durableTurn = store.getTurnById(firstTask.turn.id);
      expect(durableTurn.status).toBe('completed');
      if ('outcome' in firstTask) expect(firstTask.outcome).toBe('accepted');
      expect(store.getAgentSession(firstRun.agentSessionId).status).toBe('idle');
      expect(
        store
          .listCommandRequests()
          .filter(
            (receipt) =>
              receipt.response.kind === 'turn' && receipt.response.id === firstTask.turn.id
          )
          .map((receipt) => receipt.command)
      ).toEqual([ownerCommand]);
      // Settled owner replay is compared across all three projections without another Worker launch.
      const replayInput = {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        input: 'Implement the bounded MCP Task fix.',
        requestId: '0190f4c8-0000-7000-8000-000000000501',
        ...(ownerCommand === 'conversation.submit'
          ? { artifactRefs: [], targetRef: `warm-worker:${agentSetup.manifest.id}:default` }
          : {}),
      };
      const nativeClient = createCoreClient({
        baseUrl: 'http://nanocore.test',
        fetch: (input, init) => app.fetch(new Request(input, init)),
      });
      const replayResponse = await app.request(
        ...operationRequest(ownerCommand, {}, { body: JSON.stringify(replayInput) })
      );
      expect(replayResponse.status, await replayResponse.clone().text()).toBe(202);
      const replayResult = await replayResponse.json();
      expect(await nativeClient.operations[ownerCommand](replayInput as never)).toEqual(
        replayResult
      );
      const { operationCatalog } = await import(
        new URL('../../../skills/openkit-operations.mjs', import.meta.url).href
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
        ...operationRequest('attention.list', { workspaceId: 'ws_demo' }, undefined)
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
          ? vi
              .spyOn(runtimeConfigManager, 'current')
              .mockReturnValue({ ...originalSnapshot, providerRegistry: new ProviderRegistry([]) })
          : undefined;
      const detailResponse = await app.request('/api/app/operations/thread.dashboard', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: 'ws_demo', threadId: 'th_demo' }),
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
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
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
      let continuation: Awaited<ReturnType<typeof driveTask>>;
      if (refuseFirst) {
        responded = await approvalResponse;
        const reviewDb = openWorkspaceDb(dataRoot, 'ws_demo');
        for (let n = 0; n < 2000; n++) {
          const record = readPendingRequest(reviewDb.sqlite, repositoryApprovalId!);
          if (record?.delivery === 'undelivered' && record.publicationTurnId) break;
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
            coreDb.sqlite
              .prepare('SELECT status FROM scheduler_admission_entries WHERE turn_id = ?')
              .get(refused.publicationTurnId)
          ).toEqual({ status: 'admitted' });
          expect(
            coreDb.sqlite
              .prepare(
                'SELECT phase, disposition, operation_id FROM scheduler_execution_attempts WHERE turn_id = ?'
              )
              .get(refused.publicationTurnId)
          ).toEqual({ phase: 'closed', disposition: 'not_accepted', operation_id: null });
          const count = store.listThreadTurns('ws_demo', 'th_demo').length;
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(store.listThreadTurns('ws_demo', 'th_demo')).toHaveLength(count);
          preparationFault!.mockRestore();
          reviewDb.sqlite.close();
          return;
        }
        expect(refused.delivery).toBe('undelivered');
        expect(refused.disposition).toBe('denied-not-executed');
        expect(store.getTurnById(refused.publicationTurnId!).status).toBe('failed');
        expect(
          reviewDb.sqlite
            .prepare('SELECT count(*) AS count FROM pending_requests WHERE delivery = ?')
            .get('frozen')
        ).toEqual({ count: 0 });
        expect(
          coreDb.sqlite
            .prepare(
              "SELECT count(*) AS count FROM scheduler_admission_entries WHERE turn_id = ? AND status = 'queued'"
            )
            .get(refused.publicationTurnId)
        ).toEqual({ count: 0 });
        const count = store.listThreadTurns('ws_demo', 'th_demo').length;
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(store.listThreadTurns('ws_demo', 'th_demo')).toHaveLength(count);
        providerFault!.mockRestore();
        const user = app.request(
          ...operationRequest(
            'conversation.submit',
            { workspaceId: 'ws_demo', threadId: 'th_demo' },
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                input: 'Continue after refused admission.',
                requestId: '0190f4c8-0000-7000-8000-000000000599',
                artifactRefs: [],
                targetRef: `warm-worker:${agentSetup.manifest.id}:default`,
              }),
            }
          )
        );
        const [userResponse, resumed] = await Promise.all([user, driveTask(false)]);
        expect(userResponse.status, await userResponse.clone().text()).toBe(202);
        continuation = resumed;
        const delivered = readPendingRequest(reviewDb.sqlite, repositoryApprovalId!)!;
        expect(delivered.delivery).toBe('delivered');
        expect(delivered.publicationTurnId).toBe(refused.publicationTurnId);
        expect(delivered.deliveryTurnId).not.toBe(refused.publicationTurnId);
        expect(store.getTurnById(delivered.deliveryTurnId!).items).toContainEqual(
          expect.objectContaining({
            type: 'user-message',
            text: expect.stringContaining('Continue after refused admission.'),
          })
        );
        const trigger = store
          .getTurnById(delivered.deliveryTurnId!)
          .items.find((item) => item.type === 'user-message');
        if (!trigger || trigger.type !== 'user-message')
          throw new Error('Missing independent user trigger');
        expect(JSON.parse(trigger.text).objective).toBe('Continue after refused admission.');
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
      const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
      try {
        expect(readPendingRequest(workspaceDb.sqlite, repositoryApprovalId!)?.delivery).toBe(
          'delivered'
        );
        expect(
          store
            .listThreadItems('ws_demo', 'th_demo')
            .filter(
              (item) =>
                item.type === 'approval-decision' && item.approvalRequestId === repositoryApprovalId
            )
        ).toHaveLength(1);
        expect(
          store
            .listThreadTurns('ws_demo', 'th_demo')
            .filter((turn) => turn.triggerSource?.kind === 'approval-resolution')
        ).toHaveLength(1);
      } finally {
        workspaceDb.sqlite.close();
      }
      if (!refuseFirst)
        expect(readFileSync(callFile, 'utf8').trim().split('\n')).toEqual(['public-task']);
      else expect(existsSync(callFile)).toBe(false);
    } finally {
      await workerMcpGateway.close();
      coreDb.sqlite.close();
      rmSync(exportRoot, { force: true, recursive: true });
      rmSync(dataRoot, { force: true, recursive: true });
    }
  }, 30_000);

  it('maps the bounded MCP failure table without extra tool effects', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-mcp-failures-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const ownerCreatedAt = Date.now();
    coreDb.sqlite
      .prepare(
        `INSERT INTO users (
          id, display_name, email, email_verified, created_at, updated_at, kind, status, disabled_at
        ) VALUES ('user_backup_owner', 'Backup owner', 'backup@example.com', false, ?, ?, 'human', 'active', NULL)`
      )
      .run(ownerCreatedAt, ownerCreatedAt);
    const store = createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_backup_owner',
      workspaceId: 'ws_demo',
    });
    const memberCreatedAt = new Date().toISOString();
    coreDb.sqlite
      .prepare(
        `INSERT INTO workspace_members (
          workspace_id, user_id, status, access_level, invitation_id, joined_at,
          removed_at, revision, created_at, updated_at
        ) VALUES ('ws_demo', 'user_local', 'active', 'editor', NULL, ?, NULL, 1, ?, ?)`
      )
      .run(memberCreatedAt, memberCreatedAt, memberCreatedAt);
    const turn = store.createTurn('ws_demo', 'th_demo', 'Classify MCP failures', {
      id: 'user_local',
      kind: 'user',
    });
    const server = (id: string, schemaPolicy: 'pinned' | 'tracking' = 'tracking') => ({
      allowedTools: ['echo'],
      approvalRequiredTools: [],
      credentialBindings: [],
      deniedTools: [],
      enabled: true,
      id,
      pinnedSchemaSnapshotId: schemaPolicy === 'pinned' ? 'mcpsnap_expected' : null,
      schemaPolicy,
      timeoutMs: 100,
      transport: { args: [], command: process.execPath, environment: {}, kind: 'stdio' as const },
    });
    const catalog = {
      schemaVersion: 1 as const,
      servers: [
        server('echo'),
        server('duplicate'),
        server('pinned', 'pinned'),
        server('unavailable'),
        server('whitespace'),
        server('authority-race'),
        server('gate-race'),
        server('schema-cancel'),
      ],
    };
    let environmentPackage = resolveAgentEnvironmentPackage({
      captureCoverage: { scope: 'server', value: 'off' },
      agentSessionId: 'as_mcp_failures',
      agentSetup: createTestAgentSetup({
        mcpIds: [
          'echo',
          'duplicate',
          'pinned',
          'unavailable',
          'whitespace',
          'authority-race',
          'gate-race',
          'schema-cancel',
        ],
      }),
      backend: { kind: 'openshell' },
      createdAt: '2026-09-03T00:00:00.000Z',
      requestId: 'req_mcp_failures',
      triggerActor: turn.triggerActor,
      turn,
      workspaceCwd: '/workspace',
      workspaceMcpServerCatalog: catalog,
      workspaceRoots: [],
    });
    const authorizedEnvironmentPackage = environmentPackage;
    recordMcpWorkerLineage(coreDb, environmentPackage);
    // Production records the AgentSession and then its AEP snapshot before the worker that reaches
    // this gateway exists. The snapshot directory is pruned to the AgentSessions the store knows
    // (`workspace-file-records.ts` removeStaleDirectories), so the record has to exist here too.
    store.createAgentSession({
      agentId: environmentPackage.agent.agentId,
      createdAt: '2026-09-03T00:00:00.000Z',
      id: environmentPackage.scope.agentSessionId,
      message: null,
      status: 'busy',
      threadId: turn.threadId,
      updatedAt: '2026-09-03T00:00:00.000Z',
      workspaceId: turn.workspaceId,
    });
    const snapshotDb = openWorkspaceDb(dataRoot, 'ws_demo');
    applyScopedMigrations(snapshotDb);
    try {
      recordAgentEnvironmentPackageSnapshot(snapshotDb, {
        createdAt: '2026-09-03T00:00:00.000Z',
        environmentPackage,
      });
    } finally {
      snapshotDb.sqlite.close();
    }
    const emptyNearLimitResult = { content: [{ text: '', type: 'text' as const }] };
    const nearLimitResult = {
      content: [
        {
          text: 'x'.repeat(
            512 * 1024 - Buffer.byteLength(JSON.stringify(emptyNearLimitResult), 'utf8')
          ),
          type: 'text' as const,
        },
      ],
    };
    const callTool = vi.fn(async (request: Parameters<WorkerMcpGateway['callTool']>[0]) => {
      const message = request.arguments.message;
      if (message === 'near-limit') return nearLimitResult;
      if (message === 'timeout') {
        throw new WorkerMcpGatewayCallError(
          'mcp-timeout',
          'MCP request timed out.',
          504,
          'unknown'
        );
      }
      if (message === 'crash') {
        throw new WorkerMcpGatewayCallError(
          'mcp-call-failed',
          'MCP tool call failed.',
          503,
          'unknown'
        );
      }
      if (message === 'oversize') {
        throw new WorkerMcpGatewayCallError(
          'mcp-result-too-large',
          MCP_RESULT_TOO_LARGE_MESSAGE,
          413,
          'contacted'
        );
      }
      if (message === 'tool-error') {
        throw new WorkerMcpGatewayCallError(
          'mcp-call-failed',
          'MCP tool call failed.',
          502,
          'contacted'
        );
      }
      if (message === 'cancelled') {
        await new Promise<void>((_resolve, reject) => {
          const fail = () =>
            reject(
              new WorkerMcpGatewayCallError(
                'mcp-call-failed',
                'MCP tool call was cancelled.',
                499,
                'unknown',
                true
              )
            );
          if (request.signal?.aborted) fail();
          else request.signal?.addEventListener('abort', fail, { once: true });
        });
      }
      if (message === 'pre-cancelled') {
        throw new WorkerMcpGatewayCallError(
          'mcp-call-failed',
          'MCP tool call was cancelled.',
          503,
          'not-contacted',
          true
        );
      }
      return { content: [{ text: String(message), type: 'text' as const }] };
    });
    let listBarrier:
      | {
          readonly entered: (signal: AbortSignal | undefined) => void;
          readonly released: Promise<void>;
          readonly serverId: string;
        }
      | undefined;
    const createListBarrier = (serverId: string) => {
      let markEntered!: (signal: AbortSignal | undefined) => void;
      let release!: () => void;
      const entered = new Promise<AbortSignal | undefined>((resolve) => {
        markEntered = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      listBarrier = { entered: markEntered, released, serverId };
      return { entered, release };
    };
    const listTools = vi.fn(async (request: Parameters<WorkerMcpGateway['listTools']>[0]) => {
      if (listBarrier?.serverId === request.server.id) {
        listBarrier.entered(request.signal);
        await listBarrier.released;
      }
      if (request.signal?.aborted) {
        throw new WorkerMcpGatewayCallError(
          'mcp-server-unavailable',
          'MCP server is unavailable.',
          503,
          'unknown',
          true
        );
      }
      if (request.server.id === 'unavailable') {
        throw new WorkerMcpGatewayCallError(
          'mcp-server-unavailable',
          'MCP server is unavailable.',
          503,
          'not-contacted'
        );
      }
      if (request.server.id === 'duplicate') {
        return {
          serverVersion: '1.0.0',
          tools: [mcpEchoTool(), mcpEchoTool()],
        };
      }
      if (request.server.id === 'whitespace') {
        return {
          serverVersion: '1.0.0',
          tools: [{ ...mcpEchoTool(), name: ' echo ' }],
        };
      }
      return {
        serverVersion: '1.0.0',
        tools: [mcpEchoTool()],
      };
    });
    const workerMcpGateway = {
      callTool,
      close: vi.fn(async () => undefined),
      closeServer: vi.fn(async () => undefined),
      closeServerIfIdle: vi.fn(async () => undefined),
      closeWorkspace: vi.fn(async () => undefined),
      getServerHealth: vi.fn(() => 'inactive' as const),
      listTools,
    } satisfies WorkerMcpGateway;
    const app = new Hono();
    const workspaceMutationAdmission = new WorkspaceMutationAdmission();
    registerWorkerMcpRoutes({
      app,
      coreDb,
      runtimeConfig: () =>
        createInMemoryRuntimeConfigSnapshot({
          agentManifests: [],
          dataRoot,
          workspaceMcpServerCatalogs: [
            { catalog, path: join(dataRoot, 'catalog/catalog.json'), workspaceId: 'ws_demo' },
          ],
        }),
      store,
      workerControlGateway: {
        authenticatePackageToken: vi.fn(() => environmentPackage),
      } as unknown as WorkerControlGateway,
      workerMcpGateway,
      workspaceMutationAdmission,
    });
    const clients: Client[] = [];
    const connect = async (serverId: string) => {
      const client = new Client({ name: `failure-${serverId}`, version: '1.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://nanocore.test/api/worker-capabilities/mcp/${serverId}`),
          {
            fetch: (request, init) => app.fetch(new Request(request, init)),
            requestInit: { headers: { authorization: 'Bearer capability-token' } },
          }
        )
      );
      clients.push(client);
      return client;
    };

    try {
      const echo = await connect('echo');
      const rawCall = (id: string | number, message = 'typed-id') =>
        app.request('/api/worker-capabilities/mcp/echo', {
          body: JSON.stringify({
            id,
            jsonrpc: '2.0',
            method: 'tools/call',
            params: { arguments: { message }, name: 'echo' },
          }),
          headers: {
            accept: 'application/json, text/event-stream',
            authorization: 'Bearer capability-token',
            'content-type': 'application/json',
          },
          method: 'POST',
        });
      const typedIdCallsBefore = callTool.mock.calls.length;
      for (const id of [424_242, '424242'] as const) {
        const response = await rawCall(id);
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ id, result: expect.any(Object) });
      }
      const replay = await rawCall(424_242);
      expect(replay.status).toBe(200);
      await expect(replay.json()).resolves.toMatchObject({
        error: { data: { code: 'mcp-denied' } },
        id: 424_242,
      });
      expect(callTool.mock.calls.length).toBe(typedIdCallsBefore + 2);
      const typedIdDb = openWorkspaceDb(dataRoot, 'ws_demo');
      const typedIdRows = typedIdDb.sqlite
        .prepare(
          `SELECT call_id, item_id
           FROM capability_calls
           WHERE operation = 'mcp.call_tool'
           ORDER BY rowid`
        )
        .all() as Array<{ call_id: string; item_id: string }>;
      expect(typedIdRows).toEqual([
        { call_id: expect.stringMatching(/^cap_mcp_/), item_id: expect.stringMatching(/^it_mcp_/) },
        { call_id: expect.stringMatching(/^cap_mcp_/), item_id: expect.stringMatching(/^it_mcp_/) },
      ]);
      expect(new Set(typedIdRows.map((row) => row.call_id)).size).toBe(2);
      expect(new Set(typedIdRows.map((row) => row.item_id)).size).toBe(2);
      typedIdDb.sqlite.close();
      const failures = [
        { arguments: { message: 'blocked' }, code: 'mcp-tool-not-found', name: 'missing' },
        { arguments: { message: 'blocked' }, code: 'mcp-tool-not-found', name: 'x'.repeat(257) },
        { arguments: {}, code: 'mcp-invalid-arguments', name: 'echo' },
        { arguments: { message: 'timeout' }, code: 'mcp-timeout', name: 'echo' },
        { arguments: { message: 'crash' }, code: 'mcp-call-failed', name: 'echo' },
        { arguments: { message: 'oversize' }, code: 'mcp-result-too-large', name: 'echo' },
        { arguments: { message: 'tool-error' }, code: 'mcp-call-failed', name: 'echo' },
      ] as const;
      for (const failure of failures) {
        const before = callTool.mock.calls.length;
        await expect(
          echo.callTool({ arguments: failure.arguments, name: failure.name })
        ).rejects.toMatchObject({
          data: { code: failure.code },
          ...(failure.code === 'mcp-result-too-large'
            ? {
                message: expect.stringContaining(
                  'MCP tool result exceeds the capability response limit. Route bulk output through artifacts or the data plane.'
                ),
              }
            : {}),
        });
        expect(callTool.mock.calls.length - before).toBe(
          ['mcp-timeout', 'mcp-call-failed', 'mcp-result-too-large'].includes(failure.code) ? 1 : 0
        );
      }
      const cancellation = new AbortController();
      const callsBeforeCancellation = callTool.mock.calls.length;
      const cancelled = echo.callTool(
        { arguments: { message: 'cancelled' }, name: 'echo' },
        { signal: cancellation.signal }
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      cancellation.abort();
      await expect(cancelled).rejects.toThrow(/AbortError/);
      expect(callTool.mock.calls.length).toBe(callsBeforeCancellation + 1);
      const callsBeforePreCancellation = callTool.mock.calls.length;
      await expect(
        echo.callTool({ arguments: { message: 'pre-cancelled' }, name: 'echo' })
      ).rejects.toMatchObject({ data: { code: 'mcp-call-failed' } });
      expect(callTool.mock.calls.length).toBe(callsBeforePreCancellation + 1);
      const schemaDbBefore = openWorkspaceDb(dataRoot, 'ws_demo');
      const schemaCountBefore = schemaDbBefore.sqlite
        .prepare('SELECT COUNT(*) AS count FROM mcp_tool_schema_snapshots')
        .get();
      schemaDbBefore.sqlite.close();
      const duplicate = await connect('duplicate');
      await expect(duplicate.listTools()).rejects.toMatchObject({
        data: { code: 'mcp-server-unavailable' },
      });
      const whitespace = await connect('whitespace');
      await expect(whitespace.listTools()).rejects.toMatchObject({
        data: { code: 'mcp-server-unavailable' },
      });
      const schemaDb = openWorkspaceDb(dataRoot, 'ws_demo');
      try {
        expect(
          schemaDb.sqlite.prepare('SELECT COUNT(*) AS count FROM mcp_tool_schema_snapshots').get()
        ).toEqual(schemaCountBefore);
      } finally {
        schemaDb.sqlite.close();
      }
      const pinned = await connect('pinned');
      await expect(
        pinned.callTool({ arguments: { message: 'drift' }, name: 'echo' })
      ).rejects.toMatchObject({ data: { code: 'mcp-schema-drift' } });
      const unavailable = await connect('unavailable');
      await expect(
        unavailable.callTool({ arguments: { message: 'offline' }, name: 'echo' })
      ).rejects.toMatchObject({ data: { code: 'mcp-server-unavailable' } });

      const schemaCancel = await connect('schema-cancel');
      const schemaCancelBarrier = createListBarrier('schema-cancel');
      const schemaCancellation = new AbortController();
      const upstreamCallsBeforeSchemaCancellation = callTool.mock.calls.length;
      const schemaCancellationDb = openWorkspaceDb(dataRoot, 'ws_demo');
      const usageBeforeSchemaCancellation = schemaCancellationDb.sqlite
        .prepare('SELECT COUNT(*) AS count FROM usage_records')
        .get();
      schemaCancellationDb.sqlite.close();
      const schemaCancelledCall = schemaCancel.callTool(
        { arguments: { message: 'schema-cancel' }, name: 'echo' },
        { signal: schemaCancellation.signal }
      );
      const schemaCancelledOutcome = schemaCancelledCall.then(
        () => null,
        (error: unknown) => error
      );
      const schemaCancellationSignal = await schemaCancelBarrier.entered;
      if (!schemaCancellationSignal) throw new Error('Expected a gateway cancellation signal.');
      const schemaCancellationObserved = new Promise<void>((resolve) => {
        if (schemaCancellationSignal.aborted) resolve();
        else schemaCancellationSignal.addEventListener('abort', () => resolve(), { once: true });
      });
      schemaCancellation.abort();
      await schemaCancellationObserved;
      schemaCancelBarrier.release();
      expect(String(await schemaCancelledOutcome)).toMatch(/AbortError/);
      await vi.waitFor(() => {
        const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
        try {
          expect(
            workspaceDb.sqlite
              .prepare(
                `SELECT status
                 FROM capability_calls
                 WHERE provider_ref = 'schema-cancel'
                 ORDER BY rowid DESC
                 LIMIT 1`
              )
              .get()
          ).toEqual({ status: 'aborted' });
        } finally {
          workspaceDb.sqlite.close();
        }
      });
      expect(callTool).toHaveBeenCalledTimes(upstreamCallsBeforeSchemaCancellation);
      const afterSchemaCancellationDb = openWorkspaceDb(dataRoot, 'ws_demo');
      expect(
        afterSchemaCancellationDb.sqlite
          .prepare('SELECT COUNT(*) AS count FROM usage_records')
          .get()
      ).toEqual(usageBeforeSchemaCancellation);
      afterSchemaCancellationDb.sqlite.close();

      const authorityRace = await connect('authority-race');
      const authorityBarrier = createListBarrier('authority-race');
      const upstreamCallsBeforeAuthorityRace = callTool.mock.calls.length;
      const authorityRaceCall = authorityRace.callTool({
        arguments: { message: 'authority-race' },
        name: 'echo',
      });
      await authorityBarrier.entered;
      coreDb.sqlite
        .prepare(
          `UPDATE workspace_members
           SET status = 'removed', removed_at = ?, revision = revision + 1, updated_at = ?
           WHERE workspace_id = 'ws_demo' AND user_id = 'user_local'`
        )
        .run(new Date().toISOString(), new Date().toISOString());
      authorityBarrier.release();
      await expect(authorityRaceCall).rejects.toMatchObject({ data: { code: 'mcp-denied' } });
      expect(callTool).toHaveBeenCalledTimes(upstreamCallsBeforeAuthorityRace);
      coreDb.sqlite
        .prepare(
          `UPDATE workspace_members
           SET status = 'active', removed_at = NULL, revision = revision + 1, updated_at = ?
           WHERE workspace_id = 'ws_demo' AND user_id = 'user_local'`
        )
        .run(new Date().toISOString());

      const itemCountBeforeAuditFailure = store.listAllItems().length;
      const auditFailureDb = openWorkspaceDb(dataRoot, 'ws_demo');
      try {
        auditFailureDb.sqlite.exec(`
          CREATE TRIGGER reject_mcp_finish_audit
          BEFORE INSERT ON audit_events
          WHEN NEW.action = 'capability.finish'
          BEGIN
            SELECT RAISE(ABORT, 'injected capability finish audit failure');
          END;
        `);
        const listServersFailure = await app.request('/api/worker-capabilities/mcp/_list-servers', {
          body: '{}',
          headers: {
            authorization: 'Bearer capability-token',
            'content-type': 'application/json',
          },
          method: 'POST',
        });
        const listServersFailureBody = await listServersFailure.json();
        expect(listServersFailureBody).toMatchObject({
          error: { data: { code: 'recovery_required' } },
        });
        expect(JSON.stringify(listServersFailureBody)).not.toContain(
          'injected capability finish audit failure'
        );
        await expect(echo.listTools()).rejects.toMatchObject({
          data: { code: 'recovery_required' },
        });
        await expect(
          echo.callTool({ arguments: { message: 'finish-audit-failure' }, name: 'echo' })
        ).rejects.toMatchObject({ data: { code: 'recovery_required' } });
        expect(store.listAllItems()).toHaveLength(itemCountBeforeAuditFailure);
      } finally {
        auditFailureDb.sqlite.exec('DROP TRIGGER IF EXISTS reject_mcp_finish_audit');
        auditFailureDb.sqlite.close();
      }

      const itemCountBeforeUsageFailure = store.listAllItems().length;
      const usageFailureDb = openWorkspaceDb(dataRoot, 'ws_demo');
      try {
        usageFailureDb.sqlite.exec(`
          CREATE TRIGGER reject_mcp_usage
          BEFORE INSERT ON usage_records
          BEGIN
            SELECT RAISE(ABORT, 'injected MCP usage failure');
          END;
        `);
        await expect(
          echo.callTool({ arguments: { message: 'usage-failure' }, name: 'echo' })
        ).rejects.toMatchObject({ data: { code: 'recovery_required' } });
        expect(store.listAllItems()).toHaveLength(itemCountBeforeUsageFailure);
      } finally {
        usageFailureDb.sqlite.exec('DROP TRIGGER IF EXISTS reject_mcp_usage');
        usageFailureDb.sqlite.close();
      }

      const itemCountBeforePublicationFailure = store.listAllItems().length;
      const createItem = vi.spyOn(store, 'createItem').mockImplementationOnce(() => {
        throw new Error('injected MCP Item publication failure');
      });
      await expect(
        echo.callTool({ arguments: { message: 'item-publication-failure' }, name: 'echo' })
      ).resolves.toMatchObject({ content: [{ text: 'item-publication-failure' }] });
      createItem.mockRestore();
      expect(store.listAllItems()).toHaveLength(itemCountBeforePublicationFailure);
      const terminalDb = openWorkspaceDb(dataRoot, 'ws_demo');
      const successfulUnpublished = terminalDb.sqlite
        .prepare(
          `SELECT call_id, item_id, status
           FROM capability_calls
           WHERE operation = 'mcp.call_tool'
           ORDER BY rowid DESC
           LIMIT 1`
        )
        .get() as { call_id: string; item_id: string; status: string };
      terminalDb.sqlite.close();
      expect(successfulUnpublished.status).toBe('succeeded');
      verifyAndMigrateExistingScopedDatabases(dataRoot);
      expect(reconcileWorkerMcpItems(dataRoot, store)).toBeGreaterThan(0);
      expect(store.listAllItems()).toContainEqual(
        expect.objectContaining({
          causationId: successfulUnpublished.call_id,
          id: successfulUnpublished.item_id,
          status: 'completed',
        })
      );

      const deniedTurn = store.createTurn('ws_demo', 'th_demo', 'Reject unauthorized MCP use', {
        id: 'user_outsider',
        kind: 'user',
      });
      environmentPackage = resolveAgentEnvironmentPackage({
        captureCoverage: { scope: 'server', value: 'off' },
        agentSessionId: 'as_mcp_denied',
        agentSetup: createTestAgentSetup({ mcpIds: ['echo'] }),
        backend: { kind: 'openshell' },
        createdAt: '2026-09-03T00:01:00.000Z',
        requestId: 'req_mcp_denied',
        triggerActor: deniedTurn.triggerActor,
        turn: deniedTurn,
        workspaceCwd: '/workspace',
        workspaceMcpServerCatalog: catalog,
        workspaceRoots: [],
      });
      const beforeDeniedDb = openWorkspaceDb(dataRoot, 'ws_demo');
      const beforeDenied = mcpEffectCounts(beforeDeniedDb);
      beforeDeniedDb.sqlite.close();
      const itemsBeforeDenied = store.listAllItems().length;
      const upstreamCallsBeforeDenied = callTool.mock.calls.length;
      await expect(
        echo.callTool({ arguments: { message: 'denied' }, name: 'echo' })
      ).rejects.toMatchObject({ data: { code: 'mcp-denied' } });
      const afterDeniedDb = openWorkspaceDb(dataRoot, 'ws_demo');
      expect(mcpEffectCounts(afterDeniedDb)).toEqual(beforeDenied);
      afterDeniedDb.sqlite.close();
      expect(store.listAllItems()).toHaveLength(itemsBeforeDenied);
      expect(callTool).toHaveBeenCalledTimes(upstreamCallsBeforeDenied);
      expect(reconcileWorkerMcpItems(dataRoot, store)).toBe(0);

      const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
      applyScopedMigrations(workspaceDb);
      try {
        expect(
          workspaceDb.sqlite
            .prepare(
              `SELECT error_code, status FROM capability_calls
               WHERE operation = 'mcp.call_tool'
               ORDER BY rowid`
            )
            .all()
        ).toEqual([
          { error_code: null, status: 'succeeded' },
          { error_code: null, status: 'succeeded' },
          { error_code: 'mcp-tool-not-found', status: 'failed' },
          { error_code: 'mcp-invalid-arguments', status: 'failed' },
          { error_code: 'mcp-timeout', status: 'timed-out' },
          { error_code: 'mcp-call-failed', status: 'unknown' },
          { error_code: 'mcp-result-too-large', status: 'failed' },
          { error_code: 'mcp-call-failed', status: 'failed' },
          { error_code: 'mcp-call-failed', status: 'aborted' },
          { error_code: 'mcp-call-failed', status: 'aborted' },
          { error_code: 'mcp-schema-drift', status: 'failed' },
          { error_code: 'mcp-server-unavailable', status: 'failed' },
          { error_code: 'mcp-server-unavailable', status: 'aborted' },
          { error_code: 'mcp-denied', status: 'denied' },
          { error_code: 'capability_call_recovered_after_restart', status: 'unknown' },
          { error_code: 'usage_record_failed', status: 'failed' },
          { error_code: null, status: 'succeeded' },
        ]);
        expect(
          workspaceDb.sqlite.prepare('SELECT quantity, unit FROM usage_records').all()
        ).toEqual([
          { quantity: 1, unit: 'tool_calls' },
          { quantity: 1, unit: 'tool_calls' },
          { quantity: 1, unit: 'tool_calls' },
          { quantity: 1, unit: 'tool_calls' },
          { quantity: 1, unit: 'tool_calls' },
          { quantity: 1, unit: 'tool_calls' },
          { quantity: 1, unit: 'tool_calls' },
          { quantity: 1, unit: 'tool_calls' },
          { quantity: 1, unit: 'tool_calls' },
        ]);
      } finally {
        workspaceDb.sqlite.close();
      }
      environmentPackage = authorizedEnvironmentPackage;
      const emptyNearLimitTools = [
        { inputSchema: { description: '', type: 'object' as const }, name: 'echo' },
      ];
      const nearLimitTools = [
        {
          inputSchema: {
            description: 'x'.repeat(
              512 * 1024 - Buffer.byteLength(JSON.stringify(emptyNearLimitTools), 'utf8')
            ),
            type: 'object' as const,
          },
          name: 'echo',
        },
      ];
      const nearLimitSchemaDb = openWorkspaceDb(dataRoot, 'ws_demo');
      recordMcpToolSchemaSnapshot({
        environmentPackage,
        schemaSnapshotId: 'mcpschema_near_limit',
        serverId: 'echo',
        source: 'live',
        tools: nearLimitTools,
        workspaceDb: nearLimitSchemaDb,
        workspaceId: 'ws_demo',
      });
      nearLimitSchemaDb.sqlite.close();
      expect(Buffer.byteLength(JSON.stringify(nearLimitTools), 'utf8')).toBe(512 * 1024);
      const nearLimitList = await echo.listTools();
      expect(Buffer.byteLength(JSON.stringify(nearLimitList.tools), 'utf8')).toBe(512 * 1024);
      const nearLimitListDb = openWorkspaceDb(dataRoot, 'ws_demo');
      expect(
        nearLimitListDb.sqlite
          .prepare(
            `SELECT error_code, status
             FROM capability_calls
             WHERE operation = 'mcp.list_tools'
             ORDER BY rowid DESC
             LIMIT 1`
          )
          .get()
      ).toEqual({ error_code: null, status: 'succeeded' });
      nearLimitListDb.sqlite.close();
      expect(Buffer.byteLength(JSON.stringify(nearLimitResult), 'utf8')).toBe(512 * 1024);
      expect(
        Buffer.byteLength(
          JSON.stringify({ id: 'near-limit-id', jsonrpc: '2.0', result: nearLimitResult }),
          'utf8'
        )
      ).toBeGreaterThan(512 * 1024);
      const nearLimitResponse = await rawCall('near-limit-id', 'near-limit');
      expect(nearLimitResponse.status).toBe(200);
      await expect(nearLimitResponse.json()).resolves.toMatchObject({
        id: 'near-limit-id',
        result: nearLimitResult,
      });
      const nearLimitDb = openWorkspaceDb(dataRoot, 'ws_demo');
      expect(
        nearLimitDb.sqlite
          .prepare(
            `SELECT error_code, status
             FROM capability_calls
             WHERE operation = 'mcp.call_tool'
             ORDER BY rowid DESC
             LIMIT 1`
          )
          .get()
      ).toEqual({ error_code: null, status: 'succeeded' });
      nearLimitDb.sqlite.close();
      await workspaceMutationAdmission.close('ws_demo');
      const workspaceRoot = join(dataRoot, 'workspaces', 'ws_demo');
      rmSync(workspaceRoot, { recursive: true });
      const staleRequest = await rawCall('stale-after-delete');
      expect(staleRequest.status).toBe(200);
      await expect(staleRequest.json()).resolves.toMatchObject({
        error: { data: { code: 'mcp-denied' } },
        id: 'stale-after-delete',
      });
      expect(existsSync(workspaceRoot)).toBe(false);
    } finally {
      await Promise.all(clients.map((client) => client.close()));
      coreDb.sqlite.close();
    }
  });

  it('recreates a missing terminal Item without changing its successful call', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-mcp-item-recovery-'));
    const store = createDemoStore({ dataRoot });
    const turn = store.createTurn('ws_demo', 'th_demo', 'Recover the MCP Item', {
      id: 'user_local',
      kind: 'user',
    });
    const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
    applyScopedMigrations(workspaceDb);
    try {
      const environmentPackage = recordTestAgentEnvironmentPackage(workspaceDb, {
        suffix: 'recovery',
        triggerActor: turn.triggerActor,
        workspaceInputIds: [],
      });
      const call = startCapabilityCall({
        agentId: 'agent_codex',
        agentSessionId: environmentPackage.scope.agentSessionId,
        authorityActor: turn.triggerActor,
        callId: 'cap_mcp_recovery',
        capabilityId: 'mcp.call_tool',
        family: 'mcp',
        itemId: 'it_mcp_recovery',
        operation: 'mcp.call_tool',
        packageSnapshotId: environmentPackage.snapshotId,
        providerRef: 'echo',
        redactionClass: 'metadata-only',
        serviceRef: 'mcp-tool:echo',
        threadId: turn.threadId,
        turnId: turn.id,
        workspaceDb,
        workspaceId: turn.workspaceId,
      });
      finishCapabilityCall({ callId: call.id, status: 'succeeded', workspaceDb });
    } finally {
      workspaceDb.sqlite.close();
    }

    verifyAndMigrateExistingScopedDatabases(dataRoot);
    expect(reconcileWorkerMcpItems(dataRoot, store)).toBe(1);
    expect(reconcileWorkerMcpItems(dataRoot, store)).toBe(0);
    expect(store.getTurnById(turn.id).items).toContainEqual(
      expect.objectContaining({
        causationId: 'cap_mcp_recovery',
        id: 'it_mcp_recovery',
        server: 'echo',
        status: 'completed',
        tool: 'echo',
      })
    );
    const recoveredWorkspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
    try {
      expect(
        recoveredWorkspaceDb.sqlite
          .prepare('SELECT status FROM capability_calls WHERE call_id = ?')
          .get('cap_mcp_recovery')
      ).toEqual({ status: 'succeeded' });
    } finally {
      recoveredWorkspaceDb.sqlite.close();
    }
  });

  it.each([
    'raw',
    'bearer',
  ] as const)('injects an HTTP %s Vault grant at the gateway and rejects the next call after revoke', async (presentation) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-mcp-vault-'));
    const upstreamOptions: { credentialListEcho?: string } = {};
    const upstream = await createMcpHttpStub(upstreamOptions);
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
    const turn = store.createTurn('ws_demo', 'th_demo', 'Call HTTP MCP', {
      id: 'user_local',
      kind: 'user',
    });
    const vaultUnlockState = createVaultUnlockState({
      backendKind: 'encrypted-file',
      storeDir: join(dataRoot, 'server', 'vault'),
    });
    vaultUnlockState.unlock({ masterKey: Buffer.alloc(32, 7) });
    const vaultCanary = 'vault-"quoted\\slash';
    vaultUnlockState.backend().store({
      material: vaultCanary,
      metadata: { ownerScope: 'workspace', workspaceId: 'ws_demo' },
      referenceId: 'vault_mcp_http',
    });
    createVaultReference(coreDb, {
      backendKind: 'encrypted-file',
      backendLocator: 'encrypted-file://workspace/vault_mcp_http',
      displayName: 'HTTP MCP token',
      ownerScope: 'workspace',
      referenceId: 'vault_mcp_http',
      secretKind: 'http-bearer',
      workspaceId: 'ws_demo',
    });
    createVaultGrant(coreDb, {
      allowedInjectionPaths: ['gateway-only'],
      grantId: 'grant_mcp_http',
      lifetime: 'agent-session',
      ownerScope: 'workspace',
      targetAgentSessionId: 'as_mcp_vault',
      targetCapabilityId: 'mcp',
      vaultReferenceId: 'vault_mcp_http',
      workspaceId: 'ws_demo',
    });
    const catalog = {
      schemaVersion: 1 as const,
      servers: [
        {
          allowedTools: ['echo'],
          approvalRequiredTools: [],
          credentialBindings: [
            {
              presentation,
              sink: { kind: 'header' as const, name: 'authorization' },
              slot: 'auth',
              vaultGrantId: 'grant_mcp_http',
            },
          ],
          deniedTools: [],
          enabled: true,
          id: 'http-echo',
          pinnedSchemaSnapshotId: null,
          schemaPolicy: 'tracking' as const,
          // This fixture proves Vault admission and secrecy; no assertion needs a timeout.
          timeoutMs: 10_000,
          transport: { endpoint: upstream.url, kind: 'http' as const },
        },
      ],
    };
    let activeCatalog = catalog;
    let environmentPackage = resolveAgentEnvironmentPackage({
      captureCoverage: { scope: 'server', value: 'off' },
      agentSessionId: 'as_mcp_vault',
      agentSetup: createTestAgentSetup({ mcpIds: ['http-echo'] }),
      backend: { kind: 'openshell' },
      createdAt: '2026-09-03T00:00:00.000Z',
      requestId: 'req_mcp_vault',
      triggerActor: turn.triggerActor,
      turn,
      workspaceCwd: '/workspace',
      workspaceMcpServerCatalog: catalog,
      workspaceRoots: [],
    });
    recordMcpWorkerLineage(coreDb, environmentPackage);
    const workerControlGateway = {
      authenticatePackageToken: vi.fn(() => environmentPackage),
    } as unknown as WorkerControlGateway;
    const workerMcpGateway = createDefaultWorkerMcpGateway(coreDb);
    const app = new Hono();
    registerWorkerMcpRoutes({
      app,
      coreDb,
      runtimeConfig: () =>
        createInMemoryRuntimeConfigSnapshot({
          dataRoot,
          agentManifests: [],
          workspaceMcpServerCatalogs: [
            {
              catalog: activeCatalog,
              path: join(dataRoot, 'catalog/catalog.json'),
              workspaceId: 'ws_demo',
            },
          ],
        }),
      store,
      vaultUnlockState,
      workerControlGateway,
      workerMcpGateway,
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    });
    const client = new Client({ name: 'vault-route-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL('http://nanocore.test/api/worker-capabilities/mcp/http-echo'),
      {
        fetch: (request, init) => app.fetch(new Request(request, init)),
        requestInit: { headers: { authorization: 'Bearer capability-token' } },
      }
    );

    try {
      await client.connect(transport);
      const initializationsBeforeCall = upstream.observed.filter((request) =>
        request.endsWith('|initialize')
      ).length;
      const terminationsBeforeCall = upstream.observed.filter((request) =>
        request.endsWith('|DELETE|')
      ).length;
      const result = await client.callTool({ arguments: { message: 'safe' }, name: 'echo' });
      expect(result).toMatchObject({ content: [{ text: 'safe' }] });
      expect(upstream.observed.filter((request) => request.endsWith('|initialize'))).toHaveLength(
        initializationsBeforeCall + 1
      );
      expect(upstream.observed.filter((request) => request.endsWith('|DELETE|'))).toHaveLength(
        terminationsBeforeCall + 1
      );
      expect(
        upstream.observed.some((request) =>
          request.startsWith(`${presentation === 'bearer' ? 'Bearer ' : ''}${vaultCanary}||`)
        )
      ).toBe(true);
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM vault_injection_plans').get()
      ).toEqual({ count: 1 });
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM vault_injection_receipts').get()
      ).toEqual({ count: 1 });
      const workspaceDb = openWorkspaceDb(dataRoot, 'ws_demo');
      applyScopedMigrations(workspaceDb);
      try {
        expect(workspaceDb.sqlite.prepare('SELECT outcome FROM vault_use_records').all()).toEqual([
          { outcome: 'succeeded' },
        ]);
        expect(
          workspaceDb.sqlite.prepare('SELECT category, unit, quantity FROM usage_records').all()
        ).toEqual([{ category: 'tool', quantity: 1, unit: 'tool_calls' }]);
        const exportApp = createApp({
          coreDb,
          dataRoot,
          store,
          turnExecutor: new SimulatedTurnExecutor(),
          workerMcpGateway,
        });
        const exportResponse = await exportApp.request(
          ...operationRequest(
            'workspace.export',
            { workspaceId: 'ws_demo' },
            {
              method: 'POST',
            }
          )
        );
        expect(exportResponse.status).toBe(200);
        const exported = WorkspaceExportResponseSchema.parse(await exportResponse.json());
        const exportRoot = join(
          dataRoot,
          'server',
          'exports',
          'workspaces',
          'ws_demo',
          exported.exportId
        );
        const publicAndDurableValues = [
          environmentPackage,
          result,
          store.listAllItems(),
          store.listThreadTurns('ws_demo', 'th_demo'),
          store.listCommandRequests(),
          readDatabaseRows(coreDb.sqlite),
          readDatabaseRows(workspaceDb.sqlite),
          exported,
        ];
        expect(
          publicAndDurableValues.every((value) => !containsExactString(value, vaultCanary))
        ).toBe(true);
        const encodedCanary = JSON.stringify(vaultCanary).slice(1, -1);
        const publicAndDurableBytes = [
          ...publicAndDurableValues.map((value) => JSON.stringify(value)),
          ...exported.checkedFiles.map((path) => readFileSync(join(exportRoot, path), 'utf8')),
        ];
        expect(
          publicAndDurableBytes.every(
            (bytes) => !bytes.includes(vaultCanary) && !bytes.includes(encodedCanary)
          )
        ).toBe(true);
      } finally {
        workspaceDb.sqlite.close();
      }

      const schemaDb = openWorkspaceDb(dataRoot, 'ws_demo');
      const snapshotCount = schemaDb.sqlite
        .prepare('SELECT COUNT(*) AS count FROM mcp_tool_schema_snapshots')
        .get();
      schemaDb.sqlite.close();
      const receiptsBeforeMetadataLeak = coreDb.sqlite
        .prepare('SELECT COUNT(*) AS count FROM vault_injection_receipts')
        .get() as { count: number };
      upstreamOptions.credentialListEcho = vaultCanary;
      await expect(
        client.callTool({ arguments: { message: 'metadata-leak' }, name: 'echo' })
      ).rejects.toMatchObject({ data: { code: 'mcp-server-unavailable' } });
      delete upstreamOptions.credentialListEcho;
      const rejectedSchemaDb = openWorkspaceDb(dataRoot, 'ws_demo');
      expect(
        rejectedSchemaDb.sqlite
          .prepare('SELECT COUNT(*) AS count FROM mcp_tool_schema_snapshots')
          .get()
      ).toEqual(snapshotCount);
      rejectedSchemaDb.sqlite.close();
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM vault_injection_receipts').get()
      ).toEqual({ count: receiptsBeforeMetadataLeak.count + 1 });

      const toolCallsBeforeReceiptFailure = upstream.observed.filter((request) =>
        request.endsWith('|tools/call')
      ).length;
      coreDb.sqlite.exec(`
        CREATE TRIGGER reject_mcp_receipt
        BEFORE INSERT ON vault_injection_receipts
        BEGIN
          SELECT RAISE(ABORT, 'injected MCP receipt failure');
        END
      `);
      try {
        await expect(
          client.callTool({ arguments: { message: 'receipt-failure' }, name: 'echo' })
        ).rejects.toMatchObject({ data: { code: 'recovery_required' } });
      } finally {
        coreDb.sqlite.exec('DROP TRIGGER IF EXISTS reject_mcp_receipt');
      }
      expect(upstream.observed.filter((request) => request.endsWith('|tools/call'))).toHaveLength(
        toolCallsBeforeReceiptFailure
      );
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM vault_injection_receipts').get()
      ).toEqual({ count: receiptsBeforeMetadataLeak.count + 1 });

      await expect(
        client.callTool({ arguments: { message: 'reestablish' }, name: 'echo' })
      ).resolves.toMatchObject({ content: [{ text: 'reestablish' }] });
      const oldResolved = resolveWorkspaceMcpServer({ catalog, serverId: 'http-echo' });
      expect(
        workerMcpGateway.getServerHealth({ server: oldResolved, workspaceId: 'ws_demo' })
      ).toBe('inactive');

      const toolCallsBeforeMalformedExpiry = upstream.observed.filter((request) =>
        request.endsWith('|tools/call')
      ).length;
      const receiptsBeforeMalformedExpiry = coreDb.sqlite
        .prepare('SELECT COUNT(*) AS count FROM vault_injection_receipts')
        .get();
      const useDb = openWorkspaceDb(dataRoot, 'ws_demo');
      const usesBeforeMalformedExpiry = useDb.sqlite
        .prepare('SELECT COUNT(*) AS count FROM vault_use_records')
        .get();
      useDb.sqlite.close();
      coreDb.sqlite
        .prepare('UPDATE vault_grants SET expires_at = ? WHERE grant_id = ?')
        .run('not-a-date', 'grant_mcp_http');
      const closeFailure = vi
        .spyOn(workerMcpGateway, 'closeServer')
        .mockRejectedValueOnce(new Error('injected credential cleanup failure'));
      await expect(
        client.callTool({ arguments: { message: 'malformed-expiry' }, name: 'echo' })
      ).rejects.toMatchObject({ data: { code: 'recovery_required' } });
      closeFailure.mockRestore();
      expect(upstream.observed.filter((request) => request.endsWith('|tools/call'))).toHaveLength(
        toolCallsBeforeMalformedExpiry
      );
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM vault_injection_receipts').get()
      ).toEqual(receiptsBeforeMalformedExpiry);
      const rejectedUseDb = openWorkspaceDb(dataRoot, 'ws_demo');
      expect(
        rejectedUseDb.sqlite.prepare('SELECT COUNT(*) AS count FROM vault_use_records').get()
      ).toEqual(usesBeforeMalformedExpiry);
      rejectedUseDb.sqlite.close();
      coreDb.sqlite
        .prepare('UPDATE vault_grants SET expires_at = NULL WHERE grant_id = ?')
        .run('grant_mcp_http');

      const toolCallsBeforeRevoke = upstream.observed.filter((request) =>
        request.endsWith('|tools/call')
      ).length;
      revokeVaultGrant(coreDb, { grantId: 'grant_mcp_http' });
      activeCatalog = {
        ...catalog,
        servers: [{ ...catalog.servers[0], timeoutMs: catalog.servers[0]!.timeoutMs + 1 }],
      };
      environmentPackage = resolveAgentEnvironmentPackage({
        captureCoverage: { scope: 'server', value: 'off' },
        agentSessionId: 'as_mcp_vault',
        agentSetup: createTestAgentSetup({ mcpIds: ['http-echo'] }),
        backend: { kind: 'openshell' },
        createdAt: '2026-09-03T00:01:00.000Z',
        requestId: 'req_mcp_vault_reconfigured',
        triggerActor: turn.triggerActor,
        turn,
        workspaceCwd: '/workspace',
        workspaceMcpServerCatalog: activeCatalog,
        workspaceRoots: [],
      });
      await expect(
        client.callTool({ arguments: { message: 'blocked' }, name: 'echo' })
      ).rejects.toMatchObject({ data: { code: 'mcp-denied' } });
      expect(upstream.observed.filter((request) => request.endsWith('|tools/call'))).toHaveLength(
        toolCallsBeforeRevoke
      );
      expect(
        workerMcpGateway.getServerHealth({ server: oldResolved, workspaceId: 'ws_demo' })
      ).toBe('inactive');
    } finally {
      await client.close();
      await workerMcpGateway.close();
      await upstream.close();
      vaultUnlockState.lock();
      coreDb.sqlite.close();
    }
  });
});

/** Reads every durable row in a test database for credential-canary assertions. */
function readDatabaseRows(
  sqlite: ReturnType<typeof openCoreDb>['sqlite']
): Record<string, unknown> {
  const tables = sqlite
    .prepare(
      `SELECT name FROM sqlite_schema
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`
    )
    .all() as Array<{ readonly name: string }>;
  return Object.fromEntries(
    tables.map(({ name }) => [
      name,
      sqlite.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all(),
    ])
  );
}

/** Returns whether an object tree contains an exact string in a key or value. */
function containsExactString(value: unknown, expected: string): boolean {
  if (typeof value === 'string') return value.includes(expected);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, child]) => key.includes(expected) || containsExactString(child, expected)
  );
}

/** Reads the Workspace effect counts that an unauthorized MCP request must not change. */
function mcpEffectCounts(workspaceDb: ReturnType<typeof openWorkspaceDb>) {
  return Object.fromEntries(
    ['audit_events', 'capability_calls', 'permission_decisions', 'usage_records'].map((table) => [
      table,
      workspaceDb.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
    ])
  );
}

/** Returns one valid tool declaration for MCP route fixtures. */
function mcpEchoTool() {
  return {
    inputSchema: {
      additionalProperties: false,
      properties: { message: { type: 'string' } },
      required: ['message'],
      type: 'object',
    },
    name: 'echo',
  };
}

// This fixture supplies confirmed image evidence; the production resolver and subject checks still run.
vi.mock('./runtime/agent-environment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runtime/agent-environment.js')>();
  const { withTestPreparedNativeEnvironment } = await import(
    './test-support/native-environment.js'
  );
  return withTestPreparedNativeEnvironment(actual);
});
