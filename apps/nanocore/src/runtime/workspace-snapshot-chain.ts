import { createHash } from 'node:crypto';
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
import type { WorkspaceDb } from '../storage/db.js';
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
const WorkspaceCollectionIdentitySchema = z.object({
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
  candidate: Buffer | null
): WorkspaceCollectionReceipt {
  return db.sqlite.transaction(() => {
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
  })();
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
