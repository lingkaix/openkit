import { getControlStoreWorkerClient } from './control-store-worker-client.js';
import type { UserDb } from './db.js';
import { userDbPath } from './fs-layout.js';
import { ThreadReadItemIdsSchema } from './thread-read-membership-codecs.js';
import { readThreadReadReceipt } from './thread-read-membership-native.js';

export { readThreadReadReceipt } from './thread-read-membership-native.js';

/**
 * Unions exact displayed identities under the User database's existing native FIFO and FULL ACK.
 * Reads of an empty selection do not create a row. Admission is rechecked on Main after opening;
 * neither its callback nor a SQL statement crosses the message boundary.
 * @param userDb Caller-owned User scope, kept open until acknowledgement.
 * @param workspaceId Original Workspace identity.
 * @param threadId Original Thread identity.
 * @param itemIds Already eligible completed message identities.
 * @param recheckAdmission Existing operation admission, when invoked through the public dispatcher.
 * @returns The exact committed union in deterministic serialization order.
 */
export async function advanceThreadReadReceipt(
  userDb: UserDb,
  workspaceId: string,
  threadId: string,
  itemIds: readonly string[],
  recheckAdmission?: () => Promise<void>
): Promise<string[]> {
  const observed = ThreadReadItemIdsSchema.parse(itemIds);
  if (observed.length === 0) return readThreadReadReceipt(userDb, workspaceId, threadId);
  const { dataRoot, userId } = userDb;
  const path = userDbPath(dataRoot, userId);
  const database = `user:${path}`;
  const client = getControlStoreWorkerClient();
  await client.open({ database, path, create: false, initialize: 'user' });
  await recheckAdmission?.();
  return client.threadReadMembership(database, {
    userId,
    workspaceId,
    threadId,
    itemIds: observed,
  });
}
