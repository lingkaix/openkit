import { randomUUID } from 'node:crypto';
import {
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
import { RequestIdSchema, TimestampSchema, WorkspaceIdSchema } from '@openkit/protocol';
import { z } from 'zod';

import {
  assertCanonicalDirectory,
  assertSafeWorkspacePathSegment,
} from './storage/workspace-file-records.js';

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
    originalOwnerUserId: z.string().min(1),
    expectedRegistryRevision: z.number().int().positive(),
    confirmation: z.string().min(1),
    createdAt: TimestampSchema,
    phase: WorkspaceDeletionPhaseSchema,
    recoveryExportId: z.string().min(1).nullable(),
    recoveryExportManifestDigest: z.string().min(1).nullable(),
    closureId: z.string().min(1).nullable(),
    closureDigest: z.string().min(1).nullable(),
    stagingRelativePath: z.string().min(1).nullable(),
    terminalAuditEventId: z.string().min(1).nullable(),
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
