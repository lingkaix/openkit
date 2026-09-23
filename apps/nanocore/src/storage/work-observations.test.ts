import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compactWorkspaceEvidenceBundles,
  listWorkspaceEvidenceBundles,
  readWorkObservationBody,
} from '../evidence-bundles.js';
import { FsStore } from '../lib/store.js';
import { openWorkspaceDb, type WorkspaceDb } from './db.js';
import { applyScopedMigrations } from './migrate.js';
import {
  appendWorkObservation,
  parseWorkObservationRecord,
  readThreadRuntimeActivity,
  readWorkObservations,
  type WorkObservationDraft,
} from './work-observations.js';

const roots: string[] = [];
const databases: WorkspaceDb[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) if (db.sqlite.open) db.sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Creates an actual persisted admission and Workspace evidence database. */
function fixture(value: 'off' | 'on' = 'on') {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-observations-'));
  roots.push(dataRoot);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Capture');
  const thread = store.createThread(workspace.id, 'Capture');
  const turn = store.createTurn(
    workspace.id,
    thread.id,
    'Request',
    { kind: 'user', id: 'user_local' },
    null,
    { captureCoverage: { scope: 'server', value } }
  );
  const db = openWorkspaceDb(dataRoot, workspace.id);
  databases.push(db);
  applyScopedMigrations(db);
  const owner = { threadId: thread.id, turnId: turn.id };
  const turnRoot = join(
    dataRoot,
    'workspaces',
    workspace.id,
    'threads',
    thread.id,
    'turns',
    turn.id
  );
  return { dataRoot, store, db, owner, turnRoot };
}

/** Gateway metadata used to prove the shared inline-body path independently of worker transport. */
function model(id = 'observation-one'): WorkObservationDraft {
  return {
    id,
    type: 'model.observed',
    ts: '2026-09-22T00:00:00.000Z',
    obs: 'gateway',
    ret: 'turn-evidence',
    payload: {
      attempt: 0,
      direction: 'response',
      event: 'text_end',
      runtimeOriginRef: null,
      content: { state: 'expected' },
    },
  };
}

/** Source-validated outward assistant fact with an exact expected body declaration. */
function assistant(bytes: Uint8Array): WorkObservationDraft {
  return {
    id: 'assistant-one',
    type: 'runtime.observed',
    ts: '2026-09-22T00:00:00.000Z',
    obs: 'sidecar',
    payload: {
      observationId: 'assistant-one',
      sourceRef: 'source-one',
      sourceSequence: 1,
      observedAt: '2026-09-22T00:00:00.000Z',
      fact: {
        kind: 'assistant',
        runtimeOriginRef: 'origin-child',
        phase: 'completed',
        messageRef: 'message-one',
        representation: 'snapshot',
      },
      content: {
        state: 'expected',
        bytes: bytes.byteLength,
        sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        chunkCount: Math.ceil(bytes.byteLength / (48 * 1024)),
        mediaType: 'text/plain',
        boundary: 'outward-assistant-v1',
      },
    },
  };
}

describe('durable work observations', () => {
  it('retains exact Unicode/whitespace separately, then publishes; reload and replay preserve identity', () => {
    const f = fixture();
    const bytes = Buffer.from('  hello 世界\n\tfinal\r\n');
    const input = {
      ...f.owner,
      observation: model(),
      bodies: [{ id: 'semantic', bytes, mediaType: 'text/plain', boundary: 'test-semantic-v1' }],
    };
    const first = appendWorkObservation(f.db, input);
    expect(first.observation.refs).toBeUndefined();
    const rows = readWorkObservations(f.db, f.owner);
    expect(rows.map((row) => [row.type, row.seq])).toEqual([
      ['model.observed', 1],
      ['content.published', 2],
    ]);
    const ref = rows[1]?.refs?.[0];
    expect(ref).toBeDefined();
    expect(
      readWorkObservationBody(f.db, {
        bundleId: ref!.locator,
        ...f.owner,
        createdAt: first.observation.ts,
        sha256: ref!.digest!,
      })
    ).toEqual(bytes);
    expect(readFileSync(join(f.turnRoot, 'observations.jsonl'), 'utf8')).not.toContain('hello');
    expect(listWorkspaceEvidenceBundles(f.db, f.db.workspaceId)).toEqual([]);
    f.db.sqlite.close();
    const reopened = openWorkspaceDb(f.dataRoot, f.db.workspaceId);
    databases.push(reopened);
    expect(appendWorkObservation(reopened, input).disposition).toBe('duplicate');
    expect(appendWorkObservation(reopened, { ...input, bodies: [] }).disposition).toBe('duplicate');
    expect(readWorkObservations(reopened, f.owner)).toEqual(rows);
    expect(() =>
      appendWorkObservation(reopened, {
        ...input,
        bodies: [{ ...input.bodies[0]!, bytes: Buffer.from('changed') }],
      })
    ).toThrow(/conflict/);
    expect(
      JSON.parse(readFileSync(join(f.turnRoot, 'turn.json'), 'utf8')).requiredFeatures
    ).toContain('openkit.work-observations.v1');
    f.store.updateTurn(f.owner.turnId, {
      status: 'failed',
      error: { code: 'test', message: 'test' },
    });
    expect(
      JSON.parse(readFileSync(join(f.turnRoot, 'turn.json'), 'utf8')).requiredFeatures
    ).toContain('openkit.work-observations.v1');
  });

  it('records deferred byte identity without retaining content, then publishes only exact admitted bytes', () => {
    const f = fixture();
    const bytes = Buffer.from('exact deferred content 世界');
    const input = {
      ...f.owner,
      observation: model(),
      bodies: [{ id: 'semantic', bytes, mediaType: 'text/plain', boundary: 'test-semantic-v1' }],
    };
    appendWorkObservation(f.db, { ...input, deferBodyPublication: true });
    const [expected] = readWorkObservations(f.db, f.owner);
    expect(expected?.payload.bodies).toEqual([
      expect.objectContaining({ bytes: bytes.byteLength, state: 'expected' }),
    ]);
    expect(f.db.sqlite.prepare('SELECT COUNT(*) AS count FROM evidence_bundles').get()).toEqual({
      count: 0,
    });
    expect(() =>
      appendWorkObservation(f.db, {
        ...input,
        bodies: [{ ...input.bodies[0]!, bytes: Buffer.from('changed') }],
      })
    ).toThrow(/conflict/);
    appendWorkObservation(f.db, input);
    const rows = readWorkObservations(f.db, f.owner);
    expect(rows).toHaveLength(2);
    expect(appendWorkObservation(f.db, { ...input, bodies: [] }).disposition).toBe('duplicate');
    expect(readWorkObservations(f.db, f.owner)).toEqual(rows);
  });

  it('keeps the expected fact when body metadata commit fails and completes an exact retry', () => {
    const f = fixture();
    f.db.sqlite.exec(
      "CREATE TRIGGER fail_body BEFORE INSERT ON evidence_bundles BEGIN SELECT RAISE(ABORT, 'injected body commit failure'); END"
    );
    const input = {
      ...f.owner,
      observation: model(),
      bodies: [
        {
          id: 'semantic',
          bytes: Buffer.from('complete body'),
          mediaType: 'text/plain',
          boundary: 'test-semantic-v1',
        },
      ],
    };
    expect(() => appendWorkObservation(f.db, input)).toThrow('injected body commit failure');
    expect(readWorkObservations(f.db, f.owner)).toHaveLength(1);
    expect(readWorkObservations(f.db, f.owner)[0]?.refs).toBeUndefined();
    f.db.sqlite.exec('DROP TRIGGER fail_body');
    appendWorkObservation(f.db, input);
    expect(readWorkObservations(f.db, f.owner)).toHaveLength(2);
  });

  it('discards even valid JSON without its LF and rejects corrupt interior records', () => {
    const f = fixture();
    appendWorkObservation(f.db, { ...f.owner, observation: model(), bodies: [] });
    const path = join(f.turnRoot, 'observations.jsonl');
    const row = readWorkObservations(f.db, f.owner)[0]!;
    appendFileSync(path, JSON.stringify({ ...row, id: 'lost-tail', seq: 2 }));
    expect(readWorkObservations(f.db, f.owner)).toHaveLength(1);
    appendWorkObservation(f.db, { ...f.owner, observation: model('next'), bodies: [] });
    expect(readWorkObservations(f.db, f.owner).map((entry) => entry.id)).toEqual([
      'observation-one',
      'next',
    ]);
    appendFileSync(path, '{bad}\n');
    expect(() => readWorkObservations(f.db, f.owner)).toThrow();
    expect(
      readThreadRuntimeActivity(f.db, {
        threadId: f.owner.threadId,
        turnIds: [f.owner.turnId],
        maxEntriesPerTurn: 50,
        maxTextCharacters: 1000,
      })
    ).toEqual([
      {
        turnId: f.owner.turnId,
        contentCapture: 'on',
        coverage: 'unavailable',
        entries: [],
        omittedEntryCount: 0,
      },
    ]);
  });

  it('rejects body capture when off or missing while retaining metadata under off', () => {
    const f = fixture('off');
    const metadata = { ...model(), payload: { ...model().payload, content: { state: 'off' } } };
    appendWorkObservation(f.db, { ...f.owner, observation: metadata, bodies: [] });
    expect(() =>
      appendWorkObservation(f.db, {
        ...f.owner,
        observation: model('with-body'),
        bodies: [
          {
            id: 'body',
            bytes: Buffer.from('never retained'),
            mediaType: 'text/plain',
            boundary: 'test',
          },
        ],
      })
    ).toThrow(/off/);
    expect(f.db.sqlite.prepare('SELECT COUNT(*) AS count FROM evidence_bundles').get()).toEqual({
      count: 0,
    });
    const turnPath = join(f.turnRoot, 'turn.json');
    const raw = JSON.parse(readFileSync(turnPath, 'utf8'));
    delete raw.captureCoverage;
    writeFileSync(turnPath, JSON.stringify(raw));
    expect(() =>
      appendWorkObservation(f.db, { ...f.owner, observation: model('missing'), bodies: [] })
    ).toThrow(/missing capture/);
    expect(
      readThreadRuntimeActivity(f.db, {
        threadId: f.owner.threadId,
        turnIds: [f.owner.turnId],
        maxEntriesPerTurn: 50,
        maxTextCharacters: 1000,
      })[0]?.contentCapture
    ).toBe('unknown');
  });

  it('does not resurrect lawfully expired bodies on exact replay', () => {
    const f = fixture();
    const input = {
      ...f.owner,
      observation: model(),
      bodies: [
        { id: 'body', bytes: Buffer.from('expires'), mediaType: 'text/plain', boundary: 'test' },
      ],
    };
    appendWorkObservation(f.db, input);
    const ref = readWorkObservations(f.db, f.owner)[1]!.refs![0]!;
    const root = join(
      f.dataRoot,
      'workspaces',
      f.db.workspaceId,
      'evidence',
      'backend',
      ref.locator
    );
    compactWorkspaceEvidenceBundles({
      workspaceDb: f.db,
      workspaceId: f.db.workspaceId,
      olderThan: '2026-09-23T00:00:00.000Z',
    });
    expect(existsSync(root)).toBe(false);
    expect(appendWorkObservation(f.db, input).disposition).toBe('duplicate');
    expect(existsSync(root)).toBe(false);
  });

  it('rejects unknown semantics, unowned metadata fields and forged publication edges', () => {
    const row = { ...model(), turnId: 'turn', v: 1, seq: 1 };
    expect(() => parseWorkObservationRecord({ ...row, type: 'unowned.fact' })).toThrow(
      /Unsupported/
    );
    expect(() =>
      parseWorkObservationRecord({ ...row, payload: { ...row.payload, secretBody: 'forbidden' } })
    ).toThrow();
    expect(() =>
      parseWorkObservationRecord({
        ...row,
        refs: [{ kind: 'evidence-bundle', scope: {}, locator: 'forged', edge: 'publication' }],
      })
    ).toThrow();
  });

  it('projects child phases, safe outward text and capture setting without native refs or tool bodies', () => {
    const f = fixture();
    const origin = {
      ...assistant(Buffer.from('x')),
      id: 'origin',
      payload: {
        observationId: 'origin',
        sourceRef: 'source-one',
        sourceSequence: 0,
        observedAt: '2026-09-22T00:00:00.000Z',
        fact: {
          kind: 'origin',
          runtimeOriginRef: 'origin-child',
          parentRuntimeOriginRef: 'origin-parent',
          phase: 'started',
        },
        content: { state: 'not-applicable' },
      },
    };
    appendWorkObservation(f.db, { ...f.owner, observation: origin, bodies: [] });
    const bytes = Buffer.from('Useful result '.repeat(100));
    appendWorkObservation(f.db, {
      ...f.owner,
      observation: assistant(bytes),
      bodies: [{ id: 'content', bytes, mediaType: 'text/plain', boundary: 'outward-assistant-v1' }],
    });
    const activity = readThreadRuntimeActivity(f.db, {
      threadId: f.owner.threadId,
      turnIds: [f.owner.turnId],
      maxEntriesPerTurn: 50,
      maxTextCharacters: 1000,
    })[0]!;
    expect(activity).toMatchObject({
      coverage: 'collecting',
      contentCapture: 'on',
      entries: [
        { kind: 'child-started', label: 'Child 1 started' },
        { kind: 'result', label: 'Child 1: response completed', textTruncated: true },
      ],
    });
    expect(activity.entries[1]?.text).toHaveLength(1000);
    expect(JSON.stringify(activity)).not.toContain('origin-child');
    compactWorkspaceEvidenceBundles({
      workspaceDb: f.db,
      workspaceId: f.db.workspaceId,
      olderThan: '2026-09-23T00:00:00.000Z',
    });
    expect(
      readThreadRuntimeActivity(f.db, {
        threadId: f.owner.threadId,
        turnIds: [f.owner.turnId],
        maxEntriesPerTurn: 50,
        maxTextCharacters: 1000,
      })[0]?.entries[1]?.text
    ).toBeUndefined();
  });
});
