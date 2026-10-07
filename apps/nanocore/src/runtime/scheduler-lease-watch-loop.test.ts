import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
import { SimulatedTurnExecutor } from '../lib/simulator.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import * as storage from '../storage/db.js';
import { openCoreDb, openWorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { recordTestAgentEnvironmentPackage } from '../test-support/agent-environment.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { recordTestNativeRuntimeTarget } from '../test-support/native-environment.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  closeSchedulerExecutionAttemptWithFence,
  markSchedulerExecutionAttemptClosing,
  requireSchedulerExecutionAttempt,
  schedulerExecutionCorrelation,
} from './execution-attempt-records.js';
import {
  acceptNanoHostAttemptHeartbeat,
  requireNanoHostExecutionAttempt,
  resolveNanoHostAttemptTokenBinding,
} from './nanohost-attempt-records.js';
import { runNanoHostAttemptRecoveryMaintenance } from './nanohost-attempt-recovery.js';
import { startSchedulerAttemptMaintenanceService } from './scheduler-attempt-maintenance-service.js';
import {
  runSchedulerRecoveryMaintenance,
  runSchedulerRestartRecovery,
} from './scheduler-restart-recovery.js';
import * as backendSessions from './worker-backend-sessions.js';
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
  it('identifies real scheduler inspection failure without a native item and continues later stages', async () => {
    const f = fixture();
    const binding = f.seed('scheduler_diagnostic');
    const fault = new Error('/private/scheduler-canary secret-scheduler-canary');
    const inspect = vi.spyOn(f.recovery.executionBackend, 'inspect').mockRejectedValue(fault);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const native = vi.fn(() => runNanoHostAttemptRecoveryMaintenance(f.coreDb, f.recovery));
    const checkpoints = vi.fn(async () => 0);
    const service = startSchedulerAttemptMaintenanceService({
      intervalMs: 30_000,
      setInterval: () => 'fixture-timer',
      clearInterval: () => {},
      runRecoveryMaintenance: {
        scheduler: () =>
          runSchedulerRecoveryMaintenance(f.coreDb, {
            ...f.recovery,
            now: () => '2026-07-05T00:03:00.000Z',
          }),
        native,
        checkpoints,
      },
    });
    try {
      await expect(service.runOnce()).rejects.toMatchObject({
        errors: [expect.objectContaining({ errors: [fault] })],
      });
      expect(inspect).toHaveBeenCalledOnce();
      expect(getWorkerBackendSession(f.coreDb, binding.attemptId)).toBeNull();
      expect(native).toHaveBeenCalledOnce();
      expect(checkpoints).toHaveBeenCalledOnce();
      expect(warn.mock.calls.map(([line]) => JSON.parse(line))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            body: 'Scheduler attempt recovery check failed.',
            attributes: {
              'openkit.error.code': 'scheduler.attempt_recovery_failed',
              'openkit.attempt.id': binding.attemptId,
              'openkit.workspace.id': binding.lineage.workspaceId,
              'openkit.thread.id': binding.lineage.threadId,
              'openkit.turn.id': binding.lineage.turnId,
              'openkit.agent.session.id': binding.lineage.agentSessionId,
            },
          }),
          expect.objectContaining({
            attributes: { 'openkit.error.code': 'scheduler.recovery_stage_failed' },
          }),
        ])
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-scheduler-canary');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('/private/scheduler-canary');
    } finally {
      service.stop();
      inspect.mockRestore();
      warn.mockRestore();
      f.close();
    }
  });

  it.each([
    'native',
    'checkpoints',
  ] as const)('identifies uncaught %s scan-boundary failure with private exceptions', async (boundary) => {
    const f = fixture();
    const fault = new Error('/private/scan-canary secret-scan-canary');
    const scan =
      boundary === 'native'
        ? vi.spyOn(backendSessions, 'listWorkerBackendSessions').mockImplementation(() => {
            throw fault;
          })
        : vi.spyOn(storage, 'listExistingWorkspaceDatabaseScopes').mockImplementation(() => {
            throw fault;
          });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const after = vi.fn(async () => {});
    const service = startSchedulerAttemptMaintenanceService({
      intervalMs: 30_000,
      setInterval: () => 'fixture-timer',
      clearInterval: () => {},
      runRecoveryMaintenance: {
        scheduler: async () => {},
        native: () => runNanoHostAttemptRecoveryMaintenance(f.coreDb, f.recovery),
        checkpoints:
          boundary === 'native'
            ? after
            : async () => storage.listExistingWorkspaceDatabaseScopes(f.coreDb.dataRoot),
      },
    });
    try {
      await expect(service.runOnce()).rejects.toMatchObject({ errors: [fault] });
      expect(scan).toHaveBeenCalledOnce();
      if (boundary === 'native') expect(after).toHaveBeenCalledOnce();
      expect(warn.mock.calls.map(([line]) => JSON.parse(line))).toContainEqual({
        severityText: 'WARN',
        body:
          boundary === 'native'
            ? 'Native recovery stage failed.'
            : 'Worker checkpoint classification stage failed.',
        attributes: {
          'openkit.error.code':
            boundary === 'native'
              ? 'scheduler.native_recovery_stage_failed'
              : 'scheduler.checkpoint_classification_stage_failed',
        },
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-scan-canary');
      expect(JSON.stringify(warn.mock.calls)).not.toContain('/private/scan-canary');
    } finally {
      service.stop();
      scan.mockRestore();
      warn.mockRestore();
      f.close();
    }
  });

  it.each([
    'open',
    'closed',
  ] as const)('logs each failed native recovery item with fixed safe diagnostics and exact product correlation: %s', async (phase) => {
    const f = fixture();
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const secret = 'native-maintenance-secret-canary';
    const path = '/private/native-maintenance-path-canary';
    const faults = [new Error(`${path}: ${secret}`), new Error(`second ${secret}: ${path}`)];
    f.recovery.cleanupBackendSession
      .mockRejectedValueOnce(faults[0])
      .mockRejectedValueOnce(faults[1]);
    try {
      const bindings = [f.seed('safe_first', true, true), f.seed('safe_second', true, true)];
      if (phase === 'closed') {
        // Model already accepted generic release while an idle native binding remains for retirement.
        for (const binding of bindings) {
          const closing = markSchedulerExecutionAttemptClosing(f.coreDb, {
            attemptId: binding.attemptId,
            cause: 'turn-completed',
          });
          closeSchedulerExecutionAttemptWithFence(f.coreDb, {
            correlation: schedulerExecutionCorrelation(closing),
            fenceRef: `fixture-fence:${binding.attemptId}`,
            proof: {
              terminalHandoff: true,
              output: true,
              evidence: true,
              outsideWorkspaceCollection: true,
              integrationDrain: true,
              routesRevoked: true,
            },
          });
        }
      }

      const failure = await runNanoHostAttemptRecoveryMaintenance(f.coreDb, {
        ...f.recovery,
        now: () => '2026-07-05T00:26:00.000Z',
      }).catch((error: AggregateError) => error);
      expect(failure).toMatchObject({ message: 'Native attempt recovery failed.', errors: faults });
      expect(f.recovery.cleanupBackendSession).toHaveBeenCalledTimes(2);
      expect(log.mock.calls).toEqual(
        bindings.map((binding) => [
          JSON.stringify({
            severityText: 'WARN',
            body:
              phase === 'open'
                ? 'Native attempt cleanup or terminal handoff check failed.'
                : 'Closed-attempt backend retirement check failed.',
            attributes: {
              'openkit.error.code':
                phase === 'open'
                  ? 'scheduler.native_attempt_recovery_failed'
                  : 'scheduler.native_orphan_backend_recovery_failed',
              'openkit.attempt.id': binding.attemptId,
              'openkit.workspace.id': binding.lineage.workspaceId,
              'openkit.thread.id': binding.lineage.threadId,
              'openkit.turn.id': binding.lineage.turnId,
              'openkit.agent.session.id': binding.lineage.agentSessionId,
            },
          }),
        ])
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
      expect(JSON.stringify(log.mock.calls)).not.toContain(path);
    } finally {
      log.mockRestore();
      f.close();
    }
  });

  it('classifies checkpoints in the same maintenance pass after a real native item failure', async () => {
    const f = fixture();
    const checkpoints = vi.fn(async () => 0);
    const failures: unknown[] = [];
    f.seed('independent_stage', true, true);
    const service = startSchedulerAttemptMaintenanceService({
      intervalMs: 30_000,
      setInterval: () => 'fixture-timer',
      clearInterval: () => {},
      onError: (error) => failures.push(error),
      runRecoveryMaintenance: {
        scheduler: async () => {},
        native: () =>
          runNanoHostAttemptRecoveryMaintenance(f.coreDb, {
            ...f.recovery,
            now: () => '2026-07-05T00:26:00.000Z',
          }),
        checkpoints,
      },
    });
    try {
      const failure = await service.runOnce().catch((error: AggregateError) => error);
      expect(f.recovery.cleanupBackendSession).toHaveBeenCalledOnce();
      expect(checkpoints).toHaveBeenCalledOnce();
      expect(failure).toMatchObject({
        message: 'Scheduler recovery maintenance failed.',
        errors: [expect.objectContaining({ message: 'Native attempt recovery failed.' })],
      });
      expect(failures).toEqual([failure]);
    } finally {
      service.stop();
      f.close();
    }
  });

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
