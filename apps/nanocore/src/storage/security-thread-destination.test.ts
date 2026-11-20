import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { prepareSecurityThread, selectSecurityThread } from '../security/threads.js';
import type { CoreDb } from './db.js';
import { SecurityTriggerRefusal } from './security-trigger-codecs.js';
import { applySecurityTriggerInDb } from './security-trigger-native.js';

const db = new Proxy({} as CoreDb, {
  get() {
    throw new Error('security trigger touched a database handle');
  },
});

describe('security thread destinations stay off', () => {
  it('selects nothing and refuses reservation', async () => {
    assert.equal(
      await selectSecurityThread({
        coreDb: db,
        store: {} as never,
        workspaceId: 'workspace',
        threadId: 'thread',
      }),
      null
    );
    await assert.rejects(
      () => prepareSecurityThread({ coreDb: db, store: {} as never, requestId: 'request' }),
      (error: unknown) => error instanceof SecurityTriggerRefusal && error.code === 'forbidden'
    );
    assert.throws(
      () =>
        applySecurityTriggerInDb(db, {
          action: 'destination-reserve',
          requestId: '00000000-0000-4000-8000-000000000001',
        }),
      (error: unknown) => error instanceof SecurityTriggerRefusal && error.code === 'forbidden'
    );
  });
});
