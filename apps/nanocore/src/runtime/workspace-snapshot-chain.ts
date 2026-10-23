import { createHash } from 'node:crypto';
import { lstat, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  AgentSessionIdSchema,
  readRetainedV1,
  ThreadIdSchema,
  TimestampSchema,
  TurnIdSchema,
  WorkerStorageTargetIdSchema,
  WorkspaceIdSchema,
  writeRetainedV1,
} from '@openkit/protocol';
import { z } from 'zod';
import { OperationError } from '../operation-error.js';
import type { FileStorageAdmission } from '../storage/artifacts/file-admission.js';
import type { WorkspaceDb } from '../storage/db.js';
import {
  assertCanonicalDirectory,
  ensureCanonicalDirectoryAsync,
  publishCanonicalPathAsync,
  readCanonicalFile,
  syncCanonicalDirectoryAsync,
  syncCanonicalTreeAsync,
} from '../storage/workspace-file-records.js';
import {
  sameWorkspaceSnapshot,
  WorkspaceCollectionError,
  type WorkspaceSnapshotPair,
} from './workspace-collect-wire.js';

/** Frozen retained v1 snapshot references; transport schema changes do not reinterpret saved pairs. */
const StoredWorkspaceSnapshotPairV1Schema = z.object({
  tree: z.string().regex(/^[0-9a-f]{40}$/),
  manifest: z.string().regex(/^[0-9a-f]{40}$/),
});

/** Exact admitted volume and collection lineage; no private credentials enter these records. */
export const WorkspaceCollectionIdentitySchema = z.object({
  workspaceId: WorkspaceIdSchema,
  storageRef: WorkerStorageTargetIdSchema,
  scopeDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  workSlot: z.string().min(1),
  attachmentGeneration: z.number().int().positive(),
  sandboxId: z.string().min(1),
  collectionId: z.string().min(1),
  agentSessionId: AgentSessionIdSchema,
  threadId: ThreadIdSchema,
  turnId: TurnIdSchema,
  packageSnapshotId: z.string().min(1),
});
/** Known identity core; the reader ignores additive stored evidence. */
export type WorkspaceCollectionIdentity = z.infer<typeof WorkspaceCollectionIdentitySchema>;

/** Core-owned accepted state and independent captured-state cursor. */
export interface WorkspaceSnapshotCursor {
  acceptedBase: WorkspaceSnapshotPair;
  head: WorkspaceSnapshotPair;
  acceptedCommit: string | null;
}
/** Immutable scan receipt, including observations and cumulative candidate bytes. */
export interface WorkspaceCollectionReceipt {
  identity: WorkspaceCollectionIdentity;
  result: Record<string, unknown>;
  candidate: Buffer | null;
  isLink: boolean;
  credentialCheck: 'passed';
}
// Committed records are still an admission boundary after restart; additive evidence remains readable.
const StoredCollectionResultSchema = z
  .discriminatedUnion('outcome', [
    z
      .object({
        outcome: z.literal('candidate'),
        sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
        byteLength: z
          .number()
          .int()
          .positive()
          .max(256 * 1024 * 1024),
        head: StoredWorkspaceSnapshotPairV1Schema,
        previousHead: StoredWorkspaceSnapshotPairV1Schema,
        acceptedBase: StoredWorkspaceSnapshotPairV1Schema,
        unstable: z.boolean(),
      })
      .passthrough(),
    z
      .object({
        outcome: z.literal('empty'),
        head: StoredWorkspaceSnapshotPairV1Schema,
        previousHead: StoredWorkspaceSnapshotPairV1Schema,
        acceptedBase: StoredWorkspaceSnapshotPairV1Schema,
        unstable: z.boolean(),
      })
      .passthrough(),
    z.object({ outcome: z.literal('no_new_head'), unstable: z.boolean() }).passthrough(),
  ])
  .and(
    z
      .object({
        credentialCheck: z.literal('passed'),
        collectedAt: TimestampSchema.pipe(z.iso.datetime({ offset: true })),
        acceptedCommit: z
          .string()
          .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
          .nullable(),
        pendingEarlierLinks: z.array(z.string().min(1)),
      })
      .passthrough()
  );
/** Reads both durable snapshot components without substituting a review commit. */
export function readWorkspaceSnapshotCursor(
  db: WorkspaceDb,
  identity: Pick<WorkspaceCollectionIdentity, 'workspaceId' | 'storageRef' | 'workSlot'>
): WorkspaceSnapshotCursor | null {
  const row = db.sqlite
    .prepare(
      'SELECT schema_version AS schemaVersion, accepted_base_json, head_json, accepted_commit FROM workspace_snapshot_cursors WHERE workspace_id = ? AND storage_ref = ? AND work_slot = ?'
    )
    .get(identity.workspaceId, identity.storageRef, identity.workSlot) as
    | {
        schemaVersion: unknown;
        accepted_base_json: string | null;
        head_json: string | null;
        accepted_commit: string | null;
      }
    | undefined;
  if (row) readRetainedV1(row, () => undefined);
  if (row && (row.accepted_base_json === null) !== (row.head_json === null))
    throw new z.ZodError([
      { code: 'custom', message: 'Workspace snapshot cursor is partially initialized.', path: [] },
    ]);
  return row && row.accepted_base_json !== null && row.head_json !== null
    ? {
        acceptedBase: StoredWorkspaceSnapshotPairV1Schema.parse(JSON.parse(row.accepted_base_json)),
        head: StoredWorkspaceSnapshotPairV1Schema.parse(JSON.parse(row.head_json)),
        acceptedCommit: z
          .string()
          .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
          .nullable()
          .parse(row.accepted_commit),
      }
    : null;
}
/** Reads the exact committed collection identity for restart without another scan. */
export function readWorkspaceCollection(
  db: WorkspaceDb,
  identity: WorkspaceCollectionIdentity
): WorkspaceCollectionReceipt | null {
  const row = db.sqlite
    .prepare(
      'SELECT schema_version AS schemaVersion, identity_json, result_json, candidate, is_link FROM workspace_snapshot_collections WHERE workspace_id = ? AND storage_ref = ? AND work_slot = ? AND collection_id = ?'
    )
    .get(identity.workspaceId, identity.storageRef, identity.workSlot, identity.collectionId) as
    | {
        schemaVersion: unknown;
        identity_json: string;
        result_json: string;
        candidate: Buffer | null;
        is_link: number;
      }
    | undefined;
  if (!row) return null;
  readRetainedV1(row, () => undefined);
  const stored = WorkspaceCollectionIdentitySchema.parse(JSON.parse(row.identity_json));
  if (!isDeepStrictEqual(stored, WorkspaceCollectionIdentitySchema.parse(identity)))
    throw new z.ZodError([
      {
        code: 'custom',
        message: 'Workspace collection identity conflicts with its committed receipt.',
        path: [],
      },
    ]);
  const result = StoredCollectionResultSchema.parse(JSON.parse(row.result_json));
  if (row.is_link !== (result.outcome === 'no_new_head' && result.unstable === false ? 0 : 1))
    throw new z.ZodError([
      { code: 'custom', message: 'Workspace collection link evidence is invalid.', path: [] },
    ]);
  if (result.outcome === 'no_new_head' && result.unstable === true) {
    for (const field of ['head', 'previousHead', 'acceptedBase'])
      StoredWorkspaceSnapshotPairV1Schema.parse(result[field]);
  }
  if (
    result.outcome === 'candidate'
      ? !row.candidate ||
        row.candidate.length !== result.byteLength ||
        `sha256:${createHash('sha256').update(row.candidate).digest('hex')}` !== result.sha256
      : row.candidate !== null
  )
    throw new z.ZodError([
      {
        code: 'custom',
        message: 'Workspace collection committed candidate identity is invalid.',
        path: [],
      },
    ]);
  return {
    identity: stored,
    result,
    candidate: row.candidate,
    isLink: row.is_link === 1,
    credentialCheck: 'passed',
  };
}
/** Checks current or historical accepted commit context through the same validated durable readers used for replay. */
export function workspaceSnapshotAcceptedCommitIsKnown(
  db: WorkspaceDb,
  workspaceId: string,
  workSlot: string,
  threadId: string,
  commit: string
): boolean {
  const proofs = db.sqlite
    .prepare(`
    SELECT schema_version AS schemaVersion, 'cursor' AS kind, storage_ref AS storageRef, baseline_identity_json AS identity
    FROM workspace_snapshot_cursors
    WHERE workspace_id=? AND work_slot=? AND accepted_commit=?
    UNION ALL
    SELECT schema_version AS schemaVersion, 'collection' AS kind, storage_ref AS storageRef, identity_json AS identity
    FROM workspace_snapshot_collections WHERE workspace_id=? AND work_slot=?
  `)
    .all(workspaceId, workSlot, commit, workspaceId, workSlot) as {
    schemaVersion: unknown;
    kind: 'cursor' | 'collection';
    storageRef: string;
    identity: string;
  }[];
  return proofs.some((proof) =>
    readRetainedV1(proof, () => {
      const identity = WorkspaceCollectionIdentitySchema.parse(JSON.parse(proof.identity));
      if (identity.threadId !== threadId) return false;
      return proof.kind === 'cursor'
        ? readWorkspaceSnapshotCursor(db, { workspaceId, storageRef: proof.storageRef, workSlot })
            ?.acceptedCommit === commit
        : readWorkspaceCollection(db, identity)?.result.acceptedCommit === commit;
    })
  );
}

/** Records only the exact first initialization authority; it names no accepted pair or captured head. */
export function authorizeWorkspaceBaselineInitialization(
  db: WorkspaceDb,
  identity: WorkspaceCollectionIdentity
): void {
  const existing = db.sqlite
    .prepare(
      'SELECT schema_version AS schemaVersion FROM workspace_snapshot_cursors WHERE workspace_id=? AND storage_ref=? AND work_slot=?'
    )
    .get(identity.workspaceId, identity.storageRef, identity.workSlot);
  if (existing) readRetainedV1(existing, () => undefined);
  db.sqlite
    .prepare(
      'INSERT INTO workspace_snapshot_cursors (workspace_id, storage_ref, work_slot, accepted_base_json, head_json, baseline_identity_json, schema_version) VALUES (?, ?, ?, NULL, NULL, ?, ?) ON CONFLICT DO NOTHING'
    )
    .run(
      identity.workspaceId,
      identity.storageRef,
      identity.workSlot,
      JSON.stringify(identity),
      writeRetainedV1({}).schemaVersion
    );
}
/** Requires the same unfinished initialization, never a retained unrelated slot. */
export function requireWorkspaceBaselineInitialization(
  db: WorkspaceDb,
  identity: WorkspaceCollectionIdentity
): void {
  const row = db.sqlite
    .prepare(
      'SELECT schema_version AS schemaVersion, baseline_identity_json FROM workspace_snapshot_cursors WHERE workspace_id = ? AND storage_ref = ? AND work_slot = ?'
    )
    .get(identity.workspaceId, identity.storageRef, identity.workSlot) as
    | { schemaVersion: unknown; baseline_identity_json: string }
    | undefined;
  const stored =
    row &&
    readRetainedV1(row, () =>
      WorkspaceCollectionIdentitySchema.safeParse(JSON.parse(row.baseline_identity_json))
    );
  if (
    !stored?.success ||
    !isDeepStrictEqual(stored.data, WorkspaceCollectionIdentitySchema.parse(identity))
  )
    throw new WorkspaceCollectionError({
      outcome: 'recovery_required',
      cause: 'accepted_base_unknown',
    });
}
/**
 * Atomically initializes base and cursor after Git pin verification, or verifies the independently derived non-Git tree.
 * @param expectedTree Independently supplied non-Git tree, or null after the caller verifies a Git commit pin.
 * @param acceptedCommit Verified Git source pin, or null for non-Git initialization.
 */
export function acceptWorkspaceBaseline(
  db: WorkspaceDb,
  identity: WorkspaceCollectionIdentity,
  head: WorkspaceSnapshotPair,
  expectedTree: string | null,
  acceptedCommit: string | null = null
): void {
  const pair = StoredWorkspaceSnapshotPairV1Schema.parse(head);
  if (
    expectedTree === null
      ? acceptedCommit === null || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(acceptedCommit)
      : !/^[0-9a-f]{40}$/.test(expectedTree)
  )
    throw new WorkspaceCollectionError({
      outcome: 'recovery_required',
      cause: 'baseline_source_unavailable',
    });
  if (expectedTree !== null && pair.tree !== expectedTree)
    throw new WorkspaceCollectionError({
      outcome: 'recovery_required',
      cause: 'baseline_mismatch',
    });
  db.sqlite.transaction(() => {
    requireWorkspaceBaselineInitialization(db, identity);
    const cursor = readWorkspaceSnapshotCursor(db, identity);
    if (cursor) {
      if (!sameWorkspaceSnapshot(cursor.acceptedBase, pair))
        throw new Error('Workspace baseline identity conflicts with the retained cursor.');
      return;
    }
    db.sqlite
      .prepare(
        'UPDATE workspace_snapshot_cursors SET accepted_base_json = ?, head_json = ?, accepted_commit = ? WHERE workspace_id = ? AND storage_ref = ? AND work_slot = ?'
      )
      .run(
        JSON.stringify(pair),
        JSON.stringify(pair),
        acceptedCommit,
        identity.workspaceId,
        identity.storageRef,
        identity.workSlot
      );
  })();
}
/** Commits one contiguous capture and its candidate in the same transaction as cursor advance. */
export function acceptWorkspaceCapture(
  db: WorkspaceDb,
  identity: WorkspaceCollectionIdentity,
  result: Record<string, unknown>,
  candidate: Buffer | null,
  preserved?: RawWorkspaceCapture
): WorkspaceCollectionReceipt {
  if (
    preserved &&
    (!isDeepStrictEqual(preserved.identity, identity) ||
      !isDeepStrictEqual(preserved.candidate, candidate))
  )
    throw new Error('Preserved Workspace capture contradicts its publication.');
  const body = () => {
    const candidateIdentity = candidate
      ? {
          byteLength: candidate.length,
          sha256: `sha256:${createHash('sha256').update(candidate).digest('hex')}`,
        }
      : {};
    if (
      result.outcome === 'candidate' &&
      ((result.byteLength !== undefined && result.byteLength !== candidateIdentity.byteLength) ||
        (result.sha256 !== undefined && result.sha256 !== candidateIdentity.sha256))
    )
      throw new Error('Workspace collection candidate identity disagrees with its bytes.');
    const known = readWorkspaceCollection(db, identity);
    if (known) {
      if (
        !isDeepStrictEqual(
          known.result,
          result.outcome === 'no_new_head' && result.unstable === true
            ? {
                ...result,
                ...candidateIdentity,
                credentialCheck: 'passed',
                collectedAt: known.result.collectedAt,
                acceptedCommit: known.result.acceptedCommit,
                pendingEarlierLinks: known.result.pendingEarlierLinks,
                previousHead: known.result.previousHead,
                head: known.result.head,
                acceptedBase: known.result.acceptedBase,
              }
            : {
                ...result,
                ...candidateIdentity,
                credentialCheck: 'passed',
                collectedAt: known.result.collectedAt,
                acceptedCommit: known.result.acceptedCommit,
                pendingEarlierLinks: known.result.pendingEarlierLinks,
              }
        ) ||
        !isDeepStrictEqual(known.candidate, candidate)
      )
        throw new Error('Workspace collection replay disagrees with its committed bytes.');
      return known;
    }
    const cursor = readWorkspaceSnapshotCursor(db, identity);
    if (!cursor)
      throw new WorkspaceCollectionError({
        outcome: 'recovery_required',
        cause: 'accepted_base_unknown',
      });
    const changed = result.outcome === 'candidate' || result.outcome === 'empty';
    const observation = result.outcome === 'no_new_head' && result.unstable === true;
    if (!changed && result.outcome !== 'no_new_head')
      throw new Error('Failed workspace collection cannot advance its cursor.');
    let head = cursor.head;
    if (changed) {
      const previous = StoredWorkspaceSnapshotPairV1Schema.parse(result.previousHead);
      const accepted = StoredWorkspaceSnapshotPairV1Schema.parse(result.acceptedBase);
      head = StoredWorkspaceSnapshotPairV1Schema.parse(result.head);
      if (!sameWorkspaceSnapshot(previous, cursor.head))
        throw new WorkspaceCollectionError({
          outcome: 'recovery_required',
          cause: 'previous_head_mismatch',
        });
      if (!sameWorkspaceSnapshot(accepted, cursor.acceptedBase))
        throw new WorkspaceCollectionError({
          outcome: 'recovery_required',
          cause: 'accepted_base_unknown',
        });
      if (sameWorkspaceSnapshot(head, previous))
        throw new Error('Changed workspace collection has no new head.');
      if (
        result.outcome === 'empty' &&
        (!sameWorkspaceSnapshot(head, accepted) || candidate !== null)
      )
        throw new Error('Empty workspace candidate disagrees with the accepted base.');
      if (
        result.outcome === 'candidate' &&
        (!candidate || candidate.length === 0 || sameWorkspaceSnapshot(head, accepted))
      )
        throw new Error('Workspace candidate is empty or contradicts its accepted base.');
    } else if (candidate !== null || typeof result.unstable !== 'boolean')
      throw new Error('Unchanged workspace collection carries invalid candidate or stability.');
    const pendingEarlierLinks =
      result.outcome === 'candidate'
        ? (
            db.sqlite
              .prepare(
                "SELECT c.schema_version AS schemaVersion,c.collection_id FROM workspace_snapshot_collections c JOIN staged_workspace_reviews r ON r.workspace_id = c.workspace_id AND r.change_set_id = c.change_set_id WHERE c.workspace_id = ? AND c.storage_ref = ? AND c.work_slot = ? AND r.status = 'pending' ORDER BY c.rowid"
              )
              .all(identity.workspaceId, identity.storageRef, identity.workSlot) as {
              schemaVersion: unknown;
              collection_id: string;
            }[]
          ).map((row) => readRetainedV1(row, () => row.collection_id))
        : [];
    const checkedResult = {
      ...result,
      ...candidateIdentity,
      credentialCheck: 'passed',
      // Freeze the first durable capture time for output and review replay.
      collectedAt: new Date().toISOString(),
      acceptedCommit: cursor.acceptedCommit,
      pendingEarlierLinks,
    };
    const storedResult = observation
      ? {
          ...checkedResult,
          previousHead: cursor.head,
          head: cursor.head,
          acceptedBase: cursor.acceptedBase,
        }
      : checkedResult;
    const receipt = {
      identity,
      result: storedResult,
      candidate,
      isLink: changed || observation,
      credentialCheck: 'passed' as const,
    };
    db.sqlite
      .prepare(
        'INSERT INTO workspace_snapshot_collections (workspace_id, storage_ref, work_slot, collection_id, identity_json, result_json, candidate, is_link, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        identity.workspaceId,
        identity.storageRef,
        identity.workSlot,
        identity.collectionId,
        JSON.stringify(identity),
        JSON.stringify(storedResult),
        candidate,
        receipt.isLink ? 1 : 0,
        writeRetainedV1({}).schemaVersion
      );
    if (changed)
      db.sqlite
        .prepare(
          'UPDATE workspace_snapshot_cursors SET head_json = ? WHERE workspace_id = ? AND storage_ref = ? AND work_slot = ?'
        )
        .run(JSON.stringify(head), identity.workspaceId, identity.storageRef, identity.workSlot);
    return receipt;
  };
  let bodyFailure: unknown;
  let bodyFailed = false;
  try {
    return db.sqlite.transaction(() => {
      try {
        return body();
      } catch (error) {
        bodyFailed = true;
        bodyFailure = error;
        throw error;
      }
    })();
  } catch (error) {
    // better-sqlite3 rethrows the callback error only after rollback succeeds; COMMIT and
    // rollback errors take a different path. An absent transaction alone proves nothing.
    if (preserved && bodyFailed && error === bodyFailure)
      throw new PreservedWorkspaceCaptureRefusal(
        error instanceof Error ? error.message : 'Workspace capture SQL body was refused.',
        { cause: error }
      );
    throw error;
  }
}

/** Links an existing destination's durable review to its exact immutable candidate. */
export function linkWorkspaceSnapshotReview(
  db: WorkspaceDb,
  identity: WorkspaceCollectionIdentity,
  changeSetId: string
): void {
  const receipt = readWorkspaceCollection(db, identity);
  if (!receipt?.candidate) throw new Error('Workspace review has no committed candidate.');
  const row = db.sqlite
    .prepare(
      'SELECT change_set_id FROM workspace_snapshot_collections WHERE workspace_id = ? AND storage_ref = ? AND work_slot = ? AND collection_id = ?'
    )
    .get(identity.workspaceId, identity.storageRef, identity.workSlot, identity.collectionId) as {
    change_set_id: string | null;
  };
  if (row.change_set_id !== null && row.change_set_id !== changeSetId)
    throw new Error('Workspace collection review identity conflicts.');
  db.sqlite
    .prepare(
      'UPDATE workspace_snapshot_collections SET change_set_id = ? WHERE workspace_id = ? AND storage_ref = ? AND work_slot = ? AND collection_id = ?'
    )
    .run(
      changeSetId,
      identity.workspaceId,
      identity.storageRef,
      identity.workSlot,
      identity.collectionId
    );
}
/** Reads a real collection-to-review relation; identifiers are never interpreted as authority. */
function workspaceReviewCollection(
  db: WorkspaceDb,
  workspaceId: string,
  changeSetId: string
): WorkspaceCollectionReceipt | null {
  const row = db.sqlite
    .prepare(
      'SELECT schema_version AS schemaVersion, identity_json FROM workspace_snapshot_collections WHERE workspace_id = ? AND change_set_id = ?'
    )
    .get(workspaceId, changeSetId) as { schemaVersion: unknown; identity_json: string } | undefined;
  return row
    ? readRetainedV1(row, () =>
        readWorkspaceCollection(
          db,
          WorkspaceCollectionIdentitySchema.parse(JSON.parse(row.identity_json))
        )
      )
    : null;
}
/** Detects a later candidate whose immutable accepted base has already moved through apply. */
export function workspaceSnapshotReviewIsStale(
  db: WorkspaceDb,
  workspaceId: string,
  changeSetId: string
): boolean {
  const receipt = workspaceReviewCollection(db, workspaceId, changeSetId);
  if (!receipt) return false;
  const cursor = readWorkspaceSnapshotCursor(db, receipt.identity);
  return (
    !cursor ||
    !sameWorkspaceSnapshot(
      cursor.acceptedBase,
      StoredWorkspaceSnapshotPairV1Schema.parse(receipt.result.acceptedBase)
    )
  );
}
/** Advances the accepted base only after the existing apply owner proves success; cursor stays independent. */
export function acceptAppliedWorkspaceSnapshot(
  db: WorkspaceDb,
  workspaceId: string,
  changeSetId: string,
  acceptedCommit: string | null
): void {
  const receipt = workspaceReviewCollection(db, workspaceId, changeSetId);
  if (!receipt) return;
  const cursor = readWorkspaceSnapshotCursor(db, receipt.identity);
  const head = StoredWorkspaceSnapshotPairV1Schema.parse(receipt.result.head);
  if (cursor && sameWorkspaceSnapshot(cursor.acceptedBase, head)) return;
  if (workspaceSnapshotReviewIsStale(db, workspaceId, changeSetId))
    throw new OperationError(
      'workspace_sync_review_failed',
      'Workspace snapshot accepted base changed during apply.',
      404
    );
  db.sqlite
    .prepare(
      'UPDATE workspace_snapshot_cursors SET accepted_base_json = ?, accepted_commit = ? WHERE workspace_id = ? AND storage_ref = ? AND work_slot = ?'
    )
    .run(
      JSON.stringify(head),
      acceptedCommit,
      workspaceId,
      receipt.identity.storageRef,
      receipt.identity.workSlot
    );
}

/** Reads the original initialization lineage independently of later capture or apply heads. */
export function readWorkspaceBaselineIdentity(
  db: WorkspaceDb,
  identity: Pick<WorkspaceCollectionIdentity, 'workspaceId' | 'storageRef' | 'workSlot'>
): WorkspaceCollectionIdentity | null {
  const row = db.sqlite
    .prepare(
      'SELECT schema_version AS schemaVersion, baseline_identity_json FROM workspace_snapshot_cursors WHERE workspace_id = ? AND storage_ref = ? AND work_slot = ?'
    )
    .get(identity.workspaceId, identity.storageRef, identity.workSlot) as
    | { schemaVersion: unknown; baseline_identity_json: string }
    | undefined;
  return row
    ? readRetainedV1(row, () =>
        WorkspaceCollectionIdentitySchema.parse(JSON.parse(row.baseline_identity_json))
      )
    : null;
}

/** A pre-effect refusal: retained capture authority forbids another scan or destructive cleanup. */
export class WorkspaceCaptureRecoveryRequired extends Error {}

/** Known publication failure with retained partial evidence; it says nothing about scan non-execution. */
export class PreservedWorkspaceCaptureRefusal extends Error {}

/** Closed capture source facts; SQL alone owns receipts, cursors and disposition. */
const RawWorkspaceCaptureV1Schema = z.object({
  identity: WorkspaceCollectionIdentitySchema,
  result: z.object({
    outcome: z.literal('candidate'),
    sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    byteLength: z
      .number()
      .int()
      .positive()
      .max(256 * 1024 * 1024),
    head: StoredWorkspaceSnapshotPairV1Schema,
    previousHead: StoredWorkspaceSnapshotPairV1Schema,
    acceptedBase: StoredWorkspaceSnapshotPairV1Schema,
    unstable: z.boolean(),
    collectedAt: z.iso.datetime({ offset: true }),
  }),
});
/** Verified original source material; this value confers no admission or receipt. */
export type RawWorkspaceCapture = z.infer<typeof RawWorkspaceCaptureV1Schema> & {
  candidate: Buffer;
};
/** Resolves only a caller-derived exact original collection key. */
function captureSourceRoot(dataRoot: string, identity: WorkspaceCollectionIdentity): string {
  WorkspaceCollectionIdentitySchema.parse(identity);
  if (!/^(turn-end|release|successor)-[0-9a-f]{64}$/.test(identity.collectionId))
    throw new Error('Workspace capture requires an exact code-owned boundary key.');
  return join(
    dataRoot,
    'workspaces',
    identity.workspaceId,
    'evidence',
    'backend',
    'workspace-capture',
    identity.collectionId
  );
}
/** Revalidates bounded immutable source bytes against independently supplied original lineage. */
export async function readRawWorkspaceCapture(
  dataRoot: string,
  identity: WorkspaceCollectionIdentity
): Promise<RawWorkspaceCapture | null> {
  const root = captureSourceRoot(dataRoot, identity);
  for (const path of [
    join(dataRoot, 'workspaces', identity.workspaceId),
    dirname(dirname(dirname(root))),
    dirname(dirname(root)),
    dirname(root),
    root,
  ]) {
    const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!metadata) return null;
    assertCanonicalDirectory(path);
  }
  if (!isDeepStrictEqual((await readdir(root)).sort(), ['collection.json', 'complete']))
    throw new Error('Workspace capture source inventory conflicts.');
  const metadataPath = join(root, 'collection.json');
  const metadata = await lstat(metadataPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 65_536)
    throw new Error('Workspace capture source metadata is invalid.');
  const bytes = readCanonicalFile(metadataPath);
  if (bytes.length > 65_536) throw new Error('Workspace capture source metadata is too large.');
  const source = readRetainedV1(
    JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)),
    (value) => RawWorkspaceCaptureV1Schema.parse(value)
  );
  if (!isDeepStrictEqual(source.identity, WorkspaceCollectionIdentitySchema.parse(identity)))
    throw new Error('Workspace capture source lineage conflicts.');
  const candidatePath = join(root, 'complete');
  const file = await lstat(candidatePath);
  if (!file.isFile() || file.isSymbolicLink() || file.size !== source.result.byteLength)
    throw new Error('Workspace capture source candidate size conflicts.');
  const candidate = readCanonicalFile(candidatePath);
  if (
    candidate.length !== source.result.byteLength ||
    `sha256:${createHash('sha256').update(candidate).digest('hex')}` !== source.result.sha256
  )
    throw new Error('Workspace capture source candidate digest conflicts.');
  return { ...source, candidate };
}
/** Adopts the private same-Data-Root export before SQL; failure keeps its remaining bytes and capacity fence. */
export async function preserveRawWorkspaceCapture(input: {
  dataRoot: string;
  identity: WorkspaceCollectionIdentity;
  result: Record<string, unknown>;
  staged: { readonly bytes: Buffer; readonly path: string };
  admission: FileStorageAdmission | undefined;
}): Promise<RawWorkspaceCapture> {
  const staged = input.staged;
  const root = captureSourceRoot(input.dataRoot, input.identity);
  const existing = await readRawWorkspaceCapture(input.dataRoot, input.identity);
  const source = RawWorkspaceCaptureV1Schema.parse({
    identity: input.identity,
    result: {
      ...input.result,
      collectedAt: existing?.result.collectedAt ?? new Date().toISOString(),
    },
  });
  if (
    staged.bytes.length !== source.result.byteLength ||
    `sha256:${createHash('sha256').update(staged.bytes).digest('hex')}` !== source.result.sha256
  )
    throw new Error('Workspace capture source contradicts its verified export.');
  const serialized = Buffer.from(JSON.stringify(writeRetainedV1(source)));
  if (serialized.length > 65_536 || !input.admission)
    throw new Error('Workspace capture metadata capacity is unavailable.');
  const reservation = input.admission.reserve({
    stagingBytes: BigInt(serialized.length),
    extractionBytes: 0n,
    derivativeBytes: 0n,
    publicationBytes: 65_536n,
  });
  let acknowledged = false;
  try {
    if (existing) {
      if (
        !isDeepStrictEqual(existing.result, source.result) ||
        !isDeepStrictEqual(existing.candidate, staged.bytes)
      )
        throw new Error('Workspace capture source replay conflicts.');
      await syncCanonicalTreeAsync(root);
      await syncCanonicalDirectoryAsync(dirname(root));
    } else {
      await ensureCanonicalDirectoryAsync(dirname(root));
      assertCanonicalDirectory(dirname(staged.path));
      if (!isDeepStrictEqual((await readdir(dirname(staged.path))).sort(), ['complete']))
        throw new Error('Workspace capture staging inventory conflicts.');
      await writeFile(join(dirname(staged.path), 'collection.json'), serialized, {
        flag: 'wx',
        mode: 0o600,
      });
      reservation.recordWritten(serialized.length);
      reservation.assertAvailable();
      try {
        await publishCanonicalPathAsync(dirname(staged.path), root);
      } catch (error) {
        const winner = await readRawWorkspaceCapture(input.dataRoot, input.identity);
        if (
          !winner ||
          !isDeepStrictEqual(winner.result, source.result) ||
          !isDeepStrictEqual(winner.candidate, staged.bytes)
        )
          throw error;
        await syncCanonicalTreeAsync(root);
        await syncCanonicalDirectoryAsync(dirname(root));
      }
    }
    reservation.assertAvailable();
    acknowledged = true;
    return { ...source, candidate: staged.bytes };
  } finally {
    if (acknowledged) {
      reservation.release();
    }
  }
}
