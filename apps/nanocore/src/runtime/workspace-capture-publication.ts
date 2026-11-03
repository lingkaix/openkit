import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { WorkspaceReconciliationRecord } from '@openkit/app-api-schemas';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { WorkspaceDb } from '../storage/db.js';
import {
  type ControlWorkspaceCapture,
  ControlWorkspaceCaptureSchema,
  WorkspaceCaptureAnchorSchema,
} from '../storage/workspace-capture-codecs.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';
import type { WorkspaceCaptureAnchor } from '../storage/workspace-reconciliation-records.js';
import {
  type RawWorkspaceCapture,
  RawWorkspaceCaptureV1Schema,
  type WorkspaceCollectionIdentity,
  type WorkspaceCollectionReceipt,
} from './workspace-snapshot-chain.js';

/** Opens the existing actual Workspace physical owner before submitting one exact stage. */
async function publish(db: WorkspaceDb, value: ControlWorkspaceCapture) {
  const input = ControlWorkspaceCaptureSchema.parse(value);
  const scope = nativeProductScope(db.dataRoot, { kind: 'workspace', workspaceId: db.workspaceId });
  const client = getControlStoreWorkerClient();
  const database = `workspace:${scope.path}`;
  await client.open({
    database,
    path: scope.path,
    dataRoot: db.dataRoot,
    create: false,
    initialize: 'workspace',
    productOwner: scope.owner,
    contentMount: scope.contentMount,
  });
  return client.workspaceCapture(database, input);
}

/** Acknowledges the original idle claim before the caller may begin its separate Core drain. */
export async function claimIdleWorkspaceCapture(
  db: WorkspaceDb,
  anchor: WorkspaceCaptureAnchor,
  identity: WorkspaceCollectionIdentity
): Promise<void> {
  await publish(db, {
    action: 'claim',
    anchor: WorkspaceCaptureAnchorSchema.parse(anchor),
    identity,
  });
}

/** Publishes the collection/cursor and optional idle completion atomically, retaining exact source bytes. */
export async function publishWorkspaceCapture(
  db: WorkspaceDb,
  identity: WorkspaceCollectionIdentity,
  result: Record<string, unknown>,
  candidate: Buffer | null,
  preserved?: RawWorkspaceCapture,
  idleAnchor?: WorkspaceCaptureAnchor
): Promise<WorkspaceCollectionReceipt> {
  if (
    (candidate !== null && !preserved) ||
    (preserved &&
      (!isDeepStrictEqual(preserved.identity, identity) ||
        !isDeepStrictEqual(preserved.candidate, candidate)))
  )
    throw new Error('Preserved Workspace capture contradicts its publication.');
  const source = preserved ? RawWorkspaceCaptureV1Schema.parse(preserved) : null;
  const value = ControlWorkspaceCaptureSchema.parse({
    action: 'accept',
    identity,
    result,
    source,
    idleAnchor: idleAnchor ? WorkspaceCaptureAnchorSchema.parse(idleAnchor) : null,
  });
  const reply = await publish(db, value);
  if (reply.kind !== 'receipt') throw new Error('Workspace capture reply kind conflicts.');
  const metadata = reply.receipt.candidate;
  if (
    metadata &&
    (!candidate ||
      candidate.length !== metadata.byteLength ||
      `sha256:${createHash('sha256').update(candidate).digest('hex')}` !== metadata.sha256)
  )
    throw new Error('Acknowledged Workspace capture disagrees with its retained source.');
  if (!metadata && candidate !== null)
    throw new Error('Acknowledged Workspace capture has no candidate.');
  return { ...reply.receipt, candidate: metadata ? candidate : null };
}

/** Commits original recovery evidence without treating raw-source absence as proof of no external effect. */
export async function publishWorkspaceCaptureRecovery(
  db: WorkspaceDb,
  anchor: WorkspaceCaptureAnchor,
  identity: WorkspaceCollectionIdentity,
  source: RawWorkspaceCapture | null
): Promise<WorkspaceReconciliationRecord> {
  const reply = await publish(db, {
    action: 'recover',
    anchor: WorkspaceCaptureAnchorSchema.parse(anchor),
    identity,
    source: source ? RawWorkspaceCaptureV1Schema.parse(source) : null,
  });
  if (reply.kind !== 'recovery') throw new Error('Workspace recovery reply kind conflicts.');
  return reply.record;
}

/** Resolves only the original accepted capture receipt in the same physical deciding section. */
export async function publishWorkspaceCaptureCompletion(
  db: WorkspaceDb,
  anchor: WorkspaceCaptureAnchor,
  identity: WorkspaceCollectionIdentity,
  source: RawWorkspaceCapture | null
): Promise<WorkspaceReconciliationRecord> {
  const reply = await publish(db, {
    action: 'complete',
    anchor: WorkspaceCaptureAnchorSchema.parse(anchor),
    identity,
    source: source ? RawWorkspaceCaptureV1Schema.parse(source) : null,
  });
  if (reply.kind !== 'recovery') throw new Error('Workspace recovery reply kind conflicts.');
  return reply.record;
}
