import { join } from 'node:path';
import { prepareServerWorkOwner } from '../app.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
} from '../config/runtime-config.js';
import { FsStore } from '../lib/store.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
import { coreDbPath } from '../storage/fs-layout.js';
import { openServerWorkProductReadHandle } from '../storage/server-work-product-reads.js';
import { serverWorkStorageDescriptor } from '../storage/server-work-schema.js';

/** Provisions the exact Server-work worker and admits current Core Policy for a private test root. */
export async function openTestServerWork(
  coreDb: CoreDb,
  config: Omit<Parameters<typeof createInMemoryRuntimeConfigSnapshot>[0], 'dataRoot'> = {}
) {
  const { dataRoot } = coreDb;
  const writer = getControlStoreWorkerClient();
  const path = coreDbPath(dataRoot);
  const coreOpen = {
    database: `core:${path}`,
    path,
    dataRoot,
    create: false,
    initialize: 'core' as const,
    productOwner: { kind: 'server' as const },
    contentMount: {
      root: join(dataRoot, 'server', 'evidence', 'backend'),
      mount: 'backend-evidence' as const,
      knowledgeBaseId: null,
    },
  };
  await writer.open(coreOpen);
  const provisioned = await writer.provisionServerOwner(dataRoot, serverWorkStorageDescriptor);
  if (provisioned.state !== 'ready')
    throw new Error(`Server-work provision: ${provisioned.reason}`);
  const runtimeConfigManager = createRuntimeConfigManager({
    dataRoot,
    initialSnapshot: createInMemoryRuntimeConfigSnapshot({ dataRoot, ...config }),
  });
  await runtimeConfigManager.bindNativePolicyPublication(coreDb);
  const binding = await prepareServerWorkOwner(coreDb, () => runtimeConfigManager.current());
  if (binding.state !== 'ready') throw new Error(`Server-work binding: ${binding.reason}`);
  const reader = await openServerWorkProductReadHandle(dataRoot, writer);
  if (reader.state !== 'ready') throw new Error(`Server-work reader: ${reader.reason}`);
  return {
    binding: binding.value,
    reader: reader.value,
    runtimeConfigManager,
    store: new FsStore({ dataRoot, serverWorkReader: reader.value, serverWork: binding.value }),
    coreOpen,
  };
}
