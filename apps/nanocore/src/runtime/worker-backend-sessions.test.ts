import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker as NativeWorker } from 'node:worker_threads';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import {
  ControlStoreWorkerError,
  shutdownControlStoreWorkerClient,
} from '../storage/control-store-worker-client.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import * as attemptActionOwners from './execution-attempt-records.js';
import {
  allocateNanoHostRuntimeTargetConnectionGeneration,
  upsertNanoHostRuntimeTarget,
} from './nanohost-runtime-target.js';
import {
  getWorkerBackendSession,
  markWorkerBackendSessionLaunching,
  markWorkerBackendWorkspaceHandoffComplete,
  recordWorkerBackendSessionMaterializing,
  retireOrphanWorkerBackendSession,
  transitionWorkerBackendSessionState,
} from './worker-backend-sessions.js';

/** Creates one dispatched lease in an isolated Core database. */
async function createFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-worker-backend-session-'));
  const coreDb = openCoreDb(dataRoot);
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { force: true, recursive: true });
  });
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({
    coreDb,
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
  });
  const entry = createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    triggerActor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
    profileRef: 'profile_worker',
    queueEntryId: 'queue_backend_session',
    requestedAgentId: 'agent_codex_host',
    threadId: testEntityId('th', 'thread_backend_session'),
    turnId: 'tu_00000000-0000-7a07-9f58-6d0e7a18a11c',
    turnInput: 'Run worker',
    workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    now: () => '2026-07-15T00:00:01.000Z',
  });
  recordTestExecutionAttempt(coreDb, {
    entry,
    attemptId: testEntityId('attempt', 'lease_backend_session'),
    agentSessionId: 'as_00000000-0000-741c-b104-26abc3a228bc',
    inputRef: 'aepsnap_backend_session',
    bindingRef: 'lease-binding:lease_backend_session',
    sessionCompatibilityKey: 'fixture-compatibility',
    now: () => '2026-07-15T00:00:02.000Z',
  });
  const target = await allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
    deploymentId: 'deployment-test',
    identityId: 'nanohost-test',
    observedAt: '2026-07-15T00:00:02.500Z',
    targetId: 'runtime-target-test',
  });
  await upsertNanoHostRuntimeTarget(coreDb, {
    ...target,
    freshEmpty: true,
    observedAt: '2026-07-15T00:00:02.750Z',
    physicalEpoch: 'a'.repeat(64),
    predecessorFenced: true,
    ready: true,
  });
  return coreDb;
}

/** Returns the canonical materializing insert input. */
function materializingInput() {
  return {
    backendLineage: {
      buildArgumentsDigest: 'sha256:arguments',
      buildContextDigest: 'sha256:context',
      buildInputDigest: 'sha256:dockerfile',
      kind: 'build',
      resultingImageDigest: 'sha256:image',
    },
    backendVersion: '0.0.99',
    identity: {
      agentSessionId: 'as_00000000-0000-741c-b104-26abc3a228bc',
      backendKind: 'openshell',
      backendSessionId: 'openkit-as_backend_session',
      deploymentId: 'deployment-test',
      packageSnapshotId: 'aepsnap_backend_session',
      runtimeTargetId: 'runtime-target-test',
      stagingDirectoryRef: 'server/runtime/worker-backend-sessions/aepsnap_backend_session',
      transientProviderInstanceId: 'okp-deployment-test-worker-inference-backend-session',
    },
    lineage: {
      threadId: testEntityId('th', 'thread_backend_session'),
      turnId: 'tu_00000000-0000-7a07-9f58-6d0e7a18a11c',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    },
    now: () => '2026-07-15T00:00:03.000Z',
    sandboxBindingRef: 'lease-binding:lease_backend_session',
  } as const;
}

describe('worker backend sessions', () => {
  it.each(['reference', 'build'] as const)(
    'reads retained %s lineage annotations without reminting or rewriting identity',
    async (kind) => {
      const coreDb = await createFixture();
      try {
        const input = materializingInput();
        const original = await recordWorkerBackendSessionMaterializing(coreDb, {
          ...input,
          backendLineage:
            kind === 'reference'
              ? { kind: 'reference', imageRef: 'registry.example/worker@sha256:image' }
              : input.backendLineage,
        });
        const retained = JSON.stringify({
          ...original.backendLineage,
          description: { source: 'build annotation' },
        });
        coreDb.sqlite
          .prepare(
            'UPDATE worker_backend_sessions SET backend_lineage_json = ? WHERE attempt_id = ?'
          )
          .run(retained, original.attemptId);
        expect(getWorkerBackendSession(coreDb, original.attemptId)).toEqual(original);
        expect(
          coreDb.sqlite
            .prepare(
              'SELECT backend_lineage_json AS bytes FROM worker_backend_sessions WHERE attempt_id = ?'
            )
            .get(original.attemptId)
        ).toEqual({ bytes: retained });
      } finally {
        coreDb.sqlite.close();
      }
    }
  );

  it.each([
    { imageRef: 'registry.example/worker', kind: 'future-lineage' },
    { imageRef: 'registry.example/worker', requiredFeatures: ['future-proof'] },
    {
      buildArgumentsDigest: 'sha256:arguments',
      buildContextDigest: 'sha256:context',
      buildInputDigest: 'sha256:input',
      resultingImageDigest: null,
    },
  ])(
    'refuses unknown or invalid required retained backend lineage %# without rewriting it',
    async (lineage) => {
      const coreDb = await createFixture();
      try {
        const original = await recordWorkerBackendSessionMaterializing(
          coreDb,
          materializingInput()
        );
        const retained = JSON.stringify(lineage);
        coreDb.sqlite
          .prepare(
            'UPDATE worker_backend_sessions SET backend_lineage_json = ? WHERE attempt_id = ?'
          )
          .run(retained, original.attemptId);
        expect(() => getWorkerBackendSession(coreDb, original.attemptId)).toThrow();
        expect(
          coreDb.sqlite
            .prepare(
              'SELECT backend_lineage_json AS bytes FROM worker_backend_sessions WHERE attempt_id = ?'
            )
            .get(original.attemptId)
        ).toEqual({ bytes: retained });
      } finally {
        coreDb.sqlite.close();
      }
    }
  );

  it('persists v1 package-scoped identity before materialization and accepts exact replay', async () => {
    const coreDb = await createFixture();

    try {
      const first = await recordWorkerBackendSessionMaterializing(coreDb, materializingInput());
      const replay = await recordWorkerBackendSessionMaterializing(coreDb, materializingInput());

      expect(first).toEqual({
        agentSessionId: 'as_00000000-0000-741c-b104-26abc3a228bc',
        backendKind: 'openshell',
        deploymentId: 'deployment-test',
        backendLineage: {
          buildArgumentsDigest: 'sha256:arguments',
          buildContextDigest: 'sha256:context',
          buildInputDigest: 'sha256:dockerfile',
          resultingImageDigest: 'sha256:image',
        },
        backendVersion: '0.0.99',
        backendSessionId: 'openkit-as_backend_session',
        createdAt: '2026-07-15T00:00:03.000Z',
        attemptId: testEntityId('attempt', 'lease_backend_session'),
        packageSnapshotId: 'aepsnap_backend_session',
        originPhysicalEpoch: 'a'.repeat(64),
        physicalCleanedAt: null,
        runtimeTargetId: 'runtime-target-test',
        sandboxBindingRef: 'lease-binding:lease_backend_session',
        stagingDirectoryRef: 'server/runtime/worker-backend-sessions/aepsnap_backend_session',
        transientProviderInstanceId: 'okp-deployment-test-worker-inference-backend-session',
        workspaceHandoffState: 'pending',
        state: 'materializing',
        threadId: testEntityId('th', 'thread_backend_session'),
        turnId: 'tu_00000000-0000-7a07-9f58-6d0e7a18a11c',
        updatedAt: '2026-07-15T00:00:03.000Z',
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      });
      expect(replay).toEqual(first);
      expect(getWorkerBackendSession(coreDb, first.attemptId)).toEqual(first);
      expect(
        coreDb.sqlite
          .prepare('SELECT schema_version AS schemaVersion FROM worker_backend_sessions')
          .get()
      ).toEqual({ schemaVersion: 1 });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('refuses an unknown backend version before lineage decode, replay or lifecycle updates', async () => {
    const coreDb = await createFixture();
    try {
      const original = await recordWorkerBackendSessionMaterializing(coreDb, materializingInput());
      coreDb.sqlite
        .prepare(`UPDATE worker_backend_sessions SET schema_version = 2,
        backend_lineage_json = '{' WHERE attempt_id = ?`)
        .run(original.attemptId);
      coreDb.sqlite.exec(`CREATE TRIGGER reject_unsupported_backend_update BEFORE UPDATE ON worker_backend_sessions
        BEGIN SELECT RAISE(FAIL, 'Unsupported backend reached an UPDATE'); END`);
      expect(() => getWorkerBackendSession(coreDb, original.attemptId)).toThrow(
        'Unsupported retained record format.'
      );
      await expect(
        recordWorkerBackendSessionMaterializing(coreDb, materializingInput())
      ).rejects.toThrow('Unsupported retained record format.');
      await expect(
        transitionWorkerBackendSessionState(coreDb, {
          attemptId: original.attemptId,
          fromState: 'materializing',
          toState: 'materialized',
        })
      ).rejects.toThrow('Unsupported retained record format.');
      await expect(
        markWorkerBackendWorkspaceHandoffComplete(coreDb, { attemptId: original.attemptId })
      ).rejects.toThrow('Unsupported retained record format.');
      await expect(
        markWorkerBackendSessionLaunching(coreDb, { attemptId: original.attemptId })
      ).rejects.toThrow('Unsupported retained record format.');
      expect(
        coreDb.sqlite
          .prepare(`SELECT schema_version AS schemaVersion, backend_lineage_json, state,
        workspace_handoff_state FROM worker_backend_sessions WHERE attempt_id = ?`)
          .get(original.attemptId)
      ).toEqual({
        schemaVersion: 2,
        backend_lineage_json: '{',
        state: original.state,
        workspace_handoff_state: original.workspaceHandoffState,
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('retains the pre-effect origin across same-Epoch reconnect and rejects a different Epoch', async () => {
    const coreDb = await createFixture();
    try {
      expect(
        (await recordWorkerBackendSessionMaterializing(coreDb, materializingInput()))
          .originPhysicalEpoch
      ).toBe('a'.repeat(64));
      const successor = await allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        deploymentId: 'deployment-test',
        identityId: 'nanohost-test',
        observedAt: '2026-07-15T00:00:04.000Z',
        targetId: 'runtime-target-test',
      });
      await expect(
        recordWorkerBackendSessionMaterializing(coreDb, materializingInput())
      ).rejects.toThrow(/physical Epoch authority/i);
      await upsertNanoHostRuntimeTarget(coreDb, {
        ...successor,
        freshEmpty: true,
        observedAt: '2026-07-15T00:00:05.000Z',
        physicalEpoch: 'a'.repeat(64),
        predecessorFenced: true,
        ready: true,
      });
      expect(
        (await recordWorkerBackendSessionMaterializing(coreDb, materializingInput()))
          .originPhysicalEpoch
      ).toBe('a'.repeat(64));
      const replacement = await allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        deploymentId: 'deployment-test',
        identityId: 'nanohost-test',
        observedAt: '2026-07-15T00:00:06.000Z',
        targetId: 'runtime-target-test',
      });
      await upsertNanoHostRuntimeTarget(coreDb, {
        ...replacement,
        freshEmpty: true,
        observedAt: '2026-07-15T00:00:07.000Z',
        physicalEpoch: 'b'.repeat(64),
        predecessorFenced: true,
        ready: true,
      });
      await expect(
        recordWorkerBackendSessionMaterializing(coreDb, materializingInput())
      ).rejects.toThrow(/identity conflicts|physical Epoch/i);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects a conflicting identity or lease lineage', async () => {
    const coreDb = await createFixture();

    try {
      await recordWorkerBackendSessionMaterializing(coreDb, materializingInput());

      await expect(
        recordWorkerBackendSessionMaterializing(coreDb, {
          ...materializingInput(),
          identity: { ...materializingInput().identity, backendSessionId: 'openkit-conflict' },
        })
      ).rejects.toThrow('Worker backend session identity conflicts with its durable lease.');
      await expect(
        recordWorkerBackendSessionMaterializing(coreDb, {
          ...materializingInput(),
          identity: {
            ...materializingInput().identity,
            runtimeTargetId: 'runtime-target-changed',
          },
        })
      ).rejects.toThrow(/physical Epoch authority/i);
      await expect(
        recordWorkerBackendSessionMaterializing(coreDb, {
          ...materializingInput(),
          backendLineage: {
            ...materializingInput().backendLineage,
            resultingImageDigest: 'sha256:changed-image',
          },
        })
      ).rejects.toThrow('Worker backend session identity conflicts with its durable lease.');
      await expect(
        recordWorkerBackendSessionMaterializing(coreDb, {
          ...materializingInput(),
          identity: {
            ...materializingInput().identity,
            transientProviderInstanceId: 'provider-conflict',
          },
        })
      ).rejects.toThrow('Worker backend session identity conflicts with its durable lease.');
      await expect(
        recordWorkerBackendSessionMaterializing(coreDb, {
          ...materializingInput(),
          lineage: {
            ...materializingInput().lineage,
            turnId: 'tu_00000000-0000-7e18-a597-336d92a699e9',
          },
        })
      ).rejects.toThrow('execution attempt binding does not match worker backend session lineage.');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects a physical plan from another lease lineage before anchoring either identity', async () => {
    const coreDb = await createFixture();

    try {
      await expect(
        recordWorkerBackendSessionMaterializing(coreDb, {
          ...materializingInput(),
          identity: {
            ...materializingInput().identity,
            agentSessionId: 'as_00000000-0000-7f97-a9ca-e375aab5a2da',
            packageSnapshotId: 'aepsnap_plan_from_another_lease',
          },
        })
      ).rejects.toThrow('execution attempt binding does not match worker backend session lineage.');
      expect(
        getWorkerBackendSession(coreDb, testEntityId('attempt', 'lease_backend_session'))
      ).toBeNull();
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects terminal or deadline-expired leases before recording an external-effect identity', async () => {
    const terminalDb = await createFixture();
    const expiredDb = await createFixture();

    try {
      attemptActionOwners.closeSchedulerExecutionAttemptWithoutEffects(terminalDb, {
        attemptId: testEntityId('attempt', 'lease_backend_session'),
        cause: 'turn-failed-before-materialization',
        noOutstandingEffects: true,
      });
      attemptActionOwners.recordSchedulerExecutionOperation(expiredDb, {
        attemptId: testEntityId('attempt', 'lease_backend_session'),
        operationId: 'fixture-submit:lease_backend_session',
        submission: true,
        now: () => '2026-07-15T00:00:02.000Z',
      });
      await expect(
        recordWorkerBackendSessionMaterializing(terminalDb, materializingInput())
      ).rejects.toThrow('execution attempt is not live for worker backend materialization.');
      await expect(
        recordWorkerBackendSessionMaterializing(expiredDb, {
          ...materializingInput(),
          now: () => '2026-07-15T02:00:03.000Z',
        })
      ).rejects.toThrow('execution attempt is not live for worker backend materialization.');
      expect(
        getWorkerBackendSession(terminalDb, testEntityId('attempt', 'lease_backend_session'))
      ).toBeNull();
      expect(
        getWorkerBackendSession(expiredDb, testEntityId('attempt', 'lease_backend_session'))
      ).toBeNull();
    } finally {
      terminalDb.sqlite.close();
      expiredDb.sqlite.close();
    }
  });

  it.each([
    ['terminal', '2026-07-15T00:00:04.000Z'],
    ['deadline-expired', '2026-07-15T02:00:03.000Z'],
  ] as const)(
    'rejects an exact anchor replay after its lease becomes %s',
    async (condition, now) => {
      const coreDb = await createFixture();

      try {
        attemptActionOwners.recordSchedulerExecutionOperation(coreDb, {
          attemptId: testEntityId('attempt', 'lease_backend_session'),
          operationId: 'fixture-submit:lease_backend_session',
          submission: true,
          now: () => '2026-07-15T00:00:02.000Z',
        });
        await recordWorkerBackendSessionMaterializing(coreDb, materializingInput());
        if (condition === 'terminal') {
          coreDb.sqlite
            .prepare(
              "UPDATE scheduler_execution_attempts SET phase = 'closing' WHERE attempt_id = ?"
            )
            .run(testEntityId('attempt', 'lease_backend_session'));
        }

        await expect(
          recordWorkerBackendSessionMaterializing(coreDb, {
            ...materializingInput(),
            now: () => now,
          })
        ).rejects.toThrow('execution attempt is not live for worker backend materialization.');
        expect(
          getWorkerBackendSession(coreDb, testEntityId('attempt', 'lease_backend_session'))
        ).toMatchObject({
          state: 'materializing',
        });
      } finally {
        coreDb.sqlite.close();
      }
    }
  );

  it('gives one lease exclusive ownership of a sandbox binding', async () => {
    const coreDb = await createFixture();

    try {
      await recordWorkerBackendSessionMaterializing(coreDb, materializingInput());

      expect(() =>
        coreDb.sqlite
          .prepare(
            `INSERT INTO worker_backend_sessions (
               attempt_id, workspace_id, thread_id, turn_id, agent_session_id,
               package_snapshot_id, backend_kind, deployment_id, backend_version,
               runtime_target_id, origin_physical_epoch, backend_lineage_json, sandbox_binding_ref, backend_session_id,
               staging_directory_ref, transient_provider_instance_id, workspace_handoff_state,
               state, created_at, updated_at
             )
             SELECT 'attempt_00000000-0000-7000-8000-000000000972', 'ws_00000000-0000-71f5-922f-6fd42f52f580', 'th_00000000-0000-7000-8000-000000000972', 'tu_00000000-0000-7e18-a597-336d92a699e9', 'as_00000000-0000-7436-9246-ac6dd3ca3fe4',
                    'aepsnap_other', backend_kind, deployment_id, backend_version,
                    runtime_target_id, origin_physical_epoch, backend_lineage_json, sandbox_binding_ref, 'openkit-as_other',
                    'server/runtime/worker-backend-sessions/aepsnap_other',
                    'provider-other', workspace_handoff_state,
                    state, created_at, updated_at
             FROM worker_backend_sessions
             WHERE attempt_id = '${testEntityId('attempt', 'lease_backend_session')}'`
          )
          .run()
      ).toThrow(/UNIQUE constraint failed/);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('gives one lease exclusive ownership of a transient provider', async () => {
    const coreDb = await createFixture();

    try {
      await recordWorkerBackendSessionMaterializing(coreDb, materializingInput());

      expect(() =>
        coreDb.sqlite
          .prepare(
            `INSERT INTO worker_backend_sessions (
               attempt_id, workspace_id, thread_id, turn_id, agent_session_id,
               package_snapshot_id, backend_kind, deployment_id, backend_version,
               runtime_target_id, origin_physical_epoch, backend_lineage_json, sandbox_binding_ref,
               backend_session_id, staging_directory_ref, transient_provider_instance_id,
               workspace_handoff_state,
               state, created_at, updated_at
             )
             SELECT 'attempt_00000000-0000-7000-8000-000000000973', 'ws_00000000-0000-71f5-922f-6fd42f52f580', 'th_00000000-0000-7000-8000-000000000972', 'tu_00000000-0000-7e18-a597-336d92a699e9', 'as_00000000-0000-7436-9246-ac6dd3ca3fe4',
                    'aepsnap_provider_other', backend_kind, deployment_id, backend_version,
                    runtime_target_id, origin_physical_epoch, backend_lineage_json, 'lease-binding:lease-provider-other',
                    'openkit-as_other',
                    'server/runtime/worker-backend-sessions/aepsnap_provider_other',
                    transient_provider_instance_id, workspace_handoff_state,
                    state, created_at, updated_at
             FROM worker_backend_sessions
             WHERE attempt_id = '${testEntityId('attempt', 'lease_backend_session')}'`
          )
          .run()
      ).toThrow(/UNIQUE constraint failed/);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects replay once the anchored lifecycle has advanced beyond materializing', async () => {
    const coreDb = await createFixture();

    try {
      await recordWorkerBackendSessionMaterializing(coreDb, materializingInput());
      await transitionWorkerBackendSessionState(coreDb, {
        fromState: 'materializing',
        attemptId: testEntityId('attempt', 'lease_backend_session'),
        toState: 'materialized',
      });
      expect(
        await markWorkerBackendWorkspaceHandoffComplete(coreDb, {
          attemptId: testEntityId('attempt', 'lease_backend_session'),
          now: () => '2026-07-15T00:00:04.500Z',
        })
      ).toMatchObject({ workspaceHandoffState: 'complete' });

      await expect(
        recordWorkerBackendSessionMaterializing(coreDb, materializingInput())
      ).rejects.toThrow('Worker backend session is not materializing.');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    ['package snapshot', 'package_snapshot_id', "'aepsnap_backend_session'"],
    ['physical backend locator', 'backend_session_id', "'openkit-as_backend_session'"],
    ['sandbox binding', 'sandbox_binding_ref', "'lease-binding:lease_backend_session'"],
    [
      'staging directory',
      'staging_directory_ref',
      "'server/runtime/worker-backend-sessions/aepsnap_backend_session'",
    ],
  ] as const)(
    'enforces exclusive ownership of each %s',
    async (_description, preservedColumn, value) => {
      const coreDb = await createFixture();

      try {
        await recordWorkerBackendSessionMaterializing(coreDb, materializingInput());
        const replacements: Record<string, string> = {
          package_snapshot_id: "'aepsnap_other'",
          backend_session_id: "'openkit-as_other'",
          sandbox_binding_ref: "'lease-binding:lease-other'",
          staging_directory_ref: "'server/runtime/worker-backend-sessions/aepsnap_other'",
        };
        replacements[preservedColumn] = value;

        expect(() =>
          coreDb.sqlite
            .prepare(
              `INSERT INTO worker_backend_sessions (
               attempt_id, workspace_id, thread_id, turn_id, agent_session_id,
               package_snapshot_id, backend_kind, deployment_id, backend_version,
               runtime_target_id, origin_physical_epoch, backend_lineage_json, sandbox_binding_ref, backend_session_id,
               staging_directory_ref, transient_provider_instance_id, workspace_handoff_state,
               state, created_at, updated_at
             )
             SELECT 'attempt_00000000-0000-7000-8000-000000000972', 'ws_00000000-0000-71f5-922f-6fd42f52f580', 'th_00000000-0000-7000-8000-000000000972', 'tu_00000000-0000-7e18-a597-336d92a699e9', 'as_00000000-0000-7436-9246-ac6dd3ca3fe4',
                    ${replacements.package_snapshot_id}, backend_kind, deployment_id, backend_version,
                    runtime_target_id, origin_physical_epoch, backend_lineage_json, ${replacements.sandbox_binding_ref}, ${replacements.backend_session_id},
                    ${replacements.staging_directory_ref}, transient_provider_instance_id,
                    workspace_handoff_state,
                    state, created_at, updated_at
             FROM worker_backend_sessions
             WHERE attempt_id = '${testEntityId('attempt', 'lease_backend_session')}'`
            )
            .run()
        ).toThrow(/UNIQUE constraint failed/);
      } finally {
        coreDb.sqlite.close();
      }
    }
  );

  it('uses compare-and-set transitions for cleanup and retry', async () => {
    const coreDb = await createFixture();

    try {
      await recordWorkerBackendSessionMaterializing(coreDb, materializingInput());
      await transitionWorkerBackendSessionState(coreDb, {
        fromState: 'materializing',
        attemptId: testEntityId('attempt', 'lease_backend_session'),
        now: () => '2026-07-15T00:00:04.000Z',
        toState: 'cleanup-pending',
      });
      await transitionWorkerBackendSessionState(coreDb, {
        fromState: 'cleanup-pending',
        attemptId: testEntityId('attempt', 'lease_backend_session'),
        now: () => '2026-07-15T00:00:05.000Z',
        toState: 'cleanup-failed',
      });
      await transitionWorkerBackendSessionState(coreDb, {
        fromState: 'cleanup-failed',
        attemptId: testEntityId('attempt', 'lease_backend_session'),
        now: () => '2026-07-15T00:00:06.000Z',
        toState: 'cleanup-pending',
      });
      expect(
        await transitionWorkerBackendSessionState(coreDb, {
          fromState: 'cleanup-pending',
          attemptId: testEntityId('attempt', 'lease_backend_session'),
          now: () => '2026-07-15T00:00:07.000Z',
          toState: 'physical-cleaned',
        })
      ).toMatchObject({
        physicalCleanedAt: '2026-07-15T00:00:07.000Z',
        state: 'physical-cleaned',
        updatedAt: '2026-07-15T00:00:07.000Z',
      });
      expect(
        await transitionWorkerBackendSessionState(coreDb, {
          fromState: 'physical-cleaned',
          attemptId: testEntityId('attempt', 'lease_backend_session'),
          now: () => '2026-07-15T00:00:08.000Z',
          toState: 'cleaned',
        })
      ).toMatchObject({
        physicalCleanedAt: '2026-07-15T00:00:07.000Z',
        state: 'cleaned',
        updatedAt: '2026-07-15T00:00:08.000Z',
      });
      await expect(
        transitionWorkerBackendSessionState(coreDb, {
          fromState: 'physical-cleaned',
          attemptId: testEntityId('attempt', 'lease_backend_session'),
          toState: 'cleaned',
        })
      ).rejects.toThrow('Worker backend session state changed before transition.');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('opens the launch gate only while the owning lease remains live', async () => {
    const coreDb = await createFixture();

    try {
      attemptActionOwners.recordSchedulerExecutionOperation(coreDb, {
        attemptId: testEntityId('attempt', 'lease_backend_session'),
        operationId: 'fixture-submit:lease_backend_session',
        submission: true,
        now: () => '2026-07-15T00:00:02.000Z',
      });
      await recordWorkerBackendSessionMaterializing(coreDb, materializingInput());
      await transitionWorkerBackendSessionState(coreDb, {
        fromState: 'materializing',
        attemptId: testEntityId('attempt', 'lease_backend_session'),
        now: () => '2026-07-15T00:00:04.000Z',
        toState: 'materialized',
      });
      await markWorkerBackendWorkspaceHandoffComplete(coreDb, {
        attemptId: testEntityId('attempt', 'lease_backend_session'),
        now: () => '2026-07-15T00:00:04.500Z',
      });

      expect(
        await markWorkerBackendSessionLaunching(coreDb, {
          attemptId: testEntityId('attempt', 'lease_backend_session'),
          now: () => '2026-07-15T00:00:05.000Z',
        })
      ).toMatchObject({ state: 'launching', updatedAt: '2026-07-15T00:00:05.000Z' });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it.each([
    ['stale lease', '2026-07-15T00:00:05.000Z'],
    ['expired startup deadline', '2026-07-15T00:26:00.000Z'],
  ] as const)(
    'keeps the session materialized when the launch gate rejects a %s',
    async (condition, now) => {
      const coreDb = await createFixture();

      try {
        attemptActionOwners.recordSchedulerExecutionOperation(coreDb, {
          attemptId: testEntityId('attempt', 'lease_backend_session'),
          operationId: 'fixture-submit:lease_backend_session',
          submission: true,
          now: () => '2026-07-15T00:00:02.000Z',
        });
        await recordWorkerBackendSessionMaterializing(coreDb, materializingInput());
        await transitionWorkerBackendSessionState(coreDb, {
          fromState: 'materializing',
          attemptId: testEntityId('attempt', 'lease_backend_session'),
          now: () => '2026-07-15T00:00:04.000Z',
          toState: 'materialized',
        });
        await markWorkerBackendWorkspaceHandoffComplete(coreDb, {
          attemptId: testEntityId('attempt', 'lease_backend_session'),
          now: () => '2026-07-15T00:00:04.500Z',
        });
        if (condition === 'stale lease') {
          coreDb.sqlite
            .prepare(
              "UPDATE scheduler_execution_attempts SET phase = 'closing' WHERE attempt_id = ?"
            )
            .run(testEntityId('attempt', 'lease_backend_session'));
        }

        await expect(
          markWorkerBackendSessionLaunching(coreDb, {
            attemptId: testEntityId('attempt', 'lease_backend_session'),
            now: () => now,
          })
        ).rejects.toThrow('execution attempt is not live for worker backend launch.');
        expect(
          getWorkerBackendSession(coreDb, testEntityId('attempt', 'lease_backend_session'))
        ).toMatchObject({
          state: 'materialized',
        });
      } finally {
        coreDb.sqlite.close();
      }
    }
  );
});

// The real Worker and SQLite connection remain the producer and consumer of this L2 seam.
// The prelude observes a physical FULL commit and can lose its ACK after that commit.
const backendNativeInterception = vi.hoisted(() => ({
  gate: undefined as SharedArrayBuffer | undefined,
  workers: [] as NativeWorker[],
}));
vi.mock('node:worker_threads', async (load) => {
  const actual = await load<typeof import('node:worker_threads')>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options?: import('node:worker_threads').WorkerOptions) {
        if (backendNativeInterception.gate === undefined) {
          super(filename, options);
        } else {
          const require = createRequire(import.meta.url);
          const prelude = `
            const {workerData, parentPort} = require('node:worker_threads');
            const Database = require(workerData.databaseModule);
            const originalExec = Database.prototype.exec;
            const gate = workerData.backendGate;
            parentPort.on('message', value => {
              if (value.operation !== 'open' && value.operation !== 'close') Atomics.add(gate, 3, 1);
              if (value.operation === 'backend-session' && Atomics.compareExchange(gate, 4, 1, 0) === 1) {
                Atomics.store(gate, 5, 1);
                Atomics.notify(gate, 5);
                if (Atomics.wait(gate, 6, 0, 10000) === 'timed-out') {
                  throw new Error('Native backend deadline crossing was not released.');
                }
              }
            });
            Database.prototype.exec = function(sql) {
              const result = originalExec.call(this, sql);
              if (/^COMMIT$/i.test(sql)) {
                Atomics.store(gate, 1, this.pragma('synchronous', {simple: true}));
                Atomics.add(gate, 0, 1);
                if (Atomics.load(gate, 2) === 1) process.exit(0);
              }
              return result;
            };
          `;
          const entry = options?.eval
            ? String(filename)
            : `import(${JSON.stringify(String(filename))});`;
          super(prelude + entry, {
            ...options,
            eval: true,
            workerData: {
              ...options?.workerData,
              databaseModule: require.resolve('better-sqlite3'),
              backendGate: new Int32Array(backendNativeInterception.gate),
            },
          });
        }
        backendNativeInterception.workers.push(this);
      }
    },
  };
});

/** Uses the existing valid Core fixture, then denies every Main mutation. */
async function createNativeBackendFixture() {
  const coreDb = await createFixture();
  // Launch requires a genuine submitted attempt, not a fabricated acceptance receipt.
  attemptActionOwners.recordSchedulerExecutionOperation(coreDb, {
    attemptId: testEntityId('attempt', 'lease_backend_session'),
    operationId: 'fixture-submit:lease_backend_session',
    submission: true,
    now: () => '2026-07-15T00:00:02.000Z',
  });
  // Setup now opens the native owner; the physical observer must bind its next Worker.
  await shutdownControlStoreWorkerClient();
  const gate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 7));
  backendNativeInterception.gate = gate.buffer as SharedArrayBuffer;
  backendNativeInterception.workers = [];
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    backendNativeInterception.gate = undefined;
  });
  coreDb.sqlite.pragma('query_only = ON');
  return { coreDb, gate };
}

/** Observes all retained columns and the complete Server Audit tuple. */
function nativeBackendTuple(coreDb: ReturnType<typeof createFixture>) {
  return {
    sessions: coreDb.sqlite
      .prepare('SELECT * FROM worker_backend_sessions ORDER BY attempt_id')
      .all() as Record<string, unknown>[],
    audits: coreDb.sqlite
      .prepare('SELECT * FROM audit_events ORDER BY audit_event_id')
      .all() as Record<string, unknown>[],
  };
}

/** Reopens the same database only after the native writer has closed. */
async function reopenNativeBackendTuple(coreDb: ReturnType<typeof createFixture>) {
  await shutdownControlStoreWorkerClient();
  const reopened = openCoreDb(coreDb.dataRoot);
  try {
    reopened.sqlite.pragma('query_only = ON');
    return nativeBackendTuple(reopened);
  } finally {
    reopened.sqlite.close();
  }
}

/** Reaches cleanup through the existing lifecycle owner; this proves no physical Host effect. */
async function prepareNativeBackendPhysicalCleaned(coreDb: ReturnType<typeof createFixture>) {
  await recordWorkerBackendSessionMaterializing(coreDb, materializingInput());
  await transitionWorkerBackendSessionState(coreDb, {
    attemptId: testEntityId('attempt', 'lease_backend_session'),
    fromState: 'materializing',
    toState: 'cleanup-pending',
    now: () => '2026-07-15T00:00:04.000Z',
  });
  return transitionWorkerBackendSessionState(coreDb, {
    attemptId: testEntityId('attempt', 'lease_backend_session'),
    fromState: 'cleanup-pending',
    toState: 'physical-cleaned',
    now: () => '2026-07-15T00:00:05.000Z',
  });
}

describe('native worker backend session ownership', () => {
  it.each(['materialization', 'launch'] as const)(
    'refuses default-clock %s after a real queued Worker request crosses its absolute deadline',
    async (operation) => {
      const { coreDb, gate } = await createNativeBackendFixture();
      const attemptId = testEntityId('attempt', 'lease_backend_session');
      if (operation === 'launch') {
        await recordWorkerBackendSessionMaterializing(coreDb, materializingInput());
        await transitionWorkerBackendSessionState(coreDb, {
          attemptId: attemptId,
          fromState: 'materializing',
          toState: 'materialized',
          now: () => '2026-07-15T00:00:04.000Z',
        });
        await markWorkerBackendWorkspaceHandoffComplete(coreDb, {
          attemptId: attemptId,
          now: () => '2026-07-15T00:00:04.500Z',
        });
      }
      // Fault injection shortens only the valid attempt's absolute deadline. The operation
      // below has no clock override; both Main and the native owner use actual wall time.
      // The held native owner then observes a stored deadline already in the past.
      await shutdownControlStoreWorkerClient();
      coreDb.sqlite.pragma('query_only = OFF');
      const deadlineMs = Date.now() + 5_000;
      const deadline = new Date(deadlineMs).toISOString();
      coreDb.sqlite
        .prepare(`UPDATE scheduler_execution_attempts
          SET deadline = ?, startup_deadline = ?, heartbeat_deadline = ? WHERE attempt_id = ?`)
        .run(
          deadline,
          new Date(deadlineMs + 60000).toISOString(),
          new Date(deadlineMs + 60000).toISOString(),
          attemptId
        );
      coreDb.sqlite.pragma('query_only = ON');
      const before = nativeBackendTuple(coreDb);
      const submissions = Atomics.load(gate, 3);
      Atomics.store(gate, 4, 1);
      let pending: Promise<unknown> | undefined;
      try {
        expect(Date.now()).toBeLessThan(deadlineMs);
        pending =
          operation === 'materialization'
            ? recordWorkerBackendSessionMaterializing(coreDb, {
                ...materializingInput(),
                now: undefined,
              })
            : markWorkerBackendSessionLaunching(coreDb, { attemptId: attemptId });
        const refusal = expect(pending).rejects.toThrow(
          operation === 'materialization'
            ? 'execution attempt is not live for worker backend materialization.'
            : 'execution attempt is not live for worker backend launch.'
        );
        await vi.waitFor(() => expect(Atomics.load(gate, 5)).toBe(1), {
          timeout: 4_000,
          interval: 5,
        });
        // A failure here is a fixture timing failure, not the expected deadline refusal.
        expect(Date.now()).toBeLessThan(deadlineMs);
        coreDb.sqlite.pragma('query_only = OFF');
        const expired = new Date(Date.now() - 1_000).toISOString();
        coreDb.sqlite
          .prepare(`UPDATE scheduler_execution_attempts SET deadline = ? WHERE attempt_id = ?`)
          .run(expired, attemptId);
        coreDb.sqlite.pragma('query_only = ON');
        expect(
          (
            coreDb.sqlite
              .prepare(`SELECT deadline FROM scheduler_execution_attempts WHERE attempt_id = ?`)
              .get(attemptId) as { deadline: string }
          ).deadline < new Date().toISOString()
        ).toBe(true);
        Atomics.store(gate, 6, 1);
        Atomics.notify(gate, 6);
        await refusal;
        expect(Atomics.load(gate, 3) - submissions).toBe(1);
        expect(coreDb.sqlite.pragma('query_only', { simple: true })).toBe(1);
        expect(nativeBackendTuple(coreDb)).toEqual(before);
        expect(await reopenNativeBackendTuple(coreDb)).toEqual(before);
      } finally {
        Atomics.store(gate, 6, 1);
        Atomics.notify(gate, 6);
        // The deciding expectation above owns the refusal; always join before fixture cleanup.
        await pending?.catch(() => undefined);
      }
    }
  );

  it('executes the four existing mutation APIs while Main is query-only', async () => {
    const { coreDb, gate } = await createNativeBackendFixture();
    expect(coreDb.sqlite.pragma('query_only', { simple: true })).toBe(1);
    const first = await recordWorkerBackendSessionMaterializing(coreDb, materializingInput());
    expect(first).toMatchObject({ state: 'materializing', workspaceHandoffState: 'pending' });
    expect(await recordWorkerBackendSessionMaterializing(coreDb, materializingInput())).toEqual(
      first
    );
    expect(
      await transitionWorkerBackendSessionState(coreDb, {
        attemptId: first.attemptId,
        fromState: 'materializing',
        toState: 'materialized',
        now: () => '2026-07-15T00:00:04.000Z',
      })
    ).toEqual({ ...first, state: 'materialized', updatedAt: '2026-07-15T00:00:04.000Z' });
    const handoff = await markWorkerBackendWorkspaceHandoffComplete(coreDb, {
      attemptId: first.attemptId,
      now: () => '2026-07-15T00:00:04.500Z',
    });
    expect(handoff).toEqual({
      ...first,
      state: 'materialized',
      workspaceHandoffState: 'complete',
      updatedAt: '2026-07-15T00:00:04.500Z',
    });
    const launched = await markWorkerBackendSessionLaunching(coreDb, {
      attemptId: first.attemptId,
      now: () => '2026-07-15T00:00:05.000Z',
    });
    expect(launched).toEqual({
      ...handoff,
      state: 'launching',
      updatedAt: '2026-07-15T00:00:05.000Z',
    });
    expect(getWorkerBackendSession(coreDb, first.attemptId)).toEqual(launched);
    expect(coreDb.sqlite.inTransaction).toBe(false);
    expect(Atomics.load(gate, 0)).toBeGreaterThan(0);
    expect(Atomics.load(gate, 1)).toBe(2); // Storage: covering FULL acknowledgement.
  });

  it('preserves the exact identity-conflict refusal without changing retained bytes', async () => {
    const { coreDb } = await createNativeBackendFixture();
    await recordWorkerBackendSessionMaterializing(coreDb, materializingInput());
    const before = nativeBackendTuple(coreDb);
    await expect(
      recordWorkerBackendSessionMaterializing(coreDb, {
        ...materializingInput(),
        identity: { ...materializingInput().identity, backendSessionId: 'openkit-conflict' },
      })
    ).rejects.toThrow('Worker backend session identity conflicts with its durable lease.');
    expect(nativeBackendTuple(coreDb)).toEqual(before);
  });

  it('preserves current-state and handoff refusal without a Main fallback', async () => {
    const { coreDb } = await createNativeBackendFixture();
    const first = await recordWorkerBackendSessionMaterializing(coreDb, materializingInput());
    const before = nativeBackendTuple(coreDb);
    await expect(
      transitionWorkerBackendSessionState(coreDb, {
        attemptId: first.attemptId,
        fromState: 'materialized',
        toState: 'launching',
      })
    ).rejects.toThrow('Worker backend session state changed before transition.');
    await expect(
      markWorkerBackendSessionLaunching(coreDb, {
        attemptId: first.attemptId,
        now: () => '2026-07-15T00:00:04.000Z',
      })
    ).rejects.toThrow('execution attempt is not live for worker backend launch.');
    expect(nativeBackendTuple(coreDb)).toEqual(before);
  });

  it('retains every original row column after FULL acknowledgement and reopen', async () => {
    const { coreDb, gate } = await createNativeBackendFixture();
    await prepareNativeBackendPhysicalCleaned(coreDb);
    const before = nativeBackendTuple(coreDb);
    expect(before.sessions).toHaveLength(1);
    expect(before.sessions[0]).toMatchObject({
      schema_version: 1,
      state: 'physical-cleaned',
      physical_cleaned_at: '2026-07-15T00:00:05.000Z',
      created_at: '2026-07-15T00:00:03.000Z',
      updated_at: '2026-07-15T00:00:05.000Z',
      backend_lineage_json: JSON.stringify({
        buildArgumentsDigest: 'sha256:arguments',
        buildContextDigest: 'sha256:context',
        buildInputDigest: 'sha256:dockerfile',
        resultingImageDigest: 'sha256:image',
      }),
    });
    expect(Atomics.load(gate, 1)).toBe(2);
    expect(await reopenNativeBackendTuple(coreDb)).toEqual(before);
  });

  it('returns unknown after a real post-COMMIT ACK loss and never retries the mutation', async () => {
    const { coreDb, gate } = await createNativeBackendFixture();
    Atomics.store(gate, 2, 1);
    const outcome = await recordWorkerBackendSessionMaterializing(
      coreDb,
      materializingInput()
    ).then(
      (value) => ({ value, error: undefined }),
      (error) => ({ value: undefined, error })
    );
    expect(outcome.error).toBeInstanceOf(ControlStoreWorkerError);
    expect(outcome.error).toMatchObject({ commit: 'unknown' });
    expect(outcome.value).toBeUndefined();
    expect(Atomics.load(gate, 0)).toBe(1);
    expect(Atomics.load(gate, 1)).toBe(2);
    expect(Atomics.load(gate, 3)).toBe(1);
    expect(backendNativeInterception.workers).toHaveLength(1);
    const before = nativeBackendTuple(coreDb);
    expect(before.sessions).toHaveLength(1);
    expect(before.sessions[0]).toMatchObject({
      state: 'materializing',
      created_at: '2026-07-15T00:00:03.000Z',
      updated_at: '2026-07-15T00:00:03.000Z',
    });
    expect(await reopenNativeBackendTuple(coreDb)).toEqual(before);
  });
});

describe('native orphan backend retirement tuple', () => {
  it('commits only the exact cleaned transition and original Server Audit, then reopens both', async () => {
    const { coreDb, gate } = await createNativeBackendFixture();
    const physical = await prepareNativeBackendPhysicalCleaned(coreDb);
    const before = nativeBackendTuple(coreDb);
    await retireOrphanWorkerBackendSession(coreDb, {
      attemptId: physical.attemptId,
      now: () => '2026-07-15T00:00:06.000Z',
    });
    const after = nativeBackendTuple(coreDb);
    expect(after.sessions).toEqual([
      { ...before.sessions[0], state: 'cleaned', updated_at: '2026-07-15T00:00:06.000Z' },
    ]);
    const added = after.audits.filter(
      (row) => !before.audits.some((prior) => prior.audit_event_id === row.audit_event_id)
    );
    expect(after.audits).toHaveLength(before.audits.length + 1);
    expect(added).toEqual([
      expect.objectContaining({
        schema_version: 1,
        action: 'scheduler.orphan-backend-retired',
        category: 'system',
        outcome: 'succeeded',
        resource: `server:worker-backend-session:${physical.attemptId}`,
        severity: 'warning',
        summary: 'Unowned worker backend session physically cleaned and retired.',
        workspace_id: physical.workspaceId,
        thread_id: physical.threadId,
        turn_id: physical.turnId,
        agent_session_id: physical.agentSessionId,
      }),
    ]);
    expect(Atomics.load(gate, 1)).toBe(2);
    expect(coreDb.sqlite.inTransaction).toBe(false);
    expect(await reopenNativeBackendTuple(coreDb)).toEqual(after);
  });

  it('rolls the cleaned transition and Audit back together on a real Audit SQL fault', async () => {
    const { coreDb } = await createNativeBackendFixture();
    const physical = await prepareNativeBackendPhysicalCleaned(coreDb);
    const before = nativeBackendTuple(coreDb);
    await shutdownControlStoreWorkerClient();
    coreDb.sqlite.pragma('query_only = OFF');
    coreDb.sqlite.exec(`CREATE TRIGGER reject_orphan_retirement_audit BEFORE INSERT ON audit_events
      WHEN NEW.action = 'scheduler.orphan-backend-retired'
      BEGIN SELECT RAISE(ABORT, 'orphan retirement Audit fault'); END`);
    coreDb.sqlite.pragma('query_only = ON');
    await expect(
      retireOrphanWorkerBackendSession(coreDb, {
        attemptId: physical.attemptId,
        now: () => '2026-07-15T00:00:06.000Z',
      })
    ).rejects.toMatchObject({ code: 'constraint', commit: 'not-committed' });
    expect(nativeBackendTuple(coreDb)).toEqual(before);
    expect(await reopenNativeBackendTuple(coreDb)).toEqual(before);
    // Removing only the deliberate fault must admit the same complete original tuple.
    coreDb.sqlite.pragma('query_only = OFF');
    coreDb.sqlite.exec('DROP TRIGGER reject_orphan_retirement_audit');
    coreDb.sqlite.pragma('query_only = ON');
    await retireOrphanWorkerBackendSession(coreDb, {
      attemptId: physical.attemptId,
      now: () => '2026-07-15T00:00:06.000Z',
    });
    expect(getWorkerBackendSession(coreDb, physical.attemptId)).toEqual({
      ...physical,
      state: 'cleaned',
      updatedAt: '2026-07-15T00:00:06.000Z',
    });
    expect(nativeBackendTuple(coreDb).audits).toHaveLength(before.audits.length + 1);
  });
});
