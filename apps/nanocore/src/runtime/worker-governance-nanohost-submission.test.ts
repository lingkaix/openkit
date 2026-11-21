import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { closeTestCoreDb, createTestCoreDb } from '../test-support/store.js';
import * as attempts from './execution-attempts.js';
import { commandInputHash } from './idempotent-command.js';
import {
  type AdmitNanoHostSubmission,
  withPreparedWorkerSubmission,
} from './worker-governance-turn-executor.js';

const observedAt = '2026-11-21T00:01:00.000Z';
const coordinates = {
  attemptId: 'original-attempt',
  inputRef: 'original-input',
  bindingRef: 'original-binding',
};
const attempt: Awaited<ReturnType<AdmitNanoHostSubmission>>['attempt'] = {
  ...coordinates,
  operationId: commandInputHash({
    attemptId: coordinates.attemptId,
    inputRef: coordinates.inputRef,
    operation: 'submit',
  }),
  deadline: '2026-11-21T02:01:00.000Z',
  backendId: 'nanohost',
  phase: 'open',
  disposition: 'unknown',
  workspaceId: 'workspace',
  threadId: 'thread',
  turnId: 'turn',
  agentSessionId: 'session',
  queueEntryId: 'queue',
  preparationInputJson: '{}',
  terminalCause: null,
  outcomeRef: null,
  fenceRef: null,
  createdAt: observedAt,
  updatedAt: observedAt,
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'openkit-native-submit-before-effect-'));
  const coreDb = createTestCoreDb(root);
  const legacy = vi.spyOn(attempts, 'recordSchedulerExecutionOperation').mockResolvedValue(attempt);
  const submit = vi.fn(async (value) => attempts.schedulerExecutionCorrelation(value));
  onTestFinished(() => {
    legacy.mockRestore();
    closeTestCoreDb(coreDb);
    rmSync(root, { recursive: true, force: true });
  });
  return { coreDb, legacy, submit };
}

it('keeps physical submit behind the first FULL Core acknowledgement', async () => {
  const f = fixture();
  const acknowledgement = Promise.withResolvers<Awaited<ReturnType<AdmitNanoHostSubmission>>>();
  const admit = vi.fn(() => acknowledgement.promise);
  const pending = withPreparedWorkerSubmission(
    { coreDb: f.coreDb, ...coordinates, now: () => observedAt, native: { admit } },
    f.submit
  );
  try {
    await Promise.resolve();
    expect(admit).toHaveBeenCalledExactlyOnceWith({ attemptId: coordinates.attemptId, observedAt });
    expect(f.legacy).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  } finally {
    acknowledgement.resolve({ state: 'admitted-now', attempt });
    await pending;
  }
  const correlation = await pending;
  expect(correlation).toMatchObject({ ...coordinates, operationId: attempt.operationId });
  expect(f.submit).toHaveBeenCalledExactlyOnceWith(attempt);
});

it.each(['inspect-original', 'lost-ack', 'changed-grant', 'absent'] as const)(
  'holds %s without dispatch or a legacy recording',
  async (mode) => {
    const f = fixture();
    const admit: AdmitNanoHostSubmission | undefined =
      mode === 'absent'
        ? undefined
        : async () => {
            if (mode === 'lost-ack') throw new Error('Lost Core acknowledgement');
            return {
              state: mode === 'inspect-original' ? 'inspect-original' : 'admitted-now',
              attempt:
                mode === 'changed-grant'
                  ? { ...attempt, operationId: 'changed-operation' }
                  : attempt,
            };
          };
    await expect(
      withPreparedWorkerSubmission(
        { coreDb: f.coreDb, ...coordinates, native: { admit } },
        f.submit
      )
    ).rejects.toMatchObject({ code: 'recovery_required' });
    expect(f.legacy).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  }
);
