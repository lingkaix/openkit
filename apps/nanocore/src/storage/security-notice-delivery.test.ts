import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { publishSecurityAlarm } from '../security/publication.js';
import type { CoreDb } from './db.js';
import { SecurityTriggerRefusal } from './security-trigger-codecs.js';
import { readSecurityAlarmNoticeInDb } from './security-trigger-native.js';

const db = new Proxy({} as CoreDb, {
  get() {
    throw new Error('security trigger touched a database handle');
  },
});

describe('notice delivery stays off', () => {
  it('publishes nothing and reads no notice', async () => {
    await assert.rejects(
      () => publishSecurityAlarm({ coreDb: db, store: {} as never, requestId: 'request' }),
      (error: unknown) => error instanceof SecurityTriggerRefusal && error.code === 'forbidden'
    );
    assert.equal(readSecurityAlarmNoticeInDb(db, 'request'), null);
  });
});
