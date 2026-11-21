import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { expect, it, vi } from 'vitest';
import { listServerAuditEvents } from '../audit-events.js';
import { inspectServerWorkReceipt } from './command-request-records.js';
import { decideServerWorkInDb } from './control-store-admission.js';
import { openCoreDb } from './db.js';
import { readDataRootLayoutMarker } from './fs-layout.js';
import { applyMigrations } from './migrate.js';
import type {
  ServerCallAdmission,
  ServerWorkIntent,
  ServerWorkReceipt,
} from './server-work-port.js';
import { storageRequestId } from './storage-owner.js';

vi.mock('node:worker_threads', async (load) => ({
  ...(await load<typeof import('node:worker_threads')>()),
  isMainThread: false,
}));

it('commits the exact original Server decision and Audit and inspects a lost reply', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-kernel-server-work-'));
  let db = openCoreDb(root);
  try {
    applyMigrations(db);
    const deploymentId = readDataRootLayoutMarker(root).deploymentId;
    const actor = { kind: 'user', id: allocateEntityId('usr') } as const;
    const occurrence = {
      deploymentId,
      sourceOwner: 'server-work',
      verb: 'admit-thread',
      occurrenceKey: 'original-thread',
    } as const;
    const intent: ServerWorkIntent = {
      ...occurrence,
      requestId: storageRequestId(occurrence),
      expectedGeneration: null,
      inputDigest: `sha256:${'a'.repeat(64)}`,
      target: {
        actor,
        threadId: allocateEntityId('th'),
        credentialRef: null,
        recordRef: 'staged-thread',
      },
    };
    const apply = vi.fn(() => {
      db.sqlite
        .prepare("INSERT INTO server_settings(key,value,updated_at) VALUES('test-effect','1',?)")
        .run(new Date().toISOString());
    });
    const verify = vi.fn(() => ({ state: 'applied', apply }) as const);
    const staged = () => ({ intent, receipt: null });
    const decide = () =>
      db.sqlite.transaction(() => decideServerWorkInDb(db, intent, true, staged, verify))();
    db.sqlite.exec(`CREATE TRIGGER fixture_fail_audit BEFORE INSERT ON audit_events
      BEGIN SELECT RAISE(ABORT, 'fixture fail Audit'); END`);
    expect(decide).toThrow('fixture fail Audit');
    expect(
      db.sqlite.prepare("SELECT value FROM server_settings WHERE key='test-effect'").get()
    ).toBeUndefined();
    expect(inspectServerWorkReceipt(db, intent, true)).toEqual({ state: 'absent' });
    db.sqlite.exec('DROP TRIGGER fixture_fail_audit');

    const applied = decide();
    expect(applied).toMatchObject({ state: 'settled', receipt: { disposition: 'applied' } });
    expect(decide()).toEqual(applied);
    expect(verify).toHaveBeenCalledTimes(2);
    db.sqlite.close();
    db = openCoreDb(root);
    expect(inspectServerWorkReceipt(db, intent, false)).toEqual(applied);
    expect(
      inspectServerWorkReceipt(db, { ...intent, expectedGeneration: 'changed' }, true)
    ).toEqual({ state: 'conflict' });
    expect(listServerAuditEvents(db)).toEqual([
      expect.objectContaining({
        requestId: intent.requestId,
        action: 'server-work.admit-thread',
        actor,
      }),
    ]);
  } finally {
    db.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('records a Call refusal without Thread or Turn and holds an owner settled beside older Core', () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-kernel-server-call-'));
  const db = openCoreDb(root);
  try {
    applyMigrations(db);
    const occurrence = {
      deploymentId: readDataRootLayoutMarker(root).deploymentId,
      sourceOwner: 'server-work',
      verb: 'admit-call',
      occurrenceKey: 'original-call',
    } as const;
    const intent: ServerCallAdmission = {
      ...occurrence,
      requestId: storageRequestId(occurrence),
      expectedGeneration: null,
      inputDigest: `sha256:${'a'.repeat(64)}`,
      target: {
        actor: { kind: 'user', id: allocateEntityId('usr') },
        credentialRef: null,
        recordRef: 'staged-call',
        callId: allocateEntityId('cap'),
        threadId: null,
        turnId: null,
        routeRef: 'approved-route',
        budgetRef: null,
      },
    };
    const verify = vi.fn(() => ({ state: 'refused', reason: 'policy' }) as const);
    const ownerReceipt: ServerWorkReceipt = {
      intent,
      disposition: 'refused',
      reason: 'policy',
      receiptDigest: `sha256:${'b'.repeat(64)}`,
    };
    const decide = (completeHistory: boolean, receipt: ServerWorkReceipt | null) =>
      db.sqlite.transaction(() =>
        decideServerWorkInDb(db, intent, completeHistory, () => ({ intent, receipt }), verify)
      )();

    expect(decide(false, null)).toEqual({ state: 'unknown' });
    expect(decide(true, ownerReceipt)).toEqual({ state: 'unknown' });
    expect(verify).not.toHaveBeenCalled();
    const refused = decide(true, null);
    expect(refused).toMatchObject({
      state: 'settled',
      receipt: { disposition: 'refused', reason: 'policy' },
    });
    expect(inspectServerWorkReceipt(db, intent, true)).toEqual(refused);
    expect(listServerAuditEvents(db)).toEqual([
      expect.objectContaining({
        requestId: intent.requestId,
        action: 'server-work.admit-call',
        outcome: 'denied',
      }),
    ]);
  } finally {
    db.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
});
