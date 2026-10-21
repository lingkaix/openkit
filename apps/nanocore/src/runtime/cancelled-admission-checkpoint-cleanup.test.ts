import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentEnvironmentPackageSchema } from '@openkit/config-schema';
import Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished } from 'vitest';
import { acquireDataRootLock } from '../bootstrap/lock.js';
import { FsStore } from '../lib/store.js';
import {
  cancelSchedulerAdmissionEntry,
  createSchedulerAdmissionEntry,
} from '../scheduler-records.js';
import { shutdownControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { testEntityId } from '../test-support/entity-ids.js';
import {
  ensureLocalUser,
  FIXTURE_LOCAL_USER_ID as LOCAL_USER_ID,
} from '../test-support/local-user.js';
import { resolveAgentEnvironmentPackage } from '../test-support/prepared-agent-environment.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { recordAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import { cleanCancelledAdmissionTaskCheckpoints } from './cancelled-admission-checkpoint-cleanup.js';
import {
  bindSchedulerExecutionAttemptSession,
  closeSchedulerExecutionAttemptWithoutEffects,
  createSchedulerExecutionAttempt,
} from './execution-attempt-records.js';
import { getWorkerCheckpoint, upsertWorkerCheckpoint } from './worker-checkpoints.js';

const ACTOR = { kind: 'user' as const, id: LOCAL_USER_ID };

/** Opens a stopped data root with one Workspace, Thread, and migrated databases. */
async function createFixture(): Promise<{
  readonly backupRoot: string;
  readonly coreDb: CoreDb;
  readonly dataRoot: string;
  readonly store: FsStore;
  readonly threadId: string;
  readonly workspaceDb: WorkspaceDb;
  readonly workspaceId: string;
}> {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-checkpoint-cleanup-'));
  const backupRoot = mkdtempSync(join(tmpdir(), 'openkit-checkpoint-cleanup-backup-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);

  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Checkpoint cleanup');
  ensureLocalUser(coreDb);
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: LOCAL_USER_ID });
  const thread = await store.createThread(workspace.id, 'Checkpoint cleanup thread');
  await shutdownControlStoreWorkerClient();
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    if (workspaceDb.sqlite.open) workspaceDb.sqlite.close();
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(backupRoot, { recursive: true, force: true });
  });
  applyScopedMigrations(workspaceDb);
  return {
    backupRoot,
    coreDb,
    dataRoot,
    store,
    threadId: thread.id,
    workspaceDb,
    workspaceId: workspace.id,
  };
}

/** Closes fixture databases so the maintenance command can lock the data root. */
async function closeFixture(fixture: {
  readonly coreDb: CoreDb;
  readonly workspaceDb: WorkspaceDb;
}): Promise<void> {
  await shutdownControlStoreWorkerClient();
  fixture.workspaceDb.sqlite.close();
  fixture.coreDb.sqlite.close();
}

/** Records one failed direct Task checkpoint with no Worker session. */
function writeFailedCheckpoint(
  workspaceDb: WorkspaceDb,
  input: {
    readonly goalId?: string | null;
    readonly requestId: string;
    readonly stage?: 'failed' | 'preparing';
    readonly threadId: string;
    readonly turnId: string;
    readonly workerSessionId?: string | null;
    readonly workspaceId: string;
    readonly contextDigest?: string | null;
  }
): void {
  upsertWorkerCheckpoint(workspaceDb, {
    contextDigest: input.contextDigest ?? null,
    goalId: input.goalId ?? null,
    iteration: 0,
    requestId: input.requestId,
    requestInputHash: `sha256:${input.requestId}`,
    stage: input.stage ?? 'failed',
    stopReason: input.stage === 'preparing' ? null : 'error',
    taskId: null,
    threadId: input.threadId,
    turnId: input.turnId,
    workerSessionId: input.workerSessionId ?? null,
    workspaceId: input.workspaceId,
  });
}

/** Records one cancelled admission and no attempt for a missing Turn. */
function writeCancelledAdmission(
  coreDb: CoreDb,
  input: {
    readonly requestId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly workspaceId: string;
  }
): void {
  const queueEntryId = `queue_${input.turnId}`;
  createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    profileRef: 'agent_codex_host',
    queueEntryId,
    requestId: input.requestId,
    requestedAgentId: 'agent_codex_host',
    threadId: input.threadId,
    triggerActor: ACTOR,
    turnId: input.turnId,
    turnInput: 'Cancelled before Turn persistence.',
    workspaceId: input.workspaceId,
  });
  cancelSchedulerAdmissionEntry(coreDb, {
    queueEntryId,
    workspaceId: input.workspaceId,
  });
}

/** Records one admitted attempt that failed before Turn persistence. */
function writeStartFailureLease(
  coreDb: CoreDb,
  input: {
    readonly requestId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly workspaceId: string;
  }
): void {
  const queueEntryId = `queue_${input.turnId}`;
  const entry = createSchedulerAdmissionEntry(coreDb, {
    backendId: 'nanohost',
    profileRef: 'agent_codex_host',
    queueEntryId,
    requestId: input.requestId,
    requestedAgentId: 'agent_codex_host',
    threadId: input.threadId,
    triggerActor: ACTOR,
    turnId: input.turnId,
    turnInput: 'Start failed before Turn persistence.',
    workspaceId: input.workspaceId,
  });
  createSchedulerExecutionAttempt(coreDb, {
    entry,
    attemptId: testEntityId('attempt', `lease_${input.turnId}`),
    preparationInput: { admission: entry },
  });
  bindSchedulerExecutionAttemptSession(coreDb, {
    attemptId: testEntityId('attempt', `lease_${input.turnId}`),
    agentSessionId: testEntityId('as', `as_${input.turnId}`),
  });
  // No preparation or backend operation occurred in this missing-Turn fixture.
  closeSchedulerExecutionAttemptWithoutEffects(coreDb, {
    attemptId: testEntityId('attempt', `lease_${input.turnId}`),
    cause: 'turn-start-failed',
    noOutstandingEffects: true,
  });
}

/** Reads scheduler rows that this cleanup must preserve. */
function schedulerSnapshot(dataRoot: string): {
  readonly admissions: unknown[];
  readonly attempts: unknown[];
} {
  const coreDb = openCoreDb(dataRoot);
  try {
    return {
      admissions: coreDb.sqlite
        .prepare(
          `SELECT queue_entry_id, request_id, status, turn_id, workspace_id
           FROM scheduler_admission_entries ORDER BY queue_entry_id`
        )
        .all(),
      attempts: coreDb.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='scheduler_execution_attempts'"
        )
        .get()
        ? coreDb.sqlite.prepare('SELECT * FROM scheduler_execution_attempts ORDER BY rowid').all()
        : [],
    };
  } finally {
    coreDb.sqlite.close();
  }
}

describe('cancelled-admission Task checkpoint cleanup', () => {
  it('reports a proved cancelled admission on dry-run and removes it only on apply', async () => {
    const fixture = await createFixture();
    const turnId = 'tu_00000000-0000-7ce2-a4ef-a80fb53e8b1d';
    const requestId = '0190f4c8-0000-7000-8000-000000000591';
    const siblingTurnId = 'tu_00000000-0000-720f-8cf6-feec28411135';
    writeCancelledAdmission(fixture.coreDb, {
      requestId,
      threadId: fixture.threadId,
      turnId,
      workspaceId: fixture.workspaceId,
    });
    writeFailedCheckpoint(fixture.workspaceDb, {
      requestId,
      threadId: fixture.threadId,
      turnId,
      workspaceId: fixture.workspaceId,
    });
    writeCancelledAdmission(fixture.coreDb, {
      requestId: '0190f4c8-0000-7000-8000-000000000592',
      threadId: fixture.threadId,
      turnId: siblingTurnId,
      workspaceId: fixture.workspaceId,
    });
    writeFailedCheckpoint(fixture.workspaceDb, {
      requestId: '0190f4c8-0000-7000-8000-000000000592',
      threadId: fixture.threadId,
      turnId: siblingTurnId,
      workspaceId: fixture.workspaceId,
    });
    const keptTurn = await fixture.store.createTurn(
      fixture.workspaceId,
      fixture.threadId,
      'Unrelated product history',
      ACTOR
    );
    const before = schedulerSnapshot(fixture.dataRoot);
    await closeFixture(fixture);

    const identity = {
      threadId: fixture.threadId,
      turnId,
      workspaceId: fixture.workspaceId,
    };
    const dryRun = await cleanCancelledAdmissionTaskCheckpoints({
      backupRoot: fixture.backupRoot,
      checkpoints: [identity],
      dataRoot: fixture.dataRoot,
    });
    expect(dryRun).toMatchObject({
      applied: false,
      backupRoot: null,
      outcome: 'succeeded',
      removedCount: 0,
      rows: [{ decision: 'removable', reason: 'cancelled-admission', ...identity }],
    });
    const afterDryRun = openWorkspaceDb(fixture.dataRoot, fixture.workspaceId);
    expect(
      getWorkerCheckpoint(afterDryRun, fixture.workspaceId, fixture.threadId, turnId)
    ).not.toBeNull();
    afterDryRun.sqlite.close();

    const applied = await cleanCancelledAdmissionTaskCheckpoints({
      apply: true,
      backupRoot: fixture.backupRoot,
      checkpoints: [identity],
      dataRoot: fixture.dataRoot,
    });
    expect(applied).toMatchObject({
      applied: true,
      outcome: 'succeeded',
      removedCount: 1,
      rows: [{ decision: 'removed', reason: 'cancelled-admission', ...identity }],
    });
    expect(applied.backupRoot).toBe(fixture.backupRoot);
    const backup = new Database(
      join(fixture.backupRoot, 'workspaces', fixture.workspaceId, 'workspace.sqlite'),
      { readonly: true }
    );
    const backedUp = backup
      .prepare('SELECT turn_id FROM worker_turn_checkpoints WHERE turn_id = ?')
      .get(turnId) as { turn_id: string } | undefined;
    backup.close();
    expect(backedUp?.turn_id).toBe(turnId);

    const afterApply = openWorkspaceDb(fixture.dataRoot, fixture.workspaceId);
    try {
      expect(
        getWorkerCheckpoint(afterApply, fixture.workspaceId, fixture.threadId, turnId)
      ).toBeNull();
      expect(
        getWorkerCheckpoint(afterApply, fixture.workspaceId, fixture.threadId, siblingTurnId)
      ).not.toBeNull();
    } finally {
      afterApply.sqlite.close();
    }
    expect(schedulerSnapshot(fixture.dataRoot)).toEqual(before);
    expect(
      new FsStore({ dataRoot: fixture.dataRoot }).getTurn(
        fixture.workspaceId,
        fixture.threadId,
        keptTurn.id
      ).id
    ).toBe(keptTurn.id);

    const repeated = await cleanCancelledAdmissionTaskCheckpoints({
      apply: true,
      backupRoot: fixture.backupRoot,
      checkpoints: [identity],
      dataRoot: fixture.dataRoot,
    });
    expect(repeated).toMatchObject({
      applied: true,
      backupRoot: null,
      outcome: 'succeeded',
      removedCount: 0,
      rows: [{ decision: 'absent', reason: 'absent', ...identity }],
    });
    expect(schedulerSnapshot(fixture.dataRoot)).toEqual(before);
  });

  it('removes a proved pre-persistence start-failure checkpoint only on apply', async () => {
    const fixture = await createFixture();
    const turnId = 'tu_00000000-0000-7a81-a9d4-017d6a90c247';
    const requestId = '0190f4c8-0000-7000-8000-000000000593';
    writeStartFailureLease(fixture.coreDb, {
      requestId,
      threadId: fixture.threadId,
      turnId,
      workspaceId: fixture.workspaceId,
    });
    writeFailedCheckpoint(fixture.workspaceDb, {
      requestId,
      threadId: fixture.threadId,
      turnId,
      workspaceId: fixture.workspaceId,
    });
    const before = schedulerSnapshot(fixture.dataRoot);
    await closeFixture(fixture);
    const identity = {
      threadId: fixture.threadId,
      turnId,
      workspaceId: fixture.workspaceId,
    };

    const dryRun = await cleanCancelledAdmissionTaskCheckpoints({
      backupRoot: fixture.backupRoot,
      checkpoints: [identity],
      dataRoot: fixture.dataRoot,
    });
    expect(dryRun.rows).toEqual([
      expect.objectContaining({ decision: 'removable', reason: 'turn-start-failed', ...identity }),
    ]);

    const applied = await cleanCancelledAdmissionTaskCheckpoints({
      apply: true,
      backupRoot: fixture.backupRoot,
      checkpoints: [identity],
      dataRoot: fixture.dataRoot,
    });
    expect(applied.removedCount).toBe(1);
    expect(applied.rows[0]).toMatchObject({ decision: 'removed', reason: 'turn-start-failed' });
    const workspaceDb = openWorkspaceDb(fixture.dataRoot, fixture.workspaceId);
    try {
      expect(
        getWorkerCheckpoint(workspaceDb, fixture.workspaceId, fixture.threadId, turnId)
      ).toBeNull();
    } finally {
      workspaceDb.sqlite.close();
    }
    expect(schedulerSnapshot(fixture.dataRoot)).toEqual(before);

    const repeated = await cleanCancelledAdmissionTaskCheckpoints({
      apply: true,
      backupRoot: fixture.backupRoot,
      checkpoints: [identity],
      dataRoot: fixture.dataRoot,
    });
    expect(repeated.removedCount).toBe(0);
    expect(repeated.rows[0]?.decision).toBe('absent');
    expect(schedulerSnapshot(fixture.dataRoot)).toEqual(before);
  });

  it.each([
    {
      mutate: 'lineage' as const,
      reason: 'mismatched-turn-lineage',
    },
    {
      mutate: 'history' as const,
      reason: 'unreadable-history',
    },
    {
      mutate: 'live-lease' as const,
      reason: 'live-lease',
    },
    {
      mutate: 'multiple-leases' as const,
      reason: 'multiple-leases',
    },
    {
      mutate: 'session' as const,
      reason: 'non-null-session',
    },
    {
      mutate: 'stage' as const,
      reason: 'nonterminal-checkpoint',
    },
    {
      mutate: 'goal' as const,
      reason: 'goal-ownership',
    },
    {
      mutate: 'runtime' as const,
      reason: 'runtime-evidence',
    },
    {
      mutate: 'provenance' as const,
      reason: 'missing-provenance',
    },
  ])('preserves a checkpoint with $mutate', async ({ mutate, reason }) => {
    const fixture = await createFixture();
    const turnId = testEntityId('tu', `turn_preserve_${mutate}`);
    const requestId = `0190f4c8-0000-7000-8000-0000000005${mutate.length}`;
    if (mutate !== 'provenance' && mutate !== 'live-lease' && mutate !== 'multiple-leases') {
      writeCancelledAdmission(fixture.coreDb, {
        requestId,
        threadId: fixture.threadId,
        turnId,
        workspaceId: fixture.workspaceId,
      });
    }
    if (mutate === 'live-lease' || mutate === 'multiple-leases') {
      writeStartFailureLease(fixture.coreDb, {
        requestId,
        threadId: fixture.threadId,
        turnId,
        workspaceId: fixture.workspaceId,
      });
    }
    if (mutate === 'live-lease') {
      fixture.coreDb.sqlite
        .prepare(
          `UPDATE scheduler_execution_attempts
           SET phase = 'open', terminal_cause = NULL, recovery_state = NULL
           WHERE attempt_id = ?`
        )
        .run(testEntityId('attempt', `lease_${turnId}`));
    }
    if (mutate === 'multiple-leases') {
      fixture.coreDb.sqlite
        .prepare(
          `INSERT INTO scheduler_execution_attempts (
             attempt_id, queue_entry_id, backend_id, workspace_id, thread_id, turn_id,
             preparation_input_json, phase, disposition, terminal_cause, created_at, updated_at
           )
           SELECT ?, queue_entry_id, backend_id, workspace_id, thread_id,
                  turn_id, preparation_input_json, phase, disposition, terminal_cause, created_at, updated_at
           FROM scheduler_execution_attempts WHERE attempt_id = ?`
        )
        .run(
          testEntityId('attempt', `lease_extra_${turnId}`),
          testEntityId('attempt', `lease_${turnId}`)
        );
    }
    writeFailedCheckpoint(fixture.workspaceDb, {
      contextDigest: mutate === 'runtime' ? 'sha256:context' : null,
      goalId: mutate === 'goal' ? 'goal_preserve' : null,
      requestId,
      stage: mutate === 'stage' ? 'preparing' : 'failed',
      threadId: fixture.threadId,
      turnId,
      workerSessionId: mutate === 'session' ? 'as_00000000-0000-73cf-8c67-8f725aa0624f' : null,
      workspaceId: fixture.workspaceId,
    });
    if (mutate === 'lineage') {
      const other = await fixture.store.createWorkspace('Other lineage');
      const otherThread = await fixture.store.createThread(other.id, 'Other lineage thread');
      await fixture.store.createTurn(other.id, otherThread.id, 'Foreign Turn', ACTOR, null, {
        turnId,
      });
    }
    if (mutate === 'runtime') {
      fixture.workspaceDb.sqlite
        .prepare(
          `INSERT INTO runtime_evidence (
             runtime_evidence_id, workspace_id, thread_id, turn_id, placement, phase, summary,
             upload_manifest_json, download_manifest_json, outcome, evidence_bundle_ids_json,
             content_digests_json, required_features_json, created_at
           ) VALUES (?, ?, ?, ?, 'local', 'checkpoint', 'fixture', '[]', '[]', 'unknown', '[]', '[]', '[]', ?)`
        )
        .run(
          `rte_${turnId}`,
          fixture.workspaceId,
          fixture.threadId,
          turnId,
          '2026-09-22T00:00:00.000Z'
        );
    }
    const before = schedulerSnapshot(fixture.dataRoot);
    const checkpointBefore = getWorkerCheckpoint(
      fixture.workspaceDb,
      fixture.workspaceId,
      fixture.threadId,
      turnId
    );
    await closeFixture(fixture);
    if (mutate === 'history') {
      corruptNativeMetadata(
        fixture.dataRoot,
        fixture.workspaceId,
        'thread',
        fixture.threadId,
        () => '{'
      );
    }

    const result = await cleanCancelledAdmissionTaskCheckpoints({
      apply: true,
      backupRoot: fixture.backupRoot,
      checkpoints: [{ threadId: fixture.threadId, turnId, workspaceId: fixture.workspaceId }],
      dataRoot: fixture.dataRoot,
    });
    expect(result.removedCount).toBe(0);
    expect(result.rows).toEqual([
      expect.objectContaining({
        decision: 'refused',
        reason,
        threadId: fixture.threadId,
        turnId,
        workspaceId: fixture.workspaceId,
      }),
    ]);
    if (mutate !== 'history') {
      const workspaceDb = openWorkspaceDb(fixture.dataRoot, fixture.workspaceId);
      try {
        expect(
          getWorkerCheckpoint(workspaceDb, fixture.workspaceId, fixture.threadId, turnId)
        ).toEqual(checkpointBefore);
      } finally {
        workspaceDb.sqlite.close();
      }
      expect(schedulerSnapshot(fixture.dataRoot)).toEqual(before);
    }
  });
});

describe('cancelled-admission checkpoint cleanup preservation', () => {
  it('keeps a matching expired receipt during dry-run and apply', async () => {
    for (const apply of [false, true]) {
      const fixture = await createFixture();
      const turnId = testEntityId('tu', `turn_receipt_${apply}`);
      const requestId = '0190f4c8-0000-7000-8000-000000000991';
      const identity = { threadId: fixture.threadId, turnId, workspaceId: fixture.workspaceId };
      writeCancelledAdmission(fixture.coreDb, { ...identity, requestId });
      writeFailedCheckpoint(fixture.workspaceDb, { ...identity, requestId });
      insertReceipt(fixture.workspaceDb, {
        expiresAt: '2020-01-02T00:00:00.000Z',
        requestId,
        requestKey: `receipt_${turnId}`,
        responseId: turnId,
        scope: { threadId: fixture.threadId, workspaceId: fixture.workspaceId },
      });
      const receiptsBefore = readReceipts(fixture.dataRoot, fixture.workspaceId);
      const checkpointBefore = getWorkerCheckpoint(
        fixture.workspaceDb,
        fixture.workspaceId,
        fixture.threadId,
        turnId
      );
      await closeFixture(fixture);

      const result = await cleanCancelledAdmissionTaskCheckpoints({
        apply,
        backupRoot: fixture.backupRoot,
        checkpoints: [identity],
        dataRoot: fixture.dataRoot,
      });

      expect(result.removedCount).toBe(0);
      expect(result.backupRoot).toBeNull();
      expect(result.rows).toEqual([
        expect.objectContaining({ decision: 'refused', reason: 'missing-provenance', turnId }),
      ]);
      expect(readReceipts(fixture.dataRoot, fixture.workspaceId)).toEqual(receiptsBefore);
      expect(readCheckpoint(fixture.dataRoot, identity)).toEqual(checkpointBefore);
    }
  });

  it('preserves an unrelated expired receipt while removing a proved checkpoint', async () => {
    const fixture = await createFixture();
    const turnId = 'tu_00000000-0000-7f5a-b8f3-3a41e3c2b08d';
    const requestId = '0190f4c8-0000-7000-8000-000000000992';
    const identity = { threadId: fixture.threadId, turnId, workspaceId: fixture.workspaceId };
    writeCancelledAdmission(fixture.coreDb, { ...identity, requestId });
    writeFailedCheckpoint(fixture.workspaceDb, { ...identity, requestId });
    insertReceipt(fixture.workspaceDb, {
      expiresAt: '2020-01-02T00:00:00.000Z',
      requestId: '0190f4c8-0000-7000-8000-000000000993',
      requestKey: 'receipt_unrelated',
      responseId: 'tu_00000000-0000-7963-ac3b-c41b06427ed7',
      scope: { threadId: fixture.threadId, workspaceId: fixture.workspaceId },
    });
    const receiptsBefore = readReceipts(fixture.dataRoot, fixture.workspaceId);
    await closeFixture(fixture);

    const result = await cleanCancelledAdmissionTaskCheckpoints({
      apply: true,
      backupRoot: fixture.backupRoot,
      checkpoints: [identity],
      dataRoot: fixture.dataRoot,
    });

    expect(result.rows).toEqual([
      expect.objectContaining({ decision: 'removed', reason: 'cancelled-admission', turnId }),
    ]);
    expect(readCheckpoint(fixture.dataRoot, identity)).toBeNull();
    expect(readReceipts(fixture.dataRoot, fixture.workspaceId)).toEqual(receiptsBefore);
  });

  it.each([
    'dry-run',
    'apply',
    'refused',
  ] as const)('preserves an unrelated pending approval during %s', async (mode) => {
    const fixture = await createFixture();
    const turnId = testEntityId('tu', `turn_history_${mode}`);
    const requestId = '0190f4c8-0000-7000-8000-000000000994';
    const identity = { threadId: fixture.threadId, turnId, workspaceId: fixture.workspaceId };
    if (mode !== 'refused') {
      writeCancelledAdmission(fixture.coreDb, { ...identity, requestId });
    }
    writeFailedCheckpoint(fixture.workspaceDb, { ...identity, requestId });
    const unrelated = await fixture.store.createTurn(
      fixture.workspaceId,
      fixture.threadId,
      'Unrelated terminal approval',
      ACTOR
    );
    const timestamp = '2026-09-22T00:00:00.000Z';
    await fixture.store.createItem({
      approvalRequestId: `ap_${unrelated.id}`,
      completedAt: null,
      createdAt: timestamp,
      description: 'Independent history',
      id: testEntityId('it', `it_req_${unrelated.id}`),
      kind: 'permission',
      status: 'in_progress',
      threadId: fixture.threadId,
      title: 'Unresolved approval',
      turnId: unrelated.id,
      type: 'approval-request',
      owner: { kind: 'workspace', workspaceId: fixture.workspaceId },
    });
    await fixture.store.updateTurn(unrelated.id, {
      completedAt: timestamp,
      error: null,
      status: 'completed',
    });
    const itemsBefore = fixture.store.listThreadItems(fixture.workspaceId, fixture.threadId);
    const itemBytes = nativeItemBytes(fixture.dataRoot, fixture.workspaceId, unrelated.id);
    await closeFixture(fixture);

    const result = await cleanCancelledAdmissionTaskCheckpoints({
      apply: mode === 'apply',
      backupRoot: fixture.backupRoot,
      checkpoints: [identity],
      dataRoot: fixture.dataRoot,
    });

    expect(
      new FsStore({ dataRoot: fixture.dataRoot }).listThreadItems(
        fixture.workspaceId,
        fixture.threadId
      )
    ).toEqual(itemsBefore);
    expect(nativeItemBytes(fixture.dataRoot, fixture.workspaceId, unrelated.id)).toEqual(itemBytes);
    expect(JSON.stringify(itemsBefore)).not.toContain('it_00000000-0000-7548-a1b7-5dff9f300931');
    if (mode === 'apply') {
      expect(result.removedCount).toBe(1);
      expect(readCheckpoint(fixture.dataRoot, identity)).toBeNull();
    } else {
      expect(result.removedCount).toBe(0);
      expect(readCheckpoint(fixture.dataRoot, identity)).not.toBeNull();
    }
  });

  it('refuses malformed diagnostics and blocks every selected checkpoint', async () => {
    const fixture = await createFixture();
    const corruptId = identityFor(fixture, 'tu_00000000-0000-7f48-be95-803bf8edcd90');
    const cleanId = identityFor(fixture, 'tu_00000000-0000-7ea2-b600-fcf572339658');
    writeCancelledAdmission(fixture.coreDb, {
      ...corruptId,
      requestId: '0190f4c8-0000-7000-8000-000000000995',
    });
    writeFailedCheckpoint(fixture.workspaceDb, {
      ...corruptId,
      requestId: '0190f4c8-0000-7000-8000-000000000995',
    });
    writeCancelledAdmission(fixture.coreDb, {
      ...cleanId,
      requestId: '0190f4c8-0000-7000-8000-000000001095',
    });
    writeFailedCheckpoint(fixture.workspaceDb, {
      ...cleanId,
      requestId: '0190f4c8-0000-7000-8000-000000001095',
    });
    fixture.workspaceDb.sqlite
      .prepare('UPDATE worker_turn_checkpoints SET diagnostics_summary = ? WHERE turn_id = ?')
      .run('{', corruptId.turnId);
    await closeFixture(fixture);

    const result = await cleanCancelledAdmissionTaskCheckpoints({
      apply: true,
      backupRoot: fixture.backupRoot,
      checkpoints: [corruptId, cleanId],
      dataRoot: fixture.dataRoot,
    });

    expect(result.outcome).toBe('blocked');
    expect(result.removedCount).toBe(0);
    expect(result.rows).toEqual([
      expect.objectContaining({
        decision: 'refused',
        reason: 'unreadable-history',
        turnId: corruptId.turnId,
      }),
      expect.objectContaining({
        decision: 'refused',
        reason: 'unreadable-history',
        turnId: cleanId.turnId,
      }),
    ]);
    expect(readCheckpoint(fixture.dataRoot, corruptId)).not.toBeNull();
    expect(readCheckpoint(fixture.dataRoot, cleanId)).not.toBeNull();
  });

  it('treats incomplete context assembly as execution evidence', async () => {
    const fixture = await createFixture();
    const identity = identityFor(fixture, 'tu_00000000-0000-749c-8e69-38e10357fa79');
    const requestId = '0190f4c8-0000-7000-8000-000000000996';
    writeCancelledAdmission(fixture.coreDb, { ...identity, requestId });
    writeFailedCheckpoint(fixture.workspaceDb, { ...identity, requestId });
    fixture.workspaceDb.sqlite
      .prepare('UPDATE worker_turn_checkpoints SET diagnostics_summary = ? WHERE turn_id = ?')
      .run(
        JSON.stringify({ contextAssembly: { contextDigest: 'sha256:ran', contextRefs: [] } }),
        identity.turnId
      );
    await closeFixture(fixture);

    const result = await cleanCancelledAdmissionTaskCheckpoints({
      apply: true,
      backupRoot: fixture.backupRoot,
      checkpoints: [identity],
      dataRoot: fixture.dataRoot,
    });

    expect(result.removedCount).toBe(0);
    expect(result.rows).toEqual([
      expect.objectContaining({
        decision: 'refused',
        reason: 'runtime-evidence',
        turnId: identity.turnId,
      }),
    ]);
    expect(readCheckpoint(fixture.dataRoot, identity)).not.toBeNull();
  });

  it.each([
    ['item ids', JSON.stringify({ itemIds: 'bad' })],
    ['artifact ids', JSON.stringify({ artifactIds: {} })],
  ] as const)('refuses incorrectly typed %s diagnostics', async (_label, diagnostics) => {
    const fixture = await createFixture();
    const identity = identityFor(fixture, `turn_typed_${_label.replace(' ', '_')}`);
    const requestId = '0190f4c8-0000-7000-8000-000000000997';
    writeCancelledAdmission(fixture.coreDb, { ...identity, requestId });
    writeFailedCheckpoint(fixture.workspaceDb, { ...identity, requestId });
    fixture.workspaceDb.sqlite
      .prepare('UPDATE worker_turn_checkpoints SET diagnostics_summary = ? WHERE turn_id = ?')
      .run(diagnostics, identity.turnId);
    await closeFixture(fixture);

    const result = await cleanCancelledAdmissionTaskCheckpoints({
      apply: true,
      backupRoot: fixture.backupRoot,
      checkpoints: [identity],
      dataRoot: fixture.dataRoot,
    });

    expect(result.outcome).toBe('blocked');
    expect(result.removedCount).toBe(0);
    expect(readCheckpoint(fixture.dataRoot, identity)).not.toBeNull();
  });

  it('still removes a checkpoint whose diagnostics are plain failure text', async () => {
    const fixture = await createFixture();
    const identity = identityFor(fixture, 'tu_00000000-0000-7248-a8ea-70525940472a');
    const requestId = '0190f4c8-0000-7000-8000-000000000998';
    writeCancelledAdmission(fixture.coreDb, { ...identity, requestId });
    writeFailedCheckpoint(fixture.workspaceDb, { ...identity, requestId });
    fixture.workspaceDb.sqlite
      .prepare('UPDATE worker_turn_checkpoints SET diagnostics_summary = ? WHERE turn_id = ?')
      .run('Worker start failed.', identity.turnId);
    await closeFixture(fixture);

    const result = await cleanCancelledAdmissionTaskCheckpoints({
      apply: true,
      backupRoot: fixture.backupRoot,
      checkpoints: [identity],
      dataRoot: fixture.dataRoot,
    });

    expect(result.rows).toEqual([
      expect.objectContaining({ decision: 'removed', reason: 'cancelled-admission' }),
    ]);
    expect(readCheckpoint(fixture.dataRoot, identity)).toBeNull();
  });

  it('refuses a runtime evidence row without using context digest as a shortcut', async () => {
    const fixture = await createFixture();
    const identity = identityFor(fixture, 'tu_00000000-0000-7cd8-ac6d-ce67f0efa520');
    const requestId = '0190f4c8-0000-7000-8000-000000001001';
    writeCancelledAdmission(fixture.coreDb, { ...identity, requestId });
    writeFailedCheckpoint(fixture.workspaceDb, { ...identity, requestId });
    fixture.workspaceDb.sqlite
      .prepare(
        `INSERT INTO runtime_evidence (
           runtime_evidence_id, workspace_id, thread_id, turn_id, placement, phase, summary,
           upload_manifest_json, download_manifest_json, outcome, evidence_bundle_ids_json,
           content_digests_json, required_features_json, created_at
         ) VALUES (?, ?, ?, ?, 'local', 'checkpoint', 'fixture', '[]', '[]', 'unknown', '[]', '[]', '[]', ?)`
      )
      .run(
        `rte_${identity.turnId}`,
        fixture.workspaceId,
        fixture.threadId,
        identity.turnId,
        '2026-09-22T00:00:00.000Z'
      );
    await closeFixture(fixture);

    const result = await cleanCancelledAdmissionTaskCheckpoints({
      apply: true,
      backupRoot: fixture.backupRoot,
      checkpoints: [identity],
      dataRoot: fixture.dataRoot,
    });

    expect(result.rows).toEqual([
      expect.objectContaining({ decision: 'refused', reason: 'runtime-evidence' }),
    ]);
    expect(readCheckpoint(fixture.dataRoot, identity)).not.toBeNull();
  });

  it('refuses a worker control record for the checkpoint Turn', async () => {
    const fixture = await createFixture();
    const identity = identityFor(fixture, 'tu_00000000-0000-7781-892a-3b253a33f2d9');
    const requestId = '0190f4c8-0000-7000-8000-000000001002';
    writeCancelledAdmission(fixture.coreDb, { ...identity, requestId });
    writeFailedCheckpoint(fixture.workspaceDb, { ...identity, requestId });
    fixture.coreDb.sqlite
      .prepare(
        `INSERT INTO worker_control_records (
           workspace_id, thread_id, turn_id, agent_session_id, package_snapshot_id, request_id,
           operation, record_key, sequence, record_json, accepted_at
         ) VALUES (?, ?, ?, 'as_00000000-0000-736f-9643-8c3c704c2cce', 'aepsnap_control', ?, 'observe', 'key', 1, '{}', ?)`
      )
      .run(
        fixture.workspaceId,
        fixture.threadId,
        identity.turnId,
        requestId,
        '2026-09-22T00:00:00.000Z'
      );
    await closeFixture(fixture);

    const result = await cleanCancelledAdmissionTaskCheckpoints({
      apply: true,
      backupRoot: fixture.backupRoot,
      checkpoints: [identity],
      dataRoot: fixture.dataRoot,
    });

    expect(result.rows).toEqual([
      expect.objectContaining({ decision: 'refused', reason: 'runtime-evidence' }),
    ]);
    expect(readCheckpoint(fixture.dataRoot, identity)).not.toBeNull();
  });

  it('refuses an environment package bound to the checkpoint Turn', async () => {
    const fixture = await createFixture();
    const identity = identityFor(fixture, 'tu_00000000-0000-7c9c-a800-07ed48da3579');
    const requestId = '0190f4c8-0000-7000-8000-000000001003';
    writeCancelledAdmission(fixture.coreDb, { ...identity, requestId });
    writeFailedCheckpoint(fixture.workspaceDb, { ...identity, requestId });
    const sessionId = 'as_00000000-0000-78a3-a9bb-2860a6e89e42';
    recordAgentEnvironmentPackageSnapshot(fixture.workspaceDb, {
      createdAt: '2026-09-22T00:00:00.000Z',
      environmentPackage: AgentEnvironmentPackageSchema.parse(
        resolveAgentEnvironmentPackage({
          agent: {
            capabilities: [],
            config: {
              adapterType: 'codex',
              baseUrl: null,
              capabilities: [],
              command: null,
              environment: {},
              workspaceRoot: '/workspace',
            },
            defaultProfileId: 'default',
            id: 'agent_codex_host',
            kind: 'coder',
            modelId: null,
            name: 'Codex Agent',
            profiles: [
              {
                capabilityIds: [],
                displayName: 'Default',
                id: 'default',
                instructionsRef: null,
                modelId: null,
                skillIds: [],
              },
            ],
            sandboxSummary: null,
            skillIds: [],
            status: 'enabled',
          },
          agentSessionId: sessionId,
          agentSetup: createTestAgentSetup(),
          backend: { kind: 'openshell' },
          requestId,
          triggerActor: ACTOR,
          turn: {
            completedAt: null,
            configVersion: null,
            durationMs: null,
            error: null,
            id: identity.turnId,
            items: [],
            startedAt: '2026-09-22T00:00:00.000Z',
            status: 'running',
            threadId: fixture.threadId,
            triggerActor: ACTOR,
            owner: { kind: 'workspace', workspaceId: fixture.workspaceId },
          },
          turnInput: 'Run tests',
          workspaceCwd: '/workspace',
          workspaceRoots: [],
        })
      ),
    });
    await fixture.store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: '2026-09-22T00:00:00.000Z',
      id: sessionId,
      message: null,
      status: 'closed',
      threadId: fixture.threadId,
      updatedAt: '2026-09-22T00:00:00.000Z',
      workspaceId: fixture.workspaceId,
    });
    await closeFixture(fixture);

    const result = await cleanCancelledAdmissionTaskCheckpoints({
      apply: true,
      backupRoot: fixture.backupRoot,
      checkpoints: [identity],
      dataRoot: fixture.dataRoot,
    });

    expect(result.rows).toEqual([
      expect.objectContaining({ decision: 'refused', reason: 'runtime-evidence' }),
    ]);
    expect(readCheckpoint(fixture.dataRoot, identity)).not.toBeNull();
  });

  it('refuses an AgentSession that matches the start-failure lease', async () => {
    const fixture = await createFixture();
    const identity = identityFor(fixture, 'tu_00000000-0000-780f-be6c-5b90f496572f');
    const requestId = '0190f4c8-0000-7000-8000-000000001004';
    writeStartFailureLease(fixture.coreDb, { ...identity, requestId });
    writeFailedCheckpoint(fixture.workspaceDb, { ...identity, requestId });
    const sessionId = testEntityId('as', `as_${identity.turnId}`);
    await fixture.store.createAgentSession({
      agentId: 'agent_codex_host',
      createdAt: '2026-09-22T00:00:00.000Z',
      id: sessionId,
      message: null,
      status: 'closed',
      threadId: fixture.threadId,
      updatedAt: '2026-09-22T00:00:00.000Z',
      workspaceId: fixture.workspaceId,
    });
    await closeFixture(fixture);

    const result = await cleanCancelledAdmissionTaskCheckpoints({
      apply: true,
      backupRoot: fixture.backupRoot,
      checkpoints: [identity],
      dataRoot: fixture.dataRoot,
    });

    expect(result.rows).toEqual([
      expect.objectContaining({ decision: 'refused', reason: 'runtime-evidence' }),
    ]);
    expect(readCheckpoint(fixture.dataRoot, identity)).not.toBeNull();
  });

  it('refuses cleanup while another holder owns the data-root lock', async () => {
    const fixture = await createFixture();
    const identity = identityFor(fixture, 'tu_00000000-0000-7e14-8c92-1734e9d4fbff');
    const requestId = '0190f4c8-0000-7000-8000-000000001005';
    writeCancelledAdmission(fixture.coreDb, { ...identity, requestId });
    writeFailedCheckpoint(fixture.workspaceDb, { ...identity, requestId });
    const checkpointBefore = getWorkerCheckpoint(
      fixture.workspaceDb,
      fixture.workspaceId,
      fixture.threadId,
      identity.turnId
    );
    await closeFixture(fixture);
    const lock = acquireDataRootLock(fixture.dataRoot, { bootId: 'held-by-test' });
    try {
      await expect(
        cleanCancelledAdmissionTaskCheckpoints({
          apply: true,
          backupRoot: fixture.backupRoot,
          checkpoints: [identity],
          dataRoot: fixture.dataRoot,
        })
      ).rejects.toThrow(/stopped NanoCore/);
    } finally {
      lock.release();
    }
    expect(readCheckpoint(fixture.dataRoot, identity)).toEqual(checkpointBefore);
  });

  it('refuses apply when the backup destination already exists', async () => {
    const fixture = await createFixture();
    const identity = identityFor(fixture, 'tu_00000000-0000-72bf-ba1a-70e8fc2f5cee');
    const requestId = '0190f4c8-0000-7000-8000-000000001006';
    writeCancelledAdmission(fixture.coreDb, { ...identity, requestId });
    writeFailedCheckpoint(fixture.workspaceDb, { ...identity, requestId });
    const schedulerBefore = schedulerSnapshot(fixture.dataRoot);
    const checkpointBefore = getWorkerCheckpoint(
      fixture.workspaceDb,
      fixture.workspaceId,
      fixture.threadId,
      identity.turnId
    );
    await closeFixture(fixture);
    const destination = join(
      fixture.backupRoot,
      'workspaces',
      fixture.workspaceId,
      'workspace.sqlite'
    );
    mkdirSync(join(fixture.backupRoot, 'workspaces', fixture.workspaceId), { recursive: true });
    writeFileSync(destination, 'occupied');

    await expect(
      cleanCancelledAdmissionTaskCheckpoints({
        apply: true,
        backupRoot: fixture.backupRoot,
        checkpoints: [identity],
        dataRoot: fixture.dataRoot,
      })
    ).rejects.toThrow(/backup destination already exists/);
    expect(readCheckpoint(fixture.dataRoot, identity)).toEqual(checkpointBefore);
    expect(schedulerSnapshot(fixture.dataRoot)).toEqual(schedulerBefore);
    expect(readFileSync(destination, 'utf8')).toBe('occupied');
  });

  it.each([
    ['invalid Turn status', 'turn-schema'],
    ['corrupt native Thread JSON', 'thread-json'],
    ['malformed immutable Item JSON', 'items-json'],
    ['missing immutable Item history', 'missing-items'],
  ] as const)('blocks cleanup when unrelated published history has %s', async (_label, kind) => {
    const fixture = await createFixture();
    const identity = identityFor(fixture, testEntityId('tu', `turn_corrupt_${kind}`));
    const requestId = '0190f4c8-0000-7000-8000-000000001099';
    writeCancelledAdmission(fixture.coreDb, { ...identity, requestId });
    writeFailedCheckpoint(fixture.workspaceDb, { ...identity, requestId });
    const unrelated = await publishUnrelatedTurn(fixture.store, fixture.dataRoot);
    const historyPath = unrelated.itemsPath;
    const checkpointBefore = getWorkerCheckpoint(
      fixture.workspaceDb,
      fixture.workspaceId,
      fixture.threadId,
      identity.turnId
    );
    await closeFixture(fixture);
    if (kind === 'turn-schema') {
      corruptNativeMetadata(
        fixture.dataRoot,
        unrelated.workspaceId,
        'turn',
        unrelated.turnId,
        (raw) => JSON.stringify({ ...JSON.parse(raw), status: 'corrupt-invalid-status' })
      );
    } else if (kind === 'thread-json') {
      corruptNativeMetadata(
        fixture.dataRoot,
        unrelated.workspaceId,
        'thread',
        unrelated.threadId,
        () => '{'
      );
    } else if (kind === 'items-json') {
      // Replace only this stopped private fixture file; keep its original digest reference.
      unlinkSync(historyPath);
      writeFileSync(historyPath, '{\n');
    } else {
      unlinkSync(historyPath);
    }
    const historyBefore = nativeHistoryBytes(unrelated, kind);

    const result = await cleanCancelledAdmissionTaskCheckpoints({
      apply: true,
      backupRoot: fixture.backupRoot,
      checkpoints: [identity],
      dataRoot: fixture.dataRoot,
    });

    expect(result.outcome).toBe('blocked');
    expect(result.removedCount).toBe(0);
    expect(result.rows).toEqual([
      expect.objectContaining({
        decision: 'refused',
        reason: 'unreadable-history',
        turnId: identity.turnId,
      }),
    ]);
    expect(readCheckpoint(fixture.dataRoot, identity)).toEqual(checkpointBefore);
    expect(nativeHistoryBytes(unrelated, kind)).toEqual(historyBefore);
  });

  it('keeps an incomplete disposable Item JSONL tail without treating it as canonical history', async () => {
    const fixture = await createFixture();
    const identity = identityFor(fixture, 'tu_00000000-0000-71e2-bfd1-a8b0df334491');
    const requestId = '0190f4c8-0000-7000-8000-000000001098';
    writeCancelledAdmission(fixture.coreDb, { ...identity, requestId });
    writeFailedCheckpoint(fixture.workspaceDb, { ...identity, requestId });
    const unrelated = await publishUnrelatedTurn(fixture.store, fixture.dataRoot);
    const projectionRoot = join(
      fixture.dataRoot,
      'workspaces',
      unrelated.workspaceId,
      'projections',
      unrelated.turnId
    );
    mkdirSync(projectionRoot, { recursive: true });
    const itemsPath = join(projectionRoot, 'items.jsonl');
    appendFileSync(itemsPath, '{"id":');
    const itemsBefore = readFileSync(itemsPath);
    await closeFixture(fixture);

    const result = await cleanCancelledAdmissionTaskCheckpoints({
      apply: true,
      backupRoot: fixture.backupRoot,
      checkpoints: [identity],
      dataRoot: fixture.dataRoot,
    });

    expect(result.removedCount).toBe(1);
    expect(readFileSync(itemsPath)).toEqual(itemsBefore);
    expect(readCheckpoint(fixture.dataRoot, identity)).toBeNull();
  });
});

/** Publishes real native history outside the selected checkpoint Workspace. */
async function publishUnrelatedTurn(store: FsStore, dataRoot: string) {
  const workspace = await store.createWorkspace('Unrelated history');
  const thread = await store.createThread(workspace.id, 'Unrelated history');
  const turn = await store.createTurn(workspace.id, thread.id, 'Unrelated work', ACTOR);
  await store.createItem({
    id: testEntityId('it', `unrelated-${turn.id}`),
    owner: { kind: 'workspace', workspaceId: workspace.id },
    threadId: thread.id,
    turnId: turn.id,
    type: 'user-message',
    status: 'completed',
    actor: ACTOR,
    text: 'Retained unrelated content.',
    createdAt: turn.startedAt!,
    completedAt: turn.startedAt!,
  });
  const db = openWorkspaceDb(dataRoot, workspace.id);
  try {
    const row = db.sqlite
      .prepare(
        "SELECT content_json FROM control_product_entries WHERE kind = 'item' AND turn_id = ?"
      )
      .get(turn.id) as { content_json: string };
    return {
      dataRoot,
      itemsPath: join(
        dataRoot,
        'workspaces',
        workspace.id,
        'evidence',
        'backend',
        JSON.parse(row.content_json).reference.locator.path
      ),
      threadId: thread.id,
      turnId: turn.id,
      workspaceId: workspace.id,
    };
  } finally {
    db.sqlite.close();
  }
}

/** Corrupts only a stopped retained row; normal native writers and constraints stay intact. */
function corruptNativeMetadata(
  dataRoot: string,
  workspaceId: string,
  kind: 'thread' | 'turn',
  id: string,
  change: (raw: string) => string
): void {
  const sqlite = new Database(join(dataRoot, 'workspaces', workspaceId, 'db', 'workspace.sqlite'), {
    fileMustExist: true,
  });
  try {
    const table = kind === 'thread' ? 'control_threads' : 'control_turns';
    const row = sqlite.prepare(`SELECT record_json FROM ${table} WHERE id = ?`).get(id) as {
      record_json: string;
    };
    sqlite.pragma('ignore_check_constraints = ON');
    try {
      expect(
        sqlite
          .prepare(`UPDATE ${table} SET record_json = ? WHERE id = ?`)
          .run(change(row.record_json), id).changes
      ).toBe(1);
    } finally {
      sqlite.pragma('ignore_check_constraints = OFF');
    }
  } finally {
    sqlite.close();
  }
}

/** Captures the exact native metadata or immutable bytes selected by the corruption case. */
function nativeHistoryBytes(
  record: Awaited<ReturnType<typeof publishUnrelatedTurn>>,
  kind: 'turn-schema' | 'thread-json' | 'items-json' | 'missing-items'
): string | Buffer | null {
  if (kind === 'items-json' || kind === 'missing-items')
    return existsSync(record.itemsPath) ? readFileSync(record.itemsPath) : null;
  const sqlite = new Database(
    join(record.dataRoot, 'workspaces', record.workspaceId, 'db', 'workspace.sqlite'),
    { readonly: true }
  );
  try {
    const table = kind === 'thread-json' ? 'control_threads' : 'control_turns';
    return (
      sqlite
        .prepare(`SELECT record_json FROM ${table} WHERE id = ?`)
        .get(kind === 'thread-json' ? record.threadId : record.turnId) as { record_json: string }
    ).record_json;
  } finally {
    sqlite.close();
  }
}

/** Reads exact retained Item descriptors and original bytes without a repair or prune path. */
function nativeItemBytes(dataRoot: string, workspaceId: string, turnId: string) {
  const sqlite = new Database(join(dataRoot, 'workspaces', workspaceId, 'db', 'workspace.sqlite'), {
    readonly: true,
  });
  try {
    return (
      sqlite
        .prepare(
          "SELECT content_json FROM control_product_entries WHERE kind = 'item' AND turn_id = ? ORDER BY sequence"
        )
        .all(turnId) as { content_json: string }[]
    ).map((row) => ({
      descriptor: row.content_json,
      bytes: readFileSync(
        join(
          dataRoot,
          'workspaces',
          workspaceId,
          'evidence',
          'backend',
          JSON.parse(row.content_json).reference.locator.path
        )
      ),
    }));
  } finally {
    sqlite.close();
  }
}

/** Builds one checkpoint identity inside a fixture Workspace and Thread. */
function identityFor(
  fixture: { readonly threadId: string; readonly workspaceId: string },
  turnId: string
): { readonly threadId: string; readonly turnId: string; readonly workspaceId: string } {
  return { threadId: fixture.threadId, turnId, workspaceId: fixture.workspaceId };
}

/** Inserts one command receipt, including an already expired row. */
function insertReceipt(
  workspaceDb: WorkspaceDb,
  input: {
    readonly expiresAt: string;
    readonly requestId: string;
    readonly requestKey: string;
    readonly responseId: string;
    readonly scope: { readonly threadId: string; readonly workspaceId: string };
  }
): void {
  workspaceDb.sqlite
    .prepare(
      `INSERT INTO idempotency_requests (
         schema_version, request_key, command_name, request_id, scope_json, input_hash, response_kind,
         response_id, created_at, expires_at
       ) VALUES (1, ?, 'task.start', ?, ?, 'hash', 'turn', ?, '2020-01-01T00:00:00.000Z', ?)`
    )
    .run(
      input.requestKey,
      input.requestId,
      JSON.stringify(input.scope),
      input.responseId,
      input.expiresAt
    );
}

/** Reads receipt rows without using the pruning inventory. */
function readReceipts(dataRoot: string, workspaceId: string): unknown[] {
  const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
  try {
    return workspaceDb.sqlite
      .prepare(
        `SELECT request_key, command_name, request_id, scope_json, input_hash, response_kind,
                response_id, response_json, created_at, expires_at
         FROM idempotency_requests ORDER BY request_key`
      )
      .all();
  } finally {
    workspaceDb.sqlite.close();
  }
}

/** Reopens a Workspace database and reads one checkpoint. */
function readCheckpoint(
  dataRoot: string,
  identity: { readonly threadId: string; readonly turnId: string; readonly workspaceId: string }
) {
  const workspaceDb = openWorkspaceDb(dataRoot, identity.workspaceId);
  try {
    return getWorkerCheckpoint(
      workspaceDb,
      identity.workspaceId,
      identity.threadId,
      identity.turnId
    );
  } finally {
    workspaceDb.sqlite.close();
  }
}

describe('cancelled-admission cleanup global native absence', () => {
  it.each([
    'Server',
    'Workspace',
  ] as const)('refuses retained %s Item and event history whose required native Turn is missing', async (evidenceOwner) => {
    const fixture = await createFixture();
    const identity = identityFor(
      fixture,
      testEntityId('tu', `missing_native_turn_authority_${evidenceOwner}`)
    );
    const requestId = '0190f4c8-0000-7000-8000-000000001203';
    writeCancelledAdmission(fixture.coreDb, { ...identity, requestId });
    writeFailedCheckpoint(fixture.workspaceDb, { ...identity, requestId });
    const threadId =
      evidenceOwner === 'Server'
        ? (await fixture.store.createServerThread('Retained Server history')).id
        : fixture.threadId;
    const turn =
      evidenceOwner === 'Server'
        ? await fixture.store.createServerTurn(
            threadId,
            'Retained history requires its native Turn authority',
            ACTOR,
            null,
            { turnId: identity.turnId }
          )
        : await fixture.store.createTurn(
            fixture.workspaceId,
            threadId,
            'Retained history requires its native Turn authority',
            ACTOR,
            null,
            { turnId: identity.turnId }
          );
    const item = {
      id: testEntityId('it', `missing_native_turn_authority_${evidenceOwner}`),
      owner: turn.owner,
      threadId,
      turnId: turn.id,
      type: 'user-message' as const,
      status: 'completed' as const,
      actor: ACTOR,
      text: 'Retain this Item and its exact immutable bytes.',
      createdAt: turn.startedAt!,
      completedAt: turn.startedAt!,
    };
    if (evidenceOwner === 'Server') {
      expect(turn.owner).toEqual({ kind: 'server' });
      await fixture.store.createServerItem(item);
      const event = await fixture.store.persistServerTurnEvent(turn.id, {
        event: 'turn.started',
        threadId,
        turnId: turn.id,
        data: { type: 'turn-started', turnId: turn.id, status: 'running' },
      });
      expect(event.owner).toEqual({ kind: 'server' });
      expect(event).not.toHaveProperty('workspaceId');
    } else {
      expect(turn.owner).toEqual({ kind: 'workspace', workspaceId: fixture.workspaceId });
      await fixture.store.createItem(item);
      await fixture.store.persistTurnEvent(turn.id, {
        event: 'turn.started',
        workspaceId: fixture.workspaceId,
        threadId,
        turnId: turn.id,
        data: { type: 'turn-started', turnId: turn.id, status: 'running' },
      });
    }
    const checkpointBefore = getWorkerCheckpoint(
      fixture.workspaceDb,
      identity.workspaceId,
      identity.threadId,
      identity.turnId
    );
    expect(checkpointBefore).not.toBeNull();
    await closeFixture(fixture);
    const corePath = join(fixture.dataRoot, 'server', 'db', 'core.sqlite');
    const workspacePath = join(
      fixture.dataRoot,
      'workspaces',
      fixture.workspaceId,
      'db',
      'workspace.sqlite'
    );
    const sqlite = new Database(evidenceOwner === 'Server' ? corePath : workspacePath, {
      fileMustExist: true,
    });
    try {
      // Model stopped retained corruption only; normal native writers keep their constraints.
      sqlite.pragma('foreign_keys = OFF');
      try {
        expect(sqlite.prepare('DELETE FROM control_turns WHERE id = ?').run(turn.id).changes).toBe(
          1
        );
      } finally {
        sqlite.pragma('foreign_keys = ON');
      }
      expect(
        sqlite.prepare('SELECT id FROM control_turns WHERE id = ?').get(turn.id)
      ).toBeUndefined();
      expect(
        sqlite
          .prepare(
            'SELECT kind, turn_id FROM control_product_entries WHERE turn_id = ? ORDER BY kind'
          )
          .all(turn.id)
      ).toEqual([
        { kind: 'event', turn_id: turn.id },
        { kind: 'item', turn_id: turn.id },
      ]);
    } finally {
      sqlite.close();
    }
    const retainedRows = (path: string, tables: readonly string[]) => {
      const db = new Database(path, { fileMustExist: true, readonly: true });
      try {
        return tables.map((table) => ({
          table,
          rows: db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        }));
      } finally {
        db.close();
      }
    };
    const coreTables = [
      'workspace_registry',
      'workspace_members',
      'scheduler_admission_entries',
      'control_threads',
      'control_turns',
      'control_product_entries',
      'idempotency_requests',
    ];
    const workspaceTables = [
      'control_workspaces',
      'control_threads',
      'control_turns',
      'control_agent_sessions',
      'control_product_entries',
      'idempotency_requests',
      'worker_turn_checkpoints',
    ];
    const contentRoots = [
      join(fixture.dataRoot, 'server', 'evidence', 'backend'),
      join(fixture.dataRoot, 'workspaces', fixture.workspaceId, 'evidence', 'backend'),
    ];
    const retainedBytes = () =>
      contentRoots.map((root) => ({
        root,
        files: existsSync(root)
          ? readdirSync(root, { recursive: true })
              .map(String)
              .sort()
              .filter((path) => lstatSync(join(root, path)).isFile())
              .map((path) => ({ path, bytes: readFileSync(join(root, path)) }))
          : [],
      }));
    const coreBefore = retainedRows(corePath, coreTables);
    const workspaceBefore = retainedRows(workspacePath, workspaceTables);
    const bytesBefore = retainedBytes();
    expect(bytesBefore[evidenceOwner === 'Server' ? 0 : 1]!.files.length).toBeGreaterThanOrEqual(2);
    const schedulerBefore = schedulerSnapshot(fixture.dataRoot);
    const backupBefore = readdirSync(fixture.backupRoot, { recursive: true }).sort();
    for (const apply of [false, true]) {
      const result = await cleanCancelledAdmissionTaskCheckpoints({
        apply,
        backupRoot: fixture.backupRoot,
        checkpoints: [identity],
        dataRoot: fixture.dataRoot,
      });
      expect(result.outcome).toBe('blocked');
      expect(result.removedCount).toBe(0);
      expect(result.backupRoot).toBeNull();
      expect(result.rows).toEqual([
        expect.objectContaining({ ...identity, decision: 'refused', reason: 'unreadable-history' }),
      ]);
      expect(readCheckpoint(fixture.dataRoot, identity)).toEqual(checkpointBefore);
      expect(retainedRows(corePath, coreTables)).toEqual(coreBefore);
      expect(retainedRows(workspacePath, workspaceTables)).toEqual(workspaceBefore);
      expect(retainedBytes()).toEqual(bytesBefore);
      expect(schedulerSnapshot(fixture.dataRoot)).toEqual(schedulerBefore);
      expect(readdirSync(fixture.backupRoot, { recursive: true }).sort()).toEqual(backupBefore);
    }
  });

  it.each([
    { kind: 'Server Turn', registryStatus: 'active' },
    { kind: 'missing registered Workspace', registryStatus: 'active' },
    { kind: 'missing registered Workspace', registryStatus: 'retired' },
  ] as const)('preserves a healthy selected checkpoint with $kind and $registryStatus registry status', async ({
    kind,
    registryStatus,
  }) => {
    const fixture = await createFixture();
    const identity = identityFor(fixture, testEntityId('tu', `global_absence_${kind}`));
    const requestId = '0190f4c8-0000-7000-8000-000000001201';
    writeCancelledAdmission(fixture.coreDb, { ...identity, requestId });
    writeFailedCheckpoint(fixture.workspaceDb, { ...identity, requestId });
    const healthyTurn = await fixture.store.createTurn(
      fixture.workspaceId,
      fixture.threadId,
      'Retain selected Workspace history',
      ACTOR
    );
    insertReceipt(fixture.workspaceDb, {
      expiresAt: '2020-01-02T00:00:00.000Z',
      requestId: '0190f4c8-0000-7000-8000-000000001202',
      requestKey: 'unrelated-global-absence-receipt',
      responseId: healthyTurn.id,
      scope: { threadId: fixture.threadId, workspaceId: fixture.workspaceId },
    });
    let missingRoot: string | null = null;
    const retainedRoot = join(fixture.dataRoot, 'preserved-history-root');
    if (kind === 'Server Turn') {
      const serverThread = await fixture.store.createServerThread('Retained Server service');
      const serverTurn = await fixture.store.createServerTurn(
        serverThread.id,
        'Published service history contradicts checkpoint absence',
        ACTOR,
        null,
        { turnId: identity.turnId, status: 'completed' }
      );
      expect(serverThread.owner).toEqual({ kind: 'server' });
      expect(serverTurn.owner).toEqual({ kind: 'server' });
      expect(serverTurn).not.toHaveProperty('workspaceId');
      expect(fixture.store.getServerTurnTranscript(serverTurn.id)).toHaveLength(1);
    } else {
      const unrelated = await publishUnrelatedTurn(fixture.store, fixture.dataRoot);
      recordWorkspaceOwnerMembership({
        coreDb: fixture.coreDb,
        ownerUserId: LOCAL_USER_ID,
        workspaceId: unrelated.workspaceId,
      });
      if (registryStatus === 'retired') {
        await shutdownControlStoreWorkerClient();
        // Seed retained lifecycle for this stopped cleanup fixture, not ordinary product admission.
        expect(
          fixture.coreDb.sqlite
            .prepare(
              "UPDATE workspace_registry SET status='retired', revision=revision+1 WHERE workspace_id=? AND status='active'"
            )
            .run(unrelated.workspaceId).changes
        ).toBe(1);
      }
      expect(
        fixture.coreDb.sqlite
          .prepare('SELECT status FROM workspace_registry WHERE workspace_id=?')
          .get(unrelated.workspaceId)
      ).toEqual({ status: registryStatus });
      missingRoot = join(fixture.dataRoot, 'workspaces', unrelated.workspaceId);
    }
    const checkpointBefore = getWorkerCheckpoint(
      fixture.workspaceDb,
      identity.workspaceId,
      identity.threadId,
      identity.turnId
    );
    const healthyBefore = fixture.store.getTurnById(healthyTurn.id);
    await closeFixture(fixture);
    if (missingRoot) renameSync(missingRoot, retainedRoot);
    const corePath = join(fixture.dataRoot, 'server', 'db', 'core.sqlite');
    const workspacePath = join(
      fixture.dataRoot,
      'workspaces',
      fixture.workspaceId,
      'db',
      'workspace.sqlite'
    );
    const rows = (path: string, tables: readonly string[]) => {
      const db = new Database(path, { fileMustExist: true, readonly: true });
      try {
        return tables.map((table) => ({
          table,
          rows: db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        }));
      } finally {
        db.close();
      }
    };
    const coreTables = [
      'workspace_registry',
      'workspace_members',
      'scheduler_admission_entries',
      'control_threads',
      'control_turns',
      'control_product_entries',
      'idempotency_requests',
    ];
    const workspaceTables = [
      'control_workspaces',
      'control_threads',
      'control_turns',
      'control_product_entries',
      'idempotency_requests',
      'worker_turn_checkpoints',
    ];
    const coreBefore = rows(corePath, coreTables);
    const workspaceBefore = rows(workspacePath, workspaceTables);
    const retainedFiles = (root: string) =>
      existsSync(root)
        ? readdirSync(root, { recursive: true })
            .map(String)
            .sort()
            .filter((path) => lstatSync(join(root, path)).isFile())
            .map((path) => ({ path, bytes: readFileSync(join(root, path)) }))
        : [];
    const serverContentRoot = join(fixture.dataRoot, 'server', 'evidence', 'backend');
    const serverBytes = retainedFiles(serverContentRoot);
    const movedBytes = retainedFiles(retainedRoot);
    const backupBefore = retainedFiles(fixture.backupRoot);
    const backupEntries = readdirSync(fixture.backupRoot, { recursive: true }).sort();
    for (const apply of [false, true]) {
      const result = await cleanCancelledAdmissionTaskCheckpoints({
        apply,
        backupRoot: fixture.backupRoot,
        checkpoints: [identity],
        dataRoot: fixture.dataRoot,
      });
      expect(result.removedCount).toBe(0);
      expect(result.backupRoot).toBeNull();
      expect(result.rows).toEqual([expect.objectContaining({ ...identity, decision: 'refused' })]);
      if (kind === 'missing registered Workspace') {
        expect(result.outcome).toBe('blocked');
        expect(result.rows[0]?.reason).toBe('unreadable-history');
        expect(existsSync(missingRoot!)).toBe(false);
      }
      expect(readCheckpoint(fixture.dataRoot, identity)).toEqual(checkpointBefore);
      expect(rows(corePath, coreTables)).toEqual(coreBefore);
      expect(rows(workspacePath, workspaceTables)).toEqual(workspaceBefore);
      expect(new FsStore({ dataRoot: fixture.dataRoot }).getTurnById(healthyTurn.id)).toEqual(
        healthyBefore
      );
      expect(retainedFiles(serverContentRoot)).toEqual(serverBytes);
      expect(retainedFiles(retainedRoot)).toEqual(movedBytes);
      expect(retainedFiles(fixture.backupRoot)).toEqual(backupBefore);
      expect(readdirSync(fixture.backupRoot, { recursive: true }).sort()).toEqual(backupEntries);
    }
  });
});
