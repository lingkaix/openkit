import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type { CoreDb } from './db.js';
import { SecurityTriggerRefusal } from './security-trigger-codecs.js';
import { applySecurityTriggerInDb, enqueueE12NoticeInDb } from './security-trigger-native.js';

const db = new Proxy({} as CoreDb, {
  get() {
    throw new Error('security trigger touched a database handle');
  },
});

describe('audit assessment stays off', () => {
  it('does not enqueue an E12 notice', () => {
    enqueueE12NoticeInDb(db, 'audit_event');
  });

  it('refuses detection paging before SQL', () => {
    assert.throws(
      () => applySecurityTriggerInDb(db, { action: 'detections', limit: 1 }),
      (error: unknown) => error instanceof SecurityTriggerRefusal && error.code === 'forbidden'
    );
    assert.throws(
      () => applySecurityTriggerInDb(db, { action: 'event-outbox' }),
      (error: unknown) => error instanceof SecurityTriggerRefusal && error.code === 'forbidden'
    );
  });
});
