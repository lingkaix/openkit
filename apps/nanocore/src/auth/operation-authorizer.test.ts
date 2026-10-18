import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ADMINISTRATION_OPERATION_DEFINITIONS,
  OPERATION_DEFINITIONS,
  type OperationDefinition,
  PRODUCT_OPERATION_DEFINITIONS,
} from '@openkit/app-api-schemas';
import * as policyKernel from '@openkit/policy-kernel';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';
import { createBootReadinessSnapshot } from '../bootstrap/readiness.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from '../config/runtime-config.js';
import { AutomationStore } from '../lib/automation-store.js';
import { quickChatWorkspaceIdForUser } from '../lib/store.js';
import { registerOperationJsonRoutes } from '../operation-json-routes.js';
import { registerRemoteMcpRoutes } from '../remote-mcp-routes.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { createWorkerEnvironmentOperations } from '../worker-environments/worker-environment-operations.js';
import {
  createWorkspaceDeletionRequest,
  writeWorkspaceDeletionRequest,
} from '../workspace-deletion-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import {
  acceptWorkspaceInvitation,
  createWorkspaceInvitation,
  leaveWorkspace,
} from '../workspace-sharing.js';
import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
  rotateOpenKitAccessTokenRecord,
} from './access-token-store.js';
import type { Actor } from './identity.js';
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
  type WorkspaceAuthorityEvaluation,
  type WorkspaceAuthorityOptions,
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
        ('usr_00000000-0000-7241-80d8-0d46cb74b40d', 'Missing Member', 'missing-member@example.com', false, ?, ?, 'human', 'active'),
        ('usr_00000000-0000-7171-af76-f9d024000442', 'Removed Member', 'removed-member@example.com', false, ?, ?, 'human', 'active'),
        ('usr_00000000-0000-7b43-8df8-fd24a5ccdbe8', 'Viewer Member', 'viewer-member@example.com', false, ?, ?, 'human', 'active'),
        ('usr_00000000-0000-7e63-b85a-c188de8ee1c3', 'Disabled Member', 'disabled-member@example.com', false, ?, ?, 'human', 'disabled')`
    )
    .run(now, now, now, now, now, now, now, now);

  const store = createDemoStore({ dataRoot });
  const quickChatWorkspace = store
    .listWorkspaces()
    .find((workspace) => workspace.kind === 'personal');
  const workspace = store.listWorkspaces().find((item) => item.kind === 'code');
  if (!quickChatWorkspace || !workspace) {
    throw new Error('Expected Quick Chat and Demo Workspace fixtures.');
  }

  const foreignWorkspace = store.createWorkspace('Foreign Workspace');
  const filesystemOnlyWorkspace = store.createWorkspace('Filesystem Only Workspace');
  for (const ownedWorkspace of [quickChatWorkspace, workspace, foreignWorkspace]) {
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: ownedWorkspace.id,
    });
  }
  coreDb.sqlite
    .prepare(
      `INSERT INTO workspace_members (
        workspace_id, user_id, status, invitation_id,
        joined_at, removed_at, revision, created_at, updated_at
      ) VALUES
        (?, 'usr_00000000-0000-7171-af76-f9d024000442', 'removed', NULL, ?, ?, 2, ?, ?),
        (?, 'usr_00000000-0000-7b43-8df8-fd24a5ccdbe8', 'active', NULL, ?, NULL, 1, ?, ?),
        (?, 'usr_00000000-0000-7e63-b85a-c188de8ee1c3', 'active', NULL, ?, NULL, 1, ?, ?)`
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
    id: 'usr_00000000-0000-7000-8000-000000000001',
  });
  const foreignThread = store.createThread(foreignWorkspace.id, 'Foreign thread');
  const actorState: { current: Actor } = {
    current: { kind: 'session', userId: 'usr_00000000-0000-7000-8000-000000000001' },
  };
  const workspaceMutationAdmission = new WorkspaceMutationAdmission();
  const automationStore = new AutomationStore(coreDb, workspaceMutationAdmission);
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
    fileAdmission: new FileStorageAdmission(dataRoot, () => 1_000_000n),
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

// Real database and Workspace initialization can exceed the default hook bound on shared CI hosts.
beforeEach(() => {
  fixture = createFixture();
}, 30_000);

afterEach(() => {
  fixture.coreDb.sqlite.close();
});

describe('central Workspace operation authorizer', () => {
  it('propagates canonical-user storage failures instead of reporting a Policy denial', () => {
    const failure = new Error('injected canonical-user read failure');
    const read = vi.spyOn(fixture.coreDb.sqlite, 'prepare').mockImplementationOnce(() => {
      throw failure;
    });
    try {
      expect(() =>
        isCanonicalUserOperationAuthorized(fixture.coreDb, fixture.actorState.current)
      ).toThrow(failure);
      expect(read).toHaveBeenCalledWith(expect.stringMatching(/users/));
    } finally {
      read.mockRestore();
    }
  });

  it('keeps a canonical-user Kernel denial as a non-enumerating HTTP 403', async () => {
    const actualEvaluate = policyKernel.evaluateAccess;
    const evaluate = vi
      .spyOn(policyKernel, 'evaluateAccess')
      .mockImplementation((policy, request) =>
        actualEvaluate({ ...policy, associations: [] }, request)
      );
    try {
      const denied = await fixture.app.request(...operationRequest('caller.read', {}));
      expect(denied.status).toBe(403);
      await expect(denied.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
      expect(evaluate).toHaveBeenCalledTimes(1);
    } finally {
      evaluate.mockRestore();
    }
  });

  it.each([
    'user',
    'unattributed Gateway',
    'Workspace member',
    'Workspace administrator',
  ] as const)('requires the current Kernel decision after %s eligibility', async (scope) => {
    if (scope === 'Workspace administrator') {
      const issued = createOpenKitAccessTokenRecord(fixture.coreDb, {
        ownerUserId: 'usr_00000000-0000-7241-80d8-0d46cb74b40d',
        scope: 'server-admin',
        workspaceIds: [],
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      fixture.actorState.current = {
        kind: 'token',
        userId: issued.record.ownerUserId,
        tokenId: issued.record.tokenId,
        tokenScope: 'server-admin',
        tokenWorkspaceIds: [],
      };
    }
    const send = () => {
      if (scope === 'unattributed Gateway')
        return fixture.app.request('/v1/responses', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
      return fixture.app.request(
        ...(scope === 'user'
          ? operationRequest('caller.read', {})
          : operationRequest('workspace.dashboard', { workspaceId: fixture.workspace.id }))
      );
    };
    // Establish current eligibility with the real policy before replacing only its mandatory input.
    expect((await send()).status).toBe(200);
    const actualEvaluate = policyKernel.evaluateAccess;
    const evaluate = vi.spyOn(policyKernel, 'evaluateAccess');
    try {
      evaluate.mockImplementation((policy, request) =>
        actualEvaluate({ ...policy, associations: [] }, request)
      );
      const denied = await send();
      expect(denied.status).toBe(403);
      await expect(denied.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
      expect(evaluate).toHaveBeenCalled();
      evaluate.mockImplementation(() => {
        throw new Error('Policy dependency unavailable.');
      });
      const failed = await send();
      expect(failed.status).toBe(403);
      await expect(failed.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
    } finally {
      evaluate.mockRestore();
    }
  });

  it.each([
    {
      actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const,
      effectAuthority: true,
      expectedAuthority: 'member',
      name: 'active human owner',
      operation: 'runtime.launch',
    },
    {
      actor: {
        kind: 'agent',
        id: 'agent_worker',
        responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
      } as const,
      effectAuthority: true,
      expectedAuthority: 'member',
      name: 'responsible non-human actor',
      operation: 'runtime.launch',
    },
    {
      actor: { kind: 'system', id: 'system_worker', responsibleUserId: null } as const,
      effectAuthority: true,
      expectedAuthority: null,
      name: 'actor without a responsible user',
      operation: 'runtime.launch',
    },
    {
      actor: { kind: 'user', id: 'usr_00000000-0000-7241-80d8-0d46cb74b40d' } as const,
      effectAuthority: true,
      expectedAuthority: null,
      name: 'missing membership',
      operation: 'runtime.launch',
    },
    {
      actor: { kind: 'user', id: 'usr_00000000-0000-7171-af76-f9d024000442' } as const,
      effectAuthority: true,
      expectedAuthority: null,
      name: 'removed membership',
      operation: 'runtime.launch',
    },
    {
      actor: { kind: 'user', id: 'usr_00000000-0000-7e63-b85a-c188de8ee1c3' } as const,
      effectAuthority: true,
      expectedAuthority: null,
      name: 'disabled responsible user',
      operation: 'runtime.launch',
    },
    {
      actor: { kind: 'user', id: 'usr_00000000-0000-7b43-8df8-fd24a5ccdbe8' } as const,
      effectAuthority: true,
      expectedAuthority: 'member',
      name: 'active non-owner member',
      operation: 'runtime.launch',
    },
    {
      actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const,
      effectAuthority: true,
      expectedAuthority: null,
      name: 'unknown policy operation',
      operation: 'runtime.unregistered',
    },
    {
      actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const,
      effectAuthority: false,
      expectedAuthority: null,
      name: 'missing effect authority',
      operation: 'runtime.launch',
    },
  ])('composes current authority for $name', ({
    actor,
    effectAuthority,
    expectedAuthority,
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
    ).toBe(expectedAuthority);
  });

  it('binds a presented admin bearer to its active human owner without member fallback', () => {
    createOpenKitAccessTokenRecord(fixture.coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'usr_00000000-0000-7241-80d8-0d46cb74b40d',
      scope: 'server-admin',
      tokenId: 'token_presented_current',
      workspaceIds: [],
    });
    const requestActor = {
      kind: 'token' as const,
      tokenId: 'token_presented_current',
      tokenScope: 'server-admin' as const,
      userId: 'usr_00000000-0000-7241-80d8-0d46cb74b40d',
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
    expect(authority({ kind: 'user', id: 'usr_00000000-0000-7241-80d8-0d46cb74b40d' })).toBe(
      'administrator'
    );
    expect(authority({ kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' })).toBeNull();
    expect(
      authority({
        kind: 'automation',
        id: 'auto_00000000-0000-70fd-80e3-b24982c7fd2b',
        responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
      })
    ).toBeNull();
    fixture.coreDb.sqlite
      .prepare(
        "UPDATE openkit_access_tokens SET status = 'revoked', revoked_at = ? WHERE token_id = ?"
      )
      .run(new Date().toISOString(), 'token_presented_current');
    expect(authority({ kind: 'user', id: 'usr_00000000-0000-7241-80d8-0d46cb74b40d' })).toBeNull();
    createOpenKitAccessTokenRecord(fixture.coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
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
        { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        'runtime.launch',
        true,
        {
          ...requestActor,
          tokenId: 'token_presented_member',
          userId: 'usr_00000000-0000-7000-8000-000000000001',
        }
      )
    ).toBeNull();
  });

  it('revalidates the recorded administrator token instead of falling back to membership', () => {
    createOpenKitAccessTokenRecord(fixture.coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      scope: 'server-admin',
      tokenId: 'token_admin_admission',
      workspaceIds: [],
    });
    const admission = {
      workspaceId: fixture.workspace.id,
      triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const,
      serverAdminTokenId: 'token_admin_admission',
    };
    expect(
      currentSchedulerAdmissionWorkspaceAuthority(fixture.coreDb, admission, 'runtime.launch', true)
    ).toBe('administrator');
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
    ).toBe('member');
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
      [
        'token_admin_expired',
        'usr_00000000-0000-7241-80d8-0d46cb74b40d',
        'usr_00000000-0000-7241-80d8-0d46cb74b40d',
        '2000-01-01T00:00:00.000Z',
      ],
      [
        'token_admin_wrong_owner',
        'usr_00000000-0000-7000-8000-000000000001',
        'usr_00000000-0000-7241-80d8-0d46cb74b40d',
        '2099-01-01T00:00:00.000Z',
      ],
      [
        'token_admin_disabled',
        'usr_00000000-0000-7e63-b85a-c188de8ee1c3',
        'usr_00000000-0000-7e63-b85a-c188de8ee1c3',
        '2099-01-01T00:00:00.000Z',
      ],
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
          triggerActor: {
            kind: 'automation',
            id: 'auto_00000000-0000-70fd-80e3-b24982c7fd2b',
            responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
          },
          serverAdminTokenId: 'token_admin_wrong_owner',
        },
        'runtime.launch',
        true
      )
    ).toBeNull();
  });

  it('binds worker authority to the exact durable attempt and package actor', () => {
    createOpenKitAccessTokenRecord(fixture.coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'usr_00000000-0000-7241-80d8-0d46cb74b40d',
      scope: 'server-admin',
      tokenId: 'token_admin_worker',
      workspaceIds: [],
    });
    const entry = createSchedulerAdmissionEntry(fixture.coreDb, {
      backendId: 'nanohost',
      queueEntryId: 'queue_worker_admin',
      triggerActor: { kind: 'user', id: 'usr_00000000-0000-7241-80d8-0d46cb74b40d' },
      serverAdminTokenId: 'token_admin_worker',
      workspaceId: fixture.workspace.id,
      threadId: fixture.turn.threadId,
      turnId: 'tu_00000000-0000-7615-b8c7-8be649d29bd5',
      turnInput: 'Run worker',
      requestedAgentId: 'agent_worker',
    });
    const turnLineage = {
      workspaceId: fixture.workspace.id,
      threadId: fixture.turn.threadId,
      turnId: 'tu_00000000-0000-7615-b8c7-8be649d29bd5',
      triggerActor: { kind: 'user', id: 'usr_00000000-0000-7241-80d8-0d46cb74b40d' } as const,
    };
    expect(
      currentScheduledTurnWorkspaceAuthority(fixture.coreDb, turnLineage, 'tool.use', true)
    ).toBe('administrator');
    expect(
      currentScheduledTurnWorkspaceAuthority(
        fixture.coreDb,
        {
          ...turnLineage,
          triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        },
        'tool.use',
        true
      )
    ).toBeNull();
    recordTestExecutionAttempt(fixture.coreDb, {
      entry,
      attemptId: testEntityId('attempt', 'lease_worker_admin'),
      agentSessionId: 'as_00000000-0000-7bbb-87ab-08921157e60d',
      inputRef: 'snapshot_worker_admin',
      bindingRef: 'lease-token:worker-admin',
      sessionCompatibilityKey: 'sha256:worker-admin',
      now: () => new Date().toISOString(),
    });
    const lineage = {
      workspaceId: fixture.workspace.id,
      threadId: fixture.turn.threadId,
      turnId: 'tu_00000000-0000-7615-b8c7-8be649d29bd5',
      agentSessionId: 'as_00000000-0000-7bbb-87ab-08921157e60d',
      packageSnapshotId: 'snapshot_worker_admin',
      triggerActor: { kind: 'user', id: 'usr_00000000-0000-7241-80d8-0d46cb74b40d' } as const,
    };
    expect(currentWorkerLineageWorkspaceAuthority(fixture.coreDb, lineage, 'tool.use', true)).toBe(
      'administrator'
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
        {
          ...lineage,
          triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
        },
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

  it.each([
    'member',
    'administrator',
  ] as const)('propagates unreadable %s authority only when strict dependency failures are requested', (authority) => {
    const dataRoot = fixture.dataRoot;
    onTestFinished(() => rmSync(dataRoot, { recursive: true, force: true }));
    const actor = {
      kind: 'user' as const,
      id:
        authority === 'member'
          ? 'usr_00000000-0000-7b43-8df8-fd24a5ccdbe8'
          : 'usr_00000000-0000-7000-8000-000000000001',
    };
    const token =
      authority === 'administrator'
        ? createOpenKitAccessTokenRecord(fixture.coreDb, {
            expiresAt: '2099-01-01T00:00:00.000Z',
            ownerUserId: actor.id,
            scope: 'server-admin',
            workspaceIds: [],
          }).record
        : null;
    const entry = createSchedulerAdmissionEntry(fixture.coreDb, {
      backendId: 'nanohost',
      queueEntryId: 'queue_strict_authority',
      triggerActor: actor,
      serverAdminTokenId: token?.tokenId ?? null,
      workspaceId: fixture.workspace.id,
      threadId: fixture.turn.threadId,
      turnId: fixture.turn.id,
      turnInput: 'Check current tool authority',
      requestedAgentId: 'agent_worker',
    });
    recordTestExecutionAttempt(fixture.coreDb, {
      entry,
      attemptId: testEntityId('attempt', 'strict_authority'),
      agentSessionId: testEntityId('as', 'strict_authority'),
      inputRef: 'snapshot_strict_authority',
      bindingRef: 'binding_strict_authority',
      sessionCompatibilityKey: 'sha256:strict-authority',
      now: () => new Date().toISOString(),
    });
    const lineage = {
      workspaceId: entry.workspaceId,
      threadId: entry.threadId,
      turnId: entry.turnId,
      agentSessionId: testEntityId('as', 'strict_authority'),
      packageSnapshotId: 'snapshot_strict_authority',
      triggerActor: actor,
    };
    const requestActor = token
      ? {
          kind: 'token' as const,
          tokenId: token.tokenId,
          tokenScope: 'server-admin' as const,
          userId: actor.id,
        }
      : undefined;
    const strict = { dependencyFailure: 'throw' as const };
    const evaluate = (options?: WorkspaceAuthorityOptions) => [
      () =>
        currentWorkspaceAuthority(
          fixture.coreDb,
          entry.workspaceId,
          actor,
          'tool.use',
          true,
          requestActor,
          options
        ),
      () =>
        currentSchedulerAdmissionWorkspaceAuthority(
          fixture.coreDb,
          entry,
          'tool.use',
          true,
          options
        ),
      () =>
        currentWorkerLineageWorkspaceAuthority(fixture.coreDb, lineage, 'tool.use', true, options),
    ];
    for (const check of evaluate(strict)) expect(check()).toBe(authority);
    const capture = vi.fn<(event: WorkspaceAuthorityEvaluation) => void>();
    const capturedOptions = { ...strict, onEvaluation: capture };
    const membership = fixture.coreDb.sqlite
      .prepare('SELECT revision FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
      .get(entry.workspaceId, actor.id) as { revision: number };
    const expectedFacts = {
      workspaceId: entry.workspaceId,
      operation: 'tool.use',
      responsibleUserId: actor.id,
      relation: authority,
      presentedTokenId: token?.tokenId ?? null,
      membershipRevision: token ? null : membership.revision,
      presentedTokenState: token
        ? {
            tokenId: token.tokenId,
            ownerUserId: token.ownerUserId,
            scope: token.scope,
            workspaceIds: token.workspaceIds,
            status: token.status,
            expiresAt: token.expiresAt,
            revokedAt: token.revokedAt,
            predecessorTokenId: token.predecessorTokenId,
            rotatedGraceExpiresAt: token.rotatedGraceExpiresAt,
          }
        : null,
    };
    for (const check of evaluate(capturedOptions)) expect(check()).toBe(authority);
    expect(capture).toHaveBeenCalledTimes(3);
    for (const [event] of capture.mock.calls) {
      expect(event.facts).toEqual(expectedFacts);
      expect(event.decision.effect).toBe('allow');
      expect(event.decision.reasons).toBeDefined();
      expect(event.decision.trace).toBeDefined();
    }
    capture.mockClear();
    if (token) {
      const rotated = rotateOpenKitAccessTokenRecord(fixture.coreDb, token.tokenId, {
        graceSeconds: 3600,
      });
      if (!rotated) throw new Error('Expected the real Token rotation to succeed.');
      expectedFacts.presentedTokenState = {
        ...expectedFacts.presentedTokenState!,
        status: rotated.rotatedRecord.status,
        rotatedGraceExpiresAt: rotated.rotatedRecord.rotatedGraceExpiresAt,
      };
    } else {
      const left = fixture.coreDb.sqlite.transaction(() =>
        leaveWorkspace({
          coreDb: fixture.coreDb,
          workspaceId: entry.workspaceId,
          memberUserId: actor.id,
          expectedRevision: membership.revision,
        })
      )();
      expect(left.kind).toBe('removed');
      for (const check of evaluate(capturedOptions)) expect(check()).toBeNull();
      expect(capture).not.toHaveBeenCalled();
      const rejoined = fixture.coreDb.sqlite.transaction(() => {
        const invited = createWorkspaceInvitation({
          coreDb: fixture.coreDb,
          workspaceId: entry.workspaceId,
          inviterUserId: 'usr_00000000-0000-7000-8000-000000000001',
          inviteeEmail: 'viewer-member@example.com',
        });
        if (invited.kind !== 'created') throw new Error('Expected a real rejoin invitation.');
        return acceptWorkspaceInvitation({
          coreDb: fixture.coreDb,
          workspaceId: entry.workspaceId,
          invitationId: invited.invitation.invitationId,
          inviteeUserId: actor.id,
          expectedRevision: invited.invitation.revision,
        });
      })();
      if (rejoined.kind !== 'accepted') throw new Error('Expected a real membership rejoin.');
      expect(rejoined.member.revision).toBeGreaterThan(membership.revision);
      expectedFacts.membershipRevision = rejoined.member.revision;
    }
    for (const check of evaluate(capturedOptions)) expect(check()).toBe(authority);
    expect(capture).toHaveBeenCalledTimes(3);
    for (const [event] of capture.mock.calls) expect(event.facts).toEqual(expectedFacts);
    capture.mockClear();
    const actualEvaluate = policyKernel.evaluateAccess;
    const kernel = vi
      .spyOn(policyKernel, 'evaluateAccess')
      .mockImplementation((policy, request) =>
        actualEvaluate({ ...policy, associations: [] }, request)
      );
    try {
      for (const check of evaluate(capturedOptions)) expect(check()).toBeNull();
      expect(capture).toHaveBeenCalledTimes(3);
      for (const [index, [event]] of capture.mock.calls.entries()) {
        expect(event.facts).toEqual(expectedFacts);
        expect(event.decision).toEqual(kernel.mock.results[index]?.value);
        expect(event.decision.effect).toBe('deny');
      }
      for (const check of evaluate({
        ...strict,
        onEvaluation: (event) => {
          event.decision.effect = 'allow';
        },
      }))
        expect(check()).toBeNull();
    } finally {
      kernel.mockRestore();
    }
    const callbackError = new Error('Evaluation capture unavailable');
    const failedCapture = {
      onEvaluation: () => {
        throw callbackError;
      },
    };
    for (const check of evaluate(failedCapture)) expect(check()).toBeNull();
    for (const check of evaluate({ ...strict, ...failedCapture }))
      expect(check).toThrow(callbackError);
    capture.mockClear();
    const table = token ? 'openkit_access_tokens' : 'workspace_members';
    const readError = new Error(`Authority read unavailable: ${table}`);
    const prepare = fixture.coreDb.sqlite.prepare.bind(fixture.coreDb.sqlite);
    const unavailable = vi.spyOn(fixture.coreDb.sqlite, 'prepare').mockImplementation((sql) => {
      if (sql.includes(table)) throw readError;
      return prepare(sql);
    });
    try {
      for (const check of evaluate()) expect(check()).toBeNull();
      for (const check of evaluate(strict)) expect(check).toThrow(readError);
    } finally {
      unavailable.mockRestore();
    }
    if (token) {
      revokeOpenKitAccessTokenRecord(fixture.coreDb, token.tokenId);
    } else {
      fixture.coreDb.sqlite
        .prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
        .run(entry.workspaceId, actor.id);
    }
    for (const check of evaluate(capturedOptions)) expect(check()).toBeNull();
    expect(capture).not.toHaveBeenCalled();
    expect(
      currentWorkerLineageWorkspaceAuthority(
        fixture.coreDb,
        { ...lineage, packageSnapshotId: 'missing_snapshot' },
        'tool.use',
        true,
        capturedOptions
      )
    ).toBeNull();
    expect(capture).not.toHaveBeenCalled();
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
      intervalSeconds: 60,
      threadId: fixture.turn.threadId,
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
      userId: 'usr_00000000-0000-7000-8000-000000000001',
    };
    const tokenWithoutAttribution = await fixture.app.request('/v1/responses', {
      body: JSON.stringify({ input: 'Hello', model: 'test' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    createOpenKitAccessTokenRecord(fixture.coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      scope: 'server-admin',
      tokenId: 'token_admin',
      workspaceIds: [],
    });
    fixture.actorState.current = {
      kind: 'token',
      tokenId: 'token_admin',
      tokenScope: 'server-admin',
      tokenWorkspaceIds: [],
      userId: 'usr_00000000-0000-7000-8000-000000000001',
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
      isOwner: true,
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
      isOwner: true,
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
    fixture.actorState.current = {
      kind: 'session',
      userId: 'usr_00000000-0000-7241-80d8-0d46cb74b40d',
    };
    const deniedBeforeHandler = await fixture.app.request(
      ...operationRequest('material.thread-read', {
        workspaceId: fixture.workspace.id,
        threadId: fixture.foreignThread.id,
      })
    );

    expect(deniedBeforeHandler.status).toBe(403);
    expect(fixture.workspaceDbReads()).toBe(0);

    fixture.actorState.current = {
      kind: 'session',
      userId: 'usr_00000000-0000-7000-8000-000000000001',
    };
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
    fixture.actorState.current = {
      kind: 'session',
      userId: 'usr_00000000-0000-7241-80d8-0d46cb74b40d',
    };
    const missing = await fixture.app.request(
      ...operationRequest('workspace.dashboard', { workspaceId: fixture.workspace.id })
    );
    fixture.actorState.current = {
      kind: 'session',
      userId: 'usr_00000000-0000-7171-af76-f9d024000442',
    };
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
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      scope: 'workspace-readonly',
      tokenId: 'token_readonly',
      workspaceIds: [fixture.workspace.id],
    });
    fixture.actorState.current = {
      kind: 'token',
      tokenId: 'token_readonly',
      tokenScope: 'workspace-readonly',
      tokenWorkspaceIds: [fixture.workspace.id],
      userId: 'usr_00000000-0000-7000-8000-000000000001',
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
            intervalSeconds: 60,
            threadId: fixture.turn.threadId,
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
            intervalSeconds: 60,
            threadId: fixture.turn.threadId,
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

  it('lets usable server-admin bearer tokens receive Workspace administrator eligibility', async () => {
    createOpenKitAccessTokenRecord(fixture.coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      scope: 'server-admin',
      tokenId: 'token_admin_content',
      workspaceIds: [],
    });
    fixture.actorState.current = {
      kind: 'token',
      tokenId: 'token_admin_content',
      tokenScope: 'server-admin',
      tokenWorkspaceIds: [],
      userId: 'usr_00000000-0000-7000-8000-000000000001',
    };

    const response = await fixture.app.request(
      ...operationRequest('workspace.dashboard', { workspaceId: fixture.workspace.id })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      workspace: { id: fixture.workspace.id },
    });
  });

  it('grants usable server-admin bearer tokens administrator eligibility without membership and lists all active Workspaces', async () => {
    createOpenKitAccessTokenRecord(fixture.coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'usr_00000000-0000-7241-80d8-0d46cb74b40d',
      scope: 'server-admin',
      tokenId: 'token_admin_no_membership',
      workspaceIds: [],
    });
    fixture.actorState.current = {
      kind: 'token',
      tokenId: 'token_admin_no_membership',
      tokenScope: 'server-admin',
      tokenWorkspaceIds: [],
      userId: 'usr_00000000-0000-7241-80d8-0d46cb74b40d',
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
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
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
      userId: 'usr_00000000-0000-7000-8000-000000000001',
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
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
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

  it('requires a presented admin Token to remain usable and grants administrator eligibility without membership', async () => {
    createOpenKitAccessTokenRecord(fixture.coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      scope: 'server-admin',
      tokenId: 'token_presented_admin',
      workspaceIds: [],
    });
    fixture.actorState.current = {
      kind: 'token',
      tokenId: 'token_presented_admin',
      tokenScope: 'server-admin',
      tokenWorkspaceIds: [],
      userId: 'usr_00000000-0000-7000-8000-000000000001',
    };
    const allowed = await fixture.app.request(
      ...operationRequest('worker-environment.list', { workspaceId: fixture.workspace.id })
    );
    createOpenKitAccessTokenRecord(fixture.coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'usr_00000000-0000-7241-80d8-0d46cb74b40d',
      scope: 'server-admin',
      tokenId: 'token_admin_without_membership',
      workspaceIds: [],
    });
    fixture.actorState.current = {
      kind: 'token',
      tokenId: 'token_admin_without_membership',
      tokenScope: 'server-admin',
      tokenWorkspaceIds: [],
      userId: 'usr_00000000-0000-7241-80d8-0d46cb74b40d',
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
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      scope: 'workspace',
      tokenId: 'token_workspace',
      workspaceIds: [fixture.foreignWorkspace.id, fixture.workspace.id],
    });
    fixture.actorState.current = {
      kind: 'token',
      tokenId: 'token_workspace',
      tokenScope: 'workspace',
      tokenWorkspaceIds: [fixture.foreignWorkspace.id],
      userId: 'usr_00000000-0000-7000-8000-000000000001',
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
      userId: 'usr_00000000-0000-7000-8000-000000000001',
    };
    const token = isCanonicalUserOperationAuthorized(fixture.coreDb, fixture.actorState.current);
    createOpenKitAccessTokenRecord(fixture.coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      scope: 'server-admin',
      tokenId: 'token_admin_canonical',
      workspaceIds: [],
    });
    fixture.actorState.current = {
      kind: 'token',
      tokenId: 'token_admin_canonical',
      tokenScope: 'server-admin',
      tokenWorkspaceIds: [],
      userId: 'usr_00000000-0000-7000-8000-000000000001',
    };
    const admin = isCanonicalUserOperationAuthorized(fixture.coreDb, fixture.actorState.current);

    expect(session).toBe(true);
    expect(token).toBe(false);
    expect(admin).toBe(true);
  });

  it('provisions only the usable server-admin actor Quick Chat before administration submit', async () => {
    const actorQuickChatId = quickChatWorkspaceIdForUser(
      'usr_00000000-0000-7241-80d8-0d46cb74b40d'
    );
    presentServerAdmin('usr_00000000-0000-7241-80d8-0d46cb74b40d', 'token_admin_absent_qc');

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
      kind: 'personal',
    });
    expect(registeredWorkspaceOwner(actorQuickChatId)).toBe(
      'usr_00000000-0000-7241-80d8-0d46cb74b40d'
    );
    expect(registeredWorkspaceOwner(fixture.quickChatWorkspace.id)).toBe(
      'usr_00000000-0000-7000-8000-000000000001'
    );
  });

  it('does not provision Quick Chat for revoked or disabled administration callers', async () => {
    fixture.coreDb.sqlite
      .prepare('DELETE FROM workspace_registry WHERE workspace_id = ?')
      .run(fixture.quickChatWorkspace.id);
    presentServerAdmin('usr_00000000-0000-7000-8000-000000000001', 'token_admin_revoked_qc');
    revokeOpenKitAccessTokenRecord(fixture.coreDb, 'token_admin_revoked_qc');
    const workspaceIdsBefore = fixture.store.listWorkspaces().map((workspace) => workspace.id);

    const revoked = await submitAdministrationConversation({
      input: 'Prepare a Worker image.',
      requestId: '33333333-3333-4333-8333-333333333333',
    });
    presentServerAdmin('usr_00000000-0000-7e63-b85a-c188de8ee1c3', 'token_admin_disabled_qc');
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
    expect(
      registeredWorkspaceOwner(
        quickChatWorkspaceIdForUser('usr_00000000-0000-7e63-b85a-c188de8ee1c3')
      )
    ).toBeUndefined();
    expect(fixture.store.listWorkspaces().map((workspace) => workspace.id)).toEqual(
      workspaceIdsBefore
    );
    expect(workspaceIdsBefore).not.toContain(
      quickChatWorkspaceIdForUser('usr_00000000-0000-7e63-b85a-c188de8ee1c3')
    );
  });

  it('denies administration submit when the actor Quick Chat owner membership is removed', async () => {
    const actorQuickChatId = quickChatWorkspaceIdForUser(
      'usr_00000000-0000-7241-80d8-0d46cb74b40d'
    );
    const now = new Date().toISOString();
    fixture.store.ensureQuickChatWorkspace('usr_00000000-0000-7241-80d8-0d46cb74b40d');
    fixture.coreDb.sqlite
      .prepare(
        `INSERT INTO workspace_registry (
          workspace_id, owner_user_id, status, revision, created_at, updated_at
        ) VALUES (?, 'usr_00000000-0000-7241-80d8-0d46cb74b40d', 'active', 1, ?, ?)`
      )
      .run(actorQuickChatId, now, now);
    fixture.coreDb.sqlite
      .prepare(
        `INSERT INTO workspace_members (
          workspace_id, user_id, status, invitation_id,
          joined_at, removed_at, revision, created_at, updated_at
        ) VALUES (?, 'usr_00000000-0000-7241-80d8-0d46cb74b40d', 'removed', NULL, ?, ?, 2, ?, ?)`
      )
      .run(actorQuickChatId, now, now, now, now);
    presentServerAdmin('usr_00000000-0000-7241-80d8-0d46cb74b40d', 'token_admin_removed_qc');

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
    expect(
      ownerMembershipStatus(actorQuickChatId, 'usr_00000000-0000-7241-80d8-0d46cb74b40d')
    ).toBe('removed');
    expect(registeredWorkspaceOwner(actorQuickChatId)).toBe(
      'usr_00000000-0000-7241-80d8-0d46cb74b40d'
    );
  });

  it('lets unexpected actor-home provisioning faults escape unchanged before implementation effects', async () => {
    presentServerAdmin('usr_00000000-0000-7241-80d8-0d46cb74b40d', 'token_admin_home_fault');
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
      expect(
        registeredWorkspaceOwner(
          quickChatWorkspaceIdForUser('usr_00000000-0000-7241-80d8-0d46cb74b40d')
        )
      ).toBeUndefined();
    } finally {
      provision.mockRestore();
    }
  });

  it('requires exact workspace.delete truth even for a usable original-owner administrator and denies content', async () => {
    const record = createWorkspaceDeletionRequest(fixture.dataRoot, {
      workspaceId: fixture.workspace.id,
      originalOwnerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      initiatingUserId: 'usr_00000000-0000-7000-8000-000000000001',
      expectedRegistryRevision: 2,
      confirmation: `permanently-delete-workspace:${fixture.workspace.id}:2`,
      requestId: 'cae8ee19-e909-42b4-8612-52f37638d568',
      createdAt: new Date().toISOString(),
    });
    writeWorkspaceDeletionRequest(fixture.dataRoot, { ...record, phase: 'blocked' });
    markWorkspaceDeleting(fixture.workspace.id);
    presentServerAdmin('usr_00000000-0000-7000-8000-000000000001', 'token_admin_delete_retry');

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
      originalOwnerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      initiatingUserId: 'usr_00000000-0000-7000-8000-000000000001',
      expectedRegistryRevision: 2,
      confirmation: `permanently-delete-workspace:${fixture.workspace.id}:2`,
      requestId: 'cae8ee19-e909-42b4-8612-52f37638d568',
      createdAt: new Date().toISOString(),
    });
    writeWorkspaceDeletionRequest(fixture.dataRoot, { ...record, phase: 'blocked' });
    markWorkspaceDeleting(fixture.workspace.id);
    fixture.actorState.current = {
      kind: 'session',
      userId: 'usr_00000000-0000-7241-80d8-0d46cb74b40d',
    };
    const ordinary = await requestWorkspaceDeletion(fixture.workspace.id);
    expect(ordinary.status).toBe(403);
    await expect(ordinary.json()).resolves.toMatchObject({ code: 'workspace_access_denied' });
    presentServerAdmin('usr_00000000-0000-7241-80d8-0d46cb74b40d', 'token_admin_delete_foreign');
    const foreign = await requestWorkspaceDeletion(fixture.workspace.id);
    presentServerAdmin('usr_00000000-0000-7000-8000-000000000001', 'token_admin_delete_revoked');
    revokeOpenKitAccessTokenRecord(fixture.coreDb, 'token_admin_delete_revoked');
    const revoked = await requestWorkspaceDeletion(fixture.workspace.id);
    presentServerAdmin('usr_00000000-0000-7000-8000-000000000001', 'token_admin_delete_disabled');
    fixture.coreDb.sqlite
      .prepare(
        `UPDATE users SET status = 'disabled' WHERE id = 'usr_00000000-0000-7000-8000-000000000001'`
      )
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
        name: 'openkit_call',
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
      deploymentId: testEntityId('dep', 'fixture-deployment'),
      connectionGeneration: 1,
      predecessorFenced: true,
      ready: true,
      freshEmpty: true,
      physicalEpoch: null,
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
        ownerUserId:
          authority === 'administrator'
            ? 'usr_00000000-0000-7241-80d8-0d46cb74b40d'
            : 'usr_00000000-0000-7b43-8df8-fd24a5ccdbe8',
        scope: authority === 'administrator' ? 'server-admin' : 'workspace',
        workspaceIds: authority === 'administrator' ? [] : [fixture.workspace.id],
        tokenId: 'token_administration_fixture',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      fixture.actorState.current = {
        kind: 'token',
        userId:
          authority === 'administrator'
            ? 'usr_00000000-0000-7241-80d8-0d46cb74b40d'
            : 'usr_00000000-0000-7b43-8df8-fd24a5ccdbe8',
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
                    params: { name: 'openkit_call', arguments: { operation: id, input } },
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
