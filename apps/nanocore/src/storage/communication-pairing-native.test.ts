import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allocateEntityId, canonicalJsonText } from '@openkit/protocol';
import { sha256CanonicalJson, sha256Hex } from '@openkit/protocol/digest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readCommunicationDisclosure,
  writeCommunicationDisclosureInDb,
} from './communication-disclosure-native.js';
import { communicationOwner } from './communication-owner.js';
import {
  issuePairingChallengeInDb,
  pairCommunicationInDb,
  readCommunicationBinding,
  readCommunicationBindingForAccount,
  readPairingChallengeUser,
  readPendingPairingAuditInDb,
  revokePairingChallengesInDb,
  settlePairingAuditInDb,
  unbindCommunicationInDb,
} from './communication-pairing-native.js';
import { relayNextPairingAudit } from './communication-pairing-relay.js';
import type {
  ChannelInboundEnvelope,
  PairingAuditIntent,
  PairingAuditReceipt,
} from './communication-port.js';
import type { ControlKernelStore } from './control-kernel-port.js';
import { configureOwnedSqlite } from './control-store.js';
import { storageRequestId } from './storage-owner.js';

const alice = allocateEntityId('usr');
const bob = allocateEntityId('usr');
const deploymentId = 'communication-owner-fixture';
const firstDigest = sha256Hex('first-challenge');
const secondDigest = sha256Hex('second-challenge');

function envelope(eventId: string): ChannelInboundEnvelope {
  const key = {
    deploymentId,
    sourceOwner: 'communication',
    verb: 'channel.inbound',
    occurrenceKey: JSON.stringify(['discord', 'interaction', eventId]),
  } as const;
  return { ...key, requestId: storageRequestId(key), inputDigest: sha256Hex(eventId) };
}

function appliedPairingReceipt(intent: PairingAuditIntent): PairingAuditReceipt {
  const facts = {
    intent,
    disposition: 'applied',
    result: { eventId: intent.target.eventId },
  } as const;
  const digest = sha256Hex(canonicalJsonText(['openkit:storage-receipt:v1', facts]));
  return { ...facts, receiptDigest: `sha256:${digest}` };
}

describe('communication pairing owner', () => {
  let folder: string;
  let path: string;
  let writer: Database.Database;
  let now: number;
  let active: Set<string>;
  let administrators: Set<string>;
  const context = {
    deploymentId,
    now: () => now,
    currentAuthority: (userId: string) =>
      active.has(userId) ? { administratorAtEvent: administrators.has(userId) } : null,
  };

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'communication-pairing-'));
    path = join(folder, 'state.sqlite');
    writer = new Database(path);
    configureOwnedSqlite(writer);
    migrate(drizzle(writer), {
      migrationsFolder: fileURLToPath(
        new URL('../../drizzle/services/communication/', import.meta.url)
      ),
    });
    now = 100;
    active = new Set([alice, bob]);
    administrators = new Set([alice]);
  });

  afterEach(() => {
    writer.close();
    rmSync(folder, { recursive: true, force: true });
  });

  function issue(userId: string, digest: string) {
    issuePairingChallengeInDb(writer, { userId, digest, expiresAt: now + 50 }, context);
  }

  function pair(challengeDigest = firstDigest, externalAccountId = '101', eventId = '201') {
    return pairCommunicationInDb(
      writer,
      { envelope: envelope(eventId), challengeDigest, externalAccountId },
      context
    );
  }

  it('applies the standalone journal with only its declared tables and local foreign keys', () => {
    const tables = writer
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations'"
      )
      .pluck()
      .all();
    const approved = [
      'channel_account_bindings',
      'channel_pairing_challenges',
      'channel_disclosures',
      'notification_attention',
      'notification_delivery_attempts',
      'communication_intents',
    ].sort();
    expect(tables.sort()).toEqual(approved);
    expect([...communicationOwner.requiredTables].sort()).toEqual(approved);
    expect(writer.prepare('SELECT count(*) FROM __drizzle_migrations').pluck().get()).toBe(1);
    expect(writer.pragma('foreign_key_list(notification_delivery_attempts)')).toEqual([
      expect.objectContaining({ table: 'notification_attention', on_delete: 'CASCADE' }),
    ]);
    expect(writer.pragma('foreign_key_check')).toEqual([]);
    expect(writer.pragma('synchronous', { simple: true })).toBe(2);
  });

  it('stores only a digest and refuses superseded, expired or currently inactive challenges', () => {
    issue(alice, firstDigest);
    issue(alice, secondDigest);
    expect(readPairingChallengeUser(writer, firstDigest, now)).toBeNull();
    expect(() => pair()).toThrow('Pairing challenge unavailable.');
    active.delete(alice);
    expect(() => pair(secondDigest)).toThrow('Pairing challenge unavailable.');
    active.add(alice);
    now = 150;
    expect(() => pair(secondDigest)).toThrow('Pairing challenge unavailable.');
    expect(
      writer.prepare('SELECT digest FROM channel_pairing_challenges ORDER BY rowid').pluck().all()
    ).toEqual([firstDigest, secondDigest]);
    expect(readCommunicationBinding(writer, alice)).toBeNull();
    expect(readPendingPairingAuditInDb(writer)).toBeNull();
  });

  it('admits only one active binding per account and User and retains revoked revisions', () => {
    issue(alice, firstDigest);
    issue(bob, secondDigest);
    const original = pair();

    expect(() => pair(secondDigest, '101', '202')).toThrow('An active binding exists.');
    expect(readPairingChallengeUser(writer, secondDigest, now)).toBe(bob);
    const laterDigest = sha256Hex('new-alice-challenge');
    issue(alice, laterDigest);
    expect(() => pair(laterDigest, '102', '203')).toThrow('An active binding exists.');
    const insert = writer.prepare(
      "INSERT INTO channel_account_bindings VALUES (?, 'discord', ?, ?, ?, NULL)"
    );
    expect(() => insert.run(randomUUID(), '101', bob, now)).toThrow('UNIQUE constraint failed');
    expect(() => insert.run(randomUUID(), '102', alice, now)).toThrow('UNIQUE constraint failed');

    now++;
    administrators.delete(alice);
    expect(() =>
      unbindCommunicationInDb(writer, { userId: alice, bindingRevision: randomUUID() }, context)
    ).toThrow('Current binding unavailable.');
    expect(readPairingChallengeUser(writer, laterDigest, now)).toBe(alice);
    const revoked = unbindCommunicationInDb(
      writer,
      { userId: alice, bindingRevision: original.bindingRevision },
      context
    );
    expect(readPairingChallengeUser(writer, laterDigest, now)).toBeNull();
    expect(readCommunicationBinding(writer, alice)).toBeNull();
    expect(JSON.parse(original.audit.summary)).toMatchObject({ administratorAtEvent: true });
    expect(JSON.parse(revoked.audit.summary)).toMatchObject({ administratorAtEvent: false });
    const next = pair(secondDigest, '101', '202');
    expect(next.bindingRevision).not.toBe(original.bindingRevision);
    expect(readCommunicationBinding(writer, bob)?.revision).toBe(next.bindingRevision);
    expect(
      writer
        .prepare('SELECT revoked_at FROM channel_account_bindings WHERE revision = ?')
        .pluck()
        .get(original.bindingRevision)
    ).toBe(now);
  });

  it('revokes a retained challenge without a binding and refuses a newer binding after observation', () => {
    issue(alice, firstDigest);
    expect(readCommunicationBinding(writer, alice)).toBeNull();
    active.delete(alice);
    expect(() => revokePairingChallengesInDb(writer, alice, context)).toThrow(
      'Current unbind authority is unavailable.'
    );
    active.add(alice);
    expect(readPairingChallengeUser(writer, firstDigest, now)).toBe(alice);
    revokePairingChallengesInDb(writer, alice, context);
    expect(readPairingChallengeUser(writer, firstDigest, now)).toBeNull();
    expect(
      writer.prepare('SELECT digest, consumed_at FROM channel_pairing_challenges').get()
    ).toEqual({ digest: firstDigest, consumed_at: now });
    expect(readPendingPairingAuditInDb(writer)).toBeNull();

    issue(alice, secondDigest);
    expect(readCommunicationBinding(writer, alice)).toBeNull();
    const binding = pair(secondDigest);
    const newerDigest = sha256Hex('challenge-created-after-binding');
    issue(alice, newerDigest);
    expect(() => revokePairingChallengesInDb(writer, alice, context)).toThrow(
      'Current binding changed.'
    );
    expect(readCommunicationBinding(writer, alice)?.revision).toBe(binding.bindingRevision);
    expect(readPairingChallengeUser(writer, newerDigest, now)).toBe(alice);
  });

  it('serializes competing pair transactions on two connections', () => {
    issue(alice, firstDigest);
    issue(bob, secondDigest);
    const other = new Database(path, { fileMustExist: true, timeout: 0 });
    const competing = {
      envelope: envelope('202'),
      challengeDigest: secondDigest,
      externalAccountId: '101',
    };
    try {
      const winner = pairCommunicationInDb(
        writer,
        { envelope: envelope('201'), challengeDigest: firstDigest, externalAccountId: '101' },
        {
          ...context,
          currentAuthority(userId) {
            expect(() => pairCommunicationInDb(other, competing, context)).toThrow(
              'database is locked'
            );
            return context.currentAuthority(userId);
          },
        }
      );
      expect(() => pairCommunicationInDb(other, competing, context)).toThrow(
        'An active binding exists.'
      );
      expect(readPairingChallengeUser(other, secondDigest, now)).toBe(bob);
      expect(readPendingPairingAuditInDb(other)).toEqual(winner);
    } finally {
      other.close();
    }
  });

  it('rolls back binding, challenge and unbind when the local Audit INSERT fails', () => {
    issue(alice, firstDigest);
    const rejectAudit =
      "CREATE TRIGGER reject_audit BEFORE INSERT ON communication_intents WHEN NEW.kind = 'relay-pairing-audit' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END";
    writer.exec(rejectAudit);
    expect(() => pair()).toThrow('audit unavailable');
    expect(readPairingChallengeUser(writer, firstDigest, now)).toBe(alice);
    expect(readCommunicationBinding(writer, alice)).toBeNull();
    expect(readPendingPairingAuditInDb(writer)).toBeNull();
    writer.exec('DROP TRIGGER reject_audit');
    const change = pair();
    issue(alice, secondDigest);
    writer.exec(rejectAudit);

    expect(() =>
      unbindCommunicationInDb(
        writer,
        { userId: alice, bindingRevision: change.bindingRevision },
        context
      )
    ).toThrow('audit unavailable');
    expect(readCommunicationBinding(writer, alice)?.revision).toBe(change.bindingRevision);
    expect(readPairingChallengeUser(writer, secondDigest, now)).toBe(alice);
    expect(readPendingPairingAuditInDb(writer)).toEqual(change);
  });

  it('checks the retained version before decoding and refuses changed or incomplete Audit bytes', () => {
    issue(alice, firstDigest);
    const original = pair();
    const replace = writer.prepare(
      'UPDATE communication_intents SET event_json = ?, intent_json = ? WHERE request_id = ?'
    );
    const eventJson = canonicalJsonText(original.audit);
    const intentJson = canonicalJsonText(original.relay);

    replace.run(` ${eventJson}`, intentJson, original.relay.requestId);
    expect(() => readPendingPairingAuditInDb(writer)).toThrow('Audit digest differs');

    const incomplete = canonicalJsonText({ ...original.audit, workspaceId: undefined });
    replace.run(incomplete, intentJson, original.relay.requestId);
    expect(() => readPendingPairingAuditInDb(writer)).toThrow('Audit digest differs');
    const changedIntent = canonicalJsonText({
      ...original.relay,
      inputDigest: sha256Hex(incomplete),
    });
    replace.run(incomplete, changedIntent, original.relay.requestId);
    expect(() => readPendingPairingAuditInDb(writer)).toThrow(/workspaceId/);

    writer.pragma('ignore_check_constraints = ON');
    writer
      .prepare('UPDATE communication_intents SET schema_version = 2, intent_json = ?')
      .run('{"future":"unknown"}');
    expect(() => readPendingPairingAuditInDb(writer)).toThrow(
      'Unsupported retained record format.'
    );
  });

  it('authorizes a disclosure only for its current binding and exact request until authority expires', () => {
    issue(alice, firstDigest);
    const binding = pair();
    expect(readCommunicationBindingForAccount(writer, '101')?.revision).toBe(
      binding.bindingRevision
    );
    const disclosure = {
      externalAccountId: '101',
      bindingRevision: binding.bindingRevision,
      userId: alice,
      workspaceId: allocateEntityId('ws'),
      threadId: allocateEntityId('th'),
      pendingRequestId: 'original-input',
      tokenDigest: sha256Hex('private-disclosure'),
      contentDigest: sha256Hex('disclosed-input'),
      kind: 'user-input',
      expiresAt: now + 20,
    } as const;
    writeCommunicationDisclosureInDb(writer, disclosure, now);
    expect(readCommunicationDisclosure(writer, disclosure, now)).toEqual({
      kind: disclosure.kind,
      contentDigest: disclosure.contentDigest,
      expiresAt: disclosure.expiresAt,
    });
    expect(
      readCommunicationDisclosure(writer, { ...disclosure, pendingRequestId: 'other-input' }, now)
    ).toBeNull();
    expect(readCommunicationDisclosure(writer, disclosure, disclosure.expiresAt)).toBeNull();

    unbindCommunicationInDb(
      writer,
      { userId: alice, bindingRevision: binding.bindingRevision },
      context
    );
    issue(bob, secondDigest);
    const rebound = pair(secondDigest, '101', '202');
    expect(readCommunicationBindingForAccount(writer, '101')?.revision).toBe(
      rebound.bindingRevision
    );
    expect(readCommunicationDisclosure(writer, disclosure, now)).toBeNull();
    expect(() => writeCommunicationDisclosureInDb(writer, disclosure, now)).toThrow(
      'Current disclosure unavailable.'
    );
    expect(writer.prepare('SELECT count(*) FROM channel_disclosures').pluck().get()).toBe(1);
  });

  it('relays the original event after reopen and settles a lost kernel ACK by inspection', async () => {
    issue(alice, firstDigest);
    const change = pair();
    const unbound = unbindCommunicationInDb(
      writer,
      { userId: alice, bindingRevision: change.bindingRevision },
      context
    );
    const appended = new Map<string, PairingAuditReceipt>();
    const kernel: Pick<ControlKernelStore, 'inspectPairingAudit' | 'relayPairingAudit'> = {
      inspectPairingAudit: vi.fn(async (intent) => {
        const receipt = appended.get(intent.requestId);
        return {
          state: 'ready',
          value: receipt ? { state: 'settled', receipt } : { state: 'absent' },
        };
      }),
      relayPairingAudit: vi.fn(async (intent, event) => {
        expect(intent.target.eventId).toBe(event.id);
        expect(intent.inputDigest).toBe(sha256CanonicalJson(event));
        const receipt = appliedPairingReceipt(intent);
        appended.set(intent.requestId, receipt);
        if (event.id === change.audit.id) throw new Error('kernel ACK lost');
        return { state: 'ready', value: { state: 'settled', receipt } };
      }),
    };

    const reader = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const communication = {
        readPendingPairingAudit: async () => ({
          state: 'ready' as const,
          value: readPendingPairingAuditInDb(reader),
        }),
        settlePairingAudit: async (receipt: PairingAuditReceipt) => {
          settlePairingAuditInDb(writer, receipt);
          return { state: 'ready' as const, value: undefined };
        },
      };
      expect(await communication.readPendingPairingAudit()).toEqual({
        state: 'ready',
        value: change,
      });
      await expect(relayNextPairingAudit(communication, kernel)).rejects.toThrow('kernel ACK lost');
      writer.close();
      writer = new Database(path, { fileMustExist: true });
      configureOwnedSqlite(writer);

      const original = appended.get(change.relay.requestId)!;
      vi.mocked(kernel.inspectPairingAudit).mockResolvedValueOnce({
        state: 'ready',
        value: {
          state: 'settled',
          receipt: {
            ...original,
            receiptDigest: appliedPairingReceipt(unbound.relay).receiptDigest,
          },
        },
      });
      await expect(relayNextPairingAudit(communication, kernel)).rejects.toThrow(
        'Kernel receipt digest does not match'
      );
      expect(readPendingPairingAuditInDb(reader)).toEqual(change);
      expect(
        writer
          .prepare('SELECT receipt_digest FROM communication_intents WHERE request_id = ?')
          .pluck()
          .get(change.relay.requestId)
      ).toBeNull();

      expect(() =>
        settlePairingAuditInDb(
          writer,
          appliedPairingReceipt({
            ...original.intent,
            inputDigest: secondDigest,
          })
        )
      ).toThrow('does not match');
      expect(readPendingPairingAuditInDb(reader)).toEqual(change);
      await expect(relayNextPairingAudit(communication, kernel)).resolves.toEqual({
        state: 'ready',
        value: 'relayed',
      });
      expect(kernel.relayPairingAudit).toHaveBeenCalledTimes(1);
      expect(readPendingPairingAuditInDb(reader)).toEqual(unbound);
      await expect(relayNextPairingAudit(communication, kernel)).resolves.toEqual({
        state: 'ready',
        value: 'relayed',
      });
      expect([...appended.keys()]).toEqual([change.relay.requestId, unbound.relay.requestId]);
      expect(readPendingPairingAuditInDb(reader)).toBeNull();
    } finally {
      reader.close();
    }
  });
});
