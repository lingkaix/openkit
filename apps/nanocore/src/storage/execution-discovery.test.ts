import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createInMemoryRuntimeConfigSnapshot,
  loadRuntimeConfig,
} from '../config/runtime-config.js';
import { commandRequestExpiresAt, commandRequestKey } from '../lib/store.js';
import { ProviderRegistry } from '../providers/registry.js';
import { requireSchedulerExecutionAttempt } from '../runtime/execution-attempt-records.js';
import * as journalOwner from '../runtime/execution-journal.js';
import {
  CORE_IDLE_CLEANUP_EXECUTION_DEFINITION,
  createExecutionStepJournalReader,
  hasIdleCleanupExecution,
  settleExecutionJournalStep,
  writeExecutionJournalIntent,
} from '../runtime/execution-journal.js';
import { ExecutionReconciler } from '../runtime/execution-reconciler.js';
import type {
  ExecutionJournalIntent,
  ExecutionJournalSpan,
} from '../runtime/execution-step-journal.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { drainNanoHostSandboxAdmission } from '../runtime/nanohost-harness-records.js';
import { getWorkerBackendSession } from '../runtime/worker-backend-sessions.js';
import type { WorkerGovernanceBackend } from '../runtime/worker-governance-backend.js';
import { getWorkerStorageBinding } from '../runtime/worker-storage-bindings.js';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import {
  createTestAgentSetup,
  createTestGatewayConfig,
} from '../test-support/agent-environment.js';
import { createDemoStore, DEMO_THREAD_ID, DEMO_WORKSPACE_ID } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { admitTestNativeEnvironment } from '../test-support/native-environment.js';
import { createNativeTaskAdmissionFixture } from '../test-support/native-task-admission.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { controlStoreFor } from './control-store.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb } from './db.js';
import { ensureLayout } from './fs-layout.js';
import { applyMigrations } from './migrate.js';

/** Supplies journal primitive inputs only; no resident, receiver result or physical authority. */
function discoveryIntent(index: number): ExecutionJournalIntent {
  const requestId = index.toString(16).padStart(64, '0');
  const definitionVersion = CORE_IDLE_CLEANUP_EXECUTION_DEFINITION;
  const span: ExecutionJournalSpan & { endTimeUnixNano: null } = {
    traceId: requestId.slice(-32),
    spanId: (index * 2).toString(16).padStart(16, '0'),
    flags: 0,
    name: 'candidate discovery fixture',
    kind: 'INTERNAL',
    startTimeUnixNano: BigInt(Date.now()) * 1_000_000n,
    endTimeUnixNano: null,
    status: { code: 'UNSET' },
    attributes: [],
    droppedAttributesCount: 0,
    events: [],
    droppedEventsCount: 0,
    links: [],
    droppedLinksCount: 0,
    instrumentationScope: {
      name: 'openkit.candidate-discovery-test',
      attributes: [],
      droppedAttributesCount: 0,
    },
    resource: { attributes: [], droppedAttributesCount: 0 },
  };
  return {
    execution: {
      ref: { owner: { kind: 'server' }, executionId: `retired-idle-${requestId}` },
      definitionVersion,
      workId: requestId,
      fingerprint: 'a'.repeat(64),
      exclusionRefs: [],
      span,
    },
    stepId: `effect:${requestId}`,
    parentStepId: null,
    parent: null,
    inspectedStep: null,
    carriage: {
      operation: 'bridge.close',
      requestId,
      sequence: null,
      bindingRef: null,
    },
    control: {
      definitionVersion,
      kind: 'inspect-cleanup',
      target: null,
      workId: requestId,
      operationId: requestId,
      attemptId: null,
      invocationId: `discovery:${requestId}`,
      actor: { kind: 'user', id: FIXTURE_LOCAL_USER_ID },
      inputRefs: [],
      outputRefs: [],
      fingerprint: 'b'.repeat(64),
      permittingDecisionRef: null,
      authorityRefs: [],
      retryDeclarationRef: null,
      retryPermitted: false,
      deadlineUnixNano: null,
      physicalFenceRefs: [],
    },
    span: {
      ...span,
      spanId: (index * 2 + 1).toString(16).padStart(16, '0'),
      parentSpanId: span.spanId,
    },
  };
}

describe('Core execution candidate discovery', () => {
  it('rediscovers a commit queued as the last empty page completes', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-execution-finishing-wake-'));
    const db = openCoreDb(dataRoot);
    const advanceIdleCleanup = vi.fn(async () => {});
    const reconciler = new ExecutionReconciler({ coreDb: db, advanceIdleCleanup });
    const prepared = discoveryIntent(1);
    const committed: ExecutionJournalIntent = {
      ...prepared,
      carriage: { ...prepared.carriage, operation: 'workspace.collect' },
      control: { ...prepared.control, kind: 'collect' },
    };
    const read = journalOwner.listExecutionCandidates;
    const discovered: string[] = [];
    let queued = false;
    let projection: journalOwner.ExecutionCandidate | undefined;
    const discovery = vi
      .spyOn(journalOwner, 'listExecutionCandidates')
      .mockImplementation((...args) => {
        const actual = read(...args);
        // Scheduling-only projection: the real collect invocation grants no physical authority.
        const page = projection ? { candidates: [projection], next: null } : actual;
        discovered.push(...page.candidates.map(({ ref }) => ref.execution.executionId));
        if (page.next === null && page.candidates.length === 0 && !queued) {
          queued = true;
          queueMicrotask(() => {
            const invocation = controlStoreFor(db.sqlite).write(() =>
              writeExecutionJournalIntent(db, committed)
            );
            projection = { ref: invocation.ref, revision: 1 };
            reconciler.wake();
          });
        }
        return page;
      });
    try {
      applyMigrations(db);
      await reconciler.runOnce();
      // DX Global Dispatch: wake must survive the interval between scan exhaustion and pass release.
      // A second runOnce would hide a lost automatic follow-up in that completion interval.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(queued).toBe(true);
      expect(discovered).toContain(committed.execution.ref.executionId);
      expect(advanceIdleCleanup).not.toHaveBeenCalled();
    } finally {
      await reconciler.stop();
      discovery.mockRestore();
      db.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('rediscovers work committed during a pass and after scan exhaustion', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-execution-wake-'));
    const db = openCoreDb(dataRoot);
    const advanceIdleCleanup = vi.fn(async () => {});
    const reconciler = new ExecutionReconciler({ coreDb: db, advanceIdleCleanup });
    const read = journalOwner.listExecutionCandidates;
    const discovered: string[] = [];
    const projections: journalOwner.ExecutionCandidate[] = [];
    let injected = false;
    let continued = false;
    const collection = (index: number): ExecutionJournalIntent => {
      const intent = discoveryIntent(index);
      return {
        ...intent,
        carriage: { ...intent.carriage, operation: 'workspace.collect' },
        control: { ...intent.control, kind: 'collect' },
      };
    };
    const earlier = collection(2);
    const exhausted = collection(3);
    const commitProjection = (intent: ExecutionJournalIntent) => {
      const invocation = controlStoreFor(db.sqlite).write(() =>
        writeExecutionJournalIntent(db, intent)
      );
      projections.push({ ref: invocation.ref, revision: 1 });
    };
    const discovery = vi
      .spyOn(journalOwner, 'listExecutionCandidates')
      .mockImplementation((...args) => {
        read(...args);
        // These projections isolate invalidation scheduling, not pending-resident selection.
        const page = { candidates: [...projections], next: continued ? null : 'scheduling-cut' };
        continued = true;
        discovered.push(...page.candidates.map(({ ref }) => ref.execution.executionId));
        if (args[1] !== null && args[1] !== undefined && !injected) {
          injected = true;
          commitProjection(earlier);
          reconciler.wake();
        }
        return page;
      });
    try {
      applyMigrations(db);
      commitProjection(collection(1));
      await reconciler.runOnce();
      // DX Global Dispatch: a commit during selection invalidates the active pass.
      expect(injected).toBe(true);
      expect(discovered).toContain(earlier.execution.ref.executionId);

      discovered.length = 0;
      commitProjection(exhausted);
      reconciler.wake();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(discovered).toContain(exhausted.execution.ref.executionId);
      expect(advanceIdleCleanup).not.toHaveBeenCalled();
    } finally {
      await reconciler.stop();
      discovery.mockRestore();
      db.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('advances only the pending resident without reading poisoned completed history', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-execution-pending-selection-'));
    ensureLayout(dataRoot);
    const db = openCoreDb(dataRoot);
    applyMigrations(db);
    const ownerUserId = ensureLocalUser(db);
    const store = await createDemoStore({ dataRoot });
    recordWorkspaceOwnerMembership({ coreDb: db, ownerUserId, workspaceId: DEMO_WORKSPACE_ID });
    const { manifest } = createTestAgentSetup({
      imageRef: `sha256:${'a'.repeat(64)}`,
      requiredCapabilities: ['trusted-worker-inference-relay'],
    });
    admitTestNativeEnvironment(db, manifest);
    const native = createNativeTaskAdmissionFixture(db, store, {
      readRuntimeConfig: () =>
        createInMemoryRuntimeConfigSnapshot({
          ...loadRuntimeConfig(dataRoot),
          agentManifests: [manifest],
          gatewayConfig: createTestGatewayConfig(),
          providerRegistry: new ProviderRegistry([
            {
              id: 'agent-openrouter',
              displayName: 'Pending selection fixture',
              kind: 'local',
              models: ['openai/gpt-5.2'],
            },
          ]),
        }),
    });
    let admitted: Awaited<ReturnType<typeof native.admitTurn>> | undefined;
    let cut: { mockRestore(): void } | undefined;
    const advanceIdleCleanup = vi.fn(async () => {});
    const reconciler = new ExecutionReconciler({ coreDb: db, advanceIdleCleanup });
    try {
      const requestId = testEntityId('tu', 'pending_selection_request').slice(3);
      const entry = createSchedulerAdmissionEntry(db, {
        backendId: 'nanohost',
        queueEntryId: 'queue:pending-selection',
        requestId,
        requestedAgentId: manifest.id,
        workspaceId: DEMO_WORKSPACE_ID,
        threadId: DEMO_THREAD_ID,
        turnId: testEntityId('tu', 'pending_selection'),
        turnInput: 'Keep only current resident cleanup eligible for selection.',
        triggerActor: { kind: 'user', id: ownerUserId },
      });
      const scope = {
        workspaceId: entry.workspaceId,
        threadId: entry.threadId,
        actorId: ownerUserId,
      };
      const createdAt = new Date().toISOString();
      await store.createTurn(
        entry.workspaceId,
        entry.threadId,
        entry.turnInput,
        entry.triggerActor,
        undefined,
        {
          turnId: entry.turnId,
          status: 'pending',
          agentId: manifest.id,
          executorKind: 'worker',
          commandReceipt: {
            key: commandRequestKey('turn.start', requestId, scope),
            command: 'turn.start',
            requestId,
            scope,
            inputHash: commandInputHash({
              queueEntryId: entry.queueEntryId,
              turnInput: entry.turnInput,
            }),
            responseKind: 'turn',
            createdAt,
            expiresAt: commandRequestExpiresAt(createdAt),
          },
        }
      );
      const agentSessionId = testEntityId('as', 'pending_selection');
      admitted = await native.admitTurn(entry, {
        attemptId: testEntityId('attempt', 'pending_selection'),
        agentSessionId,
        candidateAgentSessionId: agentSessionId,
      });
      const backend = native.executor.executionBackend as WorkerGovernanceBackend;
      const identity = backend.planSession(admitted.pkg);
      await admitted.complete();
      const attempt = requireSchedulerExecutionAttempt(db, admitted.attempt.attemptId);
      expect(attempt.phase).toBe('closed');
      expect(attempt.fenceRef).toEqual(expect.any(String));
      const originalTurn = store.getTurnById(entry.turnId);
      const anchor = getWorkerBackendSession(db, attempt.attemptId)!;
      const storage = getWorkerStorageBinding(
        db,
        store.getAgentSession(agentSessionId).retainedStorage!
      );
      if (!storage?.currentSandboxBindingRef) throw new Error('Missing actual retained resident.');
      drainNanoHostSandboxAdmission(db, {
        sandboxBindingRef: storage.currentSandboxBindingRef,
        originPhysicalEpoch: anchor.originPhysicalEpoch,
      });
      const preDeleteCut = new Error('Stop before the pending resident first delete intent.');
      const write = journalOwner.writeExecutionJournalIntent;
      let bridge: ReturnType<typeof write> | undefined;
      let deleteRefused = false;
      cut = vi.spyOn(journalOwner, 'writeExecutionJournalIntent').mockImplementation((...args) => {
        if (args[0] === db && args[1].carriage.operation === 'sandbox.delete') {
          deleteRefused = true;
          throw preDeleteCut;
        }
        const original = write(...args);
        if (
          args[0] === db &&
          original.carriage.operation === 'bridge.close' &&
          original.control.kind !== 'consume-receipt'
        )
          bridge = original;
        return original;
      });
      await backend
        .cleanupSession(identity, { failedCloseout: false, wholeSandbox: true })
        .catch(() => undefined);
      expect(deleteRefused, 'Real cleanup must reach the pre-delete cut.').toBe(true);
      await native.runtime.executionReconciler.stop().catch(() => undefined);
      cut.mockRestore();
      cut = undefined;
      if (!bridge) throw new Error('Real cleanup has no admitted bridge original.');
      const reader = createExecutionStepJournalReader(db, { kind: 'server' });
      const root = await reader.readExecution(bridge.ref.execution);
      const completed = await reader.readInvocation(bridge.ref);
      expect(root.phase).toBe('closed');
      expect(completed.state).toBe('completed');
      expect(
        (await reader.readLinkedInspections(bridge.ref)).some(
          ({ inspection }) =>
            inspection.state === 'completed' && inspection.control.kind === 'consume-receipt'
        )
      ).toBe(true);
      expect(hasIdleCleanupExecution(db, anchor)).toBe(true);

      // Journal primitives model retired storage history only, never accepted Native authority.
      const historical = [];
      for (let index = 1; index <= 160; index += 1) {
        const intent = discoveryIntent(index);
        const original = controlStoreFor(db.sqlite).write(() =>
          writeExecutionJournalIntent(db, intent)
        );
        const historicalRoot = await reader.readExecution(original.ref.execution);
        controlStoreFor(db.sqlite).write(() =>
          settleExecutionJournalStep(db, {
            ref: original.ref,
            expectedExecutionRevision: historicalRoot.revision,
            state: 'completed',
            outputRefs: [],
            span: {
              ...intent.span,
              endTimeUnixNano: intent.span.startTimeUnixNano + 1n,
              status: { code: 'OK' },
            },
            nextPhase: 'closed',
            terminalCause: null,
            exclusionRefs: [],
          })
        );
        historical.push(original.ref);
      }
      const poisoned = historical[0]!;
      // A missing original is unreadable without disabling immutable-outcome or JSON guards.
      const missing = db.sqlite
        .prepare('DELETE FROM control_execution_steps WHERE execution_id = ? AND step_id = ?')
        .run(poisoned.execution.executionId, poisoned.stepId);
      expect(missing.changes).toBe(1);
      await expect(reader.readInvocation(poisoned)).rejects.toThrow();
      expect((await reader.readExecution(poisoned.execution)).phase).toBe('closed');

      // DX Global Dispatch and Physical Receipt Consumption: select current draining work only.
      await expect(reconciler.runOnce()).resolves.toBeUndefined();
      expect(advanceIdleCleanup).toHaveBeenCalledExactlyOnceWith({
        candidate: { ref: bridge.ref, revision: root.revision },
        identity,
        action: 'delete',
        originPhysicalEpoch: anchor.originPhysicalEpoch,
        sandboxBindingRef: storage.currentSandboxBindingRef,
      });
      expect(await reader.readInvocation(bridge.ref)).toEqual(completed);
      expect(hasIdleCleanupExecution(db, anchor)).toBe(true);
      expect(store.getTurnById(entry.turnId)).toEqual(originalTurn);
      expect(requireSchedulerExecutionAttempt(db, attempt.attemptId)).toEqual(attempt);
      expect(native.effects.filter(({ kind }) => kind === 'bridge.close')).toHaveLength(1);
      expect(native.effects.filter(({ kind }) => kind === 'sandbox.delete')).toHaveLength(0);
    } finally {
      cut?.mockRestore();
      await Promise.allSettled([reconciler.stop(), native.runtime.executionReconciler.stop()]);
      await admitted?.cleanup();
      await native.restore();
      await shutdownControlStoreWorkerClient();
      db.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
