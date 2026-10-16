import { randomUUID } from 'node:crypto';
import {
  type BigIntStats,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { WorkspaceDeletionPhaseSchema } from '@openkit/app-api-schemas';
import {
  AuditEventIdSchema,
  deriveEntityId,
  RequestIdSchema,
  TimestampSchema,
  UserIdSchema,
  WorkspaceExportIdSchema,
  WorkspaceIdSchema,
} from '@openkit/protocol';
import { z } from 'zod';
import type { CoreDb } from './storage/db.js';

import {
  assertCanonicalDirectory,
  assertSafeWorkspacePathSegment,
} from './storage/workspace-file-records.js';
import { getWorkspaceRegistryLifecycleFact } from './workspace-sharing.js';

const WORKSPACE_DELETION_PHASES = [
  'requested',
  'fenced',
  'blocked',
  'deleting',
  'exported',
  'closure-sealed',
  'staged',
  'deleted',
  'cleaned',
] as const;

/** Strict durable state owned by one Workspace deletion request. */
export const WorkspaceDeletionRequestRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: WorkspaceIdSchema,
    requestId: RequestIdSchema,
    originalOwnerUserId: UserIdSchema,
    expectedRegistryRevision: z.number().int().positive(),
    confirmation: z.string().min(1),
    createdAt: TimestampSchema,
    phase: WorkspaceDeletionPhaseSchema,
    recoveryExportId: WorkspaceExportIdSchema.nullable(),
    recoveryExportManifestDigest: z.string().min(1).nullable(),
    closureId: z.string().min(1).nullable(),
    closureDigest: z.string().min(1).nullable(),
    stagingRelativePath: z.string().min(1).nullable(),
    terminalAuditEventId: AuditEventIdSchema.nullable(),
    commandReceiptKey: z.string().min(1).nullable(),
    retainedStaging: z.boolean(),
    cleanedAt: TimestampSchema.nullable(),
  })
  .strict()
  .superRefine((record, context) => {
    if (
      record.stagingRelativePath !== null &&
      record.stagingRelativePath !==
        workspaceDeletionStagingRelativePath(record.workspaceId, record.requestId)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Deletion staging path must match the request-owned canonical path.',
        path: ['stagingRelativePath'],
      });
    }
    if ((record.phase === 'cleaned') !== (record.cleanedAt !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Only a cleaned deletion request may carry cleanedAt.',
        path: ['cleanedAt'],
      });
    }
    const phaseCarries = (firstPhase: (typeof WORKSPACE_DELETION_PHASES)[number]) =>
      WORKSPACE_DELETION_PHASES.indexOf(record.phase) >=
      WORKSPACE_DELETION_PHASES.indexOf(firstPhase);
    for (const [field, expected] of [
      ['recoveryExportId', phaseCarries('exported')],
      ['recoveryExportManifestDigest', phaseCarries('exported')],
      ['closureId', phaseCarries('closure-sealed')],
      ['closureDigest', phaseCarries('closure-sealed')],
      ['stagingRelativePath', phaseCarries('staged')],
      ['terminalAuditEventId', phaseCarries('deleted')],
      ['commandReceiptKey', phaseCarries('deleted')],
    ] as const) {
      if ((record[field] !== null) !== expected) {
        context.addIssue({
          code: 'custom',
          message: `${field} contradicts the deletion phase.`,
          path: [field],
        });
      }
    }
    if (record.retainedStaging && record.phase !== 'deleted') {
      context.addIssue({
        code: 'custom',
        message: 'Only deleted cleanup-pending state may retain staging.',
        path: ['retainedStaging'],
      });
    }
  });

/** Strict durable state owned by one Workspace deletion request. */
export type WorkspaceDeletionRequestRecord = z.infer<typeof WorkspaceDeletionRequestRecordSchema>;

/** Returns whether a deletion request no longer owns resumable work. */
export function isTerminalWorkspaceDeletionRequest(
  record: WorkspaceDeletionRequestRecord
): boolean {
  return record.phase === 'blocked' || record.phase === 'cleaned';
}

/** Reads every strict deletion request for one Workspace in request-id order. */
export function listWorkspaceDeletionRequests(
  dataRoot: string,
  workspaceId: string
): WorkspaceDeletionRequestRecord[] {
  const workspaceRoot = workspaceDeletionWorkspaceRoot(dataRoot, workspaceId);
  if (!existsSync(workspaceRoot)) {
    return [];
  }
  assertCanonicalDirectory(workspaceRoot);
  return readdirSync(workspaceRoot)
    .sort()
    .map((requestId) => readWorkspaceDeletionRequest(dataRoot, workspaceId, requestId));
}

/** Reads every strict deletion request across Workspaces in durable path order. */
export function listAllWorkspaceDeletionRequests(
  dataRoot: string
): WorkspaceDeletionRequestRecord[] {
  const root = join(dataRoot, 'server', 'exports', 'workspace-deletions');
  if (!existsSync(root)) {
    return [];
  }
  assertCanonicalDirectory(root);
  return readdirSync(root)
    .sort()
    .flatMap((workspaceId) => listWorkspaceDeletionRequests(dataRoot, workspaceId));
}

/**
 * Visits a bounded prefix of canonical deletion requests in durable path order.
 *
 * Directory names are the existing owner's index, not discovered Workspace content. Record
 * reads stop at the admitted ceiling or when the consumer refuses an item. Directory and file
 * identity checks report concurrent replacement without retrying or advancing deletion.
 *
 * @param dataRoot Existing deployment storage root.
 * @param maxEntries Maximum strict request records to read.
 * @param accept Admits an observation, returning false to stop before later records.
 * @returns Coverage of this read, without a guessed total.
 */
export function visitWorkspaceDeletionRequests(
  dataRoot: string,
  maxEntries: number,
  accept: (record: WorkspaceDeletionRequestRecord) => boolean
): { limited: boolean; changed: boolean } {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) {
    throw new RangeError('Deletion observation requires a nonnegative record ceiling.');
  }
  const root = join(dataRoot, 'server', 'exports', 'workspace-deletions');
  let before: BigIntStats;
  try {
    before = lstatSync(root, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { limited: false, changed: false };
    }
    throw error;
  }
  assertCanonicalDirectory(root);
  let visited = 0;
  let changed = false;
  for (const workspaceId of readdirSync(root).sort()) {
    const workspaceRoot = workspaceDeletionWorkspaceRoot(dataRoot, workspaceId);
    assertCanonicalDirectory(workspaceRoot);
    const workspaceBefore = lstatSync(workspaceRoot, { bigint: true });
    for (const requestId of readdirSync(workspaceRoot).sort()) {
      if (visited === maxEntries) return { limited: true, changed };
      const requestPath = workspaceDeletionRequestPath(dataRoot, workspaceId, requestId);
      const requestBefore = lstatSync(requestPath, { bigint: true });
      const record = readWorkspaceDeletionRequest(dataRoot, workspaceId, requestId);
      const requestAfter = lstatSync(requestPath, { bigint: true });
      visited += 1;
      if (fileIdentity(requestBefore) !== fileIdentity(requestAfter)) {
        return { limited: false, changed: true };
      }
      if (!accept(record)) return { limited: true, changed };
    }
    changed ||=
      fileIdentity(workspaceBefore) !== fileIdentity(lstatSync(workspaceRoot, { bigint: true }));
  }
  changed ||= fileIdentity(before) !== fileIdentity(lstatSync(root, { bigint: true }));
  return { limited: false, changed };
}

/** Captures record/index replacement without interpreting a filesystem time as cleanup proof. */
function fileIdentity(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

/** Reads one exact strict Workspace deletion request. */
export function readWorkspaceDeletionRequest(
  dataRoot: string,
  workspaceId: string,
  requestId: string
): WorkspaceDeletionRequestRecord {
  const requestPath = workspaceDeletionRequestPath(dataRoot, workspaceId, requestId);
  const requestRoot = dirname(requestPath);
  assertCanonicalDirectory(requestRoot);
  const stat = lstatSync(requestPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Workspace deletion request is not a canonical regular file.');
  }
  const record = WorkspaceDeletionRequestRecordSchema.parse(
    JSON.parse(readFileSync(requestPath, 'utf8'))
  );
  if (record.workspaceId !== workspaceId || record.requestId !== requestId) {
    throw new Error('Workspace deletion request path does not match its durable identity.');
  }
  return record;
}

/** Creates one previously absent private Workspace deletion request. */
export function createWorkspaceDeletionRequest(
  dataRoot: string,
  input: Pick<
    WorkspaceDeletionRequestRecord,
    | 'confirmation'
    | 'createdAt'
    | 'expectedRegistryRevision'
    | 'originalOwnerUserId'
    | 'requestId'
    | 'workspaceId'
  >
): WorkspaceDeletionRequestRecord {
  const record = WorkspaceDeletionRequestRecordSchema.parse({
    ...input,
    schemaVersion: 1,
    phase: 'requested',
    recoveryExportId: null,
    recoveryExportManifestDigest: null,
    closureId: null,
    closureDigest: null,
    stagingRelativePath: null,
    terminalAuditEventId: null,
    commandReceiptKey: null,
    retainedStaging: false,
    cleanedAt: null,
  });
  const requestPath = workspaceDeletionRequestPath(dataRoot, input.workspaceId, input.requestId);
  const requestRoot = dirname(requestPath);
  const workspaceRoot = dirname(requestRoot);
  const deletionsRoot = dirname(workspaceRoot);
  mkdirPrivate(deletionsRoot);
  fsyncDirectory(dirname(deletionsRoot));
  mkdirPrivate(workspaceRoot);
  fsyncDirectory(deletionsRoot);
  mkdirSync(requestRoot, { mode: 0o700 });
  chmodSync(requestRoot, 0o700);
  writePrivateFile(requestPath, record, 'wx');
  fsyncDirectory(requestRoot);
  fsyncDirectory(workspaceRoot);
  return record;
}

/** Atomically replaces one existing Workspace deletion request in its owning directory. */
export function writeWorkspaceDeletionRequest(
  dataRoot: string,
  record: WorkspaceDeletionRequestRecord
): WorkspaceDeletionRequestRecord {
  const parsed = WorkspaceDeletionRequestRecordSchema.parse(record);
  const requestPath = workspaceDeletionRequestPath(dataRoot, parsed.workspaceId, parsed.requestId);
  const requestRoot = dirname(requestPath);
  assertCanonicalDirectory(requestRoot);
  const temporaryPath = join(requestRoot, `.request-${randomUUID()}.tmp`);
  try {
    writePrivateFile(temporaryPath, parsed, 'wx');
    renameSync(temporaryPath, requestPath);
    fsyncDirectory(requestRoot);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  return parsed;
}

/** Returns the data-root-relative staging path owned by one deletion request. */
export function workspaceDeletionStagingRelativePath(
  workspaceId: string,
  requestId: string
): string {
  assertSafeWorkspacePathSegment(workspaceId, 'Workspace id');
  assertSafeWorkspacePathSegment(requestId, 'Deletion request id');
  return `server/deletion-staging/${workspaceId}/${requestId}`;
}

function workspaceDeletionWorkspaceRoot(dataRoot: string, workspaceId: string): string {
  assertSafeWorkspacePathSegment(workspaceId, 'Workspace id');
  return join(dataRoot, 'server', 'exports', 'workspace-deletions', workspaceId);
}

function workspaceDeletionRequestPath(
  dataRoot: string,
  workspaceId: string,
  requestId: string
): string {
  assertSafeWorkspacePathSegment(requestId, 'Deletion request id');
  return join(workspaceDeletionWorkspaceRoot(dataRoot, workspaceId), requestId, 'request.json');
}

function mkdirPrivate(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { mode: 0o700, recursive: true });
  }
  assertCanonicalDirectory(path);
  chmodSync(path, 0o700);
}

function writePrivateFile(path: string, value: WorkspaceDeletionRequestRecord, flag: 'wx'): void {
  const descriptor = openSync(path, flag, 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, 0o600);
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Canonical context for the one private recovery export admitted by a deletion request. */
export interface WorkspaceDeletionRecoveryExportContext {
  readonly authorityUserId: string;
  readonly coreDb: CoreDb | undefined;
  readonly dataRoot: string;
  readonly exportId: string;
  readonly requestId: string;
  readonly workspaceId: string;
}

/** Verifies current exact deletion authority; no caller-selected boolean grants private history. */
export function assertWorkspaceDeletionRecoveryExportAuthority(
  input: WorkspaceDeletionRecoveryExportContext
): true {
  if (!input.coreDb)
    throw new Error('Workspace deletion recovery export requires durable authority.');
  const request = readWorkspaceDeletionRequest(input.dataRoot, input.workspaceId, input.requestId);
  const registry = getWorkspaceRegistryLifecycleFact(input.coreDb, input.workspaceId);
  if (
    request.phase !== 'deleting' ||
    request.workspaceId !== input.workspaceId ||
    request.originalOwnerUserId !== input.authorityUserId ||
    request.recoveryExportId !== null ||
    request.recoveryExportManifestDigest !== null ||
    input.exportId !== deriveEntityId('wsexp', ['delete', request.requestId]) ||
    registry?.status !== 'deleting' ||
    registry.ownerUserId !== request.originalOwnerUserId ||
    registry.registryRevision !== request.expectedRegistryRevision + 1
  )
    throw new Error('Workspace deletion recovery export authority is inconsistent.');
  return true;
}
