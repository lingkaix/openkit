import { scheduler } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { requireSchedulerExecutionAttemptAdmissionContext } from '../scheduler-records.js';
import type { NanoHostCoreReads } from '../storage/control-kernel-port.js';
import type { CoreDb } from '../storage/db.js';
import { hasCoreIdleCleanupConsumption } from './core-journal-records.js';
import { requireSchedulerExecutionAttempt } from './execution-attempt-records.js';
import {
  CORE_IDLE_CLEANUP_EXECUTION_DEFINITION,
  createExecutionStepJournalReader,
  type ExecutionCandidate,
  listExecutionCandidates,
} from './execution-journal.js';
import {
  createNanoHostEffectRequest,
  nanoHostSandboxIdFromBackendSessionId,
} from './nanohost-effect-identity.js';
import { NanoHostCleanupFencePendingError } from './nanohost-runtime-target-records.js';
import { logRecoveryMaintenanceFailure } from './scheduler-attempt-maintenance-service.js';
import type { WorkerGovernanceBackendSessionIdentity } from './worker-governance-backend.js';

/** Transient selected action; its physical owner rechecks the addressed revision and provenance. */
export interface IdleCleanupSelection {
  readonly candidate: ExecutionCandidate;
  readonly identity: WorkerGovernanceBackendSessionIdentity;
  readonly action: 'result-only' | 'delete' | 'release';
  readonly originPhysicalEpoch: string;
  readonly sandboxBindingRef: string;
}

/** One ordinary next-step owner for the existing Core idle-cleanup definition. */
export class ExecutionReconciler {
  private active: Promise<void> | undefined;
  private invalidated = true;
  private stopped = false;

  /** Uses the owning connection and physical lifecycle; it creates no timer, transport or queue. */
  constructor(
    private readonly input: {
      readonly coreDb: CoreDb;
      readonly nanoHost?: NanoHostCoreReads;
      readonly advanceIdleCleanup: (selection: IdleCleanupSelection) => Promise<void>;
    }
  ) {}

  /** Records a committed change without joining the physical result consumer that made it. */
  wake(): void {
    if (this.stopped) return;
    this.invalidated = true;
    void this.runOnce().catch(() => logRecoveryMaintenanceFailure('native'));
  }

  /** Pages current residents; commits during the pass force rediscovery from its first key. */
  runOnce(): Promise<void> {
    const nanoHost = this.input.nanoHost;
    if (this.stopped || !nanoHost) return Promise.resolve();
    if (this.active) return this.active;
    const operation = Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      do {
        this.invalidated = false;
        let cursor: string | null = null;
        do {
          const page = listExecutionCandidates(this.input.coreDb, cursor, nanoHost);
          for (const candidate of page.candidates) {
            if (this.stopped) break;
            try {
              const selected = await this.selectIdleCleanup(candidate, nanoHost);
              if (selected) await this.input.advanceIdleCleanup(selected);
            } catch (error) {
              errors.push(error);
            }
          }
          cursor = page.next;
          // Each SQL read is bounded; yield between pages rather than monopolizing Main with history.
          if (cursor !== null) await scheduler.yield();
        } while (cursor !== null && !this.stopped);
      } while (this.invalidated && !this.stopped);
      if (errors.length) throw new AggregateError(errors, 'Execution reconciliation failed.');
    });
    this.active = operation;
    void operation
      .finally(() => {
        if (this.active === operation) {
          this.active = undefined;
          if (this.invalidated && !this.stopped) this.wake();
        }
      })
      .catch(() => {});
    return operation;
  }

  /** Joins only selected work, then checks this exact resident's durable disposition. */
  async reconcileIdleCleanup(identity: WorkerGovernanceBackendSessionIdentity): Promise<void> {
    const nanoHost = this.input.nanoHost;
    if (this.stopped || !nanoHost) throw new NanoHostCleanupFencePendingError();
    this.invalidated = true;
    let failure: unknown;
    try {
      await this.runOnce();
    } catch (error) {
      failure = error;
    }
    const db = this.input.coreDb;
    const originalSession = nanoHost.readBackendSession({
      packageSnapshotId: identity.packageSnapshotId,
    });
    const session = originalSession.state === 'ready' ? originalSession.value : null;
    if (
      !session ||
      !isDeepStrictEqual(identity, {
        agentSessionId: session.agentSessionId,
        backendKind: session.backendKind,
        backendSessionId: session.backendSessionId,
        deploymentId: session.deploymentId,
        packageSnapshotId: session.packageSnapshotId,
        runtimeTargetId: session.runtimeTargetId,
        stagingDirectoryRef: session.stagingDirectoryRef,
        transientProviderInstanceId: session.transientProviderInstanceId,
      })
    )
      throw new Error('Idle cleanup join has no exact retained backend owner.');
    let deleted = false;
    let residentBinding: string | undefined;
    for (const operation of ['bridge.close', 'sandbox.delete'] as const) {
      const request = createNanoHostEffectRequest(session, session.attemptId, operation, {
        attemptId: session.attemptId,
        sandboxId: nanoHostSandboxIdFromBackendSessionId(session.backendSessionId),
      });
      const executionId = `idle-cleanup:${request.requestId}`;
      if (!db.sqlite.prepare('SELECT 1 FROM control_executions WHERE id = ?').get(executionId))
        continue;
      const original = await createExecutionStepJournalReader(db, {
        kind: 'server',
      }).readInvocation({
        execution: { owner: { kind: 'server' }, executionId },
        stepId: `effect:${request.requestId}`,
      });
      if (
        original.control.attemptId !== session.attemptId ||
        original.carriage.operation !== operation ||
        original.carriage.requestId !== request.requestId ||
        original.control.operationId !== request.requestId ||
        original.control.target?.targetId !== session.runtimeTargetId ||
        !original.carriage.bindingRef ||
        original.control.target.allocationRef !== original.carriage.bindingRef ||
        (residentBinding !== undefined && residentBinding !== original.carriage.bindingRef) ||
        !original.control.authorityRefs.includes(session.sandboxBindingRef) ||
        !original.control.physicalFenceRefs.includes(session.originPhysicalEpoch)
      )
        throw new Error('Idle cleanup completion conflicts with its retained owner.');
      residentBinding = original.carriage.bindingRef;
      if (operation === 'sandbox.delete')
        deleted = original.state === 'completed' && hasCoreIdleCleanupConsumption(db, original);
    }
    const currentTarget = nanoHost.readTarget(session.runtimeTargetId);
    const target = currentTarget.state === 'ready' ? currentTarget.value : null;
    const absent =
      target?.deploymentId === session.deploymentId &&
      target.predecessorFenced &&
      target.ready &&
      target.freshEmpty &&
      target.physicalEpoch &&
      /^[0-9a-f]{64}$/.test(target.physicalEpoch) &&
      target.physicalEpoch !== session.originPhysicalEpoch;
    if (residentBinding !== undefined && (deleted || absent)) {
      const resident = nanoHost.readResident(residentBinding);
      if (resident.state === 'ready' && resident.value === null) return;
    }
    throw failure ?? new NanoHostCleanupFencePendingError();
  }

  /** Suppresses new selection and joins accepted physical work before its dependencies close. */
  stop(): Promise<void> {
    this.stopped = true;
    return this.active ?? Promise.resolve();
  }

  /** Reinterprets exact current rows; a candidate projection is never dispatch authority. */
  private async selectIdleCleanup(
    candidate: ExecutionCandidate,
    nanoHost: NanoHostCoreReads
  ): Promise<IdleCleanupSelection | undefined> {
    const db = this.input.coreDb;
    const reader = createExecutionStepJournalReader(db, { kind: 'server' });
    const root = await reader.readExecution(candidate.ref.execution);
    const original = await reader.readInvocation(candidate.ref);
    const operation = original.carriage.operation;
    if (operation !== 'bridge.close' && operation !== 'sandbox.delete') return;
    const originalSession = original.control.attemptId
      ? nanoHost.readBackendSession({ attemptId: original.control.attemptId })
      : null;
    const session = originalSession?.state === 'ready' ? originalSession.value : null;
    if (!session) throw new Error('Idle cleanup has no original backend anchor.');
    const attempt = requireSchedulerExecutionAttempt(db, session.attemptId);
    const admission = requireSchedulerExecutionAttemptAdmissionContext(db, session.attemptId);
    if (
      root.definitionVersion !== CORE_IDLE_CLEANUP_EXECUTION_DEFINITION ||
      root.workId !== original.carriage.requestId ||
      attempt.phase !== 'closed' ||
      !attempt.fenceRef ||
      session.backendKind !== 'openshell' ||
      session.workspaceId !== attempt.workspaceId ||
      session.threadId !== attempt.threadId ||
      session.turnId !== attempt.turnId ||
      session.agentSessionId !== attempt.agentSessionId ||
      session.packageSnapshotId !== attempt.inputRef ||
      session.sandboxBindingRef !== attempt.bindingRef ||
      original.control.operationId !== original.carriage.requestId ||
      original.control.target?.targetId !== session.runtimeTargetId ||
      original.control.target.allocationRef !== original.carriage.bindingRef ||
      !original.control.authorityRefs.includes(session.sandboxBindingRef) ||
      !original.control.physicalFenceRefs.includes(session.originPhysicalEpoch) ||
      !isDeepStrictEqual(original.control.actor, admission.triggerActor)
    )
      throw new Error('Idle cleanup selection conflicts with original authority.');
    if (!original.carriage.bindingRef) throw new NanoHostCleanupFencePendingError();
    const observed = nanoHost.readResident(original.carriage.bindingRef);
    if (observed.state !== 'ready') throw new NanoHostCleanupFencePendingError();
    const resident = observed.value;
    if (!resident) return;
    if (
      resident.origin !== session.originPhysicalEpoch ||
      resident.target !== session.runtimeTargetId
    )
      throw new Error('Idle cleanup selected a different resident incarnation.');
    if (resident.drain !== 'draining') return;
    const selected: Omit<IdleCleanupSelection, 'action'> = {
      candidate: { ...candidate, revision: root.revision },
      identity: {
        agentSessionId: session.agentSessionId,
        backendKind: session.backendKind,
        backendSessionId: session.backendSessionId,
        deploymentId: session.deploymentId,
        packageSnapshotId: session.packageSnapshotId,
        runtimeTargetId: session.runtimeTargetId,
        stagingDirectoryRef: session.stagingDirectoryRef,
        transientProviderInstanceId: session.transientProviderInstanceId,
      },
      originPhysicalEpoch: session.originPhysicalEpoch,
      sandboxBindingRef: resident.binding,
    };
    const currentTarget = nanoHost.readTarget(session.runtimeTargetId);
    if (currentTarget.state !== 'ready' || !currentTarget.value)
      throw new NanoHostCleanupFencePendingError();
    const target = currentTarget.value;
    if (
      !target.ready ||
      !target.predecessorFenced ||
      !target.freshEmpty ||
      target.deploymentId !== session.deploymentId ||
      !target.physicalEpoch ||
      !/^[0-9a-f]{64}$/.test(target.physicalEpoch)
    )
      throw new NanoHostCleanupFencePendingError();
    if (target.physicalEpoch !== session.originPhysicalEpoch)
      return { ...selected, action: 'release' };
    const consumed = hasCoreIdleCleanupConsumption(db, original);
    if (original.state === 'completed' && consumed) {
      if (operation === 'sandbox.delete') return { ...selected, action: 'release' };
      const next = createNanoHostEffectRequest(session, session.attemptId, 'sandbox.delete', {
        attemptId: session.attemptId,
        sandboxId: nanoHostSandboxIdFromBackendSessionId(session.backendSessionId),
      });
      if (
        !db.sqlite
          .prepare('SELECT 1 FROM control_executions WHERE id = ?')
          .get(`idle-cleanup:${next.requestId}`)
      )
        return { ...selected, action: 'delete' };
      return;
    }
    if (
      original.state === 'intent' ||
      (original.state === 'unknown' && original.control.outputRefs.length === 0 && !consumed)
    )
      return { ...selected, action: 'result-only' };
    throw new NanoHostCleanupFencePendingError();
  }
}
