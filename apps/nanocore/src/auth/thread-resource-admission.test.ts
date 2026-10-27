import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KERNEL_REMAINING_OPERATION_DEFINITIONS,
  RESOURCE_POLICY_OPERATION_DEFINITIONS,
} from '@openkit/app-api-schemas';
import { WORKSPACE_RESOURCE_POLICY_FEATURE, WorkspaceConfigSchema } from '@openkit/config-schema';
import * as policyKernel from '@openkit/policy-kernel';
import { allocateEntityId } from '@openkit/protocol';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from '../config/runtime-config.js';
import { FsStore } from '../lib/store.js';
import { admitOperation } from '../operation-resolvers.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createApp } from '../test-support/app.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { managedThreadPolicy } from '../test-support/resource-policy.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import type { AuthVariables } from './middleware.js';
import { registerOperationAccessGuards } from './operation-authorizer.js';

describe('managed Thread native admission', () => {
  it('preserves concrete operation restrictions and excludes a revoked Thread from shared lists', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'resource-native-admission-'));
    const db = openCoreDb(dataRoot);
    applyMigrations(db);
    ensureLocalUser(db);
    const store = new FsStore({ dataRoot });
    const workspace = await store.createWorkspace('Managed admission');
    recordWorkspaceOwnerMembership({
      coreDb: db,
      workspaceId: workspace.id,
      ownerUserId: FIXTURE_LOCAL_USER_ID,
    });
    const thread = await store.createThread(workspace.id, 'Managed');
    const ordinary = await store.createThread(workspace.id, 'Ordinary');
    const config = WorkspaceConfigSchema.parse({
      schemaVersion: 1,
      requiredFeatures: [WORKSPACE_RESOURCE_POLICY_FEATURE],
      workspace: {
        name: workspace.name,
        policy: {
          mediation: managedThreadPolicy({
            workspaceId: workspace.id,
            threadId: thread.id,
            userId: FIXTURE_LOCAL_USER_ID,
            operations: ['thread.read'],
          }),
        },
      },
    });
    const manager = createRuntimeConfigManager({
      dataRoot,
      initialSnapshot: createInMemoryRuntimeConfigSnapshot({
        dataRoot,
        workspaceConfigs: [
          {
            workspaceId: workspace.id,
            path: join(dataRoot, 'workspaces', workspace.id, 'config/workspace.jsonc'),
            config,
          },
        ],
      }),
    });
    const app = createApp({ dataRoot, coreDb: db, store, runtimeConfigManager: manager });
    try {
      const retained = new Hono<{ Variables: AuthVariables }>();
      retained.use('*', async (context, next) => {
        context.set('actor', { kind: 'local', userId: FIXTURE_LOCAL_USER_ID });
        await next();
      });
      registerOperationAccessGuards({
        app: retained,
        coreDb: db,
        store,
        quickChatWorkspaceIdForUser: () => workspace.id,
        workspaceMutationAdmission: new WorkspaceMutationAdmission(),
      });
      retained.get('/api/workspaces/:workspaceId/threads/:threadId/events', (context) =>
        context.json({ admitted: true })
      );
      expect(
        (await retained.request(`/api/workspaces/${workspace.id}/threads/${thread.id}/events`))
          .status
      ).toBe(200);
      expect(
        (
          await app.request(
            ...operationRequest('thread.read', { workspaceId: workspace.id, threadId: thread.id })
          )
        ).status
      ).toBe(200);
      const denied = await app.request(
        ...operationRequest(
          'thread.update',
          {
            workspaceId: workspace.id,
            threadId: thread.id,
          },
          { body: JSON.stringify({ requestId: randomUUID(), name: 'Forbidden mutation' }) }
        )
      );
      expect(denied.status).toBe(404);
      expect(store.getThread(workspace.id, thread.id).name).toBe('Managed');
      const policy = manager.current().workspaceConfigs[0]!.config.workspace.policy!.mediation;
      policy.statements = policy.statements.filter(
        (statement) => statement.kind === 'managed-boundary'
      );
      expect(
        (
          await app.request(
            ...operationRequest('thread.read', { workspaceId: workspace.id, threadId: thread.id })
          )
        ).status
      ).toBe(404);
      const list = await app.request(
        ...operationRequest('thread.list', { workspaceId: workspace.id })
      );
      expect(list.status).toBe(200);
      expect((await list.json()).items.map((item: { id: string }) => item.id)).toEqual([
        ordinary.id,
      ]);
    } finally {
      db.sqlite.close();
      await shutdownControlStoreWorkerClient();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});

it('preserves the exact admitted Worker Agent in concrete Thread resource decisions', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'resource-worker-admission-'));
  const db = openCoreDb(dataRoot);
  applyMigrations(db);
  ensureLocalUser(db);
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Worker policy');
  recordWorkspaceOwnerMembership({
    coreDb: db,
    workspaceId: workspace.id,
    ownerUserId: FIXTURE_LOCAL_USER_ID,
  });
  const thread = await store.createThread(workspace.id, 'Worker resource');
  const actor = { kind: 'user' as const, id: FIXTURE_LOCAL_USER_ID };
  const agentSessionId = allocateEntityId('as');
  const timestamp = new Date().toISOString();
  await store.createAgentSession({
    id: agentSessionId,
    agentId: 'researcher',
    workspaceId: workspace.id,
    threadId: thread.id,
    status: 'busy',
    message: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const turn = await store.createTurn(workspace.id, thread.id, 'Request access', actor, null, {
    agentId: 'researcher',
    agentSessionId,
  });
  const entry = createSchedulerAdmissionEntry(db, {
    backendId: 'nanohost',
    queueEntryId: randomUUID(),
    triggerActor: actor,
    serverAdminTokenId: null,
    workspaceId: workspace.id,
    threadId: thread.id,
    turnId: turn.id,
    turnInput: 'Request access',
    requestedAgentId: 'researcher',
  });
  const packageSnapshotId = 'resource-policy-worker-snapshot';
  recordTestExecutionAttempt(db, {
    entry,
    attemptId: allocateEntityId('attempt'),
    agentSessionId,
    inputRef: packageSnapshotId,
    bindingRef: 'resource-policy-worker-binding',
    sessionCompatibilityKey: 'resource-policy-worker-session',
    now: () => new Date().toISOString(),
  });
  store.setWorkspaceResourcePolicyProjection(() =>
    managedThreadPolicy({
      workspaceId: workspace.id,
      threadId: thread.id,
      userId: actor.id,
      agentId: 'researcher',
      operations: ['workspace.write'],
    })
  );
  const requestId = randomUUID();
  const kernel = vi.spyOn(policyKernel, 'evaluateAccess');
  try {
    const admitted = await admitOperation(
      RESOURCE_POLICY_OPERATION_DEFINITIONS['workspace.resource-access-request'],
      {
        workspaceId: workspace.id,
        threadId: thread.id,
        requestId,
        change: { resource: { family: 'thread', id: thread.id }, replacement: null },
      },
      {
        kind: 'worker',
        actor,
        lineage: {
          workspaceId: workspace.id,
          threadId: thread.id,
          turnId: turn.id,
          agentSessionId,
          packageSnapshotId,
        },
        requestId,
        bindings: { workspaceId: workspace.id, threadId: thread.id, requestId },
      },
      { coreDb: db, store, workspaceMutationAdmission: new WorkspaceMutationAdmission() }
    );
    admitted.release?.();
    expect(kernel.mock.calls.map(([, request]) => request)).toContainEqual(
      expect.objectContaining({
        target: expect.stringContaining(thread.id),
        process: agentSessionId,
        operation: 'workspace.write',
      })
    );
    const lightAppInput = {
      workspaceId: workspace.id,
      appId: randomUUID(),
      collection: 'notes',
      recordId: randomUUID(),
      schemaRevision: 1,
    };
    const worker = {
      kind: 'worker' as const,
      actor,
      lineage: {
        workspaceId: workspace.id,
        threadId: thread.id,
        turnId: turn.id,
        agentSessionId,
        packageSnapshotId,
      },
      requestId,
      bindings: { workspaceId: workspace.id },
    };
    store.setWorkspaceResourcePolicyProjection(() =>
      managedThreadPolicy({
        workspaceId: workspace.id,
        threadId: thread.id,
        userId: actor.id,
        agentId: 'researcher',
        operations: ['workspace.read'],
      })
    );
    kernel.mockClear();
    const lightApp = await admitOperation(
      KERNEL_REMAINING_OPERATION_DEFINITIONS['kernel.records.get'],
      lightAppInput,
      worker,
      { coreDb: db, store, workspaceMutationAdmission: new WorkspaceMutationAdmission() }
    );
    lightApp.release?.();
    expect(kernel.mock.calls.map(([, request]) => request)).toContainEqual(
      expect.objectContaining({
        target: expect.stringContaining(thread.id),
        process: agentSessionId,
        operation: 'workspace.read',
      })
    );
    store.setWorkspaceResourcePolicyProjection(() =>
      managedThreadPolicy({ workspaceId: workspace.id, threadId: thread.id, userId: actor.id })
    );
    await expect(
      admitOperation(
        KERNEL_REMAINING_OPERATION_DEFINITIONS['kernel.records.get'],
        lightAppInput,
        worker,
        { coreDb: db, store, workspaceMutationAdmission: new WorkspaceMutationAdmission() }
      )
    ).rejects.toThrow('Thread not found.');
  } finally {
    kernel.mockRestore();
    db.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
