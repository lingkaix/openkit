import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { recordTestAgentEnvironmentPackage } from '../test-support/agent-environment.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { recordTestNativeRuntimeTarget } from '../test-support/native-environment.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { requireSchedulerExecutionAttempt } from './execution-attempt-records.js';
import {
  acceptNanoHostAttemptHeartbeat,
  requireNanoHostExecutionAttempt,
  resolveNanoHostAttemptTokenBinding,
} from './nanohost-attempt-records.js';
import { runNanoHostAttemptRecoveryMaintenance } from './nanohost-attempt-recovery.js';
import { runSchedulerRestartRecovery } from './scheduler-restart-recovery.js';
import {
  getWorkerBackendSession,
  recordWorkerBackendSessionMaterializing,
} from './worker-backend-sessions.js';

/** Creates real authorized attempts; it supplies no backend acceptance or cleanup proof. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-native-watch-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: 'ws_demo', ownerUserId: 'user_local' });
  const executionBackend = new SimulatedTurnExecutor({ coreDb });
  const cleanupBackendSession = vi.fn(async () => {
    throw new Error('exact physical cleanup fault');
  });
  const projectRecoveredTurn = vi.fn(async () => ({ status: 'interrupted' as const }));
  const recovery = {
    executionBackend,
    cleanupBackendSession,
    projectRecoveredTurn,
    prepareBackendCleanup: vi.fn(),
    restoreBackendSession: vi.fn(async () => {}),
    reconcileAcceptedFinalStatus: vi.fn(async () => {}),
  };
  const seed = (suffix: string, submitted = true, anchored = false) => {
    const entry = createSchedulerAdmissionEntry(coreDb, {
      backendId: 'nanohost',
      triggerActor: { kind: 'user', id: 'user_local' },
      queueEntryId: `queue_${suffix}`,
      requestId: `request_${suffix}`,
      workspaceId: 'ws_demo',
      threadId: `thread_${suffix}`,
      turnId: `turn_${suffix}`,
      turnInput: `Run ${suffix}`,
      requestedAgentId: 'agent_codex_host',
      now: () => '2026-07-05T00:00:01.000Z',
    });
    const attemptId = `lease_${suffix}`;
    const agentSessionId = `as_${suffix}`;
    const inputRef = `aepsnap_turn_${suffix}_${agentSessionId}`;
    const bindingRef = `lease-binding:${attemptId}`;
    recordTestExecutionAttempt(coreDb, {
      entry,
      attemptId,
      agentSessionId,
      inputRef,
      bindingRef,
      sessionCompatibilityKey: 'c'.repeat(64),
      now: () => '2026-07-05T00:00:02.000Z',
      ...(submitted ? { operationId: `original:${suffix}` } : {}),
    });
    if (anchored) {
      // AEP 293 and Scheduler 86 require the original immutable package before physical recovery.
      // This zero-input session has no Workspace materialization or handle to hand off.
      const workspaceDb = openWorkspaceDb(dataRoot, entry.workspaceId);
      try {
        applyScopedMigrations(workspaceDb);
        const pkg = recordTestAgentEnvironmentPackage(workspaceDb, {
          coreDb,
          suffix,
          triggerActor: { kind: 'user', id: 'user_local' },
          workspaceInputIds: [],
        });
        expect(pkg.snapshotId).toBe(inputRef);
      } finally {
        workspaceDb.sqlite.close();
      }
      const target = recordTestNativeRuntimeTarget(coreDb, 'runtime-target-test');
      recordWorkerBackendSessionMaterializing(coreDb, {
        backendLineage: { imageRef: 'openkit/worker-codex:dev', kind: 'reference' },
        backendVersion: '0.0.99',
        identity: {
          agentSessionId,
          backendKind: 'openshell',
          backendSessionId: `openkit-${agentSessionId}`,
          deploymentId: target.deploymentId,
          packageSnapshotId: inputRef,
          runtimeTargetId: target.targetId,
          stagingDirectoryRef: `server/runtime/worker-backend-sessions/${inputRef}`,
          transientProviderInstanceId: null,
        },
        lineage: { workspaceId: entry.workspaceId, threadId: entry.threadId, turnId: entry.turnId },
        sandboxBindingRef: bindingRef,
        now: () => '2026-07-05T00:00:03.000Z',
      });
    }
    return {
      attemptId,
      sandboxBindingRef: bindingRef,
      lineage: {
        agentSessionId,
        packageSnapshotId: inputRef,
        workspaceId: entry.workspaceId,
        threadId: entry.threadId,
        turnId: entry.turnId,
      },
    };
  };
  return {
    coreDb,
    recovery,
    seed,
    close: () => {
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

// Durable Scheduler D72 retires the generic lease watcher and its stale/released markers.
// D103 leaves heartbeat, startup and adoption with Native; D111 requires proof before exclusion ends.
describe('Native attempt liveness and recovery', () => {
  it('keeps a pre-heartbeat attempt live until its startup deadline', async () => {
    const f = fixture();
    try {
      const binding = f.seed('materializing', true, true);
      await runNanoHostAttemptRecoveryMaintenance(f.coreDb, {
        ...f.recovery,
        now: () => '2026-07-05T00:00:40.000Z',
      });
      expect(f.recovery.cleanupBackendSession).not.toHaveBeenCalled();
      expect(requireNanoHostExecutionAttempt(f.coreDb, binding.attemptId)).toMatchObject({
        phase: 'open',
        startupDeadline: '2026-07-05T00:25:02.000Z',
      });
      expect(
        resolveNanoHostAttemptTokenBinding(f.coreDb, {
          ...binding,
          now: () => '2026-07-05T00:00:40.000Z',
        })
      ).toMatchObject({ status: 'accepted' });
      acceptNanoHostAttemptHeartbeat(f.coreDb, {
        attemptId: binding.attemptId,
        workerSequence: 0,
        workerProcessKeyHash: 'a'.repeat(43),
        heartbeatTimeoutMs: 30_000,
        now: () => '2026-07-05T00:00:40.000Z',
      });
      expect(
        acceptNanoHostAttemptHeartbeat(f.coreDb, {
          attemptId: binding.attemptId,
          workerSequence: 1,
          heartbeatTimeoutMs: 30_000,
          now: () => '2026-07-05T00:00:40.000Z',
        })
      ).toMatchObject({
        lastAcceptedHeartbeatAt: '2026-07-05T00:00:40.000Z',
        phase: 'open',
        lastWorkerSequence: 1,
      });
    } finally {
      f.close();
    }
  });

  it('closes proven pre-effect startup work while expired submitted heartbeat authority retains exclusion', async () => {
    const f = fixture();
    try {
      const startup = f.seed('startup', false);
      const heartbeat = f.seed('heartbeat');
      acceptNanoHostAttemptHeartbeat(f.coreDb, {
        attemptId: heartbeat.attemptId,
        workerSequence: 0,
        workerProcessKeyHash: 'a'.repeat(43),
        heartbeatTimeoutMs: 30_000,
        now: () => '2026-07-05T00:00:10.000Z',
      });
      acceptNanoHostAttemptHeartbeat(f.coreDb, {
        attemptId: heartbeat.attemptId,
        workerSequence: 1,
        heartbeatTimeoutMs: 30_000,
        now: () => '2026-07-05T00:00:10.000Z',
      });
      const result = await runSchedulerRestartRecovery(f.coreDb, {
        ...f.recovery,
        now: () => '2026-07-05T00:26:00.000Z',
      });
      expect(result.preparationFailedAttemptIds).toEqual([startup.attemptId]);
      await runNanoHostAttemptRecoveryMaintenance(f.coreDb, {
        ...f.recovery,
        now: () => '2026-07-05T00:26:00.000Z',
      });
      expect(requireSchedulerExecutionAttempt(f.coreDb, startup.attemptId)).toMatchObject({
        phase: 'closed',
        disposition: 'not_accepted',
        operationId: null,
        terminalCause: 'restart-before-effects',
      });
      // The missing physical anchor does not prove that the original submitted operation had no effects.
      expect(requireSchedulerExecutionAttempt(f.coreDb, heartbeat.attemptId)).toMatchObject({
        phase: 'open',
        disposition: 'unknown',
        operationId: 'original:heartbeat',
        fenceRef: null,
      });
      expect(f.recovery.cleanupBackendSession).not.toHaveBeenCalled();
      expect(
        resolveNanoHostAttemptTokenBinding(f.coreDb, {
          ...heartbeat,
          now: () => '2026-07-05T00:26:00.000Z',
        })
      ).toEqual({ status: 'rejected', reason: 'attempt-not-live' });
    } finally {
      f.close();
    }
  });

  it('routes anchored startup timeouts to exact physical recovery without releasing exclusion', async () => {
    const f = fixture();
    try {
      const binding = f.seed('anchored_startup', true, true);
      await expect(
        runNanoHostAttemptRecoveryMaintenance(f.coreDb, {
          ...f.recovery,
          now: () => '2026-07-05T00:26:00.000Z',
        })
      ).rejects.toMatchObject({
        message: 'Native attempt recovery failed.',
        errors: [expect.objectContaining({ message: 'exact physical cleanup fault' })],
      });
      expect(f.recovery.cleanupBackendSession).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          agentSessionId: 'as_anchored_startup',
          backendSessionId: 'openkit-as_anchored_startup',
          packageSnapshotId: binding.lineage.packageSnapshotId,
        })
      );
      expect(requireSchedulerExecutionAttempt(f.coreDb, binding.attemptId)).toMatchObject({
        phase: 'closing',
        terminalCause: 'native-liveness-expired',
        fenceRef: null,
        operationId: 'original:anchored_startup',
      });
      expect(getWorkerBackendSession(f.coreDb, binding.attemptId)).toMatchObject({
        state: 'cleanup-failed',
        physicalCleanedAt: null,
      });
      expect(f.recovery.projectRecoveredTurn).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });

  it('retains an awaiting reconnect attempt until its recovery deadline while refusing routes', async () => {
    const f = fixture();
    try {
      const binding = f.seed('awaiting_reconnect', true, true);
      acceptNanoHostAttemptHeartbeat(f.coreDb, {
        attemptId: binding.attemptId,
        workerSequence: 0,
        workerProcessKeyHash: 'a'.repeat(43),
        heartbeatTimeoutMs: 30_000,
        now: () => '2026-07-05T00:00:10.000Z',
      });
      f.coreDb.sqlite
        .prepare(
          `UPDATE scheduler_execution_attempts SET recovery_state = 'awaiting-reconnect', recovery_deadline = '2026-07-05T00:02:00.000Z' WHERE attempt_id = ?`
        )
        .run(binding.attemptId);
      await runNanoHostAttemptRecoveryMaintenance(f.coreDb, {
        ...f.recovery,
        now: () => '2026-07-05T00:01:00.000Z',
      });
      expect(f.recovery.cleanupBackendSession).not.toHaveBeenCalled();
      expect(requireSchedulerExecutionAttempt(f.coreDb, binding.attemptId)).toMatchObject({
        phase: 'open',
        fenceRef: null,
        operationId: 'original:awaiting_reconnect',
      });
      expect(
        resolveNanoHostAttemptTokenBinding(f.coreDb, {
          ...binding,
          now: () => '2026-07-05T00:01:00.000Z',
        })
      ).toEqual({ status: 'rejected', reason: 'reconnect-required' });
    } finally {
      f.close();
    }
  });
});
