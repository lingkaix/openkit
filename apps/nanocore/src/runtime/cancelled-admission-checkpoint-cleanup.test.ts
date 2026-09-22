import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentEnvironmentPackageSchema } from '@openkit/config-schema';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { acquireDataRootLock } from '../bootstrap/lock.js';
import { FsStore } from '../lib/store.js';
import {
  cancelSchedulerAdmissionEntry,
  createSchedulerAdmissionEntry,
  createSchedulerPlacementPlan,
  createSchedulerSessionLease,
  ensureConfiguredSchedulerBaseline,
} from '../scheduler-records.js';
import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { LOCAL_USER_ID } from '../storage/fs-layout.js';
import { applyMigrations, applyScopedMigrations } from '../storage/migrate.js';
import { createTestAgentSetup } from '../test-support/agent-environment.js';
import { recordAgentEnvironmentPackageSnapshot } from './aep-snapshot-ledger.js';
import { resolveAgentEnvironmentPackage } from './agent-environment.js';
import { cleanCancelledAdmissionTaskCheckpoints } from './cancelled-admission-checkpoint-cleanup.js';
import { getWorkerCheckpoint, upsertWorkerCheckpoint } from './worker-checkpoints.js';

const ACTOR = { kind: 'user' as const, id: LOCAL_USER_ID };

/** Opens a stopped data root with one Workspace, Thread, and migrated databases. */
function createFixture(): {
  readonly backupRoot: string;
  readonly coreDb: CoreDb;
  readonly dataRoot: string;
  readonly store: FsStore;
  readonly threadId: string;
  readonly workspaceDb: WorkspaceDb;
  readonly workspaceId: string;
} {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-checkpoint-cleanup-'));
  const backupRoot = mkdtempSync(join(tmpdir(), 'openkit-checkpoint-cleanup-backup-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureConfiguredSchedulerBaseline(coreDb, { placement: 'local' });
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Checkpoint cleanup');
  const thread = store.createThread(workspace.id, 'Checkpoint cleanup thread');
  const workspaceDb = openWorkspaceDb(dataRoot, workspace.id);
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
function closeFixture(fixture: {
  readonly coreDb: CoreDb;
  readonly workspaceDb: WorkspaceDb;
}): void {
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

/** Records one cancelled admission and no lease for a missing Turn. */
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
    priorityClass: 'interactive',
    profileRef: 'agent_codex_host',
    queueEntryId,
    requestId: input.requestId,
    requestedAgentId: 'agent_codex_host',
    requiredPoolConstraints: ['openshell.local'],
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

/** Records one admitted lease that failed before Turn persistence. */
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
  createSchedulerAdmissionEntry(coreDb, {
    priorityClass: 'interactive',
    profileRef: 'agent_codex_host',
    queueEntryId,
    requestId: input.requestId,
    requestedAgentId: 'agent_codex_host',
    requiredPoolConstraints: ['openshell.local'],
    threadId: input.threadId,
    triggerActor: ACTOR,
    turnId: input.turnId,
    turnInput: 'Start failed before Turn persistence.',
    workspaceId: input.workspaceId,
  });
  createSchedulerPlacementPlan(coreDb, {
    degradedOptionalFeatures: [],
    expectedControlMode: 'poll',
    expectedDataPlaneMode: 'openshell-files',
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 30_000,
    planId: `plan_${input.turnId}`,
    plannedLeaseDurationMs: 900_000,
    policyDecisionIds: [],
    queueEntryId,
    schedulerEpoch: 1,
    selectedPoolId: 'pool_local',
    selectedTargetId: 'target_local',
  });
  createSchedulerSessionLease(coreDb, {
    agentSessionId: `as_${input.turnId}`,
    expiresAt: '2099-01-01T01:00:00.000Z',
    heartbeatDeadline: '2099-01-01T00:10:00.000Z',
    leaseId: `lease_${input.turnId}`,
    packageSnapshotId: `aepsnap_${input.turnId}`,
    planId: `plan_${input.turnId}`,
    sandboxTokenBindingRef: `lease-binding:lease_${input.turnId}`,
    startupDeadline: '2099-01-01T00:05:00.000Z',
  });
  coreDb.sqlite
    .prepare(
      `UPDATE scheduler_session_leases
       SET status = 'failed', release_reason = 'turn-start-failed', recovery_state = 'needs-evidence'
       WHERE lease_id = ?`
    )
    .run(`lease_${input.turnId}`);
}

/** Reads scheduler rows that this cleanup must preserve. */
function schedulerSnapshot(dataRoot: string): {
  readonly admissions: unknown[];
  readonly capacity: unknown[];
  readonly leases: unknown[];
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
      capacity: coreDb.sqlite
        .prepare(
          `SELECT target_id, pool_id, in_use_count, version
           FROM scheduler_capacity_records ORDER BY target_id, pool_id`
        )
        .all(),
      leases: coreDb.sqlite
        .prepare(
          `SELECT lease_id, release_reason, status, turn_id
           FROM scheduler_session_leases ORDER BY lease_id`
        )
        .all(),
    };
  } finally {
    coreDb.sqlite.close();
  }
}

describe('cancelled-admission Task checkpoint cleanup', () => {
  it('reports a proved cancelled admission on dry-run and removes it only on apply', async () => {
    const fixture = createFixture();
    const turnId = 'turn_cancelled_admission_orphan';
    const requestId = '0190f4c8-0000-7000-8000-000000000591';
    const siblingTurnId = 'turn_cancelled_admission_sibling';
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
    const keptTurn = fixture.store.createTurn(
      fixture.workspaceId,
      fixture.threadId,
      'Unrelated product history',
      ACTOR
    );
    const before = schedulerSnapshot(fixture.dataRoot);
    closeFixture(fixture);

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
    const fixture = createFixture();
    const turnId = 'turn_start_failure_orphan';
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
    closeFixture(fixture);
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
    const fixture = createFixture();
    const turnId = `turn_preserve_${mutate}`;
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
          `UPDATE scheduler_session_leases
           SET status = 'active', release_reason = NULL, recovery_state = NULL
           WHERE lease_id = ?`
        )
        .run(`lease_${turnId}`);
    }
    if (mutate === 'multiple-leases') {
      fixture.coreDb.sqlite
        .prepare(
          `INSERT INTO scheduler_session_leases (
             lease_id, plan_id, workspace_id, thread_id, turn_id, agent_session_id,
             package_snapshot_id, pool_id, target_id, status, acquired_at, expires_at,
             heartbeat_deadline, startup_deadline, renewal_count, scheduler_epoch,
             sandbox_binding_ref, backend_anchor_state, release_reason, recovery_state
           )
           SELECT 'lease_extra_' || turn_id, plan_id, workspace_id, thread_id, turn_id,
                  agent_session_id, package_snapshot_id, pool_id, target_id, status,
                  acquired_at, expires_at, heartbeat_deadline, startup_deadline, renewal_count,
                  scheduler_epoch, 'lease-binding:extra_' || turn_id, backend_anchor_state,
                  release_reason, recovery_state
           FROM scheduler_session_leases WHERE lease_id = ?`
        )
        .run(`lease_${turnId}`);
    }
    writeFailedCheckpoint(fixture.workspaceDb, {
      contextDigest: mutate === 'runtime' ? 'sha256:context' : null,
      goalId: mutate === 'goal' ? 'goal_preserve' : null,
      requestId,
      stage: mutate === 'stage' ? 'preparing' : 'failed',
      threadId: fixture.threadId,
      turnId,
      workerSessionId: mutate === 'session' ? 'as_preserve' : null,
      workspaceId: fixture.workspaceId,
    });
    if (mutate === 'lineage') {
      const other = fixture.store.createWorkspace('Other lineage');
      const otherThread = fixture.store.createThread(other.id, 'Other lineage thread');
      fixture.store.createTurn(other.id, otherThread.id, 'Foreign Turn', ACTOR, null, { turnId });
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
    closeFixture(fixture);
    if (mutate === 'history') {
      writeFileSync(
        join(
          fixture.dataRoot,
          'workspaces',
          fixture.workspaceId,
          'threads',
          fixture.threadId,
          'thread.json'
        ),
        '{'
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
      const fixture = createFixture();
      const turnId = `turn_receipt_${apply}`;
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
      closeFixture(fixture);

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
    const fixture = createFixture();
    const turnId = 'turn_unrelated_receipt';
    const requestId = '0190f4c8-0000-7000-8000-000000000992';
    const identity = { threadId: fixture.threadId, turnId, workspaceId: fixture.workspaceId };
    writeCancelledAdmission(fixture.coreDb, { ...identity, requestId });
    writeFailedCheckpoint(fixture.workspaceDb, { ...identity, requestId });
    insertReceipt(fixture.workspaceDb, {
      expiresAt: '2020-01-02T00:00:00.000Z',
      requestId: '0190f4c8-0000-7000-8000-000000000993',
      requestKey: 'receipt_unrelated',
      responseId: 'turn_someone_else',
      scope: { threadId: fixture.threadId, workspaceId: fixture.workspaceId },
    });
    const receiptsBefore = readReceipts(fixture.dataRoot, fixture.workspaceId);
    closeFixture(fixture);

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
    const fixture = createFixture();
    const turnId = `turn_history_${mode}`;
    const requestId = '0190f4c8-0000-7000-8000-000000000994';
    const identity = { threadId: fixture.threadId, turnId, workspaceId: fixture.workspaceId };
    if (mode !== 'refused') {
      writeCancelledAdmission(fixture.coreDb, { ...identity, requestId });
    }
    writeFailedCheckpoint(fixture.workspaceDb, { ...identity, requestId });
    const unrelated = fixture.store.createTurn(
      fixture.workspaceId,
      fixture.threadId,
      'Unrelated terminal approval',
      ACTOR
    );
    const timestamp = '2026-09-22T00:00:00.000Z';
    fixture.store.createItem({
      approvalRequestId: `ap_${unrelated.id}`,
      completedAt: null,
      createdAt: timestamp,
      description: 'Independent history',
      id: `it_req_${unrelated.id}`,
      kind: 'permission',
      status: 'in_progress',
      threadId: fixture.threadId,
      title: 'Unresolved approval',
      turnId: unrelated.id,
      type: 'approval-request',
      workspaceId: fixture.workspaceId,
    });
    fixture.store.updateTurn(unrelated.id, {
      completedAt: timestamp,
      error: null,
      status: 'completed',
    });
    const itemsPath = join(
      fixture.dataRoot,
      'workspaces',
      fixture.workspaceId,
      'threads',
      fixture.threadId,
      'turns',
      unrelated.id,
      'items.jsonl'
    );
    const itemsBefore = readFileSync(itemsPath);
    closeFixture(fixture);

    const result = await cleanCancelledAdmissionTaskCheckpoints({
      apply: mode === 'apply',
      backupRoot: fixture.backupRoot,
      checkpoints: [identity],
      dataRoot: fixture.dataRoot,
    });

    expect(readFileSync(itemsPath)).toEqual(itemsBefore);
    expect(readFileSync(itemsPath, 'utf8')).not.toContain('it_approval_terminal_denial_');
    if (mode === 'apply') {
      expect(result.removedCount).toBe(1);
      expect(readCheckpoint(fixture.dataRoot, identity)).toBeNull();
    } else {
      expect(result.removedCount).toBe(0);
      expect(readCheckpoint(fixture.dataRoot, identity)).not.toBeNull();
    }
  });

  it('refuses malformed diagnostics and blocks every selected checkpoint', async () => {
    const fixture = createFixture();
    const corruptId = identityFor(fixture, 'turn_diag_corrupt');
    const cleanId = identityFor(fixture, 'turn_diag_clean');
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
    closeFixture(fixture);

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
    const fixture = createFixture();
    const identity = identityFor(fixture, 'turn_context_shape');
    const requestId = '0190f4c8-0000-7000-8000-000000000996';
    writeCancelledAdmission(fixture.coreDb, { ...identity, requestId });
    writeFailedCheckpoint(fixture.workspaceDb, { ...identity, requestId });
    fixture.workspaceDb.sqlite
      .prepare('UPDATE worker_turn_checkpoints SET diagnostics_summary = ? WHERE turn_id = ?')
      .run(
        JSON.stringify({ contextAssembly: { contextDigest: 'sha256:ran', contextRefs: [] } }),
        identity.turnId
      );
    closeFixture(fixture);

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
    const fixture = createFixture();
    const identity = identityFor(fixture, `turn_typed_${_label.replace(' ', '_')}`);
    const requestId = '0190f4c8-0000-7000-8000-000000000997';
    writeCancelledAdmission(fixture.coreDb, { ...identity, requestId });
    writeFailedCheckpoint(fixture.workspaceDb, { ...identity, requestId });
    fixture.workspaceDb.sqlite
      .prepare('UPDATE worker_turn_checkpoints SET diagnostics_summary = ? WHERE turn_id = ?')
      .run(diagnostics, identity.turnId);
    closeFixture(fixture);

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
    const fixture = createFixture();
    const identity = identityFor(fixture, 'turn_plain_failure');
    const requestId = '0190f4c8-0000-7000-8000-000000000998';
    writeCancelledAdmission(fixture.coreDb, { ...identity, requestId });
    writeFailedCheckpoint(fixture.workspaceDb, { ...identity, requestId });
    fixture.workspaceDb.sqlite
      .prepare('UPDATE worker_turn_checkpoints SET diagnostics_summary = ? WHERE turn_id = ?')
      .run('Worker start failed.', identity.turnId);
    closeFixture(fixture);

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

  it.each([
    'workspace_id',
    'thread_id',
  ] as const)('refuses a placement plan whose %s disagrees with the proof', async (column) => {
    const fixture = createFixture();
    const identity = identityFor(fixture, `turn_plan_${column}`);
    const requestId = '0190f4c8-0000-7000-8000-000000000999';
    writeStartFailureLease(fixture.coreDb, { ...identity, requestId });
    writeFailedCheckpoint(fixture.workspaceDb, { ...identity, requestId });
    fixture.coreDb.sqlite
      .prepare(`UPDATE scheduler_placement_plans SET ${column} = ? WHERE turn_id = ?`)
      .run(column === 'workspace_id' ? 'ws_foreign' : 'th_foreign', identity.turnId);
    const plansBefore = fixture.coreDb.sqlite
      .prepare(
        `SELECT plan_id, queue_entry_id, workspace_id, thread_id, turn_id
           FROM scheduler_placement_plans ORDER BY plan_id`
      )
      .all();
    const schedulerBefore = schedulerSnapshot(fixture.dataRoot);
    const checkpointBefore = getWorkerCheckpoint(
      fixture.workspaceDb,
      fixture.workspaceId,
      fixture.threadId,
      identity.turnId
    );
    closeFixture(fixture);

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
        reason: 'missing-provenance',
        turnId: identity.turnId,
      }),
    ]);
    expect(readCheckpoint(fixture.dataRoot, identity)).toEqual(checkpointBefore);
    expect(schedulerSnapshot(fixture.dataRoot)).toEqual(schedulerBefore);
    const coreDb = openCoreDb(fixture.dataRoot);
    try {
      expect(
        coreDb.sqlite
          .prepare(
            `SELECT plan_id, queue_entry_id, workspace_id, thread_id, turn_id
               FROM scheduler_placement_plans ORDER BY plan_id`
          )
          .all()
      ).toEqual(plansBefore);
    } finally {
      coreDb.sqlite.close();
    }
  });

  it('refuses a runtime evidence row without using context digest as a shortcut', async () => {
    const fixture = createFixture();
    const identity = identityFor(fixture, 'turn_runtime_row');
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
    closeFixture(fixture);

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
    const fixture = createFixture();
    const identity = identityFor(fixture, 'turn_control');
    const requestId = '0190f4c8-0000-7000-8000-000000001002';
    writeCancelledAdmission(fixture.coreDb, { ...identity, requestId });
    writeFailedCheckpoint(fixture.workspaceDb, { ...identity, requestId });
    fixture.coreDb.sqlite
      .prepare(
        `INSERT INTO worker_control_records (
           workspace_id, thread_id, turn_id, agent_session_id, package_snapshot_id, request_id,
           operation, record_key, sequence, record_json, accepted_at
         ) VALUES (?, ?, ?, 'as_control', 'aepsnap_control', ?, 'observe', 'key', 1, '{}', ?)`
      )
      .run(
        fixture.workspaceId,
        fixture.threadId,
        identity.turnId,
        requestId,
        '2026-09-22T00:00:00.000Z'
      );
    closeFixture(fixture);

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
    const fixture = createFixture();
    const identity = identityFor(fixture, 'turn_package');
    const requestId = '0190f4c8-0000-7000-8000-000000001003';
    writeCancelledAdmission(fixture.coreDb, { ...identity, requestId });
    writeFailedCheckpoint(fixture.workspaceDb, { ...identity, requestId });
    const sessionId = 'as_package';
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
            humanGate: null,
            id: identity.turnId,
            items: [],
            startedAt: '2026-09-22T00:00:00.000Z',
            status: 'running',
            threadId: fixture.threadId,
            triggerActor: ACTOR,
            workspaceId: fixture.workspaceId,
          },
          turnInput: 'Run tests',
          workspaceCwd: '/workspace',
          workspaceRoots: [],
        })
      ),
    });
    const sessionDir = join(
      fixture.dataRoot,
      'workspaces',
      fixture.workspaceId,
      'runtime',
      'agent-sessions',
      sessionId
    );
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({ id: sessionId }));
    closeFixture(fixture);

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
    const fixture = createFixture();
    const identity = identityFor(fixture, 'turn_session');
    const requestId = '0190f4c8-0000-7000-8000-000000001004';
    writeStartFailureLease(fixture.coreDb, { ...identity, requestId });
    writeFailedCheckpoint(fixture.workspaceDb, { ...identity, requestId });
    const sessionId = `as_${identity.turnId}`;
    const sessionDir = join(
      fixture.dataRoot,
      'workspaces',
      fixture.workspaceId,
      'runtime',
      'agent-sessions',
      sessionId
    );
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({ id: sessionId }));
    closeFixture(fixture);

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
    const fixture = createFixture();
    const identity = identityFor(fixture, 'turn_lock');
    const requestId = '0190f4c8-0000-7000-8000-000000001005';
    writeCancelledAdmission(fixture.coreDb, { ...identity, requestId });
    writeFailedCheckpoint(fixture.workspaceDb, { ...identity, requestId });
    const checkpointBefore = getWorkerCheckpoint(
      fixture.workspaceDb,
      fixture.workspaceId,
      fixture.threadId,
      identity.turnId
    );
    closeFixture(fixture);
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
    const fixture = createFixture();
    const identity = identityFor(fixture, 'turn_backup');
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
    closeFixture(fixture);
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
});

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
         request_key, command_name, request_id, scope_json, input_hash, response_kind,
         response_id, created_at, expires_at
       ) VALUES (?, 'task.start', ?, ?, 'hash', 'turn', ?, '2020-01-01T00:00:00.000Z', ?)`
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
