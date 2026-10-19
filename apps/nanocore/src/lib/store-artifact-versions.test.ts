import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadArtifactVersionResponseSchema } from '@openkit/app-api-schemas';
import { afterEach, describe, expect, it } from 'vitest';
import {
  artifactVersionRecordPath,
  readArtifactVersionRecord,
} from '../storage/artifacts/artifact-version-records.js';
import { testEntityId } from '../test-support/entity-ids.js';
import { FsStore } from './store.js';

const actor = { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' } as const;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Computes identity directly from the exact original UTF-8 bytes. */
function digest(body: string): string {
  return `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
}

/** Creates real retained authority without a Worker, scheduler or generated source. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'artifact-versions-'));
  roots.push(dataRoot);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Artifact versions');
  const thread = store.createThread(workspace.id, 'Producing work');
  const turn = store.createTurn(workspace.id, thread.id, 'Revise imported output', actor);
  store.updateTurn(turn.id, { status: 'completed', completedAt: new Date().toISOString() });
  const body = '\uFEFFfirst\r\noriginal\n';
  const recordedAt = '2026-10-17T00:00:00.000Z';
  const artifact = store.createArtifact({
    id: testEntityId('ar', 'artifact-version-history'),
    workspaceId: workspace.id,
    threadId: null,
    turnId: null,
    kind: 'file',
    title: 'Original output',
    status: 'ready',
    summary: null,
    version: 1,
    content: { format: 'text', body },
    contentDigest: digest(body),
    lastMutationRequestId: 'import-original',
    origin: {
      kind: 'imported',
      sourceKind: 'direct-import',
      sourceId: 'import-original',
      sourceDigest: digest(body),
      actor,
      requestId: 'import-original',
      recordedAt,
    },
    createdAt: recordedAt,
    updatedAt: recordedAt,
  });
  return { dataRoot, store, workspace, thread, turn, artifact };
}

describe('Artifact immutable version authority', () => {
  it('reloads exact selected immutable content when the disposable current body is absent', () => {
    const state = fixture();
    const artifactRoot = join(
      state.dataRoot,
      'workspaces',
      state.workspace.id,
      'artifacts',
      state.artifact.id
    );
    rmSync(join(artifactRoot, 'files'), { recursive: true });
    const reopened = new FsStore({ dataRoot: state.dataRoot });
    expect(reopened.getArtifact(state.workspace.id, state.artifact.id)).toEqual(state.artifact);
  });

  it('refuses a contradictory selected descriptor instead of substituting its current body', () => {
    const state = fixture();
    const artifactRoot = join(
      state.dataRoot,
      'workspaces',
      state.workspace.id,
      'artifacts',
      state.artifact.id
    );
    const path = join(artifactRoot, 'artifact.json');
    const metadata = JSON.parse(readFileSync(path, 'utf8'));
    metadata.title = 'Contradictory projection';
    writeFileSync(path, JSON.stringify(metadata));
    expect(() => new FsStore({ dataRoot: state.dataRoot })).toThrow(/contradictory/i);
  });

  it('validates actual staged import history before publication and fills the immediate cache', () => {
    const source = fixture();
    source.store.commitArtifactVersion({
      workspaceId: source.workspace.id,
      artifactId: source.artifact.id,
      threadId: source.thread.id,
      expectedArtifactVersion: 1,
      actor,
      requestId: 'import-version-two',
      recordedAt: '2026-10-17T00:02:00.000Z',
      title: 'Imported second',
      summary: null,
      content: { format: 'text', body: 'Second exact original\r\n' },
    });
    const sourceRoot = join(source.dataRoot, 'workspaces', source.workspace.id);
    const createImport = (corrupt: boolean) => {
      const dataRoot = mkdtempSync(join(tmpdir(), 'artifact-versions-import-'));
      roots.push(dataRoot);
      const target = new FsStore({ dataRoot });
      const input = {
        workspace: source.store.getWorkspace(source.workspace.id),
        threads: source.store.listThreads(source.workspace.id),
        turns: source.store.listThreadTurns(source.workspace.id, source.thread.id),
        knowledge: [],
        itemRevisions: source.store.listWorkspaceItemRevisions(source.workspace.id),
        artifacts: source.store.listArtifacts(source.workspace.id),
        agentSessions: [],
        turnEvents: [],
        notebookInitialization: {
          requestId: '00000000-0000-7000-8000-000000000003',
          producer: actor,
          instructionReference: 'Import exact history.',
        },
        stageWorkspace: ({ workspaceRoot }: { workspaceRoot: string }) => {
          cpSync(join(sourceRoot, 'artifacts'), join(workspaceRoot, 'artifacts'), {
            recursive: true,
          });
          if (corrupt) {
            writeFileSync(
              join(workspaceRoot, 'artifacts', source.artifact.id, 'versions', '1', 'payload'),
              'Corrupt historical bytes while the selected head remains valid.'
            );
          }
        },
      };
      return { dataRoot, target, input };
    };
    const refused = createImport(true);
    expect(() => refused.target.importWorkspaceSnapshot(refused.input)).toThrow(
      expect.objectContaining({ code: 'recovery_required' })
    );
    expect(existsSync(join(refused.dataRoot, 'workspaces', source.workspace.id))).toBe(false);
    const accepted = createImport(false);
    accepted.target.importWorkspaceSnapshot(accepted.input);
    expect(
      accepted.target.listArtifactVersions(source.workspace.id, source.artifact.id)
    ).toHaveLength(2);
    expect(
      accepted.target.getArtifactVersion(source.workspace.id, source.artifact.id, 1).artifact
    ).toEqual(source.artifact);
    expect(
      new FsStore({ dataRoot: accepted.dataRoot }).listArtifactVersions(
        source.workspace.id,
        source.artifact.id
      )
    ).toHaveLength(2);
  });

  it('rejects absent, unknown and legacy physical retained markers without a fallback reader', () => {
    const state = fixture();
    const root = join(state.dataRoot, 'workspaces', state.workspace.id);
    const path = artifactVersionRecordPath(root, state.artifact.id, 1);
    const record = JSON.parse(readFileSync(path, 'utf8'));
    expect.soft(record.schemaVersion).toBe(1);
    expect.soft(record).not.toHaveProperty('formatVersion');
    record.schemaVersion = 2;
    writeFileSync(path, JSON.stringify(record));
    expect
      .soft(() => readArtifactVersionRecord(root, state.artifact.id, 1))
      .toThrow(/unsupported.*format|format.*unsupported/i);
    delete record.schemaVersion;
    delete record.formatVersion;
    writeFileSync(path, JSON.stringify(record));
    expect(() => readArtifactVersionRecord(root, state.artifact.id, 1)).toThrow(
      /unsupported.*format|format.*unsupported/i
    );
    record.formatVersion = 1;
    writeFileSync(path, JSON.stringify(record));
    expect
      .soft(() => readArtifactVersionRecord(root, state.artifact.id, 1))
      .toThrow(/unsupported.*format|format.*unsupported/i);
  });

  it('stores snapshot facts once and preserves distinct version producers after restart', () => {
    const state = fixture();
    const laterActor = {
      kind: 'user' as const,
      id: 'usr_00000000-0000-7000-8000-000000000002',
    };
    const committed = state.store.commitArtifactVersion({
      workspaceId: state.workspace.id,
      artifactId: state.artifact.id,
      threadId: state.thread.id,
      expectedArtifactVersion: 1,
      actor: laterActor,
      requestId: 'distinct-producer-revision',
      recordedAt: '2026-10-17T00:03:00.000Z',
      title: 'Later producer output',
      summary: 'Produced by another user.',
      content: { format: 'text', body: '\uFEFFsecond\r\noriginal\n' },
    });
    const root = join(state.dataRoot, 'workspaces', state.workspace.id);
    for (const version of [1, 2]) {
      const path = artifactVersionRecordPath(root, state.artifact.id, version);
      const retained = JSON.parse(readFileSync(path, 'utf8'));
      expect.soft(retained.schemaVersion).toBe(1);
      expect.soft(retained).not.toHaveProperty('formatVersion');
      for (const field of ['parentVersion', 'requestId', 'recordedAt'])
        expect.soft(retained.version).not.toHaveProperty(field);
      expect(retained.artifact.content).toEqual({ format: 'text' });
      expect(readFileSync(join(path, '..', 'payload'))).toEqual(
        Buffer.from(version === 1 ? '\uFEFFfirst\r\noriginal\n' : '\uFEFFsecond\r\noriginal\n')
      );
    }
    const reopened = new FsStore({ dataRoot: state.dataRoot });
    const original = reopened.getArtifactVersion(state.workspace.id, state.artifact.id, 1);
    const revised = reopened.getArtifactVersion(state.workspace.id, state.artifact.id, 2);
    expect(original.artifact).toEqual(state.artifact);
    expect(original.version).toMatchObject({
      actor,
      threadId: null,
      turnId: null,
      artifactVersion: 1,
      parentVersion: null,
      requestId: 'import-original',
      recordedAt: '2026-10-17T00:00:00.000Z',
    });
    expect(revised).toEqual(committed);
    expect(revised.artifact.origin).toEqual(state.artifact.origin);
    expect(revised.artifact.threadId).toBeNull();
    expect(revised.artifact.turnId).toBeNull();
    expect(revised.version).toMatchObject({
      actor: laterActor,
      threadId: state.thread.id,
      turnId: expect.any(String),
      artifactVersion: 2,
      parentVersion: 1,
      requestId: 'distinct-producer-revision',
      recordedAt: '2026-10-17T00:03:00.000Z',
    });
    expect(ReadArtifactVersionResponseSchema.parse(revised)).toEqual(revised);
    expect(reopened.listArtifactVersions(state.workspace.id, state.artifact.id)).toEqual([
      original.version,
      revised.version,
    ]);
  });
  it('fails closed for absent real version history and never bootstraps it from a head projection', () => {
    const state = fixture();
    const path = artifactVersionRecordPath(
      join(state.dataRoot, 'workspaces', state.workspace.id),
      state.artifact.id,
      1
    );
    rmSync(path);
    expect(() => new FsStore({ dataRoot: state.dataRoot })).toThrow(
      expect.objectContaining({ code: 'recovery_required' })
    );
    expect(() => state.store.getArtifactVersion(state.workspace.id, state.artifact.id, 1)).toThrow(
      expect.objectContaining({ code: 'recovery_required' })
    );
  });

  it('tolerates descriptive version metadata without rewriting immutable bytes', () => {
    const state = fixture();
    const path = artifactVersionRecordPath(
      join(state.dataRoot, 'workspaces', state.workspace.id),
      state.artifact.id,
      1
    );
    const original = JSON.parse(readFileSync(path, 'utf8'));
    original.annotation = { retained: true };
    original.version.actor.annotation = 'historical label';
    original.artifact.origin.actor.annotation = 'import attribution';
    const bytes = JSON.stringify(original);
    writeFileSync(path, bytes);
    const reopened = new FsStore({ dataRoot: state.dataRoot });
    expect(reopened.getArtifactVersion(state.workspace.id, state.artifact.id, 1).artifact).toEqual(
      state.artifact
    );
    expect(readFileSync(path, 'utf8')).toBe(bytes);
  });
  it('advances once with exact parent and Item proof, preserves v1 bytes, and rejects stale CAS', () => {
    const state = fixture();
    const input = {
      workspaceId: state.workspace.id,
      artifactId: state.artifact.id,
      threadId: state.thread.id,
      expectedArtifactVersion: 1,
      actor,
      requestId: 'commit-next-version',
      recordedAt: '2026-10-17T00:01:00.000Z',
      title: 'Revised output',
      summary: 'One complete revision.',
      content: { format: 'text' as const, body: 'second\noriginal\r\n' },
    };

    const result = state.store.commitArtifactVersion(input);
    expect(result.artifact).toMatchObject({
      version: 2,
      title: input.title,
      content: input.content,
      contentDigest: digest(input.content.body),
      origin: state.artifact.origin,
      threadId: null,
      turnId: null,
      lastMutationRequestId: input.requestId,
    });
    expect(result.version).toMatchObject({
      artifactVersion: 2,
      parentVersion: 1,
      actor,
      threadId: state.thread.id,
      turnId: expect.any(String),
      requestId: input.requestId,
      recordedAt: input.recordedAt,
    });
    expect(
      state.store.getTurn(state.workspace.id, state.thread.id, result.version.turnId!).items
    ).toContainEqual(
      expect.objectContaining({
        type: 'artifact-reference',
        artifactId: state.artifact.id,
        artifactVersion: 2,
        lastMutationRequestId: input.requestId,
      })
    );
    expect(() =>
      state.store.commitArtifactVersion({ ...input, requestId: 'stale-writer' })
    ).toThrow(expect.objectContaining({ code: 'conflict' }));

    const reopened = new FsStore({ dataRoot: state.dataRoot });
    const original = reopened.getArtifactVersion(state.workspace.id, state.artifact.id, 1);
    expect(original.artifact).toEqual(state.artifact);
    expect(
      Buffer.from(original.artifact.content.format === 'file' ? '' : original.artifact.content.body)
    ).toEqual(Buffer.from('\uFEFFfirst\r\noriginal\n'));
    expect(original.version).toMatchObject({ artifactVersion: 1, parentVersion: null });
    expect(reopened.getArtifactVersion(state.workspace.id, state.artifact.id, 2)).toEqual(result);
    expect(
      reopened
        .listArtifactVersions(state.workspace.id, state.artifact.id)
        .map((version) => version.artifactVersion)
    ).toEqual([1, 2]);
    expect(() => reopened.getArtifactVersion(state.workspace.id, state.artifact.id, 3)).toThrow(
      /not found/i
    );
    const path = artifactVersionRecordPath(
      join(state.dataRoot, 'workspaces', state.workspace.id),
      state.artifact.id,
      2
    );
    const corrupted = JSON.parse(readFileSync(path, 'utf8'));
    expect(Object.keys(corrupted.version).sort()).toEqual(['actor', 'threadId', 'turnId']);
    expect(ReadArtifactVersionResponseSchema.parse(result)).toEqual(result);
    expect(
      ReadArtifactVersionResponseSchema.safeParse({
        ...result,
        version: { ...result.version, title: 'Contradictory public summary' },
      }).success
    ).toBe(false);
    expect(corrupted.artifact.content).toEqual({ format: 'text' });
    expect(readFileSync(join(path, '..', 'payload'))).toEqual(Buffer.from(input.content.body));
    expect(reopened.listArtifactVersions(state.workspace.id, state.artifact.id)).toEqual([
      { ...original.version },
      {
        artifactId: state.artifact.id,
        workspaceId: state.workspace.id,
        artifactVersion: 2,
        parentVersion: 1,
        title: input.title,
        summary: input.summary,
        contentDigest: digest(input.content.body),
        actor,
        threadId: state.thread.id,
        turnId: result.version.turnId,
        requestId: input.requestId,
        recordedAt: input.recordedAt,
      },
    ]);
    corrupted.version.turnId = state.turn.id;
    writeFileSync(path, JSON.stringify(corrupted));
    expect(() => new FsStore({ dataRoot: state.dataRoot })).toThrow(
      expect.objectContaining({ code: 'recovery_required' })
    );
  });
});
