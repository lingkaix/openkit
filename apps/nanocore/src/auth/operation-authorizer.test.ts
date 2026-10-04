import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ADMINISTRATION_OPERATION_DEFINITIONS,
  OPERATION_DEFINITIONS,
  type OperationDefinition,
  PRODUCT_OPERATION_DEFINITIONS,
} from '@openkit/app-api-schemas';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createBootReadinessSnapshot } from '../bootstrap/readiness.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from '../config/runtime-config.js';
import { AutomationStore } from '../lib/automation-store.js';
import { quickChatWorkspaceIdForUser } from '../lib/store.js';
import type { createConversationService } from '../mode-entry-routes.js';
import { registerOperationJsonRoutes } from '../operation-json-routes.js';
import { registerRemoteMcpRoutes } from '../remote-mcp-routes.js';
import {
  createSchedulerAdmissionEntry,
  createSchedulerPlacementPlan,
  createSchedulerSessionLease,
} from '../scheduler-records.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { operationRequest } from '../test-support/operation-request.js';
import { createWorkerEnvironmentOperations } from '../worker-environments/worker-environment-operations.js';
import {
  createWorkspaceDeletionRequest,
  writeWorkspaceDeletionRequest,
} from '../workspace-deletion-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from './access-token-store.js';
import { type Actor, ensureLocalUser } from './identity.js';
import type { AuthVariables } from './middleware.js';
import * as nanoHostOperations from './nanohost-operations.js';
import { PUBLIC_OPERATION_ACCESS } from './operation-access.js';
import * as operationAuthorizer from './operation-authorizer.js';
import {
  currentScheduledTurnWorkspaceAuthority,
  currentSchedulerAdmissionWorkspaceAuthority,
  currentWorkerLineageWorkspaceAuthority,
  currentWorkspaceAuthority,
  isCanonicalUserOperationAuthorized,
  registerOperationAccessGuards,
} from './operation-authorizer.js';

// Clone the immutable projection only in this test module so a definition fixture can replace its matching access row.
vi.mock('./operation-access.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./operation-access.js')>();
  return { ...actual, PUBLIC_OPERATION_ACCESS: { ...actual.PUBLIC_OPERATION_ACCESS } };
});

/** Creates one real Core membership fixture behind a tiny guarded Hono app. */
function createFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-operation-authorizer-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);

  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  coreDb.sqlite
    .prepare(
      `INSERT INTO users (
        id, display_name, email, email_verified, created_at, updated_at, kind, status
      ) VALUES
        ('user_missing', 'Missing Member', 'missing-member@example.com', false, ?, ?, 'human', 'active'),
        ('user_removed', 'Removed Member', 'removed-member@example.com', false, ?, ?, 'human', 'active'),
        ('user_viewer', 'Viewer Member', 'viewer-member@example.com', false, ?, ?, 'human', 'active'),
        ('user_disabled', 'Disabled Member', 'disabled-member@example.com', false, ?, ?, 'human', 'disabled')`
    )
    .run(now, now, now, now, now, now, now, now);

  const store = createDemoStore({ dataRoot });
  const quickChatWorkspace = store
    .listWorkspaces()
    .find((workspace) => workspace.kind === 'quick-chat');
  const workspace = store.listWorkspaces().find((item) => item.kind === 'code');
  if (!quickChatWorkspace || !workspace) {
    throw new Error('Expected Quick Chat and Demo Workspace fixtures.');
  }

  const foreignWorkspace = store.createWorkspace('Foreign Workspace');
  const filesystemOnlyWorkspace = store.createWorkspace('Filesystem Only Workspace');
  for (const ownedWorkspace of [quickChatWorkspace, workspace, foreignWorkspace]) {
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'user_local',
      workspaceId: ownedWorkspace.id,
    });
  }
  coreDb.sqlite
    .prepare(
      `INSERT INTO workspace_members (
        workspace_id, user_id, status, access_level, invitation_id,
        joined_at, removed_at, revision, created_at, updated_at
      ) VALUES
        (?, 'user_removed', 'removed', 'viewer', NULL, ?, ?, 2, ?, ?),
        (?, 'user_viewer', 'active', 'viewer', NULL, ?, NULL, 1, ?, ?),
        (?, 'user_disabled', 'active', 'editor', NULL, ?, NULL, 1, ?, ?)`
    )
    .run(
      workspace.id,
      timestamp,
      timestamp,
      timestamp,
      timestamp,
      workspace.id,
      timestamp,
      timestamp,
      timestamp,
      workspace.id,
      timestamp,
      timestamp,
      timestamp
    );

  const demoThread = store.listThreads(workspace.id)[0];
  if (!demoThread) {
    throw new Error('Expected the Demo Workspace thread fixture.');
  }
  const turn = store.createTurn(workspace.id, demoThread.id, 'Feedback target', {
    kind: 'user',
    id: 'user_local',
  });
  const foreignThread = store.createThread(foreignWorkspace.id, 'Foreign thread');
  const automationStore = new AutomationStore();
  const actorState: { current: Actor } = {
    current: { kind: 'session', userId: 'user_local' },
  };
  const workspaceMutationAdmission = new WorkspaceMutationAdmission();
  const app = new Hono<{ Variables: AuthVariables }>();
  let administrationHandlerReads = 0;
  let deleteWorkspaceHandlerReads = 0;
  let workspaceDbReads = 0;

  app.use('*', async (c, next) => {
    c.set('actor', actorState.current);
    await next();
  });
  registerOperationAccessGuards({
    app,
    coreDb,
    quickChatWorkspaceIdForUser,
    store,
    workspaceMutationAdmission,
  });

  registerOperationJsonRoutes({
    app,
    coreDb,
    store,
    automationStore,
    workerEnvironmentServices: {
      operations: createWorkerEnvironmentOperations({
        coreDb,
        store,
        runtimeEffects: {
          prepareImage: async () => {
            throw new Error('Not exercised.');
          },
          inspectImage: async () => {
            throw new Error('Not exercised.');
          },
          recoverImageEffect: async () => {
            throw new Error('Not exercised.');
          },
          inspectStorage: async () => {
            throw new Error('Not exercised.');
          },
          purgeStorage: async () => {
            throw new Error('Not exercised.');
          },
        },
      }),
    },
    administrationServices: {
      coreDb,
      quickChatWorkspaceIdForUser,
      mode: 'server',
      inflightCommands: new WeakMap(),
      runtimeConfig: () => {
        administrationHandlerReads += 1;
        return createInMemoryRuntimeConfigSnapshot({ dataRoot });
      },
      runtimeConfigFiles: () => {
        throw new Error('Not exercised.');
      },
      reloadRuntimeConfig: () => {
        throw new Error('Not exercised.');
      },
      resolveGatewayProvider: () => {
        throw new Error('Not exercised.');
      },
      llmGatewayDispatcher: {
        createResponses: async () => {
          throw new Error('Not exercised.');
        },
      },
      environmentToolsForTurn: () => {
        throw new Error('Not exercised.');
      },
    },
    dataRoot,
    repositoryWorkspaceDb: (id) => {
      workspaceDbReads += 1;
      return openWorkspaceDb(dataRoot, id);
    },
    closeWorkspaceMcpSessions: async () => {
      deleteWorkspaceHandlerReads += 1;
    },
    requestStore: () => store,
    workspaceMutationAdmission,
    inflightCommands: new WeakMap(),
    runtimeConfigManager: createRuntimeConfigManager({
      initialSnapshot: createInMemoryRuntimeConfigSnapshot({ dataRoot }),
    }),
    // This fixture tests native admission; the direct provider effect is covered by quick-chat.test.ts.
    conversationService: {
      quick: async (_input, _actor, workspaceId) => ({
        id: 'reply',
        status: 'completed',
        workspaceId,
        modelId: 'model',
        content: 'Hello',
      }),
    } as ReturnType<typeof createConversationService>,
  });
  registerRemoteMcpRoutes({
    app,
    coreDb,
    store,
    requestStore: () => store,
    workspaceMutationAdmission,
    getBootReadiness: createBootReadinessSnapshot,
  });
  app.post('/v1/responses', (c) => c.json(c.get('workspaceAccess') ?? null));

  return {
    actorState,
    app,
    administrationHandlerReads: () => administrationHandlerReads,
    coreDb,
    dataRoot,
    deleteWorkspaceHandlerReads: () => deleteWorkspaceHandlerReads,
    filesystemOnlyWorkspace,
    foreignThread,
    foreignWorkspace,
    quickChatWorkspace,
    store,
    workspaceDbReads: () => workspaceDbReads,
    turn,
    workspace,
    workspaceMutationAdmission,
  };
}

let fixture: ReturnType<typeof createFixture>;

beforeEach(() => {
  fixture = createFixture();
});

afterEach(() => {
  fixture.coreDb.sqlite.close();
});

describe('central Workspace operation authorizer', () => {
  it.each([
    {
      actor: { kind: 'user', id: 'user_local' } as const,
      effectAuthority: true,
      expectedRole: 'owner',
      name: 'active human owner',
      operation: 'runtime.launch',
    },
    {
      actor: {
        kind: 'agent',
        id: 'agent_worker',
        responsibleUserId: 'user_local',
      } as const,
      effectAuthority: true,
      expectedRole: 'owner',
      name: 'responsible non-human actor',
      operation: 'runtime.launch',
    },
    {
      actor: { kind: 'system', id: 'system_worker', responsibleUserId: null } as const,
      effectAuthority: true,
      expectedRole: null,
      name: 'actor without a responsible user',
      operation: 'runtime.launch',
    },
    {
      actor: { kind: 'user', id: 'user_missing' } as const,
      effectAuthority: true,
      expectedRole: null,
      name: 'missing membership',
      operation: 'runtime.launch',
    },
    {
      actor: { kind: 'user', id: 'user_removed' } as const,
      effectAuthority: true,
      expectedRole: null,
      name: 'removed membership',
      operation: 'runtime.launch',
    },
    {
      actor: { kind: 'user', id: 'user_disabled' } as const,
      effectAuthority: true,
      expectedRole: null,
      name: 'disabled responsible user',
      operation: 'runtime.launch',
    },
    {
      actor: { kind: 'user', id: 'user_viewer' } as const,
      effectAuthority: true,
      expectedRole: null,
      name: 'insufficient fixed role',
      operation: 'runtime.launch',
    },
    {
      actor: { kind: 'user', id: 'user_local' } as const,
      effectAuthority: true,
      expectedRole: null,
      name: 'unknown policy operation',
      operation: 'runtime.unregistered',
    },
    {
      actor: { kind: 'user', id: 'user_local' } as const,
      effectAuthority: false,
      expectedRole: null,
      name: 'missing effect authority',
      operation: 'runtime.launch',
    },
  ])('composes current authority for $name', ({
    actor,
    effectAuthority,
    expectedRole,
    operation,
  }) => {
    expect(
      currentWorkspaceAuthority(
        fixture.coreDb,
        fixture.workspace.id,
        actor,
        operation,
        effectAuthority
      )
    ).toBe(expectedRole);
  });

  it('binds a presented admin bearer to its active human owner without member fallback', () => {
    createOpenKitAccessTokenRecord(fixture.coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'user_missing',
      scope: 'server-admin',
      tokenId: 'token_presented_current',
      workspaceIds: [],
    });
    const requestActor = {
      kind: 'token' as const,
      tokenId: 'token_presented_current',
      tokenScope: 'server-admin' as const,
      userId: 'user_missing',
    };
    const authority = (actor: Parameters<typeof currentWorkspaceAuthority>[2]) =>
      currentWorkspaceAuthority(
        fixture.coreDb,
        fixture.workspace.id,
        actor,
        'runtime.launch',
        true,
        requestActor
      );
    expect(authority({ kind: 'user', id: 'user_missing' })).toBe('owner');
    expect(authority({ kind: 'user', id: 'user_local' })).toBeNull();
    expect(
      authority({ kind: 'automation', id: 'automation_1', responsibleUserId: 'user_local' })
    ).toBeNull();
    fixture.coreDb.sqlite
      .prepare(
        "UPDATE openkit_access_tokens SET status = 'revoked', revoked_at = ? WHERE token_id = ?"
      )
      .run(new Date().toISOString(), 'token_presented_current');
    expect(authority({ kind: 'user', id: 'user_missing' })).toBeNull();
    createOpenKitAccessTokenRecord(fixture.coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'user_local',
      scope: 'server-admin',
      tokenId: 'token_presented_member',
      workspaceIds: [],
    });
    fixture.coreDb.sqlite
      .prepare(
        "UPDATE openkit_access_tokens SET status = 'revoked', revoked_at = ? WHERE token_id = ?"
      )
      .run(new Date().toISOString(), 'token_presented_member');
    expect(
      currentWorkspaceAuthority(
        fixture.coreDb,
        fixture.workspace.id,
        { kind: 'user', id: 'user_local' },
        'runtime.launch',
        true,
        { ...requestActor, tokenId: 'token_presented_member', userId: 'user_local' }
      )
    ).toBeNull();
  });

  it('revalidates the recorded administrator token instead of falling back to membership', () => {
    createOpenKitAccessTokenRecord(fixture.coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'user_local',
      scope: 'server-admin',
      tokenId: 'token_admin_admission',
      workspaceIds: [],
    });
    const admission = {
      workspaceId: fixture.workspace.id,
      triggerActor: { kind: 'user', id: 'user_local' } as const,
      serverAdminTokenId: 'token_admin_admission',
    };
    expect(
      currentSchedulerAdmissionWorkspaceAuthority(fixture.coreDb, admission, 'runtime.launch', true)
    ).toBe('owner');
    expect(
      currentSchedulerAdmissionWorkspaceAuthority(
        fixture.coreDb,
        { ...admission, serverAdminTokenId: '' },
        'runtime.launch',
        true
      )
    ).toBeNull();
    fixture.coreDb.sqlite
      .prepare(
        "UPDATE openkit_access_tokens SET status = 'revoked', revoked_at = ? WHERE token_id = ?"
      )
      .run(new Date().toISOString(), 'token_admin_admission');
    expect(
      currentSchedulerAdmissionWorkspaceAuthority(fixture.coreDb, admission, 'runtime.launch', true)
    ).toBeNull();
    expect(
      currentSchedulerAdmissionWorkspaceAuthority(
        fixture.coreDb,
        { ...admission, serverAdminTokenId: null },
        'runtime.launch',
        true
      )
    ).toBe('owner');
    fixture.coreDb.sqlite
      .prepare(
        "UPDATE openkit_access_tokens SET status = 'active', revoked_at = NULL, scope = 'workspace' WHERE token_id = ?"
      )
      .run('token_admin_admission');
    expect(
      currentSchedulerAdmissionWorkspaceAuthority(fixture.coreDb, admission, 'runtime.launch', true)
    ).toBeNull();
  });

  it('rejects expired, wrong-owner, disabled-user, and non-human administrator provenance', () => {
    for (const [tokenId, ownerUserId, triggerUserId, expiresAt] of [
      ['token_admin_expired', 'user_missing', 'user_missing', '2000-01-01T00:00:00.000Z'],
      ['token_admin_wrong_owner', 'user_local', 'user_missing', '2099-01-01T00:00:00.000Z'],
      ['token_admin_disabled', 'user_disabled', 'user_disabled', '2099-01-01T00:00:00.000Z'],
    ] as const) {
      createOpenKitAccessTokenRecord(fixture.coreDb, {
        expiresAt,
        ownerUserId,
        scope: 'server-admin',
        tokenId,
        workspaceIds: [],
      });
      expect(
        currentSchedulerAdmissionWorkspaceAuthority(
          fixture.coreDb,
          {
            workspaceId: fixture.workspace.id,
            triggerActor: { kind: 'user', id: triggerUserId },
            serverAdminTokenId: tokenId,
          },
          'runtime.launch',
          true
        )
      ).toBeNull();
    }
    expect(
      currentSchedulerAdmissionWorkspaceAuthority(
        fixture.coreDb,
        {
          workspaceId: fixture.workspace.id,
          triggerActor: { kind: 'automation', id: 'automation_1', responsibleUserId: 'user_local' },
          serverAdminTokenId: 'token_admin_wrong_owner',
        },
        'runtime.launch',
        true
      )
    ).toBeNull();
  });

  it('binds worker authority to the exact durable lease and package actor', () => {
    createOpenKitAccessTokenRecord(fixture.coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'user_missing',
      scope: 'server-admin',
      tokenId: 'token_admin_worker',
      workspaceIds: [],
    });
    createSchedulerAdmissionEntry(fixture.coreDb, {
      queueEntryId: 'queue_worker_admin',
      triggerActor: { kind: 'user', id: 'user_missing' },
      serverAdminTokenId: 'token_admin_worker',
      workspaceId: fixture.workspace.id,
      threadId: fixture.turn.threadId,
      turnId: 'turn_worker_admin',
      turnInput: 'Run worker',
      requestedAgentId: 'agent_worker',
      priorityClass: 'interactive',
      requiredPoolConstraints: [],
    });
    const turnLineage = {
      workspaceId: fixture.workspace.id,
      threadId: fixture.turn.threadId,
      turnId: 'turn_worker_admin',
      triggerActor: { kind: 'user', id: 'user_missing' } as const,
    };
    expect(
      currentScheduledTurnWorkspaceAuthority(fixture.coreDb, turnLineage, 'tool.use', true)
    ).toBe('owner');
    expect(
      currentScheduledTurnWorkspaceAuthority(
        fixture.coreDb,
        { ...turnLineage, triggerActor: { kind: 'user', id: 'user_local' } },
        'tool.use',
        true
      )
    ).toBeNull();
    createSchedulerPlacementPlan(fixture.coreDb, {
      planId: 'plan_worker_admin',
      queueEntryId: 'queue_worker_admin',
      selectedPoolId: 'pool_worker_admin',
      selectedTargetId: 'target_worker_admin',
      plannedLeaseDurationMs: 900_000,
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 30_000,
      expectedControlMode: 'poll',
      expectedDataPlaneMode: 'openshell-files',
      degradedOptionalFeatures: [],
      failoverTargetId: null,
      policyDecisionIds: [],
      capacitySnapshotRef: 'target_worker_admin:1',
      schedulerEpoch: 1,
    });
    createSchedulerSessionLease(fixture.coreDb, {
      leaseId: 'lease_worker_admin',
      planId: 'plan_worker_admin',
      agentSessionId: 'as_worker_admin',
      packageSnapshotId: 'snapshot_worker_admin',
      sessionCompatibilityKey: 'sha256:worker-admin',
      expiresAt: '2099-01-01T00:00:00.000Z',
      heartbeatDeadline: '2099-01-01T00:00:00.000Z',
      startupDeadline: '2099-01-01T00:00:00.000Z',
      sandboxTokenBindingRef: 'lease-token:worker-admin',
    });
    const lineage = {
      workspaceId: fixture.workspace.id,
      threadId: fixture.turn.threadId,
      turnId: 'turn_worker_admin',
      agentSessionId: 'as_worker_admin',
      packageSnapshotId: 'snapshot_worker_admin',
      triggerActor: { kind: 'user', id: 'user_missing' } as const,
    };
    expect(currentWorkerLineageWorkspaceAuthority(fixture.coreDb, lineage, 'tool.use', true)).toBe(
      'owner'
    );
    expect(
      currentWorkerLineageWorkspaceAuthority(
        fixture.coreDb,
        { ...lineage, packageSnapshotId: 'other_snapshot' },
        'tool.use',
        true
      )
    ).toBeNull();
    expect(
      currentWorkerLineageWorkspaceAuthority(
        fixture.coreDb,
        { ...lineage, triggerActor: { kind: 'user', id: 'user_local' } },
        'tool.use',
        true
      )
    ).toBeNull();
    fixture.coreDb.sqlite
      .prepare(
        "UPDATE openkit_access_tokens SET status = 'revoked', revoked_at = ? WHERE token_id = ?"
      )
      .run(new Date().toISOString(), 'token_admin_worker');
    expect(
      currentWorkerLineageWorkspaceAuthority(fixture.coreDb, lineage, 'tool.use', true)
    ).toBeNull();
  });

  it('derives the Quick Chat Workspace from the authenticated actor', async () => {
    const response = await fixture.app.request(
      ...operationRequest(
        'chat.quick',
        {},
        {
          body: JSON.stringify({ input: 'Hello' }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      )
    );

    expect(response.status, await response.clone().text()).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      workspaceId: fixture.quickChatWorkspace.id,
    });
  });

  it('derives collection candidates from active Core memberships before loading content', async () => {
    const response = await fixture.app.request(...operationRequest('workspace.list', {}));
    const access = (await response.json()) as { items: { workspace: { id: string } }[] };
    expect(response.status).toBe(200);
    const workspaceIds = access.items.map(({ workspace }) => workspace.id);
    expect(workspaceIds.sort()).toEqual(
      [fixture.foreignWorkspace.id, fixture.quickChatWorkspace.id, fixture.workspace.id].sort()
    );
    expect(workspaceIds).not.toContain(fixture.filesystemOnlyWorkspace.id);
  });

  it('admits the complete automation body Workspace through native invocation', async () => {
    const body = {
      cron: '0 9 * * *',
      name: 'Morning status',
      prompt: 'Summarize current work.',
      workspaceId: fixture.workspace.id,
    };
    const response = await fixture.app.request(
      ...operationRequest(
        'automation.create',
        {},
        {
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      )
    );

    expect(response.status, await response.clone().text()).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ ...body, status: 'paused' });
  });

  it('treats Gateway metadata as optional session attribution but mandatory token scope', async () => {
    const unattributed = await fixture.app.request('/v1/responses', {
      body: JSON.stringify({ input: 'Hello', model: 'test' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const attributed = await fixture.app.request('/v1/responses', {
      body: JSON.stringify({
        input: 'Hello',
        metadata: { openkit: { workspaceId: fixture.workspace.id } },
        model: 'test',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const malformedAttribution = await fixture.app.request('/v1/responses', {
      body: JSON.stringify({
        input: 'Hello',
        metadata: { openkit: { workspaceId: '' } },
        model: 'test',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    fixture.actorState.current = {
      kind: 'token',
      tokenId: 'token_workspace',
      tokenScope: 'workspace',
      tokenWorkspaceIds: [fixture.workspace.id],
      userId: 'user_local',
    };
    const tokenWithoutAttribution = await fixture.app.request('/v1/responses', {
      body: JSON.stringify({ input: 'Hello', model: 'test' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    createOpenKitAccessTokenRecord(fixture.coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'user_local',
      scope: 'server-admin',
      tokenId: 'token_admin',
      workspaceIds: [],
    });
    fixture.actorState.current = {
      kind: 'token',
      tokenId: 'token_admin',
      tokenScope: 'server-admin',
      tokenWorkspaceIds: [],
      userId: 'user_local',
    };
    const adminAttributed = await fixture.app.request('/v1/responses', {
      body: JSON.stringify({
        input: 'Hello',
        metadata: { openkit: { workspaceId: fixture.workspace.id } },
        model: 'test',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const adminUnattributed = await fixture.app.request('/v1/responses', {
      body: JSON.stringify({ input: 'Hello', model: 'test' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(unattributed.status).toBe(200);
    await expect(unattributed.json()).resolves.toBeNull();
    expect(attributed.status).toBe(200);
    await expect(attributed.json()).resolves.toEqual({
      effectiveRole: 'owner',
      kind: 'workspace',
      policyOperation: 'llm.gateway.use',
      workspaceId: fixture.workspace.id,
    });
    expect(malformedAttribution.status).toBe(403);
    await expect(malformedAttribution.json()).resolves.toMatchObject({
      code: 'workspace_access_denied',
    });
    expect(tokenWithoutAttribution.status).toBe(403);
    await expect(tokenWithoutAttribution.json()).resolves.toMatchObject({
      code: 'workspace_access_denied',
    });
    expect(adminAttributed.status).toBe(200);
    await expect(adminAttributed.json()).resolves.toEqual({
      effectiveRole: 'owner',
      kind: 'workspace',
      policyOperation: 'llm.gateway.use',
      workspaceId: fixture.workspace.id,
    });
    expect(adminUnattributed.status).toBe(200);
    await expect(adminUnattributed.json()).resolves.toBeNull();
  });

  it('resolves an opaque Turn to its Workspace before exposing handler access', async () => {
    const response = await fixture.app.request(
      ...operationRequest(
        'turn.feedback',
        { turnId: fixture.turn.id },
        {
          body: JSON.stringify({ note: null, rating: 'good' }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      )
    );

    expect(response.status, await response.clone().text()).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      turnId: fixture.turn.id,
      rating: 'good',
      note: null,
    });
  });

  it('authorizes a route-declared Workspace from Core facts', async () => {
    const response = await fixture.app.request(
      ...operationRequest('workspace.dashboard', { workspaceId: fixture.workspace.id })
    );

    expect(response.status, await response.clone().text()).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      workspace: { id: fixture.workspace.id },
    });
  });

  it('authorizes the Workspace before reading child lineage and denies a mismatched child', async () => {
    fixture.actorState.current = { kind: 'session', userId: 'user_missing' };
    const deniedBeforeHandler = await fixture.app.request(
      ...operationRequest('material.thread-read', {
        workspaceId: fixture.workspace.id,
        threadId: fixture.foreignThread.id,
      })
    );

    expect(deniedBeforeHandler.status).toBe(403);
    expect(fixture.workspaceDbReads()).toBe(0);

    fixture.actorState.current = { kind: 'session', userId: 'user_local' };
    const deniedAfterAuthorization = await fixture.app.request(
      ...operationRequest('material.thread-read', {
        workspaceId: fixture.workspace.id,
        threadId: fixture.foreignThread.id,
      })
    );
    const deniedBeforeHandlerBody = await deniedBeforeHandler.json();
    const deniedAfterAuthorizationBody = await deniedAfterAuthorization.json();

    expect(deniedAfterAuthorization.status).toBe(404);
    expect(fixture.workspaceDbReads()).toBe(0);
    expect(deniedBeforeHandlerBody).toMatchObject({ code: 'workspace_access_denied' });
    expect(deniedAfterAuthorizationBody).toMatchObject({
      code: 'not_found',
      message: 'Thread not found.',
    });
  });

  it('returns one non-enumerating denial for missing and removed membership', async () => {
    fixture.actorState.current = { kind: 'session', userId: 'user_missing' };
    const missing = await fixture.app.request(
      ...operationRequest('workspace.dashboard', { workspaceId: fixture.workspace.id })
    );
    fixture.actorState.current = { kind: 'session', userId: 'user_removed' };
    const removed = await fixture.app.request(
      ...operationRequest('workspace.dashboard', { workspaceId: fixture.workspace.id })
    );
    const missingBody = await missing.json();
    const removedBody = await removed.json();

    expect(missing.status).toBe(403);
    expect(removed.status).toBe(403);
    expect(missingBody).toEqual(removedBody);
    expect(missingBody).toMatchObject({ code: 'workspace_access_denied' });
  });

  it('uses catalog mutation posture to cap readonly tokens', async () => {
    expect(PUBLIC_OPERATION_ACCESS['automation.create']).toMatchObject({ mutating: true });
    expect(PUBLIC_OPERATION_ACCESS['workspace.dashboard']).toMatchObject({ mutating: false });
    createOpenKitAccessTokenRecord(fixture.coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'user_local',
      scope: 'workspace-readonly',
      tokenId: 'token_readonly',
      workspaceIds: [fixture.workspace.id],
    });
    fixture.actorState.current = {
      kind: 'token',
      tokenId: 'token_readonly',
      tokenScope: 'workspace-readonly',
      tokenWorkspaceIds: [fixture.workspace.id],
      userId: 'user_local',
    };

    const read = await fixture.app.request(
      ...operationRequest('workspace.dashboard', { workspaceId: fixture.workspace.id })
    );
    const mutation = await fixture.app.request(
      ...operationRequest(
        'automation.create',
        {},
        {
          body: JSON.stringify({
            cron: '0 9 * * *',
            name: 'Denied mutation',
            prompt: 'Do not create this.',
            workspaceId: fixture.workspace.id,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      )
    );

    expect(read.status).toBe(200);
    expect(mutation.status).toBe(403);
    await expect(mutation.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
  });

  it('fences ordinary Workspace routes during deletion', async () => {
    await fixture.workspaceMutationAdmission.close(fixture.workspace.id);

    const collection = await fixture.app.request('/api/app/operations/workspace.list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const read = await fixture.app.request(
      ...operationRequest('workspace.dashboard', { workspaceId: fixture.workspace.id })
    );
    const mutation = await fixture.app.request(
      ...operationRequest(
        'automation.create',
        {},
        {
          body: JSON.stringify({
            cron: '0 9 * * *',
            name: 'Fenced mutation',
            prompt: 'Do not create this.',
            workspaceId: fixture.workspace.id,
          }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      )
    );

    expect(collection.status).toBe(200);
    const items = (await collection.json()).items as { workspace: { id: string } }[];
    expect(items.map(({ workspace }) => workspace.id)).not.toContain(fixture.workspace.id);
    expect(read.status).toBe(403);
    expect(mutation.status).toBe(403);
    await expect(read.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
    await expect(mutation.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
  });

  it('lets usable server-admin bearer tokens act as Workspace owner authority', async () => {
    createOpenKitAccessTokenRecord(fixture.coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'user_local',
      scope: 'server-admin',
      tokenId: 'token_admin_content',
      workspaceIds: [],
    });
    fixture.actorState.current = {
      kind: 'token',
      tokenId: 'token_admin_content',
      tokenScope: 'server-admin',
      tokenWorkspaceIds: [],
      userId: 'user_local',
    };

    const response = await fixture.app.request(
      ...operationRequest('workspace.dashboard', { workspaceId: fixture.workspace.id })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      workspace: { id: fixture.workspace.id },
    });
  });

  it('grants usable server-admin bearer tokens owner access without membership and lists all active Workspaces', async () => {
    createOpenKitAccessTokenRecord(fixture.coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'user_missing',
      scope: 'server-admin',
      tokenId: 'token_admin_no_membership',
      workspaceIds: [],
    });
    fixture.actorState.current = {
      kind: 'token',
      tokenId: 'token_admin_no_membership',
      tokenScope: 'server-admin',
      tokenWorkspaceIds: [],
      userId: 'user_missing',
    };

    const dashboard = await fixture.app.request(
      ...operationRequest('workspace.dashboard', { workspaceId: fixture.workspace.id })
    );
    const collection = await fixture.app.request('/api/app/operations/workspace.list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const create = await fixture.app.request(
      ...operationRequest(
        'workspace.create',
        {},
        {
          method: 'POST',
          body: JSON.stringify({
            name: 'Created by administrator',
            requestId: '00000000-0000-4000-8000-000000000001',
          }),
        }
      )
    );

    expect(dashboard.status).toBe(200);
    await expect(dashboard.json()).resolves.toMatchObject({
      workspace: { id: fixture.workspace.id },
    });
    expect(collection.status).toBe(200);
    const collectionBody = (await collection.json()) as { items: { workspace: { id: string } }[] };
    const workspaceIds = collectionBody.items.map(({ workspace }) => workspace.id);
    expect(workspaceIds).toEqual(
      expect.arrayContaining([
        fixture.quickChatWorkspace.id,
        fixture.workspace.id,
        fixture.foreignWorkspace.id,
      ])
    );
    expect(workspaceIds).not.toContain(fixture.filesystemOnlyWorkspace.id);
    expect(create.status).toBe(201);
  });

  it('still denies revoked server-admin bearer tokens for Workspace product routes', async () => {
    createOpenKitAccessTokenRecord(fixture.coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'user_local',
      scope: 'server-admin',
      tokenId: 'token_admin_revoked',
      workspaceIds: [],
    });
    fixture.coreDb.sqlite
      .prepare(
        `UPDATE openkit_access_tokens SET status = 'revoked', revoked_at = ? WHERE token_id = ?`
      )
      .run(new Date().toISOString(), 'token_admin_revoked');
    fixture.actorState.current = {
      kind: 'token',
      tokenId: 'token_admin_revoked',
      tokenScope: 'server-admin',
      tokenWorkspaceIds: [],
      userId: 'user_local',
    };

    const response = await fixture.app.request(
      ...operationRequest('workspace.dashboard', { workspaceId: fixture.workspace.id })
    );
    const create = await fixture.app.request(
      ...operationRequest(
        'workspace.create',
        {},
        {
          method: 'POST',
          body: JSON.stringify({
            name: 'Created by administrator',
            requestId: '00000000-0000-4000-8000-000000000001',
          }),
        }
      )
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
    expect(create.status).toBe(403);
    await expect(create.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
  });

  it('intersects current usable deployment administration with current Workspace access', async () => {
    const send = () =>
      fixture.app.request(
        ...operationRequest('worker-environment.list', { workspaceId: fixture.workspace.id })
      );
    const withoutAdmin = await send();
    createOpenKitAccessTokenRecord(fixture.coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'user_local',
      scope: 'server-admin',
      tokenId: 'token_current_admin',
      workspaceIds: [],
    });
    const withAdmin = await send();
    fixture.coreDb.sqlite
      .prepare(
        `UPDATE openkit_access_tokens SET status = 'revoked', revoked_at = ? WHERE token_id = ?`
      )
      .run(new Date().toISOString(), 'token_current_admin');
    const afterRevocation = await send();

    expect(withoutAdmin.status).toBe(403);
    expect(withAdmin.status).toBe(200);
    await expect(withAdmin.json()).resolves.toMatchObject({
      items: [],
      nextCursor: null,
    });
    expect(afterRevocation.status).toBe(403);
  });

  it('requires a presented admin Token to remain usable and grants owner without membership', async () => {
    createOpenKitAccessTokenRecord(fixture.coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'user_local',
      scope: 'server-admin',
      tokenId: 'token_presented_admin',
      workspaceIds: [],
    });
    fixture.actorState.current = {
      kind: 'token',
      tokenId: 'token_presented_admin',
      tokenScope: 'server-admin',
      tokenWorkspaceIds: [],
      userId: 'user_local',
    };
    const allowed = await fixture.app.request(
      ...operationRequest('worker-environment.list', { workspaceId: fixture.workspace.id })
    );
    createOpenKitAccessTokenRecord(fixture.coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'user_missing',
      scope: 'server-admin',
      tokenId: 'token_admin_without_membership',
      workspaceIds: [],
    });
    fixture.actorState.current = {
      kind: 'token',
      tokenId: 'token_admin_without_membership',
      tokenScope: 'server-admin',
      tokenWorkspaceIds: [],
      userId: 'user_missing',
    };
    const withoutMembership = await fixture.app.request(
      ...operationRequest('worker-environment.list', { workspaceId: fixture.workspace.id })
    );

    expect(allowed.status).toBe(200);
    expect(withoutMembership.status).toBe(200);
    await expect(withoutMembership.json()).resolves.toMatchObject({ items: [], nextCursor: null });
  });

  it('intersects Workspace token bindings with current membership', async () => {
    createOpenKitAccessTokenRecord(fixture.coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'user_local',
      scope: 'workspace',
      tokenId: 'token_workspace',
      workspaceIds: [fixture.foreignWorkspace.id, fixture.workspace.id],
    });
    fixture.actorState.current = {
      kind: 'token',
      tokenId: 'token_workspace',
      tokenScope: 'workspace',
      tokenWorkspaceIds: [fixture.foreignWorkspace.id],
      userId: 'user_local',
    };
    const unbound = await fixture.app.request(
      ...operationRequest('workspace.dashboard', { workspaceId: fixture.workspace.id })
    );

    fixture.actorState.current = {
      ...fixture.actorState.current,
      tokenWorkspaceIds: [fixture.workspace.id],
    };
    const bound = await fixture.app.request(
      ...operationRequest('workspace.dashboard', { workspaceId: fixture.workspace.id })
    );

    expect(unbound.status).toBe(403);
    await expect(unbound.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
    expect(bound.status).toBe(200);
    await expect(bound.json()).resolves.toMatchObject({
      workspace: { id: fixture.workspace.id },
    });
  });

  it('limits canonical-user operations to local, session, and usable server-admin actors', async () => {
    const session = isCanonicalUserOperationAuthorized(fixture.coreDb, fixture.actorState.current);
    fixture.actorState.current = {
      kind: 'token',
      tokenId: 'token_workspace',
      tokenScope: 'workspace',
      tokenWorkspaceIds: [fixture.workspace.id],
      userId: 'user_local',
    };
    const token = isCanonicalUserOperationAuthorized(fixture.coreDb, fixture.actorState.current);
    createOpenKitAccessTokenRecord(fixture.coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'user_local',
      scope: 'server-admin',
      tokenId: 'token_admin_canonical',
      workspaceIds: [],
    });
    fixture.actorState.current = {
      kind: 'token',
      tokenId: 'token_admin_canonical',
      tokenScope: 'server-admin',
      tokenWorkspaceIds: [],
      userId: 'user_local',
    };
    const admin = isCanonicalUserOperationAuthorized(fixture.coreDb, fixture.actorState.current);

    expect(session).toBe(true);
    expect(token).toBe(false);
    expect(admin).toBe(true);
  });

  it('provisions only the usable server-admin actor Quick Chat before administration submit', async () => {
    const actorQuickChatId = quickChatWorkspaceIdForUser('user_missing');
    presentServerAdmin('user_missing', 'token_admin_absent_qc');

    const response = await submitAdministrationConversation({
      input: 'Prepare a Worker image.',
      requestId: '11111111-1111-4111-8111-111111111111',
    });

    expect(response.status, await response.clone().text()).toBe(200);
    expect(fixture.administrationHandlerReads()).toBe(1);
    await expect(response.json()).resolves.toMatchObject({
      turn: { workspaceId: actorQuickChatId },
    });
    expect(fixture.store.listThreads(actorQuickChatId)).toHaveLength(1);
    expect(fixture.store.getWorkspace(actorQuickChatId)).toMatchObject({
      id: actorQuickChatId,
      kind: 'quick-chat',
    });
    expect(registeredWorkspaceOwner(actorQuickChatId)).toBe('user_missing');
    expect(registeredWorkspaceOwner(fixture.quickChatWorkspace.id)).toBe('user_local');
  });

  it('does not provision Quick Chat for revoked or disabled administration callers', async () => {
    fixture.coreDb.sqlite
      .prepare('DELETE FROM workspace_registry WHERE workspace_id = ?')
      .run(fixture.quickChatWorkspace.id);
    presentServerAdmin('user_local', 'token_admin_revoked_qc');
    revokeOpenKitAccessTokenRecord(fixture.coreDb, 'token_admin_revoked_qc');
    const workspaceIdsBefore = fixture.store.listWorkspaces().map((workspace) => workspace.id);

    const revoked = await submitAdministrationConversation({
      input: 'Prepare a Worker image.',
      requestId: '33333333-3333-4333-8333-333333333333',
    });
    presentServerAdmin('user_disabled', 'token_admin_disabled_qc');
    const disabled = await submitAdministrationConversation({
      input: 'Prepare a Worker image.',
      requestId: '44444444-4444-4444-8444-444444444444',
    });

    expect(revoked.status).toBe(403);
    expect(disabled.status).toBe(403);
    expect(fixture.administrationHandlerReads()).toBe(0);
    await expect(revoked.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
    await expect(disabled.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
    expect(registeredWorkspaceOwner(fixture.quickChatWorkspace.id)).toBeUndefined();
    expect(registeredWorkspaceOwner(quickChatWorkspaceIdForUser('user_disabled'))).toBeUndefined();
    expect(fixture.store.listWorkspaces().map((workspace) => workspace.id)).toEqual(
      workspaceIdsBefore
    );
    expect(workspaceIdsBefore).not.toContain(quickChatWorkspaceIdForUser('user_disabled'));
  });

  it('denies administration submit when the actor Quick Chat owner membership is removed', async () => {
    const actorQuickChatId = quickChatWorkspaceIdForUser('user_missing');
    const now = new Date().toISOString();
    fixture.store.ensureQuickChatWorkspace('user_missing');
    fixture.coreDb.sqlite
      .prepare(
        `INSERT INTO workspace_registry (
          workspace_id, owner_user_id, status, revision, created_at, updated_at
        ) VALUES (?, 'user_missing', 'active', 1, ?, ?)`
      )
      .run(actorQuickChatId, now, now);
    fixture.coreDb.sqlite
      .prepare(
        `INSERT INTO workspace_members (
          workspace_id, user_id, status, access_level, invitation_id,
          joined_at, removed_at, revision, created_at, updated_at
        ) VALUES (?, 'user_missing', 'removed', 'editor', NULL, ?, ?, 2, ?, ?)`
      )
      .run(actorQuickChatId, now, now, now, now);
    presentServerAdmin('user_missing', 'token_admin_removed_qc');

    const beforeThreads = fixture.store.listThreads(actorQuickChatId);
    const beforeReceipts = fixture.store.listCommandRequests();
    const beforeMembership = fixture.coreDb.sqlite
      .prepare('SELECT * FROM workspace_members WHERE workspace_id = ?')
      .all(actorQuickChatId);
    const beforeRegistry = fixture.coreDb.sqlite
      .prepare('SELECT * FROM workspace_registry WHERE workspace_id = ?')
      .all(actorQuickChatId);
    const response = await submitAdministrationConversation({
      input: 'Prepare a Worker image.',
      requestId: '55555555-5555-4555-8555-555555555555',
    });

    expect(response.status).toBe(403);
    expect(fixture.administrationHandlerReads()).toBe(0);
    await expect(response.json()).resolves.toMatchObject({
      code: 'workspace_access_denied',
      message: 'Workspace access denied.',
    });
    expect(
      await submitAdministrationConversationMcp({
        input: 'Prepare a Worker image.',
        requestId: '55555555-5555-4555-8555-555555555555',
      })
    ).toEqual({
      isError: true,
      status: 403,
      code: 'workspace_access_denied',
      message: 'Workspace access denied.',
    });
    expect(fixture.administrationHandlerReads()).toBe(0);
    expect(fixture.store.listThreads(actorQuickChatId)).toEqual(beforeThreads);
    expect(fixture.store.listCommandRequests()).toEqual(beforeReceipts);
    expect(
      fixture.coreDb.sqlite
        .prepare('SELECT * FROM workspace_members WHERE workspace_id = ?')
        .all(actorQuickChatId)
    ).toEqual(beforeMembership);
    expect(
      fixture.coreDb.sqlite
        .prepare('SELECT * FROM workspace_registry WHERE workspace_id = ?')
        .all(actorQuickChatId)
    ).toEqual(beforeRegistry);
    expect(ownerMembershipStatus(actorQuickChatId, 'user_missing')).toBe('removed');
    expect(registeredWorkspaceOwner(actorQuickChatId)).toBe('user_missing');
  });

  it('lets unexpected actor-home provisioning faults escape unchanged before implementation effects', async () => {
    presentServerAdmin('user_missing', 'token_admin_home_fault');
    const failure = new Error('Workspace owner membership has been removed.');
    failure.name = 'WorkspaceOwnerMembershipRemovedError';
    const provision = vi.spyOn(fixture.store, 'ensureQuickChatWorkspace').mockImplementation(() => {
      throw failure;
    });
    const errorHandler = vi.fn((error: Error) => error);
    fixture.app.onError((error, c) => {
      errorHandler(error);
      return c.text('Internal Server Error', 500);
    });
    const beforeWorkspaces = fixture.store.listWorkspaces();
    const beforeReceipts = fixture.store.listCommandRequests();
    try {
      const input = {
        input: 'Prepare a Worker image.',
        requestId: '66666666-6666-4666-8666-666666666666',
      };
      const response = await submitAdministrationConversation(input);
      expect(response.status).toBe(500);
      await expect(response.text()).resolves.toBe('Internal Server Error');
      expect(errorHandler).toHaveBeenCalledExactlyOnceWith(failure);
      expect(await submitAdministrationConversationMcp(input)).toEqual({
        isError: true,
        code: 'operation_failed',
        message: 'Operation failed. Inspect the owner outcome before retrying.',
      });
      expect(provision).toHaveBeenCalledTimes(2);
      expect(fixture.administrationHandlerReads()).toBe(0);
      expect(fixture.store.listWorkspaces()).toEqual(beforeWorkspaces);
      expect(fixture.store.listCommandRequests()).toEqual(beforeReceipts);
      expect(registeredWorkspaceOwner(quickChatWorkspaceIdForUser('user_missing'))).toBeUndefined();
    } finally {
      provision.mockRestore();
    }
  });

  it('requires exact workspace.delete truth even for a usable original-owner administrator and denies content', async () => {
    const record = createWorkspaceDeletionRequest(fixture.dataRoot, {
      workspaceId: fixture.workspace.id,
      originalOwnerUserId: 'user_local',
      expectedRegistryRevision: 2,
      confirmation: `permanently-delete-workspace:${fixture.workspace.id}:2`,
      requestId: 'cae8ee19-e909-42b4-8612-52f37638d568',
      createdAt: new Date().toISOString(),
    });
    writeWorkspaceDeletionRequest(fixture.dataRoot, { ...record, phase: 'blocked' });
    markWorkspaceDeleting(fixture.workspace.id);
    presentServerAdmin('user_local', 'token_admin_delete_retry');

    const retry = await requestWorkspaceDeletion(fixture.workspace.id);
    const content = await fixture.app.request(
      ...operationRequest('workspace.dashboard', { workspaceId: fixture.workspace.id })
    );

    expect(retry.status, await retry.clone().text()).toBe(409);
    await expect(retry.json()).resolves.toMatchObject({ code: 'recovery_required' });
    expect(fixture.deleteWorkspaceHandlerReads()).toBe(0);
    expect(content.status).toBe(403);
    await expect(content.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
  });

  it('admits a current foreign administrator to workspace.delete truth checks while denying revoked and disabled authority', async () => {
    const record = createWorkspaceDeletionRequest(fixture.dataRoot, {
      workspaceId: fixture.workspace.id,
      originalOwnerUserId: 'user_local',
      expectedRegistryRevision: 2,
      confirmation: `permanently-delete-workspace:${fixture.workspace.id}:2`,
      requestId: 'cae8ee19-e909-42b4-8612-52f37638d568',
      createdAt: new Date().toISOString(),
    });
    writeWorkspaceDeletionRequest(fixture.dataRoot, { ...record, phase: 'blocked' });
    markWorkspaceDeleting(fixture.workspace.id);
    fixture.actorState.current = { kind: 'session', userId: 'user_missing' };
    const ordinary = await requestWorkspaceDeletion(fixture.workspace.id);
    expect(ordinary.status).toBe(403);
    await expect(ordinary.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
    presentServerAdmin('user_missing', 'token_admin_delete_foreign');
    const foreign = await requestWorkspaceDeletion(fixture.workspace.id);
    presentServerAdmin('user_local', 'token_admin_delete_revoked');
    revokeOpenKitAccessTokenRecord(fixture.coreDb, 'token_admin_delete_revoked');
    const revoked = await requestWorkspaceDeletion(fixture.workspace.id);
    presentServerAdmin('user_local', 'token_admin_delete_disabled');
    fixture.coreDb.sqlite
      .prepare(`UPDATE users SET status = 'disabled' WHERE id = 'user_local'`)
      .run();
    const disabled = await requestWorkspaceDeletion(fixture.workspace.id);

    expect(foreign.status).toBe(409);
    expect(revoked.status).toBe(403);
    expect(disabled.status).toBe(403);
    expect(fixture.deleteWorkspaceHandlerReads()).toBe(0);
    await expect(foreign.json()).resolves.toMatchObject({ code: 'recovery_required' });
    await expect(revoked.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
    await expect(disabled.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
  });
});

/** Presents one server-admin bearer on the shared fixture actor. */
function presentServerAdmin(userId: string, tokenId: string): void {
  createOpenKitAccessTokenRecord(fixture.coreDb, {
    expiresAt: '2099-01-01T00:00:00.000Z',
    ownerUserId: userId,
    scope: 'server-admin',
    tokenId,
    workspaceIds: [],
  });
  fixture.actorState.current = {
    kind: 'token',
    tokenId,
    tokenScope: 'server-admin',
    tokenWorkspaceIds: [],
    userId,
  };
}

/** Submits one private administration conversation through the canonical administration invocation. */
function submitAdministrationConversation(body: Record<string, unknown>): Promise<Response> {
  return fixture.app.request(
    ...operationRequest(
      'administration.conversation-submit',
      {},
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }
    )
  );
}

/** Marks one existing registry row as deleting without changing its owner. */
function markWorkspaceDeleting(workspaceId: string): void {
  fixture.coreDb.sqlite
    .prepare(
      `UPDATE workspace_registry
       SET status = 'deleting', revision = revision + 1, updated_at = ?
       WHERE workspace_id = ?`
    )
    .run(new Date().toISOString(), workspaceId);
}

/** Posts an explicit canonical workspace.delete request without inventing missing deletion truth. */
function requestWorkspaceDeletion(workspaceId: string): Promise<Response> {
  return fixture.app.request(
    ...operationRequest(
      'workspace.delete',
      { workspaceId: workspaceId },
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          confirmation: `permanently-delete-workspace:${workspaceId}:2`,
          expectedRegistryRevision: 2,
          requestId: 'cae8ee19-e909-42b4-8612-52f37638d568',
        }),
      }
    )
  );
}

/** Reads the current registry owner for one Workspace id. */
function registeredWorkspaceOwner(workspaceId: string): string | undefined {
  const row = fixture.coreDb.sqlite
    .prepare('SELECT owner_user_id FROM workspace_registry WHERE workspace_id = ?')
    .get(workspaceId) as { owner_user_id: string } | undefined;
  return row?.owner_user_id;
}

/** Calls the actual remote MCP framer over the fixture's trusted actor; refusal must precede family execution. */
async function submitAdministrationConversationMcp(input: Record<string, unknown>) {
  const response = await fixture.app.request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'call',
        arguments: { operation: 'administration.conversation-submit', input },
      },
    }),
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.error).toBeUndefined();
  return { isError: body.result.isError, ...JSON.parse(body.result.content[0].text) };
}

/** Reads one Workspace membership status. */
function ownerMembershipStatus(workspaceId: string, userId: string): string | undefined {
  const row = fixture.coreDb.sqlite
    .prepare(`SELECT status FROM workspace_members WHERE workspace_id = ? AND user_id = ?`)
    .get(workspaceId, userId) as { status: string } | undefined;
  return row?.status;
}

/** Fixtures keep a real administration key and native invocation while varying its closed Workspace selector. */
describe('canonical administration Workspace admission', () => {
  it.each([
    ['body-workspace', 'administrator'],
    ['opaque-child-workspace', 'administrator'],
    ['body-workspace', 'non-administrator'],
    ['opaque-child-workspace', 'non-administrator'],
  ] as const)('uses one primary admission for %s and %s on HTTP and MCP', async (strategy, authority) => {
    const id = 'nanohost.runtime-target';
    expect(Object.hasOwn(ADMINISTRATION_OPERATION_DEFINITIONS, id)).toBe(true);
    expect(Object.hasOwn(PRODUCT_OPERATION_DEFINITIONS, id)).toBe(false);
    const definition: OperationDefinition = {
      ...OPERATION_DEFINITIONS[id],
      credentials: ['deployment-administrator'],
      inputSchema: z.object({ workspaceId: z.string(), turnId: z.string() }).strict(),
      scope:
        strategy === 'body-workspace'
          ? { kind: 'body-workspace', field: 'workspaceId' }
          : {
              kind: 'opaque-child-workspace',
              field: 'workspaceId',
              childField: 'turnId',
              childOwner: 'turn',
            },
      target: { kind: 'workspace' },
    };
    const patches = [
      [OPERATION_DEFINITIONS, definition],
      [ADMINISTRATION_OPERATION_DEFINITIONS, definition],
      [
        PUBLIC_OPERATION_ACCESS,
        {
          scope: 'workspace',
          resolver: strategy,
          authentication: 'deployment-admin',
          policyOperation: 'api.call',
          mutating: false,
        },
      ],
    ] as const;
    const originals = patches.map(([table]) => Object.getOwnPropertyDescriptor(table, id)!);
    const expected = {
      identityId: 'fixture-host',
      deploymentId: 'fixture-deployment',
      connectionGeneration: 1,
      predecessorFenced: true,
      ready: true,
      freshEmpty: true,
      observedAt: '2026-10-05T00:00:00.000Z',
    };
    const execute = vi.fn(() => expected);
    const factory = nanoHostOperations.createNanoHostOperationImplementations;
    vi.spyOn(nanoHostOperations, 'createNanoHostOperationImplementations').mockImplementation(
      (dependencies) => ({ ...factory(dependencies), [id]: execute })
    );
    const admission = vi.spyOn(operationAuthorizer, 'authorizeWorkspace');
    try {
      for (const [table, value] of patches)
        Object.defineProperty(table, id, { ...Object.getOwnPropertyDescriptor(table, id), value });
      createOpenKitAccessTokenRecord(fixture.coreDb, {
        ownerUserId: authority === 'administrator' ? 'user_missing' : 'user_viewer',
        scope: authority === 'administrator' ? 'server-admin' : 'workspace',
        workspaceIds: authority === 'administrator' ? [] : [fixture.workspace.id],
        tokenId: 'token_administration_fixture',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      fixture.actorState.current = {
        kind: 'token',
        userId: authority === 'administrator' ? 'user_missing' : 'user_viewer',
        tokenId: 'token_administration_fixture',
        tokenScope: authority === 'administrator' ? 'server-admin' : 'workspace',
        tokenWorkspaceIds: authority === 'administrator' ? [] : [fixture.workspace.id],
      };
      const app = new Hono<{ Variables: AuthVariables }>();
      app.use('*', async (c, next) => {
        c.set('actor', fixture.actorState.current);
        await next();
      });
      registerOperationAccessGuards({
        app,
        coreDb: fixture.coreDb,
        store: fixture.store,
        quickChatWorkspaceIdForUser,
        workspaceMutationAdmission: fixture.workspaceMutationAdmission,
      });
      const dependencies = {
        app,
        coreDb: fixture.coreDb,
        store: fixture.store,
        requestStore: () => fixture.store,
        inflightCommands: new WeakMap(),
        workspaceMutationAdmission: fixture.workspaceMutationAdmission,
      };
      registerOperationJsonRoutes(dependencies);
      registerRemoteMcpRoutes({ ...dependencies, getBootReadiness: createBootReadinessSnapshot });
      const input = { workspaceId: fixture.workspace.id, turnId: fixture.turn.id };
      // MCP first establishes the same native result before HTTP exercises the legacy-guard exclusion.
      for (const transport of ['MCP', 'HTTP'] as const) {
        admission.mockClear();
        execute.mockClear();
        const response = await app.request(
          transport === 'HTTP' ? `/api/app/operations/${id}` : '/mcp',
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify(
              transport === 'HTTP'
                ? input
                : {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: { name: 'call', arguments: { operation: id, input } },
                  }
            ),
          }
        );
        const json = await response.json();
        const value = transport === 'HTTP' ? json : JSON.parse(json.result.content[0].text);
        if (authority === 'administrator') {
          expect(response.status, transport).toBe(200);
          expect(value, transport).toEqual(expected);
          expect(admission, transport).toHaveBeenCalledTimes(1);
          expect(execute, transport).toHaveBeenCalledTimes(1);
        } else {
          expect(response.status, transport).toBe(transport === 'HTTP' ? 403 : 200);
          expect(value, transport).toMatchObject({ code: 'workspace_access_denied' });
          if (transport === 'MCP') expect(json.result.isError).toBe(true);
          expect(admission, transport).not.toHaveBeenCalled();
          expect(execute, transport).not.toHaveBeenCalled();
        }
      }
    } finally {
      patches.forEach(([table], index) => {
        Object.defineProperty(table, id, originals[index]!);
      });
      vi.restoreAllMocks();
    }
  });
});
