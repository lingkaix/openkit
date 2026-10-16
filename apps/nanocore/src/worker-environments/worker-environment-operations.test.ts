import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import type { Actor } from '../auth/identity.js';
import { FsStore } from '../lib/store.js';
import type { WorkerEnvironmentRuntimeEffects } from '../runtime/worker-environment-runtime-effects.js';
import {
  activateWorkerStorageAttachment,
  admitWorkerStorageContributor,
  createWorkerStorageBinding,
  getWorkerStorageBinding,
  releaseWorkerStorageAttachment,
  reserveWorkerStorageAttachment,
  type WorkerStorageBinding,
  type WorkerStorageLayout,
} from '../runtime/worker-storage-bindings.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { type CoreDb, openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { createWorkerEnvironmentOperations } from './worker-environment-operations.js';

const NOW = '2026-09-10T00:00:00.000Z';
const LAYOUT: WorkerStorageLayout = {
  family: 'hf_publicFixture',
  gid: 1000,
  platform: { architecture: 'amd64', os: 'linux' },
  targets: [{ target: '/workspace' }, { target: '/sandbox' }],
  uid: 1000,
  version: '1',
  workingDirectory: '/tmp/openkit-bootstrap',
};

interface Fixture {
  actor: Actor;
  binding: WorkerStorageBinding;
  coreDb: CoreDb;
  operations: ReturnType<typeof createWorkerEnvironmentOperations>;
  store: FsStore;
  threadId: string;
  workspaceId: string;
}

const openDbs: CoreDb[] = [];

afterEach(() => {
  for (const coreDb of openDbs.splice(0)) coreDb.sqlite.close();
});

/** Creates one idle environment whose bytes were contributed by the local user. */
function createFixture(effectOverride: Partial<WorkerEnvironmentRuntimeEffects> = {}): Fixture {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-environment-operations-'));
  const coreDb = openCoreDb(dataRoot);
  openDbs.push(coreDb);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = createDemoStore({ dataRoot });
  const workspace = store.listWorkspaces().find((candidate) => candidate.kind === 'code');
  const thread = workspace ? store.listThreads(workspace.id)[0] : undefined;
  if (!workspace || !thread) throw new Error('Expected Demo Workspace fixture.');
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  applyScopedMigrations(workspaceDb);
  workspaceDb.sqlite.close();
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    workspaceId: workspace.id,
  });
  createOpenKitAccessTokenRecord(coreDb, {
    expiresAt: '2099-01-01T00:00:00.000Z',
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
    scope: 'server-admin',
    tokenId: 'token_admin_local',
    workspaceIds: [],
  });
  coreDb.sqlite
    .prepare(
      `INSERT INTO nanohost_runtime_targets (
         target_id, identity_id, deployment_id, connection_generation,
         predecessor_fenced, ready, fresh_empty, observed_at, slot_count
       ) VALUES ('target_1', 'identity_1', 'deployment_1', 1, 1, 1, 1, ?, 1)`
    )
    .run(NOW);
  const created = createWorkerStorageBinding(coreDb, {
    deploymentId: 'deployment_1',
    layout: LAYOUT,
    now: NOW,
    runtimeTargetId: 'target_1',
    workspaceId: workspace.id,
  });
  const reserved = reserveWorkerStorageAttachment(coreDb, {
    agentSessionId: testEntityId('as', 'session_1'),
    authorizeContributor: () => true,
    expectedRevision: created.revision,
    layout: LAYOUT,
    purpose: 'work',
    responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
    runtimeTargetId: 'target_1',
    storageRef: created.storageRef,
    threadId: thread.id,
    workspaceId: workspace.id,
  });
  const attached = activateWorkerStorageAttachment(coreDb, {
    attachmentGeneration: reserved.attachmentGeneration,
    expectedRevision: reserved.revision,
    sandboxBindingRef: 'sandbox_binding_1',
    storageRef: created.storageRef,
    targets: reserved.targets.map((target) => ({ ...target, initialized: true })),
  });
  const binding = releaseWorkerStorageAttachment(coreDb, {
    attachmentGeneration: attached.attachmentGeneration,
    cleanupProved: true,
    expectedRevision: attached.revision,
    sandboxBindingRef: 'sandbox_binding_1',
    storageRef: created.storageRef,
  });
  const runtimeEffects: WorkerEnvironmentRuntimeEffects = {
    inspectImage: vi.fn(),
    inspectStorage: async ({ authorize, binding: current }) => {
      if (!authorize()) throw new Error('Current administrator authority is required.');
      return {
        attachment: null,
        capacity: { availableBytes: 512, totalBytes: 1024 },
        layoutDigest: current.layoutDigest,
        scopeDigest: current.scopeDigest,
        state: 'available',
        storageRef: current.storageRef,
        targets: current.targets,
      };
    },
    prepareImage: async () => {
      throw new Error('Not exercised.');
    },
    purgeStorage: async () => {
      throw new Error('Not exercised.');
    },
    ...effectOverride,
  };
  return {
    actor: { kind: 'session', userId: 'usr_00000000-0000-7000-8000-000000000001' },
    binding,
    coreDb,
    operations: createWorkerEnvironmentOperations({ coreDb, runtimeEffects, store }),
    store,
    threadId: thread.id,
    workspaceId: workspace.id,
  };
}

/** Adds another active member without changing the current administrator's credential. */
function addOtherMember(fixture: Fixture): void {
  const now = Date.now();
  fixture.coreDb.sqlite
    .prepare(
      `INSERT INTO users (
        id, display_name, email, email_verified, created_at, updated_at, kind, status
      ) VALUES (?, 'Other Member', 'other@example.com', false, ?, ?, 'human', 'active')`
    )
    .run(testEntityId('usr', 'user_other'), now, now);
  fixture.coreDb.sqlite
    .prepare(
      `INSERT INTO workspace_members (
        workspace_id, user_id, status, access_level, invitation_id,
        joined_at, removed_at, revision, created_at, updated_at
      ) VALUES (?, ?, 'active', 'editor', NULL, ?, NULL, 1, ?, ?)`
    )
    .run(fixture.workspaceId, testEntityId('usr', 'user_other'), NOW, NOW, NOW);
}

/** Prepares a live shared attachment so another authorized caller can contribute during inspection. */
function prepareConcurrentContributor(fixture: Fixture): () => void {
  addOtherMember(fixture);
  const reserved = reserveWorkerStorageAttachment(fixture.coreDb, {
    agentSessionId: testEntityId('as', 'session_status'),
    authorizeContributor: () => true,
    expectedRevision: fixture.binding.revision,
    layout: LAYOUT,
    purpose: 'work',
    responsibleUserId: 'usr_00000000-0000-7000-8000-000000000001',
    runtimeTargetId: 'target_1',
    storageRef: fixture.binding.storageRef,
    threadId: fixture.threadId,
    workspaceId: fixture.workspaceId,
  });
  fixture.binding = activateWorkerStorageAttachment(fixture.coreDb, {
    attachmentGeneration: reserved.attachmentGeneration,
    expectedRevision: reserved.revision,
    sandboxBindingRef: 'sandbox_status',
    storageRef: reserved.storageRef,
    targets: reserved.targets,
  });
  const thread = fixture.store.createThread(fixture.workspaceId, 'Other shared work');
  return () => {
    // This models another authorized caller's admission, not the status caller's authority.
    admitWorkerStorageContributor(fixture.coreDb, {
      authorizeContributor: () => true,
      expectedRevision: fixture.binding.revision,
      layout: LAYOUT,
      purpose: 'work',
      responsibleUserId: testEntityId('usr', 'user_other'),
      storageRef: fixture.binding.storageRef,
      threadId: thread.id,
      workspaceId: fixture.workspaceId,
    });
  };
}

describe('Worker environment operations', () => {
  it('refuses purge while a queued Turn still selects the idle storage', async () => {
    const fixture = createFixture();
    createSchedulerAdmissionEntry(fixture.coreDb, {
      backendId: 'nanohost',
      queueEntryId: 'queued-storage-work',
      requestedAgentId: 'agent-codex',
      threadId: fixture.threadId,
      triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      turnId: testEntityId('tu', 'turn-queued-storage-work'),
      turnInput: 'Continue existing work.',
      workerStorageChoice: {
        expectedRevision: fixture.binding.revision,
        goalId: null,
        kind: 'selected',
        purpose: 'work',
        storageRef: fixture.binding.storageRef,
        taskId: null,
      },
      workspaceId: fixture.workspaceId,
    });
    await expect(
      fixture.operations.purge(
        { actor: fixture.actor, workspaceId: fixture.workspaceId },
        {
          confirmation: `purge-worker-environment:${fixture.binding.storageRef}:${fixture.binding.revision}`,
          expectedRevision: fixture.binding.revision,
          requestId: '00000000-0000-4000-8000-000000000005',
          storageRef: fixture.binding.storageRef,
        }
      )
    ).rejects.toMatchObject({ code: 'purge_blocked' });
  });
  it('refuses purge while an admitted pending Turn still selects the idle storage', async () => {
    let purgeCalls = 0;
    const fixture = createFixture({
      purgeStorage: async ({ binding }) => {
        purgeCalls += 1;
        return { state: 'purged', storageRef: binding.storageRef };
      },
    });
    const turn = fixture.store.createTurn(
      fixture.workspaceId,
      fixture.threadId,
      'Continue existing work.',
      { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' }
    );
    fixture.store.updateTurn(turn.id, { status: 'pending' });
    createSchedulerAdmissionEntry(fixture.coreDb, {
      backendId: 'nanohost',
      queueEntryId: 'queued-storage-work',
      requestedAgentId: 'agent-codex',
      threadId: fixture.threadId,
      triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      turnId: turn.id,
      turnInput: 'Continue existing work.',
      workerStorageChoice: {
        expectedRevision: fixture.binding.revision,
        goalId: null,
        kind: 'selected',
        purpose: 'work',
        storageRef: fixture.binding.storageRef,
        taskId: null,
      },
      workspaceId: fixture.workspaceId,
    });
    fixture.coreDb.sqlite
      .prepare(
        "UPDATE scheduler_admission_entries SET status = 'admitted' WHERE queue_entry_id = ?"
      )
      .run('queued-storage-work');
    await expect(
      fixture.operations.purge(
        { actor: fixture.actor, workspaceId: fixture.workspaceId },
        {
          confirmation: `purge-worker-environment:${fixture.binding.storageRef}:${fixture.binding.revision}`,
          expectedRevision: fixture.binding.revision,
          requestId: '00000000-0000-4000-8000-000000000005',
          storageRef: fixture.binding.storageRef,
        }
      )
    ).rejects.toMatchObject({ code: 'purge_blocked' });
    expect(purgeCalls).toBe(0);
  });
  it('lists and selects an exact idle environment without reserving it', () => {
    const fixture = createFixture();
    fixture.coreDb.sqlite.close();
    const coreDb = openCoreDb(fixture.coreDb.dataRoot);
    openDbs[openDbs.indexOf(fixture.coreDb)] = coreDb;
    const store = new FsStore({ dataRoot: coreDb.dataRoot });
    const operations = createWorkerEnvironmentOperations({
      coreDb,
      runtimeEffects: {
        inspectImage: vi.fn(),
        inspectStorage: vi.fn(),
        prepareImage: vi.fn(),
        purgeStorage: vi.fn(),
      },
      store,
    });
    const context = { actor: fixture.actor, workspaceId: fixture.workspaceId };
    const listed = operations.list(context, { limit: 50 });
    const selected = operations.select(context, {
      adjudicatedThreadIds: [],
      expectedRevision: fixture.binding.revision,
      goalId: null,
      layoutDigest: fixture.binding.layoutDigest,
      purpose: 'work',
      storageRef: fixture.binding.storageRef,
      taskId: null,
      threadId: fixture.threadId,
    });

    expect(listed).toMatchObject({
      items: [
        {
          storageRef: fixture.binding.storageRef,
          layout: { family: 'hf_publicFixture' },
          layoutDigest: fixture.binding.layoutDigest,
        },
      ],
      nextCursor: null,
    });
    expect(selected.selected).toMatchObject({
      revision: fixture.binding.revision,
      state: 'idle',
      storageRef: fixture.binding.storageRef,
    });
  });

  it('hides missing, foreign, and private-inaccessible selection targets as the same not_found', () => {
    const fixture = createFixture();
    const context = { actor: fixture.actor, workspaceId: fixture.workspaceId };
    const inaccessible = fixture.store.createThread(
      fixture.workspaceId,
      'Other private conversation',
      testEntityId('th', 'thread_private_other'),
      'conversation',
      { privateOwnerUserId: 'usr_00000000-0000-73d4-904a-d4c4b905df7c', visibility: 'private' }
    );
    const foreign = fixture.store.createThread(
      fixture.store.ensureQuickChatWorkspace('usr_00000000-0000-7000-8000-000000000001').id,
      'Private assistant'
    );
    const hidden = {
      code: 'not_found',
      message: 'Worker environment was not found.',
    };

    for (const threadId of ['thread_missing', foreign.id, inaccessible.id]) {
      expect(() =>
        fixture.operations.select(context, {
          adjudicatedThreadIds: [],
          expectedRevision: fixture.binding.revision,
          goalId: null,
          layoutDigest: fixture.binding.layoutDigest,
          purpose: 'work',
          storageRef: fixture.binding.storageRef,
          taskId: null,
          threadId,
        })
      ).toThrow(expect.objectContaining(hidden));
    }
  });

  it('selects onto the caller visible private and shared Threads', () => {
    const fixture = createFixture();
    const context = { actor: fixture.actor, workspaceId: fixture.workspaceId };
    const ownPrivate = fixture.store.createThread(
      fixture.workspaceId,
      'Own private conversation',
      testEntityId('th', 'thread_private_own'),
      'conversation',
      { privateOwnerUserId: 'usr_00000000-0000-7000-8000-000000000001', visibility: 'private' }
    );

    expect(
      fixture.operations.select(context, {
        adjudicatedThreadIds: [],
        expectedRevision: fixture.binding.revision,
        goalId: null,
        layoutDigest: fixture.binding.layoutDigest,
        purpose: 'work',
        storageRef: fixture.binding.storageRef,
        taskId: null,
        threadId: fixture.threadId,
      })
    ).toMatchObject({ selected: { storageRef: fixture.binding.storageRef, state: 'idle' } });
    expect(
      fixture.operations.select(context, {
        adjudicatedThreadIds: [],
        expectedRevision: fixture.binding.revision,
        goalId: null,
        layoutDigest: fixture.binding.layoutDigest,
        purpose: 'work',
        storageRef: fixture.binding.storageRef,
        taskId: null,
        threadId: ownPrivate.id,
      })
    ).toMatchObject({ selected: { storageRef: fixture.binding.storageRef, state: 'idle' } });
  });

  it('defense-in-depth: hides list and refuses host status/purge for inconsistent invisible contributor lineage', async () => {
    // Thread visibility is immutable. This SQL retarget is not valid audience narrowing.
    let inspectCalls = 0;
    let purgeCalls = 0;
    const fixture = createFixture({
      inspectStorage: async () => {
        inspectCalls += 1;
        throw new Error('Host status must not run.');
      },
      purgeStorage: async () => {
        purgeCalls += 1;
        throw new Error('Host purge must not run.');
      },
    });
    const context = { actor: fixture.actor, workspaceId: fixture.workspaceId };
    fixture.store.createThread(
      fixture.workspaceId,
      'Other private conversation',
      testEntityId('th', 'thread_private_source'),
      'conversation',
      { privateOwnerUserId: 'usr_00000000-0000-73d4-904a-d4c4b905df7c', visibility: 'private' }
    );
    fixture.coreDb.sqlite
      .prepare('UPDATE worker_storage_contributors SET thread_id = ? WHERE storage_ref = ?')
      .run('thread_private_source', fixture.binding.storageRef);

    expect(fixture.operations.list(context, { limit: 50 })).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(() =>
      fixture.operations.select(context, {
        adjudicatedThreadIds: [],
        expectedRevision: fixture.binding.revision,
        goalId: null,
        layoutDigest: fixture.binding.layoutDigest,
        purpose: 'work',
        storageRef: fixture.binding.storageRef,
        taskId: null,
        threadId: fixture.threadId,
      })
    ).toThrow(
      expect.objectContaining({
        code: 'not_found',
        message: 'Worker environment was not found.',
      })
    );
    await expect(
      fixture.operations.status(context, { storageRef: fixture.binding.storageRef })
    ).rejects.toMatchObject({
      code: 'not_found',
      message: 'Worker environment was not found.',
    });
    await expect(
      fixture.operations.purge(context, {
        confirmation: `purge-worker-environment:${fixture.binding.storageRef}:${fixture.binding.revision}`,
        expectedRevision: fixture.binding.revision,
        requestId: '00000000-0000-4000-8000-000000000005',
        storageRef: fixture.binding.storageRef,
      })
    ).rejects.toMatchObject({
      code: 'not_found',
      message: 'Worker environment was not found.',
    });
    expect(inspectCalls).toBe(0);
    expect(purgeCalls).toBe(0);
  });

  it('rejects a stale selection revision through the Core compare-and-set owner', () => {
    const fixture = createFixture();

    expect(() =>
      fixture.operations.select(
        { actor: fixture.actor, workspaceId: fixture.workspaceId },
        {
          adjudicatedThreadIds: [],
          expectedRevision: fixture.binding.revision - 1,
          goalId: null,
          layoutDigest: fixture.binding.layoutDigest,
          purpose: 'work',
          storageRef: fixture.binding.storageRef,
          taskId: null,
          threadId: fixture.threadId,
        }
      )
    ).toThrow(/revision/i);
  });

  it("does not disclose one member's contributor lineage to another Workspace member", () => {
    const fixture = createFixture();
    const now = Date.now();
    fixture.coreDb.sqlite
      .prepare(
        `INSERT INTO users (
          id, display_name, email, email_verified, created_at, updated_at, kind, status
        ) VALUES ('usr_00000000-0000-73d4-904a-d4c4b905df7c', 'Other Admin', 'other@example.com', false, ?, ?, 'human', 'active')`
      )
      .run(now, now);
    fixture.coreDb.sqlite
      .prepare(
        `INSERT INTO workspace_members (
          workspace_id, user_id, status, access_level, invitation_id,
          joined_at, removed_at, revision, created_at, updated_at
        ) VALUES (?, 'usr_00000000-0000-73d4-904a-d4c4b905df7c', 'active', 'editor', NULL, ?, NULL, 1, ?, ?)`
      )
      .run(fixture.workspaceId, NOW, NOW, NOW);
    createOpenKitAccessTokenRecord(fixture.coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'usr_00000000-0000-73d4-904a-d4c4b905df7c',
      scope: 'server-admin',
      tokenId: 'token_admin_other',
      workspaceIds: [],
    });

    expect(
      fixture.operations.list(
        {
          actor: { kind: 'session', userId: 'usr_00000000-0000-73d4-904a-d4c4b905df7c' },
          workspaceId: fixture.workspaceId,
        },
        { limit: 50 }
      )
    ).toEqual({ items: [], nextCursor: null });
  });

  it('reports owner-observed unknown storage state and rechecks authority inside the host seam', async () => {
    let authorizeAtEffect: (() => boolean) | undefined;
    const fixture = createFixture({
      inspectStorage: async ({ authorize, binding }) => {
        authorizeAtEffect = authorize;
        fixture.coreDb.sqlite
          .prepare(
            `UPDATE openkit_access_tokens SET status = 'revoked', revoked_at = ? WHERE token_id = ?`
          )
          .run(NOW, 'token_admin_local');
        if (!authorize()) throw new Error('Current administrator authority is required.');
        return {
          attachment: null,
          capacity: { availableBytes: 0, totalBytes: 1024 },
          layoutDigest: binding.layoutDigest,
          scopeDigest: binding.scopeDigest,
          state: 'unknown',
          storageRef: binding.storageRef,
          targets: binding.targets,
        };
      },
    });

    await expect(
      fixture.operations.status(
        { actor: fixture.actor, workspaceId: fixture.workspaceId },
        { storageRef: fixture.binding.storageRef }
      )
    ).rejects.toThrow('Current administrator authority is required.');
    expect(authorizeAtEffect?.()).toBe(false);
  });

  it.each([
    'dispatch',
    'publication',
  ] as const)('refuses status %s when concurrent admission adds a contributor outside the caller audience', async (boundary) => {
    let addContributor: () => void;
    let authorizedAtDispatch: boolean | undefined;
    let changesAfterAdmission: unknown;
    const hostInspection = vi.fn();
    const purgeStorage = vi.fn();
    const fixture = createFixture({
      inspectStorage: async ({ authorize, binding }) => {
        expect(authorize()).toBe(true);
        if (boundary === 'dispatch') addContributor();
        authorizedAtDispatch = authorize();
        if (!authorizedAtDispatch) {
          changesAfterAdmission = fixture.coreDb.sqlite.prepare('SELECT total_changes()').get();
          throw new Error('Worker environment operation is not authorized.');
        }
        hostInspection();
        // Complete a read-only observation before another caller changes source admission.
        await Promise.resolve();
        if (boundary === 'publication') addContributor();
        changesAfterAdmission = fixture.coreDb.sqlite.prepare('SELECT total_changes()').get();
        return {
          attachment: null,
          capacity: { availableBytes: 512, totalBytes: 1024 },
          layoutDigest: binding.layoutDigest,
          scopeDigest: binding.scopeDigest,
          state: 'available',
          storageRef: binding.storageRef,
          targets: binding.targets,
        };
      },
      purgeStorage,
    });
    addContributor = prepareConcurrentContributor(fixture);

    const result = await fixture.operations
      .status(
        { actor: fixture.actor, workspaceId: fixture.workspaceId },
        { storageRef: fixture.binding.storageRef }
      )
      .then(
        (status) => ({ status }),
        (error: unknown) => ({ error })
      );

    expect(authorizedAtDispatch).toBe(boundary === 'publication');
    expect(hostInspection).toHaveBeenCalledTimes(boundary === 'publication' ? 1 : 0);
    expect(result).toMatchObject({
      error:
        boundary === 'publication'
          ? {
              code: 'not_found',
              message: 'Worker environment was not found.',
              name: 'WorkerEnvironmentOperationError',
            }
          : { message: 'Worker environment operation is not authorized.' },
    });
    expect(result).not.toHaveProperty('status');
    expect(purgeStorage).not.toHaveBeenCalled();
    expect(fixture.coreDb.sqlite.prepare('SELECT total_changes()').get()).toEqual(
      changesAfterAdmission
    );
    expect(
      getWorkerStorageBinding(fixture.coreDb, { storageRef: fixture.binding.storageRef })
    ).toMatchObject({ state: 'attached', revision: fixture.binding.revision + 1 });
  });

  it.each([
    'session',
    'token',
  ] as const)('refuses status publication after the %s administrator credential is revoked during inspection', async (kind) => {
    const purgeStorage = vi.fn();
    let changesAfterRevocation: unknown;
    const fixture = createFixture({
      inspectStorage: async ({ authorize, binding }) => {
        expect(authorize()).toBe(true);
        await Promise.resolve();
        fixture.coreDb.sqlite
          .prepare('UPDATE openkit_access_tokens SET status = ?, revoked_at = ? WHERE token_id = ?')
          .run('revoked', NOW, 'token_admin_local');
        changesAfterRevocation = fixture.coreDb.sqlite.prepare('SELECT total_changes()').get();
        return {
          attachment: null,
          capacity: { availableBytes: 512, totalBytes: 1024 },
          layoutDigest: binding.layoutDigest,
          scopeDigest: binding.scopeDigest,
          state: 'available',
          storageRef: binding.storageRef,
          targets: binding.targets,
        };
      },
      purgeStorage,
    });
    const actor: Actor =
      kind === 'session'
        ? fixture.actor
        : {
            kind: 'token',
            tokenId: 'token_admin_local',
            tokenScope: 'server-admin',
            userId: 'usr_00000000-0000-7000-8000-000000000001',
          };

    const result = await fixture.operations
      .status(
        { actor, workspaceId: fixture.workspaceId },
        { storageRef: fixture.binding.storageRef }
      )
      .then(
        (status) => ({ status }),
        (error: unknown) => ({ error })
      );

    expect(result).toMatchObject({
      error: {
        code: 'workspace_access_denied',
        message: 'Workspace access denied.',
        name: 'WorkerEnvironmentOperationError',
      },
    });
    expect(result).not.toHaveProperty('status');
    expect(purgeStorage).not.toHaveBeenCalled();
    expect(fixture.coreDb.sqlite.prepare('SELECT total_changes()').get()).toEqual(
      changesAfterRevocation
    );
    expect(
      getWorkerStorageBinding(fixture.coreDb, { storageRef: fixture.binding.storageRef })
    ).toEqual(fixture.binding);
  });

  it('keeps administrator status eligibility and unknown-state redaction after membership loss', async () => {
    const rawSandboxId = 'unknown-native-sandbox-sentinel';
    const fixture = createFixture({
      inspectStorage: async ({ authorize, binding }) => {
        fixture.coreDb.sqlite
          .prepare(
            `UPDATE workspace_members SET status = ?, removed_at = ? WHERE workspace_id = ? AND user_id = 'usr_00000000-0000-7000-8000-000000000001'`
          )
          .run('removed', NOW, fixture.workspaceId);
        await Promise.resolve();
        expect(authorize()).toBe(true);
        return {
          attachment: { generation: binding.attachmentGeneration, sandboxId: rawSandboxId },
          capacity: { availableBytes: 0, totalBytes: 1024 },
          layoutDigest: binding.layoutDigest,
          scopeDigest: binding.scopeDigest,
          state: 'unknown',
          storageRef: binding.storageRef,
          targets: binding.targets,
        };
      },
    });
    addOtherMember(fixture);
    fixture.coreDb.sqlite
      .prepare(`UPDATE workspace_registry SET owner_user_id = 'user_other' WHERE workspace_id = ?`)
      .run(fixture.workspaceId);

    const status = await fixture.operations.status(
      { actor: fixture.actor, workspaceId: fixture.workspaceId },
      { storageRef: fixture.binding.storageRef }
    );

    expect(status.storage).toMatchObject({
      attachment: { generation: fixture.binding.attachmentGeneration },
      state: 'unknown',
      storageRef: fixture.binding.storageRef,
    });
    expect(JSON.stringify(status)).not.toContain(rawSandboxId);
    expect(JSON.stringify(status)).not.toContain('sandboxId');
  });

  it('projects storage status without exposing the native Sandbox identity', async () => {
    const rawSandboxId = 'raw-native-sandbox-sentinel';
    const fixture = createFixture({
      inspectStorage: async ({ authorize, binding }) => {
        if (!authorize()) throw new Error('Current administrator authority is required.');
        return {
          attachment: { generation: binding.attachmentGeneration, sandboxId: rawSandboxId },
          capacity: { availableBytes: 512, totalBytes: 1024 },
          layoutDigest: binding.layoutDigest,
          scopeDigest: binding.scopeDigest,
          state: 'attached',
          storageRef: binding.storageRef,
          targets: binding.targets,
        };
      },
    });

    const status = await fixture.operations.status(
      { actor: fixture.actor, workspaceId: fixture.workspaceId },
      { storageRef: fixture.binding.storageRef }
    );

    expect(status.storage.attachment).toEqual({ generation: fixture.binding.attachmentGeneration });
    expect(JSON.stringify(status)).not.toContain(rawSandboxId);
    expect(JSON.stringify(status)).not.toContain('sandboxId');
  });

  it('purges one exact idle association and replays its command receipt', async () => {
    let purgeCalls = 0;
    const fixture = createFixture({
      purgeStorage: async ({ authorize, binding }) => {
        purgeCalls += 1;
        if (!authorize()) throw new Error('Current administrator authority is required.');
        return { state: 'purged', storageRef: binding.storageRef };
      },
    });
    const input = {
      confirmation: `purge-worker-environment:${fixture.binding.storageRef}:${fixture.binding.revision}`,
      expectedRevision: fixture.binding.revision,
      requestId: '00000000-0000-4000-8000-000000000001',
      storageRef: fixture.binding.storageRef,
    } as const;
    const context = { actor: fixture.actor, workspaceId: fixture.workspaceId };

    const first = await fixture.operations.purge(context, input);
    const replayed = await fixture.operations.purge(context, input);

    expect(first).toEqual({
      environment: null,
      outcome: 'purged',
      requestId: input.requestId,
      storageRef: fixture.binding.storageRef,
    });
    expect(replayed).toEqual(first);
    expect(purgeCalls).toBe(1);
  });

  it('settles an uncertain purge as unknown and does not redispatch it', async () => {
    let purgeCalls = 0;
    const fixture = createFixture({
      purgeStorage: async () => {
        purgeCalls += 1;
        throw new Error('Transport result is unknown.');
      },
    });
    const input = {
      confirmation: `purge-worker-environment:${fixture.binding.storageRef}:${fixture.binding.revision}`,
      expectedRevision: fixture.binding.revision,
      requestId: '00000000-0000-4000-8000-000000000002',
      storageRef: fixture.binding.storageRef,
    } as const;
    const context = { actor: fixture.actor, workspaceId: fixture.workspaceId };

    const first = await fixture.operations.purge(context, input);
    const replayed = await fixture.operations.purge(context, input);

    expect(first).toMatchObject({ outcome: 'unknown', environment: { state: 'unknown' } });
    expect(replayed).toEqual(first);
    expect(purgeCalls).toBe(1);
  });

  it('rechecks every source audience before replaying an uncertain purge result', async () => {
    let purgeCalls = 0;
    const fixture = createFixture({
      purgeStorage: async () => {
        purgeCalls += 1;
        throw new Error('Transport result is unknown.');
      },
    });
    const input = {
      confirmation: `purge-worker-environment:${fixture.binding.storageRef}:${fixture.binding.revision}`,
      expectedRevision: fixture.binding.revision,
      requestId: '00000000-0000-4000-8000-000000000003',
      storageRef: fixture.binding.storageRef,
    } as const;
    const context = { actor: fixture.actor, workspaceId: fixture.workspaceId };

    await fixture.operations.purge(context, input);
    fixture.coreDb.sqlite
      .prepare(
        `UPDATE worker_storage_contributors
         SET responsible_user_id = 'usr_00000000-0000-73d4-904a-d4c4b905df7c'
         WHERE storage_ref = ?`
      )
      .run(fixture.binding.storageRef);

    await expect(fixture.operations.purge(context, input)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(purgeCalls).toBe(1);
  });
});
