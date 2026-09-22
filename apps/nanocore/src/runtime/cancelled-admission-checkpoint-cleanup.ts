import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { acquireDataRootLock, type DataRootLock, DataRootLockError } from '../bootstrap/lock.js';
import { FsStore } from '../lib/store.js';
import {
  isTerminalLeaseStatus,
  listSchedulerSessionLeasesForTurn,
  requireSchedulerSessionLeaseAdmissionContext,
  type SchedulerSessionLeaseRecord,
} from '../scheduler-records.js';
import { type CoreDb, openCoreDb, openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { listExportableAgentEnvironmentPackageSnapshots } from './aep-snapshot-ledger.js';
import {
  getWorkerCheckpoint,
  parseWorkerCheckpointContextAssembly,
  type WorkerCheckpointRecord,
} from './worker-checkpoints.js';
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

interface TurnFileHit {
  readonly threadId: string;
  readonly turnId: string;
  readonly workspaceId: string;
}

type TurnHistory =
  | { readonly status: 'readable'; readonly hits: readonly TurnFileHit[] }
  | { readonly status: 'unreadable' };

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

  const coreDb = openCoreDb(dataRoot);
  const workspaceDbs = new Map<string, WorkspaceDb>();
  try {
    let store: FsStore;
    try {
      store = new FsStore({ dataRoot });
    } catch {
      return blocked(input.checkpoints, 'unreadable-history');
    }
    const history = readTurnHistory(dataRoot);
    if (history.status === 'unreadable') {
      return blocked(input.checkpoints, 'unreadable-history');
    }

    const classified = input.checkpoints.map((identity) => {
      const workspaceDb = openSelectedWorkspace(workspaceDbs, dataRoot, identity.workspaceId);
      const classification = classifyCheckpoint({
        checkpoint: identity,
        coreDb,
        dataRoot,
        history,
        store,
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
      const again = classifyCheckpoint({
        checkpoint: row,
        coreDb,
        dataRoot,
        history: readTurnHistory(dataRoot),
        store,
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
    coreDb.sqlite.close();
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
  const workspaceDb = openWorkspaceDb(dataRoot, workspaceId);
  workspaceDbs.set(workspaceId, workspaceDb);
  return workspaceDb;
}

function classifyCheckpoint(input: {
  readonly checkpoint: CancelledAdmissionCheckpointIdentity;
  readonly coreDb: CoreDb;
  readonly dataRoot: string;
  readonly history: TurnHistory;
  readonly store: FsStore;
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
  const turn = classifyTurnAbsence(input.store, input.history.hits, input.checkpoint);
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
  const evidence = classifyExecutionEvidence(
    input.coreDb,
    input.store,
    input.workspaceDb,
    checkpoint,
    leases[0]
  );
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
  if (
    checkpoint.contextDigest !== null ||
    parseWorkerCheckpointContextAssembly(checkpoint.diagnosticsSummary) ||
    hasEvidenceDiagnostics(checkpoint.diagnosticsSummary)
  ) {
    return { decision: 'refused', reason: 'runtime-evidence' };
  }
  return null;
}

function classifyTurnAbsence(
  store: FsStore,
  hits: readonly TurnFileHit[],
  identity: CancelledAdmissionCheckpointIdentity
): Classification | null {
  const matches = hits.filter((hit) => hit.turnId === identity.turnId);
  const fileVerdict = turnFileVerdict(matches, identity);
  let indexVerdict: 'absent' | 'present' | 'mismatched' | 'unreadable';
  try {
    const turn = store.getTurnById(identity.turnId);
    indexVerdict =
      turn.id === identity.turnId &&
      turn.workspaceId === identity.workspaceId &&
      turn.threadId === identity.threadId
        ? 'present'
        : 'mismatched';
  } catch (error) {
    indexVerdict =
      error instanceof Error && error.message === `Turn not found: ${identity.turnId}`
        ? 'absent'
        : 'unreadable';
  }
  if (
    fileVerdict === 'unreadable' ||
    indexVerdict === 'unreadable' ||
    fileVerdict !== indexVerdict
  ) {
    return {
      decision: 'refused',
      reason:
        fileVerdict === 'mismatched' || indexVerdict === 'mismatched'
          ? 'mismatched-turn-lineage'
          : 'unreadable-history',
    };
  }
  if (fileVerdict === 'mismatched') {
    return { decision: 'refused', reason: 'mismatched-turn-lineage' };
  }
  if (fileVerdict === 'present') {
    return { decision: 'refused', reason: 'missing-provenance' };
  }
  return null;
}

function turnFileVerdict(
  matches: readonly TurnFileHit[],
  identity: CancelledAdmissionCheckpointIdentity
): 'absent' | 'present' | 'mismatched' | 'unreadable' {
  if (matches.length === 0) return 'absent';
  if (matches.length !== 1) return 'unreadable';
  const hit = matches[0]!;
  return hit.workspaceId === identity.workspaceId && hit.threadId === identity.threadId
    ? 'present'
    : 'mismatched';
}

function classifyExecutionEvidence(
  coreDb: CoreDb,
  store: FsStore,
  workspaceDb: WorkspaceDb,
  checkpoint: WorkerCheckpointRecord,
  lease: SchedulerSessionLeaseRecord | undefined
): Classification | null {
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
    const sessionHit =
      lease !== undefined &&
      store
        .listWorkspaceAgentSessions(checkpoint.workspaceId)
        .some((session) => session.id === lease.agentSessionId);
    if (execution || runtime || packageHit || sessionHit) {
      return { decision: 'refused', reason: 'runtime-evidence' };
    }
  } catch {
    return { decision: 'refused', reason: 'unreadable-history' };
  }

  const receiptHit = store.listCommandRequests().some((record) => {
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
  const plans = listPlans(coreDb, checkpoint.turnId);
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
    plan?.planId === lease.planId &&
    plan.queueEntryId === admission.queueEntryId
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

function listPlans(
  coreDb: CoreDb,
  turnId: string
): readonly { readonly planId: string; readonly queueEntryId: string }[] | 'unreadable' {
  try {
    return coreDb.sqlite
      .prepare(
        `SELECT plan_id AS planId, queue_entry_id AS queueEntryId
         FROM scheduler_placement_plans WHERE turn_id = ?
         ORDER BY plan_id ASC`
      )
      .all(turnId) as { readonly planId: string; readonly queueEntryId: string }[];
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

function readTurnHistory(dataRoot: string): TurnHistory {
  const hits: TurnFileHit[] = [];
  const workspacesRoot = join(dataRoot, 'workspaces');
  const workspaces = listDirectories(workspacesRoot);
  if (workspaces === 'unreadable') return { status: 'unreadable' };
  for (const workspaceId of workspaces) {
    const threads = listDirectories(join(workspacesRoot, workspaceId, 'threads'));
    if (threads === 'unreadable') return { status: 'unreadable' };
    for (const threadId of threads) {
      const turnsRoot = join(workspacesRoot, workspaceId, 'threads', threadId, 'turns');
      const turns = listDirectories(turnsRoot);
      if (turns === 'unreadable') return { status: 'unreadable' };
      for (const turnId of turns) {
        const turnPath = join(turnsRoot, turnId, 'turn.json');
        if (!existsSync(turnPath)) return { status: 'unreadable' };
        try {
          const parsed = JSON.parse(readFileSync(turnPath, 'utf8')) as {
            readonly id?: unknown;
            readonly threadId?: unknown;
            readonly workspaceId?: unknown;
          };
          if (
            parsed.id !== turnId ||
            parsed.workspaceId !== workspaceId ||
            parsed.threadId !== threadId
          ) {
            return { status: 'unreadable' };
          }
        } catch {
          return { status: 'unreadable' };
        }
        hits.push({ threadId, turnId, workspaceId });
      }
    }
  }
  return { status: 'readable', hits };
}

function listDirectories(root: string): readonly string[] | 'unreadable' {
  if (!existsSync(root)) return [];
  try {
    const names: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) return 'unreadable';
      if (entry.isDirectory()) names.push(entry.name);
    }
    return names;
  } catch {
    return 'unreadable';
  }
}

function hasEvidenceDiagnostics(diagnosticsSummary: string | null): boolean {
  if (!diagnosticsSummary) return false;
  try {
    const parsed = JSON.parse(diagnosticsSummary) as {
      readonly artifactIds?: unknown;
      readonly itemIds?: unknown;
    };
    return (
      (Array.isArray(parsed.itemIds) && parsed.itemIds.length > 0) ||
      (Array.isArray(parsed.artifactIds) && parsed.artifactIds.length > 0)
    );
  } catch {
    return false;
  }
}

function checkpointKey(identity: CancelledAdmissionCheckpointIdentity): string {
  return `${identity.workspaceId}:${identity.threadId}:${identity.turnId}`;
}
