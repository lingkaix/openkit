import { prepareNanoHostOwner } from '../app.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
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
