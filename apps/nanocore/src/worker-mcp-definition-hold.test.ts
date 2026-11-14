import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { ListToolsResultSchema } from '@modelcontextprotocol/core';
import { StartTaskModeResponseSchema } from '@openkit/app-api-schemas';
import { UserConfigSchema, type WorkspaceMcpServerCatalog } from '@openkit/config-schema';
import type { ActorRef } from '@openkit/protocol';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultWorkerControlGateway } from './app.js';
import { listWorkspaceCapabilityCalls } from './capability/usage-ledger.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
  loadRuntimeConfig,
} from './config/runtime-config.js';
import { FsStore } from './lib/store.js';
import { ProviderRegistry } from './providers/registry.js';
import {
  listExportableMcpToolSchemaSnapshots,
  readRetainedMcpToolSchemaSnapshot,
} from './runtime/mcp-tool-schema-snapshots.js';
import { createDefaultWorkerMcpGateway } from './runtime/worker-mcp-gateway.js';
import { closeWorkspaceProductReadHandles } from './storage/control-store-product-records.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './storage/control-store-worker-client.js';
import type { CoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createTestAgentSetup, createTestGatewayConfig } from './test-support/agent-environment.js';
import { createAppWithLocalIdentity as createApp } from './test-support/app.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from './test-support/demo-store.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { createMcpHttpStub } from './test-support/mcp-http-stub.js';
import { admitTestNativeEnvironment } from './test-support/native-environment.js';
import { createNativeTaskAdmissionFixture } from './test-support/native-task-admission.js';
import { operationRequest } from './test-support/operation-request.js';
import { closeTestCoreDb, createTestCoreDb, createTestWorkspaceDb } from './test-support/store.js';
import { registerWorkerMcpRoutes } from './worker-mcp-routes.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

type Tools = Awaited<ReturnType<Client['listTools']>>['tools'];

const originalTool: Tools[number] = {
  name: 'echo',
  description: 'Return a public fixture message.',
  inputSchema: {
    type: 'object',
    properties: { message: { type: 'string' } },
    required: ['message'],
    additionalProperties: false,
  },
};
const siblingTool: Tools[number] = {
  name: 'stable',
  description: 'An unchanged public fixture operation.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

const changes = [
  { field: 'name', tool: { ...originalTool, name: 'echo-changed' } },
  {
    field: 'top-level description',
    tool: { ...originalTool, description: 'Return a changed public fixture message.' },
  },
  {
    field: 'inputSchema',
    tool: {
      ...originalTool,
      inputSchema: {
        type: 'object',
        properties: { count: { type: 'integer' } },
        required: ['count'],
        additionalProperties: false,
      },
    },
  },
] satisfies Array<{ field: string; tool: Tools[number] }>;

afterEach(() => vi.restoreAllMocks());

describe('MCP changed-definition exposure through real Core and native capture', () => {
  it.each(changes)(
    'holds changed $field across next-Turn discovery, a bound read and native reopen',
    async ({ field, tool: changedTool }) => {
      const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-mcp-definition-hold-'));
      const upstream = await createMcpHttpStub();
      const coreDb = createTestCoreDb(dataRoot);
      applyMigrations(coreDb);
      const actor: ActorRef = { kind: 'user', id: ensureLocalUser(coreDb) };
      const store = await createDemoStore({ dataRoot, knowledge: [] });
      const workspaceId = DEMO_WORKSPACE_ID;
      const threadId = DEMO_THREAD_ID;
      recordWorkspaceOwnerMembership({ coreDb, ownerUserId: actor.id, workspaceId });
      const catalog: WorkspaceMcpServerCatalog = {
        schemaVersion: 1,
        servers: [
          {
            id: 'echo',
            enabled: true,
            // Both names are selected before the change: a name allowlist is not the hold.
            allowedTools: ['echo', 'echo-changed', 'stable'],
            credentialBindings: [],
            pinnedSchemaSnapshotId: null,
            schemaPolicy: 'tracking',
            timeoutMs: 2_000,
            transport: { kind: 'http', endpoint: upstream.url },
          },
        ],
      };
      const setup = createTestAgentSetup({
        mcpIds: ['echo'],
        requiredCapabilities: ['trusted-worker-inference-relay'],
      });
      const snapshot = createInMemoryRuntimeConfigSnapshot({
        dataRoot,
        gatewayConfig: createTestGatewayConfig(),
        userConfigs: [
          {
            userId: actor.id,
            path: join(dataRoot, 'users', actor.id, 'config', 'user.jsonc'),
            config: UserConfigSchema.parse({
              schemaVersion: 1,
              knowledgeMaintenance: { enabled: false, reviewRequiredPageIds: [] },
            }),
          },
        ],
        providerRegistry: new ProviderRegistry([
          {
            id: 'agent-openrouter',
            displayName: 'Uncalled local fixture route',
            kind: 'local',
            models: ['openai/gpt-5.2'],
          },
        ]),
        workspaceConfigs: loadRuntimeConfig(dataRoot).workspaceConfigs,
        agentManifests: [setup.manifest],
        workspaceMcpServerCatalogs: [
          { catalog, path: join(dataRoot, 'catalog.json'), workspaceId },
        ],
      });
      // This existing peer models unrelated image/placement/Harness effects, not their reality.
      // Core Session, attempts, route tokens, native MCP commands and authorization remain real.
      const native = await createNativeTaskAdmissionFixture(coreDb, store, {
        readRuntimeConfig: () => snapshot,
      });
      // Existing metadata-only image fixture; this is not image publication or execution evidence.
      admitTestNativeEnvironment(coreDb, setup.manifest);
      const gateway = createDefaultWorkerMcpGateway(coreDb);
      const taskApp = createApp({
        coreDb,
        store,
        fileAdmission: native.fileAdmission,
        turnExecutor: native.executor,
        workerLifecycleRuntime: native.runtime,
        workerControlGateway: native.workerControlGateway,
        workerMcpGateway: gateway,
        runtimeConfigManager: createRuntimeConfigManager({
          dataRoot: null,
          initialSnapshot: snapshot,
        }),
      });
      let suppliedTools: Tools = structuredClone([originalTool, siblingTool]);
      const observed: Tools[] = [];
      // Only the upstream SDK list effect is replaced; Core's SDK server/handler is not.
      const sdkList = vi.spyOn(Client.prototype, 'listTools').mockImplementation(async () => {
        observed.push(structuredClone(suppliedTools));
        return { tools: structuredClone(suppliedTools) };
      });
      const nativeCommands = vi.spyOn(getControlStoreWorkerClient(), 'workspaceCapability');
      let first: ReturnType<typeof native.executionFor> | undefined;
      let second: ReturnType<typeof native.executionFor> | undefined;
      let reopenedCore: CoreDb | undefined;
      let reopenedGateway: ReturnType<typeof createDefaultWorkerMcpGateway> | undefined;
      try {
        const startA = await taskApp.request(
          ...operationRequest(
            'task.start',
            { workspaceId, threadId },
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                input: 'Discover selected fixture tools.',
                requestId: randomUUID(),
              }),
            }
          )
        );
        expect(startA.status, 'The actual initial task must be admitted.').toBe(202);
        const turnA = StartTaskModeResponseSchema.parse(await startA.json()).turn;
        first = native.executionFor(turnA.id);
        await first.launched.promise;
        await native.waitForStartup(turnA.id);
        const tokenA = native.executor.capabilityToken;
        expect(
          native.workerControlGateway.authenticatePackageToken(`Bearer ${tokenA}`, {
            tokenFamily: 'capability',
          }).scope
        ).toMatchObject({ workspaceId, threadId, turnId: turnA.id });
        const listA = await taskApp.request('/api/worker-capabilities/mcp/echo', {
          method: 'POST',
          headers: {
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${tokenA}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        });
        expect(listA.status).toBe(200);
        const initial = ListToolsResultSchema.parse((await listA.json()).result);
        expect(initial.tools).toHaveLength(2);
        expect(initial.tools).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: originalTool.name,
              inputSchema: originalTool.inputSchema,
            }),
            expect.objectContaining({
              name: siblingTool.name,
              inputSchema: siblingTool.inputSchema,
            }),
          ])
        );
        expect(observed).toEqual([[originalTool, siblingTool]]);
        const beforeDb = createTestWorkspaceDb(dataRoot, workspaceId);
        let initialSnapshotId: string;
        try {
          const capture = listWorkspaceCapabilityCalls(beforeDb, workspaceId).find(
            (call) => call.turnId === turnA.id && call.operation === 'mcp.list-tools'
          );
          expect(capture).toMatchObject({
            status: 'succeeded',
            schemaSnapshotId: expect.any(String),
          });
          if (!capture?.schemaSnapshotId)
            throw new Error('Initial live capture lacks its native reference.');
          initialSnapshotId = capture.schemaSnapshotId;
          expect(
            readRetainedMcpToolSchemaSnapshot({
              workspaceDb: beforeDb,
              workspaceId,
              catalogEntryId: 'echo',
              schemaSnapshotId: initialSnapshotId,
            })?.tools
          ).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                name: originalTool.name,
                inputSchema: originalTool.inputSchema,
              }),
            ])
          );
        } finally {
          closeTestCoreDb(beforeDb);
        }
        first.completion.resolve();
        await first.execution;
        expect(store.getTurnById(turnA.id).status).toBe('completed');

        suppliedTools = structuredClone([changedTool, siblingTool]);
        const startB = await taskApp.request(
          ...operationRequest(
            'task.start',
            { workspaceId, threadId },
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                input: 'Discover the selected tools again.',
                requestId: randomUUID(),
              }),
            }
          )
        );
        expect(startB.status, 'B must run under real next-Turn admission.').toBe(202);
        const turnB = StartTaskModeResponseSchema.parse(await startB.json()).turn;
        expect(turnB.id).not.toBe(turnA.id);
        second = native.executionFor(turnB.id);
        await second.launched.promise;
        await native.waitForStartup(turnB.id);
        const tokenB = native.executor.capabilityToken;
        const packageB = native.workerControlGateway.authenticatePackageToken(`Bearer ${tokenB}`, {
          tokenFamily: 'capability',
        });
        expect(packageB.scope).toMatchObject({ workspaceId, threadId, turnId: turnB.id });
        expect(store.getAgentSession(packageB.scope.agentSessionId)?.id).toBe(
          packageB.scope.agentSessionId
        );
        const listB = await taskApp.request('/api/worker-capabilities/mcp/echo', {
          method: 'POST',
          headers: {
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${tokenB}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
        });
        expect(listB.status).toBe(200);
        const changed = ListToolsResultSchema.parse((await listB.json()).result);
        expect(observed).toEqual([
          [originalTool, siblingTool],
          [changedTool, siblingTool],
        ]);
        expect(sdkList).toHaveBeenCalledTimes(2);
        const captureIndex = nativeCommands.mock.calls.findIndex(
          ([, command]) =>
            command.kind === 'mcp-schema' && command.environmentPackage.scope.turnId === turnB.id
        );
        expect(
          captureIndex,
          'B must reach the actual native mcp-schema command, not a serving map.'
        ).toBeGreaterThanOrEqual(0);
        await expect(nativeCommands.mock.results[captureIndex]?.value).resolves.toMatchObject({
          liveSnapshotId: expect.any(String),
        });
        const boundB = await taskApp.request('/api/worker-capabilities/mcp/echo', {
          method: 'POST',
          headers: {
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${tokenB}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
        });
        expect(boundB.status).toBe(200);
        const bound = ListToolsResultSchema.parse((await boundB.json()).result);
        expect(sdkList).toHaveBeenCalledTimes(2);
        const capturedDb = createTestWorkspaceDb(dataRoot, workspaceId);
        let changedSnapshotId: string;
        try {
          const capture = listWorkspaceCapabilityCalls(capturedDb, workspaceId).find(
            (call) => call.turnId === turnB.id && call.operation === 'mcp.list-tools'
          );
          expect(capture).toMatchObject({
            status: 'succeeded',
            schemaSnapshotId: expect.any(String),
          });
          if (!capture?.schemaSnapshotId)
            throw new Error('Changed live capture lacks its native reference.');
          changedSnapshotId = capture.schemaSnapshotId;
        } finally {
          closeTestCoreDb(capturedDb);
        }
        nativeCommands.mockRestore();
        await gateway.close();
        closeWorkspaceProductReadHandles(dataRoot);
        await shutdownControlStoreWorkerClient();
        // Reopen the native writer/readers and rebuild both Gateways; do not register a new token.
        // The outside runtime peer remains separate and is not claimed to have restarted.
        reopenedCore = createTestCoreDb(dataRoot);
        const reopenedStore = new FsStore({ dataRoot });
        const restoredControl = createDefaultWorkerControlGateway(reopenedCore);
        reopenedGateway = createDefaultWorkerMcpGateway(reopenedCore);
        expect(
          restoredControl.authenticatePackageToken(`Bearer ${tokenB}`, {
            tokenFamily: 'capability',
          }).scope
        ).toMatchObject({ workspaceId, threadId, turnId: turnB.id });
        const reopenedApp = new Hono();
        registerWorkerMcpRoutes({
          app: reopenedApp,
          coreDb: reopenedCore,
          store: reopenedStore,
          workerControlGateway: restoredControl,
          workerMcpGateway: reopenedGateway,
          runtimeConfig: () => snapshot,
          workspaceMutationAdmission: new WorkspaceMutationAdmission(),
        });
        const listAfterReopen = await reopenedApp.request('/api/worker-capabilities/mcp/echo', {
          method: 'POST',
          headers: {
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${tokenB}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }),
        });
        expect(listAfterReopen.status).toBe(200);
        const reopened = ListToolsResultSchema.parse((await listAfterReopen.json()).result);
        expect(sdkList).toHaveBeenCalledTimes(2);
        const retainedDb = createTestWorkspaceDb(dataRoot, workspaceId);
        try {
          const retained = readRetainedMcpToolSchemaSnapshot({
            workspaceDb: retainedDb,
            workspaceId,
            catalogEntryId: 'echo',
            schemaSnapshotId: changedSnapshotId,
          });
          expect(retained?.tools).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                name: changedTool.name,
                inputSchema: changedTool.inputSchema,
              }),
            ])
          );
          // The first deciding check is actual exposure, after real ACK and native reopen.
          for (const { boundary, result } of [
            { boundary: 'native reopen', result: reopened },
            { boundary: 'new Turn', result: changed },
            { boundary: 'Turn-bound cache', result: bound },
          ]) {
            for (const name of new Set([originalTool.name, changedTool.name])) {
              expect
                .soft(
                  result.tools.map((definition) => definition.name),
                  `Core exposed the ${field}-changed Tool through ${boundary} without exact administrator approval.`
                )
                .not.toContain(name);
            }
          }
          // Later retained meaning must include the top-level description and new identity too.
          expect(retained?.tools).toEqual(
            expect.arrayContaining([expect.objectContaining(changedTool)])
          );
          expect(changedSnapshotId).not.toBe(initialSnapshotId);
          const snapshots = listExportableMcpToolSchemaSnapshots(retainedDb, workspaceId);
          const initialRetained = snapshots.find(
            (row) => row.schemaSnapshotId === initialSnapshotId
          );
          const changedRetained = snapshots.find(
            (row) => row.schemaSnapshotId === changedSnapshotId
          );
          expect(initialRetained).toBeDefined();
          expect(changedRetained).toBeDefined();
          expect(changedRetained?.contentDigest).not.toBe(initialRetained?.contentDigest);
        } finally {
          closeTestCoreDb(retainedDb);
        }
      } finally {
        second?.completion.resolve();
        first?.completion.resolve();
        await second?.execution.catch(() => undefined);
        await first?.execution.catch(() => undefined);
        await native.restore();
        await reopenedGateway?.close();
        await gateway.close();
        await shutdownControlStoreWorkerClient();
        closeWorkspaceProductReadHandles(dataRoot);
        if (reopenedCore) closeTestCoreDb(reopenedCore);
        closeTestCoreDb(coreDb);
        rmSync(dataRoot, { recursive: true, force: true });
        await upstream.close();
      }
    },
    60_000
  );
});
