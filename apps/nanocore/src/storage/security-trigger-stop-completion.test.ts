import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { SecurityTriggerStore } from '../security/trigger.js';
import type { CoreDb } from './db.js';
import { SECURITY_TRIGGER_DISABLED_SNAPSHOT } from './security-trigger-native.js';

const db = new Proxy({} as CoreDb, {
  get() {
    throw new Error('security trigger touched a database handle');
  },
});

describe('security trigger completion stays off', () => {
  it('reports off and an empty audit page', async () => {
    const trigger = new SecurityTriggerStore(db);
    assert.deepEqual(await trigger.current(), SECURITY_TRIGGER_DISABLED_SNAPSHOT);
    assert.deepEqual(await trigger.readAudit(), { events: [], next: null });
    await assert.rejects(() => trigger.enable({ kind: 'local', userId: 'user' }));
  });
});
