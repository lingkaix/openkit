import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { testEntityId } from '../test-support/entity-ids.js';
import { openCoreDb } from './db.js';
import {
  readDiscordGuildReceiptQuestion,
  reserveDiscordGuildReceipt,
  settleDiscordGuildReceipt,
} from './discord-guild-receipts.js';
import {
  reconcileDiscordInboundCommands,
  reserveDiscordInboundCommand,
  settleDiscordInboundCommand,
} from './discord-inbound-commands.js';
import { applyMigrations } from './migrate.js';

const now = Date.UTC(2026, 10, 20);
const mention = {
  guildId: '100',
  channelId: '200',
  messageId: '300',
  botUserId: '400',
  postedAt: now,
  inputHash: 'a'.repeat(64),
};
const origin = {
  principalId: 'external-principal',
  tier: 'basic' as const,
  tierRevision: 't1',
  bindingId: 'b1',
  bindingRevision: 'b2',
  definitionId: 'reports',
  definitionRevision: 'd1',
  collectionSetRevision: 'c1',
  agentId: 'reports-agent',
  botUserId: '400',
  onBehalfOf: null,
  pairingRevision: null,
};
const work = { threadId: testEntityId('th', 'reports'), turnId: testEntityId('tu', 'reports') };
const uuid = '625bf292-180d-4d2f-8092-63baccc37267';

function fixture(run: (open: () => ReturnType<typeof openCoreDb>['sqlite']) => void) {
  const root = mkdtempSync(join(tmpdir(), 'discord-receipt-'));
  const dbs: ReturnType<typeof openCoreDb>[] = [];
  try {
    const open = () => {
      const db = openCoreDb(root);
      dbs.push(db);
      applyMigrations(db);
      return db.sqlite;
    };
    run(open);
  } finally {
    for (const db of dbs) if (db.sqlite.open) db.sqlite.close();
    rmSync(root, { force: true, recursive: true });
  }
}

describe('Reports guild command receipts', () => {
  it('reads the immutable question digest and lossless Discord instant by committed origin', () =>
    fixture((open) => {
      const db = open();
      const exact = {
        ...mention,
        postedAtExact: '2026-11-20T00:00:00.000001Z',
        questionDigest: 'b'.repeat(64),
      };
      const reserved = reserveDiscordGuildReceipt(db, exact, { now, admit: () => origin });
      if (reserved.status !== 'reserved') throw new Error('expected reservation');
      expect(reserved).toMatchObject({
        questionDigest: exact.questionDigest,
        postedAt: exact.postedAtExact,
      });
      const legacy = reserveDiscordGuildReceipt(
        db,
        { ...mention, messageId: '900' },
        { now, admit: () => origin }
      );
      if (legacy.status !== 'reserved') throw new Error('expected legacy reservation');
      db.close();
      const reopened = open();
      expect(readDiscordGuildReceiptQuestion(reopened, legacy.originId)).toBeNull();
      expect(
        reserveDiscordGuildReceipt(
          reopened,
          { ...exact, postedAtExact: '2026-11-20T00:00:00.000002Z' },
          { now, admit: () => origin }
        )
      ).toEqual({ status: 'unknown' });
      expect(readDiscordGuildReceiptQuestion(reopened, reserved.originId)).toEqual({
        guildId: exact.guildId,
        channelId: exact.channelId,
        messageId: exact.messageId,
        origin,
        questionDigest: exact.questionDigest,
        postedAt: exact.postedAtExact,
      });
      expect(settleDiscordGuildReceipt(reopened, exact, reserved.originId, null)).toBe(true);
      expect(readDiscordGuildReceiptQuestion(reopened, reserved.originId)).toBeNull();
    }));
  it('skips opaque future guild payloads before parsing and still recovers supported rows', () =>
    fixture((open) => {
      const db = open();
      const future = { ...mention, messageId: '800' };
      expect(reserveDiscordGuildReceipt(db, future, { now, admit: () => origin }).status).toBe(
        'reserved'
      );
      expect(reserveDiscordGuildReceipt(db, mention, { now, admit: () => origin }).status).toBe(
        'reserved'
      );
      const futureKey = JSON.stringify([
        'guild-mention',
        future.guildId,
        future.channelId,
        future.messageId,
      ]);
      db.prepare(
        'UPDATE idempotency_requests SET schema_version = 2, response_json = ? WHERE request_id = ?'
      ).run('opaque future data', futureKey);
      db.close();
      const reopened = open();
      expect(reconcileDiscordInboundCommands(reopened)).toBe(1);
      expect(
        reopened
          .prepare('SELECT response_json AS body FROM idempotency_requests WHERE request_id = ?')
          .get(futureKey)
      ).toEqual({ body: 'opaque future data' });
      expect(
        reopened
          .prepare('SELECT response_json AS body FROM idempotency_requests WHERE request_id <> ?')
          .get(futureKey)
      ).toEqual({ body: expect.stringContaining('response-unknown') });
    }));
  it('rolls back native admission side effects when its result is refused', () =>
    fixture((open) => {
      const db = open();
      db.exec('CREATE TEMP TABLE fixture_capacity (slot INTEGER)');
      expect(
        reserveDiscordGuildReceipt(db, mention, {
          now,
          admit: () => {
            db.exec('INSERT INTO fixture_capacity VALUES (1)');
            return { ...origin, botUserId: '999' };
          },
        })
      ).toEqual({ status: 'refused' });
      expect(db.prepare('SELECT * FROM fixture_capacity').all()).toEqual([]);
    }));

  it('does not return or rewrite a contradictory retained scope', () =>
    fixture((open) => {
      const db = open();
      const first = reserveDiscordGuildReceipt(db, mention, { now, admit: () => origin });
      if (first.status !== 'reserved') throw new Error('expected reservation');
      db.prepare('UPDATE idempotency_requests SET scope_json = ?').run(
        JSON.stringify({
          coreId: 'server',
          guildId: mention.guildId,
          channelId: '999',
        })
      );
      expect(reserveDiscordGuildReceipt(db, mention, { now, admit: () => origin })).toEqual({
        status: 'unknown',
      });
      expect(settleDiscordGuildReceipt(db, mention, first.originId, work)).toBe(false);
    }));
  it('reserves once, retains the original origin, and resolves old exact replays before freshness or authority', () =>
    fixture((open) => {
      const db = open();
      const admit = vi.fn(() => origin);
      const first = reserveDiscordGuildReceipt(db, mention, { now, admit });
      expect(first).toMatchObject({ status: 'reserved', origin });
      if (first.status !== 'reserved') throw new Error('missing reservation');
      expect(reserveDiscordGuildReceipt(db, mention, { now, admit })).toEqual({
        status: 'unknown',
      });
      expect(settleDiscordGuildReceipt(db, mention, uuid, work)).toBe(false);
      expect(settleDiscordGuildReceipt(db, mention, first.originId, work)).toBe(true);
      expect(settleDiscordGuildReceipt(db, mention, first.originId, null)).toBe(false);
      db.close();
      const reopened = open();
      expect(reserveDiscordGuildReceipt(reopened, mention, { now: now + 310_000, admit })).toEqual({
        status: 'settled',
        work,
      });
      expect(
        reserveDiscordGuildReceipt(
          reopened,
          { ...mention, inputHash: 'b'.repeat(64) },
          { now, admit }
        )
      ).toEqual({ status: 'conflict' });
      expect(admit).toHaveBeenCalledTimes(1);
      expect(
        reopened.prepare('SELECT expires_at, scope_json FROM idempotency_requests').get()
      ).toMatchObject({
        expires_at: null,
        scope_json: expect.not.stringContaining('discordUserId'),
      });
    }));

  it('keeps pre-existing DM event IDs and origins separate and preserves interruption as unknown', () =>
    fixture((open) => {
      const db = open();
      const input = {
        eventId: mention.messageId,
        payloadDigest: mention.inputHash,
        discordUserId: '777',
        requestId: uuid,
        now,
      };
      expect(reserveDiscordInboundCommand(db, input)).toEqual({ requestId: uuid });
      settleDiscordInboundCommand(db, input.eventId, 'settled');
      expect(reserveDiscordGuildReceipt(db, mention, { now, admit: () => origin }).status).toBe(
        'reserved'
      );
      db.close();
      const reopened = open();
      expect(reconcileDiscordInboundCommands(reopened)).toBe(1);
      expect(reserveDiscordInboundCommand(reopened, input)).toEqual({
        existing: { payloadDigest: input.payloadDigest, state: 'settled' },
      });
      expect(reserveDiscordGuildReceipt(reopened, mention, { now, admit: () => origin })).toEqual({
        status: 'unknown',
      });
    }));

  it('writes nothing for stale unseen, unauthorized, or invalid paired authority', () =>
    fixture((open) => {
      const db = open();
      const admit = vi.fn(() => origin);
      expect(reserveDiscordGuildReceipt(db, mention, { now: now + 300_001, admit })).toEqual({
        status: 'refused',
      });
      expect(admit).not.toHaveBeenCalled();
      expect(reserveDiscordGuildReceipt(db, mention, { now, admit: () => null })).toEqual({
        status: 'refused',
      });
      expect(
        reserveDiscordGuildReceipt(db, mention, {
          now,
          admit: () => ({ ...origin, pairingRevision: uuid }),
        })
      ).toEqual({ status: 'refused' });
      expect(db.prepare('SELECT count(*) AS n FROM idempotency_requests').get()).toEqual({ n: 0 });
    }));
});
