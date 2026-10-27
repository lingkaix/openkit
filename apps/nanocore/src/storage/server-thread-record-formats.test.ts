import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { allocateEntityId, ServerTurnEventEnvelopeSchema } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { describe, expect, it, onTestFinished } from 'vitest';
import { FsStore } from '../lib/store.js';
import { createTestStore } from '../test-support/store.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { publishImmutableProductJson, readImmutableProductJson } from './immutable-content.js';
import {
  loadServerThreadRecords,
  readServerTurnEvents,
  readServerTurnRecord,
} from './server-thread-records.js';
import {
  type NativeProductScope,
  nativeProductScope,
  readNativeProductEntries,
} from './workspace-file-records.js';

const families = ['Server Turn', 'Server Item', 'Server transcript event'] as const;
type RetainedFamily = (typeof families)[number];

/** Inspects the real native retained row and its digest-verified immutable payload. */
function readServerRetainedRecord(
  scope: NativeProductScope,
  turnId: string,
  family: RetainedFamily,
  sequence = 1
) {
  const db = new Database(scope.path, { readonly: true, fileMustExist: true });
  try {
    if (family === 'Server Turn') {
      const row = db.prepare('SELECT record_json FROM control_turns WHERE id=?').get(turnId) as {
        record_json: string;
      };
      return {
        record: JSON.parse(row.record_json) as Record<string, unknown>,
        bytes: row.record_json,
        path: undefined,
      };
    }
    const row = db
      .prepare(
        'SELECT content_json FROM control_product_entries WHERE kind=? AND turn_id=? AND sequence=?'
      )
      .get(family === 'Server Item' ? 'item' : 'event', turnId, sequence) as {
      content_json: string;
    };
    const content = JSON.parse(row.content_json);
    readImmutableProductJson(scope.contentMount, scope.owner, content);
    if (content.reference.representation === 'inline') {
      const bytes = content.reference.body as string;
      return { record: JSON.parse(bytes) as Record<string, unknown>, bytes, path: undefined };
    }
    const path = join(scope.contentMount.root, content.reference.locator.path);
    const bytes = readFileSync(path, 'utf8');
    return { record: JSON.parse(bytes) as Record<string, unknown>, bytes, path };
  } finally {
    db.close();
  }
}

/** Stopped-writer fixture injection never overwrites a previously published immutable body. */
async function replaceServerRetainedRecord(
  scope: NativeProductScope,
  turnId: string,
  family: RetainedFamily,
  record: Record<string, unknown>
) {
  await shutdownControlStoreWorkerClient();
  const content =
    family === 'Server Turn'
      ? undefined
      : await publishImmutableProductJson(
          scope.contentMount,
          scope.owner,
          join(dirname(dirname(scope.path)), 'runtime', 'staging'),
          record
        );
  const db = new Database(scope.path, { fileMustExist: true });
  try {
    const result =
      family === 'Server Turn'
        ? db
            .prepare('UPDATE control_turns SET record_json=? WHERE id=?')
            .run(JSON.stringify(record), turnId)
        : db
            .prepare(
              'UPDATE control_product_entries SET content_json=? WHERE kind=? AND turn_id=? AND sequence=1'
            )
            .run(JSON.stringify(content), family === 'Server Item' ? 'item' : 'event', turnId);
    if (result.changes !== 1)
      throw new Error('Retained fixture requires exactly one existing native row.');
  } finally {
    db.close();
  }
}

/** Publishes native Server work and seeds its original Item/event rows as prior file specimens. */
async function createServerRetainedFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-server-retained-formats-'));
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    return rmSync(dataRoot, { recursive: true, force: true });
  });
  const store = createTestStore({ dataRoot });
  const thread = await store.createServerThread('Retained Server formats');
  const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;
  const turn = await store.createServerTurn(thread.id, 'Retain Server work', actor);
  const item = await store.createServerItem({
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
  await store.persistServerTurnEvent(turn.id, {
    event: 'item.completed',
    threadId: thread.id,
    turnId: turn.id,
    data: { type: 'item-completed', itemId: item.id, item },
  });
  await shutdownControlStoreWorkerClient();
  const scope = nativeProductScope(dataRoot, { kind: 'server' });
  // Keep the original-file preservation predicate while later native rows select their own representation.
  for (const family of ['Server Item', 'Server transcript event'] as const) {
    const original = readNativeProductEntries(
      scope,
      turn.id,
      family === 'Server Item' ? 'item' : 'event'
    )[0]!;
    await replaceServerRetainedRecord(
      scope,
      turn.id,
      family,
      original.value as Record<string, unknown>
    );
  }
  return {
    dataRoot,
    scope,
    thread,
    turn: store.getServerTurnById(turn.id),
    item,
  };
}

describe('native retained Server work formats', () => {
  it.each(families)('writes %s v1 and retains descriptive additions', async (family) => {
    const fixture = await createServerRetainedFixture();
    const { dataRoot, scope, thread, turn, item } = fixture;
    const originalSource = readServerRetainedRecord(scope, turn.id, family);
    const record = originalSource.record;
    expect(record.schemaVersion).toBe(1);
    expect(record.owner).toEqual({ kind: 'server' });
    expect(record).not.toHaveProperty('workspaceId');
    const original = loadServerThreadRecords(dataRoot);
    expect(original.turns).toEqual([turn]);
    expect(original.itemRevisions).toEqual([item]);
    record.futureNote = 'Retained Server annotation.';
    const actor = (
      family === 'Server Turn'
        ? record.triggerActor
        : family === 'Server Item'
          ? record.actor
          : ((record.data as Record<string, unknown>).item as Record<string, unknown>).actor
    ) as Record<string, unknown>;
    actor.futureNote = 'Retained actor annotation.';
    await replaceServerRetainedRecord(scope, turn.id, family, record);
    const annotatedBytes = readServerRetainedRecord(scope, turn.id, family).bytes;

    expect(loadServerThreadRecords(dataRoot)).toMatchObject(original);
    expect(readServerRetainedRecord(scope, turn.id, family).bytes).toBe(annotatedBytes);
    if (originalSource.path)
      expect(readFileSync(originalSource.path, 'utf8')).toBe(originalSource.bytes);
    const reopened = new FsStore({ dataRoot });
    expect(reopened.getServerTurnById(turn.id)).toEqual(turn);
    expect(reopened.getServerItemById(item.id)).toEqual(item);
    expect(reopened.getServerTurnTranscript(turn.id)).toHaveLength(1);
    for (const event of reopened.getServerTurnTranscript(turn.id)) {
      expect(event).toEqual(ServerTurnEventEnvelopeSchema.parse(event));
    }
    expect(readServerTurnRecord(dataRoot, thread.id, turn.id)).toMatchObject({ id: turn.id });
    expect(readServerTurnEvents(dataRoot, turn)).toHaveLength(1);
    if (family === 'Server Turn') {
      await reopened.updateServerTurn(turn.id, {
        status: 'completed',
        completedAt: turn.startedAt,
      });
      expect(readServerRetainedRecord(scope, turn.id, family).record).toMatchObject({
        schemaVersion: 1,
        futureNote: record.futureNote,
        owner: { kind: 'server' },
        triggerActor: { futureNote: actor.futureNote },
      });
    } else if (family === 'Server Item') {
      await reopened.updateServerItem(item.id, { text: 'Updated retained Server work' });
      expect(readServerRetainedRecord(scope, turn.id, family).bytes).toBe(annotatedBytes);
      expect(readServerRetainedRecord(scope, turn.id, family, 2).record.schemaVersion).toBe(1);
    } else {
      await reopened.persistServerTurnEvent(turn.id, {
        event: 'error',
        threadId: thread.id,
        turnId: turn.id,
        data: { type: 'error', code: 'retained-test', message: 'Retained test event.' },
      });
      expect(readServerRetainedRecord(scope, turn.id, family).bytes).toBe(annotatedBytes);
      expect(readServerRetainedRecord(scope, turn.id, family, 2).record.schemaVersion).toBe(1);
    }
  });

  it.each(families)('refuses %s with a missing or unknown retained version', async (family) => {
    const { dataRoot, scope, thread, turn } = await createServerRetainedFixture();
    const originalRecord = readServerRetainedRecord(scope, turn.id, family).record;
    const store = new FsStore({ dataRoot });
    for (const version of [undefined, 2]) {
      const record = structuredClone(originalRecord);
      if (version === undefined) delete record.schemaVersion;
      else record.schemaVersion = version;
      await replaceServerRetainedRecord(scope, turn.id, family, record);
      const invalidBytes = readServerRetainedRecord(scope, turn.id, family).bytes;

      expect(() => new FsStore({ dataRoot })).toThrow();
      if (family === 'Server Turn') {
        expect(() => readServerTurnRecord(dataRoot, thread.id, turn.id)).toThrow();
        await expect(store.updateServerTurn(turn.id, { status: 'pending' })).rejects.toThrow();
      } else if (family === 'Server transcript event') {
        expect(() => readServerTurnEvents(dataRoot, turn)).toThrow();
      }
      expect(readServerRetainedRecord(scope, turn.id, family).bytes).toBe(invalidBytes);
      await replaceServerRetainedRecord(scope, turn.id, family, originalRecord);
      expect(loadServerThreadRecords(dataRoot).turns).toEqual([turn]);
    }
  });

  it.each(families)('refuses %s invalid native version discriminators', async (family) => {
    const { dataRoot, scope, thread, turn } = await createServerRetainedFixture();
    const original = readServerRetainedRecord(scope, turn.id, family).record;
    const read = () =>
      family === 'Server Turn'
        ? readServerTurnRecord(dataRoot, thread.id, turn.id)
        : readNativeProductEntries(scope, turn.id, family === 'Server Item' ? 'item' : 'event');
    for (const schemaVersion of [null, '1', 0, -1]) {
      await replaceServerRetainedRecord(scope, turn.id, family, { ...original, schemaVersion });
      const invalidBytes = readServerRetainedRecord(scope, turn.id, family).bytes;
      expect(read).toThrow('Unsupported retained record format.');
      expect(readServerRetainedRecord(scope, turn.id, family).bytes).toBe(invalidBytes);
      await replaceServerRetainedRecord(scope, turn.id, family, original);
      expect(read).not.toThrow();
    }
  });

  it.each(
    families
  )('refuses %s unsupported required semantics and unknown core values', async (family) => {
    const { dataRoot, scope, turn } = await createServerRetainedFixture();
    const original = readServerRetainedRecord(scope, turn.id, family).record;
    const required = {
      ...original,
      requiredFeatures: [
        ...((original.requiredFeatures as string[] | undefined) ?? []),
        'openkit.test-unsupported-retained.v1',
      ],
    };
    const core = structuredClone(original);
    if (family === 'Server Turn') core.status = 'future-status';
    else if (family === 'Server Item') core.type = 'future-item';
    else {
      core.event = 'future.event';
      core.data = { type: 'future-event' };
    }
    const read = () => loadServerThreadRecords(dataRoot);
    for (const record of [required, core]) {
      await replaceServerRetainedRecord(scope, turn.id, family, record);
      const invalidBytes = readServerRetainedRecord(scope, turn.id, family).bytes;
      expect(read).toThrow();
      expect(readServerRetainedRecord(scope, turn.id, family).bytes).toBe(invalidBytes);
      await replaceServerRetainedRecord(scope, turn.id, family, original);
      expect(read).not.toThrow();
    }
  });

  it.each(families)('refuses %s unknown or contradictory owner authority', async (family) => {
    const { dataRoot, scope, turn } = await createServerRetainedFixture();
    const original = readServerRetainedRecord(scope, turn.id, family).record;
    for (const owner of [
      { kind: 'server', futureAuthority: 'not-descriptive' },
      { kind: 'server', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
      { kind: 'workspace', workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
    ]) {
      await replaceServerRetainedRecord(scope, turn.id, family, { ...original, owner });
      const invalidBytes = readServerRetainedRecord(scope, turn.id, family).bytes;
      expect(() => loadServerThreadRecords(dataRoot)).toThrow();
      expect(() => new FsStore({ dataRoot })).toThrow();
      expect(readServerRetainedRecord(scope, turn.id, family).bytes).toBe(invalidBytes);
      await replaceServerRetainedRecord(scope, turn.id, family, original);
      expect(loadServerThreadRecords(dataRoot).turns).toEqual([turn]);
    }
  });

  it.each(
    families
  )('checks %s native SQL version before decoding retained JSON', async (family) => {
    const { dataRoot, scope, thread, turn } = await createServerRetainedFixture();
    const reader = new Database(scope.path, { readonly: true, fileMustExist: true });
    let row: { schema_version: number; json: string };
    try {
      row =
        family === 'Server Turn'
          ? (reader
              .prepare('SELECT schema_version,record_json AS json FROM control_turns WHERE id=?')
              .get(turn.id) as typeof row)
          : (reader
              .prepare(
                'SELECT schema_version,content_json AS json FROM control_product_entries WHERE kind=? AND turn_id=? AND sequence=1'
              )
              .get(family === 'Server Item' ? 'item' : 'event', turn.id) as typeof row);
    } finally {
      reader.close();
    }
    expect(row.schema_version).toBe(1);
    // Only this stopped fixture mutator admits corruption; the real reader keeps every guard.
    const replace = (version: number, json: string) => {
      const mutator = new Database(scope.path, { fileMustExist: true });
      try {
        mutator.pragma('ignore_check_constraints = ON');
        if (family === 'Server Turn')
          mutator
            .prepare('UPDATE control_turns SET schema_version=?,record_json=? WHERE id=?')
            .run(version, json, turn.id);
        else
          mutator
            .prepare(
              'UPDATE control_product_entries SET schema_version=?,content_json=? WHERE kind=? AND turn_id=? AND sequence=1'
            )
            .run(version, json, family === 'Server Item' ? 'item' : 'event', turn.id);
      } finally {
        try {
          mutator.pragma('ignore_check_constraints = OFF');
        } finally {
          mutator.close();
        }
      }
    };
    const read = () =>
      family === 'Server Turn'
        ? readServerTurnRecord(dataRoot, thread.id, turn.id)
        : readNativeProductEntries(scope, turn.id, family === 'Server Item' ? 'item' : 'event');
    for (const json of [row.json, '{invalid-json']) {
      replace(2, json);
      expect(read).toThrow();
      expect(read).not.toThrow(SyntaxError);
    }
    replace(row.schema_version, row.json);
    expect(read).not.toThrow();
  });
});
