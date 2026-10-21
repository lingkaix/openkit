import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as evidenceBundles from '../evidence-bundles.js';
import {
  compactWorkspaceEvidenceBundles,
  listWorkspaceEvidenceBundles,
  readWorkObservationBody,
  workObservationBodyBundleId,
} from '../evidence-bundles.js';
import { FsStore } from '../lib/store.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { createTestStore } from '../test-support/store.js';
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
async function fixture(value: 'off' | 'on' = 'on') {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-observations-'));
  roots.push(dataRoot);
  const store = createTestStore({ dataRoot });
  const workspace = await store.createWorkspace('Capture');
  const thread = await store.createThread(workspace.id, 'Capture');
  const turn = await store.createTurn(
    workspace.id,
    thread.id,
    'Request',
    { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
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

/** Admits an ordinary reply through the real Item writer, independently of native observation identity. */
async function admitReply(f: Awaited<ReturnType<typeof fixture>>, text: string) {
  const item = {
    id: testEntityId('it', `ordinary-${f.owner.turnId}`),
    owner: { kind: 'workspace', workspaceId: f.db.workspaceId },
    ...f.owner,
    type: 'assistant-message',
    status: 'completed',
    text,
    createdAt: '2026-09-22T00:00:10.000Z',
    completedAt: '2026-09-22T00:00:10.000Z',
  } as const;
  await f.store.createItem(item);
  return item;
}

/** Gateway metadata used to prove the shared inline-body path independently of worker transport. */
function model(id = 'observation-one'): WorkObservationDraft {
  return {
    id,
    type: 'model.observed',
    ts: '2026-09-22T00:00:00.000Z',
    obs: 'llm-gateway',
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

/** Minimal Core environment evidence, with no synthetic admission for older records. */
function environment(workspaceId: string, assistantSkillAdmission?: unknown): WorkObservationDraft {
  return {
    id: 'environment-one',
    type: 'env.bound',
    ts: '2026-09-22T00:00:00.000Z',
    obs: 'nanocore',
    ret: 'turn-evidence',
    payload: {
      version: '1',
      workspaceId,
      systemPromptDigest: `sha256:${'a'.repeat(64)}`,
      tools: [],
      ...(assistantSkillAdmission === undefined ? {} : { assistantSkillAdmission }),
    },
  };
}

const admittedSkill = {
  skillId: 'source-skill',
  versionId: `sha256:${'b'.repeat(64)}`,
  contentDigest: `sha256:${'b'.repeat(64)}`,
};

/** Source-validated outward assistant fact with an exact expected body declaration. */
function assistant(bytes: Uint8Array): WorkObservationDraft {
  return {
    id: 'assistant-one',
    type: 'runtime.observed',
    ts: '2026-09-22T00:00:00.000Z',
    obs: 'worker-shim',
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
  it('reads retained environments without inserting an Assistant Skill admission default', async () => {
    const f = await fixture('off');
    await appendWorkObservation(f.db, {
      ...f.owner,
      observation: environment(f.db.workspaceId),
      bodies: [],
    });
    const path = join(f.turnRoot, 'observations.jsonl');
    const bytes = readFileSync(path, 'utf8');
    f.db.sqlite.close();
    const reopened = openWorkspaceDb(f.dataRoot, f.db.workspaceId);
    databases.push(reopened);
    const rows = readWorkObservations(reopened, f.owner);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).not.toHaveProperty('assistantSkillAdmission');
    expect(readFileSync(path, 'utf8')).toBe(bytes);
    expect(() =>
      appendWorkObservation(reopened, {
        ...f.owner,
        observation: environment(f.db.workspaceId, { catalogRevision: null, skills: [] }),
        bodies: [],
      })
    ).toThrow('recovery_required: observation identity conflict');
    expect(readFileSync(path, 'utf8')).toBe(bytes);
  });

  it.each([
    { catalogRevision: null, skills: [] },
    { catalogRevision: 0, skills: [admittedSkill] },
    {
      catalogRevision: 7,
      skills: [admittedSkill, { ...admittedSkill, skillId: 'source-skill-two' }],
    },
  ])('retains exact Assistant Skill admission with full I/O off: %j', async (admission) => {
    const f = await fixture('off');
    const timeline = readThreadRuntimeActivity(f.db, {
      threadId: f.owner.threadId,
      turnIds: [f.owner.turnId],
    });
    const input = {
      ...f.owner,
      observation: environment(f.db.workspaceId, admission),
      bodies: [],
    };
    expect((await appendWorkObservation(f.db, input)).disposition).toBe('committed');
    const path = join(f.turnRoot, 'observations.jsonl');
    const bytes = readFileSync(path, 'utf8');
    expect(JSON.parse(bytes).payload.assistantSkillAdmission).toEqual(admission);
    expect((await appendWorkObservation(f.db, input)).disposition).toBe('duplicate');
    expect(readFileSync(path, 'utf8')).toBe(bytes);
    f.db.sqlite.close();
    const reopened = openWorkspaceDb(f.dataRoot, f.db.workspaceId);
    databases.push(reopened);
    const rows = readWorkObservations(reopened, f.owner);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload.assistantSkillAdmission).toEqual(admission);
    expect(rows[0]?.ret).toBe('turn-evidence');
    expect(rows[0]?.payload).not.toHaveProperty('bodies');
    expect(listWorkspaceEvidenceBundles(reopened, f.db.workspaceId)).toEqual([]);
    expect(
      readThreadRuntimeActivity(reopened, {
        threadId: f.owner.threadId,
        turnIds: [f.owner.turnId],
      })
    ).toEqual(timeline);
    expect((await appendWorkObservation(reopened, input)).disposition).toBe('duplicate');
    expect(readFileSync(path, 'utf8')).toBe(bytes);
  });

  it.each([
    { catalogRevision: 8, skills: [admittedSkill] },
    { catalogRevision: 7, skills: [{ ...admittedSkill, skillId: 'other-skill' }] },
    {
      catalogRevision: 7,
      skills: [
        {
          ...admittedSkill,
          versionId: `sha256:${'c'.repeat(64)}`,
          contentDigest: `sha256:${'c'.repeat(64)}`,
        },
      ],
    },
    { catalogRevision: null, skills: [] },
  ])('refuses changed valid Assistant Skill admission under one identity: %j', async (changed) => {
    const f = await fixture('off');
    const input = {
      ...f.owner,
      observation: environment(f.db.workspaceId, { catalogRevision: 7, skills: [admittedSkill] }),
      bodies: [],
    };
    await appendWorkObservation(f.db, input);
    const path = join(f.turnRoot, 'observations.jsonl');
    const bytes = readFileSync(path, 'utf8');
    expect(() =>
      appendWorkObservation(f.db, {
        ...input,
        observation: environment(f.db.workspaceId, changed),
      })
    ).toThrow('recovery_required: observation identity conflict');
    expect(readFileSync(path, 'utf8')).toBe(bytes);
    expect(readWorkObservations(f.db, f.owner)).toHaveLength(1);
  });

  it.each([
    ['null tuple', null],
    ['missing revision', { skills: [] }],
    ['missing skills', { catalogRevision: null }],
    ['negative revision', { catalogRevision: -1, skills: [admittedSkill] }],
    ['fractional revision', { catalogRevision: 1.5, skills: [admittedSkill] }],
    ['string revision', { catalogRevision: '7', skills: [admittedSkill] }],
    ['empty with revision', { catalogRevision: 0, skills: [] }],
    ['selected without revision', { catalogRevision: null, skills: [admittedSkill] }],
    ['duplicate IDs', { catalogRevision: 7, skills: [admittedSkill, admittedSkill] }],
    [
      'unordered IDs',
      { catalogRevision: 7, skills: [admittedSkill, { ...admittedSkill, skillId: 'alpha' }] },
    ],
    ['invalid ID', { catalogRevision: 7, skills: [{ ...admittedSkill, skillId: 'Source Skill' }] }],
    [
      'missing digest',
      {
        catalogRevision: 7,
        skills: [{ skillId: 'source-skill', versionId: admittedSkill.versionId }],
      },
    ],
    [
      'invalid digest',
      { catalogRevision: 7, skills: [{ ...admittedSkill, contentDigest: 'b'.repeat(64) }] },
    ],
    [
      'equal malformed version and digest',
      {
        catalogRevision: 7,
        skills: [{ ...admittedSkill, versionId: 'b'.repeat(64), contentDigest: 'b'.repeat(64) }],
      },
    ],
    [
      'changed digest only',
      {
        catalogRevision: 7,
        skills: [{ ...admittedSkill, contentDigest: `sha256:${'c'.repeat(64)}` }],
      },
    ],
    [
      'changed version only',
      { catalogRevision: 7, skills: [{ ...admittedSkill, versionId: `sha256:${'c'.repeat(64)}` }] },
    ],
    [
      'extra admission content',
      { catalogRevision: 7, skills: [admittedSkill], prompt: 'unowned prompt' },
    ],
    ...['name', 'description', 'body', 'path', 'credentials', 'inputSchema'].map((key) => [
      `extra Skill ${key}`,
      { catalogRevision: 7, skills: [{ ...admittedSkill, [key]: 'unowned content' }] },
    ]),
  ])('rejects malformed Assistant Skill admission before persistence: %s', async (_name, admission) => {
    const f = await fixture('off');
    const observation = environment(f.db.workspaceId, admission);
    expect(() =>
      parseWorkObservationRecord({ ...observation, turnId: f.owner.turnId, v: 1, seq: 1 })
    ).toThrow();
    expect(() => appendWorkObservation(f.db, { ...f.owner, observation, bodies: [] })).toThrow();
    expect(readWorkObservations(f.db, f.owner)).toEqual([]);
    expect(existsSync(join(f.turnRoot, 'observations.jsonl'))).toBe(false);
  });

  it('reads appends and reopens observations with annotated owning Turn attribution', async () => {
    const f = await fixture();
    expect(readWorkObservations(f.db, f.owner)).toEqual([]);
    const turnPath = join(f.turnRoot, 'turn.json');
    const retained = JSON.parse(readFileSync(turnPath, 'utf8'));
    retained.triggerActor.futureNote = 'Retained attribution';
    writeFileSync(turnPath, `${JSON.stringify(retained, null, 2)}\n`);
    expect(new FsStore({ dataRoot: f.dataRoot }).getTurnById(f.owner.turnId)?.triggerActor).toEqual(
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    expect(readWorkObservations(f.db, f.owner)).toEqual([]);
    const appended = await appendWorkObservation(f.db, {
      ...f.owner,
      observation: model(),
      bodies: [],
    });
    expect(appended.disposition).toBe('committed');
    f.db.sqlite.close();
    const reopened = openWorkspaceDb(f.dataRoot, f.db.workspaceId);
    databases.push(reopened);
    expect(readWorkObservations(reopened, f.owner)).toEqual([appended.observation]);
    expect(
      (await appendWorkObservation(reopened, { ...f.owner, observation: model(), bodies: [] })).disposition
    ).toBe('duplicate');
    expect(JSON.parse(readFileSync(turnPath, 'utf8')).triggerActor).toEqual(retained.triggerActor);
    expect(new FsStore({ dataRoot: f.dataRoot }).getTurnById(f.owner.turnId)?.triggerActor).toEqual(
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
  });

  it.each([
    'running',
    'pending',
  ] as const)('does constant prior-row parse work per append after opening the %s writer', async (status) => {
    const f = await fixture('off');
    await f.store.updateTurn(f.owner.turnId, { status });
    await appendWorkObservation(f.db, { ...f.owner, observation: model('warm'), bodies: [] });
    const parse = vi.spyOn(JSON, 'parse');
    try {
      for (let index = 0; index < 20; index++) {
        parse.mockClear();
        const id = `delta-${index}`;
        await appendWorkObservation(f.db, { ...f.owner, observation: model(id), bodies: [] });
        const priorRows = parse.mock.calls.filter(
          ([text]) =>
            typeof text === 'string' &&
            text.includes('"seq":') &&
            text.includes('"type":"model.observed"') &&
            !text.includes(`"id":"${id}"`)
        );
        expect(priorRows).toHaveLength(0);
      }
      parse.mockClear();
      expect(readWorkObservations(f.db, f.owner)).toHaveLength(21);
      expect(parse.mock.calls.filter(([text]) => text.includes('"seq":'))).toHaveLength(21);
    } finally {
      parse.mockRestore();
    }
  });

  it('revalidates externally changed ledgers and does not trust returned observation objects', async () => {
    const f = await fixture('off');
    const input = { ...f.owner, observation: model(), bodies: [] };
    const result = await appendWorkObservation(f.db, input);
    (result.observation.payload.content as { state: string }).state = 'off';
    expect((await appendWorkObservation(f.db, input)).disposition).toBe('duplicate');
    const path = join(f.turnRoot, 'observations.jsonl');
    const original = readFileSync(path, 'utf8');
    // Same-length replacement must invalidate state, not just growth or truncation.
    writeFileSync(path, original.replace('"seq":1', '"seq":9'));
    expect(() => readWorkObservations(f.db, f.owner)).toThrow(/corrupt observation/);
    expect(() => appendWorkObservation(f.db, input)).toThrow(/corrupt observation/);
    writeFileSync(path, original);
    appendFileSync(path, '{"torn":');
    expect((await appendWorkObservation(f.db, input)).disposition).toBe('duplicate');
    expect(readFileSync(path, 'utf8')).toBe(original);
    f.db.sqlite.close();
    const reopened = openWorkspaceDb(f.dataRoot, f.db.workspaceId);
    databases.push(reopened);
    writeFileSync(path, original.replace('"seq":1', '"seq":9'));
    expect(() => appendWorkObservation(reopened, input)).toThrow(/corrupt observation/);
  });

  it('refuses body effects for an observation kind without a body declaration', async () => {
    const f = await fixture();
    expect(() =>
      appendWorkObservation(f.db, {
        ...f.owner,
        observation: {
          id: 'env-with-body',
          type: 'env.bound',
          obs: 'nanocore',
          ts: '2026-09-29T00:00:00.000Z',
          payload: {
            version: '1',
            workspaceId: f.db.workspaceId,
            content: { state: 'expected' },
            systemPromptDigest: `sha256:${'a'.repeat(64)}`,
            tools: [],
          },
        },
        bodies: [
          {
            id: 'undeclared',
            bytes: Buffer.from('Unconsumed prompt bytes'),
            mediaType: 'text/plain',
            boundary: 'gateway-request-v1',
          },
        ],
      })
    ).toThrow('This observation type has no admitted body');
    expect(readWorkObservations(f.db, f.owner)).toEqual([]);
  });
  it('normalizes model sampling, content, body and publication additions while retaining their bytes', async () => {
    const f = await fixture();
    const observation = {
      ...model('model-request'),
      payload: {
        attempt: 0,
        direction: 'request',
        event: 'request',
        runtimeOriginRef: null,
        content: { state: 'expected', futureNote: 'ignored' },
        providerRef: 'provider',
        model: 'model',
        systemPromptDigest: `sha256:${'d'.repeat(64)}`,
        sampling: { temperature: 0, futureNote: 'ignored' },
        futureNote: 'ignored',
      },
    };
    const bytes = Buffer.from('Owned model evidence');
    await appendWorkObservation(f.db, {
      ...f.owner,
      observation,
      bodies: [{ id: 'model-body', bytes, mediaType: 'text/plain', boundary: 'model-request-v1' }],
    });
    const path = join(f.turnRoot, 'observations.jsonl');
    const rows = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(JSON.stringify(rows)).not.toContain('futureNote');
    for (const row of rows) {
      row.futureNote = 'retained';
      row.payload.futureNote = 'retained';
      for (const descriptor of row.payload.bodies) descriptor.futureNote = 'retained';
      for (const ref of row.refs ?? []) ref.futureNote = 'retained';
    }
    rows[0].payload.content.futureNote = 'retained';
    rows[0].payload.sampling.futureNote = 'retained';
    writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    const retained = readFileSync(path, 'utf8');
    expect(JSON.stringify(readWorkObservations(f.db, f.owner))).not.toContain('futureNote');
    expect((await appendWorkObservation(f.db, { ...f.owner, observation, bodies: [] })).disposition).toBe(
      'duplicate'
    );
    expect(readFileSync(path, 'utf8')).toBe(retained);
    expect(() =>
      parseWorkObservationRecord({
        ...rows[0],
        payload: { ...rows[0].payload, turnId: 'tu_00000000-0000-7f7b-9b65-51065b0acd8c' },
      })
    ).toThrow(/header identity/);
  });
  it('normalizes live nested additions and reopens annotated history without rewriting its evidence', async () => {
    const f = await fixture();
    const bytes = Buffer.from('Retained descriptive evidence');
    const observation = assistant(bytes);
    const extended = structuredClone(observation);
    (extended.payload.fact as Record<string, unknown>).futureNote = 'ignored';
    (extended.payload.content as Record<string, unknown>).futureNote = 'ignored';
    extended.payload.futureNote = 'ignored';
    const body = {
      id: 'assistant',
      bytes,
      mediaType: 'text/plain',
      boundary: 'outward-assistant-v1',
    };
    const admitted = await appendWorkObservation(f.db, {
      ...f.owner,
      observation: extended,
      bodies: [body],
    });
    expect(JSON.stringify(admitted.observation)).not.toContain('futureNote');
    const path = join(f.turnRoot, 'observations.jsonl');
    const rows = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    for (const row of rows) {
      row.futureNote = 'retained';
      row.payload.futureNote = 'retained';
      for (const ref of row.refs ?? []) ref.futureNote = 'retained';
      for (const descriptor of row.payload.bodies ?? []) descriptor.futureNote = 'retained';
    }
    rows[0].payload.fact.futureNote = 'retained';
    rows[0].payload.content.futureNote = 'retained';
    writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    const retainedBytes = readFileSync(path, 'utf8');
    expect(JSON.stringify(readWorkObservations(f.db, f.owner))).not.toContain('futureNote');
    expect(
      (await appendWorkObservation(f.db, { ...f.owner, observation, bodies: [body] })).disposition
    ).toBe('duplicate');
    expect(readFileSync(path, 'utf8')).toBe(retainedBytes);
    f.db.sqlite.close();
    const reopened = openWorkspaceDb(f.dataRoot, f.db.workspaceId);
    databases.push(reopened);
    expect(readWorkObservations(reopened, f.owner)).toHaveLength(2);
    // F1 oracle alignment: annotated raw evidence stays readable by its owner, not as an ordinary excerpt.
    const publication = readWorkObservations(reopened, f.owner)[1]!;
    expect(
      readWorkObservationBody(reopened, {
        ...f.owner,
        bundleId: publication.refs![0]!.locator,
        createdAt: observation.ts,
        sha256: publication.refs![0]!.digest!,
      })
    ).toEqual(bytes);
    expect(
      readThreadRuntimeActivity(reopened, {
        threadId: f.owner.threadId,
        turnIds: [f.owner.turnId],
      })[0]?.entries[0]?.text
    ).toBeUndefined();
  });
  it.skipIf(process.platform === 'win32').each(['before-publication', 'after-publication'])(
    'preserves the blob/reference boundary after SIGKILL %s and reopen',
    async (boundary) => {
      const f = await fixture();
      const workspaceId = f.db.workspaceId;
      const bytes = Buffer.from('  crash boundary 世界\n\tfinal\r\n');
      const observation = assistant(bytes);
      const body = {
        id: 'assistant',
        bytes,
        mediaType: 'text/plain',
        boundary: 'outward-assistant-v1',
      };
      const input = { ...f.owner, observation, bodies: [body] };
      const bundleId = workObservationBodyBundleId(
        workspaceId,
        f.owner.threadId,
        f.owner.turnId,
        observation.id,
        body.id
      );
      f.db.sqlite.close();

      // Exercise the real writers in a process that cannot run database or filesystem cleanup.
      // The pre-publication stop is after body retention, before opening the publication append.
      // SIGKILL removes process state; it does not discard the kernel cache or emulate power loss.
      const exited = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
const input = JSON.parse(process.argv[1]);
const path = join(input.dataRoot, 'workspaces', input.workspaceId, 'threads', input.owner.threadId, 'turns', input.owner.turnId, 'observations.jsonl');
const openSync = fs.openSync;
let appends = 0;
fs.openSync = (target, flags, mode) => {
  if (String(target) === path && typeof flags === 'number' && (flags & fs.constants.O_APPEND) !== 0 && ++appends === 2 && input.boundary === 'before-publication') {
    fs.writeSync(1, 'before-publication');
    process.kill(process.pid, 'SIGKILL');
  }
  return openSync(target, flags, mode);
};
syncBuiltinESMExports();
const { openWorkspaceDb } = await import(input.dbModule);
const { appendWorkObservation } = await import(input.observationModule);
const db = openWorkspaceDb(input.dataRoot, input.workspaceId);
appendWorkObservation(db, { ...input.owner, observation: input.observation, bodies: [{ ...input.body, bytes: Buffer.from(input.body.bytes) }] });
fs.writeSync(1, 'after-publication');
process.kill(process.pid, 'SIGKILL');`,
          JSON.stringify({
            dataRoot: f.dataRoot,
            workspaceId,
            owner: f.owner,
            observation,
            body: { ...body, bytes: [...bytes] },
            boundary,
            dbModule: new URL('./db.ts', import.meta.url).href,
            observationModule: new URL('./work-observations.ts', import.meta.url).href,
          }),
        ],
        { encoding: 'utf8', timeout: 15_000 }
      );
      expect(exited.error).toBeUndefined();
      expect(exited.stderr).toBe('');
      expect(exited.signal).toBe('SIGKILL');
      expect(exited.stdout).toBe(boundary);

      const reopened = openWorkspaceDb(f.dataRoot, workspaceId);
      databases.push(reopened);
      const blobPath = join(
        f.dataRoot,
        'workspaces',
        workspaceId,
        'evidence',
        'backend',
        bundleId,
        'raw',
        'content'
      );
      expect(readFileSync(blobPath)).toEqual(bytes);
      const rows = readWorkObservations(reopened, f.owner);
      expect(rows.map((row) => row.type)).toEqual(
        boundary === 'before-publication'
          ? ['runtime.observed']
          : ['runtime.observed', 'content.published']
      );
      expect(rows[0]?.refs).toBeUndefined();
      expect((await appendWorkObservation(reopened, { ...input, bodies: [] })).disposition).toBe(
        'duplicate'
      );
      expect(readWorkObservations(reopened, f.owner)).toEqual(rows);
      if (boundary === 'before-publication') {
        expect(
          readThreadRuntimeActivity(reopened, {
            threadId: f.owner.threadId,
            turnIds: [f.owner.turnId],
          })[0]?.entries.some((entry) => entry.text)
        ).toBe(false);
      }

      // Only an exact-content retry may endorse the orphan; metadata replay must not do so.
      await appendWorkObservation(reopened, input);
      const published = readWorkObservations(reopened, f.owner);
      expect(published).toHaveLength(2);
      const publication = published[1]!;
      expect(publication.parent).toBe(observation.id);
      expect(publication.refs).toEqual([
        {
          kind: 'evidence-bundle',
          scope: { workspaceId, pathClass: 'backend' },
          locator: bundleId,
          digest: createHash('sha256').update(bytes).digest('hex'),
          edge: 'publication',
        },
      ]);
      expect(
        readWorkObservationBody(reopened, {
          ...f.owner,
          bundleId,
          createdAt: observation.ts,
          sha256: publication.refs![0]!.digest!,
        })
      ).toEqual(bytes);
      expect((await appendWorkObservation(reopened, input)).disposition).toBe('duplicate');
      expect(readWorkObservations(reopened, f.owner)).toEqual(published);
    }
  );

  it('retains exact Unicode/whitespace separately, then publishes; reload and replay preserve identity', async () => {
    const f = await fixture();
    const bytes = Buffer.from('  hello 世界\n\tfinal\r\n');
    const input = {
      ...f.owner,
      observation: model(),
      bodies: [{ id: 'semantic', bytes, mediaType: 'text/plain', boundary: 'test-semantic-v1' }],
    };
    const first = await appendWorkObservation(f.db, input);
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
    expect((await appendWorkObservation(reopened, input)).disposition).toBe('duplicate');
    expect((await appendWorkObservation(reopened, { ...input, bodies: [] })).disposition).toBe('duplicate');
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
    await f.store.updateTurn(f.owner.turnId, {
      status: 'failed',
      error: { code: 'test', message: 'test' },
    });
    expect(
      JSON.parse(readFileSync(join(f.turnRoot, 'turn.json'), 'utf8')).requiredFeatures
    ).toContain('openkit.work-observations.v1');
  });

  it('records deferred byte identity without retaining content, then publishes only exact admitted bytes', async () => {
    const f = await fixture();
    const bytes = Buffer.from('exact deferred content 世界');
    const input = {
      ...f.owner,
      observation: model(),
      bodies: [{ id: 'semantic', bytes, mediaType: 'text/plain', boundary: 'test-semantic-v1' }],
    };
    await appendWorkObservation(f.db, { ...input, deferBodyPublication: true });
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
    await appendWorkObservation(f.db, input);
    const rows = readWorkObservations(f.db, f.owner);
    expect(rows).toHaveLength(2);
    expect((await appendWorkObservation(f.db, { ...input, bodies: [] })).disposition).toBe('duplicate');
    expect(readWorkObservations(f.db, f.owner)).toEqual(rows);
  });

  it('keeps the expected fact when body metadata commit fails and completes an exact retry', async () => {
    const f = await fixture();
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
    await appendWorkObservation(f.db, input);
    expect(readWorkObservations(f.db, f.owner)).toHaveLength(2);
  });

  it('discards even valid JSON without its LF and rejects corrupt interior records', async () => {
    const f = await fixture();
    await appendWorkObservation(f.db, { ...f.owner, observation: model(), bodies: [] });
    const path = join(f.turnRoot, 'observations.jsonl');
    const row = readWorkObservations(f.db, f.owner)[0]!;
    appendFileSync(path, JSON.stringify({ ...row, id: 'lost-tail', seq: 2 }));
    expect(readWorkObservations(f.db, f.owner)).toHaveLength(1);
    await appendWorkObservation(f.db, { ...f.owner, observation: model('next'), bodies: [] });
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

  it('rejects body capture when off or missing while retaining metadata under off', async () => {
    const f = await fixture('off');
    const metadata = { ...model(), payload: { ...model().payload, content: { state: 'off' } } };
    await appendWorkObservation(f.db, { ...f.owner, observation: metadata, bodies: [] });
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
      })[0]?.contentCapture
    ).toBe('unknown');
  });

  it('does not resurrect lawfully expired bodies on exact replay', async () => {
    const f = await fixture();
    const input = {
      ...f.owner,
      observation: model(),
      bodies: [
        { id: 'body', bytes: Buffer.from('expires'), mediaType: 'text/plain', boundary: 'test' },
      ],
    };
    await appendWorkObservation(f.db, input);
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
    expect((await appendWorkObservation(f.db, input)).disposition).toBe('duplicate');
    expect(existsSync(root)).toBe(false);
  });

  it('rejects unknown semantics and forged publication edges while omitting unowned metadata', () => {
    const row = { ...model(), turnId: testEntityId('tu', 'turn'), v: 1, seq: 1 };
    expect(() => parseWorkObservationRecord({ ...row, type: 'unowned.fact' })).toThrow(
      /Unsupported/
    );
    expect(
      parseWorkObservationRecord({ ...row, payload: { ...row.payload, secretBody: 'forbidden' } })
    ).not.toHaveProperty('payload.secretBody');
    expect(() =>
      parseWorkObservationRecord({
        ...row,
        refs: [{ kind: 'evidence-bundle', scope: {}, locator: 'forged', edge: 'publication' }],
      })
    ).toThrow();
  });

  it('projects child phases separately from bounded ordinary Item text, independent of raw expiry', async () => {
    const f = await fixture();
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
    await appendWorkObservation(f.db, { ...f.owner, observation: origin, bodies: [] });
    // F1 oracle alignment keeps the bounds, native-ref exclusion and coverage controls on the ordinary source.
    const reply = await admitReply(f, 'Useful result '.repeat(100));
    const bytes = Buffer.from('Raw capture canary is not the ordinary reply.');
    await appendWorkObservation(f.db, {
      ...f.owner,
      observation: assistant(bytes),
      bodies: [{ id: 'content', bytes, mediaType: 'text/plain', boundary: 'outward-assistant-v1' }],
    });
    const activity = readThreadRuntimeActivity(f.db, {
      threadId: f.owner.threadId,
      turnIds: [f.owner.turnId],
    })[0]!;
    expect(activity).toMatchObject({
      coverage: 'collecting',
      contentCapture: 'on',
      entries: [
        { kind: 'child-started', label: 'Child 1 started' },
        { kind: 'result', label: 'Child 1: response completed', textTruncated: false },
        {
          label: expect.stringMatching(/turn reply/i),
          observedAt: reply.createdAt,
          textTruncated: true,
        },
      ],
    });
    expect(activity.entries.slice(0, 2).every((entry) => entry.text === undefined)).toBe(true);
    expect(activity.entries[2]?.text).toBe(reply.text.slice(0, 1000));
    expect(activity.entries[2]?.text).toHaveLength(1000);
    expect(JSON.stringify(activity)).not.toContain('origin-child');
    expect(JSON.stringify(activity)).not.toContain(bytes.toString());
    compactWorkspaceEvidenceBundles({
      workspaceDb: f.db,
      workspaceId: f.db.workspaceId,
      olderThan: '2026-09-23T00:00:00.000Z',
    });
    expect(
      readThreadRuntimeActivity(f.db, {
        threadId: f.owner.threadId,
        turnIds: [f.owner.turnId],
      })[0]
    ).toEqual(activity);
  });

  it.each([
    'intact',
    'denied',
    'missing',
    'corrupt',
  ] as const)('does not read %s restricted bodies when projecting admitted ordinary Items', async (state) => {
    const f = await fixture();
    const reply = await admitReply(f, 'Ordinary source canary.');
    const bytes = Buffer.from('Different restricted capture canary.');
    const observation = assistant(bytes);
    await appendWorkObservation(f.db, {
      ...f.owner,
      observation,
      bodies: [{ id: 'content', bytes, mediaType: 'text/plain', boundary: 'outward-assistant-v1' }],
    });
    const publication = readWorkObservations(f.db, f.owner)[1]!;
    const ref = publication.refs![0]!;
    const rawInput = {
      ...f.owner,
      bundleId: ref.locator,
      createdAt: observation.ts,
      sha256: ref.digest!,
    };
    const rawPath = join(
      f.dataRoot,
      'workspaces',
      f.db.workspaceId,
      'evidence',
      'backend',
      ref.locator,
      'raw',
      'content'
    );
    expect(readWorkObservationBody(f.db, rawInput)).toEqual(bytes);
    expect(listWorkspaceEvidenceBundles(f.db, f.db.workspaceId)).toEqual([]);
    expect(
      f.db.sqlite
        .prepare('SELECT retention_class FROM evidence_bundles WHERE evidence_bundle_id = ?')
        .get(ref.locator)
    ).toEqual({ retention_class: 'restricted-raw' });
    if (state === 'missing') rmSync(rawPath);
    if (state === 'corrupt') writeFileSync(rawPath, 'corrupt fixture bytes');
    const openSync = fs.openSync;
    const opened = vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
      if (state === 'denied' && String(path) === rawPath) {
        throw Object.assign(new Error('F1 injected raw-file denial'), { code: 'EACCES' });
      }
      return openSync(path, flags, mode);
    });
    syncBuiltinESMExports();
    const rawRead = vi.spyOn(evidenceBundles, 'readWorkObservationBody');
    try {
      // Prove each fault reaches the real retained-body reader before testing that ordinary reads never enter it.
      if (state === 'denied')
        expect(() => readWorkObservationBody(f.db, rawInput)).toThrow(
          'F1 injected raw-file denial'
        );
      if (state === 'corrupt')
        expect(() => readWorkObservationBody(f.db, rawInput)).toThrow(
          'retained observation body mismatch'
        );
      if (state === 'missing') expect(readWorkObservationBody(f.db, rawInput)).toBeNull();
      opened.mockClear();
      rawRead.mockClear();
      const activity = readThreadRuntimeActivity(f.db, {
        threadId: f.owner.threadId,
        turnIds: [f.owner.turnId],
      })[0]!;
      expect.soft(rawRead).not.toHaveBeenCalled();
      expect.soft(opened.mock.calls.filter(([path]) => String(path) === rawPath)).toEqual([]);
      expect
        .soft(activity)
        .toMatchObject({ coverage: 'collecting', contentCapture: 'on', omittedEntryCount: 0 });
      expect.soft(activity.entries).toEqual([
        {
          sequence: 1,
          observedAt: observation.ts,
          kind: 'result',
          label: 'Worker: response completed',
          textTruncated: false,
        },
        expect.objectContaining({
          label: expect.stringMatching(/turn reply/i),
          observedAt: reply.createdAt,
          text: reply.text,
          textTruncated: false,
        }),
      ]);
      expect.soft(JSON.stringify(activity)).not.toContain(bytes.toString());
      expect.soft(JSON.stringify(activity)).not.toMatch(/message-one|origin-child|source-one/);
      expect.soft(f.store.getTurnById(f.owner.turnId)?.status).toBe('running');
    } finally {
      rawRead.mockRestore();
      opened.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it.each([
    'absent',
    'user-message',
    'reasoning',
    'empty-reply',
  ] as const)('does not fall back to a published raw body when the ordinary Item is %s', async (source) => {
    const f = await fixture();
    const bytes = Buffer.from('Safe-looking raw text must stay restricted.');
    await appendWorkObservation(f.db, {
      ...f.owner,
      observation: assistant(bytes),
      bodies: [{ id: 'content', bytes, mediaType: 'text/plain', boundary: 'outward-assistant-v1' }],
    });
    if (source === 'empty-reply') await admitReply(f, '');
    if (source === 'user-message' || source === 'reasoning') {
      await f.store.createItem({
        id: testEntityId('it', `not-a-reply-${source}`),
        owner: { kind: 'workspace', workspaceId: f.db.workspaceId },
        ...f.owner,
        ...(source === 'reasoning'
          ? {
              type: 'reasoning',
              summary: ['Private reasoning canary.'],
              content: ['Private reasoning body.'],
            }
          : {
              type: 'user-message',
              actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
              text: 'Non-reply Item canary.',
            }),
        status: 'completed',
        createdAt: '2026-09-22T00:00:10.000Z',
        completedAt: '2026-09-22T00:00:10.000Z',
      });
    }
    const activity = readThreadRuntimeActivity(f.db, {
      threadId: f.owner.threadId,
      turnIds: [f.owner.turnId],
    })[0]!;
    expect(activity).toMatchObject({
      coverage: 'collecting',
      entries: [{ label: 'Worker: response completed' }],
    });
    expect(activity.entries).toHaveLength(1);
    expect(activity.entries[0]).not.toHaveProperty('text');
    expect(activity.entries[0]?.textTruncated).toBe(false);
  });

  it.each([
    'absent',
    'unsupported',
    'unavailable',
  ] as const)('keeps ordinary Items with capture off and %s collection without claiming completion', async (collector) => {
    const f = await fixture('off');
    const reply = await admitReply(f, 'Admitted reply with full capture off.');
    if (collector !== 'absent') {
      await appendWorkObservation(f.db, {
        ...f.owner,
        observation: {
          id: 'collector-state',
          type: 'runtime.observed',
          ts: '2026-09-22T00:00:00.000Z',
          obs: 'worker-shim',
          payload: {
            observationId: 'collector-state',
            sourceRef: 'source-one',
            sourceSequence: 1,
            observedAt: '2026-09-22T00:00:00.000Z',
            fact: {
              kind: 'coverage',
              runtimeOriginRef: null,
              family: 'child-content',
              coverage: collector,
              ...(collector === 'unavailable' ? { reason: 'collector-failed' } : {}),
            },
            content: { state: 'not-applicable' },
          },
        },
        bodies: [],
      });
    }
    const activity = readThreadRuntimeActivity(f.db, {
      threadId: f.owner.threadId,
      turnIds: [f.owner.turnId],
    })[0]!;
    expect.soft(activity.coverage).toBe('unavailable');
    expect.soft(activity.contentCapture).toBe('off');
    expect.soft(activity.entries).toEqual([
      expect.objectContaining({
        label: expect.stringMatching(/turn reply/i),
        text: reply.text,
        observedAt: reply.createdAt,
      }),
    ]);
    expect(f.store.getTurnById(f.owner.turnId)?.status).toBe('running');
    expect(f.db.sqlite.prepare('SELECT COUNT(*) AS count FROM evidence_bundles').get()).toEqual({
      count: 0,
    });
  });

  it('screens the entire ordinary source before truncation without exposing reasoning or native identities', async () => {
    const f = await fixture('off');
    const reply = await admitReply(f, 'Safe ordinary text 世界\nSecond line.');
    const read = () =>
      readThreadRuntimeActivity(f.db, {
        threadId: f.owner.threadId,
        turnIds: [f.owner.turnId],
      })[0]!;
    expect.soft(read().entries.map((entry) => entry.text)).toEqual([reply.text]);
    for (const text of [
      'Authorization: Bearer f1-test-value',
      'token=f1-test-value',
      'Path /private/f1-canary',
      'native_session_id=f1-canary',
      '00000000-0000-7000-8000-000000000001',
      'Control\u0000character',
      `${'Safe prefix '.repeat(100)} api_key=f1-test-value`,
    ]) {
      await f.store.updateItem(reply.id, { text });
      expect.soft(read().entries, text).toEqual([]);
    }
    expect(f.store.getTurnById(f.owner.turnId)?.status).toBe('running');
  });

  it('counts the ordinary reply within the 50-entry bound and keeps fixed structural tool labels', async () => {
    const f = await fixture('off');
    const reply = await admitReply(f, 'Bounded ordinary text '.repeat(100));
    for (let index = 0; index < 52; index++) {
      await appendWorkObservation(f.db, {
        ...f.owner,
        observation: {
          id: `tool-${index}`,
          type: 'runtime.observed',
          ts: '2026-09-22T00:00:00.000Z',
          obs: 'worker-shim',
          payload: {
            observationId: `tool-${index}`,
            sourceRef: 'source-one',
            sourceSequence: index,
            observedAt: '2026-09-22T00:00:00.000Z',
            fact: {
              kind: 'tool',
              runtimeOriginRef: null,
              phase: 'completed',
              toolName: index === 51 ? 'private-native-tool-name' : 'bash',
              callRef: `native-call-${index}`,
              exitCode: 0,
            },
            content: { state: 'off' },
          },
        },
        bodies: [],
      });
    }
    const activity = readThreadRuntimeActivity(f.db, {
      threadId: f.owner.threadId,
      turnIds: [f.owner.turnId],
    })[0]!;
    expect.soft(activity.entries).toHaveLength(50);
    expect.soft(activity.omittedEntryCount).toBe(3);
    expect.soft(activity.coverage).toBe('collecting');
    const ordinary = activity.entries.filter((entry) => entry.text !== undefined);
    expect.soft(ordinary).toEqual([
      expect.objectContaining({
        text: reply.text.slice(0, 1000),
        textTruncated: true,
        label: expect.stringMatching(/turn reply/i),
      }),
    ]);
    const structural = activity.entries.filter((entry) => entry.text === undefined);
    expect.soft(structural).toHaveLength(49);
    expect.soft(structural.at(-1)).toMatchObject({
      kind: 'result',
      label: 'Worker: tool completed (exit 0)',
      textTruncated: false,
    });
    expect
      .soft(
        structural.slice(0, -1).every((entry) => entry.label === 'Worker: bash completed (exit 0)')
      )
      .toBe(true);
    expect
      .soft(JSON.stringify(activity))
      .not.toMatch(/private-native-tool-name|native-call|source-one/);
    expect(f.store.listThreadItems(f.db.workspaceId, f.owner.threadId)).toContainEqual(
      expect.objectContaining({ id: reply.id, text: reply.text })
    );
  });

  it.each([
    'malformed-frame',
    'partial-frame',
  ] as const)('keeps observed child activity partial after a %s collection gap', async (reason) => {
    const f = await fixture();
    await appendWorkObservation(f.db, {
      ...f.owner,
      observation: {
        id: 'observed-child',
        type: 'runtime.observed',
        ts: '2026-09-22T00:00:00.000Z',
        obs: 'worker-shim',
        payload: {
          observationId: 'observed-child',
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
      },
      bodies: [],
    });
    await appendWorkObservation(f.db, {
      ...f.owner,
      observation: {
        id: `gap-${reason}`,
        type: 'runtime.observed',
        ts: '2026-09-22T00:00:01.000Z',
        obs: 'worker-shim',
        payload: {
          observationId: `gap-${reason}`,
          sourceRef: 'source-one',
          sourceSequence: 1,
          observedAt: '2026-09-22T00:00:01.000Z',
          fact: {
            kind: 'coverage',
            runtimeOriginRef: null,
            family: 'child-content',
            coverage: 'unavailable',
            reason,
          },
          content: { state: 'not-applicable' },
        },
      },
      bodies: [],
    });

    expect(
      readThreadRuntimeActivity(f.db, {
        threadId: f.owner.threadId,
        turnIds: [f.owner.turnId],
      })[0]
    ).toMatchObject({
      coverage: 'partial',
      contentCapture: 'on',
      entries: [{ kind: 'child-started', label: 'Child 1 started' }],
    });
  });
});
