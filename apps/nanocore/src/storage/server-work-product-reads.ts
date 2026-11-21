import { join, resolve } from 'node:path';
import {
  bindServerWorkProductReadHandle,
  type ControlStoreProductReadHandle,
  isAdmittedServerWorkProductReader,
} from './control-store-product-records.js';
import type { getControlStoreWorkerClient } from './control-store-worker-client.js';
import { serverStoragePath } from './db.js';
import { ServerOwnerAdmissionError } from './migrate.js';
import { serverWorkUnavailable } from './server-work-command.js';
import type { StorageResult } from './storage-owner.js';
import type { NativeProductScope } from './workspace-file-records.js';

/** Takes one query-only product reader from the acknowledged Server-work worker generation. */
export async function openServerWorkProductReadHandle(
  dataRoot: string,
  worker?: Pick<ReturnType<typeof getControlStoreWorkerClient>, 'openServerOwnerReadDb'>
): Promise<StorageResult<'server-work', ControlStoreProductReadHandle>> {
  if (!worker) return { state: 'unavailable', owner: 'server-work', reason: 'disabled' };
  try {
    const sqlite = await worker.openServerOwnerReadDb(dataRoot, 'server-work');
    try {
      const reader = bindServerWorkProductReadHandle(
        serverStoragePath(dataRoot, 'server-work'),
        sqlite
      );
      return { state: 'ready', value: reader };
    } catch (error) {
      if (sqlite.open) sqlite.close();
      throw error;
    }
  } catch (error) {
    return {
      state: 'unavailable',
      owner: 'server-work',
      reason: error instanceof ServerOwnerAdmissionError ? error.reason : 'recovery-required',
    };
  }
}

/** Borrows the admitted reader and preserves the immutable Server content binding. */
export function serverWorkProductScope(
  dataRoot: string,
  reader?: ControlStoreProductReadHandle
): NativeProductScope & { readonly sqlite: ControlStoreProductReadHandle['sqlite'] } {
  const path = serverStoragePath(dataRoot, 'server-work');
  if (
    !reader?.sqlite.open ||
    !isAdmittedServerWorkProductReader(reader.sqlite) ||
    resolve(reader.sqlite.name) !== resolve(path)
  )
    throw serverWorkUnavailable();
  return {
    path,
    owner: { kind: 'server' },
    sqlite: reader.sqlite,
    contentMount: {
      root: join(dataRoot, 'server', 'evidence', 'backend'),
      mount: 'backend-evidence',
      knowledgeBaseId: null,
    },
  };
}
