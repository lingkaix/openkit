import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '@openkit/protocol/digest';
import { afterEach, expect, it, vi } from 'vitest';
import { disableCanonicalUser } from '../auth/user-lifecycle.js';
import {
  requireSchedulerExecutionAttempt,
  schedulerExecutionCorrelation,
} from '../runtime/execution-attempt-records.js';
import {
  acceptSchedulerExecutionObservation,
  bindNanoHostAttemptPreparation,
  bindSchedulerExecutionAttemptSession,
  closeSchedulerExecutionAttemptWithFence,
  closeSchedulerExecutionAttemptWithoutEffects,
  createSchedulerExecutionAttempt,
  finalizeSchedulerExecutionAttemptInput,
  markNanoHostAttemptNeedsEvidence,
  markSchedulerExecutionAttemptClosing,
  recordSchedulerExecutionOperation,
} from '../runtime/execution-attempts.js';
import { requireNanoHostExecutionAttempt } from '../runtime/nanohost-attempt-records.js';
import {
  createSchedulerAdmissionEntry,
  requireSchedulerAdmissionEntry,
} from '../scheduler-records.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { schedulerFixtureInput } from '../test-support/scheduler-admissions.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import {
  ControlStoreWorkerError,
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { type CoreDb, openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';
import { nativeProductScope } from './workspace-file-records.js';

const roots: string[] = [];
const dbs: CoreDb[] = [];
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  dbs.splice(0).forEach((db) => {
    db.sqlite.close();
  });
  roots.splice(0).forEach((root) => {
    rmSync(root, { recursive: true, force: true });
  });
});

function fixture(label: string, backendId = 'nanohost') {
  const root = mkdtempSync(join(tmpdir(), `openkit-attempt-owner-${label}-`));
  roots.push(root);
  const db = openCoreDb(root);
  dbs.push(db);
  applyMigrations(db);
  ensureLocalUser(db);
  const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
  const actor = { kind: 'user' as const, id: 'usr_00000000-0000-7000-8000-000000000001' };
  recordWorkspaceOwnerMembership({ coreDb: db, workspaceId, ownerUserId: actor.id });
  const turnId = `tu_00000000-0000-7000-8000-${label.padStart(12, '0')}`;
  const entry = createSchedulerAdmissionEntry(db, {
    queueEntryId: `queue-attempt-owner-${label}`,
    backendId,
    triggerActor: actor,
    workspaceId,
    threadId: 'th_00000000-0000-7000-8000-000000000001',
    turnId,
    inputRef: schedulerFixtureInput(
      workspaceId,
      turnId,
      'Exercise the native execution-attempt owner.'
    ),
    requestedAgentId: 'agent_worker',
  });
  db.sqlite.pragma('query_only = ON');
  return { db, entry, root };
}

const releaseProof = {
  terminalHandoff: true,
  output: true,
  evidence: true,
  outsideWorkspaceCollection: true,
  integrationDrain: true,
  routesRevoked: true,
} as const;

it.each(['openai-agents', 'e2b'])('withholds %s attempt effects in v0.2.0', async (backendId) => {
  const { db, entry } = fixture('10', backendId);
  await expect(
    createSchedulerExecutionAttempt(db, { entry, preparationInput: { admission: entry } })
  ).rejects.toThrow('Execution backend effects are unavailable.');
  expect(requireSchedulerAdmissionEntry(db, entry.queueEntryId).status).toBe('queued');
  expect(db.sqlite.prepare('SELECT count(*) FROM scheduler_execution_attempts').pluck().get()).toBe(
    0
  );
});

it('does not turn a retained Agents API predecessor into a session-current cancel', async () => {
  const { db, entry } = fixture('11');
  const attempt = await createSchedulerExecutionAttempt(db, {
    entry,
    preparationInput: { admission: entry },
  });
  const nativeCancel = vi.fn();
  const retainedPredecessor = {
    ...attempt,
    backendId: 'openai-agents',
    operationId: 'original-predecessor-cancel',
  };
  expect(() => nativeCancel(schedulerExecutionCorrelation(retainedPredecessor))).toThrow(
    'Execution backend effects are unavailable.'
  );
  expect(nativeCancel).not.toHaveBeenCalled();
});

it('requires a file-local admission with the original attempt scope', async () => {
  const { db, entry, root } = fixture('12');
  const attempt = await createSchedulerExecutionAttempt(db, {
    entry,
    preparationInput: { admission: entry },
  });
  const native = openCoreDb(root);
  try {
    expect(() =>
      native.sqlite
        .prepare('UPDATE scheduler_execution_attempts SET thread_id = ? WHERE attempt_id = ?')
        .run('contradictory-thread', attempt.attemptId)
    ).toThrow('FOREIGN KEY constraint failed');
    expect(() =>
      native.sqlite
        .prepare('DELETE FROM scheduler_admission_entries WHERE queue_entry_id = ?')
        .run(entry.queueEntryId)
    ).toThrow('FOREIGN KEY constraint failed');
    expect(requireSchedulerExecutionAttempt(db, attempt.attemptId).threadId).toBe(entry.threadId);
  } finally {
    native.sqlite.close();
  }
});

it('owns the accepted execution attempt lifecycle while the Main Core handle is read only', async () => {
  const { db, entry } = fixture('1');
  const preparationInput = {
    admission: entry,
    exact: true,
    retainedContext: `${'a'.repeat(1_048_600)}é`,
  };
  expect(Buffer.byteLength(JSON.stringify(preparationInput))).toBeGreaterThan(1024 * 1024);
  const attempt = await createSchedulerExecutionAttempt(db, {
    entry,
    attemptId: 'attempt_00000000-0000-7000-8000-000000000001',
    preparationInput,
    now: () => '2026-11-01T00:00:00.000Z',
  });
  const claim = db.sqlite
    .prepare(`SELECT json_extract(invocation_json, '$.carriage.schedulerPreparation')
    FROM control_execution_steps WHERE execution_id=? AND step_id='claim'`)
    .pluck()
    .get(`scheduler-lifecycle:${attempt.attemptId}`) as string;
  expect(JSON.parse(claim)).toMatchObject({
    queueEntryId: entry.queueEntryId,
    admissionHash: entry.inputHash,
    inputDigest: entry.inputRef.digest,
    preparationDigest: sha256Hex(JSON.stringify(preparationInput)),
  });
  expect(attempt.preparationInputJson).not.toContain('retainedContext');
  expect(requireSchedulerAdmissionEntry(db, entry.queueEntryId).status).toBe('admitted');
  const binding = {
    attemptId: attempt.attemptId,
    agentSessionId: 'as_00000000-0000-7000-8000-000000000001',
  };
  const firstBinding = await bindSchedulerExecutionAttemptSession(db, {
    ...binding,
    now: () => '2026-11-01T00:00:01.000Z',
  });
  await shutdownControlStoreWorkerClient();
  expect(
    await bindSchedulerExecutionAttemptSession(db, {
      ...binding,
      now: () => '2026-11-01T00:00:01.500Z',
    })
  ).toEqual(firstBinding);
  await finalizeSchedulerExecutionAttemptInput(db, {
    attemptId: attempt.attemptId,
    inputRef: 'input-owner-1',
    bindingRef: 'binding-owner-1',
    now: () => '2026-11-01T00:00:02.000Z',
  });
  const submitted = await recordSchedulerExecutionOperation(db, {
    attemptId: attempt.attemptId,
    operationId: 'operation-owner-1',
    submission: true,
    now: () => '2026-11-01T00:00:03.000Z',
  });
  const correlation = schedulerExecutionCorrelation(submitted);
  expect(
    await acceptSchedulerExecutionObservation(db, {
      ...correlation,
      disposition: 'accepted',
      execution: 'running',
      outcomeRef: null,
      fenceRef: null,
    })
  ).toMatchObject({ disposition: 'accepted', phase: 'open' });
  const beforeExpiry = db.sqlite.prepare('SELECT * FROM scheduler_execution_attempts').get();
  expect(
    await markSchedulerExecutionAttemptClosing(db, {
      attemptId: attempt.attemptId,
      cause: 'preparation-deadline',
      requireUnsubmitted: true,
    })
  ).toMatchObject({ phase: 'open', deadline: submitted.deadline, terminalCause: null });
  expect(db.sqlite.prepare('SELECT * FROM scheduler_execution_attempts').get()).toEqual(
    beforeExpiry
  );
  expect(
    await markSchedulerExecutionAttemptClosing(db, {
      attemptId: attempt.attemptId,
      cause: 'turn-completed',
      outcomeRef: 'turn:tu_00000000-0000-7000-8000-000000000001:completed',
      now: () => '2026-11-01T00:00:04.000Z',
    })
  ).toMatchObject({ phase: 'closing', terminalCause: 'turn-completed' });
  const closed = await closeSchedulerExecutionAttemptWithFence(db, {
    correlation,
    proof: releaseProof,
    fenceRef: 'fence-owner-1',
    now: () => '2026-11-01T00:00:05.000Z',
  });
  expect(closed).toMatchObject({ phase: 'closed', fenceRef: 'fence-owner-1' });
  const beforeReplay = db.sqlite.prepare('SELECT * FROM scheduler_execution_attempts').get();
  expect(
    await closeSchedulerExecutionAttemptWithFence(db, {
      correlation,
      proof: releaseProof,
      fenceRef: 'fence-owner-1',
      now: () => '2026-11-01T00:00:06.000Z',
    })
  ).toEqual(closed);
  await expect(
    closeSchedulerExecutionAttemptWithFence(db, {
      correlation,
      proof: releaseProof,
      fenceRef: 'changed-fence',
    })
  ).rejects.toThrow('Attempt release has unresolved handoff or fencing proof.');
  expect(db.sqlite.prepare('SELECT * FROM scheduler_execution_attempts').get()).toEqual(
    beforeReplay
  );
});

it('closes a proved no-effect attempt and requeues its original admission exactly once', async () => {
  const { db, entry } = fixture('2');
  const attempt = await createSchedulerExecutionAttempt(db, {
    entry,
    attemptId: 'attempt_00000000-0000-7000-8000-000000000002',
    preparationInput: { admission: entry },
    now: () => '2026-11-01T00:01:00.000Z',
  });
  const closed = await closeSchedulerExecutionAttemptWithoutEffects(db, {
    attemptId: attempt.attemptId,
    noOutstandingEffects: true,
    cause: 'backend-busy',
    requeue: true,
    now: () => '2026-11-01T00:01:01.000Z',
  });
  expect(closed).toMatchObject({
    phase: 'closed',
    disposition: 'not_accepted',
    terminalCause: 'backend-busy',
  });
  expect(requireSchedulerAdmissionEntry(db, entry.queueEntryId).status).toBe('queued');
  const beforeReplay = {
    attempt: db.sqlite.prepare('SELECT * FROM scheduler_execution_attempts').get(),
    admission: db.sqlite.prepare('SELECT * FROM scheduler_admission_entries').get(),
  };
  expect(
    await closeSchedulerExecutionAttemptWithoutEffects(db, {
      attemptId: attempt.attemptId,
      noOutstandingEffects: true,
      cause: 'changed-cause',
      requeue: true,
    })
  ).toEqual(closed);
  expect({
    attempt: db.sqlite.prepare('SELECT * FROM scheduler_execution_attempts').get(),
    admission: db.sqlite.prepare('SELECT * FROM scheduler_admission_entries').get(),
  }).toEqual(beforeReplay);
});

it('closes a proved no-effect attempt when the wall clock moves backward', async () => {
  const { db, entry } = fixture('13');
  const claimedAt = '2026-11-01T00:01:00.000Z';
  const closedAt = '2026-11-01T00:00:59.000Z';
  const attempt = await createSchedulerExecutionAttempt(db, {
    entry,
    preparationInput: { admission: entry },
    now: () => claimedAt,
  });
  const closed = await closeSchedulerExecutionAttemptWithoutEffects(db, {
    attemptId: attempt.attemptId,
    noOutstandingEffects: true,
    cause: 'turn-start-failed',
    now: () => closedAt,
  });
  expect(closed).toMatchObject({
    phase: 'closed',
    disposition: 'not_accepted',
    terminalCause: 'turn-start-failed',
    updatedAt: closedAt,
  });
  const terminalSpan = db.sqlite
    .prepare(
      "SELECT json_extract(span_json, '$.endTimeUnixNano') FROM control_executions WHERE id = ?"
    )
    .pluck()
    .get(`scheduler-lifecycle:${attempt.attemptId}`);
  expect(terminalSpan).toBe(String(BigInt(Date.parse(claimedAt)) * 1_000_000n));
});

it('rolls back the new attempt when admission acquisition fails inside the worker transaction', async () => {
  const { db, entry } = fixture('3');
  db.sqlite.pragma('query_only = OFF');
  db.sqlite.exec(`CREATE TRIGGER reject_attempt_acquisition
    BEFORE UPDATE OF status ON scheduler_admission_entries
    WHEN OLD.queue_entry_id = '${entry.queueEntryId}' AND NEW.status = 'admitted'
    BEGIN SELECT RAISE(ABORT, 'injected attempt acquisition failure'); END`);
  db.sqlite.pragma('query_only = ON');
  await expect(
    createSchedulerExecutionAttempt(db, {
      entry,
      attemptId: 'attempt_00000000-0000-7000-8000-000000000003',
      preparationInput: { admission: entry },
    })
  ).rejects.toMatchObject({
    name: ControlStoreWorkerError.name,
    code: 'constraint',
    commit: 'not-committed',
  });
  expect(requireSchedulerAdmissionEntry(db, entry.queueEntryId).status).toBe('queued');
  expect(db.sqlite.prepare('SELECT * FROM scheduler_execution_attempts').all()).toEqual([]);
  expect(
    db.sqlite
      .prepare('SELECT 1 FROM control_execution_steps WHERE execution_id = ?')
      .get('scheduler-lifecycle:attempt_00000000-0000-7000-8000-000000000003')
  ).toBeUndefined();
});

it('commits one attempt when two claims race and the winner loses its acknowledgement', async () => {
  const { db, entry, root } = fixture('9');
  const attemptIds = [
    'attempt_00000000-0000-7000-8000-000000000091',
    'attempt_00000000-0000-7000-8000-000000000092',
  ];
  const lostAcknowledgement = new Error('Simulated loss of the committed claim acknowledgement.');
  const client = getControlStoreWorkerClient();
  const apply = client.executionAttempt.bind(client);
  const replies = vi.spyOn(client, 'executionAttempt').mockImplementation(async (...args) => {
    const result = await apply(...args);
    if (args[1].kind === 'create') throw lostAcknowledgement;
    return result;
  });
  try {
    const claims = await Promise.allSettled(
      attemptIds.map((attemptId) =>
        createSchedulerExecutionAttempt(db, {
          entry,
          attemptId,
          preparationInput: { admission: entry },
        })
      )
    );
    expect(claims.every(({ status }) => status === 'rejected')).toBe(true);
    const failures = claims.flatMap((claim) => (claim.status === 'rejected' ? [claim.reason] : []));
    expect(failures.filter((reason) => reason === lostAcknowledgement)).toHaveLength(1);
  } finally {
    replies.mockRestore();
  }

  await shutdownControlStoreWorkerClient();
  const reopened = openCoreDb(root);
  dbs.push(reopened);
  const rows = reopened.sqlite
    .prepare('SELECT attempt_id AS id FROM scheduler_execution_attempts WHERE queue_entry_id = ?')
    .all(entry.queueEntryId) as { id: string }[];
  expect(rows).toHaveLength(1);
  expect(attemptIds).toContain(rows[0]?.id);
  expect(requireSchedulerExecutionAttempt(reopened, rows[0]!.id)).toMatchObject({
    queueEntryId: entry.queueEntryId,
    phase: 'open',
    operationId: null,
  });
  expect(requireSchedulerAdmissionEntry(reopened, entry.queueEntryId).status).toBe('admitted');
});

it('refuses an admitted same-attempt successor when its queued predecessor fails', async () => {
  const { db, entry } = fixture('4');
  const attempt = await createSchedulerExecutionAttempt(db, {
    entry,
    attemptId: 'attempt_00000000-0000-7000-8000-000000000004',
    preparationInput: { admission: entry },
  });
  db.sqlite.pragma('query_only = OFF');
  db.sqlite.exec(`CREATE TRIGGER reject_first_attempt_binding
    BEFORE UPDATE OF agent_session_id ON scheduler_execution_attempts
    WHEN OLD.attempt_id = '${attempt.attemptId}'
      AND NEW.agent_session_id = 'as_00000000-0000-7000-8000-000000000004'
    BEGIN SELECT RAISE(ABORT, 'injected predecessor refusal'); END`);
  db.sqlite.pragma('query_only = ON');
  const scope = nativeProductScope(db.dataRoot, { kind: 'server' });
  const client = getControlStoreWorkerClient();
  const first = client
    .executionAttempt(`core:${scope.path}`, {
      kind: 'bind-session',
      attemptId: attempt.attemptId,
      agentSessionId: 'as_00000000-0000-7000-8000-000000000004',
      observedAt: '2026-11-01T00:03:01.000Z',
    })
    .catch((error: unknown) => error);
  const successor = client
    .executionAttempt(`core:${scope.path}`, {
      kind: 'bind-session',
      attemptId: attempt.attemptId,
      agentSessionId: 'as_00000000-0000-7000-8000-000000000005',
      observedAt: '2026-11-01T00:03:02.000Z',
    })
    .catch((error: unknown) => error);
  await expect(first).resolves.toMatchObject({ code: 'constraint', commit: 'not-committed' });
  await expect(successor).resolves.toMatchObject({ code: 'precondition', commit: 'not-committed' });
  expect(requireSchedulerExecutionAttempt(db, attempt.attemptId).agentSessionId).toBeNull();

  db.sqlite.pragma('query_only = OFF');
  db.sqlite.exec('DROP TRIGGER reject_first_attempt_binding');
  db.sqlite.pragma('query_only = ON');
  await expect(
    bindSchedulerExecutionAttemptSession(db, {
      attemptId: attempt.attemptId,
      agentSessionId: 'as_00000000-0000-7000-8000-000000000005',
      now: () => '2026-11-01T00:03:03.000Z',
    })
  ).resolves.toMatchObject({ agentSessionId: 'as_00000000-0000-7000-8000-000000000005' });
});

it('rechecks current runtime launch authority after native open and before create', async () => {
  const { db, entry, root } = fixture('5');
  const client = getControlStoreWorkerClient();
  const nativeOpen = client.open.bind(client);
  const posted = vi.spyOn(client, 'executionAttempt');
  let authorityChanged = false;
  const opened = vi.spyOn(client, 'open').mockImplementation(async (input) => {
    await nativeOpen(input);
    const authority = openCoreDb(root);
    try {
      authorityChanged =
        authority.sqlite.transaction(
          () =>
            disableCanonicalUser(
              authority,
              'usr_00000000-0000-7000-8000-000000000001',
              new Date('2026-11-01T00:04:00.000Z')
            )?.changed ?? false
        )() === true;
    } finally {
      authority.sqlite.close();
    }
  });
  try {
    await expect(
      createSchedulerExecutionAttempt(db, {
        entry,
        attemptId: 'attempt_00000000-0000-7000-8000-000000000005',
        preparationInput: { admission: entry },
      })
    ).rejects.toThrow('The exact queued admission is no longer dispatchable.');
    expect(authorityChanged).toBe(true);
    expect(opened).toHaveBeenCalledOnce();
    expect(posted).toHaveBeenCalledOnce();
    expect(db.sqlite.prepare('SELECT * FROM scheduler_execution_attempts').all()).toEqual([]);
    expect(
      db.sqlite
        .prepare('SELECT status FROM scheduler_admission_entries WHERE queue_entry_id = ?')
        .get(entry.queueEntryId)
    ).toEqual({ status: 'queued' });
  } finally {
    opened.mockRestore();
    posted.mockRestore();
  }
});

it('commits exact NanoHost preparation without moving the first startup deadline', async () => {
  const { db, entry } = fixture('6');
  const attempt = await createSchedulerExecutionAttempt(db, {
    entry,
    attemptId: 'attempt_00000000-0000-7000-8000-000000000006',
    preparationInput: { admission: entry },
    now: () => '2026-11-01T00:00:00.000Z',
  });
  const preparation = {
    attemptId: attempt.attemptId,
    agentSessionId: 'as_00000000-0000-7000-8000-000000000006',
    inputRef: 'input-native-6',
    bindingRef: 'binding-native-6',
    sessionCompatibilityKey: 'compatibility-native-6',
  };
  await bindNanoHostAttemptPreparation(db, {
    ...preparation,
    now: () => '2026-11-01T00:01:00.000Z',
  });
  const first = requireNanoHostExecutionAttempt(db, attempt.attemptId);
  // Worker Runtime Communication Model: startup is 25 minutes from acquisition.
  expect(first).toMatchObject({
    ...preparation,
    startupDeadline: '2026-11-01T00:25:00.000Z',
    deadline: null,
    phase: 'open',
    preparationInputJson: attempt.preparationInputJson,
  });
  await bindNanoHostAttemptPreparation(db, {
    ...preparation,
    now: () => '2026-11-01T00:02:00.000Z',
  });
  expect(requireNanoHostExecutionAttempt(db, attempt.attemptId)).toEqual(first);
});

it('refuses conflicting NanoHost preparation without changing any retained attempt fact', async () => {
  const { db, entry } = fixture('7');
  const attempt = await createSchedulerExecutionAttempt(db, {
    entry,
    attemptId: 'attempt_00000000-0000-7000-8000-000000000007',
    preparationInput: { admission: entry },
    now: () => '2026-11-01T00:00:00.000Z',
  });
  const preparation = {
    attemptId: attempt.attemptId,
    agentSessionId: 'as_00000000-0000-7000-8000-000000000007',
    inputRef: 'input-native-7',
    bindingRef: 'binding-native-7',
    sessionCompatibilityKey: 'compatibility-native-7',
  };
  await bindNanoHostAttemptPreparation(db, preparation);
  const before = requireNanoHostExecutionAttempt(db, attempt.attemptId);
  for (const conflict of [
    { agentSessionId: 'as_00000000-0000-7000-8000-000000000008' },
    { inputRef: 'different-input' },
    { bindingRef: 'different-binding' },
  ]) {
    await expect(
      bindNanoHostAttemptPreparation(db, {
        ...preparation,
        ...conflict,
        sessionCompatibilityKey: 'must-not-be-written',
      })
    ).rejects.toThrow();
    expect(requireNanoHostExecutionAttempt(db, attempt.attemptId)).toEqual(before);
  }
});

it('projects NanoHost needs-evidence only after the separate closing acknowledgement', async () => {
  const { db, entry } = fixture('8');
  const attempt = await createSchedulerExecutionAttempt(db, {
    entry,
    attemptId: 'attempt_00000000-0000-7000-8000-000000000008',
    preparationInput: { admission: entry },
  });
  await bindNanoHostAttemptPreparation(db, {
    attemptId: attempt.attemptId,
    agentSessionId: 'as_00000000-0000-7000-8000-000000000008',
    inputRef: 'input-native-8',
    bindingRef: 'binding-native-8',
    sessionCompatibilityKey: 'compatibility-native-8',
  });
  const open = requireNanoHostExecutionAttempt(db, attempt.attemptId);
  await markNanoHostAttemptNeedsEvidence(db, attempt.attemptId);
  expect(requireNanoHostExecutionAttempt(db, attempt.attemptId)).toEqual(open);
  await markSchedulerExecutionAttemptClosing(db, {
    attemptId: attempt.attemptId,
    cause: 'restart-native-recovery',
  });
  const closing = requireNanoHostExecutionAttempt(db, attempt.attemptId);
  await markNanoHostAttemptNeedsEvidence(db, attempt.attemptId);
  expect(requireNanoHostExecutionAttempt(db, attempt.attemptId)).toEqual({
    ...closing,
    recoveryState: 'needs-evidence',
  });
  await markNanoHostAttemptNeedsEvidence(db, attempt.attemptId);
  expect(requireNanoHostExecutionAttempt(db, attempt.attemptId)).toEqual({
    ...closing,
    recoveryState: 'needs-evidence',
  });
});
