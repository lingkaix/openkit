import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId, ThreadSchema, writeRetainedV1 } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import {
  listServerCapabilityCalls,
  listServerUsageRecords,
  recoverRunningCapabilityCalls,
} from '../capability/usage-ledger.js';
import { FsStore } from '../lib/store.js';
import { closeTestCoreDb, createTestCoreDb } from '../test-support/store.js';
import { openControlStoreProductReadHandle } from './control-store-product-records.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { serverStoragePath } from './db.js';
import { openServerWorkProductReadHandle } from './server-work-product-reads.js';
import { serverWorkStorageDescriptor } from './server-work-schema.js';

const owner = { kind: 'server' } as const;
const ready = { state: 'ready', owner: 'server-work' };
const recoveryRequired = {
  state: 'unavailable',
  owner: 'server-work',
  reason: 'recovery-required',
};

function writeThread(sqlite: Database.Database, id: string, name: string): void {
  const row = writeRetainedV1(
    ThreadSchema.parse({
      id,
      owner,
      visibility: 'server',
      status: 'active',
      name,
      preview: name,
      entryPath: 'knowledge-manager',
      threadSource: 'conversation',
      createdAt: '2026-11-21T01:00:00.000Z',
      updatedAt: '2026-11-21T01:00:00.000Z',
    })
  );
  sqlite
    .prepare(
      `INSERT INTO control_threads (id, status, schema_version, revision, record_json)
     VALUES (?, 'active', 1, 1, ?)`
    )
    .run(id, JSON.stringify(row));
}

it('projects only the acknowledged Server-work file and releases the owned reader', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-server-product-reader-'));
  const worker = getControlStoreWorkerClient();
  const destination = serverStoragePath(dataRoot, 'server-work');
  const id = allocateEntityId('th');
  try {
    const core = createTestCoreDb(dataRoot);
    try {
      expect(
        core.sqlite
          .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'control_threads'")
          .get()
      ).toBeUndefined();
      const kernelReader = openControlStoreProductReadHandle(core.sqlite.name, owner, core.sqlite);
      try {
        expect(() => kernelReader.list('thread')).toThrow(
          expect.objectContaining({ code: 'operation_storage_unavailable', status: 503 })
        );
      } finally {
        kernelReader.close();
      }
      FsStore.validateFileAuthority(dataRoot);
      const unboundStore = new FsStore({ dataRoot });
      expect(() => unboundStore.listServerThreads()).toThrow(
        expect.objectContaining({ code: 'operation_storage_unavailable', status: 503 })
      );
      await expect(unboundStore.createServerThread('Unadmitted')).rejects.toMatchObject({
        code: 'operation_storage_unavailable',
        status: 503,
      });
      await expect(recoverRunningCapabilityCalls({ workspaceDb: core })).resolves.toEqual({
        state: 'unavailable',
        owner: 'server-work',
        reason: 'disabled',
      });
    } finally {
      closeTestCoreDb(core);
    }
    await expect(openServerWorkProductReadHandle(dataRoot)).resolves.toEqual({
      state: 'unavailable',
      owner: 'server-work',
      reason: 'disabled',
    });
    await expect(openServerWorkProductReadHandle(dataRoot, worker)).resolves.toEqual(
      recoveryRequired
    );
    expect(existsSync(destination)).toBe(false);

    await expect(
      worker.provisionServerOwner(dataRoot, serverWorkStorageDescriptor)
    ).resolves.toEqual(ready);
    await worker.closeServerOwner(dataRoot, 'server-work');
    const sqlite = new Database(destination, { fileMustExist: true });
    try {
      writeThread(sqlite, id, 'Admitted Server-work Thread');
    } finally {
      sqlite.close();
    }
    await expect(worker.openServerOwner(dataRoot, serverWorkStorageDescriptor)).resolves.toEqual(
      ready
    );

    const result = await openServerWorkProductReadHandle(dataRoot, worker);
    if (result.state !== 'ready')
      throw new Error(`Server-work reader unavailable: ${result.reason}`);
    try {
      expect(result.value.get('thread', id)?.record.name).toBe('Admitted Server-work Thread');
      expect(result.value.list('thread')).toHaveLength(1);
      expect(result.value.sqlite.readonly).toBe(true);
      const store = new FsStore({ dataRoot, serverWorkReader: result.value });
      expect(store.listServerThreads().map((thread) => thread.id)).toEqual([id]);
      expect(store.getServerThread(id).name).toBe('Admitted Server-work Thread');
      expect(store.listServerThreadTurns(id)).toEqual([]);
      expect(listServerCapabilityCalls({ dataRoot }, result.value)).toEqual([]);
      expect(listServerUsageRecords({ dataRoot }, result.value)).toEqual([]);
      await expect(store.updateServerThread(id, { name: 'Unadmitted' })).rejects.toMatchObject({
        code: 'operation_storage_unavailable',
        status: 503,
      });
      expect(store.getServerThread(id).name).toBe('Admitted Server-work Thread');
    } finally {
      result.value.close();
    }
    expect(result.value.sqlite.open).toBe(false);
    await worker.closeServerOwner(dataRoot, 'server-work');
    await expect(openServerWorkProductReadHandle(dataRoot, worker)).resolves.toEqual(
      recoveryRequired
    );
  } finally {
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { recursive: true, force: true });
  }
}, 60_000);
