import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type { CoreDb } from './db.js';
import { SecurityTriggerRefusal } from './security-trigger-codecs.js';
import { applySecurityTriggerInDb } from './security-trigger-native.js';

const db = new Proxy({} as CoreDb, {
  get() {
    throw new Error('security trigger touched a database handle');
  },
});

describe('alarm mark and enqueue stay off', () => {
  it('refuses the mark before SQL', () => {
    assert.throws(
      () =>
        applySecurityTriggerInDb(db, {
          action: 'alarm-mark-enqueue',
          requestId: '00000000-0000-4000-8000-000000000001',
          threadId: 'thread',
        }),
      (error: unknown) => error instanceof SecurityTriggerRefusal && error.code === 'forbidden'
    );
  });
});
