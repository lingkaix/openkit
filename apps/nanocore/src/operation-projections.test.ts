import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LightAppSchemaInput } from '@openkit/app-api-schemas';
import {
  type JsonOperationId,
  type KernelOperationId,
  OPERATION_DEFINITIONS,
  operationToolName,
} from '@openkit/app-api-schemas';
import { ApiErrorSchema, PROTOCOL_VERSION, workspaceIdForOwner } from '@openkit/protocol';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createCoreClient } from '../../../packages/core-client/src/index.js';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from './auth/access-token-store.js';
import { createBetterAuth } from './auth/better-auth.js';
import type { Actor } from './auth/identity.js';
import type { AuthVariables } from './auth/middleware.js';
import { createInMemoryRuntimeConfigSnapshot } from './config/runtime-config.js';
import * as commands from './generative-kernel/commands.js';
import { createLightApp, listRecords, updateRecord } from './generative-kernel/commands.js';
import { KernelCommandError } from './generative-kernel/errors.js';
import { createAppOpenApiDocument, getRegisteredAppApiOperationIds } from './openapi.js';
import * as invocation from './operation-composition.js';
import { createOperationInvocation } from './operation-composition.js';
import type {
  AssistantOperationInvocationContext,
  OperationImplementations,
} from './operation-contract.js';
import { OperationError } from './operation-error.js';
import { createInternalOperationEngine, createOperationEngine } from './operation-invocation.js';
import { registerOperationJsonRoutes } from './operation-json-routes.js';
import type { OperationAdmissionDependencies } from './operation-resolvers.js';
import * as goalCoordinator from './runtime/goal-coordinator.js';
import {
  dispatchOpenkitGenerativeTool,
  OPENKIT_GENERATIVE_TOOL_OPERATIONS,
} from './runtime/openkit-generative-mcp.js';
import type { WorkerControlGateway } from './runtime/worker-control-gateway.js';
import { createDefaultWorkerMcpGateway } from './runtime/worker-mcp-gateway.js';
import { createSchedulerAdmissionEntry } from './scheduler-records.js';
import { openExistingAppDb } from './storage/app-db.js';
import { shutdownControlStoreWorkerClient } from './storage/control-store-worker-client.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createTestAgentSetup } from './test-support/agent-environment.js';
import { type CreateAppOptions, createApp, createLoopbackAppFetch } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { testEntityId } from './test-support/entity-ids.js';
import { recordTestExecutionAttempt } from './test-support/execution-attempt.js';
import { testGoalDomainProposal } from './test-support/goal-domain.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { resolveAgentEnvironmentPackage } from './test-support/prepared-agent-environment.js';
import { registerWorkerMcpRoutes } from './worker-mcp-routes.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';
import { resolveWorkspaceMembershipRelation } from './workspace-sharing.js';

describe('shared family contract', () => {
  it('projects User owner withdrawal through the public JSON and uniform Skill operation contract', async () => {
    const id = 'vault.grant-withdraw';
    expect(Object.hasOwn(OPERATION_DEFINITIONS, id)).toBe(true);
    const openapi = createAppOpenApiDocument();
    expect(openapi.paths).toHaveProperty(`/api/app/operations/${id}`);
    // The Skill is a projection of the same operation table. Its fake transport proves forwarding only.
    const skill = await import(
      new URL('../../../skills/openkit-operations.mjs', import.meta.url).href
    );
    const operation = skill.operationCatalog.find((entry: { id: string }) => entry.id === id);
    expect(operation).toBeDefined();
    expect(operation.appOperationId).toBe(id);
    expect(operation.mutating).toBe(true);
    const input = {
      workspaceId: testEntityId('ws', 'owner-withdrawal-projection'),
      grantId: testEntityId('grant', 'owner-withdrawal-projection'),
    };
    expect(operation.inputSchema.parse(input)).toEqual(input);
    for (const field of ['material', 'userId', 'actor', 'ownerUserId', 'policyDecisionId'])
      expect(operation.inputSchema.safeParse({ ...input, [field]: 'synthetic' }).success).toBe(
        false
      );
    const result = { grantId: input.grantId, status: 'revoked' };
    const forward = vi.fn(async () => result);
    expect(await operation.handler({ client: { operations: { [id]: forward } } }, input)).toBe(
      result
    );
    expect(forward).toHaveBeenCalledExactlyOnceWith(input);
    expect(OPENKIT_GENERATIVE_TOOL_OPERATIONS).not.toHaveProperty(
      operationToolName(id as JsonOperationId)
    );
  });

  it.each(
    Object.entries(OPERATION_DEFINITIONS)
      .filter(([, definition]) => definition.binding === 'streaming')
      .map(([id]) => id)
  )('refuses native streaming invocation %s before parsing, admission or effects', async (id) => {
    const touched = vi.fn(() => {
      throw new Error('Native streaming invocation crossed its refusal boundary.');
    });
    const invoke = createOperationEngine(
      new Proxy({}, { get: touched }) as OperationImplementations,
      new Proxy({}, { get: touched }) as OperationAdmissionDependencies
    );
    // An untyped caller can cross the compile-time JSON-only boundary; runtime must fail closed.
    const error = await invoke(id as JsonOperationId, null, {
      kind: 'public',
      actor: { kind: 'local', userId: 'usr_00000000-0000-7000-8000-000000000001' },
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(OperationError);
    expect(error).toMatchObject({ code: 'unsupported_operation', status: 400 });
    expect(touched).not.toHaveBeenCalled();
  });

  it.each([
    'success',
    'typed refusal',
  ] as const)('marks a JSON operation %s response as not cacheable', async (outcome) => {
    const f = await operationFixture();
    try {
      const response = await f.app.request('/api/app/operations/workspace.read', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          outcome === 'success' ? { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' } : {}
        ),
      });
      expect(response.status).toBe(outcome === 'success' ? 200 : 400);
      expect(await response.json()).toMatchObject(
        outcome === 'success'
          ? { id: 'ws_00000000-0000-7000-8000-000000000001' }
          : { code: 'invalid_request' }
      );
      expect(response.headers.get('cache-control')).toBe('no-store');
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('keeps overlapping dynamic success statuses local to each request', async () => {
    const f = await operationFixture();
    const turn = await f.store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Dynamic response',
      f.command.actor
    );
    const body = {
      outcome: 'answered',
      explanation: 'Done.',
      turn,
      item: await f.store.createItem({
        id: 'it_00000000-0000-714e-b73b-fee7fe0cf1a3',
        owner: { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        threadId: 'th_00000000-0000-7000-8000-000000000001',
        turnId: turn.id,
        type: 'assistant-message',
        status: 'completed',
        text: 'Done.',
        createdAt: turn.startedAt!,
        completedAt: turn.startedAt!,
      }),
      handoff: null,
      originatingWorkspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      originatingThreadId: 'th_00000000-0000-7000-8000-000000000001',
      receivingWorkspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      receivingThreadId: 'th_00000000-0000-7000-8000-000000000001',
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
      c.set('actor', { kind: 'local', userId: 'usr_00000000-0000-7000-8000-000000000001' });
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
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
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
    const turn = await f.store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Resolver subject',
      f.command.actor
    );
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
              ? { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' }
              : {
                  workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
                  threadId: 'th_00000000-0000-7000-8000-000000000001',
                  turnId: turn.id,
                }
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
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        appId: f.appRecord.appId,
        collection: 'entries',
        schemaRevision: 1,
        data: { note: 'safe' },
        requestId: randomUUID(),
      };
      for (const name of ['http', 'worker']) {
        await expect(projections[name]!('kernel.records.create', input)).rejects.toEqual({
          ...(name === 'http' ? { protocolVersion: PROTOCOL_VERSION } : {}),
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
        protocolVersion: PROTOCOL_VERSION,
        code: 'limit_exceeded',
        message: 'Record limit exceeded.',
        details: { limit: 'records', maximum: 2 },
        path: ['/data'],
      });
      const token = createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
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
          params: {
            name: 'openkit_call',
            arguments: { operation: 'kernel.records.create', input },
          },
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
        listRecords(
          f.command.dataRoot,
          'ws_00000000-0000-7000-8000-000000000001',
          f.appRecord.appId,
          'entries',
          {
            schemaRevision: 1,
          }
        ).totalItems
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
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          appId: 'private-secret-sentinel',
          collection: 'entries',
          schemaRevision: 1,
          data: {},
        }),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toEqual({
        protocolVersion: PROTOCOL_VERSION,
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
async function operationFixture(
  options: Pick<CreateAppOptions, 'llmGatewayDispatcher' | 'mode'> = {}
) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-operation-slice-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  });
  const command = {
    store,
    dataRoot,
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    actor: { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' },
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
  // Join the real App boot before this fixture publishes live Goal work.
  const createCoordinator = goalCoordinator.createGoalCoordinator;
  const coordinators = vi
    .spyOn(goalCoordinator, 'createGoalCoordinator')
    .mockImplementation((options) => {
      const coordinator = createCoordinator(options);
      vi.spyOn(coordinator, 'boot');
      return coordinator;
    });
  try {
    const app = createApp({ coreDb, dataRoot, store, ...options });
    for (const { value: coordinator } of coordinators.mock.results)
      await vi.mocked(coordinator.boot).mock.results[0]!.value;
    return { app, coreDb, store, command, appRecord, schema, mode: options.mode ?? 'local' };
  } finally {
    for (const { value: coordinator } of coordinators.mock.results)
      vi.mocked(coordinator.boot).mockRestore();
    coordinators.mockRestore();
  }
}

/** Reuses the real projection assembly over one isolated Kernel authority and exact Worker admission. */
async function operationProjections(f: Awaited<ReturnType<typeof operationFixture>>) {
  const cliModule = new URL('../../../skills/openkit-operations.mjs', import.meta.url).href;
  const { operationCatalog } = await import(cliModule);
  const client = createCoreClient({
    baseUrl: 'http://nanocore.test',
    fetch: createLoopbackAppFetch(f.app),
  });
  const turn = await f.store.createTurn(
    'ws_00000000-0000-7000-8000-000000000001',
    'th_00000000-0000-7000-8000-000000000001',
    'Operation invariant',
    f.command.actor
  );
  await f.store.createAgentSession({
    id: 'as_00000000-0000-7dd2-9c72-030c3ef6118f',
    agentId: 'agent_codex_host',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    threadId: 'th_00000000-0000-7000-8000-000000000001',
    status: 'busy',
    message: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await f.store.updateTurn(turn.id, {
    agentId: 'agent_codex_host',
    agentSessionId: 'as_00000000-0000-7dd2-9c72-030c3ef6118f',
  });
  const environmentPackage = await resolveAgentEnvironmentPackage({
    captureCoverage: { scope: 'server', value: 'off' },
    agentSessionId: 'as_00000000-0000-7dd2-9c72-030c3ef6118f',
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
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    scope: 'server-admin',
    workspaceIds: [],
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const entry = createSchedulerAdmissionEntry(f.coreDb, {
    backendId: 'nanohost',
    queueEntryId: 'queue_operation',
    requestId: 'request_operation',
    triggerActor: turn.triggerActor,
    serverAdminTokenId: workerAuthority.record.tokenId,
    workspaceId: workspaceIdForOwner(turn.owner),
    threadId: turn.threadId,
    turnId: turn.id,
    turnInput: 'Operation invariant',
    requestedAgentId: environmentPackage.agent.agentId,
  });
  recordTestExecutionAttempt(f.coreDb, {
    entry,
    attemptId: testEntityId('attempt', 'lease_operation'),
    agentSessionId: 'as_00000000-0000-7dd2-9c72-030c3ef6118f',
    inputRef: environmentPackage.snapshotId,
    bindingRef: 'binding_operation',
    sessionCompatibilityKey: 'operation-projection-session',
    now: () => new Date().toISOString(),
    operationId: 'submit_operation',
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
    const db = openWorkspaceDb(f.command.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
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
                workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
                actor: f.command.actor,
                inflightCommands: new WeakMap(),
                packageSnapshotId: 'package_fixture',
                workspaceMutationAdmission: new WorkspaceMutationAdmission(),
                scope: {
                  workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
                  threadId: 'th_00000000-0000-7000-8000-000000000001',
                  turnId: 'tu_00000000-0000-7772-b181-2e0959d2eeb3',
                  agentSessionId: 'as_00000000-0000-73ba-ba74-ff17bfabd390',
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
      const selector = {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        appId: f.appRecord.appId,
      };
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
          listRecords(
            f.command.dataRoot,
            'ws_00000000-0000-7000-8000-000000000001',
            selector.appId,
            'entries',
            {
              schemaRevision: 1,
            }
          ).items
        ).toEqual(expect.arrayContaining(mutations));
        const db = openExistingAppDb(
          f.command.dataRoot,
          'ws_00000000-0000-7000-8000-000000000001',
          selector.appId
        );
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
        listRecords(
          f.command.dataRoot,
          'ws_00000000-0000-7000-8000-000000000001',
          selector.appId,
          'entries',
          { schemaRevision: 1 }
        ).totalItems
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
              workspaceId: 'ws_00000000-0000-71f5-922f-6fd42f52f580',
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
        listRecords(
          f.command.dataRoot,
          'ws_00000000-0000-7000-8000-000000000001',
          selector.appId,
          'entries',
          { schemaRevision: 1 }
        ).totalItems
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
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            appId: f.appRecord.appId,
            collection: 'entries',
            requestId: randomUUID(),
            schemaRevision: 1,
            data: { note: 'committed' },
          },
          {
            kind: 'public',
            actor: { kind: 'local', userId: 'usr_00000000-0000-7000-8000-000000000001' },
          }
        )
      ).rejects.toMatchObject({
        code: 'invalid_operation_output',
        message: expect.stringContaining('does not undo committed effects'),
      });
      await owners.workspaceMutationAdmission.close('ws_00000000-0000-7000-8000-000000000001');
      owners.workspaceMutationAdmission.reopen('ws_00000000-0000-7000-8000-000000000001');
      const corrupt = await f.app.request('/api/app/operations/kernel.records.create', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-openkit-request-id': randomUUID() },
        body: JSON.stringify({
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
        listRecords(
          f.command.dataRoot,
          'ws_00000000-0000-7000-8000-000000000001',
          f.appRecord.appId,
          'entries',
          {
            schemaRevision: 1,
          }
        ).items
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
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        scope: 'workspace-readonly',
        workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      const headers = {
        authorization: `Bearer ${issued.secret}`,
        'content-type': 'application/json',
      };
      const selector = {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        appId: f.appRecord.appId,
      };
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
        listRecords(
          f.command.dataRoot,
          'ws_00000000-0000-7000-8000-000000000001',
          selector.appId,
          'entries',
          { schemaRevision: 1 }
        ).totalItems
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
        actor: { kind: 'local' as const, userId: 'usr_00000000-0000-7000-8000-000000000001' },
      };
      const input = {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
      const before = listRecords(
        f.command.dataRoot,
        'ws_00000000-0000-7000-8000-000000000001',
        input.appId,
        'entries',
        {
          schemaRevision: 1,
        }
      );
      await expect(
        invoke('kernel.records.create', { ...input, data: { note: 'conflict' } }, context)
      ).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
      expect(
        listRecords(
          f.command.dataRoot,
          'ws_00000000-0000-7000-8000-000000000001',
          input.appId,
          'entries',
          { schemaRevision: 1 }
        )
      ).toEqual(before);
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('enforces read-only credentials and current revocation at native admission', async () => {
    const f = await operationFixture();
    try {
      const issued = createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        scope: 'workspace-readonly',
        workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      const actor: Actor = {
        kind: 'token',
        userId: 'usr_00000000-0000-7000-8000-000000000001',
        tokenId: issued.record.tokenId,
        tokenScope: 'workspace-readonly',
        tokenWorkspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
      };
      const invoke = createOperationInvocation({
        ...f.command,
        coreDb: f.coreDb,
        workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      });
      const selector = {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        appId: f.appRecord.appId,
      };
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
        listRecords(
          f.command.dataRoot,
          'ws_00000000-0000-7000-8000-000000000001',
          selector.appId,
          'entries',
          { schemaRevision: 1 }
        ).totalItems
      ).toBe(0);
      revokeOpenKitAccessTokenRecord(f.coreDb, issued.record.tokenId);
      await expect(
        invoke('kernel.apps.get', selector, { kind: 'public', actor })
      ).rejects.toMatchObject({ code: 'workspace_access_denied' });
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  // Real invocation setup shares gate CPU; identity and zero-effect checks are the oracle.
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
        bindings: {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          requestId: randomUUID(),
        },
        lineage: {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
          turnId: 'tu_00000000-0000-7f0b-950b-062b02380791',
          agentSessionId: testEntityId('as', 'session_wrong'),
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
        invoke(
          'kernel.records.create',
          { ...input, workspaceId: 'ws_00000000-0000-71f5-922f-6fd42f52f580' },
          context
        )
      ).rejects.toMatchObject({ code: 'bound_input_conflict' });
      await expect(
        invoke(
          'kernel.records.create',
          { ...input, actor: { kind: 'user', id: 'usr_00000000-0000-73d4-904a-d4c4b905df7c' } },
          context
        )
      ).rejects.toMatchObject({ code: 'bound_input_conflict' });
      await expect(invoke('kernel.records.create', input, context)).rejects.toMatchObject({
        code: 'workspace_access_denied',
      });
      expect(
        listRecords(
          f.command.dataRoot,
          'ws_00000000-0000-7000-8000-000000000001',
          input.appId,
          'entries',
          { schemaRevision: 1 }
        ).totalItems
      ).toBe(0);
    } finally {
      f.coreDb.sqlite.close();
    }
  }, 60_000);

  it('keeps a caller-selected Workspace distinct from context-bound identity and scoped children', async () => {
    const f = await operationFixture();
    try {
      const other = await f.store.createWorkspace('Other authorized Workspace');
      recordWorkspaceOwnerMembership({
        coreDb: f.coreDb,
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        workspaceId: other.id,
      });
      const invoke = createOperationInvocation({
        ...f.command,
        coreDb: f.coreDb,
        workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      });
      const context = {
        kind: 'public' as const,
        actor: { kind: 'local' as const, userId: 'usr_00000000-0000-7000-8000-000000000001' },
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
          { workspaceId: 'ws_00000000-0000-7000-8000-000000000001', appId: f.appRecord.appId },
          context
        )
      ).toEqual(f.appRecord);
      const { projections } = await operationProjections(f);
      const wrongChild = {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        appId: child.appId,
      };
      let ownerReadFailure: unknown;
      try {
        commands.getLightApp(f.command.dataRoot, wrongChild.workspaceId, wrongChild.appId);
      } catch (error) {
        ownerReadFailure = error;
      }
      expect(ownerReadFailure).toMatchObject({ code: 'not_found', status: 404 });
      const { code: readCode, message: readMessage } = ownerReadFailure as {
        code: string;
        message: string;
      };
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
        await expect(project('kernel.apps.get', wrongChild)).rejects.toMatchObject({
          code: readCode,
          message: readMessage,
        });
        for (const [workspaceId, appId] of [
          ['ws_00000000-0000-7000-8000-000000000001', f.appRecord.appId],
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
  it('preserves the owner not_found refusal for a never-created app through every projection', async () => {
    const f = await operationFixture();
    try {
      const { projections } = await operationProjections(f);
      const selector = {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        appId: randomUUID(),
      };
      let ownerReadFailure: unknown;
      try {
        commands.getLightApp(f.command.dataRoot, selector.workspaceId, selector.appId);
      } catch (error) {
        ownerReadFailure = error;
      }
      expect(ownerReadFailure).toMatchObject({ code: 'not_found', status: 404 });
      const { code, message } = ownerReadFailure as { code: string; message: string };
      for (const project of Object.values(projections)) {
        await expect(project('kernel.apps.get', selector)).rejects.toMatchObject({ code, message });
      }
      expect(
        listRecords(
          f.command.dataRoot,
          'ws_00000000-0000-7000-8000-000000000001',
          f.appRecord.appId,
          'entries',
          {
            schemaRevision: 1,
          }
        ).totalItems
      ).toBe(0);
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('rejects the next Worker call after its admitted administrator credential is revoked', async () => {
    const f = await operationFixture();
    try {
      const { projections, workerAuthorityTokenId } = await operationProjections(f);
      const selector = {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        appId: f.appRecord.appId,
      };
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
        listRecords(
          f.command.dataRoot,
          'ws_00000000-0000-7000-8000-000000000001',
          f.appRecord.appId,
          'entries',
          {
            schemaRevision: 1,
          }
        ).totalItems
      ).toBe(0);
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('uses canonical JSON routes for the read and replayable mutation', async () => {
    const fixture = await operationFixture();
    try {
      const input = {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        appId: fixture.appRecord.appId,
      };
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
        listRecords(
          fixture.command.dataRoot,
          'ws_00000000-0000-7000-8000-000000000001',
          input.appId,
          'entries',
          {
            schemaRevision: 1,
          }
        ).items
      ).toEqual([await mutation.json()]);
      expect(
        (
          await fixture.app.request(
            `/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/light-apps/${input.appId}`
          )
        ).status
      ).toBe(404);
      expect(
        (
          await fixture.app.request(
            `/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/light-apps/${input.appId}/collections/entries/records`,
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
  const app =
    secret && f.mode !== 'server'
      ? createApp({
          mode: 'server',
          coreDb: f.coreDb,
          dataRoot: f.command.dataRoot,
          store: f.store,
        })
      : f.app;
  const headers = {
    'content-type': 'application/json',
    ...(secret ? { authorization: `Bearer ${secret}` } : {}),
  };
  const client = createCoreClient({
    baseUrl: 'http://127.0.0.1',
    headers,
    fetch: createLoopbackAppFetch(app),
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
      const selector = { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' };
      for (const [initiating, create] of Object.entries(projections)) {
        const input = {
          ...selector,
          name: initiating,
          visibility: 'workspace',
          requestId: randomUUID(),
        };
        const thread = (await create('thread.create', input)) as { id: string; visibility: string };
        expect(thread.visibility).toBe('workspace');
        const turn = await f.store.createTurn(
          'ws_00000000-0000-7000-8000-000000000001',
          thread.id,
          'journey',
          f.command.actor
        );
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
                workspace: expect.objectContaining({
                  id: 'ws_00000000-0000-7000-8000-000000000001',
                }),
                isOwner: true,
              }),
            ]),
          });
          expect(await project('workspace.resources', selector)).toEqual(
            f.store.getWorkspaceResources('ws_00000000-0000-7000-8000-000000000001')
          );
          expect(await project('thread.create', input)).toEqual(
            f.store.getThread('ws_00000000-0000-7000-8000-000000000001', thread.id)
          );
          expect(await project('thread.read', child)).toEqual(
            f.store.getThread('ws_00000000-0000-7000-8000-000000000001', thread.id)
          );
          expect(await project('thread.items', child)).toEqual({
            items: f.store.listThreadItems('ws_00000000-0000-7000-8000-000000000001', thread.id),
            nextCursor: null,
          });
          const read = await project('thread.dashboard', child);
          dashboard ??= read;
          expect(read).toEqual(dashboard);
          expect(read).toMatchObject({
            thread: f.store.getThread('ws_00000000-0000-7000-8000-000000000001', thread.id),
            viewerUserId: 'usr_00000000-0000-7000-8000-000000000001',
          });
          const result = await project('turn.read', { ...child, turnId: turn.id });
          turnRead ??= result;
          expect(result).toEqual(turnRead);
          expect(result).toMatchObject({ id: turn.id, contextPackageDigest: null });
          expect(result).not.toHaveProperty('agentSessionId');
        }
        const before = f.store.listThreads('ws_00000000-0000-7000-8000-000000000001').length;
        for (const project of Object.values(projections)) {
          await expect(
            project('thread.create', { ...input, name: 'changed' })
          ).rejects.toMatchObject({ code: 'idempotency_key_conflict' });
        }
        expect(f.store.listThreads('ws_00000000-0000-7000-8000-000000000001')).toHaveLength(before);
      }
      for (const [initiating, project] of Object.entries(projections)) {
        const privateThread = await project('thread.create', {
          ...selector,
          name: `${initiating} private default`,
          requestId: randomUUID(),
        });
        expect(privateThread).toMatchObject({
          visibility: 'private',
          privateOwnerUserId: 'usr_00000000-0000-7000-8000-000000000001',
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
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        scope: 'workspace-readonly',
        workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      const projections = await publicJourneyProjections(f, issued.secret);
      const foreign = await f.store.createThread(
        'ws_00000000-0000-7000-8000-000000000001',
        'private marker',
        undefined,
        'conversation',
        {
          visibility: 'private',
          privateOwnerUserId: 'usr_00000000-0000-7ed5-9b62-226e0a66887f',
        }
      );
      const turn = await f.store.createTurn(
        'ws_00000000-0000-7000-8000-000000000001',
        foreign.id,
        'protected marker',
        f.command.actor
      );
      const before = f.store.listThreads('ws_00000000-0000-7000-8000-000000000001').length;
      for (const project of Object.values(projections)) {
        await expect(
          project('workspace.resources', { workspaceId: 'ws_00000000-0000-7744-93d6-d2f551c62efa' })
        ).rejects.toMatchObject({
          code: 'workspace_access_denied',
          message: 'Workspace access denied.',
        });
        for (const id of ['thread.read', 'thread.items', 'thread.dashboard']) {
          await expect(
            project(id, {
              workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
              threadId: foreign.id,
            })
          ).rejects.toMatchObject({ code: 'not_found', message: 'Thread not found.' });
        }
        await expect(
          project('turn.read', {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: foreign.id,
            turnId: turn.id,
          })
        ).rejects.toMatchObject({ code: 'not_found', message: 'Thread not found.' });
        await expect(
          project('thread.create', {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            name: 'denied',
            requestId: randomUUID(),
            visibility: 'workspace',
          })
        ).rejects.toMatchObject({
          code: 'workspace_access_denied',
          message: 'Workspace access denied.',
        });
      }
      expect(f.store.listThreads('ws_00000000-0000-7000-8000-000000000001')).toHaveLength(before);
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('keeps the owner not_found for a visible Thread with a Turn from another Thread in the same Workspace with zero effects', async () => {
    const f = await operationFixture();
    try {
      const projections = await publicJourneyProjections(f);
      const visible = await f.store.createThread(
        'ws_00000000-0000-7000-8000-000000000001',
        'visible Thread'
      );
      const other = await f.store.createThread(
        'ws_00000000-0000-7000-8000-000000000001',
        'other visible Thread'
      );
      const turn = await f.store.createTurn(
        'ws_00000000-0000-7000-8000-000000000001',
        other.id,
        'wrong lineage',
        f.command.actor
      );
      const threadCount = f.store.listThreads('ws_00000000-0000-7000-8000-000000000001').length;
      const visibleTurnCount = f.store.listThreadTurns(
        'ws_00000000-0000-7000-8000-000000000001',
        visible.id
      ).length;
      const otherTurnCount = f.store.listThreadTurns(
        'ws_00000000-0000-7000-8000-000000000001',
        other.id
      ).length;
      for (const project of Object.values(projections)) {
        expect(
          await project('thread.read', {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: visible.id,
          })
        ).toEqual(f.store.getThread('ws_00000000-0000-7000-8000-000000000001', visible.id));
        await expect(
          project('turn.read', {
            workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
            threadId: visible.id,
            turnId: turn.id,
          })
        ).rejects.toMatchObject({ code: 'not_found', message: `Turn not found: ${turn.id}` });
        expect(f.store.listThreads('ws_00000000-0000-7000-8000-000000000001')).toHaveLength(
          threadCount
        );
        expect(
          f.store.listThreadTurns('ws_00000000-0000-7000-8000-000000000001', visible.id)
        ).toHaveLength(visibleTurnCount);
        expect(
          f.store.listThreadTurns('ws_00000000-0000-7000-8000-000000000001', other.id)
        ).toHaveLength(otherTurnCount);
      }
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('rejects conflicting HTTP Thread creation body and header request identities with zero effects', async () => {
    const f = await operationFixture();
    try {
      const threadCount = f.store.listThreads('ws_00000000-0000-7000-8000-000000000001').length;
      const response = await f.app.request('/api/app/operations/thread.create', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-openkit-request-id': randomUUID() },
        body: JSON.stringify({
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          name: 'conflicting identity',
          requestId: randomUUID(),
        }),
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ code: 'bound_input_conflict' });
      expect(f.store.listThreads('ws_00000000-0000-7000-8000-000000000001')).toHaveLength(
        threadCount
      );
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('admits the current administrator bearer and Web session to foreign private reads and active Workspace candidates without membership', async () => {
    const f = await operationFixture();
    try {
      const other = await f.store.createWorkspace('administrator candidate');
      f.coreDb.sqlite
        .prepare(
          "INSERT INTO users (id, kind, display_name, email, email_verified, created_at, updated_at, last_seen_at) SELECT 'usr_00000000-0000-7ed5-9b62-226e0a66887f', kind, display_name, 'foreign@local.openkit.invalid', email_verified, created_at, updated_at, last_seen_at FROM users WHERE id = 'usr_00000000-0000-7000-8000-000000000001'"
        )
        .run();
      recordWorkspaceOwnerMembership({
        coreDb: f.coreDb,
        ownerUserId: 'usr_00000000-0000-7ed5-9b62-226e0a66887f',
        workspaceId: other.id,
      });
      const foreign = await f.store.createThread(
        other.id,
        'foreign private',
        undefined,
        'conversation',
        {
          visibility: 'private',
          privateOwnerUserId: 'usr_00000000-0000-7ed5-9b62-226e0a66887f',
        }
      );
      const turn = await f.store.createTurn(
        other.id,
        foreign.id,
        'administrator read',
        f.command.actor
      );
      const issued = createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
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
          {
            kind: 'public',
            actor: {
              kind: 'session',
              userId: 'usr_00000000-0000-7000-8000-000000000001',
              adminTokenId: issued.record.tokenId,
            },
          }
        )
      ).toEqual(f.store.getThread(other.id, foreign.id));
      revokeOpenKitAccessTokenRecord(f.coreDb, issued.record.tokenId);
      await expect(
        invoke(
          'thread.read' as never,
          { workspaceId: other.id, threadId: foreign.id },
          {
            kind: 'public',
            actor: {
              kind: 'session',
              userId: 'usr_00000000-0000-7000-8000-000000000001',
              adminTokenId: issued.record.tokenId,
            },
          }
        )
      ).rejects.toMatchObject({ code: 'workspace_access_denied' });
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('deletes every replaced route and hand-written client CLI access and OpenAPI mapping', async () => {
    const f = await operationFixture();
    try {
      const turn = await f.store.createTurn(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
        'old route',
        f.command.actor
      );
      for (const [method, path] of [
        ['GET', '/api/workspaces'],
        ['GET', '/api/app/workspaces'],
        ['GET', '/api/workspaces/ws_00000000-0000-7000-8000-000000000001/resources'],
        ['POST', '/api/workspaces/ws_00000000-0000-7000-8000-000000000001/threads'],
        [
          'GET',
          '/api/workspaces/ws_00000000-0000-7000-8000-000000000001/threads/th_00000000-0000-7000-8000-000000000001',
        ],
        [
          'GET',
          '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/threads/th_00000000-0000-7000-8000-000000000001/items',
        ],
        [
          'GET',
          '/api/app/workspaces/ws_00000000-0000-7000-8000-000000000001/threads/th_00000000-0000-7000-8000-000000000001/dashboard',
        ],
        [
          'GET',
          `/api/workspaces/ws_00000000-0000-7000-8000-000000000001/threads/th_00000000-0000-7000-8000-000000000001/turns/${turn.id}`,
        ],
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
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const dispatch = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return {
        id: 'projection-idle',
        object: 'response',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'Projection checked.' }] },
        ],
      };
    });
    const f = await operationFixture({
      llmGatewayDispatcher: { createResponses: dispatch } as never,
    });
    try {
      const projections = await publicJourneyProjections(f);
      const created = (await projections.client('goal.create', {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
      applyScopedMigrations(db, undefined, 'pre-knowledge');
      try {
        // Use the Goal owner's live Turn while its controlled Provider waits.
        await entered.promise;
        const turns = f.store.listThreadTurns(goal.workspaceId, goal.threadId);
        expect(turns).toHaveLength(1);
        const turn = turns[0]!;
        expect(turn).toMatchObject({ agentId: 'goal-coordinator', status: 'running' });
        const tools = createGoalTools({
          store: f.store,
          db,
          actor: { kind: 'local', userId: 'usr_00000000-0000-7000-8000-000000000001' },
          goalId: goal.goalId,
          turnId: turn.id,
          services: {},
          invoke: createOperationInvocation({
            coreDb: f.coreDb,
            store: f.store,
            repositoryWorkspaceDb: (workspaceId) => {
              const db = openWorkspaceDb(f.command.dataRoot, workspaceId);
              applyScopedMigrations(db, undefined, 'pre-knowledge');
              return db;
            },
            inflightCommands: new WeakMap(),
            workspaceMutationAdmission: new WorkspaceMutationAdmission(),
          }),
        });
        expect(tools.map((tool) => tool.name).sort()).toEqual(
          [
            ...Object.entries(GOAL_OPERATION_DEFINITIONS)
              .filter(([, definition]) =>
                (definition.credentials as readonly string[]).includes('coordinator')
              )
              .map(([id]) => id),
            ...[
              'thread.items',
              'artifact.read',
              'turn.read',
              'evidence.runtime-list',
              'agent.list',
              'knowledge.ask',
              'knowledge.tell',
              'vault.injection-plan-list',
              'vault.injection-receipt-list',
              'vault.binding-deliver',
              'vault.binding-replace',
              'vault.binding-revoke',
            ],
          ].sort()
        );
        // The real live Goal/Coordinator Turn above grants no human Login material entry.
        expect(tools.map((tool) => tool.name)).not.toContain('vault.bootstrap-codex-auth');
        const acquisition = createOperationInvocation({
          coreDb: f.coreDb,
          store: f.store,
          inflightCommands: new WeakMap(),
          workspaceMutationAdmission: new WorkspaceMutationAdmission(),
        });
        const acquisitionHttp = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
          throw new Error('Coordinator acquisition crossed the human-only refusal.');
        });
        try {
          await expect(
            acquisition(
              'vault.bootstrap-codex-auth',
              { authJsonBase64: 'e30=' },
              {
                kind: 'coordinator',
                actor: { kind: 'local', userId: 'usr_00000000-0000-7000-8000-000000000001' },
                workspaceId: goal.workspaceId,
                threadId: goal.threadId,
                goalId: goal.goalId,
                turnId: turn.id,
                requestId: randomUUID(),
              }
            )
          ).rejects.toMatchObject({ code: 'workspace_access_denied', status: 403 });
          expect(acquisitionHttp).not.toHaveBeenCalled();
        } finally {
          acquisitionHttp.mockRestore();
        }
        const read = await tools.find((tool) => tool.name === 'goal.read')!.execute({});
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
        release.resolve();
        try {
          await shutdownControlStoreWorkerClient();
          const current = readGoalView(f.store, db, goal.goalId).goal!;
          expect(current.consideredRevision).toBe(current.changeRevision);
          for (const completed of f.store.listThreadTurns(goal.workspaceId, goal.threadId))
            expect(completed).toMatchObject({ status: 'completed', error: null });
        } finally {
          db.sqlite.close();
        }
      }
    } finally {
      release.resolve();
      try {
        await shutdownControlStoreWorkerClient();
      } finally {
        f.coreDb.sqlite.close();
      }
    }
  });
  it('preserves read-only, wrong-audience and revocation refusals before Goal effects', async () => {
    const f = await operationFixture();
    try {
      const issued = createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
        scope: 'workspace-readonly',
        workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      const readOnly = await publicJourneyProjections(f, issued.secret);
      await expect(
        readOnly.http('goal.create', {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          requestId: randomUUID(),
          intent: 'Denied',
        })
      ).rejects.toMatchObject({ code: 'workspace_access_denied' });
      const foreign = await f.store.createThread(
        'ws_00000000-0000-7000-8000-000000000001',
        'Private',
        undefined,
        'conversation',
        {
          visibility: 'private',
          privateOwnerUserId: 'usr_00000000-0000-7ed5-9b62-226e0a66887f',
        }
      );
      await expect(
        readOnly.http('goal.read', {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: foreign.id,
        })
      ).rejects.toMatchObject({ code: 'not_found' });
      revokeOpenKitAccessTokenRecord(f.coreDb, issued.record.tokenId);
      await expect(
        readOnly.http('goal.read', {
          workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
          threadId: 'th_00000000-0000-7000-8000-000000000001',
        })
      ).rejects.toMatchObject({ code: expect.any(String) });
    } finally {
      f.coreDb.sqlite.close();
    }
  });
});

import { executeGoalOperation, readGoalView } from './runtime/goal-owner.js';
import { readPendingRequest } from './runtime/pending-requests.js';

it('discloses and grants a Coordinator proposal to the current administrator without membership, retaining actual attribution and refusing revoked consumption', async () => {
  const f = await operationFixture({ mode: 'server' });
  const db = openWorkspaceDb(f.command.dataRoot, 'ws_00000000-0000-7000-8000-000000000001');
  applyScopedMigrations(db, undefined, 'pre-knowledge');
  try {
    const { user: administrator } = await createBetterAuth(f.coreDb, { env: {} }).api.signUpEmail({
      body: {
        name: 'Proposal administrator',
        email: [randomUUID(), 'example.invalid'].join('@'),
        password: randomUUID(),
      },
    });
    const issued = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: administrator.id,
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const context = {
      actor: { kind: 'local' as const, userId: 'usr_00000000-0000-7000-8000-000000000001' },
    };
    const created = await executeGoalOperation(
      'goal.create',
      {
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
        requestId: randomUUID(),
        intent: 'Review design',
      },
      context,
      f.store,
      db
    );
    const goal = created.goal!;
    const scope = {
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      threadId: goal.threadId,
      goalId: goal.goalId,
    };
    const turn = await f.store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      goal.threadId,
      'Coordinate',
      { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
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
        goalDomain: testGoalDomainProposal(scope.workspaceId, scope.goalId),
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
    expect(
      resolveWorkspaceMembershipRelation(f.coreDb, scope.workspaceId, administrator.id)
    ).toBeNull();
    const disclosed = (await admin.client(
      'goal.read',
      scope
    )) as import('@openkit/app-api-schemas').GoalView;
    expect(disclosed.requests[0]).toMatchObject({
      requestId: request.requestId,
      exactIntent: request.exactIntent,
    });
    const resolved = (await admin.client('goal.plan.approve', {
      ...scope,
      requestId: randomUUID(),
      pendingRequestId: request.requestId,
      decision: 'granted',
    })) as import('@openkit/app-api-schemas').GoalView;
    expect(resolved.requests[0]).toMatchObject({
      decidingActorId: administrator.id,
      claim: 'unclaimed',
      disposition: null,
    });
    const originalBinding = {
      workspaceId: scope.workspaceId,
      threadId: goal.threadId,
      raisingTurnId: turn.id,
      requesterKind: 'coordinator',
      responsibleUserId: context.actor.userId,
      governedIntent: request.exactIntent,
      decidingActor: { kind: 'user', id: administrator.id },
      decidingActorContext: {
        kind: 'token',
        userId: administrator.id,
        tokenId: issued.record.tokenId,
      },
    };
    expect(readPendingRequest(db.sqlite, request.requestId)).toMatchObject({
      ...originalBinding,
      claim: 'unclaimed',
      disposition: null,
    });
    expect(resolved.goal!.activePlanVersionId).toBeNull();
    // Exercise current authority at the Goal owner boundary before terminal hooks admit delivery.
    // The original live Coordinator binding remains valid; no competing consumer is created.
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
    expect(readPendingRequest(db.sqlite, request.requestId)).toMatchObject({
      ...originalBinding,
      claim: 'unclaimed',
      disposition: 'denied-not-executed',
      executionCallId: null,
    });
    const after = readGoalView(f.store, db, goal.goalId);
    expect(after.goal!.activePlanVersionId).toBeNull();
    expect(after.versions).toEqual(proposed.versions);
    expect(after.tasks).toEqual([]);
    expect(
      resolveWorkspaceMembershipRelation(f.coreDb, scope.workspaceId, administrator.id)
    ).toBeNull();
  } finally {
    db.sqlite.close();
    f.coreDb.sqlite.close();
  }
});

/** Isolates generic private invocation while retaining real current admission and Turn owners. */
async function privateEngineFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'private-native-operation-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = await createDemoStore({ dataRoot });
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  });
  const thread = await store.createThread(
    'ws_00000000-0000-7000-8000-000000000001',
    'Private operation',
    undefined,
    'conversation',
    {
      visibility: 'private',
      privateOwnerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    }
  );
  const turn = await store.createTurn(
    'ws_00000000-0000-7000-8000-000000000001',
    thread.id,
    'Private read',
    {
      kind: 'user',
      id: 'usr_00000000-0000-7000-8000-000000000001',
    }
  );
  const controller = new AbortController();
  const context: AssistantOperationInvocationContext = {
    kind: 'assistant-command',
    entryScope: 'conversation.submit',
    actor: { kind: 'local', userId: 'usr_00000000-0000-7000-8000-000000000001' },
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    threadId: thread.id,
    turnId: turn.id,
    requestId: randomUUID(),
    signal: controller.signal,
  };
  const definitions = {
    'probe.read': {
      binding: 'internal',
      entryScope: 'conversation.submit',
      description: 'Read a bounded fixture value.',
      inputSchema: z.object({ value: z.string().default('default') }).strict(),
      outputSchema: z.object({ echo: z.string() }).strict(),
      policyOperation: 'workspace.read',
      mutating: false,
    },
  } as const;
  const handler = vi.fn(
    async (input: { value: string }, _context: AssistantOperationInvocationContext) => ({
      echo: input.value,
    })
  );
  const invoke = createInternalOperationEngine(
    definitions,
    { 'probe.read': handler },
    { coreDb, store },
    context
  );
  return {
    dataRoot,
    coreDb,
    store,
    context,
    controller,
    handler,
    invoke,
    close: () => {
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

describe('#144 private native invocation and public exclusion', () => {
  it('executes a definition-authored private key without Skill-specific dispatch and parses its defaults', async () => {
    const f = await privateEngineFixture();
    try {
      expect(await f.invoke('probe.read', {}, f.context)).toEqual({ echo: 'default' });
      expect(f.handler).toHaveBeenCalledOnce();
      expect(f.handler).toHaveBeenCalledWith(
        { value: 'default' },
        expect.objectContaining({ ...f.context, signal: expect.any(AbortSignal) })
      );
    } finally {
      f.close();
    }
  });

  it.each([
    null,
    { value: 7 },
    { unexpected: true },
  ])('rejects invalid logical input %j before private handler dispatch', async (input) => {
    const f = await privateEngineFixture();
    try {
      await expect(f.invoke('probe.read', input, f.context)).rejects.toMatchObject({
        code: 'invalid_request',
        status: 400,
      });
      expect(f.handler).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it.each([
    'actor',
    'workspaceId',
    'threadId',
    'turnId',
    'entryScope',
    'requestId',
    'signal',
  ] as const)('rejects caller-bound %s even when equal to trusted context', async (field) => {
    const f = await privateEngineFixture();
    try {
      await expect(
        f.invoke('probe.read', { [field]: f.context[field] }, f.context)
      ).rejects.toMatchObject({ code: 'bound_input_conflict', status: 403 });
      expect(f.handler).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it('validates logical output before returning from native invocation', async () => {
    const f = await privateEngineFixture();
    f.handler.mockResolvedValueOnce({ echo: 7 } as unknown as { echo: string });
    try {
      await expect(f.invoke('probe.read', {}, f.context)).rejects.toMatchObject({
        code: 'invalid_operation_output',
        status: 500,
      });
      expect(f.handler).toHaveBeenCalledOnce();
    } finally {
      f.close();
    }
  });

  it.each([
    'before',
    'during',
  ] as const)('preserves cancellation %s the private handler and returns no late success', async (when) => {
    const f = await privateEngineFixture();
    const stopped = new Error('Fixture cancellation.');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    if (when === 'before') f.controller.abort(stopped);
    else
      f.handler.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return { echo: 'late-success-canary' };
      });
    const pending = f.invoke('probe.read', {}, f.context);
    try {
      if (when === 'during') {
        await entered.promise;
        f.controller.abort(stopped);
        release.resolve();
      }
      await expect(pending).rejects.toBe(stopped);
      expect(f.handler).toHaveBeenCalledTimes(when === 'before' ? 0 : 1);
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
      f.close();
    }
  });

  it('omits the private operation from public definitions, HTTP, OpenAPI, Core Client and CLI', async () => {
    const f = await operationFixture();
    try {
      expect(Object.keys(OPERATION_DEFINITIONS)).not.toContain('skill.read');
      expect(getRegisteredAppApiOperationIds(f.app)).not.toContain('skill.read');
      expect(JSON.stringify(createAppOpenApiDocument())).not.toContain('skill.read');
      const client = createCoreClient({ baseUrl: 'http://nanocore.test' });
      expect(Object.keys(client.operations)).not.toContain('skill.read');
      const cliModule = new URL('../../../skills/openkit-operations.mjs', import.meta.url).href;
      const { operationCatalog } = await import(cliModule);
      expect(operationCatalog.map((row: { id: string }) => row.id)).not.toContain('skill.read');
      const response = await f.app.request('/api/app/operations/skill.read', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ skillId: 'alpha' }),
      });
      expect(response.status).toBe(404);
      const touched = vi.fn();
      const invoke = createOperationEngine(
        new Proxy({}, { get: touched }) as OperationImplementations,
        new Proxy({}, { get: touched }) as OperationAdmissionDependencies
      );
      await expect(
        invoke(
          'skill.read' as JsonOperationId,
          {},
          {
            kind: 'public',
            actor: { kind: 'local', userId: 'usr_00000000-0000-7000-8000-000000000001' },
          }
        )
      ).rejects.toMatchObject({ code: 'unsupported_operation', status: 400 });
      expect(touched).not.toHaveBeenCalled();
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('omits and refuses the private operation in remote MCP discovery and invocation', async () => {
    const f = await operationFixture();
    const token = createOpenKitAccessTokenRecord(f.coreDb, {
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const request = async (name: string, args: Record<string, unknown>) => {
      const response = await f.app.request('/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token.secret}`,
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: randomUUID(),
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    try {
      const found = await request('search', { query: 'skill.read' });
      expect(JSON.stringify(found)).not.toContain('skill.read');
      for (const name of ['describe', 'call']) {
        const result = await request(name, {
          operation: 'skill.read',
          ...(name === 'call' ? { input: {} } : {}),
        });
        expect(result.result.isError).toBe(true);
        expect(JSON.parse(result.result.content[0].text)).toMatchObject({
          code: 'unsupported_operation',
        });
      }
    } finally {
      f.coreDb.sqlite.close();
    }
  });

  it('omits and refuses the private operation through the real supplied Worker MCP projection', async () => {
    const f = await operationFixture();
    try {
      const { mcp } = await operationProjections(f);
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
      expect(listed.result.tools).not.toContainEqual(
        expect.objectContaining({ name: 'skill_read' })
      );
      expect(Object.values(OPENKIT_GENERATIVE_TOOL_OPERATIONS)).not.toContain('skill.read');
      const called = await request('tools/call', {
        name: 'skill_read',
        arguments: { skillId: 'alpha' },
      });
      expect(called.error).toBeDefined();
    } finally {
      f.coreDb.sqlite.close();
    }
  });
});

// Drain and stop the native fixture owner before the next test can remove or reuse its roots.
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
});

/** The fixed-User definitions drive every public framing while Worker User entry remains unavailable. */
describe('personal Login operation projections', () => {
  it.each([
    'vault.login-list',
    'vault.login-quarantine',
    'vault.login-release',
  ])('projects %s through OpenAPI and the uniform Skill without advertising Worker admission', async (id) => {
    const definition = Reflect.get(OPERATION_DEFINITIONS, id);
    expect(
      definition,
      'O13 expected baseline RED: missing Login operation definition'
    ).toBeDefined();
    expect(definition).toMatchObject({
      binding: 'json',
      returnsOneTimeSecret: false,
      scope: { kind: 'user' },
      target: { kind: 'user' },
      policyOperation: 'vault.admin',
      mutating: id !== 'vault.login-list',
    });
    expect(definition.credentials).not.toContain('worker-package');
    expect(definition.credentials).not.toContain('coordinator');
    expect(createAppOpenApiDocument().paths).toHaveProperty(`/api/app/operations/${id}`);
    const { operationCatalog } = await import(
      new URL('../../../skills/openkit-operations.mjs', import.meta.url).href
    );
    const operation = operationCatalog.find((entry: { id: string }) => entry.id === id);
    expect(operation).toBeDefined();
    expect(operation.appOperationId).toBe(id);
    expect(operation.mutating).toBe(id !== 'vault.login-list');
    const input =
      id === 'vault.login-list' ? {} : { referenceId: testEntityId('vault', 'login-projection') };
    expect(operation.inputSchema.parse(input)).toEqual(input);
    for (const field of [
      'material',
      'backendLocator',
      'accountId',
      'userId',
      'actor',
      'quarantined',
    ])
      expect(operation.inputSchema.safeParse({ ...input, [field]: 'synthetic' }).success).toBe(
        false
      );
    const output =
      id === 'vault.login-list'
        ? { items: [] }
        : {
            referenceId: input.referenceId,
            provider: 'codex',
            currentVersion: 1,
            status: 'active',
            quarantined: id === 'vault.login-quarantine',
            observations: null,
          };
    const forward = vi.fn(async () => output);
    expect(await operation.handler({ client: { operations: { [id]: forward } } }, input)).toBe(
      output
    );
    expect(forward).toHaveBeenCalledExactlyOnceWith(input);
    expect(OPENKIT_GENERATIVE_TOOL_OPERATIONS).not.toHaveProperty(
      operationToolName(id as JsonOperationId)
    );
  });

  it('preserves reference-only unknown observations through real HTTP, Core Client, CLI and remote MCP calls', async () => {
    for (const id of ['vault.login-list', 'vault.login-quarantine', 'vault.login-release'])
      expect(Object.hasOwn(OPERATION_DEFINITIONS, id)).toBe(true);
    const f = await operationFixture();
    try {
      const { createVaultReference } = await import('./vault/vault-references.js');
      const input = {
        referenceId: testEntityId('vault', 'login-uniform-journey'),
        ownerScope: 'user' as const,
        userId: ensureLocalUser(f.coreDb),
        displayName: 'Private uniform Login label',
        secretKind: 'opaque',
        backendKind: 'encrypted-file' as const,
        backendLocator: 'synthetic-private-uniform-locator',
        login: {
          provider: 'codex' as const,
          accountId: 'synthetic-private-uniform-account',
          quarantined: false,
        },
      };
      const reference = await createVaultReference(f.coreDb, input);
      expect(
        reference,
        'O1 prerequisite must succeed before this can decide public behavior'
      ).toMatchObject({ login: input.login });
      const projections = await publicJourneyProjections(f);
      const issued = createOpenKitAccessTokenRecord(f.coreDb, {
        ownerUserId: input.userId,
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: '2999-01-01T00:00:00.000Z',
      });
      const remote = async (operation: string, value: Record<string, unknown>) => {
        const response = await f.app.request('/mcp', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${issued.secret}`,
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: randomUUID(),
            method: 'tools/call',
            params: { name: 'openkit_call', arguments: { operation, input: value } },
          }),
        });
        expect(response.status).toBe(200);
        const envelope = (await response.json()) as {
          result: { isError?: boolean; content: Array<{ text: string }> };
        };
        expect(envelope.result.isError).not.toBe(true);
        return JSON.parse(envelope.result.content[0]!.text) as unknown;
      };
      for (const call of [...Object.values(projections), remote]) {
        const view = {
          referenceId: reference.referenceId,
          provider: 'codex',
          status: 'active',
          currentVersion: 1,
          quarantined: false,
          observations: null,
        };
        await expect(call('vault.login-list', {})).resolves.toEqual({ items: [view] });
        await expect(
          call('vault.login-quarantine', { referenceId: reference.referenceId })
        ).resolves.toEqual({ ...view, quarantined: true });
        await expect(
          call('vault.login-release', { referenceId: reference.referenceId })
        ).resolves.toEqual(view);
      }
    } finally {
      f.coreDb.sqlite.close();
    }
  });
});

it('refuses fixed-User Login operations on the existing real Worker package projection without metadata effects', async () => {
  for (const id of ['vault.login-list', 'vault.login-quarantine', 'vault.login-release'])
    expect(Object.hasOwn(OPERATION_DEFINITIONS, id)).toBe(true);
  const f = await operationFixture();
  try {
    const { createVaultReference, getVaultReference } = await import('./vault/vault-references.js');
    const input = {
      referenceId: testEntityId('vault', 'login-worker-refusal'),
      ownerScope: 'user' as const,
      userId: ensureLocalUser(f.coreDb),
      displayName: 'Worker refusal Login',
      secretKind: 'opaque',
      backendKind: 'encrypted-file' as const,
      login: {
        provider: 'codex' as const,
        accountId: 'synthetic-worker-refusal-account',
        quarantined: false,
      },
    };
    const login = await createVaultReference(f.coreDb, input);
    expect(login, 'O1 prerequisite before Worker projection checks').toMatchObject({
      login: input.login,
    });
    const { projections } = await operationProjections(f);
    for (const id of ['vault.login-list', 'vault.login-quarantine', 'vault.login-release']) {
      await expect(
        projections.worker!(
          id as KernelOperationId,
          id === 'vault.login-list' ? {} : { referenceId: login.referenceId }
        )
      ).rejects.toBeDefined();
      expect(getVaultReference(f.coreDb, login.referenceId)).toEqual(login);
    }
  } finally {
    f.coreDb.sqlite.close();
  }
});

it('declares the real deterministic reviewed issue gate and non-decisive completed observation', async () => {
  // Core Mediation, Enforcement Points: declaration and implementation must describe the same crossing.
  const { policyOperationDefinition } = await import('./policy/statements.js');
  const definition = OPERATION_DEFINITIONS['vault.grant-issue'];
  expect(definition).toMatchObject({
    scope: { kind: 'body-workspace', field: 'workspaceId' },
    target: { kind: 'addressed-thread', threadField: 'threadId', missing: 'not-found' },
    policyOperation: 'vault.admin',
    mutating: true,
    insertionPoints: {
      stages: expect.arrayContaining(['decide', 'completed']),
      modes: expect.arrayContaining(['gate', 'observe']),
      participantKinds: ['deterministic'],
      gateResults: expect.arrayContaining(['allow', 'deny']),
      gateFailures: ['error'],
    },
  });
  const adapted = policyOperationDefinition('vault.grant-issue');
  expect(adapted.points.stages).toEqual(expect.arrayContaining(['decide', 'completed']));
  expect(adapted.points.modes).toEqual(expect.arrayContaining(['gate', 'observe']));
  expect(adapted.points.modes).toHaveLength(2);
  expect(adapted.points.gateResults).toHaveLength(2);
  expect(adapted.points.participantKinds).toEqual(['deterministic']);
});

// Operation Definition, Inputs: trusted approved lineage is never a public authority selector.
it('refuses caller-selected mediated decision lineage at the existing issue input boundary', () => {
  const definition = OPERATION_DEFINITIONS['vault.grant-issue'];
  const input = {
    workspaceId: testEntityId('ws', 'reviewed-issue-lineage-input'),
    threadId: testEntityId('th', 'reviewed-issue-lineage-input'),
    approvalRequestId: randomUUID(),
  };
  expect(definition.inputSchema.safeParse(input).success).toBe(true);
  expect(
    definition.inputSchema.safeParse({
      ...input,
      decisionLineage: { requestId: input.approvalRequestId, approvalId: input.approvalRequestId },
    }).success
  ).toBe(false);
});

/** Actual package HTTP projection, not a fake successful implementation or fabricated retained User state. */
it('keeps human acquisition absent from the real Worker Tool surface before any provider contact', async () => {
  const f = await operationFixture();
  const http = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('Human acquisition must not contact an upstream from Worker entry.');
  });
  try {
    const { projections, mcp } = await operationProjections(f);
    const listed = await mcp.request('/api/worker-capabilities/mcp/openkit-generative', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer private-test-capability',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/list' }),
    });
    expect(listed.status).toBe(200);
    const listing = await listed.json();
    expect(listing.error).toBeUndefined();
    expect(listing.result.tools.length).toBeGreaterThan(0);
    expect(listing.result.tools.map((tool: { name: string }) => tool.name)).not.toContain(
      operationToolName('vault.bootstrap-codex-auth')
    );
    const beforeReferences = f.coreDb.sqlite.prepare('SELECT * FROM vault_references').all();
    const beforeGrants = f.coreDb.sqlite.prepare('SELECT * FROM vault_grants').all();
    expect(OPENKIT_GENERATIVE_TOOL_OPERATIONS).not.toHaveProperty(
      operationToolName('vault.bootstrap-codex-auth')
    );
    await expect(
      projections.worker!('vault.bootstrap-codex-auth', { authJsonBase64: 'e30=' })
    ).rejects.toBeDefined();
    expect(http).not.toHaveBeenCalled();
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_references').all()).toEqual(
      beforeReferences
    );
    expect(f.coreDb.sqlite.prepare('SELECT * FROM vault_grants').all()).toEqual(beforeGrants);
  } finally {
    http.mockRestore();
    await shutdownControlStoreWorkerClient();
    f.coreDb.sqlite.close();
  }
});
