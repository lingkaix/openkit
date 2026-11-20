import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  drainSecurityNotices,
  publishSecurityAlarm,
  readSecurityAlarmPublication,
} from '../security/publication.js';
import type { CoreDb } from './db.js';

const db = new Proxy({} as CoreDb, {
  get() {
    throw new Error('security trigger touched a database handle');
  },
});

describe('alarm publication stays off', () => {
  it('drains nothing and reads no publication', async () => {
    await drainSecurityNotices({ coreDb: db, store: {} as never });
    assert.equal(
      await readSecurityAlarmPublication({
        coreDb: db,
        store: {} as never,
        workspaceId: 'workspace',
        threadId: 'thread',
        requestId: 'request',
      }),
      null
    );
    await assert.rejects(() =>
      publishSecurityAlarm({ coreDb: db, store: {} as never, requestId: 'request' })
    );
  });
});
