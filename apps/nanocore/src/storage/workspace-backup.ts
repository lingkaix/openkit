import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { Worker } from 'node:worker_threads';
import { createZstdCompress } from 'node:zlib';
import {
  LightAppAdmittedSchemaSchema,
  type WORKSPACE_SNAPSHOT_OPERATION_DEFINITIONS,
  type WorkspaceBlocker,
  WorkspaceBlockerSchema,
  type WorkspaceFreezeRefusal,
  WorkspaceSnapshotReportSchema,
} from '@openkit/app-api-schemas';
import {
  AgentSessionSchema,
  AgentSessionStatusSchema,
  allocateEntityId,
  isEntityId,
  readRetainedV1,
  SEALED_TURN_TERMINALS,
  TurnSchema,
  TurnStatusSchema,
} from '@openkit/protocol';
import {
  copyFileForCut,
  copyVerifiedFile as copyStorageFile,
  publishDurableFile,
} from '@openkit/storage';
import Database from 'better-sqlite3';
import {
  DeploymentAdminRequiredError,
  requireAdministratorOperation,
} from '../auth/operation-authorizer.js';
import { isThreadIdVisible } from '../auth/thread-visibility.js';
import { acquireDataRootLock, type DataRootLock, DataRootLockError } from '../bootstrap/lock.js';
import { isScopeAdmitted, scopeAdmissionFailures } from '../bootstrap/readiness.js';
import { listWorkspaceCapabilityCalls } from '../capability/usage-ledger.js';
import { readDefaultKnowledgeBaseId, readKnowledgeMounts } from '../config/knowledge-base.js';
import {
  collectionTableName,
  fieldColumnName,
  quoteIdent,
  sqliteTypeForField,
} from '../generative-kernel/native.js';
import {
  assertSnapshotIntegrity,
  readLightAppSnapshot,
  readLightAppSnapshots,
} from '../generative-kernel/snapshots.js';
import { readSourcePointers } from '../knowledge/source-pointers.js';
import type { FsStore } from '../lib/store.js';
import type { OperationInvocationDependencies } from '../operation-composition.js';
import { type AdmittedOperationContext, publicOperationActor } from '../operation-contract.js';
import { OperationError, projectOperationError } from '../operation-error.js';
import { requireSchedulerExecutionAttempt } from '../runtime/execution-attempt-records.js';
import { readExecutionJournalRoot } from '../runtime/execution-journal.js';
import { hasUnprovedNanoHostWorkspaceCleanup } from '../runtime/nanohost-attempt-records.js';
import { readPendingRequest } from '../runtime/pending-requests.js';
import { getWorkerBackendSession } from '../runtime/worker-backend-sessions.js';
import { getWorkerStorageBinding } from '../runtime/worker-storage-bindings.js';
import {
  listWorkspaceApplyPlans,
  StoredWorkspaceApplyPlanV1Schema,
} from '../runtime/workspace-apply-plans.js';
import { listWorkspaceApplyResults } from '../runtime/workspace-apply-results.js';
import { getWorkspaceSyncReview } from '../runtime/workspace-sync-records.js';
import { listWorkspaceDeletionHoldRecordIds } from '../workspace-deletion-evidence.js';
import {
  isTerminalWorkspaceDeletionRequest,
  listWorkspaceDeletionRequests,
} from '../workspace-deletion-request.js';
import type { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { assertAppDefinitionMatches } from './app-db.js';
import {
  FileAdmissionError,
  type FileStorageReservation,
  type FileWriteCapacity,
} from './artifacts/file-admission.js';
import {
  getWorkspaceProductReadHandle,
  openControlStoreProductReadHandle,
} from './control-store-products.js';
import { getControlStoreWorkerClient } from './control-store-worker-client.js';
import {
  DATA_ROOT_BACKUP_MANIFEST_FILE,
  inventoryRegularFiles,
  verifyDataRootBackupManifest,
} from './data-root-backup.js';
import type { CoreDb } from './db.js';
import { bindCoreSqlite, bindWorkspaceSqlite, openExistingCoreDbWithIntegrityCheck } from './db.js';
import { readDataRootLayoutMarker } from './fs-layout.js';
import {
  exportRecurringPortableHistory,
  RECURRING_PORTABLE_FEATURE,
  RECURRING_PORTABLE_PATHS,
  readRecurringPortableCoreCut,
  readRecurringPortableFiles,
  validateRecurringPortableHistory,
} from './recurring-portable-history.js';
import { RecurringOccurrenceSchema, readRecurringOccurrence } from './recurring-records.js';
import { assertWorkspaceArchiveFilePath, workspaceArchiveHeader } from './workspace-archive.js';
import type {
  SnapshotSource,
  WorkspaceBackupCoverage,
  WorkspaceBackupManifest,
  WorkspaceBackupVerificationInput,
} from './workspace-backup-bundle.js';
import {
  assertWorkspaceBackupRequiredFeatures,
  parseWorkspaceBackupManifest,
  readWorkspaceSnapshotMetadata,
  WorkspaceBackupBundleError,
  withVerifiedWorkspaceBackupBundle,
  withVerifiedWorkspaceSnapshotSource,
} from './workspace-backup-bundle.js';
import { completeCapture, inspectCapture, protectCapture } from './workspace-capture-protection.js';
import {
  ensureCanonicalDirectory,
  loadWorkspaceFileRecords,
  publishCanonicalPath,
  syncCanonicalDirectory,
  syncCanonicalTree,
} from './workspace-file-records.js';
import {
  prepareRecoveryAdmission,
  type RecoveryAdmission,
  readRecoveryAdmission,
  recoveryReport,
  refuseRecovery as refuse,
} from './workspace-recovery-admissions.js';

/** Closed refusal codes shared by the offline Workspace commands. */
export type WorkspaceRecoveryErrorCode =
  | 'not-implemented'
  | 'invalid-arguments'
  | 'root-locked'
  | 'source-unavailable'
  | 'source-not-stopped'
  | 'parent-backup-invalid'
  | 'deployment-mismatch'
  | 'workspace-unavailable'
  | 'release-mismatch'
  | 'unsupported-format'
  | 'unsafe-path'
  | 'invalid-bundle'
  | 'invalid-database'
  | 'incomplete-closure'
  | 'capacity-exceeded'
  | 'candidate-conflict'
  | 'request-conflict'
  | 'workspace-moved-out'
  | 'safety-unproved'
  | 'mapping-refused'
  | 'identity-collision'
  | 'recovery-required';

/** Operator-safe refusal; messages must not include secrets or packaged content. */
export class WorkspaceRecoveryError extends Error {
  /** Creates a refusal with a stable code and an English operator message. */
  constructor(
    readonly code: WorkspaceRecoveryErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'WorkspaceRecoveryError';
  }
}

/** The backup-directory branch requires verification by the implementation, not the caller. */
export type WorkspaceBackupSource =
  | {
      readonly kind: 'live-workspace';
      readonly dataRoot: string;
      readonly coreDb: CoreDb;
      readonly store: FsStore;
      readonly mutationAdmission: WorkspaceMutationAdmission;
      readonly currentAuthority?: () => void;
      readonly canReadThread?: (threadId: string) => boolean;
    }
  | { readonly kind: 'stopped-data-root'; readonly dataRoot: string }
  | { readonly kind: 'data-root-backup'; readonly backupRoot: string };

/** Retains the parent backup's actual guarantee, including crash-consistent hot capture. */
export type WorkspaceBackupSourceReport =
  | { readonly kind: 'live-workspace' }
  | { readonly kind: 'stopped-data-root' }
  | {
      readonly kind: 'data-root-backup';
      readonly dataRootBackupId: string;
      readonly consistency: 'clean' | 'crash-consistent';
    };

/** Path-free capture facts; physical consistency never proves external effect completion. */
export interface WorkspaceBackupReport {
  readonly backupId: string;
  readonly workspaceId: string;
  readonly sourceDeploymentId: string;
  readonly knowledgeBaseIds: readonly string[];
  readonly capturedRevision: number;
  readonly manifestDigest: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly coverage: WorkspaceBackupCoverage;
  /** Present on capture; a standalone bundle need not retain its parent-directory provenance. */
  readonly source?: WorkspaceBackupSourceReport;
  readonly interruptedTurnIds: readonly string[];
  readonly unknownEffectTurnIds: readonly string[];
}

/**
 * Reads authoritative target obstruction without writes, asynchronous work or private-count disclosure.
 * Existing deletion consults only capture protection here; its owner retains other deletion decisions.
 */
export function readBlockers(input: {
  readonly coreDb: CoreDb;
  readonly store: FsStore;
  readonly workspaceId: string;
  readonly operation?: WorkspaceFreezeRefusal['operation'];
  readonly canReadThread?: (threadId: string) => boolean;
}): readonly WorkspaceBlocker[] {
  try {
    input.store.getWorkspace(input.workspaceId);
  } catch {
    return [{ kind: 'unavailable', reason: 'unavailable', actions: [] }];
  }
  return readWorkspaceBlockerFacts(input);
}

/** Reads the same obstruction facts for an exact selected recovery, without granting serving admission. */
export function readWorkspaceRecoveryBlockers(
  input: Parameters<typeof readBlockers>[0],
  selected: RecoveryAdmission
): readonly WorkspaceBlocker[] {
  const current = readRecoveryAdmission(input.coreDb, selected.admission_id);
  const refusal = scopeAdmissionFailures(input.coreDb.dataRoot).find(
    (failure) =>
      failure.scope === 'workspace' && failure.id === input.workspaceId && failure.check !== 'index'
  );
  if (
    selected.workspace_id !== input.workspaceId ||
    !isDeepStrictEqual(current, selected) ||
    refusal?.check !== 'recovery'
  )
    return [{ kind: 'unavailable', reason: 'unavailable', actions: [] }];
  return readWorkspaceBlockerFacts(input, selected);
}

/** One authoritative census serves ordinary and exact-recovery lifecycle inspection. */
function readWorkspaceBlockerFacts(
  input: Parameters<typeof readBlockers>[0],
  selected?: RecoveryAdmission
): readonly WorkspaceBlocker[] {
  const blockers: WorkspaceBlocker[] = [];
  let unavailable = false;
  const add = (blocker: WorkspaceBlocker, threadId?: string) => {
    if (threadId && input.canReadThread && !input.canReadThread(threadId)) unavailable = true;
    else blockers.push(WorkspaceBlockerSchema.parse(blocker));
  };
  try {
    const { coreDb, workspaceId } = input;
    if (!isEntityId('ws', workspaceId)) throw new Error('Invalid Workspace scope.');
    const reader = getWorkspaceProductReadHandle(
      join(coreDb.dataRoot, 'workspaces', workspaceId, 'db/workspace.sqlite'),
      { kind: 'workspace', workspaceId }
    );
    const db = reader.sqlite;
    const targetDb = bindWorkspaceSqlite(db, coreDb.dataRoot, workspaceId);
    const ids = (sql: string): string[] => db.prepare(sql).pluck().all(workspaceId) as string[];
    const coreIds = (sql: string): string[] =>
      coreDb.sqlite.prepare(sql).pluck().all(workspaceId) as string[];
    const addCaptureBlockers = () => {
      for (const id of ids(
        "SELECT capture_id FROM workspace_capture_records WHERE workspace_id=? AND state NOT IN ('finished','abandoned')"
      )) {
        const capture = inspectCapture(targetDb, workspaceId, id);
        if (!capture) throw new Error('Missing capture authority.');
        if (capture.state === 'active')
          add({
            kind: 'snapshot',
            reason: 'pending-publication',
            reference: { backupId: id },
            actions: [],
          });
      }
    };
    if (input.operation === 'delete') {
      addCaptureBlockers();
      return blockers;
    }
    if (
      listWorkspaceDeletionRequests(coreDb.dataRoot, workspaceId).some(
        (request) => !isTerminalWorkspaceDeletionRequest(request)
      )
    )
      add({
        kind: 'publication',
        reason: 'pending-publication',
        reference: { workspaceId },
        actions: [],
      });
    const turnActions = (threadId: string, turnId: string): WorkspaceBlocker['actions'] => [
      {
        operationId: 'turn.interrupt',
        input: { workspaceId, threadId, turnId, requestId: randomUUID() },
      },
    ];
    // Sealed history is validated off Main against the private cut. Admission reads
    // active candidates through the existing partial index and addresses only dependencies.
    const turns = new Map<string, ReturnType<typeof TurnSchema.parse> | undefined>();
    const turn = (id: string) => {
      if (!turns.has(id)) {
        const row = reader.get('turn', id);
        turns.set(id, row ? TurnSchema.parse({ ...row.record, items: [] }) : undefined);
      }
      return turns.get(id);
    };
    // Unknown headers cannot prove inactivity. These scalar scans deliberately
    // do not decode sealed history; their retained-header cost remains observable.
    if (
      db
        .prepare(
          `SELECT 1 FROM control_turns WHERE status NOT IN (${TurnStatusSchema.options.map(() => '?').join(',')}) LIMIT 1`
        )
        .get(...TurnStatusSchema.options) ||
      db
        .prepare(
          `SELECT 1 FROM control_agent_sessions WHERE workspace_id=? AND status NOT IN (${AgentSessionStatusSchema.options.map(() => '?').join(',')}) LIMIT 1`
        )
        .get(workspaceId, ...AgentSessionStatusSchema.options) ||
      db
        .prepare(
          // These closed scalar sets are owned by runtime/pending-requests.ts.
          `SELECT 1 FROM pending_requests WHERE workspace_id=? AND
          (claim NOT IN ('unclaimed','claimed','finished') OR state NOT IN ('pending','resolved','ended')
          OR disposition NOT IN ('approved-executed','denied-not-executed','execution-error','outcome-unknown')) LIMIT 1`
        )
        .get(workspaceId) ||
      db
        .prepare(
          `SELECT 1 FROM workspace_apply_plans WHERE workspace_id=? AND approval_state NOT IN (${StoredWorkspaceApplyPlanV1Schema.shape.approvalState.options.map(() => '?').join(',')}) LIMIT 1`
        )
        .get(workspaceId, ...StoredWorkspaceApplyPlanV1Schema.shape.approvalState.options)
    )
      throw new Error('Unsupported current Workspace state.');
    for (const id of db
      .prepare("SELECT id FROM control_turns WHERE status IN ('pending','running')")
      .pluck()
      .all() as string[]) {
      const candidate = turn(id);
      if (!candidate) throw new Error('Missing active Turn authority.');
      add(
        {
          kind: 'turn',
          reason: 'active-work',
          reference: { threadId: candidate.threadId, turnId: candidate.id },
          actions: turnActions(candidate.threadId, candidate.id),
        },
        candidate.threadId
      );
    }
    for (const id of coreIds(
      `SELECT attempt_id FROM scheduler_execution_attempts a WHERE workspace_id=? AND (phase<>'closed' OR EXISTS (SELECT 1 FROM worker_backend_sessions b WHERE b.attempt_id=a.attempt_id AND (b.state<>'cleaned' OR b.physical_cleaned_at IS NULL)))`
    )) {
      const attempt = requireSchedulerExecutionAttempt(coreDb, id);
      const session = getWorkerBackendSession(coreDb, id);
      if (
        attempt.phase !== 'closed' ||
        (session && (session.state !== 'cleaned' || session.physicalCleanedAt === null))
      )
        add(
          {
            kind: 'worker-attempt',
            reason: attempt.phase === 'closed' ? 'cleanup-unproved' : 'active-work',
            reference: {
              attemptId: id,
              threadId: attempt.threadId,
              turnId: attempt.turnId,
              agentSessionId: attempt.agentSessionId,
            },
            actions:
              attempt.phase !== 'closed' &&
              turn(attempt.turnId) &&
              !SEALED_TURN_TERMINALS[turn(attempt.turnId)!.status]
                ? turnActions(attempt.threadId, attempt.turnId)
                : [{ operationId: 'administration.cleanup-read', input: {} }],
          },
          attempt.threadId
        );
    }
    if (
      hasUnprovedNanoHostWorkspaceCleanup(coreDb, workspaceId) &&
      !blockers.some((b) => b.kind === 'worker-attempt')
    )
      unavailable = true;
    for (const id of coreIds(
      "SELECT attempt_id FROM worker_backend_sessions WHERE workspace_id=? AND (state<>'cleaned' OR physical_cleaned_at IS NULL)"
    )) {
      const session = getWorkerBackendSession(coreDb, id);
      if (!session) throw new Error('Missing physical session authority.');
      if (session.state !== 'cleaned' || session.physicalCleanedAt === null)
        add(
          {
            kind: 'worker-residency',
            reason: 'cleanup-unproved',
            reference: { agentSessionId: session.agentSessionId },
            actions: [{ operationId: 'administration.cleanup-read', input: {} }],
          },
          session.threadId ?? undefined
        );
    }
    for (const id of db
      .prepare(
        "SELECT id FROM control_agent_sessions WHERE workspace_id=? AND status IN ('created','initializing','busy')"
      )
      .pluck()
      .all(workspaceId) as string[]) {
      const row = reader.get('agent-session', id);
      if (!row) throw new Error('Missing AgentSession authority.');
      const session = AgentSessionSchema.parse(row.record);
      if (['created', 'initializing', 'busy'].includes(session.status))
        add(
          {
            kind: 'worker-residency',
            reason: 'active-work',
            reference: { agentSessionId: session.id },
            actions: [{ operationId: 'administration.cleanup-read', input: {} }],
          },
          session.threadId ?? undefined
        );
    }
    for (const id of coreIds(
      input.operation === undefined || input.operation === 'capture'
        ? "SELECT storage_ref FROM worker_storage_bindings WHERE workspace_id=? AND state NOT IN ('idle','purged')"
        : "SELECT storage_ref FROM worker_storage_bindings WHERE workspace_id=? AND state<>'purged'"
    )) {
      const binding = getWorkerStorageBinding(coreDb, { storageRef: id });
      if (!binding) throw new Error('Missing storage authority.');
      if (
        !['idle', 'purged'].includes(binding.state) ||
        (input.operation !== undefined &&
          input.operation !== 'capture' &&
          binding.state !== 'purged')
      )
        add(
          {
            kind: 'worker-residency',
            reason: 'cleanup-unproved',
            reference: { storageRef: id },
            actions: [{ operationId: 'administration.cleanup-read', input: {} }],
          },
          binding.currentThreadId ?? undefined
        );
    }
    for (const row of coreDb.sqlite
      .prepare(
        'SELECT schema_version AS schemaVersion,agent_session_id AS id,thread_id AS threadId FROM agent_session_runtime_bindings WHERE workspace_id=?'
      )
      .all(workspaceId) as { schemaVersion: number; id: string; threadId: string }[]) {
      readRetainedV1(row, () => undefined);
      add(
        {
          kind: 'worker-residency',
          reason: 'cleanup-unproved',
          reference: { agentSessionId: row.id },
          actions: [{ operationId: 'administration.cleanup-read', input: {} }],
        },
        row.threadId
      );
    }
    for (const id of ids(
      "SELECT request_id FROM pending_requests WHERE workspace_id=? AND claim='claimed' AND disposition IS NULL"
    )) {
      const request = readPendingRequest(db, id);
      if (!request) throw new Error('Missing Pending authority.');
      if (request.claim === 'claimed' && request.disposition === null)
        add(
          {
            kind: 'pending-request',
            reason: 'unproved-effect',
            reference: { threadId: request.threadId, pendingRequestId: request.requestId },
            actions: [],
          },
          request.threadId
        );
    }
    const plans = db
      .prepare(`SELECT p.schema_version AS schemaVersion, p.payload_json
      FROM workspace_apply_plans p WHERE p.workspace_id=? AND p.approval_state='approved'
      AND NOT EXISTS (SELECT 1 FROM workspace_apply_results r WHERE r.workspace_id=p.workspace_id
        AND r.review_id=p.review_id AND r.change_set_id=p.change_set_id)`)
      .all(workspaceId) as { schemaVersion: unknown; payload_json: string }[];
    for (const row of plans) {
      const plan = readRetainedV1(row, () =>
        StoredWorkspaceApplyPlanV1Schema.parse(JSON.parse(row.payload_json))
      );
      let threadId: string | undefined;
      if (input.canReadThread) {
        const review = getWorkspaceSyncReview(targetDb, workspaceId, plan.reviewId);
        const artifact = review ? input.store.getArtifact(workspaceId, review.artifactId) : null;
        if (!artifact?.threadId) {
          unavailable = true;
          continue;
        }
        threadId = artifact.threadId;
      }
      add(
        {
          kind: 'synchronization',
          reason: 'unproved-effect',
          reference: { reviewId: plan.reviewId },
          actions: [
            { operationId: 'sync.review-read', input: { workspaceId, reviewId: plan.reviewId } },
          ],
        },
        threadId
      );
    }
    const inertOccurrenceStates = RecurringOccurrenceSchema.shape.state.options.filter(
      (state) => state !== 'recovery_required' && state !== 'admission-accepted'
    );
    for (const row of coreDb.sqlite
      .prepare(
        `SELECT schema_version AS schemaVersion,state,record_json FROM recurring_occurrences WHERE workspace_id=? AND
        (state NOT IN (${inertOccurrenceStates.map(() => '?').join(',')}) OR NOT json_valid(record_json)
        OR json_extract(record_json,'$.state') IS NULL
        OR json_extract(record_json,'$.state') NOT IN (${inertOccurrenceStates.map(() => '?').join(',')}))`
      )
      .all(workspaceId, ...inertOccurrenceStates, ...inertOccurrenceStates) as {
      schemaVersion: number;
      state: string;
      record_json: string;
    }[]) {
      const occurrence = readRetainedV1(row, () => readRecurringOccurrence(row.record_json));
      if (row.state !== occurrence.state) throw new Error('Contradictory occurrence state.');
      if (
        occurrence.state === 'recovery_required' ||
        (occurrence.state === 'admission-accepted' &&
          (!occurrence.turnId || !turn(occurrence.turnId)))
      )
        add(
          {
            kind: 'recurring-occurrence',
            reason: 'unproved-effect',
            reference: { occurrenceId: occurrence.id },
            actions: [],
          },
          occurrence.snapshot.threadId
        );
    }
    addCaptureBlockers();
    for (const id of coreIds(
      "SELECT admission_id FROM workspace_recovery_admissions WHERE workspace_id=? AND state NOT IN ('finished','abandoned')"
    )) {
      const recovery = readRecoveryAdmission(coreDb, id);
      if (!recovery) throw new Error('Missing recovery authority.');
      if (selected && isDeepStrictEqual(recovery, selected)) continue;
      if (recovery.state === 'prepared')
        add({
          kind: 'snapshot',
          reason: 'pending-publication',
          reference: id.startsWith('wsbak_') ? { backupId: id } : { recoveryRequestId: id },
          actions: [],
        });
    }
    for (const id of db
      .prepare(
        "SELECT id FROM control_executions e WHERE phase<>'closed' OR EXISTS (SELECT 1 FROM control_execution_steps s WHERE s.execution_id=e.id AND s.state IN ('intent','unknown'))"
      )
      .pluck()
      .all() as string[]) {
      const execution = readExecutionJournalRoot(targetDb, {
        owner: { kind: 'workspace', workspaceId },
        executionId: id,
      });
      if (execution.phase !== 'closed' || execution.openSteps.length) {
        const dependency = turn(execution.workId);
        if (!dependency) unavailable = true;
        else
          add(
            {
              kind: 'publication',
              reason: 'pending-publication',
              reference: { workspaceId },
              actions: [],
            },
            dependency.threadId
          );
      }
    }
    // A running call can outlive its user-visible Turn; unknown historical rows need closed physical proof.
    for (const row of listWorkspaceCapabilityCalls(targetDb, workspaceId, 'unsettled')) {
      if (row.status !== 'running' && row.status !== 'unknown') continue;
      const dependency = row.turnId ? turn(row.turnId) : undefined;
      if (row.status === 'running' || !dependency || !SEALED_TURN_TERMINALS[dependency.status]) {
        if (!dependency) unavailable = true;
        else
          add(
            {
              kind: 'publication',
              reason: 'pending-publication',
              reference: { workspaceId },
              actions: [],
            },
            dependency.threadId
          );
      }
    }
  } catch {
    unavailable = true;
  }
  if (unavailable) blockers.push({ kind: 'unavailable', reason: 'unavailable', actions: [] });
  return blockers;
}

/** Trusted release/capacity policy plus a new or exactly owned output and stable wsbak identity. */
export interface WorkspaceBackupCreateInput extends WorkspaceBackupVerificationInput {
  readonly source: WorkspaceBackupSource;
  readonly workspaceId: string;
  readonly expectedSourceDeploymentId: string;
  readonly backupId: string;
  readonly purpose: 'backup' | 'move';
  /** Trusted maintenance provenance only; public capture operations omit this member. */
  readonly origin?: 'manual' | 'automatic';
}

/** MOVE preparation deliberately carries no transferable seal or moved-out authority. */
export type WorkspaceBackupCreateResult = Readonly<{
  bundleRoot: string;
  manifest: WorkspaceBackupManifest;
  report: WorkspaceBackupReport & { readonly source: WorkspaceBackupSourceReport };
}> &
  (
    | { readonly purpose: 'backup'; readonly disposition: 'sealed' }
    | { readonly purpose: 'move'; readonly disposition: 'prepared' }
  );

/** A request-owned, absent destination on the target filesystem; no registration is changed. */
export interface WorkspaceBackupStageInput extends WorkspaceBackupVerificationInput {
  /** Local pool resolution stays with the one bundle owner, before candidate admission. */
  readonly snapshotSource?: {
    readonly dataRoot: string;
    readonly source: SnapshotSource;
    /** Original-byte acquisition only; Main already holds admission for capture replay. */
    readonly acquireSource?: () => () => void;
  };
  readonly candidateRoot: string;
  readonly expectedWorkspaceId: string;
  readonly expectedSourceDeploymentId: string;
  readonly purpose: 'backup' | 'move';
}

/** Full graph verification of a private candidate, not target admission or safety approval. */
export interface WorkspaceBackupStageResult {
  readonly disposition: 'staged';
  readonly candidateRoot: string;
  readonly manifest: WorkspaceBackupManifest;
  readonly report: WorkspaceBackupReport;
}

/** Installed native formats; app keys also admit recognized immutable recovery versions. */
export const WORKSPACE_BACKUP_DATABASE_FORMATS: Readonly<Record<string, number>> = Object.freeze({
  'drizzle.workspace': 17,
  'drizzle.app.1': 1,
  'drizzle.app.2': 2,
  'drizzle.app.3': 3,
  'drizzle.app.4': 4,
  'drizzle.app.5': 5,
  'light-app.kernel.1': 1,
  'light-app.kernel.2': 2,
});
const recurringPaths = Object.values(RECURRING_PORTABLE_PATHS);
const omitted = new Set(['indexes', 'logs', 'projections']);
const roots = new Set([
  'db',
  'light-apps',
  'knowledge',
  'content',
  'files',
  'data',
  'sources',
  'threads',
  'artifacts',
  'reviews',
  'evidence',
  'config',
  'catalog',
  'runtime',
  'imports',
  'records',
]);

/** Installed offline verification policy shared by capture, CLI and MOVE. */
export const WORKSPACE_BACKUP_POLICY = {
  supportedRequiredFeatures: [RECURRING_PORTABLE_FEATURE],
  supportedDatabaseFormats: WORKSPACE_BACKUP_DATABASE_FORMATS,
};

/** Reads bounded selector metadata only; the staged verifier still decides authority and exact bytes. */
export function readWorkspaceBackupManifest(bundleRoot: string): WorkspaceBackupManifest {
  try {
    const metadata = join(bundleRoot, 'manifest.json');
    const stat = lstatSync(metadata);
    if (
      realpathSync(bundleRoot) !== resolve(bundleRoot) ||
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 16_777_216
    )
      throw new Error();
    return parseWorkspaceBackupManifest(JSON.parse(readFileSync(metadata, 'utf8')));
  } catch {
    return refuse('invalid-bundle');
  }
}

/** Maps bounded owner errors, keeping unknown storage failures local and content-free. */
function failure(error: unknown, fallback: WorkspaceRecoveryErrorCode): never {
  if (error instanceof WorkspaceRecoveryError) throw error;
  if (error instanceof WorkspaceBackupBundleError) refuse(error.code);
  if (error instanceof FileAdmissionError) refuse('capacity-exceeded');
  refuse(fallback);
}

/** Hashes exact bytes, including the original manifest and serialized inventory. */
function digest(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Refuses links at any existing path component before file or SQLite access. */
function realDirectory(path: string): string {
  const root = resolve(path);
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) refuse('unsafe-path');
  return root;
}

/** Enumerates regular canonical bytes only, with explicit omitted projections and no opaque database guesses. */
function files(root: string, metadata?: Map<string, { bytes: number; mode: number }>): string[] {
  realDirectory(root);
  const result: string[] = [];
  const device = lstatSync(root).dev;
  const walk = (path: string) => {
    for (const name of readdirSync(join(root, path)).sort()) {
      const p = path ? `${path}/${name}` : name;
      if (!path && omitted.has(name)) continue;
      if (!path && !roots.has(name)) refuse('incomplete-closure');
      if (p.startsWith('records/') && !recurringPaths.some((accepted) => accepted === p))
        refuse('incomplete-closure');
      try {
        assertWorkspaceArchiveFilePath(p);
      } catch {
        refuse('unsafe-path');
      }
      const stat = lstatSync(join(root, p));
      if (stat.isSymbolicLink() || stat.dev !== device) refuse('unsafe-path');
      if (stat.isDirectory()) walk(p);
      else {
        if (!stat.isFile() || stat.nlink !== 1) refuse('unsafe-path');
        // Opaque MCP state has no installed SQLite format owner, whatever its filename.
        if (p.startsWith('catalog/mcp-data/')) {
          const fd = openSync(join(root, p), constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const header = Buffer.alloc(16);
            if (
              readSync(fd, header, 0, 16, 0) === 16 &&
              header.equals(Buffer.from('SQLite format 3\0'))
            )
              refuse('unsupported-format');
          } finally {
            closeSync(fd);
          }
        }
        metadata?.set(p, { bytes: stat.size, mode: stat.mode & 0o777 });
        if (!/(?:-wal|-shm)$/.test(p)) result.push(p);
      }
      if (result.length > 200_000) refuse('capacity-exceeded');
    }
  };
  walk('');
  return result;
}

/** Copies or hashes exact retained bytes in bounded chunks through a no-follow source descriptor. */
function copyBytes(path: string, destination?: string, expectedDigest?: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let output: number | undefined;
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) refuse('unsafe-path');
    if (destination) output = openSync(destination, 'wx', Number(before.mode & 0o777n));
    const hash = createHash('sha256');
    const bytes = Buffer.alloc(65_536);
    let total = 0n;
    for (;;) {
      const count = readSync(fd, bytes, 0, bytes.length, null);
      if (!count) break;
      total += BigInt(count);
      if (total > before.size) refuse('incomplete-closure');
      hash.update(bytes.subarray(0, count));
      if (output !== undefined) {
        let written = 0;
        while (written < count) {
          const countWritten = writeSync(output, bytes, written, count - written);
          if (!countWritten) refuse('capacity-exceeded');
          written += countWritten;
        }
      }
    }
    const after = fstatSync(fd, { bigint: true });
    if (
      before.size !== total ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      refuse('incomplete-closure');
    const result = `sha256:${hash.digest('hex')}`;
    if (expectedDigest && result !== expectedDigest) refuse('parent-backup-invalid');
    if (destination) chmodSync(destination, Number(before.mode & 0o777n));
    return result;
  } finally {
    closeSync(fd);
    if (output !== undefined) closeSync(output);
  }
}

/** Existing-only and read-only: never migrates, repairs, recovers execution, or creates authority. */
function database(path: string): Database.Database {
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    db.pragma('query_only = ON');
    assertSnapshotIntegrity(db);
    return db;
  } catch {
    db?.close();
    refuse('invalid-database');
  }
}

/** Proves the complete one-based native journal prefix, including unknown/interior ledger rows. */
function nativePrefix(db: Database.Database, scope: 'workspace' | 'app'): number {
  const journal = JSON.parse(
    readFileSync(new URL(`../../drizzle/${scope}/meta/_journal.json`, import.meta.url), 'utf8')
  ) as { entries: { when: number }[] };
  const applied = db
    .prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at')
    .all() as { created_at: number }[];
  if (
    !applied.length ||
    applied.some((row, i) => Number(row.created_at) !== journal.entries[i]?.when)
  )
    refuse('unsupported-format');
  return applied.length;
}

/** Checks every captured database's actual schema/identity and saved app definitions, without upgrading it. */
function databaseFormats(dataRoot: string, workspaceId: string, root: string) {
  const formats: WorkspaceBackupManifest['databaseFormats'] = [];
  for (const path of files(root).filter((p) => p.endsWith('.sqlite'))) {
    const app = /^light-apps\/([^/]+)\/(data.sqlite|snapshots\/[^/]+.sqlite)$/.exec(path);
    if (path !== 'db/workspace.sqlite' && !app) refuse('unsupported-format');
    const db = database(join(root, path));
    try {
      const prefix = nativePrefix(db, app ? 'app' : 'workspace');
      if (!app) {
        if (prefix !== WORKSPACE_BACKUP_DATABASE_FORMATS['drizzle.workspace'])
          refuse('unsupported-format');
        formats.push({ path, markers: { 'drizzle.workspace': prefix } });
      } else {
        const snapshot = app[2] !== 'data.sqlite';
        const hasKernel = (db.pragma('table_info(app_metadata)') as { name: string }[]).some(
          (c) => c.name === 'kernel_format_version'
        );
        const row = db.prepare('SELECT * FROM app_metadata').get() as
          | Record<string, unknown>
          | undefined;
        const kernel = hasKernel ? Number(row?.kernel_format_version) : 1;
        if (row?.app_id !== app[1] || row?.workspace_id !== workspaceId) refuse('invalid-database');
        if ((!snapshot && (prefix !== 5 || kernel !== 2)) || prefix > 5 || ![1, 2].includes(kernel))
          refuse('unsupported-format');
        const schema = LightAppAdmittedSchemaSchema.parse(JSON.parse(String(row.schema_json)));
        if (
          schema.appId !== app[1] ||
          schema.schemaRevision !== row.schema_revision ||
          digest(String(row.schema_json)) !== row.schema_digest
        )
          refuse('invalid-database');
        // The native owner supplies names and types; no DDL, migration or replacement database runs.
        if (kernel === 2) {
          const tables = new Set([
            '__drizzle_migrations',
            'app_metadata',
            'idempotency_requests',
            'audit_events',
            ...schema.collections.map((c) => collectionTableName(c.id)),
          ]);
          const actual = db
            .prepare(
              "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )
            .pluck()
            .all() as string[];
          if (actual.length !== tables.size || actual.some((name) => !tables.has(name)))
            refuse('invalid-database');
          for (const collection of schema.collections) {
            const base: Record<string, string> = {
              id: 'TEXT',
              revision: 'INTEGER',
              created: 'TEXT',
              updated: 'TEXT',
              creator_json: 'TEXT',
              last_mutator_json: 'TEXT',
              create_request_id: 'TEXT',
              last_request_id: 'TEXT',
              write_schema_revision: 'INTEGER',
            };
            for (const field of collection.fields)
              base[fieldColumnName(field.id)] = sqliteTypeForField(field);
            const columns = db.pragma(
              `table_info(${quoteIdent(collectionTableName(collection.id))})`
            ) as { name: string; type: string }[];
            if (
              columns.length !== Object.keys(base).length ||
              columns.some((c) => base[c.name] !== c.type)
            )
              refuse('invalid-database');
          }
        }
        assertAppDefinitionMatches({
          scope: 'app',
          sqlite: db,
          dataRoot,
          workspaceId,
          appId: app[1]!,
        });
        if (snapshot) {
          const saved = readLightAppSnapshot(
            dataRoot,
            workspaceId,
            app[1]!,
            path.split('/').at(-1)!.slice(0, -7)
          );
          if (
            saved.metadata.kernelFormatVersion !== kernel ||
            saved.metadata.definitionVersion !== row.schema_digest ||
            saved.metadata.appRevision !== row.app_revision ||
            saved.metadata.schemaRevision !== row.schema_revision
          )
            refuse('invalid-database');
        }
        formats.push({
          path,
          markers: { [`drizzle.app.${prefix}`]: prefix, [`light-app.kernel.${kernel}`]: kernel },
        });
      }
    } catch (error) {
      failure(error, 'invalid-database');
    } finally {
      db.close();
    }
  }
  if (!formats.some((f) => f.path === 'db/workspace.sqlite')) refuse('incomplete-closure');
  // Metadata without its recovery bytes must not disappear from the closure.
  for (const appId of existsSync(join(root, 'light-apps'))
    ? readdirSync(join(root, 'light-apps'))
    : []) {
    if (!existsSync(join(root, 'light-apps', appId, 'data.sqlite'))) refuse('incomplete-closure');
    for (const saved of readLightAppSnapshots(dataRoot, workspaceId, appId))
      readLightAppSnapshot(dataRoot, workspaceId, appId, saved.snapshotId);
  }
  return formats;
}

/** Reuses canonical native, Artifact, Source and Notebook readers on an isolated Workspace placement. */
function graph(
  dataRoot: string,
  workspaceId: string,
  expectedRevision?: number,
  requiredFeatures?: readonly string[]
) {
  const root = join(dataRoot, 'workspaces', workspaceId);
  if (!existsSync(join(root, 'db/workspace.sqlite'))) refuse('incomplete-closure');
  const db = database(join(root, 'db/workspace.sqlite'));
  let capturedRevision: number;
  try {
    const reader = openControlStoreProductReadHandle(join(root, 'db/workspace.sqlite'), {
      kind: 'workspace',
      workspaceId,
    });
    try {
      const workspace = reader.get('workspace', workspaceId);
      if (!workspace || workspace.record.id !== workspaceId) refuse('invalid-database');
      if (
        workspace.record.status !== 'active' ||
        db
          .prepare(
            "SELECT json_extract(record_json, '$.movedOut') FROM control_workspaces WHERE id=?"
          )
          .pluck()
          .get(workspaceId)
      )
        refuse('workspace-moved-out');
      capturedRevision = workspace.revision;
      if (expectedRevision !== undefined && expectedRevision !== capturedRevision)
        refuse('invalid-database');
    } finally {
      reader.close();
    }
  } catch (error) {
    db.close();
    failure(error, 'invalid-database');
  }
  try {
    const formats = databaseFormats(dataRoot, workspaceId, root);
    const records = loadWorkspaceFileRecords(dataRoot, workspaceId)[0];
    if (!records) refuse('incomplete-closure');
    const references = {
      workspaceId,
      threadIds: new Set(records.threads.map((t) => t.id)),
      turns: new Map(records.turns.map((t) => [t.id, t.threadId])),
    };
    const inheritedPath = join(root, 'imports/recurrence-history.json');
    const inheritedRecurring = existsSync(inheritedPath)
      ? readFileSync(inheritedPath, 'utf8')
      : null;
    if (inheritedRecurring !== null) validateRecurringPortableHistory(inheritedRecurring);
    const portableFiles = new Map(
      recurringPaths
        .filter((path) => existsSync(join(root, path)))
        .map((path) => [path, readFileSync(join(root, path), 'utf8')])
    );
    if (portableFiles.size || requiredFeatures?.includes(RECURRING_PORTABLE_FEATURE)) {
      if (requiredFeatures && !requiredFeatures.includes(RECURRING_PORTABLE_FEATURE))
        refuse('unsupported-format');
      const history = readRecurringPortableFiles(portableFiles, references);
      validateRecurringPortableHistory(JSON.stringify(history));
    }

    const knowledgeBaseIds = [
      readDefaultKnowledgeBaseId({ dataRoot, scope: { kind: 'workspace', workspaceId } }),
    ];
    const mounts = readKnowledgeMounts({ dataRoot, scope: { kind: 'workspace', workspaceId } });
    const externalDependencies: WorkspaceBackupManifest['coverage']['externalDependencies'] = [];
    for (const pointer of readSourcePointers({
      dataRoot,
      ownerScope: { kind: 'workspace', workspaceId },
    }).values()) {
      const ref = pointer.fields.contentRef;
      const mount = mounts.find((m) => m.name === ref.locator.mount);
      if (ref.availability !== 'available' || !mount?.default) {
        externalDependencies.push({
          kind: 'external-source',
          reference: pointer.source.id,
          availability: 'unavailable',
        });
        continue;
      }
      if (mount.backend !== 'local' || mount.root !== 'raw') refuse('incomplete-closure');
      assertWorkspaceArchiveFilePath(ref.locator.path);
      const path = join(root, 'knowledge', 'raw', ref.locator.path);
      if (
        copyBytes(path) !== ref.contentDigest ||
        lstatSync(path).size !== pointer.fields.byteLength
      )
        refuse('incomplete-closure');
    }
    const privateAudienceRefs = [
      ...new Set(
        records.threads.flatMap((t) => (t.privateOwnerUserId ? [t.privateOwnerUserId] : []))
      ),
    ].sort();
    const unknownEffectTurnIds = (
      db
        .prepare(
          "SELECT DISTINCT e.work_id FROM control_executions e JOIN control_execution_steps s ON s.execution_id=e.id WHERE s.state IN ('intent','unknown') UNION SELECT turn_id AS work_id FROM capability_calls WHERE status IN ('running','unknown') AND turn_id IS NOT NULL"
        )
        .all() as { work_id: string }[]
    )
      .map((r) => r.work_id)
      .filter((id) => isEntityId('tu', id));
    const interruptedTurnIds = records.turns
      .filter((t) => !SEALED_TURN_TERMINALS[t.status])
      .map((t) => t.id);
    return {
      capturedRevision,
      references,
      inheritedRecurring,
      formats,
      knowledgeBaseIds,
      privateAudienceRefs,
      interruptedTurnIds,
      unknownEffectTurnIds,
      externalDependencies,
    };
  } catch (error) {
    failure(error, 'incomplete-closure');
  } finally {
    db.close();
  }
}

/** Removes only empty sidecars made by private read-only inspection, after every handle has closed. */
function closePrivateBytes(root: string): void {
  for (const path of files(root).filter((p) => p.endsWith('.sqlite'))) {
    const wal = `${join(root, path)}-wal`;
    if (existsSync(wal) && lstatSync(wal).size !== 0) refuse('invalid-database');
    rmSync(wal, { force: true });
    rmSync(`${join(root, path)}-shm`, { force: true });
  }
}

/** Recomputes parent inventory authority, in addition to the existing file-set and byte verifier. */
function parent(root: string) {
  try {
    realDirectory(root);
    const verified = verifyDataRootBackupManifest({ backupRoot: root });
    const inventory = inventoryRegularFiles(root).filter(
      (e) => e.path !== DATA_ROOT_BACKUP_MANIFEST_FILE
    );
    if (
      digest(JSON.stringify(inventory)) !== verified.manifest.contentDigest ||
      !isDeepStrictEqual(inventory, verified.manifest.contentInventory)
    )
      refuse('parent-backup-invalid');
    return {
      ...verified.manifest,
      metadataDigest: copyBytes(join(root, DATA_ROOT_BACKUP_MANIFEST_FILE)),
    };
  } catch {
    refuse('parent-backup-invalid');
  }
}

/** Validates inert retained history after the cut; it is not another live blocker census. */
function validateCaptureHistory(dataRoot: string, workspaceId: string, coreRoot?: string): void {
  // graph() already checked this private cut; no writes may intervene before this validator.
  const sqlite = new Database(join(dataRoot, 'workspaces', workspaceId, 'db/workspace.sqlite'), {
    readonly: true,
    fileMustExist: true,
  });
  const target = bindWorkspaceSqlite(sqlite, dataRoot, workspaceId);
  try {
    for (const id of sqlite
      .prepare('SELECT request_id FROM pending_requests WHERE workspace_id=?')
      .pluck()
      .all(workspaceId) as string[])
      readPendingRequest(sqlite, id);
    for (const id of sqlite
      .prepare('SELECT capture_id FROM workspace_capture_records WHERE workspace_id=?')
      .pluck()
      .all(workspaceId) as string[])
      inspectCapture(target, workspaceId, id);
    listWorkspaceApplyPlans(target, workspaceId);
    listWorkspaceApplyResults(target, workspaceId);
    listWorkspaceCapabilityCalls(target, workspaceId);
    for (const id of sqlite.prepare('SELECT id FROM control_executions').pluck().all() as string[])
      readExecutionJournalRoot(target, {
        owner: { kind: 'workspace', workspaceId },
        executionId: id,
      });
  } finally {
    sqlite.close();
  }
  if (!coreRoot) return;
  // These excluded Core families are checked for supported closed semantics only;
  // captured account/recurrence authority comes exclusively from the frozen raw cut.
  const coreSqlite = new Database(join(coreRoot, 'server/db/core.sqlite'), {
    readonly: true,
    fileMustExist: true,
  });
  const core = bindCoreSqlite(coreSqlite, coreRoot);
  try {
    for (const id of coreSqlite
      .prepare(
        "SELECT attempt_id FROM scheduler_execution_attempts WHERE workspace_id=? AND phase='closed'"
      )
      .pluck()
      .all(workspaceId) as string[])
      requireSchedulerExecutionAttempt(core, id);
    for (const id of coreSqlite
      .prepare(
        "SELECT attempt_id FROM worker_backend_sessions WHERE workspace_id=? AND state='cleaned' AND physical_cleaned_at IS NOT NULL"
      )
      .pluck()
      .all(workspaceId) as string[])
      getWorkerBackendSession(core, id);
    for (const id of coreSqlite
      .prepare(
        "SELECT storage_ref FROM worker_storage_bindings WHERE workspace_id=? AND state IN ('idle','purged')"
      )
      .pluck()
      .all(workspaceId) as string[])
      getWorkerStorageBinding(core, { storageRef: id });
    for (const id of coreSqlite
      .prepare(
        "SELECT admission_id FROM workspace_recovery_admissions WHERE workspace_id=? AND state<>'prepared'"
      )
      .pluck()
      .all(workspaceId) as string[])
      readRecoveryAdmission(core, id);
  } finally {
    coreSqlite.close();
  }
}

/** Opens the existing capture-record owner without migrating or initializing authority. */
function captureDatabase(dataRoot: string, workspaceId: string) {
  const sqlite = new Database(join(dataRoot, 'workspaces', workspaceId, 'db/workspace.sqlite'), {
    fileMustExist: true,
  });
  sqlite.pragma('synchronous = FULL');
  sqlite.pragma('busy_timeout = 5');
  return bindWorkspaceSqlite(sqlite, dataRoot, workspaceId);
}

/** Creates the existing directory placement needed by read-only domain owners; it is never booted. */
function privateRoot(stagingParent: string, workspaceId: string) {
  realDirectory(stagingParent);
  const container = mkdtempSync(join(stagingParent, 'workspace-capture-'));
  const workspaceRoot = join(container, 'workspaces', workspaceId);
  mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
  return { container, workspaceRoot };
}

/** Projects only known, path-free capture facts. */
function report(
  manifest: WorkspaceBackupManifest,
  manifestDigest: string,
  facts: Pick<ReturnType<typeof graph>, 'interruptedTurnIds' | 'unknownEffectTurnIds'>
): WorkspaceBackupReport {
  return {
    backupId: manifest.backupId,
    workspaceId: manifest.workspaceId,
    sourceDeploymentId: manifest.sourceDeploymentId,
    knowledgeBaseIds: manifest.knowledgeBaseIds,
    capturedRevision: manifest.capturedRevision,
    manifestDigest,
    fileCount: manifest.inventory.length,
    totalBytes: manifest.inventory.reduce((n, e) => n + e.bytes, 0),
    coverage: manifest.coverage,
    interruptedTurnIds: facts.interruptedTurnIds,
    unknownEffectTurnIds: facts.unknownEffectTurnIds,
  };
}

/** Finite observations/barriers of the existing capture request, not a retained phase ledger. */
export type WorkspaceCapturePhase =
  | 'preflight'
  | 'freeze'
  | 'drain'
  | 'pin'
  | 'pin-end'
  | 'core-pin'
  | 'enumeration'
  | 'mutable-copy'
  | 'db-backup'
  | 'cut'
  | 'post-cut-validation'
  | 'pool'
  | 'authority'
  | 'finish'
  | 'cleanup'
  | 'cleanup-end';
/** Closed, request-private worker control; it carries no product body or authorization grant. */
export type WorkspaceCaptureControl =
  | { kind: 'candidate'; workspaceId: string }
  | { kind: 'phase'; phase: WorkspaceCapturePhase; at: number }
  | { kind: 'capacity'; action: 'reserve'; writes: FileWriteCapacity }
  | {
      kind: 'capacity';
      action: 'assert' | 'release' | 'reduce' | 'written';
      reservation: number;
      bytes?: number | bigint;
    };
/** Paths and existing capture arguments only; live authority and byte admission stay on Main. */
export type WorkspaceCaptureWorkerInput = Omit<
  WorkspaceBackupCreateInput,
  'source' | 'admission'
> & { dataRoot: string };
type CaptureInput = Omit<WorkspaceBackupCreateInput, 'source'> & {
  source:
    | Exclude<WorkspaceBackupSource, { kind: 'live-workspace' }>
    | { kind: 'live-workspace'; dataRoot: string };
};
let captureWorkerActive = false;

/** Enumerates sealed generation metadata only; attempts and mutable filesystem times spend no UTC day. */
async function snapshotGenerations(
  dataRoot: string,
  workspaceId: string,
  policy: Pick<WorkspaceBackupVerificationInput, 'supportedRequiredFeatures'>
) {
  const pool = join(dataRoot, 'server/backups/workspaces', workspaceId);
  const found: Awaited<ReturnType<typeof readWorkspaceSnapshotMetadata>>[] = [];
  if (!lstatSync(pool, { throwIfNoEntry: false })) return found;
  realDirectory(pool);
  for (const id of readdirSync(pool).sort()) {
    if (!isEntityId('wsbak', id)) continue;
    const generation = join(pool, id);
    realDirectory(generation);
    if (!lstatSync(join(generation, 'seal.json'), { throwIfNoEntry: false })) continue;
    found.push(
      await readWorkspaceSnapshotMetadata({ ...policy, dataRoot, workspaceId, backupId: id })
    );
  }
  return found;
}

/** Retires only automatic successes under the caller's existing target freeze, then collects unreachable pool bytes. */
async function retainWorkspaceSnapshots(input: WorkspaceCaptureWorkerInput): Promise<void> {
  const { dataRoot, workspaceId } = input;
  const pool = realDirectory(join(dataRoot, 'server/backups/workspaces', workspaceId));
  const generations = await snapshotGenerations(dataRoot, workspaceId, input);
  const reader = openControlStoreProductReadHandle(
    join(dataRoot, 'workspaces', workspaceId, 'db/workspace.sqlite'),
    { kind: 'workspace', workspaceId }
  );
  const automatic = new Set<string>();
  try {
    const db = bindWorkspaceSqlite(reader.sqlite, dataRoot, workspaceId);
    // Workspace evidence holds are broader than a generation selector; preserve all of them.
    if (listWorkspaceDeletionHoldRecordIds(db, workspaceId).length) return;
    for (const id of reader.sqlite
      .prepare('SELECT capture_id FROM workspace_capture_records WHERE workspace_id=?')
      .pluck()
      .all(workspaceId) as string[]) {
      const capture = inspectCapture(db, workspaceId, id);
      if (!capture || capture.state === 'active') refuse('recovery-required');
      if (capture.origin === 'automatic' && capture.state === 'finished') automatic.add(id);
    }
  } finally {
    reader.close();
  }
  const protectedIds = new Set<string>();
  const protectedInventories: WorkspaceBackupManifest['inventory'][] = [];
  const coreReader = openControlStoreProductReadHandle(join(dataRoot, 'server/db/core.sqlite'), {
    kind: 'server',
  });
  try {
    const core = bindCoreSqlite(coreReader.sqlite, dataRoot);
    for (const row of coreReader.sqlite
      .prepare(
        'SELECT admission_id, proof_json FROM workspace_recovery_admissions WHERE workspace_id=?'
      )
      .all(workspaceId) as { admission_id: string; proof_json: string }[]) {
      // Check required semantics on original proof content before its owner strips descriptive fields.
      assertWorkspaceBackupRequiredFeatures(
        JSON.parse(row.proof_json),
        new Set(input.supportedRequiredFeatures ?? [])
      );
      const recovery = readRecoveryAdmission(core, row.admission_id);
      if (!recovery) refuse('recovery-required');
      protectedIds.add(recovery.backup_id);
      protectedInventories.push(recovery.proof.manifest.inventory);
    }
  } finally {
    coreReader.close();
  }
  const known = new Set<string>(generations.map((entry) => entry.manifest.backupId));
  // Incomplete or unknown generations may still own bytes. Do not guess their inventory or retire them.
  if (readdirSync(pool).some((id) => id !== 'objects' && !known.has(id))) return;
  const expired = generations
    .filter(
      (entry) => entry.manifest.purpose === 'backup' && automatic.has(entry.manifest.backupId)
    )
    .sort((a, b) =>
      b.manifest.capture.completedAt < a.manifest.capture.completedAt
        ? -1
        : b.manifest.capture.completedAt > a.manifest.capture.completedAt
          ? 1
          : a.manifest.backupId < b.manifest.backupId
            ? -1
            : 1
    )
    .slice(7)
    .filter((entry) => !protectedIds.has(entry.manifest.backupId));
  const retired = new Set(expired.map((entry) => entry.manifest.backupId));
  const references = new Map<string, number>();
  for (const inventory of [
    ...generations.map((entry) => entry.manifest.inventory),
    ...protectedInventories,
  ]) {
    for (const entry of inventory) {
      const previous = references.get(entry.sha256);
      if (previous !== undefined && previous !== entry.bytes) refuse('invalid-bundle');
      references.set(entry.sha256, entry.bytes);
    }
  }
  const objects = realDirectory(join(pool, 'objects'));
  const names = readdirSync(objects);
  const sizes = new Map<string, number>();
  // Complete the protection and object census before retiring any exposure.
  for (const name of names) {
    const stat = lstatSync(join(objects, name));
    if (!/^[0-9a-f]{64}$/.test(name) || !stat.isFile() || stat.nlink !== 1) refuse('unsafe-path');
    sizes.set(`sha256:${name}`, stat.size);
  }
  for (const [sha256, bytes] of references)
    if (sizes.get(sha256) !== bytes) refuse('invalid-bundle');
  const keep = new Set(
    [
      ...generations
        .filter((entry) => !retired.has(entry.manifest.backupId))
        .map((entry) => entry.manifest.inventory),
      ...protectedInventories,
    ].flatMap((inventory) => inventory.map((entry) => entry.sha256))
  );
  for (const entry of expired) {
    const generation = join(pool, entry.manifest.backupId);
    rmSync(join(generation, 'seal.json'));
    syncCanonicalDirectory(generation);
    rmSync(generation, { recursive: true });
  }
  if (expired.length) syncCanonicalDirectory(pool);
  for (const name of names) if (!keep.has(`sha256:${name}`)) rmSync(join(objects, name));
  syncCanonicalDirectory(objects);
}

/** Runs the same capture owner on the private thread, delegating only current authority/admission to Main. */
export async function runWorkspaceCaptureWorker(
  input: WorkspaceCaptureWorkerInput,
  control: (request: WorkspaceCaptureControl) => number | undefined,
  automatic?: { readonly day: string; readonly workspaceIds: readonly string[] }
) {
  let selected = input;
  if (automatic) {
    let found = false;
    for (const workspaceId of automatic.workspaceIds) {
      const generations = await snapshotGenerations(input.dataRoot, workspaceId, input);
      if (
        generations.some(
          (entry) =>
            entry.seal &&
            entry.manifest.purpose === 'backup' &&
            entry.manifest.capture.completedAt.slice(0, 10) >= automatic.day
        )
      )
        continue;
      if (control({ kind: 'candidate', workspaceId }) !== 1) continue;
      selected = {
        ...input,
        workspaceId,
        bundleRoot: join(input.dataRoot, 'server/backups/workspaces', workspaceId, input.backupId),
      };
      if (existsSync(selected.bundleRoot)) refuse('candidate-conflict');
      found = true;
      break;
    }
    if (!found) return undefined;
  }
  const { dataRoot, ...parameters } = selected;
  const captured = await captureWorkspaceBackup(
    {
      ...parameters,
      source: { kind: 'live-workspace', dataRoot },
      admission: {
        reserve(writes) {
          const reservation = control({ kind: 'capacity', action: 'reserve', writes }) as number;
          return {
            assertAvailable: () => {
              control({ kind: 'capacity', action: 'assert', reservation });
            },
            release: () => {
              control({ kind: 'capacity', action: 'release', reservation });
            },
            reduceTo: (bytes) => {
              control({ kind: 'capacity', action: 'reduce', reservation, bytes });
            },
            recordWritten: (bytes) => {
              control({ kind: 'capacity', action: 'written', reservation, bytes });
            },
          };
        },
      },
    },
    (phase) => {
      control({ kind: 'phase', phase, at: performance.timeOrigin + performance.now() });
    }
  );
  if (automatic) {
    // Reuse the same exclusion and posted-ACK drain; never collect over a new publisher.
    control({ kind: 'phase', phase: 'freeze', at: performance.timeOrigin + performance.now() });
    control({ kind: 'phase', phase: 'drain', at: performance.timeOrigin + performance.now() });
    try {
      await retainWorkspaceSnapshots(selected);
    } finally {
      control({ kind: 'phase', phase: 'cut', at: performance.timeOrigin + performance.now() });
    }
  }
  return captured;
}

/** Owns one nonwaiting worker slot and the live target's original gate, hold and capacity leases. */
export async function createWorkspaceBackup(
  input: WorkspaceBackupCreateInput
): Promise<WorkspaceBackupCreateResult> {
  const captured = await runWorkspaceCapture(input);
  if (!captured) refuse('recovery-required');
  return captured;
}

/** Trusted daily policy on the existing maintenance pass; application composition activates it separately. */
export async function runWorkspaceSnapshotMaintenance(
  input: Omit<
    WorkspaceBackupCreateInput,
    'workspaceId' | 'backupId' | 'bundleRoot' | 'purpose' | 'origin' | 'source'
  > & {
    readonly source: Extract<WorkspaceBackupSource, { kind: 'live-workspace' }>;
    readonly now?: Date;
  }
): Promise<WorkspaceBackupCreateResult | undefined> {
  const day = (input.now ?? new Date()).toISOString().slice(0, 10);
  const workspaceIds = (
    input.source.coreDb.sqlite
      .prepare(
        "SELECT workspace_id FROM workspace_registry WHERE status='active' ORDER BY workspace_id"
      )
      .pluck()
      .all() as string[]
  ).filter((id) => isScopeAdmitted(input.source.dataRoot, 'workspace', id));
  if (!workspaceIds.length) return undefined;
  const backupId = allocateEntityId('wsbak');
  return runWorkspaceCapture(
    {
      ...input,
      workspaceId: workspaceIds[0]!,
      backupId,
      bundleRoot: join(
        input.source.dataRoot,
        'server/backups/workspaces',
        workspaceIds[0]!,
        backupId
      ),
      purpose: 'backup',
      origin: 'automatic',
    },
    { day, workspaceIds }
  );
}

/** One existing worker lifetime serves either explicit capture or the trusted daily policy. */
async function runWorkspaceCapture(
  input: WorkspaceBackupCreateInput,
  automatic?: { readonly day: string; readonly workspaceIds: readonly string[] }
): Promise<WorkspaceBackupCreateResult | undefined> {
  if (
    (input.origin !== undefined && input.origin !== 'manual' && input.origin !== 'automatic') ||
    (input.origin === 'automatic' &&
      (input.source.kind !== 'live-workspace' || input.purpose !== 'backup'))
  )
    refuse('invalid-arguments');
  if (input.source.kind !== 'live-workspace') return captureWorkspaceBackup(input);
  if (captureWorkerActive) refuse('capacity-exceeded');
  captureWorkerActive = true;
  const live = input.source;
  let targetWorkspaceId = input.workspaceId;
  const reservations = new Map<number, FileStorageReservation>();
  let releaseFreeze: (() => void) | undefined;
  let releaseReplayRead: (() => void) | undefined;
  let resumeNative: (() => void) | undefined;
  let worker: Worker | undefined;
  let authorityError: unknown;
  let result: Omit<WorkspaceBackupCreateResult, 'manifest'> | null | undefined;
  let closing = false;
  let drained: Promise<void> | undefined;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  try {
    live.currentAuthority?.();
    // Presence selects acquisition only. The worker still proves finished capture and exact bytes.
    // The existing worker slot excludes another owned capture publishing this path meanwhile.
    if (!automatic && existsSync(input.bundleRoot)) {
      releaseReplayRead = live.mutationAdmission.enter(input.workspaceId) ?? undefined;
      if (!releaseReplayRead)
        throw new OperationError('workspace_frozen', 'Workspace is temporarily frozen.', 409, {
          details: { workspaceId: input.workspaceId, retryable: true },
        });
    }
    const request: WorkspaceCaptureWorkerInput = {
      dataRoot: live.dataRoot,
      workspaceId: input.workspaceId,
      backupId: input.backupId,
      expectedSourceDeploymentId: input.expectedSourceDeploymentId,
      purpose: input.purpose,
      origin: input.origin ?? 'manual',
      bundleRoot: input.bundleRoot,
      stagingParent: input.stagingParent,
      expectedRelease: input.expectedRelease,
      supportedDatabaseFormats: input.supportedDatabaseFormats,
      ...(input.supportedRequiredFeatures
        ? { supportedRequiredFeatures: input.supportedRequiredFeatures }
        : {}),
    };
    const options = { workerData: { input: request, signal: signal.buffer, automatic } };
    if (import.meta.url.endsWith('.ts') && process.env.VITEST === 'true') {
      worker = new Worker(
        pathToFileURL(join(tmpdir(), 'nanocore-worker/dist/storage/workspace-backup-worker.mjs')),
        options
      );
    } else if (import.meta.url.endsWith('.ts')) {
      const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href;
      const entry = new URL('./workspace-backup-worker.ts', import.meta.url).href;
      worker = new Worker(
        `import(${JSON.stringify(loader)}).then(({register}) => {register(); return import(${JSON.stringify(entry)});});`,
        { ...options, eval: true }
      );
    } else worker = new Worker(new URL('./workspace-backup-worker.js', import.meta.url), options);
    const host = worker;
    result = await new Promise<Omit<WorkspaceBackupCreateResult, 'manifest'> | null>(
      (resolveResult, reject) => {
        const onWorkerFailure = () =>
          reject(
            authorityError ??
              new WorkspaceRecoveryError(
                'recovery-required',
                'Capture worker outcome requires inspection.'
              )
          );
        host.on('error', onWorkerFailure);
        host.on('exit', onWorkerFailure);
        host.on(
          'message',
          async (
            value:
              | WorkspaceCaptureControl
              | { kind: 'done'; result: Omit<WorkspaceBackupCreateResult, 'manifest'> | null }
              | { kind: 'failed'; code: WorkspaceRecoveryErrorCode }
          ) => {
            if (value.kind === 'done') {
              if (authorityError) reject(authorityError);
              else resolveResult(value.result);
              return;
            }
            if (value.kind === 'failed') {
              reject(
                authorityError ??
                  new WorkspaceRecoveryError(value.code, 'Workspace capture refused.')
              );
              return;
            }
            let reply: number | undefined;
            let ok = true;
            try {
              if (value.kind === 'candidate') {
                if (!automatic?.workspaceIds.includes(value.workspaceId))
                  refuse('invalid-arguments');
                targetWorkspaceId = value.workspaceId;
                reply = 0;
                if (isScopeAdmitted(live.dataRoot, 'workspace', targetWorkspaceId)) {
                  const candidate = live.mutationAdmission.tryFreeze(targetWorkspaceId, () =>
                    readBlockers({ ...live, workspaceId: targetWorkspaceId, operation: 'capture' })
                  );
                  if (candidate.status === 'frozen') {
                    candidate.release();
                    reply = 1;
                  }
                }
              } else if (value.kind === 'capacity') {
                if (value.action === 'reserve') {
                  reply = reservations.size;
                  reservations.set(reply, input.admission.reserve(value.writes));
                } else {
                  const reservation = reservations.get(value.reservation);
                  if (!reservation) refuse('capacity-exceeded');
                  if (value.action === 'assert') reservation.assertAvailable();
                  if (value.action === 'release') reservation.release();
                  if (value.action === 'reduce') reservation.reduceTo(value.bytes as bigint);
                  if (value.action === 'written') reservation.recordWritten(value.bytes as number);
                }
              } else {
                if (value.phase !== 'cleanup' && value.phase !== 'cleanup-end')
                  live.currentAuthority?.();
                if (value.phase === 'freeze') {
                  live.store.setWorkspaceMutationAdmission(live.mutationAdmission);
                  let hold: Promise<() => void> | null = null;
                  const wasClosed = live.mutationAdmission.isClosed(targetWorkspaceId);
                  const admission = live.mutationAdmission.tryFreeze(targetWorkspaceId, () => {
                    const blockers = readBlockers({
                      ...live,
                      workspaceId: targetWorkspaceId,
                      operation: 'capture',
                    });
                    if (blockers.length) return blockers;
                    hold = getControlStoreWorkerClient().tryPauseForWorkspaceCapture(
                      `workspace:${join(live.dataRoot, 'workspaces', targetWorkspaceId, 'db/workspace.sqlite')}`,
                      live.mutationAdmission
                    );
                    return hold
                      ? []
                      : [
                          {
                            kind: 'publication',
                            reason: 'pending-publication',
                            reference: { workspaceId: targetWorkspaceId },
                            actions: [],
                          },
                        ];
                  });
                  if (admission.status !== 'frozen') {
                    const busy = wasClosed && admission.status === 'busy';
                    throw new OperationError(
                      busy ? 'workspace_frozen' : 'workspace_blocked',
                      'Workspace capture is not admitted.',
                      409,
                      {
                        details: {
                          workspaceId: targetWorkspaceId,
                          operation: 'capture',
                          retryable: busy,
                          blockers:
                            admission.status === 'blocked'
                              ? admission.blockers
                              : [
                                  {
                                    kind: 'publication',
                                    reason: busy ? 'frozen' : 'pending-publication',
                                    reference: { workspaceId: targetWorkspaceId },
                                    actions: [],
                                  },
                                ],
                        },
                      }
                    );
                  }
                  releaseFreeze = admission.release;
                  drained = hold!.then(
                    (release) => {
                      resumeNative = release;
                    },
                    (error) => {
                      authorityError ??= error;
                    }
                  );
                }
                if (value.phase === 'drain') {
                  await drained;
                  if (closing) return;
                  if (authorityError) throw authorityError;
                  live.currentAuthority?.();
                }
                if (value.phase === 'cut') {
                  resumeNative?.();
                  resumeNative = undefined;
                  if (input.purpose === 'backup') {
                    releaseFreeze?.();
                    releaseFreeze = undefined;
                  }
                }
              }
            } catch (error) {
              ok = false;
              authorityError ??=
                error instanceof FileAdmissionError
                  ? new WorkspaceRecoveryError(
                      'capacity-exceeded',
                      'Capture capacity is unavailable.'
                    )
                  : error;
            }
            if (closing) return;
            host.postMessage({ ok, result: reply });
            Atomics.store(signal, 0, 1);
            Atomics.notify(signal, 0);
          }
        );
      }
    );
    live.currentAuthority?.();
  } catch (error) {
    authorityError ??= error;
  } finally {
    closing = true;
    let cleanupFailure: unknown;
    try {
      await worker?.terminate();
    } catch (error) {
      cleanupFailure = error;
    }
    // Drain rejection is observed when acquired; its native owner has already
    // released the failed hold. Late successful acquisition still belongs here.
    await drained;
    try {
      resumeNative?.();
      if (input.purpose === 'move' && releaseFreeze) {
        // Before a pin a refused MOVE reopens; uncertain retained truth keeps its fence.
        try {
          const retained = captureDatabase(live.dataRoot, targetWorkspaceId);
          try {
            if (!inspectCapture(retained, targetWorkspaceId, input.backupId)) releaseFreeze();
          } finally {
            retained.sqlite.close();
          }
        } catch {
          /* Unknown retained truth keeps MOVE exclusion. */
        }
      } else releaseFreeze?.();
    } catch (error) {
      cleanupFailure ??= error;
    }
    for (const reservation of reservations.values()) {
      try {
        reservation.release();
      } catch (error) {
        cleanupFailure ??= error;
      }
    }
    releaseReplayRead?.();
    captureWorkerActive = false;
    authorityError ??= cleanupFailure;
  }
  if (authorityError) throw authorityError;
  if (result === null) return undefined;
  if (!result) refuse('recovery-required');
  const captured = result;
  // Online handlers consume the report; explicit internal readers keep the existing
  // manifest property without cloning a complete graph across the thread boundary.
  return {
    ...captured,
    get manifest() {
      return readWorkspaceBackupManifest(captured.bundleRoot);
    },
  } as WorkspaceBackupCreateResult;
}

/**
 * Captures the fenced live target, stopped authority under its lock, or a verified read-only parent.
 * Core recurring history uses its existing portable paths; scheduler authority never travels.
 */
async function captureWorkspaceBackup(
  input: CaptureInput,
  phase?: (phase: WorkspaceCapturePhase) => void
): Promise<WorkspaceBackupCreateResult> {
  let lock: DataRootLock | undefined;
  let staging: ReturnType<typeof privateRoot> | undefined;
  let reservation: FileStorageReservation | undefined;
  let ownedOutput = false;
  let captureFinished = false;
  let captureDb: ReturnType<typeof bindWorkspaceSqlite> | undefined;
  const live = input.source.kind === 'live-workspace';
  const cutMetadata = new Map<string, { bytes: number; mode: number }>();
  const immutableCut: WorkspaceBackupManifest['inventory'][number][] = [];
  let liveCut:
    | {
        accounts: { ownerId: string; memberIds: string[]; privateAudienceRefs: string[] };
        recurring: ReturnType<typeof readRecurringPortableCoreCut>;
      }
    | undefined;
  try {
    phase?.('preflight');
    if (
      !isEntityId('ws', input.workspaceId) ||
      !isEntityId('wsbak', input.backupId) ||
      !isEntityId('dep', input.expectedSourceDeploymentId) ||
      !['backup', 'move'].includes(input.purpose)
    )
      refuse('invalid-arguments');
    const sourceRoot = resolve(
      input.source.kind === 'data-root-backup' ? input.source.backupRoot : input.source.dataRoot
    );
    if (!existsSync(sourceRoot)) refuse('source-unavailable');
    realDirectory(sourceRoot);
    if (input.source.kind === 'stopped-data-root') {
      try {
        lock = acquireDataRootLock(sourceRoot, { bootId: randomUUID() });
      } catch (error) {
        if (error instanceof DataRootLockError) refuse('root-locked');
        failure(error, 'source-unavailable');
      }
    }
    const verifiedParent =
      input.source.kind === 'data-root-backup' ? parent(sourceRoot) : undefined;
    const deploymentId = readDataRootLayoutMarker(sourceRoot).deploymentId;
    if (
      deploymentId !== input.expectedSourceDeploymentId ||
      (verifiedParent && verifiedParent.sourceDeploymentId !== deploymentId)
    )
      refuse('deployment-mismatch');
    const source: WorkspaceBackupSourceReport = live
      ? { kind: 'live-workspace' }
      : verifiedParent
        ? {
            kind: 'data-root-backup',
            dataRootBackupId: verifiedParent.id,
            consistency: verifiedParent.consistency,
          }
        : { kind: 'stopped-data-root' };
    const sourceWorkspace = join(sourceRoot, 'workspaces', input.workspaceId);
    if (!existsSync(join(sourceWorkspace, 'db/workspace.sqlite'))) refuse('workspace-unavailable');
    const output = resolve(input.bundleRoot);
    if (
      output === sourceRoot ||
      (!live && output.startsWith(`${sourceRoot}${sep}`)) ||
      sourceRoot.startsWith(`${output}${sep}`)
    )
      refuse('unsafe-path');
    if (live) {
      if (
        output !== join(sourceRoot, 'server/backups/workspaces', input.workspaceId, input.backupId)
      )
        refuse('unsafe-path');
      ensureCanonicalDirectory(dirname(output));
    }
    realDirectory(dirname(output));
    if (lstatSync(output, { throwIfNoEntry: false })) {
      realDirectory(output);
      let previous: WorkspaceBackupManifest;
      try {
        previous = readWorkspaceBackupManifest(output);
      } catch {
        refuse('candidate-conflict');
      }
      if (previous.backupId !== input.backupId) refuse('candidate-conflict');
      if (
        previous.workspaceId !== input.workspaceId ||
        previous.sourceDeploymentId !== deploymentId ||
        previous.purpose !== input.purpose
      )
        refuse('request-conflict');
      if (input.purpose !== 'backup' || !existsSync(join(output, 'seal.json')))
        refuse('recovery-required');
      if (live) {
        phase?.('authority');
        const retained = captureDatabase(sourceRoot, input.workspaceId);
        try {
          if (inspectCapture(retained, input.workspaceId, input.backupId)?.state !== 'finished')
            refuse('recovery-required');
        } finally {
          retained.sqlite.close();
        }
        staging = privateRoot(input.stagingParent, input.workspaceId);
        const saved = await stageWorkspaceBackup({
          ...input,
          candidateRoot: join(staging.container, 'retry'),
          expectedWorkspaceId: input.workspaceId,
          expectedSourceDeploymentId: deploymentId,
          snapshotSource: {
            dataRoot: sourceRoot,
            source: {
              kind: 'local-snapshot',
              workspaceId: input.workspaceId,
              backupId: input.backupId,
            },
          },
        });
        phase?.('authority');
        return {
          bundleRoot: output,
          manifest: saved.manifest,
          report: { ...saved.report, source },
          purpose: 'backup' as const,
          disposition: 'sealed' as const,
        };
      }
      staging = privateRoot(input.stagingParent, input.workspaceId);
      const staged = await stageWorkspaceBackup({
        ...input,
        expectedWorkspaceId: input.workspaceId,
        expectedSourceDeploymentId: deploymentId,
        candidateRoot: join(staging.container, 'retry'),
        purpose: 'backup',
      });
      if (verifiedParent && !isDeepStrictEqual(verifiedParent, parent(sourceRoot)))
        refuse('parent-backup-invalid');
      return {
        bundleRoot: input.bundleRoot,
        manifest: staged.manifest,
        report: { ...staged.report, source },
        purpose: 'backup',
        disposition: 'sealed',
      };
    }
    if (live) {
      staging = privateRoot(dirname(output), input.workspaceId);
      reservation = input.admission.reserve({
        stagingBytes: 1_048_576n,
        extractionBytes: 0n,
        derivativeBytes: 0n,
        publicationBytes: 0n,
      });
      phase?.('freeze');
      phase?.('drain');
      phase?.('core-pin');
      const sqlite = new Database(join(sourceRoot, 'server/db/core.sqlite'), {
        readonly: true,
        fileMustExist: true,
      });
      try {
        sqlite.pragma('query_only = ON');
        const core = bindCoreSqlite(sqlite, sourceRoot);
        liveCut = sqlite.transaction(() => ({
          accounts: {
            ownerId: sqlite
              .prepare(
                "SELECT owner_user_id FROM workspace_registry WHERE workspace_id=? AND status='active'"
              )
              .pluck()
              .get(input.workspaceId) as string,
            memberIds: sqlite
              .prepare(
                "SELECT user_id FROM workspace_members WHERE workspace_id=? AND status='active' ORDER BY user_id"
              )
              .pluck()
              .all(input.workspaceId) as string[],
            privateAudienceRefs: [],
          },
          recurring: readRecurringPortableCoreCut(core, input.workspaceId),
        }))();
      } finally {
        sqlite.close();
      }
    }
    phase?.('enumeration');
    const sourceFiles = files(sourceWorkspace, live ? cutMetadata : undefined);
    const total = sourceFiles.reduce(
      (n, p) =>
        n +
        (cutMetadata.get(p)?.bytes ?? lstatSync(join(sourceWorkspace, p)).size) +
        (cutMetadata.get(`${p}-wal`)?.bytes ?? 0),
      1_048_576
    );
    reservation?.release();
    reservation = input.admission.reserve({
      stagingBytes:
        BigInt(total) * 3n +
        (live ? 0n : BigInt(lstatSync(join(sourceRoot, 'server/db/core.sqlite')).size)),
      extractionBytes: 0n,
      derivativeBytes: 0n,
      publicationBytes: 0n,
    });
    mkdirSync(output, { mode: 0o700 });
    ownedOutput = true;
    if (!live) syncCanonicalDirectory(dirname(output));
    staging ??= privateRoot(dirname(output), input.workspaceId);
    // Only the stopped live authority is writable. H1 protects its private snapshot instead.
    if (!verifiedParent) {
      if (!live) {
        const sourceDb = database(join(sourceWorkspace, 'db/workspace.sqlite'));
        sourceDb.close();
      }
      captureDb = captureDatabase(sourceRoot, input.workspaceId);
      // A lost acknowledgement can still leave an active MOVE pin. Unknown completion keeps its fence.
      phase?.('pin');
      protectCapture(captureDb, input.workspaceId, input.backupId, {
        origin: input.origin ?? 'manual',
      });
      phase?.('pin-end');
    }
    phase?.('mutable-copy');
    for (const path of sourceFiles) {
      if (!live) reservation.assertAvailable();
      const destination = join(staging.workspaceRoot, path);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      const currentDatabase =
        path === 'db/workspace.sqlite' || /^light-apps\/[^/]+\/data.sqlite$/.test(path);
      const original = join(sourceWorkspace, path);
      const mode = cutMetadata.get(path)?.mode ?? lstatSync(original).mode & 0o777;
      if (live && /^evidence\/backend\/sha256\/[0-9a-f]{64}$/.test(path)) {
        // The existing native content owner publishes these create-only and never sweeps committed digest objects.
        // Active capture protection remains retained until seal; mutable/expiry-owned families stay in the frozen cut.
        immutableCut.push({
          path,
          bytes: cutMetadata.get(path)!.bytes,
          sha256: `sha256:${path.split('/').at(-1)!}`,
          mode,
        });
        continue;
      }
      if (live && !currentDatabase) {
        await copyFileForCut({
          sourcePath: original,
          destinationPath: destination,
          mode,
          maxBytes: 2_147_483_648,
        });
      } else if (verifiedParent || !currentDatabase) {
        const entry = verifiedParent?.contentInventory.find(
          (e) => e.path === `workspaces/${input.workspaceId}/${path}`
        );
        if (verifiedParent && (!entry || entry.bytes !== lstatSync(original).size))
          refuse('parent-backup-invalid');
        copyBytes(original, destination, entry?.digest);
      }
      if (currentDatabase) {
        // A single database-copy method, including WAL: SQLite's backup API.
        phase?.('db-backup');
        const db = live
          ? new Database(original, { readonly: true, fileMustExist: true })
          : database(verifiedParent ? destination : original);
        try {
          await db.backup(`${destination}.capture`);
        } finally {
          db.close();
        }
        renameSync(`${destination}.capture`, destination);
        chmodSync(destination, mode);
        if (live) cutMetadata.set(path, { bytes: lstatSync(destination).size, mode });
        phase?.('mutable-copy');
      }
    }
    if (verifiedParent) {
      captureDb = captureDatabase(staging.container, input.workspaceId);
      protectCapture(captureDb, input.workspaceId, input.backupId);
    }
    // All mutable bytes are independent. Only exactly protected create-only native objects remain live-dependent.
    if (live) phase?.('cut');
    phase?.('post-cut-validation');
    // Canonical readers resolve native file-backed bodies inside the private cut.
    // Materialize protected bytes only after release; pool publication still reuses
    // existing objects and independently verifies their original digest.
    for (const entry of immutableCut) {
      const pooled = join(dirname(output), 'objects', entry.sha256.slice(7));
      const destination = join(staging.workspaceRoot, entry.path);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      const copied = await copyFileForCut({
        sourcePath: existsSync(pooled) ? pooled : join(sourceWorkspace, entry.path),
        destinationPath: destination,
        mode: entry.mode,
        maxBytes: 2_147_483_648,
      });
      if (copied.bytes !== entry.bytes) refuse('incomplete-closure');
    }
    const facts = graph(staging.container, input.workspaceId);
    if (live) validateCaptureHistory(staging.container, input.workspaceId, sourceRoot);
    for (const { markers } of facts.formats)
      for (const [key, value] of Object.entries(markers))
        if (input.supportedDatabaseFormats[key] !== value) refuse('unsupported-format');
    const coreSource = join(sourceRoot, 'server/db/core.sqlite');
    // H1 opens Core only after making a private copy; no SQLite operation touches its parent.
    const corePath = join(staging.container, 'core.sqlite');
    if (live) {
      // Core facts were cut synchronously before file I/O; no whole-Core copy belongs to a live Workspace.
    } else if (verifiedParent) {
      const entry = verifiedParent.contentInventory.find((e) => e.path === 'server/db/core.sqlite');
      if (!entry || entry.bytes !== lstatSync(coreSource).size) refuse('parent-backup-invalid');
      copyBytes(coreSource, corePath, entry.digest);
    } else {
      const db = database(coreSource);
      try {
        await db.backup(corePath);
      } finally {
        db.close();
      }
    }
    const core = live ? undefined : database(corePath);
    let hasRecurring = false;
    let accounts: WorkspaceBackupManifest['accounts'];
    try {
      const owner =
        liveCut?.accounts.ownerId ??
        (core!
          .prepare('SELECT owner_user_id FROM workspace_registry WHERE workspace_id=?')
          .pluck()
          .get(input.workspaceId) as string | undefined);
      if (!isEntityId('usr', owner)) refuse('workspace-unavailable');
      const memberIds =
        liveCut?.accounts.memberIds ??
        (core!
          .prepare(
            "SELECT user_id FROM workspace_members WHERE workspace_id=? AND status='active' ORDER BY user_id"
          )
          .pluck()
          .all(input.workspaceId) as string[]);
      // Core owns native rows. Its existing portable owner emits inert history, never queue authority.
      const recurring = exportRecurringPortableHistory(
        core ? bindCoreSqlite(core, staging.container) : undefined,
        input.workspaceId,
        facts.inheritedRecurring,
        [...facts.references.turns].map(([id, threadId]) => ({ id, threadId })),
        liveCut?.recurring
      );
      validateRecurringPortableHistory(JSON.stringify(recurring));
      hasRecurring =
        facts.inheritedRecurring !== null ||
        recurring.schedules.length > 0 ||
        recurring.occurrences.length > 0 ||
        recurring.expiredRanges.length > 0;
      if (hasRecurring) {
        mkdirSync(join(staging.workspaceRoot, 'records'), { recursive: true, mode: 0o700 });
        const portableFiles = new Map<string, string>();
        for (const [family, path] of Object.entries(RECURRING_PORTABLE_PATHS)) {
          const rows = recurring[family as keyof typeof RECURRING_PORTABLE_PATHS];
          const text = rows.map((row) => `${JSON.stringify(row)}\n`).join('');
          writeFileSync(join(staging.workspaceRoot, path), text, { flag: 'wx', mode: 0o600 });
          portableFiles.set(path, text);
          if (live) cutMetadata.set(path, { bytes: Buffer.byteLength(text), mode: 0o600 });
        }
        readRecurringPortableFiles(portableFiles, facts.references);
      }
      if (memberIds.some((id) => !isEntityId('usr', id))) refuse('invalid-database');
      accounts = {
        ownerId: owner,
        memberIds: memberIds.filter((id) => isEntityId('usr', id)),
        privateAudienceRefs: facts.privateAudienceRefs,
      };
    } finally {
      core?.close();
    }
    if (verifiedParent && !isDeepStrictEqual(verifiedParent, parent(sourceRoot)))
      refuse('parent-backup-invalid');
    const startedAt = inspectCapture(captureDb!, input.workspaceId, input.backupId)!.createdAt;
    // Close before inventory: no WAL/SHM or active SQLite handle travels.
    captureDb?.sqlite.close();
    captureDb = undefined;
    if (!live) closePrivateBytes(staging.workspaceRoot);
    const inventory = [
      ...(live
        ? [...cutMetadata.keys()].filter(
            (path) => !/(?:-wal|-shm)$/.test(path) && !immutableCut.some((e) => e.path === path)
          )
        : files(staging.workspaceRoot)
      ).map((path) => ({
        path,
        bytes: cutMetadata.get(path)?.bytes ?? lstatSync(join(staging!.workspaceRoot, path)).size,
        sha256: copyBytes(join(staging!.workspaceRoot, path)),
        mode:
          cutMetadata.get(path)?.mode ?? lstatSync(join(staging!.workspaceRoot, path)).mode & 0o777,
      })),
      ...immutableCut,
    ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const manifest = parseWorkspaceBackupManifest({
      format: 'openkit-workspace-backup',
      version: 1,
      purpose: input.purpose,
      backupId: input.backupId,
      workspaceId: input.workspaceId,
      sourceDeploymentId: deploymentId,
      knowledgeBaseIds: facts.knowledgeBaseIds,
      capturedRevision: facts.capturedRevision,
      priorMoves: [],
      release: input.expectedRelease,
      databaseFormats: facts.formats,
      requiredFeatures: hasRecurring ? [RECURRING_PORTABLE_FEATURE] : [],
      capture: {
        startedAt,
        completedAt: new Date().toISOString(),
        consistency: live && input.purpose === 'backup' ? 'workspace-consistent' : 'quiescent',
      },
      inventory,
      inventoryDigest: digest(JSON.stringify(inventory)),
      coverage: {
        includedAuthorities: ['workspace-control', 'workspace-content', 'knowledge', 'light-apps'],
        snapshotRoots: [...new Set(inventory.map((e) => e.path.split('/')[0]!))],
        omittedProjections: [...omitted],
        omittedVolumes: [],
        externalDependencies: facts.externalDependencies,
      },
      accounts,
    });
    if (live) {
      phase?.('pool');
      const objectRoot = join(dirname(output), 'objects');
      ensureCanonicalDirectory(objectRoot);
      for (const entry of inventory) {
        const object = join(objectRoot, entry.sha256.slice(7));
        if (existsSync(object)) {
          await copyStorageFile({
            sourcePath: object,
            expectedBytes: entry.bytes,
            expectedSha256: entry.sha256,
            maxBytes: 2_147_483_648,
          });
        } else {
          const original = join(staging.workspaceRoot, entry.path);
          await copyStorageFile({
            sourcePath: original,
            destinationPath: object,
            expectedBytes: entry.bytes,
            expectedSha256: entry.sha256,
            mode: 0o444,
            maxBytes: 2_147_483_648,
          });
        }
      }
      syncCanonicalDirectory(objectRoot);
      phase?.('authority');
    }
    const metadata = `${JSON.stringify(manifest)}\n`;
    const manifestDigest = digest(metadata);
    // Remove only empty directories, which the exact file-inventory format does not represent.
    const prune = (root: string) => {
      for (const name of readdirSync(root)) {
        const p = join(root, name);
        if (lstatSync(p).isDirectory()) {
          prune(p);
          if (!readdirSync(p).length) rmSync(p, { recursive: true });
        }
      }
    };
    if (!live) {
      writeFileSync(join(staging.workspaceRoot, 'manifest.json'), metadata, {
        flag: 'wx',
        mode: 0o600,
      });
      prune(staging.workspaceRoot);
      syncCanonicalTree(staging.workspaceRoot);
    }
    const seal =
      input.purpose === 'backup'
        ? JSON.stringify({
            format: 'openkit-workspace-backup-seal',
            version: 1,
            backupId: input.backupId,
            purpose: input.purpose,
            manifestDigest,
          })
        : undefined;
    if (!live && seal !== undefined) {
      writeFileSync(join(staging.workspaceRoot, 'seal.json'), seal, { flag: 'wx', mode: 0o600 });
      syncCanonicalTree(staging.workspaceRoot);
      await withVerifiedWorkspaceBackupBundle(
        {
          ...input,
          supportedRequiredFeatures: input.supportedRequiredFeatures ?? [
            RECURRING_PORTABLE_FEATURE,
          ],
          bundleRoot: staging.workspaceRoot,
        },
        async () => undefined
      );
    }
    reservation.assertAvailable();
    if (live) {
      await publishDurableFile({ destinationPath: join(output, 'manifest.json'), bytes: metadata });
      phase?.('authority');
      if (seal !== undefined)
        await publishDurableFile({
          destinationPath: join(output, 'seal.json'),
          bytes: seal,
        });
      phase?.('authority');
    } else publishCanonicalPath(staging.workspaceRoot, output);
    if (input.purpose === 'backup') {
      phase?.('finish');
      if (!verifiedParent) {
        const writer = captureDatabase(sourceRoot, input.workspaceId);
        try {
          try {
            captureFinished = true;
            completeCapture(writer, input.workspaceId, input.backupId);
          } catch (error) {
            // An acknowledgement can be lost after the durable decision. Keep its exact sealed bytes.
            const decision = inspectCapture(writer, input.workspaceId, input.backupId);
            if (decision?.state === 'active' || decision?.state === 'abandoned')
              captureFinished = false;
            throw error;
          }
        } finally {
          writer.sqlite.close();
        }
      }
    }
    const common = {
      bundleRoot: input.bundleRoot,
      manifest,
      report: { ...report(manifest, manifestDigest, facts), source },
    };
    if (input.purpose === 'move' && !verifiedParent) {
      const core = openExistingCoreDbWithIntegrityCheck(sourceRoot);
      try {
        prepareRecoveryAdmission(core, input.backupId, output, {
          input: {
            command: 'capture',
            source: live ? { kind: 'live-workspace' } : input.source,
            workspaceId: input.workspaceId,
            expectedSourceDeploymentId: deploymentId,
            bundleRoot: output,
            backupId: input.backupId,
            purpose: 'move',
          },
          manifest,
          capture: common.report,
          result: recoveryReport('capture', 'prepared', common.report),
        });
      } finally {
        core.sqlite.close();
      }
    }
    return input.purpose === 'backup'
      ? { ...common, purpose: 'backup', disposition: 'sealed' }
      : { ...common, purpose: 'move', disposition: 'prepared' };
  } catch (error) {
    // An unfinished capture has no transferable marker. A lost finish ACK cannot erase a committed generation.
    if (ownedOutput && !captureFinished)
      rmSync(join(input.bundleRoot, 'seal.json'), { force: true });
    if (error instanceof OperationError) throw error;
    return failure(error, 'invalid-database');
  } finally {
    captureDb?.sqlite.close();
    lock?.release();
    phase?.('cleanup');
    if (staging) rmSync(staging.container, { recursive: true, force: true });
    phase?.('cleanup-end');
    reservation?.release();
  }
}

/** Verifies a sealed bundle, then copies identity-mapped bytes into an absent private candidate; never admits or boots it. */
export async function stageWorkspaceBackup(
  input: WorkspaceBackupStageInput
): Promise<WorkspaceBackupStageResult> {
  let staging: ReturnType<typeof privateRoot> | undefined;
  let reserved: FileStorageReservation | undefined;
  let owned = false;
  try {
    realDirectory(dirname(input.candidateRoot));
    if (lstatSync(input.candidateRoot, { throwIfNoEntry: false })) refuse('candidate-conflict');
    const verify = input.snapshotSource
      ? <T>(
          policy: WorkspaceBackupVerificationInput,
          consume: (
            bundle: import('./workspace-backup-bundle.js').VerifiedWorkspaceBackupBundle
          ) => Promise<T>
        ) => withVerifiedWorkspaceSnapshotSource({ ...policy, ...input.snapshotSource! }, consume)
      : withVerifiedWorkspaceBackupBundle;
    return await verify(
      {
        ...input,
        supportedRequiredFeatures: input.supportedRequiredFeatures ?? [RECURRING_PORTABLE_FEATURE],
      },
      async (bundle) => {
        const { manifest } = bundle;
        if (
          manifest.workspaceId !== input.expectedWorkspaceId ||
          manifest.sourceDeploymentId !== input.expectedSourceDeploymentId
        )
          refuse('deployment-mismatch');
        if (manifest.purpose !== input.purpose) refuse('invalid-bundle');
        reserved = input.admission.reserve({
          stagingBytes: BigInt(bundle.totalBytes),
          extractionBytes: 0n,
          derivativeBytes: 0n,
          publicationBytes: 0n,
        });
        mkdirSync(input.candidateRoot, { mode: 0o700 });
        owned = true;
        staging = privateRoot(dirname(input.candidateRoot), manifest.workspaceId);
        for (const entry of manifest.inventory) {
          const path = join(staging.workspaceRoot, entry.path);
          mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
          const fd = openSync(path, 'wx', 0o600);
          try {
            // Keep memory bounded independently of bundle file sizes.
            for await (const chunk of bundle.readFile(entry.path)) {
              let offset = 0;
              while (offset < chunk.length) offset += writeSync(fd, chunk, offset);
              reserved.recordWritten(chunk.length);
            }
          } finally {
            closeSync(fd);
          }
          chmodSync(path, entry.mode);
        }
        const facts = graph(
          staging.container,
          manifest.workspaceId,
          manifest.capturedRevision,
          manifest.requiredFeatures
        );
        if (
          facts.formats.length !== manifest.databaseFormats.length ||
          facts.formats.some(
            (actual) =>
              !isDeepStrictEqual(
                actual.markers,
                manifest.databaseFormats.find((declared) => declared.path === actual.path)?.markers
              )
          ) ||
          !isDeepStrictEqual(facts.knowledgeBaseIds, manifest.knowledgeBaseIds)
        )
          refuse('unsupported-format');
        for (const entry of manifest.inventory)
          if (copyBytes(join(staging.workspaceRoot, entry.path)) !== entry.sha256)
            refuse('invalid-database');
        closePrivateBytes(staging.workspaceRoot);
        publishCanonicalPath(staging.workspaceRoot, input.candidateRoot);
        return {
          disposition: 'staged',
          candidateRoot: input.candidateRoot,
          manifest,
          report: report(manifest, bundle.manifestDigest, facts),
        };
      }
    );
  } catch (error) {
    if (owned) rmSync(input.candidateRoot, { recursive: true, force: true });
    // Live source acquisition is an admission refusal, not invalid retained bytes.
    if (error instanceof OperationError && error.code === 'workspace_frozen') throw error;
    return failure(error, 'invalid-bundle');
  } finally {
    if (staging) rmSync(staging.container, { recursive: true, force: true });
    reserved?.release();
  }
}

/** Proves an H1 cut still equals the stopped source before its first local MOVE ownership binding. */
export function assertWorkspaceBackupCut(
  dataRoot: string,
  candidate: string,
  manifest: WorkspaceBackupManifest,
  core: ReturnType<typeof bindCoreSqlite>
): void {
  const root = join(dataRoot, 'workspaces', manifest.workspaceId);
  const facts = graph(dataRoot, manifest.workspaceId, manifest.capturedRevision);
  const expected = manifest.inventory.filter(
    (entry) => !recurringPaths.some((path) => path === entry.path)
  );
  if (!isDeepStrictEqual(files(root).sort(), expected.map((entry) => entry.path).sort()))
    refuse('request-conflict');
  const databaseDigest = (path: string) => {
    const db = database(path);
    try {
      const hash = createHash('sha256');
      const tables = db
        .prepare(
          "SELECT name,sql FROM sqlite_schema WHERE type='table' AND name <> 'workspace_capture_records' ORDER BY name"
        )
        .all() as { name: string; sql: string }[];
      for (const table of tables) {
        hash.update(JSON.stringify(table));
        const columns = (
          db.pragma(`table_info(${quoteIdent(table.name)})`) as { name: string }[]
        ).map((column) => quoteIdent(column.name));
        for (const row of db
          .prepare(`SELECT * FROM ${quoteIdent(table.name)} ORDER BY ${columns.join(',')}`)
          .safeIntegers()
          .iterate())
          hash.update(
            JSON.stringify(row, (_key, value) =>
              typeof value === 'bigint' ? { int64: value.toString() } : value
            )
          );
      }
      return hash.digest('hex');
    } finally {
      db.close();
    }
  };
  for (const entry of expected) {
    const path = join(root, entry.path);
    if ((lstatSync(path).mode & 0o777) !== entry.mode) refuse('request-conflict');
    const currentDatabase =
      entry.path === 'db/workspace.sqlite' || /^light-apps\/[^/]+\/data.sqlite$/.test(entry.path);
    if (
      currentDatabase
        ? databaseDigest(path) !== databaseDigest(join(candidate, entry.path))
        : copyBytes(path) !== entry.sha256
    )
      refuse('request-conflict');
  }
  const owner = core.sqlite
    .prepare('SELECT owner_user_id FROM workspace_registry WHERE workspace_id=?')
    .pluck()
    .get(manifest.workspaceId);
  const members = core.sqlite
    .prepare(
      "SELECT user_id FROM workspace_members WHERE workspace_id=? AND status='active' ORDER BY user_id"
    )
    .pluck()
    .all(manifest.workspaceId);
  if (
    owner !== manifest.accounts.ownerId ||
    !isDeepStrictEqual(members, [...manifest.accounts.memberIds].sort())
  )
    refuse('request-conflict');
  const recurring = exportRecurringPortableHistory(
    core,
    manifest.workspaceId,
    facts.inheritedRecurring,
    [...facts.references.turns].map(([id, threadId]) => ({ id, threadId }))
  );
  for (const [family, path] of Object.entries(RECURRING_PORTABLE_PATHS)) {
    const rows = recurring[family as keyof typeof RECURRING_PORTABLE_PATHS];
    const text = existsSync(join(candidate, path))
      ? readFileSync(join(candidate, path), 'utf8')
      : '';
    if (rows.map((row) => `${JSON.stringify(row)}\n`).join('') !== text) refuse('request-conflict');
  }
}

/** Preserves the existing safe domain refusal envelope at concrete online recovery joins. */
export async function invokeWorkspaceRecoveryOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof WorkspaceRecoveryError || error instanceof WorkspaceBackupBundleError)
      throw new OperationError(error.code, error.message, 409, { cause: error });
    throw error;
  }
}

/** Supplies current administrator, build and storage owners for online Workspace snapshots. */
export function workspaceSnapshotOperationPolicy(
  dependencies: OperationInvocationDependencies,
  context: AdmittedOperationContext
) {
  const { coreDb, dataRoot, fileAdmission, store, workspaceMutationAdmission } = dependencies;
  if (!coreDb)
    throw new OperationError('recovery_required', 'Administrator authority is unavailable.', 503);
  if (!dataRoot || !fileAdmission || !store || !workspaceMutationAdmission)
    throw new OperationError(
      'operation_storage_unavailable',
      'Workspace snapshot storage is unavailable.',
      503
    );
  const currentAuthority = () => {
    try {
      requireAdministratorOperation(coreDb, publicOperationActor(context), 'api.call');
    } catch (cause) {
      if (cause instanceof DeploymentAdminRequiredError)
        throw new OperationError(
          'deployment_admin_required',
          'Current deployment administrator authority is required.',
          403,
          { cause }
        );
      if (cause instanceof OperationError) throw cause;
      const failure = projectOperationError(cause);
      throw new OperationError(
        failure?.code ?? 'internal_error',
        failure?.message ?? 'Internal Server Error',
        failure?.status ?? 500,
        { cause }
      );
    }
  };
  currentAuthority();
  const release = dependencies.diagnosticsServices?.releaseIdentity;
  if (!release?.sourceCommit)
    throw new OperationError(
      'operation_storage_unavailable',
      'The server build identity is unknown; install a build with its source commit.',
      503
    );
  const stagingParent = join(dataRoot, 'server/backups');
  ensureCanonicalDirectory(stagingParent);
  realDirectory(stagingParent);
  return {
    coreDb,
    dataRoot,
    store,
    mutationAdmission: workspaceMutationAdmission,
    currentAuthority,
    verification: {
      stagingParent,
      admission: fileAdmission,
      expectedRelease: {
        version: release.releaseTag ?? 'source',
        buildId: release.sourceCommit,
      },
      ...WORKSPACE_BACKUP_POLICY,
    },
  };
}

/** Complete online operator joins; existing backup, bundle and Kernel owners retain their decisions. */
export function createWorkspaceSnapshotOperationImplementations(
  dependencies: OperationInvocationDependencies
) {
  type Definitions = typeof WORKSPACE_SNAPSHOT_OPERATION_DEFINITIONS;
  type Input<K extends keyof Definitions> = import('zod').infer<Definitions[K]['inputSchema']>;
  const invoke = invokeWorkspaceRecoveryOperation;
  const policy = (context: AdmittedOperationContext) =>
    workspaceSnapshotOperationPolicy(dependencies, context);
  // Online readers acquire here; Main already holds acquisition admission for sealed replay.
  const localSource = (
    input: Input<'workspace.backup-verify'>,
    owned: ReturnType<typeof policy>
  ) => ({
    dataRoot: owned.dataRoot,
    source: { kind: 'local-snapshot' as const, ...input },
    acquireSource: () => {
      const release = owned.mutationAdmission.enter(input.workspaceId);
      if (!release)
        throw new OperationError('workspace_frozen', 'Workspace is temporarily frozen.', 409, {
          details: { workspaceId: input.workspaceId, retryable: true },
        });
      return release;
    },
  });
  const inspect = async (
    input: Input<'workspace.backup-verify'>,
    owned: ReturnType<typeof policy>
  ) => {
    const container = privateRoot(owned.verification.stagingParent, input.workspaceId);
    try {
      const result = await stageWorkspaceBackup({
        ...owned.verification,
        bundleRoot: join(
          owned.dataRoot,
          'server/backups/workspaces',
          input.workspaceId,
          input.backupId
        ),
        snapshotSource: localSource(input, owned),
        expectedWorkspaceId: input.workspaceId,
        expectedSourceDeploymentId: readDataRootLayoutMarker(owned.dataRoot).deploymentId,
        purpose: 'backup',
        candidateRoot: join(container.container, 'verified'),
      });
      owned.currentAuthority();
      return result;
    } finally {
      rmSync(container.container, { recursive: true, force: true });
    }
  };
  return {
    'workspace.backup-capture': (
      input: Input<'workspace.backup-capture'>,
      context: AdmittedOperationContext
    ) =>
      invoke(async () => {
        const owned = policy(context);
        const captured = await createWorkspaceBackup({
          ...owned.verification,
          ...input,
          source: {
            kind: 'live-workspace',
            ...owned,
            canReadThread: (threadId) =>
              isThreadIdVisible(
                owned.store,
                input.workspaceId,
                threadId,
                publicOperationActor(context)?.userId,
                true,
                'thread.read',
                { kind: 'user', userId: publicOperationActor(context)!.userId }
              ),
          },
          expectedSourceDeploymentId: readDataRootLayoutMarker(owned.dataRoot).deploymentId,
          bundleRoot: join(
            owned.dataRoot,
            'server/backups/workspaces',
            input.workspaceId,
            input.backupId
          ),
        });
        owned.currentAuthority();
        return WorkspaceSnapshotReportSchema.parse(
          recoveryReport('capture', captured.disposition, captured.report)
        );
      }),
    'workspace.backup-verify': (
      input: Input<'workspace.backup-verify'>,
      context: AdmittedOperationContext
    ) =>
      invoke(async () => {
        const result = await inspect(input, policy(context));
        return WorkspaceSnapshotReportSchema.parse(
          recoveryReport('verify', 'verified', result.report)
        );
      }),
    'workspace.backup-download': (
      input: Input<'workspace.backup-download'>,
      context: AdmittedOperationContext
    ): Promise<Response> =>
      invoke(async () => {
        const owned = policy(context);
        // Verification acquires independent copies before exposing a stream. Keep its callback alive until cancellation or completion.
        return new Promise<Response>((resolveResponse, rejectResponse) => {
          void withVerifiedWorkspaceSnapshotSource(
            {
              ...owned.verification,
              includeMetadata: true,
              ...localSource(input, owned),
            },
            async (bundle) => {
              owned.currentAuthority();
              const chunks = async function* () {
                for (const path of ['manifest.json', 'seal.json']) {
                  const buffers: Buffer[] = [];
                  for await (const chunk of bundle.readFile(path)) buffers.push(Buffer.from(chunk));
                  owned.currentAuthority();
                  const bytes = Buffer.concat(buffers);
                  yield workspaceArchiveHeader(path, 'file', bytes.length, 0o600);
                  yield bytes;
                  if (bytes.length % 512) yield Buffer.alloc(512 - (bytes.length % 512));
                }
                for (const inventory of bundle.manifest.inventory) {
                  owned.currentAuthority();
                  yield workspaceArchiveHeader(
                    inventory.path,
                    'file',
                    inventory.bytes,
                    inventory.mode
                  );
                  for await (const chunk of bundle.readFile(inventory.path)) {
                    owned.currentAuthority();
                    yield Buffer.from(chunk);
                  }
                  if (inventory.bytes % 512) yield Buffer.alloc(512 - (inventory.bytes % 512));
                }
                yield Buffer.alloc(1024);
              };
              const archive = Readable.from(chunks(), { objectMode: false, highWaterMark: 65536 });
              const compressed = createZstdCompress();
              const completion = pipeline(archive, compressed, { signal: context.signal });
              resolveResponse(
                new Response(Readable.toWeb(compressed) as ReadableStream, {
                  headers: {
                    'content-type': 'application/octet-stream',
                    'cache-control': 'no-store',
                  },
                })
              );
              await completion;
            }
          ).catch(rejectResponse);
        });
      }),
  };
}
