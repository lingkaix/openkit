import { join } from 'node:path';
import { onTestFinished } from 'vitest';
import { prepareServerWorkOwner } from '../app.js';
import { getLocalUserId } from '../auth/identity.js';
import {
  createInMemoryRuntimeConfigSnapshot,
  createRuntimeConfigManager,
  type RuntimeConfigManager,
} from '../config/runtime-config.js';
import { FsStore, type FsStoreOptions } from '../lib/store.js';
import { getControlStoreWorkerClient } from '../storage/control-store-worker-client.js';
import type { CoreDb } from '../storage/db.js';
import { coreDbPath } from '../storage/fs-layout.js';
import { openServerWorkProductReadHandle } from '../storage/server-work-product-reads.js';
import { serverWorkStorageDescriptor } from '../storage/server-work-schema.js';
import { createTestGatewayConfig } from './agent-environment.js';
import { createDemoStore } from './demo-store.js';
import { createTestCoreDb, retainTestServerWorkReader } from './store.js';

type FixtureRuntimeConfig = Omit<
  Parameters<typeof createInMemoryRuntimeConfigSnapshot>[0],
  'dataRoot'
>;

async function admitTestServerWork(
  coreDb: CoreDb,
  config: FixtureRuntimeConfig | RuntimeConfigManager,
  reuseCurrentPolicy = false
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
  const runtimeConfigManager =
    'current' in config
      ? config
      : createRuntimeConfigManager({
          dataRoot,
          initialSnapshot: createInMemoryRuntimeConfigSnapshot({ ...config, dataRoot }),
        });
  // A second Store in the same fixture keeps the sole publisher for this Core generation.
  const policy = reuseCurrentPolicy
    ? await writer.runtimePolicyPublication(coreDb, { kind: 'inspect' })
    : null;
  if (!policy?.publisherId) await runtimeConfigManager.bindNativePolicyPublication(coreDb);
  else if (policy.state !== 'active') throw new Error('Server-work fixture Policy is unavailable.');
  const binding = await prepareServerWorkOwner(coreDb, () => runtimeConfigManager.current());
  if (binding.state !== 'ready') throw new Error(`Server-work binding: ${binding.reason}`);
  const reader = await openServerWorkProductReadHandle(dataRoot, writer);
  if (reader.state !== 'ready') throw new Error(`Server-work reader: ${reader.reason}`);
  return {
    binding: binding.value,
    reader: reader.value,
    runtimeConfigManager,
    coreOpen,
  };
}

/** Provisions the exact Server-work worker and admits current Core Policy for a private test root. */
export async function openTestServerWork(
  coreDb: CoreDb,
  config: FixtureRuntimeConfig | RuntimeConfigManager = {}
) {
  const native = await admitTestServerWork(coreDb, config);
  try {
    const store = new FsStore({
      dataRoot: coreDb.dataRoot,
      serverWorkReader: native.reader,
      serverWork: native.binding,
    });
    return { ...native, store };
  } catch (error) {
    native.reader.close();
    throw error;
  }
}

/** Supplies native Server work to a Store fixture and releases its private reader at test completion. */
export async function testServerWorkOptions(
  core: CoreDb | string,
  config: FixtureRuntimeConfig | RuntimeConfigManager = {}
): Promise<Required<Pick<FsStoreOptions, 'dataRoot' | 'serverWorkReader' | 'serverWork'>>> {
  const coreDb = typeof core === 'string' ? createTestCoreDb(core) : core;
  if (typeof core === 'string')
    onTestFinished(() => {
      if (coreDb.sqlite.open) coreDb.sqlite.close();
    });
  const { binding, reader } = await admitTestServerWork(
    coreDb,
    'current' in config ? config : { gatewayConfig: createTestGatewayConfig(), ...config },
    true
  );
  onTestFinished(retainTestServerWorkReader(reader));
  return { dataRoot: coreDb.dataRoot, serverWorkReader: reader, serverWork: binding };
}

/** Creates an empty Store for fixtures which exercise the admitted Server product owner. */
export async function createTestServerWorkStore(
  core: CoreDb | string,
  config?: FixtureRuntimeConfig | RuntimeConfigManager
): Promise<FsStore> {
  return new FsStore(await testServerWorkOptions(core, config));
}

/** Seeds the existing Demo fixture with the same admitted Server work used at boot. */
export async function createTestServerWorkDemoStore(
  core: CoreDb | string,
  config?: FixtureRuntimeConfig | RuntimeConfigManager
): Promise<FsStore> {
  return createDemoStore(await testServerWorkOptions(core, config));
}

/** Creates a Server Thread as the fixture's existing local user. */
export function createTestServerThread(
  store: FsStore,
  coreDb: CoreDb,
  title: string,
  entryPath?: Parameters<FsStore['createServerThread']>[2]
) {
  return store.createServerThread(title, undefined, entryPath, {
    actor: { kind: 'user', id: getLocalUserId(coreDb) },
    credentialRef: null,
  });
}
