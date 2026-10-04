import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LightAppSchemaInput } from '@openkit/app-api-schemas';
import { type KernelOperationId, operationToolName } from '@openkit/app-api-schemas';
import { ApiErrorSchema } from '@openkit/protocol';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createCoreClient } from '../../../packages/core-client/src/index.js';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from './auth/access-token-store.js';
import type { Actor } from './auth/identity.js';
import { ensureLocalUser } from './auth/identity.js';
import type { AuthVariables } from './auth/middleware.js';
import { createInMemoryRuntimeConfigSnapshot } from './config/runtime-config.js';
import * as commands from './generative-kernel/commands.js';
import { createLightApp, listRecords, updateRecord } from './generative-kernel/commands.js';
import { KernelCommandError } from './generative-kernel/errors.js';
import * as invocation from './operation-composition.js';
import { createOperationInvocation } from './operation-composition.js';
import { registerOperationJsonRoutes } from './operation-json-routes.js';
import {
  dispatchOpenkitGenerativeTool,
  OPENKIT_GENERATIVE_TOOL_OPERATIONS,
} from './runtime/openkit-generative-mcp.js';
import type { WorkerControlGateway } from './runtime/worker-control-gateway.js';
import { createDefaultWorkerMcpGateway } from './runtime/worker-mcp-gateway.js';
import {
  createSchedulerAdmissionEntry,
  createSchedulerPlacementPlan,
  createSchedulerSessionLease,
} from './scheduler-records.js';
import { openExistingAppDb } from './storage/app-db.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createTestAgentSetup } from './test-support/agent-environment.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { resolveAgentEnvironmentPackage } from './test-support/prepared-agent-environment.js';
import { registerWorkerMcpRoutes } from './worker-mcp-routes.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

describe('shared family contract', () => {
  it.each([
    'success',
    'typed refusal',
  ] as const)('marks a JSON operation %s response as not cacheable', async (outcome) => {
    const f = await operationFixture();
    try {
      const response = await f.app.request('/api/app/operations/workspace.read', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(outcome === 'success' ? { workspaceId: 'ws_demo' } : {}),
      });
      expect(response.status).toBe(outcome === 'success' ? 200 : 400);
      expect(await response.json()).toMatchObject(
        outcome === 'success' ? { id: 'ws_demo' } : { code: 'invalid_request' }
      );
      expect(response.headers.get('cache-control')).toBe('no-store');
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('keeps overlapping dynamic success statuses local to each request', async () => {
    const f = await operationFixture();
    const turn = f.store.createTurn('ws_demo', 'th_demo', 'Dynamic response', f.command.actor);
    const body = {
      outcome: 'answered',
      explanation: 'Done.',
      turn,
      item: f.store.createItem({
        id: 'it_dynamic',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        turnId: turn.id,
        type: 'assistant-message',
        status: 'completed',
        text: 'Done.',
        createdAt: turn.startedAt!,
        completedAt: turn.startedAt!,
      }),
      handoff: null,
      originatingWorkspaceId: 'ws_demo',
      originatingThreadId: 'th_demo',
      receivingWorkspaceId: 'ws_demo',
      receivingThreadId: 'th_demo',
      targetRef: 'internal-role:assistant',
      logicalModelId: null,
    };
    let releaseFirst!: () => void;
    let enteredFirst!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const app = new Hono<{ Variables: AuthVariables }>();
    app.use('*', async (c, next) => {
      c.set('actor', { kind: 'local', userId: 'user_local' });
      await next();
    });
    registerOperationJsonRoutes({
      app,
      requestStore: () => f.store,
      coreDb: f.coreDb,
      store: f.store,
      inflightCommands: new WeakMap(),
      workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      conversationService: {
        submit: async (_store, input) => {
          if (input.input === 'first') {
            enteredFirst();
            await gate;
            return { body, status: 200 };
          }
          return { body, status: 202 };
        },
      } as unknown as NonNullable<
        invocation.OperationInvocationDependencies['conversationService']
      >,
    });
    const call = (input: string) =>
      app.request('/api/app/operations/conversation.submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-openkit-request-id': randomUUID() },
        body: JSON.stringify({
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          targetRef: 'internal-role:assistant',
          input,
        }),
      });
    try {
      const first = call('first');
      await entered;
      const second = await call('second');
      releaseFirst();
      expect(second.status).toBe(202);
      expect((await first).status).toBe(200);
    } finally {
      releaseFirst();
      f.coreDb.sqlite.close();
    }
  });
  it.each([
    'handler',
    'resolver',
  ] as const)('lets an unclassified %s failure reach the HTTP error boundary', async (subject) => {
    const f = await operationFixture();
    const sentinel = new Error(`private-${subject}-sentinel`);
    const observed = vi.fn();
    f.app.onError((error, c) => {
      observed(error);
      return c.text('Internal Server Error', 500);
    });
    const turn = f.store.createTurn('ws_demo', 'th_demo', 'Resolver subject', f.command.actor);
    const failure =
      subject === 'handler'
        ? vi.spyOn(f.store, 'getWorkspaceResources').mockImplementation(() => {
            throw sentinel;
          })
        : vi.spyOn(f.store, 'getTurnLineage').mockImplementation(() => {
            throw sentinel;
          });
    try {
      const response = await f.app.request(
        `/api/app/operations/${subject === 'handler' ? 'workspace.resources' : 'turn.read'}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            subject === 'handler'
              ? { workspaceId: 'ws_demo' }
              : { workspaceId: 'ws_demo', threadId: 'th_demo', turnId: turn.id }
          ),
        }
      );
      expect(failure).toHaveBeenCalledOnce();
      expect(observed).toHaveBeenCalledWith(sentinel);
      expect(response.status).toBe(500);
      expect(await response.text()).toBe('Internal Server Error');
      expect(response.headers.get('cache-control')).toBe('no-store');
    } finally {
      failure.mockRestore();
      f.coreDb.sqlite.close();
    }
  });

  it('preserves literal safe Kernel failure fields through HTTP, remote MCP and supplied worker MCP', async () => {
    const f = await operationFixture();
    const error = new KernelCommandError('limit_exceeded', 'Record limit exceeded.', {
      limit: 'records',
      maximum: 2,
      path: '/data',
    });
    Object.defineProperty(error, 'cause', {
      value: new Error('private-secret-sentinel', { cause: new Error('nested-private-secret') }),
    });
    const failure = vi.spyOn(commands, 'createRecord').mockRejectedValue(error);
    try {
      const { projections } = await operationProjections(f);
      const input = {
        workspaceId: 'ws_demo',
        appId: f.appRecord.appId,
        collection: 'entries',
        schemaRevision: 1,
        data: { note: 'safe' },
        requestId: randomUUID(),
      };
      for (const name of ['http', 'worker']) {
        await expect(projections[name]!('kernel.records.create', input)).rejects.toEqual({
          ...(name === 'http' ? { protocolVersion: '0.5.0' } : {}),
          code: 'limit_exceeded',
          message: 'Record limit exceeded.',
          details: { limit: 'records', maximum: 2 },
          ...(name === 'worker' ? { status: 400 } : {}),
          path: ['/data'],
        });
      }
      const httpFailure = await f.app.request('/api/app/operations/kernel.records.create', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-openkit-request-id': input.requestId },
        body: JSON.stringify(input),
      });
      expect(httpFailure.status).toBe(400);
      expect(await httpFailure.json()).toEqual({
        protocolVersion: '0.5.0',
        code: 'limit_exceeded',
        message: 'Record limit exceeded.',
        details: { limit: 'records', maximum: 2 },
        path: ['/data'],
      });
      const token = createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: 'user_local',
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      const remote = await f.app.request('/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token.secret}`,
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'call', arguments: { operation: 'kernel.records.create', input } },
        }),
      });
      const envelope = (await remote.json()) as {
        result: { isError: boolean; content: { text: string }[] };
      };
      expect(envelope.result.isError).toBe(true);
      expect(JSON.parse(envelope.result.content[0]!.text)).toEqual({
        code: 'limit_exceeded',
        message: 'Record limit exceeded.',
        status: 400,
        details: { limit: 'records', maximum: 2 },
        path: ['/data'],
      });
      expect(JSON.stringify(envelope)).not.toContain('private-secret');
      expect(JSON.stringify(envelope)).not.toContain('stack');
      expect(
        listRecords(f.command.dataRoot, 'ws_demo', f.appRecord.appId, 'entries', {
          schemaRevision: 1,
        }).totalItems
      ).toBe(0);
    } finally {
      failure.mockRestore();
      f.coreDb.sqlite.close();
    }
  });

  it('redacts invalid submitted input at the native parse boundary', async () => {
    const f = await operationFixture();
    try {
      const response = await f.app.request('/api/app/operations/kernel.records.create', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-openkit-request-id': randomUUID() },
        body: JSON.stringify({
          workspaceId: 'ws_demo',
          appId: 'private-secret-sentinel',
          collection: 'entries',
          schemaRevision: 1,
          data: {},
        }),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toEqual({
        protocolVersion: '0.5.0',
        code: 'invalid_request',
        message: 'Invalid operation input.',
        details: { fields: ['appId'] },
      });
      expect(JSON.stringify(body)).not.toContain('private-secret-sentinel');
    } finally {
      f.coreDb.sqlite.close();
    }
  });
});

/** Isolated domain authority shared by every projection in this invariant. */
async function operationFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-operation-slice-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
  const command = {
    store,
    dataRoot,
    workspaceId: 'ws_demo',
    actor: { kind: 'user' as const, id: 'user_local' },
    requestId: randomUUID(),
    inflightCommands: new WeakMap(),
  };
  const schema: LightAppSchemaInput = {
    format: 'openkit.light-app',
    schemaVersion: 1,
    title: 'Operation slice',
    purpose: 'Invariant',
    collections: [
      {
        name: 'entries',
        type: 'base',
        description: 'Entries',
        indexes: [],
        fields: [{ name: 'note', type: 'text', required: true, description: 'Note' }],
      },
    ],
  };
  const appRecord = await createLightApp(command, schema);
  const app = createApp({ coreDb, dataRoot, store });
  return { app, coreDb, store, command, appRecord, schema };
}

/** Reuses the real projection assembly over one isolated Kernel authority and exact Worker admission. */
async function operationProjections(f: Awaited<ReturnType<typeof operationFixture>>) {
  const cliModule = new URL('../../../skills/openkit-operations.mjs', import.meta.url).href;
  const { operationCatalog } = await import(cliModule);
  const client = createCoreClient({
    baseUrl: 'http://nanocore.test',
    fetch: (input, init) => f.app.fetch(new Request(input, init)),
  });
  const turn = f.store.createTurn('ws_demo', 'th_demo', 'Operation invariant', f.command.actor);
  f.store.createAgentSession({
    id: 'as_operation',
    agentId: 'agent_codex_host',
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    status: 'busy',
    message: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  f.store.updateTurn(turn.id, { agentSessionId: 'as_operation' });
  const environmentPackage = resolveAgentEnvironmentPackage({
    captureCoverage: { scope: 'server', value: 'off' },
    agentSessionId: 'as_operation',
    agentSetup: createTestAgentSetup(),
    backend: { kind: 'openshell' },
    createdAt: new Date().toISOString(),
    requestId: 'operation-package',
    triggerActor: turn.triggerActor,
    turn,
    workspaceCwd: '/workspace',
    workspaceRoots: [],
  });
  const workerAuthority = createOpenKitAccessTokenRecord(f.coreDb, {
    ownerUserId: 'user_local',
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  createSchedulerAdmissionEntry(f.coreDb, {
    queueEntryId: 'queue_operation',
    requestId: 'request_operation',
    triggerActor: turn.triggerActor,
    serverAdminTokenId: workerAuthority.record.tokenId,
    workspaceId: turn.workspaceId,
    threadId: turn.threadId,
    turnId: turn.id,
    turnInput: 'Operation invariant',
    requestedAgentId: environmentPackage.agent.agentId,
    priorityClass: 'interactive',
    requiredPoolConstraints: [],
  });
  createSchedulerPlacementPlan(f.coreDb, {
    planId: 'plan_operation',
    queueEntryId: 'queue_operation',
    selectedPoolId: 'pool_test',
    selectedTargetId: 'target_test',
    plannedLeaseDurationMs: 900_000,
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 30_000,
    expectedControlMode: 'poll',
    expectedDataPlaneMode: 'openshell-files',
    degradedOptionalFeatures: [],
    policyDecisionIds: [],
    schedulerEpoch: 1,
  });
  createSchedulerSessionLease(f.coreDb, {
    leaseId: 'lease_operation',
    planId: 'plan_operation',
    agentSessionId: 'as_operation',
    packageSnapshotId: environmentPackage.snapshotId,
    expiresAt: '2099-01-01T00:00:00.000Z',
    heartbeatDeadline: '2099-01-01T00:00:00.000Z',
    startupDeadline: '2099-01-01T00:00:00.000Z',
    sandboxTokenBindingRef: 'binding_operation',
  });
  const mcp = new Hono();
  registerWorkerMcpRoutes({
    app: mcp,
    coreDb: f.coreDb,
    store: f.store,
    workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    runtimeConfig: () =>
      createInMemoryRuntimeConfigSnapshot({
        dataRoot: f.command.dataRoot,
        agentManifests: [],
        workspaceMcpServerCatalogs: [],
      }),
    workerMcpGateway: createDefaultWorkerMcpGateway(f.coreDb),
    workerControlGateway: {
      authenticatePackageToken: () => environmentPackage,
    } as unknown as WorkerControlGateway,
  });
  const projections: Record<
    string,
    (id: KernelOperationId, args: Record<string, unknown>) => Promise<unknown>
  > = {
    http: async (id, args) => {
      const { requestId, ...body } = args;
      const response = await f.app.request(`/api/app/operations/${id}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(requestId ? { 'x-openkit-request-id': String(requestId) } : {}),
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw ApiErrorSchema.parse(await response.json());
      expect(response.status).toBe(200);
      return response.json();
    },
    client: (id, args) => client.operations[id](args as never),
    worker: async (id, args) => {
      const { requestId, workspaceId: _workspaceId, ...modelInput } = args;
      const response = await mcp.request('/api/worker-capabilities/mcp/openkit-generative', {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer private-test-capability',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: requestId ?? randomUUID(),
          method: 'tools/call',
          params: { name: operationToolName(id), arguments: modelInput },
        }),
      });
      expect(response.status).toBe(200);
      const envelope = (await response.json()) as {
        result?: { structuredContent: unknown };
        error?: { message: string; data?: { code: string } };
      };
      if (envelope.error) throw { ...envelope.error.data, message: envelope.error.message };
      return envelope.result!.structuredContent;
    },
    cli: async (id, args) => {
      const operation = operationCatalog.find((entry: { id: string }) => entry.id === id);
      expect(operation, 'CLI must derive canonical ids from the definition').toBeDefined();
      return operation.handler({ client }, operation.inputSchema.parse(args));
    },
  };
  return { projections, mcp, workerAuthorityTokenId: workerAuthority.record.tokenId };
}

describe('operation projection cutover', () => {
  it('refuses a one-time-secret result before native dispatch even if a built-in Worker mapping accidentally supplies it', async () => {
    const f = await operationFixture();
    const db = openWorkspaceDb(f.command.dataRoot, 'ws_demo');
    const selected = OPENKIT_GENERATIVE_TOOL_OPERATIONS as unknown as Record<string, string>;
    try {
      const before = f.coreDb.sqlite
        .prepare('SELECT * FROM openkit_access_tokens ORDER BY token_id')
        .all();
      for (const id of ['token.create', 'token.rotate', 'bootstrap.consume']) {
        const name = operationToolName(id);
        expect(selected[name]).toBeUndefined();
        selected[name] = id;
        try {
          await expect(
            dispatchOpenkitGenerativeTool(
              {
                coreDb: f.coreDb,
                store: f.store,
                dataRoot: f.command.dataRoot,
                workspaceDb: db,
                workspaceId: 'ws_demo',
                actor: f.command.actor,
                inflightCommands: new WeakMap(),
                packageSnapshotId: 'package_fixture',
                workspaceMutationAdmission: new WorkspaceMutationAdmission(),
                scope: {
                  workspaceId: 'ws_demo',
                  threadId: 'th_demo',
                  turnId: 'turn_fixture',
                  agentSessionId: 'as_fixture',
                },
              },
              name,
              {}
            )
          ).rejects.toMatchObject({ code: 'mcp_result_unavailable', status: 400 });
          expect(
            f.coreDb.sqlite.prepare('SELECT * FROM openkit_access_tokens ORDER BY token_id').all()
          ).toEqual(before);
        } finally {
          delete selected[name];
        }
      }
    } finally {
      db.sqlite.close();
      f.coreDb.sqlite.close();
    }
  });

  it('omits and refuses all one-time-secret operations through the selected built-in Worker MCP path without token writes', async () => {
    const f = await operationFixture();
    try {
      const { mcp } = await operationProjections(f);
      const rows = () =>
        f.coreDb.sqlite.prepare('SELECT * FROM openkit_access_tokens ORDER BY token_id').all();
      const before = rows();
      const request = async (method: string, params: Record<string, unknown>) => {
        const response = await mcp.request('/api/worker-capabilities/mcp/openkit-generative', {
          method: 'POST',
          headers: {
            accept: 'application/json, text/event-stream',
            authorization: 'Bearer private-test-capability',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
        });
        expect(response.status).toBe(200);
        return response.json();
      };
      const listed = await request('tools/list', {});
      for (const id of ['token.create', 'token.rotate', 'bootstrap.consume']) {
        const name = operationToolName(id);
        expect(listed.result.tools).not.toContainEqual(expect.objectContaining({ name }));
        const result = await request('tools/call', { name, arguments: {} });
        expect(result.error).toBeDefined();
        expect(JSON.stringify(result)).not.toMatch(/okt_|token_hash/);
        expect(rows()).toEqual(before);
      }
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('preserves one result and stored-record invariant over every projection and initiating projection', async () => {
    const f = await operationFixture();
    const createInvocation = vi.spyOn(invocation, 'createOperationInvocation');
    try {
      const { projections, mcp } = await operationProjections(f);
      const selector = { workspaceId: 'ws_demo', appId: f.appRecord.appId };
      const mutations: unknown[] = [];
      for (const initiating of Object.keys(projections)) {
        const input = {
          ...selector,
          collection: 'entries',
          requestId: randomUUID(),
          schemaRevision: 1,
          data: { note: initiating },
        };
        const expected = await projections[initiating]!('kernel.records.create', input);
        for (const project of Object.values(projections)) {
          const before = createInvocation.mock.calls.length;
          expect(await project('kernel.apps.get', selector)).toEqual(f.appRecord);
          expect(await project('kernel.records.create', input)).toEqual(expected);
          expect(createInvocation.mock.calls.length).toBeGreaterThan(before);
        }
        mutations.push(expected);
        expect(
          listRecords(f.command.dataRoot, 'ws_demo', selector.appId, 'entries', {
            schemaRevision: 1,
          }).items
        ).toEqual(expect.arrayContaining(mutations));
        const db = openExistingAppDb(f.command.dataRoot, 'ws_demo', selector.appId);
        try {
          const audits = db.sqlite
            .prepare("SELECT actor_json FROM audit_events WHERE action = 'kernel.records.create'")
            .all() as { actor_json: string }[];
          expect(audits).toHaveLength(mutations.length);
          expect(audits.every((row) => row.actor_json === JSON.stringify(f.command.actor))).toBe(
            true
          );
        } finally {
          db.sqlite.close();
        }
      }
      expect(
        listRecords(f.command.dataRoot, 'ws_demo', selector.appId, 'entries', { schemaRevision: 1 })
          .totalItems
      ).toBe(Object.keys(projections).length);
      const wrongBoundInput = await mcp.request('/api/worker-capabilities/mcp/openkit-generative', {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          authorization: 'Bearer private-test-capability',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: randomUUID(),
          method: 'tools/call',
          params: {
            name: operationToolName('kernel.records.create'),
            arguments: {
              ...selector,
              workspaceId: 'ws_other',
              collection: 'entries',
              schemaRevision: 1,
              data: { note: 'denied' },
            },
          },
        }),
      });
      expect(await wrongBoundInput.json()).toMatchObject({
        error: { data: { code: 'bound_input_conflict' } },
      });
      expect(
        listRecords(f.command.dataRoot, 'ws_demo', selector.appId, 'entries', { schemaRevision: 1 })
          .totalItems
      ).toBe(Object.keys(projections).length);
    } finally {
      createInvocation.mockRestore();
      f.coreDb.sqlite.close();
    }
  });

  it('detects invalid output without undoing an owner-committed mutation', async () => {
    const f = await operationFixture();
    const createRecord = commands.createRecord;
    const corruptedOutput = vi
      .spyOn(commands, 'createRecord')
      .mockImplementation(async (...args) => {
        const result = await createRecord(...args);
        return { ...result, revision: -1 };
      });
    try {
      const owners = {
        ...f.command,
        coreDb: f.coreDb,
        workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      };
      const invoke = createOperationInvocation(owners);
      await expect(
        invoke(
          'kernel.records.create',
          {
            workspaceId: 'ws_demo',
            appId: f.appRecord.appId,
            collection: 'entries',
            requestId: randomUUID(),
            schemaRevision: 1,
            data: { note: 'committed' },
          },
          { kind: 'public', actor: { kind: 'local', userId: 'user_local' } }
        )
      ).rejects.toMatchObject({
        code: 'invalid_operation_output',
        message: expect.stringContaining('does not undo committed effects'),
      });
      await owners.workspaceMutationAdmission.close('ws_demo');
      owners.workspaceMutationAdmission.reopen('ws_demo');
      const corrupt = await f.app.request('/api/app/operations/kernel.records.create', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-openkit-request-id': randomUUID() },
        body: JSON.stringify({
          workspaceId: 'ws_demo',
          appId: f.appRecord.appId,
          collection: 'entries',
          schemaRevision: 1,
          data: { note: 'committed over HTTP' },
        }),
      });
      expect(corrupt.status).toBe(500);
      expect(ApiErrorSchema.parse(await corrupt.json())).toMatchObject({
        code: 'invalid_operation_output',
        message: expect.stringContaining('does not undo committed effects'),
      });
      expect(
        listRecords(f.command.dataRoot, 'ws_demo', f.appRecord.appId, 'entries', {
          schemaRevision: 1,
        }).items
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ revision: 1, data: { note: 'committed' } }),
          expect.objectContaining({ revision: 1, data: { note: 'committed over HTTP' } }),
        ])
      );
    } finally {
      corruptedOutput.mockRestore();
      f.coreDb.sqlite.close();
    }
  });
  it('preserves typed read-only denial through authenticated HTTP and rejects a revoked next call', async () => {
    const f = await operationFixture();
    try {
      const server = createApp({
        mode: 'server',
        coreDb: f.coreDb,
        dataRoot: f.command.dataRoot,
        store: f.store,
      });
      const issued = createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: 'user_local',
        scope: 'workspace-readonly',
        workspaceIds: ['ws_demo'],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      const headers = {
        authorization: `Bearer ${issued.secret}`,
        'content-type': 'application/json',
      };
      const selector = { workspaceId: 'ws_demo', appId: f.appRecord.appId };
      const read = await server.request('/api/app/operations/kernel.apps.get', {
        method: 'POST',
        headers,
        body: JSON.stringify(selector),
      });
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual(f.appRecord);
      const denied = await server.request('/api/app/operations/kernel.records.create', {
        method: 'POST',
        headers: { ...headers, 'x-openkit-request-id': randomUUID() },
        body: JSON.stringify({
          ...selector,
          collection: 'entries',
          schemaRevision: 1,
          data: { note: 'denied' },
        }),
      });
      expect(denied.status).toBe(403);
      expect(ApiErrorSchema.parse(await denied.json())).toMatchObject({
        code: 'workspace_access_denied',
      });
      expect(
        listRecords(f.command.dataRoot, 'ws_demo', selector.appId, 'entries', { schemaRevision: 1 })
          .totalItems
      ).toBe(0);
      revokeOpenKitAccessTokenRecord(f.coreDb, issued.record.tokenId);
      const revoked = await server.request('/api/app/operations/kernel.apps.get', {
        method: 'POST',
        headers,
        body: JSON.stringify(selector),
      });
      expect(revoked.status).toBe(401);
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('replays current owner records and rejects changed input before any effect', async () => {
    const f = await operationFixture();
    try {
      const invoke = createOperationInvocation({
        ...f.command,
        coreDb: f.coreDb,
        workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      });
      const context = {
        kind: 'public' as const,
        actor: { kind: 'local' as const, userId: 'user_local' },
      };
      const input = {
        workspaceId: 'ws_demo',
        appId: f.appRecord.appId,
        collection: 'entries',
        requestId: randomUUID(),
        schemaRevision: 1,
        data: { note: 'original' },
      };
      const first = await invoke('kernel.records.create', input, context);
      const updated = await updateRecord(
        { ...f.command, requestId: randomUUID() },
        input.appId,
        'entries',
        first.id,
        {
          schemaRevision: 1,
          expectedRecordRevision: 1,
          data: { note: 'current' },
        }
      );
      expect(await invoke('kernel.records.create', input, context)).toEqual(updated);
      const before = listRecords(f.command.dataRoot, 'ws_demo', input.appId, 'entries', {
        schemaRevision: 1,
      });
      await expect(
        invoke('kernel.records.create', { ...input, data: { note: 'conflict' } }, context)
      ).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
      expect(
        listRecords(f.command.dataRoot, 'ws_demo', input.appId, 'entries', { schemaRevision: 1 })
      ).toEqual(before);
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('enforces read-only credentials and current revocation at native admission', async () => {
    const f = await operationFixture();
    try {
      const issued = createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: 'user_local',
        scope: 'workspace-readonly',
        workspaceIds: ['ws_demo'],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      const actor: Actor = {
        kind: 'token',
        userId: 'user_local',
        tokenId: issued.record.tokenId,
        tokenScope: 'workspace-readonly',
        tokenWorkspaceIds: ['ws_demo'],
      };
      const invoke = createOperationInvocation({
        ...f.command,
        coreDb: f.coreDb,
        workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      });
      const selector = { workspaceId: 'ws_demo', appId: f.appRecord.appId };
      expect(await invoke('kernel.apps.get', selector, { kind: 'public', actor })).toEqual(
        f.appRecord
      );
      await expect(
        invoke(
          'kernel.records.create',
          {
            ...selector,
            collection: 'entries',
            requestId: randomUUID(),
            schemaRevision: 1,
            data: { note: 'denied' },
          },
          { kind: 'public', actor }
        )
      ).rejects.toMatchObject({ code: 'workspace_access_denied' });
      expect(
        listRecords(f.command.dataRoot, 'ws_demo', selector.appId, 'entries', { schemaRevision: 1 })
          .totalItems
      ).toBe(0);
      revokeOpenKitAccessTokenRecord(f.coreDb, issued.record.tokenId);
      await expect(
        invoke('kernel.apps.get', selector, { kind: 'public', actor })
      ).rejects.toMatchObject({ code: 'workspace_access_denied' });
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('rejects model-bound identity conflicts and unproved Worker lineage before effects', async () => {
    const f = await operationFixture();
    try {
      const invoke = createOperationInvocation({
        ...f.command,
        coreDb: f.coreDb,
        workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      });
      const context = {
        kind: 'worker' as const,
        actor: f.command.actor,
        requestId: randomUUID(),
        bindings: { workspaceId: 'ws_demo', requestId: randomUUID() },
        lineage: {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          turnId: 'turn_wrong',
          agentSessionId: 'session_wrong',
          packageSnapshotId: 'package_wrong',
        },
      };
      const input = {
        appId: f.appRecord.appId,
        collection: 'entries',
        schemaRevision: 1,
        data: { note: 'denied' },
      };
      await expect(
        invoke('kernel.records.create', { ...input, workspaceId: 'ws_other' }, context)
      ).rejects.toMatchObject({ code: 'bound_input_conflict' });
      await expect(
        invoke(
          'kernel.records.create',
          { ...input, actor: { kind: 'user', id: 'user_other' } },
          context
        )
      ).rejects.toMatchObject({ code: 'bound_input_conflict' });
      await expect(invoke('kernel.records.create', input, context)).rejects.toMatchObject({
        code: 'workspace_access_denied',
      });
      expect(
        listRecords(f.command.dataRoot, 'ws_demo', input.appId, 'entries', { schemaRevision: 1 })
          .totalItems
      ).toBe(0);
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('keeps a caller-selected Workspace distinct from context-bound identity and scoped children', async () => {
    const f = await operationFixture();
    try {
      const other = f.store.createWorkspace('Other authorized Workspace');
      recordWorkspaceOwnerMembership({
        coreDb: f.coreDb,
        ownerUserId: 'user_local',
        workspaceId: other.id,
      });
      const invoke = createOperationInvocation({
        ...f.command,
        coreDb: f.coreDb,
        workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      });
      const context = {
        kind: 'public' as const,
        actor: { kind: 'local' as const, userId: 'user_local' },
      };
      const child = await createLightApp(
        { ...f.command, workspaceId: other.id, requestId: randomUUID() },
        f.schema
      );
      expect(
        await invoke('kernel.apps.get', { workspaceId: other.id, appId: child.appId }, context)
      ).toEqual(child);
      expect(
        await invoke(
          'kernel.apps.get',
          { workspaceId: 'ws_demo', appId: f.appRecord.appId },
          context
        )
      ).toEqual(f.appRecord);
      const { projections } = await operationProjections(f);
      const wrongChild = { workspaceId: 'ws_demo', appId: child.appId };
      const ownerRead = commands.getLightApp(
        f.command.dataRoot,
        wrongChild.workspaceId,
        wrongChild.appId
      );
      expect(ownerRead).toMatchObject({ lifecycle: 'unavailable', schema: null });
      const input = {
        ...wrongChild,
        collection: 'entries',
        schemaRevision: 1,
        requestId: randomUUID(),
        data: { note: 'wrong child' },
      };
      let ownerFailure: unknown;
      try {
        await commands.createRecord(
          f.command,
          input.appId,
          input.collection,
          input.schemaRevision,
          input.data
        );
      } catch (error) {
        ownerFailure = error;
      }
      expect(ownerFailure).toMatchObject({
        code: 'unavailable',
        message: 'App authority is missing.',
      });
      const { code, message } = ownerFailure as { code: string; message: string };
      for (const project of Object.values(projections)) {
        await expect(project('kernel.records.create', input)).rejects.toMatchObject({
          code,
          message,
        });
        await expect(project('kernel.apps.get', wrongChild)).resolves.toEqual(ownerRead);
        for (const [workspaceId, appId] of [
          ['ws_demo', f.appRecord.appId],
          [other.id, child.appId],
        ]) {
          expect(
            listRecords(f.command.dataRoot, workspaceId!, appId!, 'entries', { schemaRevision: 1 })
              .totalItems
          ).toBe(0);
        }
      }
    } finally {
      f.coreDb.sqlite.close();
    }
  });
  it('preserves the owner unavailable entry for a missing app through every projection', async () => {
    const f = await operationFixture();
    try {
      const { projections } = await operationProjections(f);
      const selector = { workspaceId: 'ws_demo', appId: randomUUID() };
      const ownerRead = commands.getLightApp(
        f.command.dataRoot,
        selector.workspaceId,
        selector.appId
      );
      expect(ownerRead).toMatchObject({
        appId: selector.appId,
        lifecycle: 'unavailable',
        schema: null,
      });
      for (const project of Object.values(projections)) {
        await expect(project('kernel.apps.get', selector)).resolves.toEqual(ownerRead);
      }
      expect(
        listRecords(f.command.dataRoot, 'ws_demo', f.appRecord.appId, 'entries', {
          schemaRevision: 1,
        }).totalItems
      ).toBe(0);
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('rejects the next Worker call after its admitted administrator credential is revoked', async () => {
    const f = await operationFixture();
    try {
      const { projections, workerAuthorityTokenId } = await operationProjections(f);
      const selector = { workspaceId: 'ws_demo', appId: f.appRecord.appId };
      expect(await projections.worker!('kernel.apps.get', selector)).toEqual(f.appRecord);
      revokeOpenKitAccessTokenRecord(f.coreDb, workerAuthorityTokenId);
      await expect(projections.worker!('kernel.apps.get', selector)).rejects.toMatchObject({
        code: 'mcp-denied',
      });
      await expect(
        projections.worker!('kernel.records.create', {
          ...selector,
          collection: 'entries',
          schemaRevision: 1,
          requestId: randomUUID(),
          data: { note: 'revoked' },
        })
      ).rejects.toMatchObject({ code: 'mcp-denied' });
      expect(
        listRecords(f.command.dataRoot, 'ws_demo', f.appRecord.appId, 'entries', {
          schemaRevision: 1,
        }).totalItems
      ).toBe(0);
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('uses canonical JSON routes for the read and replayable mutation', async () => {
    const fixture = await operationFixture();
    try {
      const input = { workspaceId: 'ws_demo', appId: fixture.appRecord.appId };
      const read = await fixture.app.request('/api/app/operations/kernel.apps.get', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual(fixture.appRecord);
      const mutation = await fixture.app.request('/api/app/operations/kernel.records.create', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-openkit-request-id': randomUUID() },
        body: JSON.stringify({
          ...input,
          collection: 'entries',
          schemaRevision: 1,
          data: { note: 'same result' },
        }),
      });
      expect(mutation.status).toBe(200);
      expect(
        listRecords(fixture.command.dataRoot, 'ws_demo', input.appId, 'entries', {
          schemaRevision: 1,
        }).items
      ).toEqual([await mutation.json()]);
      expect(
        (await fixture.app.request(`/api/app/workspaces/ws_demo/light-apps/${input.appId}`)).status
      ).toBe(404);
      expect(
        (
          await fixture.app.request(
            `/api/app/workspaces/ws_demo/light-apps/${input.appId}/collections/entries/records`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{}',
            }
          )
        ).status
      ).toBe(404);
    } finally {
      fixture.coreDb.sqlite.close();
    }
  });
});

/** Public projection assembly sharing real authentication, storage, client and CLI owners. */
async function publicJourneyProjections(
  f: Awaited<ReturnType<typeof operationFixture>>,
  secret?: string
) {
  const app = secret
    ? createApp({ mode: 'server', coreDb: f.coreDb, dataRoot: f.command.dataRoot, store: f.store })
    : f.app;
  const headers = {
    'content-type': 'application/json',
    ...(secret ? { authorization: `Bearer ${secret}` } : {}),
  };
  const client = createCoreClient({
    baseUrl: 'http://127.0.0.1',
    headers,
    fetch: (input, init) => app.fetch(new Request(input, init)),
  });
  const { operationCatalog } = await import(
    new URL('../../../skills/openkit-operations.mjs', import.meta.url).href
  );
  return {
    http: async (id: string, args: Record<string, unknown>) => {
      const { requestId, ...body } = args;
      const response = await app.request(`/api/app/operations/${id}`, {
        method: 'POST',
        headers: {
          ...headers,
          ...(requestId ? { 'x-openkit-request-id': String(requestId) } : {}),
        },
        body: JSON.stringify(body),
      });
      expect(
        response.headers.get('content-type'),
        `Derived ${id} binding must return JSON`
      ).toContain('application/json');
      const output = await response.json();
      if (!response.ok) throw output;
      return output;
    },
    client: (id: string, args: Record<string, unknown>) =>
      (client.operations as unknown as Record<string, (args: unknown) => Promise<unknown>>)[id]!(
        args
      ),
    cli: (id: string, args: Record<string, unknown>) => {
      const operation = operationCatalog.find((entry: { id: string }) => entry.id === id);
      expect(operation).toBeDefined();
      return operation.handler({ client }, operation.inputSchema.parse(args));
    },
  };
}

describe('Workspace Thread Turn projection cutover', () => {
  it('preserves authorized collection, resources, Thread creation replay and all Thread/Turn reads across HTTP client and CLI', async () => {
    const f = await operationFixture();
    try {
      const projections = await publicJourneyProjections(f);
      const selector = { workspaceId: 'ws_demo' };
      for (const [initiating, create] of Object.entries(projections)) {
        const input = {
          ...selector,
          name: initiating,
          visibility: 'workspace',
          requestId: randomUUID(),
        };
        const thread = (await create('thread.create', input)) as { id: string; visibility: string };
        expect(thread.visibility).toBe('workspace');
        const turn = f.store.createTurn('ws_demo', thread.id, 'journey', f.command.actor);
        const child = { ...selector, threadId: thread.id };
        let collection: unknown;
        let dashboard: unknown;
        let turnRead: unknown;
        for (const project of Object.values(projections)) {
          const list = await project('workspace.list', {});
          collection ??= list;
          expect(list).toEqual(collection);
          expect(list).toMatchObject({
            items: expect.arrayContaining([
              expect.objectContaining({
                workspace: expect.objectContaining({ id: 'ws_demo' }),
                effectiveRole: 'owner',
              }),
            ]),
          });
          expect(await project('workspace.resources', selector)).toEqual(
            f.store.getWorkspaceResources('ws_demo')
          );
          expect(await project('thread.create', input)).toEqual(
            f.store.getThread('ws_demo', thread.id)
          );
          expect(await project('thread.read', child)).toEqual(
            f.store.getThread('ws_demo', thread.id)
          );
          expect(await project('thread.items', child)).toEqual({
            items: f.store.listThreadItems('ws_demo', thread.id),
            nextCursor: null,
          });
          const read = await project('thread.dashboard', child);
          dashboard ??= read;
          expect(read).toEqual(dashboard);
          expect(read).toMatchObject({
            thread: f.store.getThread('ws_demo', thread.id),
            viewerUserId: 'user_local',
          });
          const result = await project('turn.read', { ...child, turnId: turn.id });
          turnRead ??= result;
          expect(result).toEqual(turnRead);
          expect(result).toMatchObject({ id: turn.id, contextPackageDigest: null });
          expect(result).not.toHaveProperty('agentSessionId');
        }
        const before = f.store.listThreads('ws_demo').length;
        for (const project of Object.values(projections)) {
          await expect(
            project('thread.create', { ...input, name: 'changed' })
          ).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
        }
        expect(f.store.listThreads('ws_demo')).toHaveLength(before);
      }
      for (const [initiating, project] of Object.entries(projections)) {
        const privateThread = await project('thread.create', {
          ...selector,
          name: `${initiating} private default`,
          requestId: randomUUID(),
        });
        expect(privateThread).toMatchObject({
          visibility: 'private',
          privateOwnerUserId: 'user_local',
        });
      }
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('keeps owner refusals for unauthorized Workspace, foreign-private Thread audience denial and read-only creation with zero effects', async () => {
    const f = await operationFixture();
    try {
      const issued = createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: 'user_local',
        scope: 'workspace-readonly',
        workspaceIds: ['ws_demo'],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      const projections = await publicJourneyProjections(f, issued.secret);
      const foreign = f.store.createThread('ws_demo', 'private marker', undefined, 'conversation', {
        visibility: 'private',
        privateOwnerUserId: 'user_foreign',
      });
      const turn = f.store.createTurn('ws_demo', foreign.id, 'protected marker', f.command.actor);
      const before = f.store.listThreads('ws_demo').length;
      for (const project of Object.values(projections)) {
        await expect(
          project('workspace.resources', { workspaceId: 'ws_unknown' })
        ).rejects.toMatchObject({
          code: 'workspace_access_denied',
          message: 'Workspace access denied.',
        });
        for (const id of ['thread.read', 'thread.items', 'thread.dashboard']) {
          await expect(
            project(id, { workspaceId: 'ws_demo', threadId: foreign.id })
          ).rejects.toMatchObject({ code: 'not_found', message: 'Thread not found.' });
        }
        await expect(
          project('turn.read', { workspaceId: 'ws_demo', threadId: foreign.id, turnId: turn.id })
        ).rejects.toMatchObject({ code: 'not_found', message: 'Thread not found.' });
        await expect(
          project('thread.create', {
            workspaceId: 'ws_demo',
            name: 'denied',
            requestId: randomUUID(),
            visibility: 'workspace',
          })
        ).rejects.toMatchObject({
          code: 'workspace_access_denied',
          message: 'Workspace access denied.',
        });
      }
      expect(f.store.listThreads('ws_demo')).toHaveLength(before);
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('keeps the owner not_found for a visible Thread with a Turn from another Thread in the same Workspace with zero effects', async () => {
    const f = await operationFixture();
    try {
      const projections = await publicJourneyProjections(f);
      const visible = f.store.createThread('ws_demo', 'visible Thread');
      const other = f.store.createThread('ws_demo', 'other visible Thread');
      const turn = f.store.createTurn('ws_demo', other.id, 'wrong lineage', f.command.actor);
      const threadCount = f.store.listThreads('ws_demo').length;
      const visibleTurnCount = f.store.listThreadTurns('ws_demo', visible.id).length;
      const otherTurnCount = f.store.listThreadTurns('ws_demo', other.id).length;
      for (const project of Object.values(projections)) {
        expect(
          await project('thread.read', { workspaceId: 'ws_demo', threadId: visible.id })
        ).toEqual(f.store.getThread('ws_demo', visible.id));
        await expect(
          project('turn.read', { workspaceId: 'ws_demo', threadId: visible.id, turnId: turn.id })
        ).rejects.toMatchObject({ code: 'not_found', message: `Turn not found: ${turn.id}` });
        expect(f.store.listThreads('ws_demo')).toHaveLength(threadCount);
        expect(f.store.listThreadTurns('ws_demo', visible.id)).toHaveLength(visibleTurnCount);
        expect(f.store.listThreadTurns('ws_demo', other.id)).toHaveLength(otherTurnCount);
      }
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('rejects conflicting HTTP Thread creation body and header request identities with zero effects', async () => {
    const f = await operationFixture();
    try {
      const threadCount = f.store.listThreads('ws_demo').length;
      const response = await f.app.request('/api/app/operations/thread.create', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-openkit-request-id': randomUUID() },
        body: JSON.stringify({
          workspaceId: 'ws_demo',
          name: 'conflicting identity',
          requestId: randomUUID(),
        }),
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ code: 'bound_input_conflict' });
      expect(f.store.listThreads('ws_demo')).toHaveLength(threadCount);
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('admits the current administrator bearer and Web session to foreign private reads and active Workspace candidates without membership', async () => {
    const f = await operationFixture();
    try {
      const other = f.store.createWorkspace('administrator candidate');
      f.coreDb.sqlite
        .prepare(
          "INSERT INTO users (id, kind, display_name, email, email_verified, created_at, updated_at, last_seen_at) SELECT 'user_foreign', kind, display_name, 'foreign@local.openkit.invalid', email_verified, created_at, updated_at, last_seen_at FROM users WHERE id = 'user_local'"
        )
        .run();
      recordWorkspaceOwnerMembership({
        coreDb: f.coreDb,
        ownerUserId: 'user_foreign',
        workspaceId: other.id,
      });
      const foreign = f.store.createThread(other.id, 'foreign private', undefined, 'conversation', {
        visibility: 'private',
        privateOwnerUserId: 'user_foreign',
      });
      const turn = f.store.createTurn(other.id, foreign.id, 'administrator read', f.command.actor);
      const issued = createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: 'user_local',
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      const projections = await publicJourneyProjections(f, issued.secret);
      for (const project of Object.values(projections)) {
        expect(await project('workspace.list', {})).toMatchObject({
          items: expect.arrayContaining([
            expect.objectContaining({ workspace: expect.objectContaining({ id: other.id }) }),
          ]),
        });
        expect(
          await project('thread.read', { workspaceId: other.id, threadId: foreign.id })
        ).toEqual(f.store.getThread(other.id, foreign.id));
        expect(
          await project('thread.dashboard', { workspaceId: other.id, threadId: foreign.id })
        ).toMatchObject({ thread: f.store.getThread(other.id, foreign.id) });
        expect(
          await project('turn.read', {
            workspaceId: other.id,
            threadId: foreign.id,
            turnId: turn.id,
          })
        ).toMatchObject({ id: turn.id });
      }
      const invoke = createOperationInvocation({
        ...f.command,
        coreDb: f.coreDb,
        workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      });
      expect(
        await invoke(
          'thread.read' as never,
          { workspaceId: other.id, threadId: foreign.id },
          { kind: 'public', actor: { kind: 'session', userId: 'user_local' } }
        )
      ).toEqual(f.store.getThread(other.id, foreign.id));
      revokeOpenKitAccessTokenRecord(f.coreDb, issued.record.tokenId);
      await expect(
        invoke(
          'thread.read' as never,
          { workspaceId: other.id, threadId: foreign.id },
          { kind: 'public', actor: { kind: 'session', userId: 'user_local' } }
        )
      ).rejects.toMatchObject({ code: 'workspace_access_denied' });
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('deletes every replaced route and hand-written client CLI access and OpenAPI mapping', async () => {
    const f = await operationFixture();
    try {
      const turn = f.store.createTurn('ws_demo', 'th_demo', 'old route', f.command.actor);
      for (const [method, path] of [
        ['GET', '/api/workspaces'],
        ['GET', '/api/app/workspaces'],
        ['GET', '/api/workspaces/ws_demo/resources'],
        ['POST', '/api/workspaces/ws_demo/threads'],
        ['GET', '/api/workspaces/ws_demo/threads/th_demo'],
        ['GET', '/api/app/workspaces/ws_demo/threads/th_demo/items'],
        ['GET', '/api/app/workspaces/ws_demo/threads/th_demo/dashboard'],
        ['GET', `/api/workspaces/ws_demo/threads/th_demo/turns/${turn.id}`],
      ])
        expect(
          (
            await f.app.request(path!, {
              method,
              headers: { 'content-type': 'application/json' },
              body: method === 'POST' ? '{}' : undefined,
            })
          ).status,
          `${method} ${path}`
        ).toBe(404);
      const root = new URL('../../../', import.meta.url);
      const cli = readFileSync(new URL('skills/openkit-operations.mjs', root), 'utf8');
      for (const id of [
        'workspace.list',
        'workspace.resources',
        'thread.create',
        'thread.read',
        'thread.items',
        'thread.dashboard',
        'turn.read',
      ])
        expect(cli).not.toContain(`id: '${id}'`);
      const access = readFileSync(
        new URL('apps/nanocore/src/auth/operation-access.ts', root),
        'utf8'
      );
      const openapi = readFileSync(new URL('apps/nanocore/src/openapi.ts', root), 'utf8');
      for (const old of ['listAuthorizedWorkspaces', 'listThreadItems', 'getThreadDashboard']) {
        expect(access).not.toContain(`'${old}'`);
        expect(openapi).not.toContain(`operationId: '${old}'`);
      }
      const client = createCoreClient({ baseUrl: 'http://nanocore.test' });
      for (const old of [
        'listWorkspaces',
        'getWorkspaceResources',
        'createThread',
        'getThread',
        'getTurn',
        'listThreadItems',
      ])
        expect(client.core).not.toHaveProperty(old);
      for (const old of ['listAuthorizedWorkspaces', 'getThreadDashboard'])
        expect(client.app).not.toHaveProperty(old);
    } finally {
      f.coreDb.sqlite.close();
    }
  });
});

import { GOAL_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { createGoalTools } from './runtime/goal-coordinator.js';
import { openWorkspaceDb } from './storage/db.js';
import { applyScopedMigrations } from './storage/migrate.js';

describe('Goal definition projections', () => {
  it('joins HTTP, Core Client, CLI and Coordinator Tools to the same Goal owner', async () => {
    const f = await operationFixture();
    try {
      const projections = await publicJourneyProjections(f);
      const created = (await projections.client('goal.create', {
        workspaceId: 'ws_demo',
        requestId: randomUUID(),
        intent: 'Review design',
      })) as import('@openkit/app-api-schemas').GoalView;
      const goal = created.goal!;
      const scope = { workspaceId: goal.workspaceId, threadId: goal.threadId, goalId: goal.goalId };
      for (const project of Object.values(projections))
        expect(
          ((await project('goal.read', scope)) as import('@openkit/app-api-schemas').GoalView).goal!
            .goalId
        ).toBe(goal.goalId);
      const db = openWorkspaceDb(f.command.dataRoot, goal.workspaceId);
      applyScopedMigrations(db);
      try {
        const previous = f.store
          .listThreadTurns(goal.workspaceId, goal.threadId)
          .filter((turn) => turn.agentId === 'goal-coordinator');
        for (const turn of previous)
          if (turn.status === 'running')
            f.store.updateTurn(turn.id, {
              status: 'failed',
              completedAt: new Date().toISOString(),
            });
        const turn = f.store.createTurn(
          goal.workspaceId,
          goal.threadId,
          'Projection check',
          { kind: 'user', id: 'user_local' },
          undefined,
          { executorKind: 'coordinator', agentId: 'goal-coordinator' }
        );
        const tools = createGoalTools({
          store: f.store,
          db,
          actor: { kind: 'local', userId: 'user_local' },
          goalId: goal.goalId,
          turnId: turn.id,
          services: {},
          invoke: createOperationInvocation({
            coreDb: f.coreDb,
            store: f.store,
            repositoryWorkspaceDb: (workspaceId) => {
              const db = openWorkspaceDb(f.command.dataRoot, workspaceId);
              applyScopedMigrations(db);
              return db;
            },
            inflightCommands: new WeakMap(),
            workspaceMutationAdmission: new WorkspaceMutationAdmission(),
          }),
        });
        expect(tools.map((tool) => tool.name).sort()).toEqual(
          Object.entries(GOAL_OPERATION_DEFINITIONS)
            .filter(([, definition]) =>
              (definition.credentials as readonly string[]).includes('coordinator')
            )
            .map(([id]) => operationToolName(id))
            .sort()
        );
        const read = await tools.find((tool) => tool.name === 'goal_read')!.execute({});
        expect(read.isError).not.toBe(true);
        expect(JSON.parse((read.content[0] as { text: string }).text).goal.goalId).toBe(
          goal.goalId
        );

        expect(
          (
            (await projections.http('goal.card.create', {
              ...scope,
              requestId: randomUUID(),
              description: 'Verify API',
              priority: 0,
            })) as import('@openkit/app-api-schemas').GoalView
          ).cards
        ).toHaveLength(1);
      } finally {
        db.sqlite.close();
      }
    } finally {
      f.coreDb.sqlite.close();
    }
  });
  it('preserves read-only, wrong-audience and revocation refusals before Goal effects', async () => {
    const f = await operationFixture();
    try {
      const issued = createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: 'user_local',
        scope: 'workspace-readonly',
        workspaceIds: ['ws_demo'],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      const readOnly = await publicJourneyProjections(f, issued.secret);
      await expect(
        readOnly.http('goal.create', {
          workspaceId: 'ws_demo',
          requestId: randomUUID(),
          intent: 'Denied',
        })
      ).rejects.toMatchObject({ code: 'workspace_access_denied' });
      const foreign = f.store.createThread('ws_demo', 'Private', undefined, 'conversation', {
        visibility: 'private',
        privateOwnerUserId: 'user_foreign',
      });
      await expect(
        readOnly.http('goal.read', { workspaceId: 'ws_demo', threadId: foreign.id })
      ).rejects.toMatchObject({ code: 'not_found' });
      revokeOpenKitAccessTokenRecord(f.coreDb, issued.record.tokenId);
      await expect(
        readOnly.http('goal.read', { workspaceId: 'ws_demo', threadId: 'th_demo' })
      ).rejects.toMatchObject({ code: expect.any(String) });
    } finally {
      f.coreDb.sqlite.close();
    }
  });
});

import { executeGoalOperation } from './runtime/goal-owner.js';

it('discloses and grants a Coordinator proposal to the current administrator without membership, retaining actual attribution and refusing revoked consumption', async () => {
  const f = await operationFixture();
  const db = openWorkspaceDb(f.command.dataRoot, 'ws_demo');
  applyScopedMigrations(db);
  try {
    f.coreDb.sqlite
      .prepare(
        "INSERT INTO users (id,kind,display_name,email,email_verified,created_at,updated_at,last_seen_at) SELECT 'user_admin',kind,display_name,'admin@local.openkit.invalid',email_verified,created_at,updated_at,last_seen_at FROM users WHERE id='user_local'"
      )
      .run();
    const issued = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: 'user_admin',
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const context = { actor: { kind: 'local' as const, userId: 'user_local' } };
    const created = await executeGoalOperation(
      'goal.create',
      { workspaceId: 'ws_demo', requestId: randomUUID(), intent: 'Review design' },
      context,
      f.store,
      db
    );
    const goal = created.goal!;
    const scope = { workspaceId: 'ws_demo', threadId: goal.threadId, goalId: goal.goalId };
    const turn = f.store.createTurn(
      'ws_demo',
      goal.threadId,
      'Coordinate',
      { kind: 'user', id: 'user_local' },
      undefined,
      { executorKind: 'coordinator', agentId: 'goal-coordinator' }
    );
    const coordinator = { ...context, coordinatorTurnId: turn.id };
    const proposed = await executeGoalOperation(
      'goal.plan.propose',
      {
        ...scope,
        requestId: randomUUID(),
        expectedRevision: goal.changeRevision,
        commitment: {
          intentBasis: { intent: goal.intent, revision: 0 },
          cards: [],
          permittedAdjustments: 'Research only',
          completionEvidence: ['Report'],
          boundaries: 'No writes',
        },
      },
      coordinator,
      f.store,
      db
    );
    const request = proposed.requests[0]!;
    const admin = await publicJourneyProjections(f, issued.secret);
    const resolved = (await admin.client('goal.plan.approve', {
      ...scope,
      requestId: randomUUID(),
      pendingRequestId: request.requestId,
      decision: 'granted',
    })) as import('@openkit/app-api-schemas').GoalView;
    expect(resolved.requests[0]).toMatchObject({
      decidingActorId: 'user_admin',
      claim: 'unclaimed',
      disposition: null,
    });
    const consuming = f.store.createTurn(
      'ws_demo',
      goal.threadId,
      'Consume exact outcome',
      { kind: 'user', id: 'user_admin' },
      undefined,
      { executorKind: 'coordinator', agentId: 'goal-coordinator' }
    );
    coordinator.coordinatorTurnId = consuming.id;
    revokeOpenKitAccessTokenRecord(f.coreDb, issued.record.tokenId);
    await expect(
      executeGoalOperation(
        'goal.plan.approve',
        {
          ...scope,
          requestId: randomUUID(),
          pendingRequestId: request.requestId,
          decision: 'granted',
        },
        coordinator,
        f.store,
        db,
        { coreDb: f.coreDb }
      )
    ).rejects.toMatchObject({ code: 'grant_conflict' });
    expect(
      db.sqlite
        .prepare(
          'SELECT deciding_actor_id,claim,disposition FROM pending_requests WHERE request_id=?'
        )
        .get(request.requestId)
    ).toEqual({
      deciding_actor_id: 'user_admin',
      claim: 'unclaimed',
      disposition: 'denied-not-executed',
    });
  } finally {
    db.sqlite.close();
    f.coreDb.sqlite.close();
  }
});
