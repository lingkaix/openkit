import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId, canonicalIdentifierName } from '@openkit/protocol';
import { sha256CanonicalJson } from '@openkit/protocol/digest';
import { expect, it, vi } from 'vitest';
import { prepareAuditEvent } from '../audit-events.js';
import {
  inspectChannelInboundReceipt,
  inspectPairingAuditReceipt,
} from './command-request-records.js';
import type { ChannelInboundOrigin } from './communication-port.js';
import {
  bindChannelInboundOriginInDb,
  relayPairingAuditInDb,
  reserveChannelInboundInDb,
  settleChannelInboundInDb,
} from './control-store-admission.js';
import { type CoreDb, openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';
import { storageRequestId } from './storage-owner.js';

vi.mock('node:worker_threads', async (load) => ({
  ...(await load<typeof import('node:worker_threads')>()),
  isMainThread: false,
}));

function withCore(run: (db: CoreDb, root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-kernel-envelope-'));
  const db = openCoreDb(root);
  try {
    applyMigrations(db);
    run(db, root);
  } finally {
    db.sqlite.close();
    rmSync(root, { recursive: true, force: true });
  }
}

it('recovers a permanent envelope after losing the reserve and settle replies', () => {
  withCore((db, root) => {
    const key = {
      deploymentId: 'deployment',
      sourceOwner: 'communication',
      verb: 'channel.inbound',
      occurrenceKey: canonicalIdentifierName(['discord', 'interaction', '123']),
    } as const;
    const envelope = { ...key, requestId: storageRequestId(key), inputDigest: 'a'.repeat(64) };
    const origin: ChannelInboundOrigin = {
      envelope,
      workspaceId: allocateEntityId('ws'),
      threadId: allocateEntityId('th'),
      turnId: allocateEntityId('tu'),
      pendingRequestId: 'ap_mcp_original_approval',
      userId: allocateEntityId('usr'),
      bindingRevision: '00000000-0000-7000-8000-000000000002',
      disclosureDigest: 'd'.repeat(64),
      operation: 'approval.respond',
    };
    const pick = db.sqlite.transaction(() => reserveChannelInboundInDb(db, envelope, true));
    expect(db.sqlite.transaction(() => reserveChannelInboundInDb(db, envelope, false))()).toEqual({
      state: 'unknown',
    });
    expect(pick()).toEqual({ state: 'reserved-now' });
    expect(pick()).toEqual({ state: 'inspect-original' });
    expect(
      db.sqlite.transaction(() =>
        reserveChannelInboundInDb(db, { ...envelope, inputDigest: 'b'.repeat(64) }, true)
      )()
    ).toEqual({ state: 'conflict' });

    const bind = db.sqlite.transaction((candidate: ChannelInboundOrigin) =>
      bindChannelInboundOriginInDb(db, candidate, true)
    );
    expect(bind(origin)).toEqual({ state: 'bound-now' });
    expect(bind(origin)).toEqual({ state: 'inspect-original' });
    expect(bind({ ...origin, userId: allocateEntityId('usr') })).toEqual({ state: 'conflict' });

    const outcome = { kind: 'pending-decision', decisionRef: 'c'.repeat(64) } as const;
    const verify = vi.fn<(candidate: ChannelInboundOrigin) => string | null>(() => null);
    const settle = db.sqlite.transaction(() =>
      settleChannelInboundInDb(db, envelope, outcome, true, verify)
    );
    expect(settle()).toEqual({ state: 'unknown' });
    expect(verify).toHaveBeenCalledWith(origin);
    verify.mockReturnValue(outcome.decisionRef);
    const settled = settle();
    expect(settled).toMatchObject({ state: 'settled', receipt: { result: outcome } });

    const reopened = openCoreDb(root);
    try {
      const original = inspectChannelInboundReceipt(reopened, key, true);
      expect(original).toEqual({
        ...settled,
        origin,
      });
      expect(settle()).toEqual(settled);
      expect(verify).toHaveBeenCalledTimes(2);
    } finally {
      reopened.sqlite.close();
    }
  });
});

it('joins the original pairing Audit and receipt in one transaction, and verifies exact read-back', () => {
  withCore((db) => {
    const userId = allocateEntityId('usr');
    const bindingRevision = '00000000-0000-7000-8000-000000000002';
    const actor = { kind: 'user', id: userId } as const;
    const event = prepareAuditEvent({
      action: 'channel.pairing.bind',
      workspaceId: null,
      actor,
      subject: actor,
      resource: `channel:discord:${userId}`,
      outcome: 'succeeded',
      summary: JSON.stringify({
        channelKind: 'discord',
        bindingRevision,
        userId,
        administratorAtEvent: true,
      }),
    });
    const key = {
      deploymentId: 'deployment',
      sourceOwner: 'communication',
      verb: 'relay-pairing-audit',
      occurrenceKey: event.id,
    } as const;
    const intent = {
      ...key,
      requestId: storageRequestId(key),
      inputDigest: sha256CanonicalJson(event),
      expectedGeneration: bindingRevision,
      target: { eventId: event.id },
    };
    expect(inspectPairingAuditReceipt(db, intent, false)).toEqual({ state: 'unknown' });
    expect(() =>
      db.sqlite.transaction(() => {
        relayPairingAuditInDb(db, intent, event, true);
        throw new Error('fail the complete transaction');
      })()
    ).toThrow('fail the complete transaction');
    expect(inspectPairingAuditReceipt(db, intent, true)).toEqual({ state: 'absent' });
    expect(db.sqlite.prepare('SELECT audit_event_id FROM audit_events').all()).toEqual([]);

    const relay = db.sqlite.transaction(() => relayPairingAuditInDb(db, intent, event, true));
    const applied = relay();
    expect(applied).toMatchObject({ state: 'settled', receipt: { result: { eventId: event.id } } });
    expect(relay()).toEqual(applied);
    expect(inspectPairingAuditReceipt(db, intent, true)).toEqual(applied);
    expect(
      inspectPairingAuditReceipt(db, { ...intent, inputDigest: 'a'.repeat(64) }, true)
    ).toEqual({ state: 'conflict' });
    db.sqlite
      .prepare('UPDATE audit_events SET summary=? WHERE audit_event_id=?')
      .run('Changed retained Audit.', event.id);
    expect(inspectPairingAuditReceipt(db, intent, true)).toEqual({ state: 'unknown' });
  });
});
