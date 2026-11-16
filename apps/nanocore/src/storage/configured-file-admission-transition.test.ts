import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { FsStore } from '../lib/store.js';
import { runIdempotentCommand } from '../runtime/idempotent-command.js';
import { FileStorageAdmission } from './artifacts/file-admission.js';
import {
  getControlStoreWorkerClient,
  nativeUserDatabasePath,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { createDataRootAdminOperationImplementations } from './data-root-admin-operations.js';
import { openCoreDb, openUserDb } from './db.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';

it.each(['supplied-refusal', 'lower-configured', 'nested-reuse'] as const)(
  'uses %s after a standalone User receipt warmed the default',
  async (policy) => {
    const root = mkdtempSync(join(tmpdir(), 'warm-user-app-admission-'));
    let capacity: ReturnType<typeof vi.spyOn> | undefined;
    const coreDb = openCoreDb(root);
    applyMigrations(coreDb);
    const store = new FsStore({ dataRoot: root });
    const userId = allocateEntityId('usr');
    const userDb = openUserDb(root, userId);
    applyScopedMigrations(userDb);
    const scope = { userId, actorId: userId };
    const inflightCommands = new WeakMap();
    const commit = (requestId: string) => {
      const turnId = allocateEntityId('tu');
      return runIdempotentCommand({
        store,
        receiptDb: userDb,
        inflightCommands,
        command: 'knowledge.maintain',
        requestId,
        scope,
        input: { instructions: 'Keep the selected User receipt owner.' },
        responseKind: 'turn',
        responseId: (result: { turnId: string }) => result.turnId,
        replay: () => {
          throw new Error('Fresh receipt must not replay.');
        },
        execute: async (receipt) => {
          const { responseKind, ...original } = receipt;
          await store.commitScopedNotebookStage(userDb, {
            kind: 'receipt',
            receipt: { ...original, response: { kind: responseKind, id: turnId } },
          });
          return { turnId };
        },
      });
    };
    try {
      await commit(randomUUID());
      if (policy !== 'supplied-refusal') {
        mkdirSync(join(root, 'config'), { recursive: true });
        writeFileSync(
          join(root, 'config/server.jsonc'),
          JSON.stringify({
            schemaVersion: 1,
            server: { fileReserveBytes: 0 },
          })
        );
      }
      const fallbackRoot = dirname(nativeUserDatabasePath(userDb));
      const fallback = getControlStoreWorkerClient().getFileStorageAdmission(fallbackRoot);
      expect(fallback !== undefined).toBe(true);
      createApp({
        mode: 'server',
        coreDb,
        store,
        ...(policy === 'supplied-refusal'
          ? {
              fileAdmission: new FileStorageAdmission(
                root,
                () => 2_000_000_000n,
                () => 0n
              ),
            }
          : {}),
      });
      if (policy !== 'supplied-refusal') {
        // Keep the real shared filesystem pool; only the sampled free bytes change.
        const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
        const original = fs.statfsSync;
        capacity = vi.spyOn(fs, 'statfsSync').mockImplementation((path, options) => ({
          ...original(path, options as { bigint: true }),
          bavail: 500_000_000n,
          bsize: 1n,
        }));
        syncBuiltinESMExports();
      }
      if (policy === 'nested-reuse') {
        getControlStoreWorkerClient().setFileStorageAdmission(fallbackRoot, fallback!);
        await expect(
          createDataRootAdminOperationImplementations(root, fallback)['storage.layout-report']()
        ).rejects.toMatchObject({ code: 'operation_storage_no_space', status: 507 });
        return;
      }
      if (policy !== 'supplied-refusal') {
        const selected = getControlStoreWorkerClient().getFileStorageAdmission(root);
        expect(selected !== undefined).toBe(true);
        const report = await createDataRootAdminOperationImplementations(root, selected)[
          'storage.layout-report'
        ]();
        expect(report.serverDb.exists).toBe(true);
      }
      const requestId = randomUUID();
      let committed = false;
      await commit(requestId).then(
        () => {
          committed = true;
        },
        (error: unknown) => {
          expect(error).toMatchObject({ code: 'no-space', commit: 'not-committed' });
        }
      );
      expect(committed).toBe(policy === 'lower-configured');
      expect(store.getCommandRequest('knowledge.maintain', requestId, scope, userDb) !== null).toBe(
        policy === 'lower-configured'
      );
    } finally {
      capacity?.mockRestore();
      syncBuiltinESMExports();
      await shutdownControlStoreWorkerClient();
      userDb.sqlite.close();
      coreDb.sqlite.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
);
