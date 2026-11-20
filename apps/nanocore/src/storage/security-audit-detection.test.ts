import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { SecurityTriggerStore } from '../security/trigger.js';
import type { CoreDb } from './db.js';
import { SecurityTriggerRefusal } from './security-trigger-codecs.js';
import { applySecurityTriggerInDb } from './security-trigger-native.js';

const db = new Proxy({} as CoreDb, {
  get() {
    throw new Error('security trigger touched a database handle');
  },
});

describe('audit detection stays off', () => {
  it('returns an empty scan and refuses the native operation', async () => {
    assert.deepEqual(await new SecurityTriggerStore(db).detectAudit(), {
      cursor: null,
      scanned: 0,
      detected: 0,
      unsupported: 0,
    });
    assert.throws(
      () =>
        applySecurityTriggerInDb(db, {
          action: 'audit-detect',
          limit: 1,
          timestamp: '2026-11-21T00:00:00.000Z',
        }),
      (error: unknown) => error instanceof SecurityTriggerRefusal && error.code === 'forbidden'
    );
  });
});
