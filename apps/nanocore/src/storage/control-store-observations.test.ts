import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId } from '@openkit/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { ControlProductOwner } from './control-store-products.js';
import {
  getControlStoreWorkerClient,
  shutdownControlStoreWorkerClient,
} from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';
import {
  applyControlTurnReap,
  applyControlWorkObservation,
  type ControlWorkObservationInput,
  type ControlWorkObservationPreparation,
  prepareControlTurnReap,
  prepareControlWorkObservation,
  publishControlWorkObservationBodies,
  readControlWorkObservation,
  readControlWorkObservations,
  readControlWorkObservationTurnBinding,
} from './work-observations.js';

const timestamp = '2026-10-20T00:00:00.000Z';
const roots: string[] = [];
const handles: Database.Database[] = [];
afterEach(async () => {
  await shutdownControlStoreWorkerClient();
  for (const sqlite of handles.splice(0)) sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Uses the complete actual scoped journal, including the observation migration. */
function fixture(kind: 'server' | 'workspace' = 'server') {
  const root = mkdtempSync(join(tmpdir(), 'native-observations-'));
  roots.push(root);
  const owner: ControlProductOwner =
    kind === 'server' ? { kind } : { kind, workspaceId: allocateEntityId('ws') };
  const db = owner.kind === 'server' ? openCoreDb(root) : openWorkspaceDb(root, owner.workspaceId);
  const sqlite = db.sqlite;
  handles.push(sqlite);
  if (db.scope === 'core') applyMigrations(db);
  else applyScopedMigrations(db);
  sqlite.pragma('synchronous = FULL');
  const threadId = allocateEntityId('th');
  const turnId = allocateEntityId('tu');
  const thread = {
    schemaVersion: 1,
    id: threadId,
    owner,
    name: 'Native observations',
    preview: 'Native SQL only',
    status: 'active',
    entryPath: 'conversation',
    visibility: owner.kind === 'server' ? 'server' : 'workspace',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const turn = {
    schemaVersion: 1,
    id: turnId,
    threadId,
    owner,
    agentSessionId: null,
    triggerActor: { kind: 'system', id: 'observation-test', responsibleUserId: null },
    error: null,
    configVersion: null,
    startedAt: timestamp,
    completedAt: null as string | null,
    durationMs: null,
    status: 'running',
    captureCoverage: { scope: owner.kind === 'server' ? 'server' : 'workspace', value: 'on' },
    annotation: { keep: true },
  };
  if (owner.kind === 'workspace')
    sqlite.prepare('INSERT INTO control_workspaces VALUES (?,1,1,?)').run(
      owner.workspaceId,
      JSON.stringify({
        schemaVersion: 1,
        id: owner.workspaceId,
        kind: 'general',
        status: 'active',
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    );
  sqlite
    .prepare('INSERT INTO control_threads VALUES (?,?,?,1,1,?)')
    .run(
      threadId,
      owner.kind === 'server' ? null : owner.workspaceId,
      'active',
      JSON.stringify(thread)
    );
  sqlite
    .prepare('INSERT INTO control_turns VALUES (?,?,NULL,?,1,1,?)')
    .run(turnId, threadId, 'running', JSON.stringify(turn));
  return { root, db, sqlite, owner, threadId, turnId, turn };
}

/** Valid metadata needs no filesystem publication or unrelated effect domain. */
function input(f: ReturnType<typeof fixture>, id = 'gap:1'): ControlWorkObservationInput {
  return {
    threadId: f.threadId,
    turnId: f.turnId,
    bodies: [],
    observation: {
      id,
      type: 'capture.unavailable',
      ts: timestamp,
      obs: 'nanocore',
      payload: { family: 'model-response', reason: 'capture-failed' },
    },
  };
}

/** Tests the same production body in its caller's transaction, not a replacement handler or runner. */
function append(f: ReturnType<typeof fixture>, value = input(f)) {
  return f.sqlite.transaction(() => applyControlWorkObservation(f.sqlite, f.owner, value))();
}

/** Captures raw bytes so extension preservation and rollback do not rely on a lossy reader. */
function turnRaw(f: ReturnType<typeof fixture>) {
  return JSON.parse(
    (
      f.sqlite.prepare('SELECT record_json FROM control_turns WHERE id=?').get(f.turnId) as {
        record_json: string;
      }
    ).record_json
  );
}

/** Emulates the terminal product mutation owned by primary before this body runs in the same savepoint. */
function terminalize(f: ReturnType<typeof fixture>) {
  const turn = { ...turnRaw(f), status: 'completed', completedAt: timestamp, durationMs: 0 };
  f.sqlite
    .prepare('UPDATE control_turns SET status=?,revision=revision+1,record_json=? WHERE id=?')
    .run(turn.status, JSON.stringify(turn), f.turnId);
}

/** Complete model content uses the existing admitted semantic-unit body owner. */
function bodyInput(f: ReturnType<typeof fixture>): ControlWorkObservationPreparation {
  return {
    threadId: f.threadId,
    turnId: f.turnId,
    observation: {
      id: 'model:request',
      type: 'model.observed',
      ts: timestamp,
      obs: 'llm-gateway',
      corr: 'call:1',
      payload: {
        direction: 'request',
        event: 'request',
        attempt: 0,
        runtimeOriginRef: null,
        providerRef: 'test',
        model: 'test',
        systemPromptDigest: `sha256:${'a'.repeat(64)}`,
        sampling: {},
        content: { state: 'expected' },
      },
    },
    bodies: [
      {
        id: 'request',
        bytes: Buffer.from('exact admitted model body'),
        mediaType: 'application/json',
        boundary: 'model-request',
      },
    ],
  };
}

describe('native WorkObservation transport', () => {
  it('acknowledges the native order and manifest only after their shared outer commit', async () => {
    const f = fixture('server');
    const client = getControlStoreWorkerClient();
    try {
      await client.open({
        database: 'native-observation',
        path: f.sqlite.name,
        dataRoot: f.root,
        create: false,
        initialize: 'core',
        productOwner: f.owner,
      });
      const result = await client.observation('native-observation', input(f));
      expect(result.disposition).toBe('committed');
      expect(result.observation.seq).toBe(1);
      expect(result.publication).toBeNull();
      expect(readControlWorkObservations(f.sqlite, f.owner, f)).toEqual([result.observation]);
      expect(turnRaw(f).requiredFeatures).toContain('openkit.work-observations.v1');
      expect(await client.observation('native-observation', input(f))).toEqual({
        ...result,
        disposition: 'duplicate',
      });
    } finally {
      await client.shutdown();
    }
  });

  it('rolls back the native capture manifest when the actual observation insert aborts', async () => {
    const f = fixture('server');
    const before = turnRaw(f);
    f.sqlite.exec(
      `CREATE TRIGGER native_observation_abort BEFORE INSERT ON control_work_observations BEGIN SELECT RAISE(ABORT, 'native_observation_abort'); END`
    );
    const client = getControlStoreWorkerClient();
    try {
      await client.open({
        database: 'native-observation',
        path: f.sqlite.name,
        dataRoot: f.root,
        create: false,
        initialize: 'core',
        productOwner: f.owner,
      });
      await expect(client.observation('native-observation', input(f))).rejects.toMatchObject({
        code: 'constraint',
        commit: 'not-committed',
      });
      expect(turnRaw(f)).toEqual(before);
      expect(readControlWorkObservations(f.sqlite, f.owner, f)).toEqual([]);
    } finally {
      await client.shutdown();
    }
  });
});

describe.each(['server', 'workspace'] as const)('native %s WorkObservation SQL body', (kind) => {
  it('assigns and deduplicates exact sequence and rolls back metadata and feature markers', () => {
    const f = fixture(kind);
    f.sqlite.exec('BEGIN; SAVEPOINT observation');
    const first = applyControlWorkObservation(f.sqlite, f.owner, input(f));
    expect(first.disposition).toBe('committed');
    expect(first.observation.seq).toBe(1);
    expect(applyControlWorkObservation(f.sqlite, f.owner, input(f)).disposition).toBe('duplicate');
    expect(applyControlWorkObservation(f.sqlite, f.owner, input(f, 'gap:2')).observation.seq).toBe(
      2
    );
    f.sqlite.exec('ROLLBACK TO observation; RELEASE observation; COMMIT');
    expect(readControlWorkObservations(f.sqlite, f.owner, f)).toEqual([]);
    expect(turnRaw(f)).toEqual(f.turn);
    expect(append(f).observation.seq).toBe(1);
    expect(turnRaw(f).annotation).toEqual({ keep: true });
    expect(turnRaw(f).requiredFeatures).toEqual(['openkit.work-observations.v1']);
    expect(existsSync(join(f.root, kind === 'server' ? 'server' : 'workspaces', 'threads'))).toBe(
      false
    );
  });

  it('refuses divergent replay without consuming sequence and leaves sibling savepoints usable', () => {
    const f = fixture(kind);
    append(f);
    f.sqlite.exec('BEGIN; SAVEPOINT bad');
    expect(() =>
      applyControlWorkObservation(f.sqlite, f.owner, {
        ...input(f),
        observation: {
          ...input(f).observation,
          payload: { family: 'model-request', reason: 'unsupported' },
        },
      })
    ).toThrow(/identity conflict/);
    f.sqlite.exec('ROLLBACK TO bad; RELEASE bad; SAVEPOINT good');
    expect(applyControlWorkObservation(f.sqlite, f.owner, input(f, 'gap:2')).observation.seq).toBe(
      2
    );
    f.sqlite.exec('RELEASE good; COMMIT');
    expect(readControlWorkObservations(f.sqlite, f.owner, f).map((row) => row.id)).toEqual([
      'gap:1',
      'gap:2',
    ]);
  });

  it('reads last committed pages through a true readonly handle without writes or file authority', () => {
    const f = fixture(kind);
    append(f);
    const readonly = new Database(f.sqlite.name, { readonly: true, fileMustExist: true });
    handles.push(readonly);
    readonly.pragma('query_only = ON');
    f.sqlite.exec('BEGIN');
    applyControlWorkObservation(f.sqlite, f.owner, input(f, 'gap:2'));
    expect(readControlWorkObservations(readonly, f.owner, f)).toHaveLength(1);
    f.sqlite.exec('COMMIT');
    expect(readControlWorkObservations(readonly, f.owner, { ...f, limit: 1 })[0]?.seq).toBe(1);
    expect(
      readControlWorkObservations(readonly, f.owner, { ...f, afterSequence: 1, limit: 1 })[0]?.seq
    ).toBe(2);
    expect(readControlWorkObservation(readonly, f.owner, { ...f, id: 'gap:2' })?.seq).toBe(2);
    expect(readControlWorkObservations(readonly, f.owner, { ...f, afterSequence: 2 })).toEqual([]);
    expect(() => readControlWorkObservations(readonly, f.owner, { ...f, limit: 129 })).toThrow();
    expect(() => applyControlWorkObservation(readonly, f.owner, input(f))).toThrow(
      /owning SQL transaction/
    );
  });

  it('preserves descriptive fields in exact retained bytes and compares only admitted known identity', () => {
    const f = fixture(kind);
    const value = input(f);
    const observation = {
      ...value.observation,
      annotation: { ignored: true },
      payload: { ...value.observation.payload, annotation: ['keep', 7] },
      refs: [
        {
          kind: 'evidence',
          scope: { note: 'association' },
          locator: 'source',
          edge: 'association' as const,
          annotation: 'keep ref',
        },
      ],
    };
    append(f, { ...value, observation });
    const admitted = JSON.parse(
      (
        f.sqlite.prepare('SELECT record_json FROM control_work_observations').get() as {
          record_json: string;
        }
      ).record_json
    );
    expect(admitted).not.toHaveProperty('annotation');
    expect(admitted.payload).not.toHaveProperty('annotation');
    expect(admitted.refs[0]).not.toHaveProperty('annotation');
    // Seed retained descriptive additions separately from untrusted live admission.
    const before = JSON.stringify({
      ...admitted,
      annotation: observation.annotation,
      payload: { ...admitted.payload, annotation: observation.payload.annotation },
      refs: [{ ...admitted.refs[0], annotation: observation.refs[0].annotation }],
    });
    expect(
      f.sqlite.prepare('UPDATE control_work_observations SET record_json=?').run(before).changes
    ).toBe(1);
    expect(JSON.parse(before)).toMatchObject({
      annotation: { ignored: true },
      payload: { annotation: ['keep', 7] },
      refs: [{ annotation: 'keep ref' }],
    });
    append(f, { ...value, observation: { ...observation, annotation: 'not acted on' } });
    expect(
      (
        f.sqlite.prepare('SELECT record_json FROM control_work_observations').get() as {
          record_json: string;
        }
      ).record_json
    ).toBe(before);
    const projected = readControlWorkObservations(f.sqlite, f.owner, f)[0];
    expect(projected).not.toHaveProperty('annotation');
    expect(projected?.payload).not.toHaveProperty('annotation');
    expect(projected?.refs?.[0]).not.toHaveProperty('annotation');
  });

  it('refuses unknown core values, required semantics, missing owners, and contradictory indexed lineage', () => {
    const f = fixture(kind);
    expect(() =>
      append(f, { ...input(f), observation: { ...input(f).observation, type: 'future.semantic' } })
    ).toThrow(/Unsupported/);
    expect(() =>
      append(f, {
        ...input(f),
        observation: {
          ...input(f).observation,
          requiredFeatures: ['future.authority'],
        } as unknown as ControlWorkObservationInput['observation'],
      })
    ).toThrow(/required/);
    expect(() => append(f, { ...input(f), threadId: allocateEntityId('th') })).toThrow(/owner/);
    const other: ControlProductOwner =
      f.owner.kind === 'server'
        ? { kind: 'workspace', workspaceId: allocateEntityId('ws') }
        : { kind: 'server' };
    expect(() => readControlWorkObservationTurnBinding(f.sqlite, other, f)).toThrow(/lineage/);
    const raw = turnRaw(f);
    f.sqlite
      .prepare('UPDATE control_turns SET record_json=? WHERE id=?')
      .run(JSON.stringify({ ...raw, requiredFeatures: ['future.required'] }), f.turnId);
    expect(() => append(f)).toThrow(/Unsupported required Turn feature/);
    f.sqlite
      .prepare('UPDATE control_turns SET record_json=? WHERE id=?')
      .run(JSON.stringify({ ...raw, captureCoverage: undefined }), f.turnId);
    expect(() => append(f)).toThrow(/coverage/);
    f.sqlite
      .prepare('UPDATE control_turns SET record_json=? WHERE id=?')
      .run(JSON.stringify({ ...raw, threadId: allocateEntityId('th') }), f.turnId);
    expect(() => append(f)).toThrow(/lineage/);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM control_work_observations').get()).toEqual({
      n: 0,
    });
  });

  it('requires a prior same-Turn causal parent and matching model attempt', () => {
    const f = fixture(kind);
    expect(() =>
      append(f, { ...input(f), observation: { ...input(f).observation, parent: 'absent' } })
    ).toThrow(/parent/);
    const request = prepareControlWorkObservation(f.owner, { ...bodyInput(f), bodies: [] });
    append(f, request);
    const response: ControlWorkObservationInput = {
      ...request,
      observation: {
        id: 'response:1',
        type: 'model.observed',
        ts: timestamp,
        obs: 'llm-gateway',
        corr: 'call:1',
        parent: 'model:request',
        payload: {
          direction: 'response',
          event: 'done',
          attempt: 1,
          runtimeOriginRef: null,
          content: { state: 'off' },
        },
      },
    };
    expect(() => append(f, response)).toThrow(/request lineage/);
    expect(
      append(f, {
        ...response,
        observation: {
          ...response.observation,
          payload: { ...response.observation.payload, attempt: 0 },
        },
      }).observation.seq
    ).toBe(2);
  });

  it('keeps immutable publication outside SQL and commits only verified scoped metadata', () => {
    const f = fixture(kind);
    const body = bodyInput(f);
    const prepared = prepareControlWorkObservation(f.owner, body);
    expect(() => append(f, prepared)).toThrow(/independent publication/);
    expect(readControlWorkObservations(f.sqlite, f.owner, f)).toEqual([]);
    const filesBefore = readdirSync(f.root, { recursive: true });
    f.sqlite.exec('BEGIN');
    expect(() => publishControlWorkObservationBodies(f.db, body)).toThrow(
      /independent owner commit/
    );
    f.sqlite.exec('ROLLBACK');
    expect(readdirSync(f.root, { recursive: true })).toEqual(filesBefore);
    const published = publishControlWorkObservationBodies(f.db, body);
    const filesPublished = readdirSync(f.root, { recursive: true });
    f.sqlite.exec('BEGIN; SAVEPOINT observation');
    const result = applyControlWorkObservation(f.sqlite, f.owner, published);
    expect(result.observation.seq).toBe(1);
    expect(result.publication?.seq).toBe(2);
    f.sqlite.exec('ROLLBACK TO observation; RELEASE observation; COMMIT');
    expect(f.sqlite.prepare('SELECT import_status FROM evidence_bundles').get()).toEqual({
      import_status: 'promoted',
    });
    expect(readControlWorkObservations(f.sqlite, f.owner, f)).toEqual([]);
    expect(append(f, published).publication?.seq).toBe(2);
    expect(readdirSync(f.root, { recursive: true })).toEqual(filesPublished);
    expect(readControlWorkObservations(f.sqlite, f.owner, f).map((row) => row.type)).toEqual([
      'model.observed',
      'content.published',
    ]);
    expect(append(f, published).disposition).toBe('duplicate');
  });

  it('supports deferred body publication without accepting forged owner or publication edges', () => {
    const f = fixture(kind);
    const body = bodyInput(f);
    const prepared = prepareControlWorkObservation(f.owner, {
      ...body,
      deferBodyPublication: true,
    });
    expect(append(f, prepared).publication).toBeNull();
    expect(() =>
      append(f, {
        ...prepared,
        publishBodies: true,
        bodies: prepared.bodies.map((b) => ({ ...b, bundleId: 'foreign' })),
      })
    ).toThrow(/owner/);
    expect(() =>
      append(f, {
        ...prepared,
        bodies: [],
        observation: {
          ...prepared.observation,
          refs: [{ kind: 'evidence-bundle', scope: {}, locator: 'foreign', edge: 'publication' }],
        },
      })
    ).toThrow(/writer/);
    expect(append(f, publishControlWorkObservationBodies(f.db, body)).publication?.seq).toBe(2);
    expect(append(f, { ...prepared, bodies: [] }).disposition).toBe('duplicate');
    const metadataReplay = publishControlWorkObservationBodies(f.db, { ...body, bodies: [] });
    expect(metadataReplay).toMatchObject({ bodies: [], publishBodies: false });
    expect(append(f, metadataReplay).publication?.seq).toBe(2);
  });

  it('rejects unpublished expiry but never recreates bytes after an existing publication expires', () => {
    const f = fixture(kind);
    const body = bodyInput(f);
    const prepared = publishControlWorkObservationBodies(f.db, body);
    f.sqlite.prepare("UPDATE evidence_bundles SET import_status='expired'").run();
    expect(() => append(f, prepared)).toThrow(/independent publication/);
    expect(() => publishControlWorkObservationBodies(f.db, body)).toThrow(/expired/);
    f.sqlite.prepare("UPDATE evidence_bundles SET import_status='promoted'").run();
    append(f, prepared);
    f.sqlite.prepare("UPDATE evidence_bundles SET import_status='expired'").run();
    const bodyPath = join(
      f.root,
      ...(f.db.scope === 'core' ? ['server'] : ['workspaces', f.db.workspaceId]),
      'evidence',
      'backend',
      prepared.bodies[0]!.bundleId,
      'raw',
      'content'
    );
    rmSync(bodyPath);
    const files = readdirSync(f.root, { recursive: true });
    expect(publishControlWorkObservationBodies(f.db, body)).toEqual(prepared);
    expect(append(f, prepared).disposition).toBe('duplicate');
    expect(readdirSync(f.root, { recursive: true })).toEqual(files);
    expect(existsSync(bodyPath)).toBe(false);
  });

  it('checks coverage, exact immutable digest, and retained row versions without mutation', () => {
    const f = fixture(kind);
    const body = bodyInput(f);
    const prepared = publishControlWorkObservationBodies(f.db, body);
    f.sqlite.prepare("UPDATE evidence_bundles SET content_digests_json='[]'").run();
    expect(() => append(f, prepared)).toThrow(/independent publication/);
    const raw = turnRaw(f);
    f.sqlite
      .prepare('UPDATE control_turns SET record_json=? WHERE id=?')
      .run(
        JSON.stringify({ ...raw, captureCoverage: { scope: 'server', value: 'off' } }),
        f.turnId
      );
    expect(() => append(f, prepared)).toThrow(/coverage is off/);
    f.sqlite
      .prepare('UPDATE control_turns SET record_json=? WHERE id=?')
      .run(JSON.stringify(raw), f.turnId);
    append(f);
    f.sqlite
      .prepare('UPDATE control_work_observations SET record_json=?')
      .run(JSON.stringify({ ...readControlWorkObservations(f.sqlite, f.owner, f)[0], v: 2 }));
    expect(() => readControlWorkObservations(f.sqlite, f.owner, f)).toThrow();
  });

  it('checks runtime semantic-unit bytes, digest, media type and boundary before publication', () => {
    const f = fixture(kind);
    const bytes = Buffer.from('runtime body');
    const runtime: ControlWorkObservationPreparation = {
      ...bodyInput(f),
      observation: {
        id: 'runtime:1',
        type: 'runtime.observed',
        ts: timestamp,
        obs: 'worker-shim',
        payload: {
          observationId: 'runtime:1',
          sourceRef: 'source:1',
          sourceSequence: 1,
          observedAt: timestamp,
          fact: {
            kind: 'assistant',
            phase: 'completed',
            runtimeOriginRef: 'origin:1',
            messageRef: 'message:1',
            representation: 'snapshot',
          },
          content: {
            state: 'expected',
            bytes: bytes.length,
            chunkCount: 1,
            sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
            mediaType: 'text/plain',
            boundary: 'outward-assistant-v1',
          },
        },
      },
      bodies: [{ id: 'body', bytes, mediaType: 'text/plain', boundary: 'outward-assistant-v1' }],
    };
    const candidate = prepareControlWorkObservation(f.owner, runtime);
    expect(() =>
      append(f, {
        ...candidate,
        bodies: candidate.bodies.map((b) => ({ ...b, bytes: b.bytes + 1 })),
      })
    ).toThrow(/contradicts/);
  });

  it('refuses absent capture manifests, sequence gaps and oversized metadata instead of repairing authority', () => {
    const f = fixture(kind);
    expect(() =>
      append(f, {
        ...input(f),
        observation: { ...input(f).observation, ext: { tooLarge: 'x'.repeat(64 * 1024) } },
      })
    ).toThrow(/native bound/);
    expect(turnRaw(f)).toEqual(f.turn);
    append(f);
    append(f, input(f, 'gap:2'));
    const raw = turnRaw(f);
    f.sqlite
      .prepare('UPDATE control_turns SET record_json=? WHERE id=?')
      .run(JSON.stringify({ ...raw, requiredFeatures: [] }), f.turnId);
    expect(() => readControlWorkObservations(f.sqlite, f.owner, f)).toThrow(/manifest/);
    expect(() => append(f, input(f, 'gap:3'))).toThrow(/manifest/);
    f.sqlite
      .prepare('UPDATE control_turns SET record_json=? WHERE id=?')
      .run(JSON.stringify(raw), f.turnId);
    f.sqlite.prepare('DELETE FROM control_work_observations WHERE sequence=1').run();
    expect(() => readControlWorkObservations(f.sqlite, f.owner, f)).toThrow(/sequence gap/);
    expect(() => append(f, input(f, 'gap:3'))).toThrow(/sequence/);
  });

  it('validates environment ownership without deriving a Workspace for Server observations', () => {
    const f = fixture(kind);
    const observation = {
      id: 'env:1',
      type: 'env.bound',
      ts: timestamp,
      obs: 'nanocore' as const,
      payload: {
        version: '1',
        ...(f.owner.kind === 'server'
          ? { owner: { kind: 'server' } }
          : { workspaceId: f.owner.workspaceId }),
        systemPromptDigest: `sha256:${'a'.repeat(64)}`,
        tools: [],
      },
    };
    expect(append(f, { ...input(f), observation }).observation.payload).toEqual(
      observation.payload
    );
    expect(() =>
      append(f, {
        ...input(f),
        observation: {
          ...observation,
          id: 'env:wrong',
          payload: {
            version: '1',
            workspaceId: allocateEntityId('ws'),
            systemPromptDigest: `sha256:${'a'.repeat(64)}`,
            tools: [],
          },
        },
      })
    ).toThrow(/database owner/);
  });

  it('skips only never-recorded absent coverage and refuses missing capture authority after observation', () => {
    const f = fixture(kind);
    const reap = { ...f, reason: 'completed', inferredBy: 'native-terminal' };
    const original = turnRaw(f);
    f.sqlite.transaction(() => {
      terminalize(f);
      f.sqlite
        .prepare('UPDATE control_turns SET record_json=? WHERE id=?')
        .run(JSON.stringify({ ...turnRaw(f), captureCoverage: undefined }), f.turnId);
      expect(applyControlTurnReap(f.sqlite, f.owner, reap)).toBeNull();
    })();
    f.sqlite
      .prepare('UPDATE control_turns SET status=?,record_json=? WHERE id=?')
      .run(original.status, JSON.stringify(original), f.turnId);
    append(f);
    expect(() =>
      f.sqlite.transaction(() => {
        terminalize(f);
        f.sqlite
          .prepare('UPDATE control_turns SET record_json=? WHERE id=?')
          .run(JSON.stringify({ ...turnRaw(f), captureCoverage: undefined }), f.turnId);
        applyControlTurnReap(f.sqlite, f.owner, reap);
      })()
    ).toThrow(/missing capture coverage/);
    expect(turnRaw(f).status).toBe('running');
  });

  it('settles only each matched model attempt and runtime tool call in ordinary reap', () => {
    const f = fixture(kind);
    const request = prepareControlWorkObservation(f.owner, { ...bodyInput(f), bodies: [] });
    append(f, request);
    append(f, {
      ...request,
      observation: {
        ...request.observation,
        id: 'model:retry',
        payload: { ...request.observation.payload, attempt: 1 },
      },
    });
    append(f, {
      ...request,
      observation: {
        id: 'model:done',
        type: 'model.observed',
        ts: timestamp,
        obs: 'llm-gateway',
        parent: 'model:request',
        corr: 'call:1',
        payload: {
          direction: 'response',
          event: 'done',
          attempt: 0,
          runtimeOriginRef: null,
          content: { state: 'off' },
        },
      },
    });
    for (const [id, phase, callRef] of [
      ['tool:start', 'started', 'tool:1'],
      ['tool:end', 'completed', 'tool:1'],
      ['tool:open', 'started', 'tool:2'],
    ] as const)
      append(f, {
        ...input(f),
        observation: {
          id,
          type: 'runtime.observed',
          ts: timestamp,
          obs: 'worker-shim',
          payload: {
            observationId: id,
            sourceRef: 'source:1',
            sourceSequence: 1,
            observedAt: timestamp,
            fact: { kind: 'tool', phase, runtimeOriginRef: 'origin:1', callRef, toolName: 'read' },
            content: { state: 'off' },
          },
        },
      });
    const result = f.sqlite.transaction(() => {
      terminalize(f);
      return applyControlTurnReap(f.sqlite, f.owner, {
        ...f,
        reason: 'completed',
        inferredBy: 'native-terminal',
      });
    })();
    expect(result?.payload.unresolvedCalls).toEqual([
      { corr: 'call:1', type: 'model.observed', name: null, ts: timestamp },
      { corr: 'tool:2', type: 'runtime.observed', name: 'read', ts: timestamp },
    ]);
  });

  it('uses ingest order across bounded pages and records ordinary terminality without restart recovery', () => {
    const f = fixture(kind);
    f.sqlite.transaction(() => {
      for (let n = 0; n < 130; n++)
        applyControlWorkObservation(f.sqlite, f.owner, {
          ...input(f, `gap:${n}`),
          observation: {
            ...input(f, `gap:${n}`).observation,
            ts: n === 129 ? '2026-10-19T00:00:00.000Z' : timestamp,
          },
        });
    })();
    expect(readControlWorkObservations(f.sqlite, f.owner, f)).toHaveLength(128);
    expect(
      readControlWorkObservations(f.sqlite, f.owner, { ...f, afterSequence: 128 }).map(
        (row) => row.seq
      )
    ).toEqual([129, 130]);
    const result = f.sqlite.transaction(() => {
      terminalize(f);
      return applyControlTurnReap(f.sqlite, f.owner, {
        ...f,
        reason: 'completed',
        inferredBy: 'native-terminal',
      });
    })();
    expect(result).toMatchObject({
      seq: 131,
      payload: { lastObservedTs: '2026-10-19T00:00:00.000Z', unresolvedCalls: [] },
    });
    expect(f.sqlite.inTransaction).toBe(false);
  });

  it('publishes ordinary terminal reap in the same savepoint and retains its first snapshot', () => {
    const f = fixture(kind);
    const reap = { ...f, reason: 'completed', inferredBy: 'native-terminal' };
    expect(() => prepareControlTurnReap(f.sqlite, f.owner, reap)).toThrow(/owning SQL transaction/);
    expect(() =>
      f.sqlite.transaction(() => prepareControlTurnReap(f.sqlite, f.owner, reap))()
    ).toThrow(/terminal Turn/);
    append(f, prepareControlWorkObservation(f.owner, { ...bodyInput(f), bodies: [] }));
    f.sqlite.exec('BEGIN; SAVEPOINT terminal');
    terminalize(f);
    const result = applyControlTurnReap(f.sqlite, f.owner, reap);
    expect(result).toMatchObject({
      id: `turn.reap:${f.turnId}`,
      seq: 2,
      ts: timestamp,
      payload: {
        reason: 'completed',
        lastObservedTs: timestamp,
        inferredBy: 'native-terminal',
        unresolvedCalls: [{ corr: 'call:1', type: 'model.observed', name: null, ts: timestamp }],
      },
    });
    f.sqlite.exec('ROLLBACK TO terminal; RELEASE terminal; COMMIT');
    expect(turnRaw(f).status).toBe('running');
    expect(
      readControlWorkObservation(f.sqlite, f.owner, { ...f, id: `turn.reap:${f.turnId}` })
    ).toBeUndefined();
    const committed = f.sqlite.transaction(() => {
      terminalize(f);
      return applyControlTurnReap(f.sqlite, f.owner, reap);
    })();
    append(f, input(f, 'late-gap'));
    expect(
      f.sqlite.transaction(() =>
        applyControlTurnReap(f.sqlite, f.owner, { ...reap, reason: 'late reason' })
      )()
    ).toEqual(committed);
  });
});
