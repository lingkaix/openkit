import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

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
