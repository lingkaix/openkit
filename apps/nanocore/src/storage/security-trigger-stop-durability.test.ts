import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { SecurityTriggerStore } from '../security/trigger.js';
import type { CoreDb } from './db.js';

const db = new Proxy({} as CoreDb, {
  get() {
    throw new Error('security trigger touched a database handle');
  },
});

describe('security trigger stop stays off', () => {
  it('refuses stop before SQL', async () => {
    await assert.rejects(() =>
      new SecurityTriggerStore(db).stop({ kind: 'local', userId: 'user' })
    );
  });
});
