import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
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
import { createInMemoryRuntimeConfigSnapshot } from './config/runtime-config.js';
import * as commands from './generative-kernel/commands.js';
import { createLightApp, listRecords, updateRecord } from './generative-kernel/commands.js';
import * as invocation from './operation-invocation.js';
import { createOperationInvocation } from './operation-invocation.js';
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
