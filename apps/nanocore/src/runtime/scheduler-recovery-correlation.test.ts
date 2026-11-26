import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createSchedulerAdmissionEntry } from '../scheduler-records.js';
import type { CoreDb } from '../storage/db.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { schedulerFixtureInput } from '../test-support/scheduler-admissions.js';
import { createTestCoreDb, disposeTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  acceptSchedulerExecutionObservation,
  closeSchedulerExecutionAttemptWithFence,
  markSchedulerExecutionAttemptClosing,
  recordSchedulerExecutionOperation,
  requireSchedulerExecutionAttempt,
  type SchedulerExecutionAttemptRecord,
  schedulerExecutionCorrelation,
} from './execution-attempts.js';
import type { ExecutionBackendObservation, ExecutionBackendPort } from './execution-backend.js';
import { runSchedulerRecoveryMaintenance } from './scheduler-restart-recovery.js';

const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';

/** Records a prepared attempt or an unknown submission for recovery. */
function recoveryAttempt(
  db: CoreDb,
  name: string,
  at: string,
  { submitted = true, threadId = testEntityId('th', name) } = {}
) {
  const turnId = testEntityId('tu', name);
  const entry = createSchedulerAdmissionEntry(db, {
    backendId: 'nanohost',
    triggerActor: { kind: 'user', id: FIXTURE_LOCAL_USER_ID },
    queueEntryId: `queue_${name}`,
    requestId: `request_${name}`,
    requestedAgentId: 'agent_codex_host',
    threadId,
    turnId,
    inputRef: schedulerFixtureInput(workspaceId, turnId, 'Recover the exact attempt'),
    workspaceId,
    now: () => at,
  });
  return recordTestExecutionAttempt(db, {
    entry,
    attemptId: testEntityId('attempt', name),
    agentSessionId: testEntityId('as', name),
    inputRef: `package_${name}`,
    bindingRef: `binding_${name}`,
    sessionCompatibilityKey: 'recovery-correlation',
    now: () => at,
    ...(submitted ? { operationId: `operation_${name}` } : {}),
  });
}

it.each(['inspect', 'cancel'] as const)(
  'ignores another durable attempt result returned by recovery %s',
  async (operation) => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-recovery-correlation-'));
    const db = createTestCoreDb(root);
    try {
      ensureLocalUser(db);
      const store = await createDemoStore({ dataRoot: root });
      recordWorkspaceOwnerMembership({
        coreDb: db,
        ownerUserId: FIXTURE_LOCAL_USER_ID,
        workspaceId,
      });
      const original = recoveryAttempt(db, 'original-recovery', '2026-07-05T00:00:01.000Z');
      const newer = recoveryAttempt(db, 'newer-recovery', '2026-07-05T00:01:00.000Z');
      const [target, foreign] = operation === 'inspect' ? [newer, original] : [original, newer];
      const requested = schedulerExecutionCorrelation(target);
      const received: ExecutionBackendObservation = {
        ...schedulerExecutionCorrelation(foreign),
        disposition: 'accepted',
        execution: 'terminal',
        outcomeRef: 'foreign-outcome',
        fenceRef: 'foreign-fence',
      };
      const delivery = Promise.withResolvers<ExecutionBackendObservation>();
      const backend = {
        id: 'nanohost',
        inspect: vi.fn<ExecutionBackendPort['inspect']>(async (key) =>
          operation === 'inspect' && key.attemptId === target.attemptId ? delivery.promise : null
        ),
        cancel: vi.fn<ExecutionBackendPort['cancel']>(async () => delivery.promise),
        submit: vi.fn<ExecutionBackendPort['submit']>(),
        release: vi.fn<ExecutionBackendPort['release']>(),
      } satisfies ExecutionBackendPort;
      const input = {
        store,
        executionBackend: backend,
        now: () =>
          operation === 'cancel' ? '2026-07-05T02:00:01.000Z' : '2026-07-05T00:02:00.000Z',
        projectRecoveredTurn: vi.fn(async () => ({ status: 'missing' as const })),
      };
      const pending = runSchedulerRecoveryMaintenance(db, input);
      try {
        await vi.waitFor(() => expect(backend[operation]).toHaveBeenLastCalledWith(requested));
        expect(requireSchedulerExecutionAttempt(db, foreign.attemptId)).toEqual(foreign);
      } finally {
        delivery.resolve(received);
        await pending;
      }
      expect(requireSchedulerExecutionAttempt(db, foreign.attemptId)).toEqual(foreign);
      const held = requireSchedulerExecutionAttempt(db, target.attemptId);
      expect(held).toMatchObject({
        phase: operation === 'cancel' ? 'closing' : 'open',
        disposition: 'unknown',
        fenceRef: null,
        outcomeRef: null,
      });

      backend.inspect.mockImplementation(async (key) =>
        key.attemptId === received.attemptId ? received : null
      );
      await runSchedulerRecoveryMaintenance(db, input);
      expect(requireSchedulerExecutionAttempt(db, foreign.attemptId)).toMatchObject({
        disposition: 'accepted',
        outcomeRef: received.outcomeRef,
        fenceRef: received.fenceRef,
      });
      expect(requireSchedulerExecutionAttempt(db, target.attemptId)).toEqual(held);
      expect(backend.submit).not.toHaveBeenCalled();
      expect(backend.release).not.toHaveBeenCalled();
      expect(input.projectRecoveredTurn).not.toHaveBeenCalled();
    } finally {
      await disposeTestStore(root, db);
    }
  }
);

it('rejects submission evidence from a pending preparation inspection of the same attempt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-recovery-correlation-'));
  const db = createTestCoreDb(root);
  const now = () => '2026-07-05T00:00:02.000Z';
  try {
    ensureLocalUser(db);
    const store = await createDemoStore({ dataRoot: root });
    recordWorkspaceOwnerMembership({
      coreDb: db,
      ownerUserId: FIXTURE_LOCAL_USER_ID,
      workspaceId,
    });
    const { attemptId } = recoveryAttempt(db, 'advancing-recovery', '2026-07-05T00:00:01.000Z', {
      submitted: false,
    });
    const preparation = schedulerExecutionCorrelation(
      await recordSchedulerExecutionOperation(db, { attemptId, operationId: 'prepare', now })
    );
    const delivery = Promise.withResolvers<ExecutionBackendObservation | null>();
    const backend = {
      id: 'nanohost',
      inspect: vi.fn<ExecutionBackendPort['inspect']>(async () => delivery.promise),
      cancel: vi.fn<ExecutionBackendPort['cancel']>(),
      submit: vi.fn<ExecutionBackendPort['submit']>(),
      release: vi.fn<ExecutionBackendPort['release']>(),
    } satisfies ExecutionBackendPort;
    const input = {
      store,
      executionBackend: backend,
      now,
      projectRecoveredTurn: vi.fn(async () => ({ status: 'missing' as const })),
    };

    const pending = runSchedulerRecoveryMaintenance(db, input);
    let submitted: SchedulerExecutionAttemptRecord;
    try {
      await vi.waitFor(() => expect(backend.inspect).toHaveBeenCalledWith(preparation));
      await acceptSchedulerExecutionObservation(db, {
        ...preparation,
        disposition: 'accepted',
        execution: 'terminal',
        outcomeRef: null,
        fenceRef: null,
      });
      submitted = await recordSchedulerExecutionOperation(db, {
        attemptId,
        operationId: 'submit',
        submission: true,
        now,
      });
      delivery.resolve({
        ...schedulerExecutionCorrelation(submitted),
        disposition: 'accepted',
        execution: 'terminal',
        outcomeRef: 'crossed-outcome',
        fenceRef: 'crossed-fence',
      });
    } finally {
      delivery.resolve(null);
      await pending;
    }
    expect(submitted).toMatchObject({ disposition: 'unknown', outcomeRef: null, fenceRef: null });
    expect(backend.inspect.mock.calls).toEqual([[preparation]]);
    const afterCrossedReply = requireSchedulerExecutionAttempt(db, attemptId);

    const submission = schedulerExecutionCorrelation(submitted);
    expect(submission).toEqual({ ...preparation, operationId: 'submit' });
    const exact: ExecutionBackendObservation = {
      ...submission,
      disposition: 'accepted',
      execution: 'terminal',
      outcomeRef: 'submission-outcome',
      fenceRef: 'submission-fence',
    };
    backend.inspect.mockResolvedValue(exact);
    await runSchedulerRecoveryMaintenance(db, input);
    expect(backend.inspect.mock.calls).toEqual([[preparation], [submission]]);
    expect.soft(afterCrossedReply).toEqual(submitted);
    expect.soft(requireSchedulerExecutionAttempt(db, attemptId)).toMatchObject({
      disposition: 'accepted',
      outcomeRef: exact.outcomeRef,
      fenceRef: exact.fenceRef,
    });
    expect(backend.cancel).not.toHaveBeenCalled();
    expect(backend.submit).not.toHaveBeenCalled();
    expect(backend.release).not.toHaveBeenCalled();
    expect(input.projectRecoveredTurn).not.toHaveBeenCalled();
  } finally {
    await disposeTestStore(root, db);
  }
});

it('keeps a delayed original result from changing either attempt after successor placement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-recovery-correlation-'));
  const db = createTestCoreDb(root);
  const now = () => '2026-07-05T00:02:00.000Z';
  try {
    ensureLocalUser(db);
    const store = await createDemoStore({ dataRoot: root });
    recordWorkspaceOwnerMembership({ coreDb: db, ownerUserId: FIXTURE_LOCAL_USER_ID, workspaceId });
    const original = recoveryAttempt(db, 'late-original', '2026-07-05T00:00:01.000Z');
    await markSchedulerExecutionAttemptClosing(db, {
      attemptId: original.attemptId,
      cause: 'turn-cancelled',
      now,
    });
    const originalKey = schedulerExecutionCorrelation(original);
    const originalFence = 'original-release-fence';
    const delivery = Promise.withResolvers<ExecutionBackendObservation>();
    const backend = {
      id: 'nanohost',
      inspect: vi.fn<ExecutionBackendPort['inspect']>(async () => delivery.promise),
      cancel: vi.fn<ExecutionBackendPort['cancel']>(),
      submit: vi.fn<ExecutionBackendPort['submit']>(),
      release: vi.fn<ExecutionBackendPort['release']>(),
    } satisfies ExecutionBackendPort;
    const input = {
      store,
      executionBackend: backend,
      now,
      projectRecoveredTurn: vi.fn(async () => ({ status: 'missing' as const })),
    };

    const pending = runSchedulerRecoveryMaintenance(db, input);
    let closed: SchedulerExecutionAttemptRecord;
    let successor: SchedulerExecutionAttemptRecord;
    try {
      await vi.waitFor(() => expect(backend.inspect).toHaveBeenCalledExactlyOnceWith(originalKey));
      closed = await closeSchedulerExecutionAttemptWithFence(db, {
        correlation: originalKey,
        proof: {
          terminalHandoff: true,
          output: true,
          evidence: true,
          outsideWorkspaceCollection: true,
          integrationDrain: true,
          routesRevoked: true,
        },
        fenceRef: originalFence,
        now,
      });
      expect(closed).toMatchObject({ phase: 'closed', disposition: 'unknown', outcomeRef: null });
      successor = recoveryAttempt(db, 'after-original-release', now(), {
        threadId: original.threadId,
      });
      expect(successor).toMatchObject({ phase: 'open', disposition: 'unknown', outcomeRef: null });
    } finally {
      delivery.resolve({
        ...originalKey,
        disposition: 'accepted',
        execution: 'terminal',
        outcomeRef: 'late-original-outcome',
        fenceRef: originalFence,
      });
      await pending;
    }
    expect(requireSchedulerExecutionAttempt(db, original.attemptId)).toEqual(closed);
    expect(requireSchedulerExecutionAttempt(db, successor.attemptId)).toEqual(successor);

    const successorKey = schedulerExecutionCorrelation(successor);
    backend.inspect.mockResolvedValue({
      ...successorKey,
      disposition: 'accepted',
      execution: 'running',
      outcomeRef: 'successor-outcome',
      fenceRef: null,
    });
    await runSchedulerRecoveryMaintenance(db, input);
    expect(backend.inspect.mock.calls).toEqual([[originalKey], [successorKey]]);
    expect(requireSchedulerExecutionAttempt(db, original.attemptId)).toEqual(closed);
    expect(requireSchedulerExecutionAttempt(db, successor.attemptId)).toMatchObject({
      phase: 'open',
      disposition: 'accepted',
      outcomeRef: 'successor-outcome',
      fenceRef: null,
    });
    expect(backend.submit).not.toHaveBeenCalled();
    expect(backend.cancel).not.toHaveBeenCalled();
    expect(backend.release).not.toHaveBeenCalled();
    expect(input.projectRecoveredTurn).not.toHaveBeenCalled();
  } finally {
    await disposeTestStore(root, db);
  }
});
