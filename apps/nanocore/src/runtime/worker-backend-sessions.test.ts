import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
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
  transitionWorkerBackendSessionState,
} from './worker-backend-sessions.js';

/** Creates one dispatched lease in an isolated Core database. */
function createFixture() {
  const coreDb = openCoreDb(mkdtempSync(join(tmpdir(), 'openkit-worker-backend-session-')));
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: 'ws_demo', ownerUserId: 'user_local' });
  const entry = createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    triggerActor: { kind: 'user', id: 'user_local' },
    profileRef: 'profile_worker',
    queueEntryId: 'queue_backend_session',
    requestedAgentId: 'agent_codex_host',
    threadId: 'thread_backend_session',
    turnId: 'turn_backend_session',
    turnInput: 'Run worker',
    workspaceId: 'ws_demo',
    now: () => '2026-07-15T00:00:01.000Z',
  });
  recordTestExecutionAttempt(coreDb, {
    entry,
    attemptId: 'lease_backend_session',
    agentSessionId: 'as_backend_session',
    inputRef: 'aepsnap_backend_session',
    bindingRef: 'lease-binding:lease_backend_session',
    sessionCompatibilityKey: 'fixture-compatibility',
    now: () => '2026-07-15T00:00:02.000Z',
  });
  const target = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
    deploymentId: 'deployment-test',
    identityId: 'nanohost-test',
    observedAt: '2026-07-15T00:00:02.500Z',
    targetId: 'runtime-target-test',
  });
  upsertNanoHostRuntimeTarget(coreDb, {
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
      agentSessionId: 'as_backend_session',
      backendKind: 'openshell',
      backendSessionId: 'openkit-as_backend_session',
      deploymentId: 'deployment-test',
      packageSnapshotId: 'aepsnap_backend_session',
      runtimeTargetId: 'runtime-target-test',
      stagingDirectoryRef: 'server/runtime/worker-backend-sessions/aepsnap_backend_session',
      transientProviderInstanceId: 'okp-deployment-test-worker-inference-backend-session',
    },
    lineage: {
      threadId: 'thread_backend_session',
      turnId: 'turn_backend_session',
      workspaceId: 'ws_demo',
    },
    now: () => '2026-07-15T00:00:03.000Z',
    sandboxBindingRef: 'lease-binding:lease_backend_session',
  } as const;
}

describe('worker backend sessions', () => {
  it.each([
    'reference',
    'build',
  ] as const)('reads retained %s lineage annotations without reminting or rewriting identity', (kind) => {
    const coreDb = createFixture();
    try {
      const input = materializingInput();
      const original = recordWorkerBackendSessionMaterializing(coreDb, {
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
        .prepare('UPDATE worker_backend_sessions SET backend_lineage_json = ? WHERE attempt_id = ?')
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
  });

  it.each([
    { imageRef: 'registry.example/worker', kind: 'future-lineage' },
    { imageRef: 'registry.example/worker', requiredFeatures: ['future-proof'] },
    {
      buildArgumentsDigest: 'sha256:arguments',
      buildContextDigest: 'sha256:context',
      buildInputDigest: 'sha256:input',
      resultingImageDigest: null,
    },
  ])('refuses unknown or invalid required retained backend lineage %# without rewriting it', (lineage) => {
    const coreDb = createFixture();
    try {
      const original = recordWorkerBackendSessionMaterializing(coreDb, materializingInput());
      const retained = JSON.stringify(lineage);
      coreDb.sqlite
        .prepare('UPDATE worker_backend_sessions SET backend_lineage_json = ? WHERE attempt_id = ?')
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
  });

  it('persists the complete package-scoped identity before materialization and accepts exact replay', () => {
    const coreDb = createFixture();

    try {
      const first = recordWorkerBackendSessionMaterializing(coreDb, materializingInput());
      const replay = recordWorkerBackendSessionMaterializing(coreDb, materializingInput());

      expect(first).toEqual({
        agentSessionId: 'as_backend_session',
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
        attemptId: 'lease_backend_session',
        packageSnapshotId: 'aepsnap_backend_session',
        originPhysicalEpoch: 'a'.repeat(64),
        physicalCleanedAt: null,
        runtimeTargetId: 'runtime-target-test',
        sandboxBindingRef: 'lease-binding:lease_backend_session',
        stagingDirectoryRef: 'server/runtime/worker-backend-sessions/aepsnap_backend_session',
        transientProviderInstanceId: 'okp-deployment-test-worker-inference-backend-session',
        workspaceHandoffState: 'pending',
        state: 'materializing',
        threadId: 'thread_backend_session',
        turnId: 'turn_backend_session',
        updatedAt: '2026-07-15T00:00:03.000Z',
        workspaceId: 'ws_demo',
      });
      expect(replay).toEqual(first);
      expect(getWorkerBackendSession(coreDb, first.attemptId)).toEqual(first);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('retains the pre-effect origin across same-Epoch reconnect and rejects a different Epoch', () => {
    const coreDb = createFixture();
    try {
      expect(
        recordWorkerBackendSessionMaterializing(coreDb, materializingInput()).originPhysicalEpoch
      ).toBe('a'.repeat(64));
      const successor = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        deploymentId: 'deployment-test',
        identityId: 'nanohost-test',
        observedAt: '2026-07-15T00:00:04.000Z',
        targetId: 'runtime-target-test',
      });
      expect(() => recordWorkerBackendSessionMaterializing(coreDb, materializingInput())).toThrow(
        /physical Epoch authority/i
      );
      upsertNanoHostRuntimeTarget(coreDb, {
        ...successor,
        freshEmpty: true,
        observedAt: '2026-07-15T00:00:05.000Z',
        physicalEpoch: 'a'.repeat(64),
        predecessorFenced: true,
        ready: true,
      });
      expect(
        recordWorkerBackendSessionMaterializing(coreDb, materializingInput()).originPhysicalEpoch
      ).toBe('a'.repeat(64));
      const replacement = allocateNanoHostRuntimeTargetConnectionGeneration(coreDb, {
        deploymentId: 'deployment-test',
        identityId: 'nanohost-test',
        observedAt: '2026-07-15T00:00:06.000Z',
        targetId: 'runtime-target-test',
      });
      upsertNanoHostRuntimeTarget(coreDb, {
        ...replacement,
        freshEmpty: true,
        observedAt: '2026-07-15T00:00:07.000Z',
        physicalEpoch: 'b'.repeat(64),
        predecessorFenced: true,
        ready: true,
      });
      expect(() => recordWorkerBackendSessionMaterializing(coreDb, materializingInput())).toThrow(
        /identity conflicts|physical Epoch/i
      );
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects a conflicting identity or lease lineage', () => {
    const coreDb = createFixture();

    try {
      recordWorkerBackendSessionMaterializing(coreDb, materializingInput());

      expect(() =>
        recordWorkerBackendSessionMaterializing(coreDb, {
          ...materializingInput(),
          identity: { ...materializingInput().identity, backendSessionId: 'openkit-conflict' },
        })
      ).toThrow('Worker backend session identity conflicts with its durable lease.');
      expect(() =>
        recordWorkerBackendSessionMaterializing(coreDb, {
          ...materializingInput(),
          identity: {
            ...materializingInput().identity,
            runtimeTargetId: 'runtime-target-changed',
          },
        })
      ).toThrow(/physical Epoch authority/i);
      expect(() =>
        recordWorkerBackendSessionMaterializing(coreDb, {
          ...materializingInput(),
          backendLineage: {
            ...materializingInput().backendLineage,
            resultingImageDigest: 'sha256:changed-image',
          },
        })
      ).toThrow('Worker backend session identity conflicts with its durable lease.');
      expect(() =>
        recordWorkerBackendSessionMaterializing(coreDb, {
          ...materializingInput(),
          identity: {
            ...materializingInput().identity,
            transientProviderInstanceId: 'provider-conflict',
          },
        })
      ).toThrow('Worker backend session identity conflicts with its durable lease.');
      expect(() =>
        recordWorkerBackendSessionMaterializing(coreDb, {
          ...materializingInput(),
          lineage: { ...materializingInput().lineage, turnId: 'turn_other' },
        })
      ).toThrow('execution attempt binding does not match worker backend session lineage.');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects a physical plan from another lease lineage before anchoring either identity', () => {
    const coreDb = createFixture();

    try {
      expect(() =>
        recordWorkerBackendSessionMaterializing(coreDb, {
          ...materializingInput(),
          identity: {
            ...materializingInput().identity,
            agentSessionId: 'as_plan_from_another_lease',
            packageSnapshotId: 'aepsnap_plan_from_another_lease',
          },
        })
      ).toThrow('execution attempt binding does not match worker backend session lineage.');
      expect(getWorkerBackendSession(coreDb, 'lease_backend_session')).toBeNull();
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects terminal or deadline-expired leases before recording an external-effect identity', () => {
    const terminalDb = createFixture();
    const expiredDb = createFixture();

    try {
      attemptActionOwners.closeSchedulerExecutionAttemptWithoutEffects(terminalDb, {
        attemptId: 'lease_backend_session',
        cause: 'turn-failed-before-materialization',
        noOutstandingEffects: true,
      });
      attemptActionOwners.recordSchedulerExecutionOperation(expiredDb, {
        attemptId: 'lease_backend_session',
        operationId: 'fixture-submit:lease_backend_session',
        submission: true,
        now: () => '2026-07-15T00:00:02.000Z',
      });
      expect(() =>
        recordWorkerBackendSessionMaterializing(terminalDb, materializingInput())
      ).toThrow('execution attempt is not live for worker backend materialization.');
      expect(() =>
        recordWorkerBackendSessionMaterializing(expiredDb, {
          ...materializingInput(),
          now: () => '2026-07-15T02:00:03.000Z',
        })
      ).toThrow('execution attempt is not live for worker backend materialization.');
      expect(getWorkerBackendSession(terminalDb, 'lease_backend_session')).toBeNull();
      expect(getWorkerBackendSession(expiredDb, 'lease_backend_session')).toBeNull();
    } finally {
      terminalDb.sqlite.close();
      expiredDb.sqlite.close();
    }
  });

  it.each([
    ['terminal', '2026-07-15T00:00:04.000Z'],
    ['deadline-expired', '2026-07-15T02:00:03.000Z'],
  ] as const)('rejects an exact anchor replay after its lease becomes %s', (condition, now) => {
    const coreDb = createFixture();

    try {
      attemptActionOwners.recordSchedulerExecutionOperation(coreDb, {
        attemptId: 'lease_backend_session',
        operationId: 'fixture-submit:lease_backend_session',
        submission: true,
        now: () => '2026-07-15T00:00:02.000Z',
      });
      recordWorkerBackendSessionMaterializing(coreDb, materializingInput());
      if (condition === 'terminal') {
        coreDb.sqlite
          .prepare("UPDATE scheduler_execution_attempts SET phase = 'closing' WHERE attempt_id = ?")
          .run('lease_backend_session');
      }

      expect(() =>
        recordWorkerBackendSessionMaterializing(coreDb, {
          ...materializingInput(),
          now: () => now,
        })
      ).toThrow('execution attempt is not live for worker backend materialization.');
      expect(getWorkerBackendSession(coreDb, 'lease_backend_session')).toMatchObject({
        state: 'materializing',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('gives one lease exclusive ownership of a sandbox binding', () => {
    const coreDb = createFixture();

    try {
      recordWorkerBackendSessionMaterializing(coreDb, materializingInput());

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
             SELECT 'lease_other', 'ws_other', 'thread_other', 'turn_other', 'as_other',
                    'aepsnap_other', backend_kind, deployment_id, backend_version,
                    runtime_target_id, origin_physical_epoch, backend_lineage_json, sandbox_binding_ref, 'openkit-as_other',
                    'server/runtime/worker-backend-sessions/aepsnap_other',
                    'provider-other', workspace_handoff_state,
                    state, created_at, updated_at
             FROM worker_backend_sessions
             WHERE attempt_id = 'lease_backend_session'`
          )
          .run()
      ).toThrow(/UNIQUE constraint failed/);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('gives one lease exclusive ownership of a transient provider', () => {
    const coreDb = createFixture();

    try {
      recordWorkerBackendSessionMaterializing(coreDb, materializingInput());

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
             SELECT 'lease_provider_other', 'ws_other', 'thread_other', 'turn_other', 'as_other',
                    'aepsnap_provider_other', backend_kind, deployment_id, backend_version,
                    runtime_target_id, origin_physical_epoch, backend_lineage_json, 'lease-binding:lease-provider-other',
                    'openkit-as_other',
                    'server/runtime/worker-backend-sessions/aepsnap_provider_other',
                    transient_provider_instance_id, workspace_handoff_state,
                    state, created_at, updated_at
             FROM worker_backend_sessions
             WHERE attempt_id = 'lease_backend_session'`
          )
          .run()
      ).toThrow(/UNIQUE constraint failed/);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('rejects replay once the anchored lifecycle has advanced beyond materializing', () => {
    const coreDb = createFixture();

    try {
      recordWorkerBackendSessionMaterializing(coreDb, materializingInput());
      transitionWorkerBackendSessionState(coreDb, {
        fromState: 'materializing',
        attemptId: 'lease_backend_session',
        toState: 'materialized',
      });
      expect(
        markWorkerBackendWorkspaceHandoffComplete(coreDb, {
          attemptId: 'lease_backend_session',
          now: () => '2026-07-15T00:00:04.500Z',
        })
      ).toMatchObject({ workspaceHandoffState: 'complete' });

      expect(() => recordWorkerBackendSessionMaterializing(coreDb, materializingInput())).toThrow(
        'Worker backend session is not materializing.'
      );
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
  ] as const)('enforces exclusive ownership of each %s', (_description, preservedColumn, value) => {
    const coreDb = createFixture();

    try {
      recordWorkerBackendSessionMaterializing(coreDb, materializingInput());
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
             SELECT 'lease_other', 'ws_other', 'thread_other', 'turn_other', 'as_other',
                    ${replacements.package_snapshot_id}, backend_kind, deployment_id, backend_version,
                    runtime_target_id, origin_physical_epoch, backend_lineage_json, ${replacements.sandbox_binding_ref}, ${replacements.backend_session_id},
                    ${replacements.staging_directory_ref}, transient_provider_instance_id,
                    workspace_handoff_state,
                    state, created_at, updated_at
             FROM worker_backend_sessions
             WHERE attempt_id = 'lease_backend_session'`
          )
          .run()
      ).toThrow(/UNIQUE constraint failed/);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('uses compare-and-set transitions for cleanup and retry', () => {
    const coreDb = createFixture();

    try {
      recordWorkerBackendSessionMaterializing(coreDb, materializingInput());
      transitionWorkerBackendSessionState(coreDb, {
        fromState: 'materializing',
        attemptId: 'lease_backend_session',
        now: () => '2026-07-15T00:00:04.000Z',
        toState: 'cleanup-pending',
      });
      transitionWorkerBackendSessionState(coreDb, {
        fromState: 'cleanup-pending',
        attemptId: 'lease_backend_session',
        now: () => '2026-07-15T00:00:05.000Z',
        toState: 'cleanup-failed',
      });
      transitionWorkerBackendSessionState(coreDb, {
        fromState: 'cleanup-failed',
        attemptId: 'lease_backend_session',
        now: () => '2026-07-15T00:00:06.000Z',
        toState: 'cleanup-pending',
      });
      expect(
        transitionWorkerBackendSessionState(coreDb, {
          fromState: 'cleanup-pending',
          attemptId: 'lease_backend_session',
          now: () => '2026-07-15T00:00:07.000Z',
          toState: 'physical-cleaned',
        })
      ).toMatchObject({
        physicalCleanedAt: '2026-07-15T00:00:07.000Z',
        state: 'physical-cleaned',
        updatedAt: '2026-07-15T00:00:07.000Z',
      });
      expect(
        transitionWorkerBackendSessionState(coreDb, {
          fromState: 'physical-cleaned',
          attemptId: 'lease_backend_session',
          now: () => '2026-07-15T00:00:08.000Z',
          toState: 'cleaned',
        })
      ).toMatchObject({
        physicalCleanedAt: '2026-07-15T00:00:07.000Z',
        state: 'cleaned',
        updatedAt: '2026-07-15T00:00:08.000Z',
      });
      expect(() =>
        transitionWorkerBackendSessionState(coreDb, {
          fromState: 'physical-cleaned',
          attemptId: 'lease_backend_session',
          toState: 'cleaned',
        })
      ).toThrow('Worker backend session state changed before transition.');
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('opens the launch gate only while the owning lease remains live', () => {
    const coreDb = createFixture();

    try {
      attemptActionOwners.recordSchedulerExecutionOperation(coreDb, {
        attemptId: 'lease_backend_session',
        operationId: 'fixture-submit:lease_backend_session',
        submission: true,
        now: () => '2026-07-15T00:00:02.000Z',
      });
      recordWorkerBackendSessionMaterializing(coreDb, materializingInput());
      transitionWorkerBackendSessionState(coreDb, {
        fromState: 'materializing',
        attemptId: 'lease_backend_session',
        now: () => '2026-07-15T00:00:04.000Z',
        toState: 'materialized',
      });
      markWorkerBackendWorkspaceHandoffComplete(coreDb, {
        attemptId: 'lease_backend_session',
        now: () => '2026-07-15T00:00:04.500Z',
      });

      expect(
        markWorkerBackendSessionLaunching(coreDb, {
          attemptId: 'lease_backend_session',
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
  ] as const)('keeps the session materialized when the launch gate rejects a %s', (condition, now) => {
    const coreDb = createFixture();

    try {
      attemptActionOwners.recordSchedulerExecutionOperation(coreDb, {
        attemptId: 'lease_backend_session',
        operationId: 'fixture-submit:lease_backend_session',
        submission: true,
        now: () => '2026-07-15T00:00:02.000Z',
      });
      recordWorkerBackendSessionMaterializing(coreDb, materializingInput());
      transitionWorkerBackendSessionState(coreDb, {
        fromState: 'materializing',
        attemptId: 'lease_backend_session',
        now: () => '2026-07-15T00:00:04.000Z',
        toState: 'materialized',
      });
      markWorkerBackendWorkspaceHandoffComplete(coreDb, {
        attemptId: 'lease_backend_session',
        now: () => '2026-07-15T00:00:04.500Z',
      });
      if (condition === 'stale lease') {
        coreDb.sqlite
          .prepare("UPDATE scheduler_execution_attempts SET phase = 'closing' WHERE attempt_id = ?")
          .run('lease_backend_session');
      }

      expect(() =>
        markWorkerBackendSessionLaunching(coreDb, {
          attemptId: 'lease_backend_session',
          now: () => now,
        })
      ).toThrow('execution attempt is not live for worker backend launch.');
      expect(getWorkerBackendSession(coreDb, 'lease_backend_session')).toMatchObject({
        state: 'materialized',
      });
    } finally {
      coreDb.sqlite.close();
    }
  });
});
