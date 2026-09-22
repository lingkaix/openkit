import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { acquireDataRootLock, type DataRootLock, DataRootLockError } from '../bootstrap/lock.js';
import {
  isTerminalLeaseStatus,
  listSchedulerSessionLeasesForTurn,
  requireSchedulerSessionLeaseAdmissionContext,
  type SchedulerSessionLeaseRecord,
} from '../scheduler-records.js';
import {
  type DurableCommandRequestRead,
  readDurableCommandRequestRecords,
} from '../storage/command-request-records.js';
import {
  type CoreDb,
  openBootVerifiedWorkspaceDb,
  openExistingCoreDbWithIntegrityCheck,
  type WorkspaceDb,
} from '../storage/db.js';
import {
  type PublishedTurnIdentity,
  readPublishedAgentSessionIds,
  readPublishedTurnIdentities,
} from '../storage/workspace-file-records.js';
import { listExportableAgentEnvironmentPackageSnapshots } from './aep-snapshot-ledger.js';
import { getWorkerCheckpoint, type WorkerCheckpointRecord } from './worker-checkpoints.js';
import { clearWorkerCheckpointAfterTerminalState } from './worker-recovery.js';
import { isTerminalWorkerTurnStage } from './worker-stage.js';

/** Explicit checkpoint identity selected by the operator. */
export interface CancelledAdmissionCheckpointIdentity {
  readonly workspaceId: string;
  readonly threadId: string;
  readonly turnId: string;
}

/** One selected checkpoint after dry-run classification or apply. */
export interface CancelledAdmissionCheckpointCleanupRow
  extends CancelledAdmissionCheckpointIdentity {
  readonly decision: 'absent' | 'removable' | 'removed' | 'refused';
  readonly reason: string;
}

/** Result of one stopped-server checkpoint cleanup invocation. */
export interface CancelledAdmissionCheckpointCleanupResult {
  readonly applied: boolean;
  readonly backupRoot: string | null;
  readonly outcome: 'succeeded' | 'blocked';
  readonly removedCount: number;
  readonly rows: readonly CancelledAdmissionCheckpointCleanupRow[];
}

/** Input for the stopped-server missing-Turn checkpoint cleanup. */
export interface CleanCancelledAdmissionTaskCheckpointsInput {
  /** When true, delete proved checkpoints after a consistent backup. Dry-run is the default. */
  readonly apply?: boolean;
  /** External destination for Workspace database backups. Required even for dry-run. */
  readonly backupRoot: string;
  /** Explicit checkpoint identities. The command never scans for deletion candidates. */
  readonly checkpoints: readonly CancelledAdmissionCheckpointIdentity[];
  /** NanoCore data root whose server is stopped. */
  readonly dataRoot: string;
}

type ReadableReceipts = Extract<DurableCommandRequestRead, { status: 'readable' }>['records'];

type Classification = {
  readonly decision: 'absent' | 'removable' | 'refused';
  readonly reason: string;
};

/**
 * Reports or deletes explicit failed Task checkpoints whose product Turns were never persisted.
 *
 * NanoCore must be stopped. Dry-run is the default. Apply backs up each mutated Workspace
 * database outside the data root, rechecks the selected row, and deletes only that checkpoint.
 */
export async function cleanCancelledAdmissionTaskCheckpoints(
  input: CleanCancelledAdmissionTaskCheckpointsInput
): Promise<CancelledAdmissionCheckpointCleanupResult> {
  const dataRoot = resolve(input.dataRoot);
  const backupRoot = resolve(input.backupRoot);
  const apply = input.apply === true;
  if (!existsSync(dataRoot)) {
    throw new Error(`Cancelled-admission checkpoint cleanup data root is missing: ${dataRoot}`);
  }
  if (backupRoot === dataRoot || backupRoot.startsWith(`${dataRoot}/`)) {
    throw new Error(
      'Cancelled-admission checkpoint cleanup backup root must be outside the data root.'
    );
  }
  if (input.checkpoints.length === 0) {
    throw new Error(
      'Cancelled-admission checkpoint cleanup requires at least one checkpoint identity.'
    );
  }
  const seen = new Set<string>();
  for (const identity of input.checkpoints) {
    const key = checkpointKey(identity);
    if (seen.has(key)) {
      throw new Error(
        `Cancelled-admission checkpoint cleanup received a duplicate identity: ${key}`
      );
    }
    seen.add(key);
  }

  let lock: DataRootLock;
  try {
    lock = acquireDataRootLock(dataRoot, {
      bootId: `cancelled-admission-checkpoint-cleanup-${randomUUID()}`,
    });
  } catch (error) {
    if (error instanceof DataRootLockError) {
      throw new Error(
        'Cancelled-admission checkpoint cleanup requires a stopped NanoCore with an exclusive data-root lock.'
      );
    }
    throw error;
  }

  let coreDb: CoreDb | null = null;
  const workspaceDbs = new Map<string, WorkspaceDb>();
  try {
    try {
      coreDb = openExistingCoreDbWithIntegrityCheck(dataRoot);
    } catch {
      return blocked(input.checkpoints, 'unreadable-history');
    }
    const openedCoreDb = coreDb;
    if (!openedCoreDb) {
      return blocked(input.checkpoints, 'unreadable-history');
    }
    const history = readPublishedTurnIdentities(dataRoot);
    const receipts = readDurableCommandRequestRecords(dataRoot);
    if (history.status === 'unreadable' || receipts.status === 'unreadable') {
      return blocked(input.checkpoints, 'unreadable-history');
    }

    const classified = input.checkpoints.map((identity) => {
      const workspaceDb = openSelectedWorkspace(workspaceDbs, dataRoot, identity.workspaceId);
      const classification = classifyCheckpoint({
        checkpoint: identity,
        coreDb: openedCoreDb,
        dataRoot,
        history,
        receipts: receipts.records,
        workspaceDb,
      });
      return { ...identity, ...classification };
    });
    if (classified.some((row) => row.reason === 'unreadable-history')) {
      return blocked(input.checkpoints, 'unreadable-history');
    }
    if (!apply) {
      return {
        applied: false,
        backupRoot: null,
        outcome: 'succeeded',
        removedCount: 0,
        rows: classified,
      };
    }

    const removable = classified.filter((row) => row.decision === 'removable');
    if (removable.length === 0) {
      return {
        applied: true,
        backupRoot: null,
        outcome: 'succeeded',
        removedCount: 0,
        rows: classified,
      };
    }

    const workspaceIds = [...new Set(removable.map((row) => row.workspaceId))];
    for (const workspaceId of workspaceIds) {
      const destination = join(backupRoot, 'workspaces', workspaceId, 'workspace.sqlite');
      if (existsSync(destination)) {
        throw new Error(
          'Cancelled-admission checkpoint cleanup backup destination already exists.'
        );
      }
      mkdirSync(dirname(destination), { recursive: true });
      const workspaceDb = openSelectedWorkspace(workspaceDbs, dataRoot, workspaceId);
      if (!workspaceDb) {
        throw new Error(
          'Cancelled-admission checkpoint cleanup lost the selected Workspace database.'
        );
      }
      await workspaceDb.sqlite.backup(destination);
    }

    const rows: CancelledAdmissionCheckpointCleanupRow[] = [];
    let removedCount = 0;
    for (const row of classified) {
      if (row.decision !== 'removable') {
        rows.push(row);
        continue;
      }
      const workspaceDb = openSelectedWorkspace(workspaceDbs, dataRoot, row.workspaceId);
      if (!workspaceDb) {
        rows.push({ ...row, decision: 'refused', reason: 'changed-before-delete' });
        continue;
      }
      const againHistory = readPublishedTurnIdentities(dataRoot);
      const againReceipts = readDurableCommandRequestRecords(dataRoot);
      if (againHistory.status === 'unreadable' || againReceipts.status === 'unreadable') {
        rows.push({ ...row, decision: 'refused', reason: 'changed-before-delete' });
        continue;
      }
      const again = classifyCheckpoint({
        checkpoint: row,
        coreDb: openedCoreDb,
        dataRoot,
        history: againHistory,
        receipts: againReceipts.records,
        workspaceDb,
      });
      if (again.decision !== 'removable' || again.reason !== row.reason) {
        rows.push({ ...row, decision: 'refused', reason: 'changed-before-delete' });
        continue;
      }
      const cleared = await clearWorkerCheckpointAfterTerminalState(workspaceDb, {
        threadId: row.threadId,
        turnId: row.turnId,
        workspaceId: row.workspaceId,
      });
      if (!cleared) {
        rows.push({ ...row, decision: 'refused', reason: 'changed-before-delete' });
        continue;
      }
      removedCount += 1;
      rows.push({ ...row, decision: 'removed' });
    }
    return {
      applied: true,
      backupRoot,
      outcome: 'succeeded',
      removedCount,
      rows,
    };
  } finally {
    for (const workspaceDb of workspaceDbs.values()) {
      workspaceDb.sqlite.close();
    }
    coreDb?.sqlite.close();
    lock.release();
  }
}

/** Parses and runs the stopped-server checkpoint cleanup CLI. */
export function runCancelledAdmissionCheckpointCleanupCli(
  argv: readonly string[],
  write: (line: string) => void = (line) => {
    process.stdout.write(line);
  }
): Promise<CancelledAdmissionCheckpointCleanupResult> {
  const args = parseArgs(argv);
  return cleanCancelledAdmissionTaskCheckpoints(args).then((result) => {
    write(
      `${JSON.stringify(
        {
          applied: result.applied,
          outcome: result.outcome,
          removedCount: result.removedCount,
          rows: result.rows,
        },
        null,
        2
      )}\n`
    );
    if (result.outcome === 'blocked') {
      throw new Error(
        'Cancelled-admission checkpoint cleanup blocked because history could not be proved.'
      );
    }
    return result;
  });
}

function parseArgs(argv: readonly string[]): CleanCancelledAdmissionTaskCheckpointsInput {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  let dataRoot: string | undefined;
  let backupRoot: string | undefined;
  let apply = false;
  const checkpoints: CancelledAdmissionCheckpointIdentity[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--dry-run') {
      continue;
    }
    if (flag === '--apply') {
      apply = true;
      continue;
    }
    const value = args[index + 1];
    if (flag === '--data-root') {
      if (!value) throw new Error('Missing value for --data-root');
      dataRoot = value;
      index += 1;
      continue;
    }
    if (flag === '--backup-root') {
      if (!value) throw new Error('Missing value for --backup-root');
      backupRoot = value;
      index += 1;
      continue;
    }
    if (flag === '--checkpoint') {
      if (!value) throw new Error('Missing value for --checkpoint');
      checkpoints.push(parseCheckpointIdentity(value));
      index += 1;
      continue;
    }
    throw new Error(`Unknown cancelled-admission checkpoint cleanup flag: ${flag ?? ''}`);
  }
  if (!dataRoot) {
    throw new Error('Missing required cancelled-admission checkpoint cleanup flag: --data-root');
  }
  if (!backupRoot) {
    throw new Error('Missing required cancelled-admission checkpoint cleanup flag: --backup-root');
  }
  return { apply, backupRoot, checkpoints, dataRoot };
}

function parseCheckpointIdentity(value: string): CancelledAdmissionCheckpointIdentity {
  const parts = value.split(':');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error(
      'Checkpoint identity must be workspaceId:threadId:turnId with no empty component.'
    );
  }
  return { workspaceId: parts[0]!, threadId: parts[1]!, turnId: parts[2]! };
}

function blocked(
  checkpoints: readonly CancelledAdmissionCheckpointIdentity[],
  reason: string
): CancelledAdmissionCheckpointCleanupResult {
  return {
    applied: false,
    backupRoot: null,
    outcome: 'blocked',
    removedCount: 0,
    rows: checkpoints.map((identity) => ({ ...identity, decision: 'refused', reason })),
  };
}

function openSelectedWorkspace(
  workspaceDbs: Map<string, WorkspaceDb>,
  dataRoot: string,
  workspaceId: string
): WorkspaceDb | null {
  const existing = workspaceDbs.get(workspaceId);
  if (existing) return existing;
  if (!existsSync(join(dataRoot, 'workspaces', workspaceId, 'workspace-record.json'))) {
    return null;
  }
  const workspaceDb = openBootVerifiedWorkspaceDb(dataRoot, workspaceId);
  workspaceDbs.set(workspaceId, workspaceDb);
  return workspaceDb;
}

function classifyCheckpoint(input: {
  readonly checkpoint: CancelledAdmissionCheckpointIdentity;
  readonly coreDb: CoreDb;
  readonly dataRoot: string;
  readonly history: ReturnType<typeof readPublishedTurnIdentities>;
  readonly receipts: ReadableReceipts;
  readonly workspaceDb: WorkspaceDb | null;
}): Classification {
  if (input.history.status === 'unreadable') {
    return { decision: 'refused', reason: 'unreadable-history' };
  }
  const owner = readWorkspaceThreadOwner(input.dataRoot, input.checkpoint);
  if (owner !== 'ok') {
    return { decision: 'refused', reason: owner };
  }
  if (!input.workspaceDb) {
    return { decision: 'refused', reason: 'invalid-ownership' };
  }
  const checkpoint = getWorkerCheckpoint(
    input.workspaceDb,
    input.checkpoint.workspaceId,
    input.checkpoint.threadId,
    input.checkpoint.turnId
  );
  if (!checkpoint) {
    return { decision: 'absent', reason: 'absent' };
  }
  const shape = classifyShape(checkpoint);
  if (shape) return shape;
  const turn = classifyTurnAbsence(input.history.turns, input.checkpoint);
  if (turn) return turn;
  const leases = listLeasesForTurn(input.coreDb, checkpoint.turnId);
  if (leases === 'unreadable') {
    return { decision: 'refused', reason: 'unreadable-history' };
  }
  if (leases.some((lease) => !isTerminalLeaseStatus(lease.status))) {
    return { decision: 'refused', reason: 'live-lease' };
  }
  if (leases.length > 1) {
    return { decision: 'refused', reason: 'multiple-leases' };
  }
  if (leases.some((lease) => !leaseMatches(lease, checkpoint))) {
    return { decision: 'refused', reason: 'missing-provenance' };
  }
  const evidence = classifyExecutionEvidence({
    checkpoint,
    coreDb: input.coreDb,
    dataRoot: input.dataRoot,
    lease: leases[0],
    receipts: input.receipts,
    workspaceDb: input.workspaceDb,
  });
  if (evidence) return evidence;
  return classifyProof(input.coreDb, checkpoint, leases[0]);
}

function classifyShape(checkpoint: WorkerCheckpointRecord): Classification | null {
  if (checkpoint.goalId !== null || checkpoint.taskId !== null) {
    return { decision: 'refused', reason: 'goal-ownership' };
  }
  if (!isTerminalWorkerTurnStage(checkpoint.stage)) {
    return { decision: 'refused', reason: 'nonterminal-checkpoint' };
  }
  if (checkpoint.stage !== 'failed' || checkpoint.stopReason !== 'error') {
    return { decision: 'refused', reason: 'missing-provenance' };
  }
  if (checkpoint.workerSessionId !== null) {
    return { decision: 'refused', reason: 'non-null-session' };
  }
  if (checkpoint.iteration !== 0) {
    return { decision: 'refused', reason: 'missing-provenance' };
  }
  const diagnostics = classifyDiagnostics(checkpoint.diagnosticsSummary);
  if (diagnostics === 'unreadable') {
    return { decision: 'refused', reason: 'unreadable-history' };
  }
  if (checkpoint.contextDigest !== null || diagnostics === 'evidence') {
    return { decision: 'refused', reason: 'runtime-evidence' };
  }
  return null;
}

function classifyTurnAbsence(
  turns: readonly PublishedTurnIdentity[],
  identity: CancelledAdmissionCheckpointIdentity
): Classification | null {
  const verdict = turnFileVerdict(
    turns.filter((hit) => hit.turnId === identity.turnId),
    identity
  );
  if (verdict === 'unreadable') {
    return { decision: 'refused', reason: 'unreadable-history' };
  }
  if (verdict === 'mismatched') {
    return { decision: 'refused', reason: 'mismatched-turn-lineage' };
  }
  if (verdict === 'present') {
    return { decision: 'refused', reason: 'missing-provenance' };
  }
  return null;
}

function turnFileVerdict(
  matches: readonly PublishedTurnIdentity[],
  identity: CancelledAdmissionCheckpointIdentity
): 'absent' | 'present' | 'mismatched' | 'unreadable' {
  if (matches.length === 0) return 'absent';
  if (matches.length !== 1) return 'unreadable';
  const hit = matches[0]!;
  return hit.workspaceId === identity.workspaceId && hit.threadId === identity.threadId
    ? 'present'
    : 'mismatched';
}

function classifyExecutionEvidence(input: {
  readonly checkpoint: WorkerCheckpointRecord;
  readonly coreDb: CoreDb;
  readonly dataRoot: string;
  readonly lease: SchedulerSessionLeaseRecord | undefined;
  readonly receipts: ReadableReceipts;
  readonly workspaceDb: WorkspaceDb;
}): Classification | null {
  const { checkpoint, coreDb, dataRoot, lease, receipts, workspaceDb } = input;
  try {
    const execution = coreDb.sqlite
      .prepare(
        `SELECT 1 AS found FROM worker_control_records
           WHERE turn_id = @turn OR (@session IS NOT NULL AND agent_session_id = @session)
         UNION ALL SELECT 1 FROM worker_control_commands
           WHERE turn_id = @turn OR (@session IS NOT NULL AND agent_session_id = @session)
         UNION ALL SELECT 1 FROM worker_control_rejected_evidence
           WHERE turn_id = @turn OR (@session IS NOT NULL AND agent_session_id = @session)
         UNION ALL SELECT 1 FROM worker_control_sequence_fingerprints
           WHERE turn_id = @turn OR (@session IS NOT NULL AND agent_session_id = @session)
         UNION ALL SELECT 1 FROM agent_session_runtime_bindings
           WHERE current_turn_id = @turn
              OR (@session IS NOT NULL AND agent_session_id = @session)
              OR (@lease IS NOT NULL AND current_lease_id = @lease)
         UNION ALL SELECT 1 FROM sandbox_runtime_records
           WHERE @binding IS NOT NULL AND sandbox_binding_ref = @binding
         LIMIT 1`
      )
      .get({
        binding: lease?.sandboxBindingRef ?? null,
        lease: lease?.leaseId ?? null,
        session: lease?.agentSessionId ?? null,
        turn: checkpoint.turnId,
      }) as { found: number } | undefined;
    const runtime = workspaceDb.sqlite
      .prepare(
        `SELECT 1 AS found FROM runtime_evidence WHERE turn_id = ?
         UNION ALL SELECT 1 FROM evidence_bundles WHERE turn_id = ?
         LIMIT 1`
      )
      .get(checkpoint.turnId, checkpoint.turnId) as { found: number } | undefined;
    const snapshots = listExportableAgentEnvironmentPackageSnapshots(
      workspaceDb,
      checkpoint.workspaceId
    );
    const packageHit = snapshots.some(
      (snapshot) =>
        snapshot.turnId === checkpoint.turnId ||
        (lease !== undefined && snapshot.agentSessionId === lease.agentSessionId)
    );
    const sessions = readPublishedAgentSessionIds(dataRoot, checkpoint.workspaceId);
    if (sessions.status === 'unreadable') {
      return { decision: 'refused', reason: 'unreadable-history' };
    }
    const sessionHit = lease !== undefined && sessions.sessionIds.includes(lease.agentSessionId);
    if (execution || runtime || packageHit || sessionHit) {
      return { decision: 'refused', reason: 'runtime-evidence' };
    }
  } catch {
    return { decision: 'refused', reason: 'unreadable-history' };
  }

  const receiptHit = receipts.some((record) => {
    const responseId = 'id' in record.response ? record.response.id : null;
    return record.requestId === checkpoint.requestId || responseId === checkpoint.turnId;
  });
  if (receiptHit) {
    return { decision: 'refused', reason: 'missing-provenance' };
  }
  return null;
}

function classifyProof(
  coreDb: CoreDb,
  checkpoint: WorkerCheckpointRecord,
  lease: SchedulerSessionLeaseRecord | undefined
): Classification {
  const admissions = listAdmissions(coreDb, checkpoint);
  const plans = listPlans(
    coreDb,
    checkpoint.turnId,
    admissions === 'unreadable' ? [] : admissions.map((admission) => admission.queueEntryId)
  );
  if (admissions === 'unreadable' || plans === 'unreadable') {
    return { decision: 'refused', reason: 'unreadable-history' };
  }
  if (!lease) {
    const admission = admissions.length === 1 ? admissions[0] : undefined;
    if (
      plans.length === 0 &&
      admission &&
      admission.status === 'cancelled' &&
      admission.requestId === checkpoint.requestId &&
      admission.workspaceId === checkpoint.workspaceId &&
      admission.threadId === checkpoint.threadId &&
      admission.turnId === checkpoint.turnId
    ) {
      return { decision: 'removable', reason: 'cancelled-admission' };
    }
    return { decision: 'refused', reason: 'missing-provenance' };
  }

  const anchor = readLeaseAnchor(coreDb, lease.leaseId);
  let admissionContext: ReturnType<typeof requireSchedulerSessionLeaseAdmissionContext> | null =
    null;
  try {
    admissionContext = requireSchedulerSessionLeaseAdmissionContext(coreDb, lease.leaseId);
  } catch {
    admissionContext = null;
  }
  const admission = admissions.length === 1 ? admissions[0] : undefined;
  const plan = plans.length === 1 ? plans[0] : undefined;
  if (
    lease.status === 'failed' &&
    lease.releaseReason === 'turn-start-failed' &&
    lease.recoveryState === 'needs-evidence' &&
    lease.lastAcceptedHeartbeatAt === null &&
    lease.lastWorkerSequence === null &&
    lease.renewalCount === 0 &&
    lease.workerProcessKeyHash === null &&
    lease.workerControlTokenHash === null &&
    lease.workerInferenceTokenHash === null &&
    lease.workerCapabilityTokenHash === null &&
    anchor === 'unanchored' &&
    admissionContext?.requestId === checkpoint.requestId &&
    admission?.status === 'admitted' &&
    admission.requestId === checkpoint.requestId &&
    admission.workspaceId === checkpoint.workspaceId &&
    admission.threadId === checkpoint.threadId &&
    admission.turnId === checkpoint.turnId &&
    plan !== undefined &&
    planMatchesLineage(plan, checkpoint, lease, admission)
  ) {
    return { decision: 'removable', reason: 'turn-start-failed' };
  }
  return { decision: 'refused', reason: 'missing-provenance' };
}

function listLeasesForTurn(
  coreDb: CoreDb,
  turnId: string
): readonly SchedulerSessionLeaseRecord[] | 'unreadable' {
  try {
    const rows = coreDb.sqlite
      .prepare(
        `SELECT DISTINCT workspace_id AS workspaceId, thread_id AS threadId
         FROM scheduler_session_leases WHERE turn_id = ?`
      )
      .all(turnId) as { readonly threadId: string; readonly workspaceId: string }[];
    const leases: SchedulerSessionLeaseRecord[] = [];
    for (const row of rows) {
      leases.push(
        ...listSchedulerSessionLeasesForTurn(coreDb, {
          threadId: row.threadId,
          turnId,
          workspaceId: row.workspaceId,
        })
      );
    }
    return leases;
  } catch {
    return 'unreadable';
  }
}

function leaseMatches(
  lease: SchedulerSessionLeaseRecord,
  checkpoint: WorkerCheckpointRecord
): boolean {
  return (
    lease.workspaceId === checkpoint.workspaceId &&
    lease.threadId === checkpoint.threadId &&
    lease.turnId === checkpoint.turnId
  );
}

function listAdmissions(
  coreDb: CoreDb,
  checkpoint: WorkerCheckpointRecord
):
  | readonly {
      readonly queueEntryId: string;
      readonly requestId: string | null;
      readonly status: string;
      readonly threadId: string;
      readonly turnId: string;
      readonly workspaceId: string;
    }[]
  | 'unreadable' {
  try {
    return coreDb.sqlite
      .prepare(
        `SELECT queue_entry_id AS queueEntryId, request_id AS requestId, status,
                workspace_id AS workspaceId, thread_id AS threadId, turn_id AS turnId
         FROM scheduler_admission_entries
         WHERE turn_id = ? OR request_id = ?
         ORDER BY queue_entry_id ASC`
      )
      .all(checkpoint.turnId, checkpoint.requestId) as {
      readonly queueEntryId: string;
      readonly requestId: string | null;
      readonly status: string;
      readonly threadId: string;
      readonly turnId: string;
      readonly workspaceId: string;
    }[];
  } catch {
    return 'unreadable';
  }
}

interface PlacementPlanLineage {
  readonly planId: string;
  readonly queueEntryId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly workspaceId: string;
}

function planMatchesLineage(
  plan: PlacementPlanLineage,
  checkpoint: WorkerCheckpointRecord,
  lease: SchedulerSessionLeaseRecord,
  admission: {
    readonly queueEntryId: string;
    readonly threadId: string;
    readonly turnId: string;
    readonly workspaceId: string;
  }
): boolean {
  return (
    plan.planId === lease.planId &&
    plan.queueEntryId === admission.queueEntryId &&
    plan.workspaceId === checkpoint.workspaceId &&
    plan.threadId === checkpoint.threadId &&
    plan.turnId === checkpoint.turnId &&
    plan.workspaceId === lease.workspaceId &&
    plan.threadId === lease.threadId &&
    plan.turnId === lease.turnId &&
    plan.workspaceId === admission.workspaceId &&
    plan.threadId === admission.threadId &&
    plan.turnId === admission.turnId
  );
}

function listPlans(
  coreDb: CoreDb,
  turnId: string,
  queueEntryIds: readonly string[]
): readonly PlacementPlanLineage[] | 'unreadable' {
  try {
    const queueClause =
      queueEntryIds.length === 0
        ? 'turn_id = ?'
        : `turn_id = ? OR queue_entry_id IN (${queueEntryIds.map(() => '?').join(', ')})`;
    return coreDb.sqlite
      .prepare(
        `SELECT plan_id AS planId, queue_entry_id AS queueEntryId,
                workspace_id AS workspaceId, thread_id AS threadId, turn_id AS turnId
         FROM scheduler_placement_plans WHERE ${queueClause}
         ORDER BY plan_id ASC`
      )
      .all(turnId, ...queueEntryIds) as PlacementPlanLineage[];
  } catch {
    return 'unreadable';
  }
}

function readLeaseAnchor(coreDb: CoreDb, leaseId: string): 'unanchored' | 'anchored' | null {
  const row = coreDb.sqlite
    .prepare(
      'SELECT backend_anchor_state AS state FROM scheduler_session_leases WHERE lease_id = ?'
    )
    .get(leaseId) as { readonly state: 'unanchored' | 'anchored' } | undefined;
  return row?.state ?? null;
}

function readWorkspaceThreadOwner(
  dataRoot: string,
  identity: CancelledAdmissionCheckpointIdentity
): 'ok' | 'invalid-ownership' | 'unreadable-history' {
  const workspacePath = join(dataRoot, 'workspaces', identity.workspaceId, 'workspace-record.json');
  const threadPath = join(
    dataRoot,
    'workspaces',
    identity.workspaceId,
    'threads',
    identity.threadId,
    'thread.json'
  );
  if (!existsSync(workspacePath) || !existsSync(threadPath)) {
    return 'invalid-ownership';
  }
  try {
    const workspace = JSON.parse(readFileSync(workspacePath, 'utf8')) as { readonly id?: unknown };
    const thread = JSON.parse(readFileSync(threadPath, 'utf8')) as {
      readonly id?: unknown;
      readonly workspaceId?: unknown;
    };
    if (
      workspace.id !== identity.workspaceId ||
      thread.id !== identity.threadId ||
      thread.workspaceId !== identity.workspaceId
    ) {
      return 'invalid-ownership';
    }
    return 'ok';
  } catch {
    return 'unreadable-history';
  }
}

function classifyDiagnostics(
  diagnosticsSummary: string | null
): 'none' | 'evidence' | 'unreadable' {
  if (diagnosticsSummary === null || diagnosticsSummary.trim() === '') return 'none';
  const looksStructured =
    diagnosticsSummary.trim().startsWith('{') || diagnosticsSummary.trim().startsWith('[');
  let parsed: unknown;
  try {
    parsed = JSON.parse(diagnosticsSummary);
  } catch {
    return looksStructured ? 'unreadable' : 'none';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return 'unreadable';
  }
  const record = parsed as Record<string, unknown>;
  if ('itemIds' in record && !Array.isArray(record.itemIds)) return 'unreadable';
  if ('artifactIds' in record && !Array.isArray(record.artifactIds)) return 'unreadable';
  if ('contextAssembly' in record) return 'evidence';
  const itemIds = record.itemIds;
  const artifactIds = record.artifactIds;
  if (
    (Array.isArray(itemIds) && itemIds.length > 0) ||
    (Array.isArray(artifactIds) && artifactIds.length > 0)
  ) {
    return 'evidence';
  }
  return 'none';
}

function checkpointKey(identity: CancelledAdmissionCheckpointIdentity): string {
  return `${identity.workspaceId}:${identity.threadId}:${identity.turnId}`;
}
