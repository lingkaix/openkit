import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createOpenKitAccessTokenRecord } from '../auth/access-token-store.js';
import { type Actor, ensureLocalUser } from '../auth/identity.js';
import type { FsStore } from '../lib/store.js';
import { createGoalRecord } from '../runtime/goal-store.js';
import type { WorkerEnvironmentRuntimeEffects } from '../runtime/worker-environment-runtime-effects.js';
import {
  activateWorkerStorageAttachment,
  createWorkerStorageBinding,
  releaseWorkerStorageAttachment,
  reserveWorkerStorageAttachment,
  type WorkerStorageBinding,
  type WorkerStorageLayout,
} from '../runtime/worker-storage-bindings.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { type CoreDb, openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { createWorkerEnvironmentOperations } from './worker-environment-operations.js';

const NOW = '2026-09-10T00:00:00.000Z';
const LAYOUT: WorkerStorageLayout = {
  family: 'openkit-worker',
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
    ownerUserId: 'user_local',
    workspaceId: workspace.id,
  });
  createOpenKitAccessTokenRecord(coreDb, {
    expiresAt: '2099-01-01T00:00:00.000Z',
    ownerUserId: 'user_local',
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
    agentSessionId: 'session_1',
    authorizeContributor: () => true,
    expectedRevision: created.revision,
    layout: LAYOUT,
    purpose: 'work',
    responsibleUserId: 'user_local',
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
    actor: { kind: 'session', userId: 'user_local' },
    binding,
    coreDb,
    operations: createWorkerEnvironmentOperations({ coreDb, runtimeEffects, store }),
    store,
    threadId: thread.id,
    workspaceId: workspace.id,
  };
}

describe('Worker environment operations', () => {
  it('refuses purge while a queued Turn still selects the idle storage', async () => {
    const fixture = createFixture();
    createSchedulerAdmissionEntry(fixture.coreDb, {
      priorityClass: 'interactive',
      queueEntryId: 'queued-storage-work',
      requestedAgentId: 'agent-codex',
      requiredPoolConstraints: [],
      threadId: fixture.threadId,
      triggerActor: { kind: 'user', id: 'user_local' },
      turnId: 'turn-queued-storage-work',
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
      { kind: 'user', id: 'user_local' }
    );
    fixture.store.updateTurn(turn.id, { status: 'pending' });
    createSchedulerAdmissionEntry(fixture.coreDb, {
      priorityClass: 'interactive',
      queueEntryId: 'queued-storage-work',
      requestedAgentId: 'agent-codex',
      requiredPoolConstraints: [],
      threadId: fixture.threadId,
      triggerActor: { kind: 'user', id: 'user_local' },
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
  it('refuses to purge idle storage still selected by a nonterminal Goal', async () => {
    let purgeCalls = 0;
    const fixture = createFixture({
      purgeStorage: async ({ binding }) => {
        purgeCalls += 1;
        return { state: 'purged', storageRef: binding.storageRef };
      },
    });
    const workspaceDb = openWorkspaceDb(fixture.coreDb.dataRoot, fixture.workspaceId);
    try {
      applyScopedMigrations(workspaceDb);
      createGoalRecord(workspaceDb, {
        goalId: 'goal-retaining-storage',
        objective: 'Continue related work using this environment.',
        threadId: fixture.threadId,
        title: 'Retained work',
        workerStorageChoice: {
          expectedRevision: fixture.binding.revision,
          kind: 'selected',
          purpose: 'work',
          storageRef: fixture.binding.storageRef,
        },
        workspaceExists: () => true,
        workspaceId: fixture.workspaceId,
      });
    } finally {
      workspaceDb.sqlite.close();
    }
    await expect(
      fixture.operations.purge(
        { actor: fixture.actor, workspaceId: fixture.workspaceId },
        {
          confirmation: `purge-worker-environment:${fixture.binding.storageRef}:${fixture.binding.revision}`,
          expectedRevision: fixture.binding.revision,
          requestId: '00000000-0000-4000-8000-000000000004',
          storageRef: fixture.binding.storageRef,
        }
      )
    ).rejects.toMatchObject({ code: 'purge_blocked' });
    expect(purgeCalls).toBe(0);
  });
  it('lists and selects an exact idle environment without reserving it', () => {
    const fixture = createFixture();
    const context = { actor: fixture.actor, workspaceId: fixture.workspaceId };
    const listed = fixture.operations.list(context, { limit: 50 });
    const selected = fixture.operations.select(context, {
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
      items: [{ storageRef: fixture.binding.storageRef }],
      nextCursor: null,
    });
    expect(selected.selected).toMatchObject({
      revision: fixture.binding.revision,
      state: 'idle',
      storageRef: fixture.binding.storageRef,
    });
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
        ) VALUES ('user_other', 'Other Admin', 'other@example.com', false, ?, ?, 'human', 'active')`
      )
      .run(now, now);
    fixture.coreDb.sqlite
      .prepare(
        `INSERT INTO workspace_members (
          workspace_id, user_id, status, access_level, invitation_id,
          joined_at, removed_at, revision, created_at, updated_at
        ) VALUES (?, 'user_other', 'active', 'editor', NULL, ?, NULL, 1, ?, ?)`
      )
      .run(fixture.workspaceId, NOW, NOW, NOW);
    createOpenKitAccessTokenRecord(fixture.coreDb, {
      expiresAt: '2099-01-01T00:00:00.000Z',
      ownerUserId: 'user_other',
      scope: 'server-admin',
      tokenId: 'token_admin_other',
      workspaceIds: [],
    });

    expect(
      fixture.operations.list(
        { actor: { kind: 'session', userId: 'user_other' }, workspaceId: fixture.workspaceId },
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
         SET responsible_user_id = 'user_other'
         WHERE storage_ref = ?`
      )
      .run(fixture.binding.storageRef);

    await expect(fixture.operations.purge(context, input)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(purgeCalls).toBe(1);
  });
});
