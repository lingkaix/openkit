import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type { CoreDb } from './db.js';
import { SecurityTriggerRefusal } from './security-trigger-codecs.js';
import {
  applySecurityTriggerInDb,
  SECURITY_TRIGGER_DISABLED_SNAPSHOT,
} from './security-trigger-native.js';

const db = new Proxy({} as CoreDb, {
  get() {
    throw new Error('security trigger touched a database handle');
  },
});

describe('native security trigger refuses before SQL', () => {
  it('reports off for current without reading the six tables', () => {
    assert.deepEqual(
      applySecurityTriggerInDb(db, { action: 'current', timestamp: '2026-11-21T00:00:00.000Z' }),
      { kind: 'state', snapshot: SECURITY_TRIGGER_DISABLED_SNAPSHOT }
    );
  });

  it('refuses enable, stop and audit reads', () => {
    for (const input of [
      {
        action: 'enable',
        actor: { kind: 'local', userId: 'user_test' },
        timestamp: '2026-11-21T00:00:00.000Z',
      },
      {
        action: 'stop',
        actor: { kind: 'local', userId: 'user_test' },
        timestamp: '2026-11-21T00:00:00.000Z',
      },
      { action: 'audit', limit: 1, timestamp: '2026-11-21T00:00:00.000Z' },
      { action: 'alarms' },
    ] as const) {
      assert.throws(
        () => applySecurityTriggerInDb(db, input),
        (error: unknown) => error instanceof SecurityTriggerRefusal && error.code === 'forbidden'
      );
    }
  });
});
