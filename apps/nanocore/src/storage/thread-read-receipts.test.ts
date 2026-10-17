import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openUserDb } from './db.js';
import { applyScopedMigrations } from './migrate.js';
import { advanceThreadReadReceipt, readThreadReadReceipt } from './thread-read-receipts.js';

const userId = 'usr_019a0000-0000-7000-8000-000000000001';
const workspaceId = 'ws_019a0000-0000-7000-8000-000000000002';
const threadId = 'th_019a0000-0000-7000-8000-000000000003';
const earlierItemId = 'it_019a0000-0000-5000-8000-000000000004';
const laterItemId = 'it_019a0000-0000-5000-8000-000000000005';

describe('User-owned Thread read receipts', () => {
  it('reads without advancing and retains the union across devices and reopen', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-thread-read-'));
    const firstDevice = openUserDb(dataRoot, userId);
    applyScopedMigrations(firstDevice);
    const secondDevice = openUserDb(dataRoot, userId);

    try {
      try {
        expect(readThreadReadReceipt(firstDevice, workspaceId, threadId)).toEqual([]);
        expect(advanceThreadReadReceipt(firstDevice, workspaceId, threadId, [])).toEqual([]);
        expect(firstDevice.sqlite.prepare('SELECT * FROM thread_read_receipts').all()).toEqual([]);
        expect(
          advanceThreadReadReceipt(firstDevice, workspaceId, threadId, [laterItemId, laterItemId])
        ).toEqual([laterItemId]);
        expect(readThreadReadReceipt(secondDevice, workspaceId, threadId)).toEqual([laterItemId]);
        expect(
          advanceThreadReadReceipt(secondDevice, workspaceId, threadId, [earlierItemId])
        ).toEqual([earlierItemId, laterItemId]);
        expect(advanceThreadReadReceipt(firstDevice, workspaceId, threadId, [laterItemId])).toEqual(
          [earlierItemId, laterItemId]
        );
        expect(
          readThreadReadReceipt(firstDevice, workspaceId, 'th_019a0000-0000-7000-8000-000000000006')
        ).toEqual([]);
        expect(
          readThreadReadReceipt(firstDevice, 'ws_019a0000-0000-7000-8000-000000000007', threadId)
        ).toEqual([]);
      } finally {
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
        expect(advanceThreadReadReceipt(reopened, workspaceId, threadId, [])).toEqual([
          earlierItemId,
          laterItemId,
        ]);
        expect(
          reopened.sqlite.prepare('SELECT count(*) AS count FROM thread_read_receipts').get()
        ).toEqual({ count: 1 });
      } finally {
        reopened.sqlite.close();
      }
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('refuses invalid required content without repairing or replacing it', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-thread-read-invalid-'));
    const userDb = openUserDb(dataRoot, userId);
    applyScopedMigrations(userDb);
    try {
      advanceThreadReadReceipt(userDb, workspaceId, threadId, [earlierItemId]);
      expect(() =>
        advanceThreadReadReceipt(userDb, workspaceId, threadId, [laterItemId, ''])
      ).toThrow();
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
        expect(() =>
          advanceThreadReadReceipt(userDb, workspaceId, threadId, [laterItemId])
        ).toThrow('Thread read receipt storage content is invalid');
        expect(
          userDb.sqlite.prepare('SELECT item_ids_json FROM thread_read_receipts').get()
        ).toEqual({ item_ids_json: invalidContent });
      }
    } finally {
      userDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
