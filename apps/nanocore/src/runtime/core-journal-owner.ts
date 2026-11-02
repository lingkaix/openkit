import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { ControlCoreJournalInput } from '../storage/core-journal-codecs.js';
import type { CoreDb } from '../storage/db.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';
/** Joins the original Core producer through the existing FIFO until its covering FULL acknowledgement. */
export async function publishCoreJournal(
  db: CoreDb,
  input: ControlCoreJournalInput
): Promise<string | null> {
  const snapshot = structuredClone(input);
  const scope = nativeProductScope(db.dataRoot, { kind: 'server' });
  const database = `core:${scope.path}`;
  const client = getControlStoreWorkerClient();
  return client.runOperation(async () => {
    await client.open({
      database,
      path: scope.path,
      dataRoot: db.dataRoot,
      create: false,
      initialize: 'core',
      productOwner: scope.owner,
      contentMount: scope.contentMount,
    });
    return client.coreJournal(database, snapshot);
  });
}
