import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { FsStore } from '../lib/store.js';
import {
  loadServerThreadRecords,
  readServerTurnEvents,
  readServerTurnRecord,
} from './server-thread-records.js';

const families = ['Server Turn', 'Server Item', 'Server transcript event'] as const;

/** Publishes one native Server Turn, Item row and transcript row through FsStore. */
function createServerRetainedFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-server-retained-formats-'));
  onTestFinished(() => rmSync(dataRoot, { recursive: true, force: true }));
  const store = new FsStore({ dataRoot });
  const thread = store.createServerThread('Retained Server formats');
  const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;
  const turn = store.createServerTurn(thread.id, 'Retain Server work', actor);
  const item = store.createServerItem({
    id: allocateEntityId('it'),
    owner: { kind: 'server' },
    threadId: thread.id,
    turnId: turn.id,
    type: 'user-message',
    actor,
    text: 'Retain Server work',
    status: 'completed',
    createdAt: turn.startedAt!,
    completedAt: turn.startedAt!,
  });
  store.emitServerTurnEvent(turn.id, {
    event: 'item.completed',
    threadId: thread.id,
    turnId: turn.id,
    data: { type: 'item-completed', itemId: item.id, item },
  });
  const turnRoot = join(dataRoot, 'server', 'threads', thread.id, 'turns', turn.id);
  return {
    dataRoot,
    thread,
    turn: store.getServerTurnById(turn.id),
    item,
    paths: {
      'Server Turn': join(turnRoot, 'turn.json'),
      'Server Item': join(turnRoot, 'items.jsonl'),
      'Server transcript event': join(turnRoot, 'runtime', 'events.jsonl'),
    },
  };
}

describe('native retained Server work formats', () => {
  it.each(families)('writes %s v1 and retains descriptive additions', (family) => {
    const fixture = createServerRetainedFixture();
    const { dataRoot, paths, thread, turn, item } = fixture;
    const path = paths[family];
    const record = JSON.parse(readFileSync(path, 'utf8'));
    expect(record.schemaVersion).toBe(1);
    expect(record.owner).toEqual({ kind: 'server' });
    expect(record).not.toHaveProperty('workspaceId');
    const original = loadServerThreadRecords(dataRoot);
    expect(original.turns).toEqual([turn]);
    expect(original.itemRevisions).toEqual([item]);
    record.futureNote = 'Retained Server annotation.';
    record.owner.futureNote = 'Retained owner annotation.';
    const actor =
      family === 'Server Turn'
        ? record.triggerActor
        : family === 'Server Item'
          ? record.actor
          : record.data.item.actor;
    actor.futureNote = 'Retained actor annotation.';
    const annotatedBytes = `${JSON.stringify(record)}\n`;
    writeFileSync(path, annotatedBytes);

    expect(loadServerThreadRecords(dataRoot)).toEqual(original);
    expect(readFileSync(path, 'utf8')).toBe(annotatedBytes);
    const reopened = new FsStore({ dataRoot });
    expect(reopened.getServerTurnById(turn.id)).toEqual(turn);
    expect(reopened.getServerItemById(item.id)).toEqual(item);
    expect(reopened.getServerTurnTranscript(turn.id)).toHaveLength(1);
    expect(readServerTurnRecord(dataRoot, thread.id, turn.id)).toMatchObject({ id: turn.id });
    expect(readServerTurnEvents(dataRoot, turn)).toHaveLength(1);
    if (family === 'Server Turn') {
      reopened.updateServerTurn(turn.id, { status: 'completed', completedAt: turn.startedAt });
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
        schemaVersion: 1,
        futureNote: record.futureNote,
        owner: { futureNote: record.owner.futureNote },
        triggerActor: { futureNote: actor.futureNote },
      });
    } else if (family === 'Server Item') {
      reopened.updateServerItem(item.id, { text: 'Updated retained Server work' });
      const rows = readFileSync(path, 'utf8').trimEnd().split('\n');
      expect(rows[0]).toBe(annotatedBytes.trimEnd());
      expect(JSON.parse(rows[1]!).schemaVersion).toBe(1);
    } else {
      reopened.emitServerTurnEvent(turn.id, {
        event: 'error',
        threadId: thread.id,
        turnId: turn.id,
        data: { type: 'error', code: 'retained-test', message: 'Retained test event.' },
      });
      const rows = readFileSync(path, 'utf8').trimEnd().split('\n');
      expect(rows[0]).toBe(annotatedBytes.trimEnd());
      expect(JSON.parse(rows[1]!).schemaVersion).toBe(1);
    }
  });

  it.each(families)('refuses %s with a missing or unknown retained version', (family) => {
    const { dataRoot, paths, thread, turn } = createServerRetainedFixture();
    const path = paths[family];
    const originalBytes = readFileSync(path, 'utf8');
    const store = new FsStore({ dataRoot });
    for (const version of [undefined, 2]) {
      const record = JSON.parse(originalBytes);
      if (version === undefined) delete record.schemaVersion;
      else record.schemaVersion = version;
      const invalidBytes = `${JSON.stringify(record)}\n`;
      writeFileSync(path, invalidBytes);

      expect(() => new FsStore({ dataRoot })).toThrow();
      if (family === 'Server Turn') {
        expect(() => readServerTurnRecord(dataRoot, thread.id, turn.id)).toThrow();
        expect(() => store.updateServerTurn(turn.id, { status: 'pending' })).toThrow();
      } else if (family === 'Server transcript event') {
        expect(() => readServerTurnEvents(dataRoot, turn)).toThrow();
      }
      expect(readFileSync(path, 'utf8')).toBe(invalidBytes);
      writeFileSync(path, originalBytes);
      expect(loadServerThreadRecords(dataRoot).turns).toEqual([turn]);
    }
  });
});
