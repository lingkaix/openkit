import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  createSchedulerAdmissionEntry,
  findNextDispatchableSchedulerAdmissionEntry,
  requireSchedulerAdmissionEntry,
} from '../scheduler-records.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { recordTestExecutionAttempt } from '../test-support/execution-attempt.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { schedulerFixtureInput } from '../test-support/scheduler-admissions.js';
import {
  closeTestCoreDb,
  createTestCoreDb,
  disposeTestStore,
  shutdownTestStoreWorker,
} from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  acceptSchedulerExecutionObservation,
  closeSchedulerExecutionAttemptWithFence,
  createSchedulerExecutionAttempt,
  listSchedulerExecutionAttemptsByTurnId,
  markSchedulerExecutionAttemptClosing,
  requireSchedulerExecutionAttempt,
  schedulerExecutionCorrelation,
} from './execution-attempts.js';

it.each(['before commit', 'after commit'] as const)(
  'recovers an exact Core release when the close reply is lost %s',
  async (lossPoint) => {
    const root = mkdtempSync(join(tmpdir(), 'openkit-release-ack-'));
    let db = createTestCoreDb(root);
    const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
    const threadId = testEntityId('th', 'release-ack');
    const closingAt = '2026-07-05T00:00:02.000Z';
    const releaseAt = '2026-07-05T00:00:03.000Z';
    const retryAt = '2026-07-05T00:00:04.000Z';
    const commitBeforeLoss = lossPoint === 'after commit';

    /** Queues another Turn on the same Thread so the scheduler must consult the predecessor. */
    function enqueue(name: string) {
      const turnId = testEntityId('tu', name);
      return createSchedulerAdmissionEntry(db, {
        queueEntryId: `queue_${name}`,
        requestId: `request_${name}`,
        backendId: 'nanohost',
        triggerActor: { kind: 'user', id: FIXTURE_LOCAL_USER_ID },
        requestedAgentId: 'agent_codex_host',
        threadId,
        turnId,
        workspaceId,
        inputRef: schedulerFixtureInput(workspaceId, turnId, 'Recover the exact Core release.'),
      });
    }

    try {
      ensureLocalUser(db);
      recordWorkspaceOwnerMembership({
        coreDb: db,
        workspaceId,
        ownerUserId: FIXTURE_LOCAL_USER_ID,
      });
      const predecessor = recordTestExecutionAttempt(db, {
        entry: enqueue('release-predecessor'),
        attemptId: testEntityId('attempt', 'release-predecessor'),
        agentSessionId: testEntityId('as', 'release-predecessor'),
        bindingRef: 'release-binding',
        inputRef: 'release-input',
        operationId: 'release-submission',
        sessionCompatibilityKey: 'release-ack',
        now: () => '2026-07-05T00:00:01.000Z',
      });
      const correlation = schedulerExecutionCorrelation(predecessor);
      await acceptSchedulerExecutionObservation(db, {
        ...correlation,
        disposition: 'accepted',
        execution: 'terminal',
        outcomeRef: 'release-outcome',
        fenceRef: null,
      });
      const closing = await markSchedulerExecutionAttemptClosing(db, {
        attemptId: predecessor.attemptId,
        cause: 'turn-completed',
        now: () => closingAt,
      });
      const successor = enqueue('release-successor');
      expect(findNextDispatchableSchedulerAdmissionEntry(db)).toBeNull();
      const release = {
        correlation,
        proof: {
          terminalHandoff: true,
          output: true,
          evidence: true,
          outsideWorkspaceCollection: true,
          integrationDrain: true,
          routesRevoked: true,
        },
        fenceRef: 'original-release-fence',
      };

      const client = getControlStoreWorkerClient();
      const apply = client.executionAttempt.bind(client);
      const lost = new Error('Simulated loss of the Core release reply.');
      const delivery = vi
        .spyOn(client, 'executionAttempt')
        .mockImplementationOnce(async (...args) => {
          expect(args[1]).toMatchObject({ kind: 'close-with-fence', ...release });
          if (commitBeforeLoss) await apply(...args);
          throw lost;
        });
      try {
        await expect(
          closeSchedulerExecutionAttemptWithFence(db, { ...release, now: () => releaseAt })
        ).rejects.toBe(lost);
      } finally {
        delivery.mockRestore();
      }

      const decided = commitBeforeLoss
        ? { ...closing, phase: 'closed', fenceRef: release.fenceRef, updatedAt: releaseAt }
        : closing;
      const nextAfterLoss = commitBeforeLoss ? successor : null;
      expect(requireSchedulerExecutionAttempt(db, predecessor.attemptId)).toEqual(decided);
      expect(findNextDispatchableSchedulerAdmissionEntry(db)).toEqual(nextAfterLoss);

      await shutdownTestStoreWorker();
      closeTestCoreDb(db);
      db = createTestCoreDb(root);
      expect(requireSchedulerExecutionAttempt(db, predecessor.attemptId)).toEqual(decided);
      expect(findNextDispatchableSchedulerAdmissionEntry(db)).toEqual(nextAfterLoss);

      const successorClaim = { entry: successor, preparationInput: { admission: successor } };
      if (!commitBeforeLoss) {
        await expect(createSchedulerExecutionAttempt(db, successorClaim)).rejects.toThrow();
        expect(requireSchedulerExecutionAttempt(db, predecessor.attemptId)).toEqual(closing);
        expect(requireSchedulerAdmissionEntry(db, successor.queueEntryId)).toEqual(successor);
        expect(listSchedulerExecutionAttemptsByTurnId(db, successor.turnId)).toEqual([]);

        const rejectedReleases = [
          [
            'different operation',
            { ...release, correlation: { ...correlation, operationId: 'other-operation' } },
          ],
          [
            'different binding',
            { ...release, correlation: { ...correlation, bindingRef: 'other-binding' } },
          ],
          ...Object.keys(release.proof).map(
            (handoff) =>
              [
                `missing ${handoff}`,
                { ...release, proof: { ...release.proof, [handoff]: false } },
              ] as const
          ),
        ] as const;
        for (const [reason, unproved] of rejectedReleases) {
          await expect(
            closeSchedulerExecutionAttemptWithFence(db, unproved),
            reason
          ).rejects.toThrow();
          expect(requireSchedulerExecutionAttempt(db, predecessor.attemptId), reason).toEqual(
            closing
          );
          expect(requireSchedulerAdmissionEntry(db, successor.queueEntryId), reason).toEqual(
            successor
          );
          expect(findNextDispatchableSchedulerAdmissionEntry(db), reason).toBeNull();
        }
      }

      const closed = await closeSchedulerExecutionAttemptWithFence(db, {
        ...release,
        now: () => retryAt,
      });
      expect(closed).toEqual({
        ...closing,
        phase: 'closed',
        fenceRef: release.fenceRef,
        updatedAt: commitBeforeLoss ? releaseAt : retryAt,
      });
      expect(findNextDispatchableSchedulerAdmissionEntry(db)).toEqual(successor);
      const admitted = await createSchedulerExecutionAttempt(db, successorClaim);
      expect(
        await closeSchedulerExecutionAttemptWithFence(db, {
          ...release,
          now: () => '2026-07-05T00:00:05.000Z',
        })
      ).toEqual(closed);
      expect(requireSchedulerExecutionAttempt(db, admitted.attemptId)).toEqual(admitted);
      expect(requireSchedulerAdmissionEntry(db, successor.queueEntryId).status).toBe('admitted');
      expect(findNextDispatchableSchedulerAdmissionEntry(db)).toBeNull();
    } finally {
      await disposeTestStore(root, db);
    }
  }
);
