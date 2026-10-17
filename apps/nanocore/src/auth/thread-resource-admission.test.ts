import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RESOURCE_POLICY_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
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
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createApp } from '../test-support/app.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import type { AuthVariables } from './middleware.js';
import { registerOperationAccessGuards } from './operation-authorizer.js';

describe('managed Thread native admission', () => {
  it('decides the concrete operation once and excludes a revoked Thread from shared lists', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'resource-native-admission-'));
    const db = openCoreDb(dataRoot);
    applyMigrations(db);
    ensureLocalUser(db);
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Managed admission');
    recordWorkspaceOwnerMembership({
      coreDb: db,
      workspaceId: workspace.id,
      ownerUserId: FIXTURE_LOCAL_USER_ID,
    });
    const thread = store.createThread(workspace.id, 'Managed');
    const ordinary = store.createThread(workspace.id, 'Ordinary');
    const config = WorkspaceConfigSchema.parse({
      requiredFeatures: [WORKSPACE_RESOURCE_POLICY_FEATURE],
      workspace: {
        name: workspace.name,
        policy: {
          resourceAccess: [
            {
              resource: { family: 'thread', id: thread.id },
              grants: [
                {
                  subject: { kind: 'user', userId: FIXTURE_LOCAL_USER_ID },
                  operations: ['thread.read'],
                },
              ],
              prohibitions: [],
            },
          ],
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
    const kernel = vi.spyOn(policyKernel, 'evaluateAccess');
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
      kernel.mockClear();
      expect(
        (await retained.request(`/api/workspaces/${workspace.id}/threads/${thread.id}/events`))
          .status
      ).toBe(200);
      expect(kernel).toHaveBeenCalledTimes(1);
      kernel.mockClear();
      expect(
        (
          await app.request(
            ...operationRequest('thread.read', { workspaceId: workspace.id, threadId: thread.id })
          )
        ).status
      ).toBe(200);
      expect(kernel).toHaveBeenCalledTimes(1);
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
      manager.current().workspaceConfigs[0]!.config.workspace.policy!.resourceAccess[0]!.grants =
        [];
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
      kernel.mockRestore();
      db.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});

it('uses one concrete Kernel decision for an exact admitted Worker Agent', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'resource-worker-admission-'));
  const db = openCoreDb(dataRoot);
  applyMigrations(db);
  ensureLocalUser(db);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Worker policy');
  recordWorkspaceOwnerMembership({
    coreDb: db,
    workspaceId: workspace.id,
    ownerUserId: FIXTURE_LOCAL_USER_ID,
  });
  const thread = store.createThread(workspace.id, 'Worker resource');
  const actor = { kind: 'user' as const, id: FIXTURE_LOCAL_USER_ID };
  const agentSessionId = allocateEntityId('as');
  const turn = store.createTurn(workspace.id, thread.id, 'Request access', actor, null, {
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
  store.setWorkspaceResourcePolicyProjection(() => [
    {
      resource: { family: 'thread', id: thread.id },
      grants: [
        {
          subject: { kind: 'agent', userId: actor.id, agentId: 'researcher' },
          operations: ['workspace.write'],
        },
      ],
      prohibitions: [],
    },
  ]);
  const requestId = randomUUID();
  const kernel = vi.spyOn(policyKernel, 'evaluateAccess');
  try {
    const admitted = admitOperation(
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
    expect(kernel).toHaveBeenCalledTimes(1);
    expect(kernel.mock.calls[0]![1].target).toContain(thread.id);
    expect(kernel.mock.calls[0]![1].process).toBe(agentSessionId);
  } finally {
    kernel.mockRestore();
    db.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
