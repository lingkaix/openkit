import { resolve } from 'node:path';
import type { FsStore } from '../lib/store.js';
import { StoreRecordNotFoundError } from '../lib/store-errors.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
import type { SecurityThreadDestination } from '../storage/security-thread-destination-codecs.js';
import { SecurityTriggerRefusal } from '../storage/security-trigger-codecs.js';

type Owners = { coreDb: CoreDb; store: FsStore };
/** Trusted source identity only; current principal/effect admission remains with Administration. */
export interface SecurityThreadSelection {
  recipientUserId: string;
  generation: number;
  workspaceId: string;
  threadId: string;
  threadStatus: 'active' | 'archived';
}
function unavailable(): never {
  throw new SecurityTriggerRefusal('recovery_required');
}
function assertOwners({ coreDb, store }: Owners): void {
  const root = store.getDataRoot();
  if (coreDb.scope !== 'core' || !root || resolve(root) !== resolve(coreDb.dataRoot)) unavailable();
}
function readOwner(
  store: FsStore,
  destination: SecurityThreadDestination
): SecurityThreadSelection {
  const { recipientUserId, generation, workspaceId, threadId } = destination;
  try {
    const workspace = store.getWorkspace(workspaceId);
    const thread = store.getThread(workspaceId, threadId);
    if (
      workspace.id !== workspaceId ||
      workspace.kind !== 'personal' ||
      thread.id !== threadId ||
      thread.owner.kind !== 'workspace' ||
      thread.owner.workspaceId !== workspaceId ||
      thread.entryPath !== 'administration' ||
      thread.visibility !== 'private' ||
      thread.privateOwnerUserId !== recipientUserId
    )
      unavailable();
    return { recipientUserId, generation, workspaceId, threadId, threadStatus: thread.status };
  } catch (error) {
    if (error instanceof StoreRecordNotFoundError) unavailable();
    throw error;
  }
}

/** Read-only Core-binding/actual-owner join. Registered incomplete tuples never become ordinary work. */
export async function selectSecurityThread(
  input: Owners & { workspaceId: string; threadId: string }
): Promise<SecurityThreadSelection | null> {
  assertOwners(input);
  const result = await getControlStoreWorkerClient().securityTrigger(input.coreDb, {
    action: 'destination-read',
    threadId: input.threadId,
  });
  if (result.kind !== 'destination-read')
    throw new TypeError('Unexpected destination lookup result.');
  const destination = result.destination;
  if (!destination) return null;
  if (destination.status !== 'ready' || destination.workspaceId !== input.workspaceId)
    unavailable();
  return readOwner(input.store, destination);
}

/** Prepare only an actually owed alarm destination through both original native owners; never Raise. */
export async function prepareSecurityThread(
  input: Owners & { requestId: string }
): Promise<SecurityThreadSelection> {
  assertOwners(input);
  const client = getControlStoreWorkerClient();
  const result = await client.securityTrigger(input.coreDb, {
    action: 'destination-reserve',
    requestId: input.requestId,
  });
  if (result.kind !== 'destination')
    throw new TypeError('Unexpected destination reservation result.');
  const destination = result.destination;
  if (destination.status === 'ready') {
    const selected = readOwner(input.store, destination);
    if (selected.threadStatus !== 'active') unavailable();
    return selected;
  }
  // A prior reserved intent has an unknown cross-store outcome. Do not adopt, repost or repair it.
  if (!result.fresh) unavailable();
  const home = await input.store.ensureQuickChatWorkspace(destination.recipientUserId);
  if (home.id !== destination.workspaceId || home.kind !== 'personal') unavailable();
  try {
    input.store.getThread(destination.workspaceId, destination.threadId);
    unavailable();
  } catch (error) {
    if (!(error instanceof StoreRecordNotFoundError)) throw error;
  }
  await input.store.createThread(
    destination.workspaceId,
    'Security',
    destination.threadId,
    'administration',
    { visibility: 'private', privateOwnerUserId: destination.recipientUserId }
  );
  const selected = readOwner(input.store, destination);
  if (selected.threadStatus !== 'active') unavailable();
  // The real Workspace publisher has ACKed before this original Core progress transition.
  const completed = await client.securityTrigger(input.coreDb, {
    action: 'destination-ready',
    threadId: destination.threadId,
    requestId: destination.sourceRequestId,
  });
  if (completed.kind !== 'destination' || completed.destination.status !== 'ready')
    throw new TypeError('Unexpected destination completion result.');
  return selected;
}
