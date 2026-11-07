import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { workerStorageWorkSlotRef } from './worker-governance-turn-executor.js';
import {
  activateWorkerStorageAttachment,
  admitWorkerStorageContributor,
  authorizeAttachedWorkerStorageReplacement,
  createAndReserveWorkerStorageAttachment,
  getWorkerStorageBinding,
  listWorkerStorageBindings,
  markWorkerStorageAttachmentUnknown,
  markWorkerStoragePurgePending,
  releaseWorkerStorageAttachment,
  reserveWorkerStorageAttachment,
  selectWorkerStorageBinding,
  settleWorkerStoragePurge,
  type WorkerStorageContributor,
  type WorkerStorageLayout,
  workerStorageLayoutDigest,
  workerStorageScopeDigest,
} from './worker-storage-bindings.js';

const NOW = '2026-09-10T00:00:00.000Z';
const LAYOUT: WorkerStorageLayout = {
  family: 'openkit-worker',
  version: '1',
  uid: 1000,
  gid: 1000,
  workingDirectory: '/tmp/openkit-bootstrap',
  platform: { architecture: 'amd64', os: 'linux' },
  targets: [{ target: '/workspace' }, { target: '/sandbox' }],
};

/** Creates one migrated Core database with its configured NanoHost target. */
function createCoreDb(): CoreDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-storage-'));
  const coreDb = openCoreDb(dataRoot);
  onTestFinished(() => {
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { force: true, recursive: true });
  });
  applyMigrations(coreDb);
  coreDb.sqlite
    .prepare(
      `INSERT INTO nanohost_runtime_targets (
         target_id, identity_id, deployment_id, connection_generation,
         predecessor_fenced, ready, fresh_empty, observed_at, slot_count
       ) VALUES ('target_1', 'identity_1', 'deployment_1', 1, 1, 1, 1, ?, 1)`
    )
    .run(NOW);
  return coreDb;
}

/** Drains the native owner before closing the Main view of its Core database. */
async function closeCoreDb(coreDb: CoreDb): Promise<void> {
  await shutdownControlStoreWorkerClient();
  if (coreDb.sqlite.open) coreDb.sqlite.close();
}

/** Creates and reserves one genuine association through its public owner. */
async function createReservedBinding(
  coreDb: CoreDb,
  workspaceId = 'ws_00000000-0000-73c3-900f-8d310e4ba201',
  seed = 'fixture'
) {
  return await createAndReserveWorkerStorageAttachment(coreDb, {
    agentSessionId: `session_${seed}`,
    authorizeContributor: allowContributor,
    deploymentId: 'deployment_1',
    layout: LAYOUT,
    now: NOW,
    purpose: 'work',
    responsibleUserId: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b',
    runtimeTargetId: 'target_1',
    threadId: `thread_${seed}`,
    workspaceId,
  });
}

/** Releases one genuine first reservation for idle-state tests. */
async function createBinding(
  coreDb: CoreDb,
  workspaceId = 'ws_00000000-0000-73c3-900f-8d310e4ba201',
  seed = 'fixture'
) {
  const reserved = await createReservedBinding(coreDb, workspaceId, seed);
  return await releaseWorkerStorageAttachment(coreDb, {
    attachmentGeneration: reserved.attachmentGeneration,
    cleanupProved: true,
    expectedRevision: reserved.revision,
    now: NOW,
    storageRef: reserved.storageRef,
  });
}

/** Allows every contributor in tests that are not exercising revocation. */
function allowContributor(_contributor: WorkerStorageContributor): boolean {
  return true;
}

/** Builds the exact selection facts for one binding revision. */
function selection(binding: Awaited<ReturnType<typeof createBinding>>) {
  return {
    authorizeContributor: allowContributor,
    expectedRevision: binding.revision,
    layout: LAYOUT,
    purpose: 'work' as const,
    responsibleUserId: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b',
    storageRef: binding.storageRef,
    threadId: 'thread_1',
    workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
  };
}

describe('Worker storage bindings', () => {
  it('creates and reserves one association atomically through the native owner', async () => {
    let coreDb = createCoreDb();
    const dataRoot = coreDb.dataRoot;
    try {
      coreDb.sqlite.exec('PRAGMA query_only = ON');
      const reserved = await createReservedBinding(coreDb, undefined, 'atomic');

      expect(reserved).toMatchObject({
        attachmentGeneration: 1,
        currentAgentSessionId: 'session_atomic',
        contributors: [
          expect.objectContaining({
            attachmentGeneration: 1,
            threadId: 'thread_atomic',
          }),
        ],
        revision: 2,
        state: 'reserved',
      });
      await closeCoreDb(coreDb);
      coreDb = openCoreDb(dataRoot);
      expect(getWorkerStorageBinding(coreDb, { storageRef: reserved.storageRef })).toEqual(
        reserved
      );
    } finally {
      await closeCoreDb(coreDb);
    }
  });

  it('publishes an existing binding reservation through the native owner while Main is query-only', async () => {
    const coreDb = createCoreDb();
    try {
      const binding = await createBinding(coreDb);
      coreDb.sqlite.exec('PRAGMA query_only = ON');

      const reserved = await reserveWorkerStorageAttachment(coreDb, {
        ...selection(binding),
        agentSessionId: 'session_native_owner',
        runtimeTargetId: 'target_1',
      });

      expect(reserved).toMatchObject({
        attachmentGeneration: binding.attachmentGeneration + 1,
        currentAgentSessionId: 'session_native_owner',
        revision: binding.revision + 1,
        state: 'reserved',
        storageRef: binding.storageRef,
      });
      expect(reserved.contributors.at(-1)).toMatchObject({ threadId: 'thread_1' });
      expect(getWorkerStorageBinding(coreDb, { storageRef: binding.storageRef })).toEqual(reserved);
    } finally {
      await closeCoreDb(coreDb);
    }
  });

  it('preserves an attached shared work slot when the native owner admits its next contributor', async () => {
    const coreDb = createCoreDb();
    try {
      const reserved = await createReservedBinding(coreDb, undefined, 'shared-owner');
      const attached = await activateWorkerStorageAttachment(coreDb, {
        attachmentGeneration: reserved.attachmentGeneration,
        expectedRevision: reserved.revision,
        sandboxBindingRef: 'sandbox_shared_owner',
        storageRef: reserved.storageRef,
        targets: reserved.targets.map((target) => ({ ...target, initialized: true })),
      });
      expect(attached.currentWorkSlotRef).toEqual(expect.any(String));
      const originalWorkSlotRef = attached.currentWorkSlotRef!;
      const sharedContributor = {
        ...selection(attached),
        responsibleUserId: 'usr_00000000-0000-7a71-a8b1-dcc65a83481f',
        reuseWorkSlotRef: originalWorkSlotRef,
        threadId: 'thread_shared_contributor',
      };
      coreDb.sqlite.exec('PRAGMA query_only = ON');

      const admitted = await admitWorkerStorageContributor(coreDb, sharedContributor);

      expect(admitted.currentWorkSlotRef).toBe(originalWorkSlotRef);
      expect(admitted.contributors).toHaveLength(2);
      expect(admitted.contributors.at(-1)).toMatchObject({
        responsibleUserId: sharedContributor.responsibleUserId,
        threadId: sharedContributor.threadId,
        workSlotRef: originalWorkSlotRef,
      });
    } finally {
      await closeCoreDb(coreDb);
    }
  });

  it('refuses a contributor whose authority changes after the native owner opens', async () => {
    const coreDb = createCoreDb();
    try {
      const binding = await createBinding(coreDb, undefined, 'revoked');
      const before = getWorkerStorageBinding(coreDb, { storageRef: binding.storageRef });
      let authorityChecks = 0;
      coreDb.sqlite.exec('PRAGMA query_only = ON');

      await expect(
        reserveWorkerStorageAttachment(coreDb, {
          ...selection(binding),
          agentSessionId: 'session_revoked',
          authorizeContributor: () => {
            authorityChecks += 1;
            return false;
          },
          runtimeTargetId: 'target_1',
        })
      ).rejects.toMatchObject({ code: 'authorization_denied' });

      expect(authorityChecks).toBe(1);
      expect(getWorkerStorageBinding(coreDb, { storageRef: binding.storageRef })).toEqual(before);
    } finally {
      await closeCoreDb(coreDb);
    }
  });

  it('writes v1 storage and reads inert target additions without changing retained identity', async () => {
    const coreDb = createCoreDb();
    try {
      const original = await createBinding(coreDb);
      const retained = JSON.stringify(
        original.targets.map((target) => ({
          ...target,
          description: { note: 'volume annotation' },
        }))
      );
      coreDb.sqlite
        .prepare('UPDATE worker_storage_bindings SET targets_json = ? WHERE storage_ref = ?')
        .run(retained, original.storageRef);
      expect(getWorkerStorageBinding(coreDb, { storageRef: original.storageRef })).toEqual(
        original
      );
      expect(
        coreDb.sqlite
          .prepare(
            'SELECT schema_version AS schemaVersion, targets_json AS bytes FROM worker_storage_bindings WHERE storage_ref = ?'
          )
          .get(original.storageRef)
      ).toEqual({ schemaVersion: 1, bytes: retained });
    } finally {
      await closeCoreDb(coreDb);
    }
  });

  it('refuses an unknown storage version before target decode or attachment reservation', async () => {
    const coreDb = createCoreDb();
    try {
      const original = await createBinding(coreDb);
      coreDb.sqlite
        .prepare(`UPDATE worker_storage_bindings SET schema_version = 2,
        targets_json = '{' WHERE storage_ref = ?`)
        .run(original.storageRef);
      coreDb.sqlite.exec(`CREATE TRIGGER reject_unsupported_storage_update BEFORE UPDATE ON worker_storage_bindings
        BEGIN SELECT RAISE(FAIL, 'Unsupported storage reached an UPDATE'); END`);
      expect(() => getWorkerStorageBinding(coreDb, { storageRef: original.storageRef })).toThrow(
        'Unsupported retained record format.'
      );
      expect(() =>
        listWorkerStorageBindings(coreDb, {
          authorizeContributor: allowContributor,
          workspaceId: original.workspaceId,
        })
      ).toThrow('Unsupported retained record format.');
      await expect(
        reserveWorkerStorageAttachment(coreDb, {
          ...selection(original),
          agentSessionId: 'session_unknown_version',
          runtimeTargetId: original.runtimeTargetId,
        })
      ).rejects.toThrow('Unsupported retained record format.');
      expect(
        coreDb.sqlite
          .prepare(`SELECT schema_version AS schemaVersion, targets_json, state, revision
        FROM worker_storage_bindings WHERE storage_ref = ?`)
          .get(original.storageRef)
      ).toEqual({
        schemaVersion: 2,
        targets_json: '{',
        state: original.state,
        revision: original.revision,
      });
    } finally {
      await closeCoreDb(coreDb);
    }
  });

  it.each([
    { active: 'true' },
    { initialized: null },
    { target: 'relative-path' },
    { requiredFeatures: ['future-attachment'] },
  ])(
    'refuses invalid or unsupported required retained target semantics %# without changing bytes',
    async (change) => {
      const coreDb = createCoreDb();
      try {
        const original = await createBinding(coreDb);
        const retained = JSON.stringify(
          original.targets.map((target) => ({ ...target, ...change }))
        );
        coreDb.sqlite
          .prepare('UPDATE worker_storage_bindings SET targets_json = ? WHERE storage_ref = ?')
          .run(retained, original.storageRef);
        expect(() =>
          getWorkerStorageBinding(coreDb, { storageRef: original.storageRef })
        ).toThrow();
        expect(
          coreDb.sqlite
            .prepare(
              'SELECT targets_json AS bytes FROM worker_storage_bindings WHERE storage_ref = ?'
            )
            .get(original.storageRef)
        ).toEqual({ bytes: retained });
      } finally {
        await closeCoreDb(coreDb);
      }
    }
  );

  it('refuses attachment generation exhaustion before changing storage or contributors', async () => {
    const coreDb = createCoreDb();
    try {
      const initial = await createBinding(coreDb);
      coreDb.sqlite
        .prepare(
          'UPDATE worker_storage_bindings SET attachment_generation = ? WHERE storage_ref = ?'
        )
        .run(Number.MAX_SAFE_INTEGER, initial.storageRef);
      const binding = getWorkerStorageBinding(coreDb, { storageRef: initial.storageRef })!;
      await expect(
        reserveWorkerStorageAttachment(coreDb, {
          ...selection(binding),
          agentSessionId: 'session_1',
          runtimeTargetId: 'target_1',
        })
      ).rejects.toThrow('attachment generation is exhausted');
      expect(getWorkerStorageBinding(coreDb, { storageRef: initial.storageRef })).toEqual(binding);
    } finally {
      await closeCoreDb(coreDb);
    }
  });

  it('authorizes only the exact selected revision attached to a replaced Sandbox', async () => {
    const coreDb = createCoreDb();
    try {
      const binding = await createBinding(coreDb);
      const reserved = await reserveWorkerStorageAttachment(coreDb, {
        ...selection(binding),
        agentSessionId: 'session_1',
        runtimeTargetId: 'target_1',
      });
      const attached = await activateWorkerStorageAttachment(coreDb, {
        attachmentGeneration: reserved.attachmentGeneration,
        expectedRevision: reserved.revision,
        sandboxBindingRef: 'sandbox_1',
        storageRef: binding.storageRef,
        targets: reserved.targets.map((target) => ({ ...target, initialized: true })),
      });

      expect(
        authorizeAttachedWorkerStorageReplacement(coreDb, {
          ...selection(attached),
          sandboxBindingRef: 'sandbox_1',
        })
      ).toMatchObject({ revision: attached.revision, state: 'attached' });
      expect(() =>
        authorizeAttachedWorkerStorageReplacement(coreDb, {
          ...selection(attached),
          expectedRevision: attached.revision - 1,
          sandboxBindingRef: 'sandbox_1',
        })
      ).toThrow('revision changed');
      expect(() =>
        authorizeAttachedWorkerStorageReplacement(coreDb, {
          ...selection(attached),
          sandboxBindingRef: 'sandbox_other',
        })
      ).toThrow('not attached to the Sandbox being replaced');
      expect(() =>
        authorizeAttachedWorkerStorageReplacement(coreDb, {
          ...selection(attached),
          reuseWorkSlotRef: 'wsl_unrelated',
          sandboxBindingRef: 'sandbox_1',
        })
      ).toThrow('work slot is unavailable');
    } finally {
      await closeCoreDb(coreDb);
    }
  });

  it('stores a host-verifiable layout and exposes only currently authorized candidates', async () => {
    const coreDb = createCoreDb();
    try {
      const binding = await createBinding(coreDb);
      const canonical = JSON.stringify({
        family: 'openkit-worker',
        version: '1',
        uid: 1000,
        gid: 1000,
        workingDirectory: '/tmp/openkit-bootstrap',
        platform: { architecture: 'amd64', os: 'linux' },
        targets: [{ target: '/sandbox' }, { target: '/workspace' }],
      });
      expect(binding).toMatchObject({
        attachmentGeneration: 1,
        contributors: [
          expect.objectContaining({
            attachmentGeneration: 1,
            threadId: 'thread_fixture',
          }),
        ],
        layoutDigest: `sha256:${createHash('sha256').update(canonical).digest('hex')}`,
        revision: 3,
        scopeDigest: workerStorageScopeDigest('ws_00000000-0000-73c3-900f-8d310e4ba201'),
        state: 'idle',
        workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
      });
      expect(workerStorageLayoutDigest(LAYOUT)).toBe(binding.layoutDigest);
      expect(binding.targets.map(({ initialized, target }) => ({ initialized, target }))).toEqual([
        { initialized: false, target: '/sandbox' },
        { initialized: false, target: '/workspace' },
      ]);

      const reserved = await reserveWorkerStorageAttachment(coreDb, {
        ...selection(binding),
        agentSessionId: 'session_1',
        runtimeTargetId: 'target_1',
      });
      expect(
        listWorkerStorageBindings(coreDb, {
          authorizeContributor: allowContributor,
          workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
        })
      ).toHaveLength(1);
      expect(
        listWorkerStorageBindings(coreDb, {
          authorizeContributor: () => false,
          workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
        })
      ).toEqual([]);
      expect(reserved.contributors).toHaveLength(2);
    } finally {
      await closeCoreDb(coreDb);
    }
  });

  it('rejects cross-Workspace, revoked-audience, and contributor-contaminated review reuse', async () => {
    const coreDb = createCoreDb();
    try {
      const binding = await createBinding(coreDb);
      const reserved = await reserveWorkerStorageAttachment(coreDb, {
        ...selection(binding),
        agentSessionId: 'session_1',
        runtimeTargetId: 'target_1',
      });
      const attached = await activateWorkerStorageAttachment(coreDb, {
        attachmentGeneration: reserved.attachmentGeneration,
        expectedRevision: reserved.revision,
        sandboxBindingRef: 'sandbox_1',
        storageRef: binding.storageRef,
        targets: reserved.targets.map((target) => ({ ...target, initialized: true })),
      });
      const idle = await releaseWorkerStorageAttachment(coreDb, {
        attachmentGeneration: attached.attachmentGeneration,
        cleanupProved: true,
        expectedRevision: attached.revision,
        sandboxBindingRef: 'sandbox_1',
        storageRef: binding.storageRef,
      });

      expect(() =>
        selectWorkerStorageBinding(coreDb, {
          ...selection(idle),
          workspaceId: 'ws_00000000-0000-7fee-b878-266b367d3b31',
        })
      ).toThrow('cannot cross Workspaces');
      expect(() =>
        selectWorkerStorageBinding(coreDb, {
          ...selection(idle),
          authorizeContributor: () => false,
        })
      ).toThrow('audience is no longer authorized');
      expect(() =>
        selectWorkerStorageBinding(coreDb, {
          ...selection(idle),
          adjudicatedThreadIds: ['thread_1'],
          purpose: 'independent-review',
          threadId: 'review_thread',
        })
      ).toThrow('Independent review cannot reuse contributor storage');
      for (const adjudicatedThreadIds of [[], ['unrelated_thread']]) {
        expect(() =>
          selectWorkerStorageBinding(coreDb, {
            ...selection(idle),
            adjudicatedThreadIds,
            purpose: 'independent-review',
            threadId: 'review_thread',
          })
        ).toThrow('Independent review cannot reuse contributor storage');
      }
    } finally {
      await closeCoreDb(coreDb);
    }
  });

  it('does not disclose one user contributor history to another member of the same Workspace', async () => {
    const coreDb = createCoreDb();
    try {
      const binding = await createBinding(coreDb);
      const reserved = await reserveWorkerStorageAttachment(coreDb, {
        ...selection(binding),
        agentSessionId: 'session_1',
        runtimeTargetId: 'target_1',
      });
      const attached = await activateWorkerStorageAttachment(coreDb, {
        attachmentGeneration: reserved.attachmentGeneration,
        expectedRevision: reserved.revision,
        sandboxBindingRef: 'sandbox_1',
        storageRef: binding.storageRef,
        targets: reserved.targets.map((target) => ({ ...target, initialized: true })),
      });
      const idle = await releaseWorkerStorageAttachment(coreDb, {
        attachmentGeneration: attached.attachmentGeneration,
        cleanupProved: true,
        expectedRevision: attached.revision,
        sandboxBindingRef: 'sandbox_1',
        storageRef: binding.storageRef,
      });

      expect(() =>
        selectWorkerStorageBinding(coreDb, {
          ...selection(idle),
          authorizeContributor: (contributor) =>
            contributor.responsibleUserId === 'usr_00000000-0000-7a71-a8b1-dcc65a83481f',
          responsibleUserId: 'usr_00000000-0000-7a71-a8b1-dcc65a83481f',
          threadId: 'thread_2',
        })
      ).toThrow('audience is no longer authorized');
      expect(
        listWorkerStorageBindings(coreDb, {
          authorizeContributor: (contributor) =>
            contributor.responsibleUserId === 'usr_00000000-0000-7a71-a8b1-dcc65a83481f',
          workspaceId: 'ws_00000000-0000-73c3-900f-8d310e4ba201',
        })
      ).toEqual([]);
    } finally {
      await closeCoreDb(coreDb);
    }
  });

  it('uses CAS to reject competing writers and preserves lineage across detach', async () => {
    const coreDb = createCoreDb();
    try {
      const binding = await createBinding(coreDb);
      coreDb.sqlite.exec('PRAGMA query_only = ON');
      const first = await reserveWorkerStorageAttachment(coreDb, {
        ...selection(binding),
        agentSessionId: 'session_1',
        runtimeTargetId: 'target_1',
      });
      await expect(
        reserveWorkerStorageAttachment(coreDb, {
          ...selection(binding),
          agentSessionId: 'session_competing',
          runtimeTargetId: 'target_1',
        })
      ).rejects.toThrow();

      await expect(
        activateWorkerStorageAttachment(coreDb, {
          attachmentGeneration: first.attachmentGeneration + 1,
          expectedRevision: first.revision,
          sandboxBindingRef: 'sandbox_stale',
          storageRef: binding.storageRef,
          targets: first.targets.map((target) => ({ ...target, initialized: true })),
        })
      ).rejects.toThrow('revision changed');
      expect(getWorkerStorageBinding(coreDb, { storageRef: binding.storageRef })).toEqual(first);

      const attached = await activateWorkerStorageAttachment(coreDb, {
        attachmentGeneration: first.attachmentGeneration,
        expectedRevision: first.revision,
        sandboxBindingRef: 'sandbox_1',
        storageRef: binding.storageRef,
        targets: first.targets.map((target) => ({ ...target, initialized: true })),
      });
      await expect(
        releaseWorkerStorageAttachment(coreDb, {
          attachmentGeneration: attached.attachmentGeneration,
          cleanupProved: false,
          expectedRevision: attached.revision,
          sandboxBindingRef: 'sandbox_1',
          storageRef: binding.storageRef,
        })
      ).rejects.toThrow('cleanup is not proved');
      const idle = await releaseWorkerStorageAttachment(coreDb, {
        attachmentGeneration: attached.attachmentGeneration,
        cleanupProved: true,
        expectedRevision: attached.revision,
        sandboxBindingRef: 'sandbox_1',
        storageRef: binding.storageRef,
      });
      const successor = await reserveWorkerStorageAttachment(coreDb, {
        ...selection(idle),
        agentSessionId: 'session_2',
        runtimeTargetId: 'target_1',
        threadId: 'thread_2',
      });
      expect(successor.attachmentGeneration).toBe(first.attachmentGeneration + 1);
      expect(successor.contributors).toHaveLength(first.contributors.length + 1);
      expect(successor.currentWorkSlotRef).not.toBe(first.currentWorkSlotRef);
      await expect(
        reserveWorkerStorageAttachment(coreDb, {
          ...selection(successor),
          agentSessionId: 'session_3',
          reuseWorkSlotRef: first.currentWorkSlotRef!,
          runtimeTargetId: 'target_1',
          threadId: 'thread_3',
        })
      ).rejects.toThrow('already has an attachment');
      const successorAttached = await activateWorkerStorageAttachment(coreDb, {
        attachmentGeneration: successor.attachmentGeneration,
        expectedRevision: successor.revision,
        sandboxBindingRef: 'sandbox_2',
        storageRef: binding.storageRef,
        targets: successor.targets.map((target) => ({ ...target, initialized: true })),
      });
      const successorIdle = await releaseWorkerStorageAttachment(coreDb, {
        attachmentGeneration: successorAttached.attachmentGeneration,
        cleanupProved: true,
        expectedRevision: successorAttached.revision,
        sandboxBindingRef: 'sandbox_2',
        storageRef: binding.storageRef,
      });
      const transferred = await reserveWorkerStorageAttachment(coreDb, {
        ...selection(successorIdle),
        agentSessionId: 'session_3',
        reuseWorkSlotRef: first.currentWorkSlotRef!,
        runtimeTargetId: 'target_1',
        threadId: 'thread_3',
      });
      expect(transferred.currentWorkSlotRef).toBe(first.currentWorkSlotRef);
      expect(
        workerStorageWorkSlotRef(
          {
            kind: 'selected',
            storageRef: transferred.storageRef,
            expectedRevision: transferred.revision,
            purpose: 'work',
            goalId: null,
            taskId: null,
          },
          'ws_00000000-0000-73c3-900f-8d310e4ba201',
          'thread_3',
          coreDb,
          'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b'
        )
      ).toBe(first.currentWorkSlotRef);
    } finally {
      await closeCoreDb(coreDb);
    }
  });

  it('adds targets once and retains removed target identities across a compatible image change', async () => {
    const coreDb = createCoreDb();
    try {
      const binding = await createBinding(coreDb);
      const firstReservation = await reserveWorkerStorageAttachment(coreDb, {
        ...selection(binding),
        agentSessionId: 'session_before_image_change',
        runtimeTargetId: 'target_1',
      });
      const firstAttachment = await activateWorkerStorageAttachment(coreDb, {
        attachmentGeneration: firstReservation.attachmentGeneration,
        expectedRevision: firstReservation.revision,
        sandboxBindingRef: 'sandbox_before_image_change',
        storageRef: binding.storageRef,
        targets: firstReservation.targets.map((target) => ({ ...target, initialized: true })),
      });
      const idle = await releaseWorkerStorageAttachment(coreDb, {
        attachmentGeneration: firstAttachment.attachmentGeneration,
        cleanupProved: true,
        expectedRevision: firstAttachment.revision,
        sandboxBindingRef: 'sandbox_before_image_change',
        storageRef: binding.storageRef,
      });
      const changedLayout: WorkerStorageLayout = {
        ...LAYOUT,
        targets: [{ target: '/workspace' }, { target: '/data' }],
      };

      const changed = await reserveWorkerStorageAttachment(coreDb, {
        ...selection(idle),
        agentSessionId: 'session_after_image_change',
        expectedRevision: idle.revision,
        layout: changedLayout,
        runtimeTargetId: 'target_1',
      });
      expect(changed.layout.targets).toEqual([{ target: '/data' }, { target: '/workspace' }]);
      expect(changed.targets).toEqual([
        expect.objectContaining({ active: true, initialized: false, target: '/data' }),
        expect.objectContaining({ active: false, initialized: true, target: '/sandbox' }),
        expect.objectContaining({ active: true, initialized: true, target: '/workspace' }),
      ]);

      const attached = await activateWorkerStorageAttachment(coreDb, {
        attachmentGeneration: changed.attachmentGeneration,
        expectedRevision: changed.revision,
        sandboxBindingRef: 'sandbox_after_image_change',
        storageRef: changed.storageRef,
        targets: changed.targets
          .filter(({ active }) => active)
          .map((target) => ({ ...target, initialized: true })),
      });
      expect(attached.targets.find(({ target }) => target === '/sandbox')).toMatchObject({
        active: false,
        initialized: true,
      });
      expect(attached.targets.find(({ target }) => target === '/data')).toMatchObject({
        active: true,
        initialized: true,
      });
    } finally {
      await closeCoreDb(coreDb);
    }
  });

  it('fences uncertain attachments and requires explicit authorized purge settlement', async () => {
    const coreDb = createCoreDb();
    try {
      const binding = await createBinding(coreDb);
      const purgeable = await createBinding(coreDb, undefined, 'purgeable');
      coreDb.sqlite.exec('PRAGMA query_only = ON');
      const reserved = await reserveWorkerStorageAttachment(coreDb, {
        ...selection(binding),
        agentSessionId: 'session_1',
        runtimeTargetId: 'target_1',
      });
      const unknown = await markWorkerStorageAttachmentUnknown(coreDb, {
        attachmentGeneration: reserved.attachmentGeneration,
        expectedRevision: reserved.revision,
        storageRef: binding.storageRef,
      });
      expect(unknown.state).toBe('unknown');
      expect(() => selectWorkerStorageBinding(coreDb, { ...selection(unknown) })).toThrow(
        'storage is fenced'
      );
      expect(
        (
          await releaseWorkerStorageAttachment(coreDb, {
            attachmentGeneration: unknown.attachmentGeneration,
            cleanupProved: true,
            expectedRevision: unknown.revision,
            storageRef: unknown.storageRef,
          })
        ).state
      ).toBe('idle');

      await expect(
        markWorkerStoragePurgePending(coreDb, {
          authorizePurge: () => false,
          expectedRevision: purgeable.revision,
          hasSurvivingReferences: () => false,
          storageRef: purgeable.storageRef,
        })
      ).rejects.toThrow('purge is not authorized');
      const pending = await markWorkerStoragePurgePending(coreDb, {
        authorizePurge: () => true,
        expectedRevision: purgeable.revision,
        hasSurvivingReferences: () => false,
        storageRef: purgeable.storageRef,
      });
      const settled = await settleWorkerStoragePurge(coreDb, {
        expectedRevision: pending.revision,
        outcome: 'unknown',
        storageRef: purgeable.storageRef,
      });
      expect(settled.state).toBe('unknown');
      expect(getWorkerStorageBinding(coreDb, { storageRef: purgeable.storageRef })).toEqual(
        settled
      );
      await expect(
        settleWorkerStoragePurge(coreDb, {
          expectedRevision: pending.revision,
          outcome: 'purged',
          storageRef: purgeable.storageRef,
        })
      ).rejects.toThrow('revision changed');
      expect(getWorkerStorageBinding(coreDb, { storageRef: purgeable.storageRef })).toEqual(
        settled
      );
    } finally {
      await closeCoreDb(coreDb);
    }
  });
});
