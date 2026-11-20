import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import {
  blockDiscordReportsAmbientMessage,
  type DiscordAmbientFittedSelection,
  freezeDiscordReportsAmbient,
  readDiscordReportsAmbient,
} from './discord-reports-ambient.js';

const route = { guildId: '100', channelId: '200' };
const key = { ...route, turnId: 'turn-1', bindingRevision: 'binding-rev-1', mentionId: '700' };
const postedAt = 1_800_000_000_000;
const source = {
  messageId: '600',
  discordAuthorId: '800',
  postedAt,
  editedAt: null,
  text: 'Original source',
  renderedLabel: 'Participant A',
};
const observed: DiscordAmbientFittedSelection = {
  state: 'selected',
  approximateMemberCount: 20,
  countObservedAt: postedAt + 10,
  windowStart: postedAt - 10,
  fitted: [source],
};
const policy = {
  current: () => true,
  capturedAt: postedAt + 20,
  mapAuthor: () => 'opaque-author',
  sourceAuthor: () => 'canonical-author',
  tier: 'basic' as const,
  captureItemId: 'capture-1',
};

it('stores only fitted rows and rejects conflicting stable author without changing the first creation time', () => {
  const db = open();
  try {
    const readerMessages = [
      source,
      { ...source, messageId: '601', text: 'Excluded during fitting' },
    ];
    expect(
      freezeDiscordReportsAmbient(
        db,
        key,
        { ...observed, fitted: readerMessages.slice(0, 1) },
        policy
      )
    ).toBe(true);
    const second = { ...key, turnId: 'conflicting' };
    expect(
      freezeDiscordReportsAmbient(db, second, observed, {
        ...policy,
        capturedAt: policy.capturedAt + 1,
        captureItemId: 'capture-conflict',
        sourceAuthor: () => 'wrong',
      })
    ).toBe(true);
    expect(readDiscordReportsAmbient(db, second)).toBeNull();
    expect(
      db
        .prepare(
          'SELECT message_id, source_author_ref, created_at FROM discord_reports_ambient_revisions'
        )
        .all()
    ).toEqual([
      {
        message_id: source.messageId,
        source_author_ref: 'canonical-author',
        created_at: policy.capturedAt,
      },
    ]);
    expect(
      db
        .prepare(
          'SELECT capture_item_id, tier FROM discord_reports_ambient_captures WHERE turn_id = ?'
        )
        .get(key.turnId)
    ).toEqual({
      capture_item_id: 'capture-1',
      tier: 'basic',
    });
  } finally {
    db.close();
  }
});

function open() {
  const db = new Database(':memory:');
  db.exec(
    readFileSync(
      new URL('../../drizzle/core/0003_discord_reports_ambient.sql', import.meta.url),
      'utf8'
    )
  );
  return db;
}

it('shares exactly one canonical revision, pins refs and text separately from a later edit, and never refreshes a frozen Turn', () => {
  const db = open();
  try {
    const second = { ...key, turnId: 'turn-2', bindingRevision: 'binding-rev-2', mentionId: '701' };
    const third = { ...key, turnId: 'turn-3', mentionId: '702' };
    const edited = {
      ...observed,
      fitted: [{ ...source, editedAt: '2027-01-15T08:00:00.000001Z', text: 'Edited source' }],
    };
    expect(freezeDiscordReportsAmbient(db, key, observed, policy)).toBe(true);
    expect(
      freezeDiscordReportsAmbient(db, second, observed, { ...policy, captureItemId: 'capture-2' })
    ).toBe(true);
    expect(freezeDiscordReportsAmbient(db, key, edited, policy)).toBe(false);
    expect(
      freezeDiscordReportsAmbient(db, third, edited, { ...policy, captureItemId: 'capture-3' })
    ).toBe(true);
    const original = readDiscordReportsAmbient(db, key);
    expect(readDiscordReportsAmbient(db, second)).toEqual(original);
    expect(readDiscordReportsAmbient(db, { ...key, mentionId: 'wrong' })).toBeNull();
    expect(readDiscordReportsAmbient(db, third)?.ordered[0]?.text).toBe('Edited source');
    expect(original?.ordered[0]?.text).toBe(source.text);
    expect(original?.digest).not.toBe(readDiscordReportsAmbient(db, third)?.digest);
    expect(
      db.prepare('SELECT count(*) AS total FROM discord_reports_ambient_revisions').get()
    ).toEqual({ total: 2 });
  } finally {
    db.close();
  }
});

it('fences all references and both edits, preserving held bodies physically but never for context', () => {
  const db = open();
  try {
    const second = { ...key, turnId: 'turn-2', mentionId: '701' };
    const unrelated = { ...key, turnId: 'turn-3', mentionId: '702' };
    freezeDiscordReportsAmbient(db, key, observed, policy);
    freezeDiscordReportsAmbient(
      db,
      second,
      {
        ...observed,
        fitted: [{ ...source, editedAt: '2027-01-15T08:00:00.000002Z', text: 'Edited source' }],
      },
      { ...policy, captureItemId: 'capture-2' }
    );
    freezeDiscordReportsAmbient(
      db,
      unrelated,
      { ...observed, fitted: [{ ...source, messageId: '601' }] },
      { ...policy, captureItemId: 'capture-3' }
    );
    const heldRef = readDiscordReportsAmbient(db, key)?.ordered[0]?.revisionId;
    const fenceDerived = vi.fn(() => true);
    const selection = { ...route, messageId: source.messageId };
    const authority = {
      canDelete: () => true,
      fenceDerived,
      isHeld: (id: string) => id === heldRef,
    };
    expect(
      blockDiscordReportsAmbientMessage(db, selection, { ...authority, canDelete: () => false })
    ).toBeNull();
    expect(blockDiscordReportsAmbientMessage(db, selection, authority)).toEqual({
      affectedTurns: 2,
      bodiesDeleted: 1,
      bodiesHeld: 1,
    });
    expect(fenceDerived).toHaveBeenCalledWith(expect.arrayContaining(['turn-1', 'turn-2']));
    expect(readDiscordReportsAmbient(db, key)).toBeNull();
    expect(readDiscordReportsAmbient(db, second)).toBeNull();
    expect(readDiscordReportsAmbient(db, unrelated)?.ordered[0]?.text).toBe(source.text);
    const later = { ...key, turnId: 'later' };
    expect(
      freezeDiscordReportsAmbient(db, later, observed, {
        ...policy,
        captureItemId: 'capture-later',
      })
    ).toBe(true);
    expect(readDiscordReportsAmbient(db, later)).toBeNull();
    expect(
      blockDiscordReportsAmbientMessage(db, selection, { ...authority, isHeld: () => false })
        ?.bodiesDeleted
    ).toBe(1);
  } finally {
    db.close();
  }
});

it('freezes unavailable without writing message bodies and will not refresh it after access returns', () => {
  const db = open();
  try {
    expect(freezeDiscordReportsAmbient(db, key, { state: 'unavailable' }, policy)).toBe(true);
    expect(freezeDiscordReportsAmbient(db, key, observed, policy)).toBe(false);
    expect(readDiscordReportsAmbient(db, key)).toBeNull();
    expect(
      db.prepare('SELECT count(*) AS total FROM discord_reports_ambient_revisions').get()
    ).toEqual({ total: 0 });
  } finally {
    db.close();
  }
});
