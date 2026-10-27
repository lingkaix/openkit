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
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isDeepStrictEqual } from 'node:util';
import { createZstdCompress } from 'node:zlib';
import {
  LightAppAdmittedSchemaSchema,
  type WORKSPACE_SNAPSHOT_OPERATION_DEFINITIONS,
  type WorkspaceBlocker,
  WorkspaceBlockerSchema,
  type WorkspaceFreezeRefusal,
  WorkspaceSnapshotReportSchema,
} from '@openkit/app-api-schemas';
import { isEntityId, readRetainedV1, SEALED_TURN_TERMINALS, TurnSchema } from '@openkit/protocol';
import { copyVerifiedFile as copyStorageFile, publishDurableFile } from '@openkit/storage';
import Database from 'better-sqlite3';
import {
  DeploymentAdminRequiredError,
  requireAdministratorOperation,
} from '../auth/operation-authorizer.js';
import { isThreadIdVisible } from '../auth/thread-visibility.js';
import { acquireDataRootLock, type DataRootLock, DataRootLockError } from '../bootstrap/lock.js';
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
import { listWorkspaceApplyPlans } from '../runtime/workspace-apply-plans.js';
import { listWorkspaceApplyResults } from '../runtime/workspace-apply-results.js';
import { getWorkspaceSyncReview } from '../runtime/workspace-sync-records.js';
import {
  isTerminalWorkspaceDeletionRequest,
  listWorkspaceDeletionRequests,
} from '../workspace-deletion-request.js';
import type { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { assertAppDefinitionMatches } from './app-db.js';
import { FileAdmissionError, type FileStorageReservation } from './artifacts/file-admission.js';
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
  readRecurringPortableFiles,
  validateRecurringPortableHistory,
} from './recurring-portable-history.js';
import { readRecurringOccurrence } from './recurring-records.js';
import { assertWorkspaceArchiveFilePath, workspaceArchiveHeader } from './workspace-archive.js';
import type {
  SnapshotSource,
  WorkspaceBackupCoverage,
  WorkspaceBackupManifest,
  WorkspaceBackupVerificationInput,
} from './workspace-backup-bundle.js';
import {
  parseWorkspaceBackupManifest,
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
  const blockers: WorkspaceBlocker[] = [];
  let unavailable = false;
  const add = (blocker: WorkspaceBlocker, threadId?: string) => {
    if (threadId && input.canReadThread && !input.canReadThread(threadId)) unavailable = true;
    else blockers.push(WorkspaceBlockerSchema.parse(blocker));
  };
  try {
    const { coreDb, workspaceId } = input;
    if (!isEntityId('ws', workspaceId)) throw new Error('Invalid Workspace scope.');
    input.store.getWorkspace(workspaceId);
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
        'SELECT capture_id FROM workspace_capture_records WHERE workspace_id=?'
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
    let after = '';
    const turns = new Map<string, ReturnType<typeof TurnSchema.parse>>();
    for (;;) {
      const page = reader.list('turn', after);
      if (!page.length) break;
      for (const row of page) {
        const turn = TurnSchema.parse({ ...row.record, items: [] });
        turns.set(turn.id, turn);
        if (!SEALED_TURN_TERMINALS[turn.status])
          add(
            {
              kind: 'turn',
              reason: 'active-work',
              reference: { threadId: turn.threadId, turnId: turn.id },
              actions: turnActions(turn.threadId, turn.id),
            },
            turn.threadId
          );
        after = turn.id;
      }
    }
    for (const id of coreIds(
      'SELECT attempt_id FROM scheduler_execution_attempts WHERE workspace_id=?'
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
              turns.has(attempt.turnId) &&
              !SEALED_TURN_TERMINALS[turns.get(attempt.turnId)!.status]
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
      'SELECT attempt_id FROM worker_backend_sessions WHERE workspace_id=?'
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
    for (const session of input.store.listWorkspaceAgentSessions(workspaceId)) {
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
      'SELECT storage_ref FROM worker_storage_bindings WHERE workspace_id=?'
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
    for (const id of ids('SELECT request_id FROM pending_requests WHERE workspace_id=?')) {
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
    const results = new Set(
      listWorkspaceApplyResults(targetDb, workspaceId).map((result) =>
        JSON.stringify([result.reviewId, result.changeSetId])
      )
    );
    for (const plan of listWorkspaceApplyPlans(targetDb, workspaceId)) {
      if (
        plan.approvalState !== 'approved' ||
        results.has(JSON.stringify([plan.reviewId, plan.changeSetId]))
      )
        continue;
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
    for (const row of coreDb.sqlite
      .prepare(
        'SELECT schema_version AS schemaVersion,record_json FROM recurring_occurrences WHERE workspace_id=?'
      )
      .all(workspaceId) as { schemaVersion: number; record_json: string }[]) {
      const occurrence = readRetainedV1(row, () => readRecurringOccurrence(row.record_json));
      if (
        occurrence.state === 'recovery_required' ||
        (occurrence.state === 'admission-accepted' &&
          (!occurrence.turnId || !turns.has(occurrence.turnId)))
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
      'SELECT admission_id FROM workspace_recovery_admissions WHERE workspace_id=?'
    )) {
      const recovery = readRecoveryAdmission(coreDb, id);
      if (!recovery) throw new Error('Missing recovery authority.');
      if (recovery.state === 'prepared')
        add({
          kind: 'snapshot',
          reason: 'pending-publication',
          reference: id.startsWith('wsbak_') ? { backupId: id } : { recoveryRequestId: id },
          actions: [],
        });
    }
    for (const id of db.prepare('SELECT id FROM control_executions').pluck().all() as string[]) {
      const execution = readExecutionJournalRoot(targetDb, {
        owner: { kind: 'workspace', workspaceId },
        executionId: id,
      });
      if (execution.phase !== 'closed' || execution.openSteps.length) {
        const turn = turns.get(execution.workId);
        if (!turn) unavailable = true;
        else
          add(
            {
              kind: 'publication',
              reason: 'pending-publication',
              reference: { workspaceId },
              actions: [],
            },
            turn.threadId
          );
      }
    }
    // A running call can outlive its user-visible Turn; unknown historical rows need closed physical proof.
    for (const row of listWorkspaceCapabilityCalls(targetDb, workspaceId)) {
      if (row.status !== 'running' && row.status !== 'unknown') continue;
      const turn = row.turnId ? turns.get(row.turnId) : undefined;
      if (row.status === 'running' || !turn || !SEALED_TURN_TERMINALS[turn.status]) {
        if (!turn) unavailable = true;
        else
          add(
            {
              kind: 'publication',
              reason: 'pending-publication',
              reference: { workspaceId },
              actions: [],
            },
            turn.threadId
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
  readonly snapshotSource?: { readonly dataRoot: string; readonly source: SnapshotSource };
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
  'drizzle.workspace': 16,
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
function files(root: string): string[] {
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

/**
 * Captures the fenced live target, stopped authority under its lock, or a verified read-only parent.
 * Core recurring history uses its existing portable paths; scheduler authority never travels.
 */
export async function createWorkspaceBackup(
  input: WorkspaceBackupCreateInput
): Promise<WorkspaceBackupCreateResult> {
  let lock: DataRootLock | undefined;
  let staging: ReturnType<typeof privateRoot> | undefined;
  let reservation: FileStorageReservation | undefined;
  let ownedOutput = false;
  let captureFinished = false;
  let retainMoveFence = false;
  let captureDb: ReturnType<typeof bindWorkspaceSqlite> | undefined;
  const live = input.source.kind === 'live-workspace' ? input.source : undefined;
  let releaseFreeze: (() => void) | undefined;
  let resumeNative: (() => void) | undefined;
  let liveFacts: ReturnType<typeof graph> | undefined;
  const immutableCut: WorkspaceBackupManifest['inventory'][number][] = [];
  let liveCut:
    | {
        accounts: WorkspaceBackupManifest['accounts'];
        recurring: ReturnType<typeof exportRecurringPortableHistory>;
      }
    | undefined;
  try {
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
        live.currentAuthority?.();
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
        live.currentAuthority?.();
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
      live.currentAuthority?.();
      live.store.setWorkspaceMutationAdmission(live.mutationAdmission);
      const alreadyFrozen = live.mutationAdmission.isClosed(input.workspaceId);
      let hold: Promise<() => void> | null = null;
      const admission = live.mutationAdmission.tryFreeze(input.workspaceId, () => {
        const blockers = readBlockers({
          ...live,
          workspaceId: input.workspaceId,
          operation: 'capture',
        });
        if (blockers.length) return blockers;
        hold = getControlStoreWorkerClient().tryPauseForWorkspaceCapture(
          `workspace:${join(sourceWorkspace, 'db/workspace.sqlite')}`,
          live.mutationAdmission
        );
        return hold
          ? []
          : [
              {
                kind: 'publication' as const,
                reason: 'pending-publication' as const,
                reference: { workspaceId: input.workspaceId },
                actions: [],
              },
            ];
      });
      if (admission.status !== 'frozen') {
        const busy = admission.status === 'busy' && alreadyFrozen;
        throw new OperationError(
          busy ? 'workspace_frozen' : 'workspace_blocked',
          busy
            ? 'Workspace is temporarily frozen.'
            : 'Resolve the Workspace blockers before capture.',
          409,
          {
            details: {
              workspaceId: input.workspaceId,
              operation: 'capture',
              retryable: busy,
              blockers: busy
                ? [
                    {
                      kind: 'publication',
                      reason: 'frozen',
                      reference: { workspaceId: input.workspaceId },
                      actions: [],
                    },
                  ]
                : admission.status === 'blocked'
                  ? admission.blockers
                  : [
                      {
                        kind: 'publication',
                        reason: 'pending-publication',
                        reference: { workspaceId: input.workspaceId },
                        actions: [],
                      },
                    ],
            },
          }
        );
      }
      releaseFreeze = admission.release;
      resumeNative = await hold!;
      live.currentAuthority?.();
      const sourceFacts = graph(sourceRoot, input.workspaceId);
      liveFacts = sourceFacts;
      liveCut = live.coreDb.sqlite.transaction(() => {
        const ownerId = live.coreDb.sqlite
          .prepare(
            "SELECT owner_user_id FROM workspace_registry WHERE workspace_id=? AND status='active'"
          )
          .pluck()
          .get(input.workspaceId) as string;
        const memberIds = live.coreDb.sqlite
          .prepare(
            "SELECT user_id FROM workspace_members WHERE workspace_id=? AND status='active' ORDER BY user_id"
          )
          .pluck()
          .all(input.workspaceId) as string[];
        if (!isEntityId('usr', ownerId) || memberIds.some((id) => !isEntityId('usr', id)))
          refuse('workspace-unavailable');
        const recurring = exportRecurringPortableHistory(
          live.coreDb,
          input.workspaceId,
          sourceFacts.inheritedRecurring,
          [...sourceFacts.references.turns].map(([id, threadId]) => ({ id, threadId }))
        );
        return {
          accounts: {
            ownerId,
            memberIds: memberIds.filter((id) => isEntityId('usr', id)),
            privateAudienceRefs: sourceFacts.privateAudienceRefs,
          },
          recurring,
        };
      })();
    }
    const sourceFiles = files(sourceWorkspace);
    const total = sourceFiles.reduce(
      (n, p) =>
        n +
        lstatSync(join(sourceWorkspace, p)).size +
        (lstatSync(`${join(sourceWorkspace, p)}-wal`, { throwIfNoEntry: false })?.size ?? 0),
      1_048_576
    );
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
    syncCanonicalDirectory(dirname(output));
    staging = privateRoot(dirname(output), input.workspaceId);
    // Only the stopped live authority is writable. H1 protects its private snapshot instead.
    if (!verifiedParent) {
      const sourceDb = database(join(sourceWorkspace, 'db/workspace.sqlite'));
      sourceDb.close();
      captureDb = captureDatabase(sourceRoot, input.workspaceId);
      // A lost acknowledgement can still leave an active MOVE pin. Unknown completion keeps its fence.
      retainMoveFence = live !== undefined && input.purpose === 'move';
      protectCapture(captureDb, input.workspaceId, input.backupId);
    }
    for (const path of sourceFiles) {
      reservation.assertAvailable();
      const destination = join(staging.workspaceRoot, path);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      const currentDatabase =
        path === 'db/workspace.sqlite' || /^light-apps\/[^/]+\/data.sqlite$/.test(path);
      const original = join(sourceWorkspace, path);
      const mode = lstatSync(original).mode & 0o777;
      if (live && /^evidence\/backend\/sha256\/[0-9a-f]{64}$/.test(path)) {
        // The existing native content owner publishes these create-only and never sweeps committed digest objects.
        // Active capture protection remains retained until seal; mutable/expiry-owned families stay in the frozen cut.
        immutableCut.push({
          path,
          bytes: lstatSync(original).size,
          sha256: `sha256:${path.split('/').at(-1)!}`,
          mode,
        });
        continue;
      }
      if (live && !currentDatabase) {
        await copyStorageFile({
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
        const db = database(verifiedParent ? destination : original);
        try {
          await db.backup(`${destination}.capture`);
        } finally {
          db.close();
        }
        renameSync(`${destination}.capture`, destination);
        chmodSync(destination, mode);
      }
    }
    if (verifiedParent) {
      captureDb = captureDatabase(staging.container, input.workspaceId);
      protectCapture(captureDb, input.workspaceId, input.backupId);
    }
    // Mutable files and every SQLite copy are independent now. Only append-only native digest objects remain live-source dependent.
    if (live) {
      resumeNative?.();
      resumeNative = undefined;
      if (input.purpose === 'backup') {
        releaseFreeze?.();
        releaseFreeze = undefined;
      }
      live.currentAuthority?.();
    }
    const facts = liveFacts ?? graph(staging.container, input.workspaceId);
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
    const core = live ? live.coreDb.sqlite : database(corePath);
    let hasRecurring = false;
    let accounts: WorkspaceBackupManifest['accounts'];
    try {
      const owner =
        liveCut?.accounts.ownerId ??
        (core
          .prepare('SELECT owner_user_id FROM workspace_registry WHERE workspace_id=?')
          .pluck()
          .get(input.workspaceId) as string | undefined);
      if (!isEntityId('usr', owner)) refuse('workspace-unavailable');
      const memberIds =
        liveCut?.accounts.memberIds ??
        (core
          .prepare(
            "SELECT user_id FROM workspace_members WHERE workspace_id=? AND status='active' ORDER BY user_id"
          )
          .pluck()
          .all(input.workspaceId) as string[]);
      // Core owns native rows. Its existing portable owner emits inert history, never queue authority.
      const recurring =
        liveCut?.recurring ??
        exportRecurringPortableHistory(
          bindCoreSqlite(core, staging.container),
          input.workspaceId,
          facts.inheritedRecurring,
          [...facts.references.turns].map(([id, threadId]) => ({ id, threadId }))
        );
      validateRecurringPortableHistory(JSON.stringify(recurring));
      hasRecurring =
        facts.inheritedRecurring !== null ||
        recurring.schedules.length > 0 ||
        recurring.occurrences.length > 0 ||
        recurring.expiredRanges.length > 0;
      if (hasRecurring) {
        mkdirSync(join(staging.workspaceRoot, 'records'), { mode: 0o700 });
        const portableFiles = new Map<string, string>();
        for (const [family, path] of Object.entries(RECURRING_PORTABLE_PATHS)) {
          const rows = recurring[family as keyof typeof RECURRING_PORTABLE_PATHS];
          const text = rows.map((row) => `${JSON.stringify(row)}\n`).join('');
          writeFileSync(join(staging.workspaceRoot, path), text, { flag: 'wx', mode: 0o600 });
          portableFiles.set(path, text);
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
      if (!live) core.close();
    }
    if (verifiedParent && !isDeepStrictEqual(verifiedParent, parent(sourceRoot)))
      refuse('parent-backup-invalid');
    const startedAt = inspectCapture(captureDb!, input.workspaceId, input.backupId)!.createdAt;
    // Close before inventory: no WAL/SHM or active SQLite handle travels.
    captureDb?.sqlite.close();
    captureDb = undefined;
    closePrivateBytes(staging.workspaceRoot);
    const inventory = [
      ...files(staging.workspaceRoot).map((path) => ({
        path,
        bytes: lstatSync(join(staging!.workspaceRoot, path)).size,
        sha256: copyBytes(join(staging!.workspaceRoot, path)),
        mode: lstatSync(join(staging!.workspaceRoot, path)).mode & 0o777,
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
      const objectRoot = join(dirname(output), 'objects');
      ensureCanonicalDirectory(objectRoot);
      for (const entry of inventory) {
        reservation.assertAvailable();
        const object = join(objectRoot, entry.sha256.slice(7));
        if (existsSync(object)) {
          await copyStorageFile({
            sourcePath: object,
            expectedBytes: entry.bytes,
            expectedSha256: entry.sha256,
            maxBytes: 2_147_483_648,
          });
        } else {
          const original = immutableCut.some((item) => item.path === entry.path)
            ? join(sourceWorkspace, entry.path)
            : join(staging.workspaceRoot, entry.path);
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
      live.currentAuthority?.();
    }
    const metadata = `${JSON.stringify(manifest)}\n`;
    const manifestDigest = digest(metadata);
    writeFileSync(join(staging.workspaceRoot, 'manifest.json'), metadata, {
      flag: 'wx',
      mode: 0o600,
    });
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
    prune(staging.workspaceRoot);
    syncCanonicalTree(staging.workspaceRoot);
    if (input.purpose === 'backup') {
      writeFileSync(
        join(staging.workspaceRoot, 'seal.json'),
        JSON.stringify({
          format: 'openkit-workspace-backup-seal',
          version: 1,
          backupId: input.backupId,
          purpose: input.purpose,
          manifestDigest,
        }),
        { flag: 'wx', mode: 0o600 }
      );
      syncCanonicalTree(staging.workspaceRoot);
      if (!live)
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
      live.currentAuthority?.();
      if (input.purpose === 'backup')
        await publishDurableFile({
          destinationPath: join(output, 'seal.json'),
          bytes: readFileSync(join(staging.workspaceRoot, 'seal.json')),
        });
      live.currentAuthority?.();
    } else publishCanonicalPath(staging.workspaceRoot, output);
    if (input.purpose === 'backup') {
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
      const core = live?.coreDb ?? openExistingCoreDbWithIntegrityCheck(sourceRoot);
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
        if (!live) core.sqlite.close();
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
    resumeNative?.();
    if (!retainMoveFence) releaseFreeze?.();
    captureDb?.sqlite.close();
    lock?.release();
    if (staging) rmSync(staging.container, { recursive: true, force: true });
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

/** Complete online operator joins; existing backup, bundle and Kernel owners retain their decisions. */
export function createWorkspaceSnapshotOperationImplementations(
  dependencies: OperationInvocationDependencies
) {
  type Definitions = typeof WORKSPACE_SNAPSHOT_OPERATION_DEFINITIONS;
  type Input<K extends keyof Definitions> = import('zod').infer<Definitions[K]['inputSchema']>;
  // Offline domain refusals keep their existing safe identities in the online operation envelope.
  const invoke = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof WorkspaceRecoveryError || error instanceof WorkspaceBackupBundleError)
        throw new OperationError(error.code, error.message, 409, { cause: error });
      throw error;
    }
  };
  const policy = (context: AdmittedOperationContext) => {
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
  };
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
        snapshotSource: { dataRoot: owned.dataRoot, source: { kind: 'local-snapshot', ...input } },
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
              dataRoot: owned.dataRoot,
              source: { kind: 'local-snapshot', ...input },
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
