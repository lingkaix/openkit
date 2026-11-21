import Database from 'better-sqlite3';
import { prepareNanoHostOwner } from '../app.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import { type CoreDb, serverStoragePath } from '../storage/db.js';
import { nanoHostStoreDescriptor } from '../storage/nanohost-store-descriptor.js';
import { nativeProductScope } from '../storage/workspace-file-records.js';

/** Provisions a private fixture and joins the real acknowledged Native and Core workers. */
export async function openAdmittedTestNanoHost(coreDb: CoreDb) {
  const { dataRoot } = coreDb;
  const worker = getControlStoreWorkerClient();
  const { path, contentMount } = nativeProductScope(dataRoot, { kind: 'server' });
  await worker.open({
    database: `core:${path}`,
    path,
    dataRoot,
    create: false,
    initialize: 'core',
    productOwner: { kind: 'server' },
    contentMount,
  });
  const provisioned = await worker.provisionServerOwner(dataRoot, nanoHostStoreDescriptor);
  if (provisioned.state !== 'ready') throw new Error(`NanoHost provision: ${provisioned.reason}`);
  return reopenAdmittedTestNanoHost(coreDb);
}

/** Rejoins the persisted Native owner after the fixture's previous generation exits. */
export async function reopenAdmittedTestNanoHost(coreDb: CoreDb) {
  const storage = await prepareNanoHostOwner(coreDb, { enabled: () => true });
  if (storage.state !== 'ready') throw new Error(`NanoHost admission: ${storage.reason}`);
  return storage;
}

/** Reads fixture evidence from the same acknowledged NanoHost generation as production. */
export function readAdmittedTestNanoHost<Value>(
  coreDb: CoreDb,
  query: (sqlite: Database.Database) => Value
): Value {
  const result = getControlStoreWorkerClient().readAdmittedNanoHost(coreDb.dataRoot, query);
  if (result.state !== 'ready') throw new Error(`NanoHost fixture read: ${result.reason}`);
  return result.value;
}

/** Changes fixture bytes while the test owns an admitted NanoHost opening and has paused its writers. */
export function mutateAdmittedTestNanoHost<Value>(
  coreDb: CoreDb,
  mutate: (sqlite: Database.Database) => Value
): Value {
  readAdmittedTestNanoHost(coreDb, () => undefined);
  const sqlite = new Database(serverStoragePath(coreDb.dataRoot, 'nanohost'), {
    fileMustExist: true,
  });
  try {
    return sqlite.transaction(mutate).immediate(sqlite);
  } finally {
    sqlite.close();
  }
}

/** Seeds an exact fixture through a short-lived connection to the admitted NanoHost file. */
export async function seedAdmittedTestNanoHost(
  coreDb: CoreDb,
  seed: (sqlite: Database.Database) => void
) {
  const storage = await openAdmittedTestNanoHost(coreDb);
  mutateAdmittedTestNanoHost(coreDb, seed);
  return storage;
}
