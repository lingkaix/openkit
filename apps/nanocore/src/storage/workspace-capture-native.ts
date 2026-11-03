import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { listWorkspaceReconciliationRecords } from '../runtime/workspace-reconciliation-read.js';
import {
  acceptWorkspaceCapture,
  type RawWorkspaceCapture,
  readRawWorkspaceCapture,
  WorkspaceCaptureRecoveryRequired,
} from '../runtime/workspace-snapshot-chain.js';
import { readProduct } from './control-store-product-records.js';
import type { WorkspaceDb } from './db.js';
import type {
  ControlWorkspaceCapture,
  ControlWorkspaceCaptureResult,
} from './workspace-capture-codecs.js';
import { ControlWorkspaceCaptureResultSchema } from './workspace-capture-codecs.js';
import { AgentSessionRecordSchema } from './workspace-file-records.js';
import {
  completeWorkspaceCaptureRecovery,
  recordWorkspaceCaptureRecovery,
} from './workspace-reconciliation-records.js';

/** Reads only the original identity-derived immutable source after admitted predecessors, before SQL. */
export async function prepareWorkspaceCapture(
  db: WorkspaceDb,
  input: ControlWorkspaceCapture,
  reserve: (files: { readonly path: string; readonly publicationBytes: number }[]) => Promise<void>
): Promise<RawWorkspaceCapture | null> {
  if (!('source' in input) || input.source === null) return null;
  const original = await readRawWorkspaceCapture(db.dataRoot, input.identity);
  if (
    !original ||
    !isDeepStrictEqual({ identity: original.identity, result: original.result }, input.source)
  )
    throw new Error('Workspace capture source changed before publication.');
  if (input.action === 'accept') {
    // The original source is already durable. SQLite can allocate both database and WAL copies;
    // the existing shared WAL forecast still covers ordinary metadata and page overhead.
    await reserve([{ path: db.sqlite.name, publicationBytes: original.candidate.length * 2 }]);
  }
  return original;
}

/** Rechecks the original positive attachment in the owning SQL section, never a Main allow boolean. */
function requireIdleCaptureAttachment(
  db: WorkspaceDb,
  input: Extract<ControlWorkspaceCapture, { action: 'claim' }>
): void {
  const session = AgentSessionRecordSchema.parse(
    readProduct(
      db.sqlite,
      { kind: 'workspace', workspaceId: db.workspaceId },
      'agent-session',
      input.identity.agentSessionId
    )?.record
  );
  const original = session.retainedStorage;
  if (
    !original ||
    original.storageRef !== input.identity.storageRef ||
    original.workSlotRef !== input.identity.workSlot ||
    original.attachmentGeneration !== input.identity.attachmentGeneration
  )
    throw new WorkspaceCaptureRecoveryRequired(
      'Idle capture lacks its original attachment generation.'
    );
  if (
    listWorkspaceReconciliationRecords(db, input.identity.workspaceId).some(
      (record) => record.id === `wrr_capture_${input.identity.collectionId}`
    )
  )
    throw new WorkspaceCaptureRecoveryRequired(
      'Idle capture already has its original continuation.'
    );
}

/** Executes each original stage, including capture and optional completion as one unchanged tuple. */
export function applyWorkspaceCaptureInDb(
  db: WorkspaceDb,
  input: ControlWorkspaceCapture,
  source: RawWorkspaceCapture | null
): ControlWorkspaceCaptureResult {
  if (input.identity.workspaceId !== db.workspaceId)
    throw new Error('Workspace capture recovery source or owner conflicts.');
  if (
    'source' in input &&
    ((input.source === null) !== (source === null) ||
      (source &&
        !isDeepStrictEqual({ identity: source.identity, result: source.result }, input.source)))
  )
    throw new Error('Workspace capture source changed before publication.');
  if (input.action === 'claim') {
    requireIdleCaptureAttachment(db, input);
    return ControlWorkspaceCaptureResultSchema.parse({
      kind: 'recovery',
      record: recordWorkspaceCaptureRecovery(db, input.anchor, input.identity, null),
    });
  }
  if (input.action === 'recover')
    return ControlWorkspaceCaptureResultSchema.parse({
      kind: 'recovery',
      record: recordWorkspaceCaptureRecovery(db, input.anchor, input.identity, source),
    });
  if (input.action === 'complete')
    return ControlWorkspaceCaptureResultSchema.parse({
      kind: 'recovery',
      record: completeWorkspaceCaptureRecovery(db, input.anchor, input.identity, source),
    });
  if (
    input.idleAnchor &&
    !listWorkspaceReconciliationRecords(db, input.identity.workspaceId).some(
      (record) =>
        record.id === `wrr_capture_${input.identity.collectionId}` &&
        record.stateAfter === 'requires-human'
    )
  )
    throw new WorkspaceCaptureRecoveryRequired(
      'Idle capture disposition changed during collection.'
    );
  const receipt = acceptWorkspaceCapture(
    db,
    input.identity,
    input.result,
    source?.candidate ?? null,
    source ?? undefined
  );
  if (input.idleAnchor)
    completeWorkspaceCaptureRecovery(db, input.idleAnchor, input.identity, source);
  return ControlWorkspaceCaptureResultSchema.parse({
    kind: 'receipt',
    receipt: {
      ...receipt,
      candidate: receipt.candidate
        ? {
            byteLength: receipt.candidate.length,
            sha256: `sha256:${createHash('sha256').update(receipt.candidate).digest('hex')}`,
          }
        : null,
    },
  });
}
