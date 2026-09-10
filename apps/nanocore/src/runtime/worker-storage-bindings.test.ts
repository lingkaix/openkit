import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { goalChildWorkerStorageChoice } from '../goal-routes.js';
import { type CoreDb, openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { workerStorageWorkSlotRef } from './worker-governance-turn-executor.js';
import {
  activateWorkerStorageAttachment,
  admitWorkerStorageContributor,
  authorizeAttachedWorkerStorageReplacement,
  createWorkerStorageBinding,
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
  const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-storage-')));
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

/** Creates one empty storage association on the fixture target. */
function createBinding(coreDb: CoreDb, workspaceId = 'ws_1') {
  return createWorkerStorageBinding(coreDb, {
    deploymentId: 'deployment_1',
    layout: LAYOUT,
    now: NOW,
    runtimeTargetId: 'target_1',
    workspaceId,
  });
}

/** Allows every contributor in tests that are not exercising revocation. */
function allowContributor(_contributor: WorkerStorageContributor): boolean {
  return true;
}

/** Builds the exact selection facts for one binding revision. */
function selection(binding: ReturnType<typeof createBinding>) {
  return {
    authorizeContributor: allowContributor,
    expectedRevision: binding.revision,
    layout: LAYOUT,
    purpose: 'work' as const,
    responsibleUserId: 'user_1',
    storageRef: binding.storageRef,
    threadId: 'thread_1',
    workspaceId: 'ws_1',
  };
}

describe('Worker storage bindings', () => {
  it('authorizes only the exact selected revision attached to a replaced Sandbox', () => {
    const coreDb = createCoreDb();
    try {
      const binding = createBinding(coreDb);
      const reserved = reserveWorkerStorageAttachment(coreDb, {
        ...selection(binding),
        agentSessionId: 'session_1',
        runtimeTargetId: 'target_1',
      });
      const attached = activateWorkerStorageAttachment(coreDb, {
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
      coreDb.sqlite.close();
    }
  });

  it('does not refresh a Goal baseline across another contributor in the same attachment generation', () => {
    const coreDb = createCoreDb();
    try {
      const binding = createBinding(coreDb);
      const reserved = reserveWorkerStorageAttachment(coreDb, {
        ...selection(binding),
        goalId: 'goal_1',
        taskId: 'task_1',
        agentSessionId: 'session_1',
        runtimeTargetId: 'target_1',
      });
      const attached = activateWorkerStorageAttachment(coreDb, {
        attachmentGeneration: reserved.attachmentGeneration,
        expectedRevision: reserved.revision,
        sandboxBindingRef: 'sandbox_1',
        storageRef: binding.storageRef,
        targets: reserved.targets.map((target) => ({ ...target, initialized: true })),
      });
      const goal = {
        goalId: 'goal_1',
        workspaceId: 'ws_1',
        threadId: 'thread_1',
        workerStorageChoice: {
          kind: 'selected' as const,
          expectedRevision: binding.revision,
          purpose: 'work' as const,
          storageRef: binding.storageRef,
        },
      };
      expect(goalChildWorkerStorageChoice(coreDb, goal, { taskId: 'task_2' })).toMatchObject({
        expectedRevision: attached.revision,
      });
      admitWorkerStorageContributor(coreDb, {
        ...selection(attached),
        threadId: 'thread_2',
        goalId: 'goal_2',
      });
      expect(goalChildWorkerStorageChoice(coreDb, goal, { taskId: 'task_2' })).toMatchObject({
        expectedRevision: binding.revision,
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('stores a host-verifiable layout and exposes only currently authorized candidates', () => {
    const coreDb = createCoreDb();
    try {
      const binding = createBinding(coreDb);
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
        attachmentGeneration: 0,
        contributors: [],
        layoutDigest: `sha256:${createHash('sha256').update(canonical).digest('hex')}`,
        revision: 1,
        scopeDigest: workerStorageScopeDigest('ws_1'),
        state: 'idle',
        workspaceId: 'ws_1',
      });
      expect(workerStorageLayoutDigest(LAYOUT)).toBe(binding.layoutDigest);
      expect(binding.targets.map(({ initialized, target }) => ({ initialized, target }))).toEqual([
        { initialized: false, target: '/sandbox' },
        { initialized: false, target: '/workspace' },
      ]);

      const reserved = reserveWorkerStorageAttachment(coreDb, {
        ...selection(binding),
        agentSessionId: 'session_1',
        runtimeTargetId: 'target_1',
      });
      expect(
        listWorkerStorageBindings(coreDb, {
          authorizeContributor: allowContributor,
          workspaceId: 'ws_1',
        })
      ).toHaveLength(1);
      expect(
        listWorkerStorageBindings(coreDb, {
          authorizeContributor: () => false,
          workspaceId: 'ws_1',
        })
      ).toEqual([]);
      expect(reserved.contributors).toHaveLength(1);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects cross-Workspace, revoked-audience, and contributor-contaminated review reuse', () => {
    const coreDb = createCoreDb();
    try {
      const binding = createBinding(coreDb);
      const reserved = reserveWorkerStorageAttachment(coreDb, {
        ...selection(binding),
        agentSessionId: 'session_1',
        runtimeTargetId: 'target_1',
      });
      const attached = activateWorkerStorageAttachment(coreDb, {
        attachmentGeneration: reserved.attachmentGeneration,
        expectedRevision: reserved.revision,
        sandboxBindingRef: 'sandbox_1',
        storageRef: binding.storageRef,
        targets: reserved.targets.map((target) => ({ ...target, initialized: true })),
      });
      const idle = releaseWorkerStorageAttachment(coreDb, {
        attachmentGeneration: attached.attachmentGeneration,
        cleanupProved: true,
        expectedRevision: attached.revision,
        sandboxBindingRef: 'sandbox_1',
        storageRef: binding.storageRef,
      });

      expect(() =>
        selectWorkerStorageBinding(coreDb, {
          ...selection(idle),
          workspaceId: 'ws_2',
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
      coreDb.sqlite.close();
    }
  });

  it('does not disclose one user contributor history to another member of the same Workspace', () => {
    const coreDb = createCoreDb();
    try {
      const binding = createBinding(coreDb);
      const reserved = reserveWorkerStorageAttachment(coreDb, {
        ...selection(binding),
        agentSessionId: 'session_1',
        runtimeTargetId: 'target_1',
      });
      const attached = activateWorkerStorageAttachment(coreDb, {
        attachmentGeneration: reserved.attachmentGeneration,
        expectedRevision: reserved.revision,
        sandboxBindingRef: 'sandbox_1',
        storageRef: binding.storageRef,
        targets: reserved.targets.map((target) => ({ ...target, initialized: true })),
      });
      const idle = releaseWorkerStorageAttachment(coreDb, {
        attachmentGeneration: attached.attachmentGeneration,
        cleanupProved: true,
        expectedRevision: attached.revision,
        sandboxBindingRef: 'sandbox_1',
        storageRef: binding.storageRef,
      });

      expect(() =>
        selectWorkerStorageBinding(coreDb, {
          ...selection(idle),
          authorizeContributor: (contributor) => contributor.responsibleUserId === 'user_2',
          responsibleUserId: 'user_2',
          threadId: 'thread_2',
        })
      ).toThrow('audience is no longer authorized');
      expect(
        listWorkerStorageBindings(coreDb, {
          authorizeContributor: (contributor) => contributor.responsibleUserId === 'user_2',
          workspaceId: 'ws_1',
        })
      ).toEqual([]);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('uses CAS to reject competing writers and preserves lineage across detach', () => {
    const coreDb = createCoreDb();
    try {
      const binding = createBinding(coreDb);
      const first = reserveWorkerStorageAttachment(coreDb, {
        ...selection(binding),
        agentSessionId: 'session_1',
        runtimeTargetId: 'target_1',
      });
      expect(() =>
        reserveWorkerStorageAttachment(coreDb, {
          ...selection(binding),
          agentSessionId: 'session_competing',
          runtimeTargetId: 'target_1',
        })
      ).toThrow();

      const attached = activateWorkerStorageAttachment(coreDb, {
        attachmentGeneration: first.attachmentGeneration,
        expectedRevision: first.revision,
        sandboxBindingRef: 'sandbox_1',
        storageRef: binding.storageRef,
        targets: first.targets.map((target) => ({ ...target, initialized: true })),
      });
      expect(() =>
        releaseWorkerStorageAttachment(coreDb, {
          attachmentGeneration: attached.attachmentGeneration,
          cleanupProved: false,
          expectedRevision: attached.revision,
          sandboxBindingRef: 'sandbox_1',
          storageRef: binding.storageRef,
        })
      ).toThrow('cleanup is not proved');
      const idle = releaseWorkerStorageAttachment(coreDb, {
        attachmentGeneration: attached.attachmentGeneration,
        cleanupProved: true,
        expectedRevision: attached.revision,
        sandboxBindingRef: 'sandbox_1',
        storageRef: binding.storageRef,
      });
      const successor = reserveWorkerStorageAttachment(coreDb, {
        ...selection(idle),
        agentSessionId: 'session_2',
        runtimeTargetId: 'target_1',
        threadId: 'thread_2',
      });
      expect(successor.attachmentGeneration).toBe(2);
      expect(successor.contributors).toHaveLength(2);
      expect(successor.currentWorkSlotRef).not.toBe(first.currentWorkSlotRef);
      expect(() =>
        reserveWorkerStorageAttachment(coreDb, {
          ...selection(successor),
          agentSessionId: 'session_3',
          reuseWorkSlotRef: first.currentWorkSlotRef!,
          runtimeTargetId: 'target_1',
          threadId: 'thread_3',
        })
      ).toThrow('already has an attachment');
      const successorAttached = activateWorkerStorageAttachment(coreDb, {
        attachmentGeneration: successor.attachmentGeneration,
        expectedRevision: successor.revision,
        sandboxBindingRef: 'sandbox_2',
        storageRef: binding.storageRef,
        targets: successor.targets.map((target) => ({ ...target, initialized: true })),
      });
      const successorIdle = releaseWorkerStorageAttachment(coreDb, {
        attachmentGeneration: successorAttached.attachmentGeneration,
        cleanupProved: true,
        expectedRevision: successorAttached.revision,
        sandboxBindingRef: 'sandbox_2',
        storageRef: binding.storageRef,
      });
      const transferred = reserveWorkerStorageAttachment(coreDb, {
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
          'ws_1',
          'thread_3',
          coreDb,
          'user_1'
        )
      ).toBe(first.currentWorkSlotRef);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('adds targets once and retains removed target identities across a compatible image change', () => {
    const coreDb = createCoreDb();
    try {
      const binding = createBinding(coreDb);
      const firstReservation = reserveWorkerStorageAttachment(coreDb, {
        ...selection(binding),
        agentSessionId: 'session_before_image_change',
        runtimeTargetId: 'target_1',
      });
      const firstAttachment = activateWorkerStorageAttachment(coreDb, {
        attachmentGeneration: firstReservation.attachmentGeneration,
        expectedRevision: firstReservation.revision,
        sandboxBindingRef: 'sandbox_before_image_change',
        storageRef: binding.storageRef,
        targets: firstReservation.targets.map((target) => ({ ...target, initialized: true })),
      });
      const idle = releaseWorkerStorageAttachment(coreDb, {
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

      const changed = reserveWorkerStorageAttachment(coreDb, {
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

      const attached = activateWorkerStorageAttachment(coreDb, {
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
      coreDb.sqlite.close();
    }
  });

  it('fences uncertain attachments and requires explicit authorized purge settlement', () => {
    const coreDb = createCoreDb();
    try {
      const binding = createBinding(coreDb);
      const reserved = reserveWorkerStorageAttachment(coreDb, {
        ...selection(binding),
        agentSessionId: 'session_1',
        runtimeTargetId: 'target_1',
      });
      const unknown = markWorkerStorageAttachmentUnknown(coreDb, {
        attachmentGeneration: reserved.attachmentGeneration,
        expectedRevision: reserved.revision,
        storageRef: binding.storageRef,
      });
      expect(unknown.state).toBe('unknown');
      expect(() => selectWorkerStorageBinding(coreDb, { ...selection(unknown) })).toThrow(
        'storage is fenced'
      );
      expect(
        releaseWorkerStorageAttachment(coreDb, {
          attachmentGeneration: unknown.attachmentGeneration,
          cleanupProved: true,
          expectedRevision: unknown.revision,
          storageRef: unknown.storageRef,
        }).state
      ).toBe('idle');

      const purgeable = createBinding(coreDb);
      expect(() =>
        markWorkerStoragePurgePending(coreDb, {
          authorizePurge: () => false,
          expectedRevision: purgeable.revision,
          hasSurvivingReferences: () => false,
          storageRef: purgeable.storageRef,
        })
      ).toThrow('purge is not authorized');
      const pending = markWorkerStoragePurgePending(coreDb, {
        authorizePurge: () => true,
        expectedRevision: purgeable.revision,
        hasSurvivingReferences: () => false,
        storageRef: purgeable.storageRef,
      });
      const settled = settleWorkerStoragePurge(coreDb, {
        expectedRevision: pending.revision,
        outcome: 'unknown',
        storageRef: purgeable.storageRef,
      });
      expect(settled.state).toBe('unknown');
      expect(getWorkerStorageBinding(coreDb, { storageRef: purgeable.storageRef })).toEqual(
        settled
      );
    } finally {
      coreDb.sqlite.close();
    }
  });
});
