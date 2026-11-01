import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import {
  CONTROL_WORKER_VERSION,
  isControlWorkerReply,
  isControlWorkerRequest,
} from './control-store-worker-protocol.js';
import { openUserDb } from './db.js';
import { userDbPath } from './fs-layout.js';
import { applyScopedMigrations } from './migrate.js';
import { advanceThreadReadReceipt, readThreadReadReceipt } from './thread-read-receipts.js';

const userId = 'usr_019a0000-0000-7000-8000-000000000001';
const workspaceId = 'ws_019a0000-0000-7000-8000-000000000002';
const threadId = 'th_019a0000-0000-7000-8000-000000000003';
const earlierItemId = 'it_019a0000-0000-5000-8000-000000000004';
const laterItemId = 'it_019a0000-0000-5000-8000-000000000005';

describe('User-owned Thread read receipts', () => {
  it('reads without advancing and retains the native union across devices and reopen', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-thread-read-'));
    const firstDevice = openUserDb(dataRoot, userId);
    applyScopedMigrations(firstDevice);
    const secondDevice = openUserDb(dataRoot, userId);

    try {
      try {
        expect(readThreadReadReceipt(firstDevice, workspaceId, threadId)).toEqual([]);
        await expect(
          Promise.resolve(advanceThreadReadReceipt(firstDevice, workspaceId, threadId, []))
        ).resolves.toEqual([]);
        expect(firstDevice.sqlite.prepare('SELECT * FROM thread_read_receipts').all()).toEqual([]);
        const database = `user:${userDbPath(dataRoot, userId)}`;
        const content = new TextEncoder().encode(JSON.stringify([laterItemId]))
          .buffer as ArrayBuffer;
        const nativeRequest = {
          version: CONTROL_WORKER_VERSION,
          id: 0,
          database,
          operation: 'thread-read-membership' as const,
          input: { userId, workspaceId, threadId, byteLength: content.byteLength },
          content,
        };
        expect(isControlWorkerRequest(nativeRequest)).toBe(true);
        expect(
          isControlWorkerRequest({
            ...nativeRequest,
            input: { ...nativeRequest.input, byteLength: content.byteLength + 1 },
          })
        ).toBe(false);
        expect(
          isControlWorkerRequest({
            ...nativeRequest,
            input: { ...nativeRequest.input, futureRequiredSemantics: true },
          })
        ).toBe(false);
        const nativeReply = {
          version: CONTROL_WORKER_VERSION,
          id: 0,
          status: 'ok' as const,
          operation: 'thread-read-membership' as const,
          itemIds: [earlierItemId, laterItemId],
        };
        expect(isControlWorkerReply(nativeReply)).toBe(true);
        expect(isControlWorkerReply({ ...nativeReply, itemIds: [laterItemId, laterItemId] })).toBe(
          false
        );
        expect(
          isControlWorkerReply({ ...nativeReply, itemIds: [laterItemId, earlierItemId] })
        ).toBe(false);
        const resumeNativeWrites =
          await getControlStoreWorkerClient().pauseForDataRootBackup(database);
        let settled = false;
        const firstAdvance = Promise.resolve(
          advanceThreadReadReceipt(firstDevice, workspaceId, threadId, [laterItemId, laterItemId])
        ).then((membership) => {
          settled = true;
          return membership;
        });
        try {
          await new Promise((resolve) => setImmediate(resolve));
          expect.soft(settled).toBe(false);
          expect
            .soft(firstDevice.sqlite.prepare('SELECT * FROM thread_read_receipts').all())
            .toEqual([]);
        } finally {
          resumeNativeWrites();
        }
        await expect(firstAdvance).resolves.toEqual([laterItemId]);
        expect(readThreadReadReceipt(secondDevice, workspaceId, threadId)).toEqual([laterItemId]);
        await expect(
          Promise.resolve(
            advanceThreadReadReceipt(secondDevice, workspaceId, threadId, [earlierItemId])
          )
        ).resolves.toEqual([earlierItemId, laterItemId]);
        await expect(
          Promise.resolve(
            advanceThreadReadReceipt(firstDevice, workspaceId, threadId, [laterItemId])
          )
        ).resolves.toEqual([earlierItemId, laterItemId]);
        expect(
          readThreadReadReceipt(firstDevice, workspaceId, 'th_019a0000-0000-7000-8000-000000000006')
        ).toEqual([]);
        expect(
          readThreadReadReceipt(firstDevice, 'ws_019a0000-0000-7000-8000-000000000007', threadId)
        ).toEqual([]);
      } finally {
        await shutdownControlStoreWorkerClient();
        firstDevice.sqlite.close();
        secondDevice.sqlite.close();
      }

      const reopened = openUserDb(dataRoot, userId);
      try {
        applyScopedMigrations(reopened);
        expect(readThreadReadReceipt(reopened, workspaceId, threadId)).toEqual([
          earlierItemId,
          laterItemId,
        ]);
        await expect(
          Promise.resolve(advanceThreadReadReceipt(reopened, workspaceId, threadId, []))
        ).resolves.toEqual([earlierItemId, laterItemId]);
        expect(
          reopened.sqlite.prepare('SELECT count(*) AS count FROM thread_read_receipts').get()
        ).toEqual({ count: 1 });
      } finally {
        await shutdownControlStoreWorkerClient();
        reopened.sqlite.close();
      }
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('writes v1 membership and reads it without changing the User database', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-thread-read-v1-'));
    const userDb = openUserDb(dataRoot, userId);
    try {
      applyScopedMigrations(userDb);
      await expect(
        Promise.resolve(
          advanceThreadReadReceipt(userDb, workspaceId, threadId, [
            laterItemId,
            earlierItemId,
            laterItemId,
          ])
        )
      ).resolves.toEqual([earlierItemId, laterItemId]);
      expect(
        userDb.sqlite
          .prepare(
            'SELECT schema_version AS schemaVersion, item_ids_json FROM thread_read_receipts'
          )
          .get()
      ).toEqual({
        schemaVersion: 1,
        item_ids_json: JSON.stringify([earlierItemId, laterItemId]),
      });
      const changes = userDb.sqlite.prepare('SELECT total_changes() AS count').get();

      expect(readThreadReadReceipt(userDb, workspaceId, threadId)).toEqual([
        earlierItemId,
        laterItemId,
      ]);
      expect(userDb.sqlite.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
    } finally {
      await shutdownControlStoreWorkerClient();
      userDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('refuses an unknown version before decoding malformed membership without repair', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-thread-read-version-'));
    const userDb = openUserDb(dataRoot, userId);
    try {
      applyScopedMigrations(userDb);
      await advanceThreadReadReceipt(userDb, workspaceId, threadId, [earlierItemId]);
      expect(readThreadReadReceipt(userDb, workspaceId, threadId)).toEqual([earlierItemId]);
      userDb.sqlite
        .prepare('UPDATE thread_read_receipts SET schema_version = 2, item_ids_json = ?')
        .run('{');

      let failure: unknown;
      try {
        readThreadReadReceipt(userDb, workspaceId, threadId);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({
        message: 'Thread read receipt storage content is invalid.',
        cause: { name: 'TypeError', message: 'Unsupported retained record format.' },
      });
      await expect(
        Promise.resolve().then(() =>
          advanceThreadReadReceipt(userDb, workspaceId, threadId, [laterItemId])
        )
      ).rejects.toThrow('Thread read receipt storage content is invalid');
      expect(
        userDb.sqlite
          .prepare(
            'SELECT schema_version AS schemaVersion, item_ids_json FROM thread_read_receipts'
          )
          .get()
      ).toEqual({ schemaVersion: 2, item_ids_json: '{' });
    } finally {
      await shutdownControlStoreWorkerClient();
      userDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('refuses invalid required content without repairing or replacing it', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-thread-read-invalid-'));
    const userDb = openUserDb(dataRoot, userId);
    applyScopedMigrations(userDb);
    try {
      await advanceThreadReadReceipt(userDb, workspaceId, threadId, [earlierItemId]);
      await expect(
        Promise.resolve().then(() =>
          advanceThreadReadReceipt(userDb, workspaceId, threadId, [laterItemId, ''])
        )
      ).rejects.toThrow();
      expect(readThreadReadReceipt(userDb, workspaceId, threadId)).toEqual([earlierItemId]);

      for (const invalidContent of [
        '{',
        '{}',
        '[""]',
        JSON.stringify([earlierItemId, earlierItemId]),
      ]) {
        userDb.sqlite
          .prepare('UPDATE thread_read_receipts SET item_ids_json = ?')
          .run(invalidContent);
        expect(() => readThreadReadReceipt(userDb, workspaceId, threadId)).toThrow(
          'Thread read receipt storage content is invalid'
        );
        await expect(
          Promise.resolve().then(() =>
            advanceThreadReadReceipt(userDb, workspaceId, threadId, [laterItemId])
          )
        ).rejects.toThrow('Thread read receipt storage content is invalid');
        expect(
          userDb.sqlite.prepare('SELECT item_ids_json FROM thread_read_receipts').get()
        ).toEqual({ item_ids_json: invalidContent });
      }
    } finally {
      await shutdownControlStoreWorkerClient();
      userDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
