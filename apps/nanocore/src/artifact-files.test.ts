import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ArtifactVersionRecordSchema, allocateEntityId, deriveEntityId } from '@openkit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createArtifactOperationImplementations } from './artifact-operations.js';
import { createArtifactReview, getArtifactReview } from './artifact-reviews.js';
import { FsStore } from './lib/store.js';
import { FileStorageAdmission } from './storage/artifacts/file-admission.js';
import { stageArtifactPayload } from './storage/artifacts/file-payload.js';
import { artifactFilePayloadPath } from './storage/artifacts/file-records.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { createAppWithWorkspaceAuthority as createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import {
  ensureLocalUser,
  FIXTURE_LOCAL_USER_ID as LOCAL_USER_ID,
} from './test-support/local-user.js';
import { operationRequest } from './test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

/** Frozen exact-byte expectations prepared independently before production implementation. */
const corpus = JSON.parse(
  readFileSync(new URL('../../../tests/fixtures/large-context/cases.json', import.meta.url), 'utf8')
) as {
  originals: Array<{
    id: string;
    patternHex: string;
    repeats: number;
    size: number;
    sha256: string;
  }>;
};
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.mocked(open).mockClear();
});

/** Uses real canonical files, Workspace receipts, local authority, and the composed App routes. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'artifact-files-'));
  cleanups.push(() => rmSync(dataRoot, { recursive: true, force: true }));
  const coreDb = openCoreDb(dataRoot);
  cleanups.push(() => coreDb.sqlite.close());
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = createDemoStore({ dataRoot });
  const workspace = store.listWorkspaces()[0]!;
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: LOCAL_USER_ID, workspaceId: workspace.id });
  return { dataRoot, coreDb, store, workspace, app: createApp({ coreDb, dataRoot, store }) };
}

/** Sends actual binary request bytes; file metadata remains separate from the body. */
function upload(
  state: ReturnType<typeof fixture>,
  original: (typeof corpus.originals)[number],
  options: {
    requestId?: string;
    body?: Uint8Array;
    byteLength?: number;
    contentDigest?: string;
  } = {}
) {
  const query = new URLSearchParams({
    workspaceId: state.workspace.id,
    title: original.id,
    mediaType: 'application/octet-stream',
    byteLength: String(options.byteLength ?? original.size),
    contentDigest: options.contentDigest ?? original.sha256,
  });
  return state.app.request(`/api/app/operations/artifact.import?${query}`, {
    method: 'POST',
    headers: {
      'x-openkit-request-id': options.requestId ?? randomUUID(),
      'content-type': 'application/octet-stream',
    },
    body: options.body ?? Buffer.from(original.patternHex.repeat(original.repeats), 'hex'),
  });
}

/** Requests the exact immutable version through the public streaming binding. */
function download(state: ReturnType<typeof fixture>, artifactId: string, artifactVersion = 1) {
  const query = new URLSearchParams({
    workspaceId: state.workspace.id,
    artifactId,
    artifactVersion: String(artifactVersion),
  });
  return state.app.request(`/api/app/operations/artifact.download?${query}`);
}

describe('exact Artifact file import and download', () => {
  it('publishes binary v2 through the composed stream route and retains both exact originals after reopen', async () => {
    const state = fixture();
    const original = corpus.originals.find(({ id }) => id === 'binary-invalid-utf8')!;
    const firstBytes = Buffer.from(original.patternHex.repeat(original.repeats), 'hex');
    const imported = await upload(state, original);
    expect(imported.status, await imported.clone().text()).toBe(201);
    const { artifactId } = (await imported.json()) as { artifactId: string };
    const first = state.store.getArtifact(state.workspace.id, artifactId);
    const thread = state.store.createThread(
      state.workspace.id,
      'Binary version publication',
      undefined,
      'conversation',
      {
        visibility: 'workspace',
      }
    );
    expect(state.store.listThreadTurns(state.workspace.id, thread.id)).toEqual([]);
    const bytes = Buffer.from([255, 0, 128, 10, 13, 0, 195, 40]);
    const contentDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const requestId = randomUUID();
    const actor = { kind: 'user', id: LOCAL_USER_ID } as const;
    const turnId = deriveEntityId('tu', [
      actor,
      state.workspace.id,
      thread.id,
      'artifact.version-file-commit',
      requestId,
    ]);
    const query = new URLSearchParams({
      workspaceId: state.workspace.id,
      artifactId,
      threadId: thread.id,
      expectedArtifactVersion: '1',
      title: 'Revised binary original',
      summary: JSON.stringify(null),
      mediaType: 'application/octet-stream',
      byteLength: String(bytes.length),
      contentDigest,
    });
    const response = await state.app.request(
      `/api/app/operations/artifact.version-file-commit?${query}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-openkit-request-id': requestId },
        body: bytes,
      }
    );
    expect(response.status, await response.clone().text()).toBe(201);
    const committed = ArtifactVersionRecordSchema.parse(await response.json());
    expect(committed.artifact).toMatchObject({
      id: artifactId,
      version: 2,
      threadId: null,
      turnId: null,
      summary: null,
      origin: first.origin,
      contentDigest,
      content: { format: 'file', mediaType: 'application/octet-stream', byteLength: bytes.length },
    });
    expect(committed.version).toMatchObject({
      artifactId,
      artifactVersion: 2,
      parentVersion: 1,
      actor,
      threadId: thread.id,
      turnId,
      contentDigest,
      requestId,
      recordedAt: committed.artifact.updatedAt,
    });
    const reopened = new FsStore({ dataRoot: state.dataRoot });
    expect(reopened.getArtifact(state.workspace.id, artifactId)).toEqual(committed.artifact);
    expect(reopened.getArtifactVersion(state.workspace.id, artifactId, 1).artifact).toEqual(first);
    expect(reopened.getArtifactVersion(state.workspace.id, artifactId, 2)).toEqual(committed);
    const publication = reopened.getTurn(state.workspace.id, thread.id, turnId);
    expect(publication).toMatchObject({ status: 'completed', triggerActor: actor });
    expect(publication.agentId ?? null).toBeNull();
    expect(publication.agentSessionId ?? null).toBeNull();
    expect(publication.items).toContainEqual(
      expect.objectContaining({
        id: deriveEntityId('it', [artifactId, turnId]),
        type: 'artifact-reference',
        artifactId,
        artifactVersion: 2,
        lastMutationRequestId: requestId,
        title: 'Revised binary original',
        summary: null,
      })
    );
    expect(committed.artifact.origin).toMatchObject({
      kind: 'imported',
      sourceDigest: original.sha256,
    });
    state.store = reopened;
    state.app = createApp({ coreDb: state.coreDb, dataRoot: state.dataRoot, store: reopened });
    for (const exact of [
      { version: 1, bytes: firstBytes, digest: original.sha256 },
      { version: 2, bytes, digest: contentDigest },
    ]) {
      const downloaded = await download(state, artifactId, exact.version);
      expect(downloaded.status, await downloaded.clone().text()).toBe(200);
      expect(downloaded.headers.get('content-length')).toBe(String(exact.bytes.length));
      expect(downloaded.headers.get('x-openkit-content-digest')).toBe(exact.digest);
      const retained = Buffer.from(await downloaded.arrayBuffer());
      expect(retained).toEqual(exact.bytes);
      expect(`sha256:${createHash('sha256').update(retained).digest('hex')}`).toBe(exact.digest);
    }
  });

  it('closes the original file when the public archive response is cancelled', async () => {
    const state = fixture();
    // Incompressible bytes keep the actual source reader under backpressure at cancellation.
    const bytes = randomBytes(2 * 1024 * 1024);
    const uploaded = await upload(
      state,
      {
        id: 'cancelled-archive-original',
        patternHex: '',
        repeats: 0,
        size: bytes.length,
        sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      },
      { body: bytes }
    );
    expect(uploaded.status).toBe(201);
    const { artifactId } = await uploaded.json();
    const exported = await state.app.request(
      ...operationRequest('workspace.export', { workspaceId: state.workspace.id })
    );
    expect(exported.status).toBe(200);
    const { exportId } = await exported.json();
    const originalPath = artifactFilePayloadPath(
      join(state.dataRoot, 'server', 'exports', 'workspaces', state.workspace.id, exportId),
      artifactId,
      1
    );
    const response = await state.app.request(
      `/api/app/workspaces/${state.workspace.id}/exports/${exportId}/archive`
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await reader.read();
    const opened = vi.mocked(open);
    await expect
      .poll(() => opened.mock.calls.findIndex(([path]) => path === originalPath))
      .toBeGreaterThanOrEqual(0);
    const index = opened.mock.calls.findIndex(([path]) => path === originalPath);
    // Hold the real handle so garbage collection cannot conceal a leaked source lifetime.
    const file = await opened.mock.results[index]!.value;
    const descriptor = file.fd;
    const original = fstatSync(descriptor);
    try {
      await reader.cancel();
      await expect
        .poll(() => {
          try {
            const current = fstatSync(descriptor);
            return current.ino === original.ino && current.dev === original.dev;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EBADF') return false;
            throw error;
          }
        })
        .toBe(false);
    } finally {
      await reader.cancel().catch(() => undefined);
      // The producer normally closes it; preserve cleanup on an assertion failure.
      void file.close().catch(() => undefined);
    }
  });

  it('preserves exact originals through public Workspace archive transfer', async () => {
    const source = fixture();
    const originals = corpus.originals.filter(
      ({ id }) => id === 'empty' || id === 'binary-invalid-utf8'
    );
    expect(originals).toHaveLength(2);
    for (const original of originals) expect((await upload(source, original)).status).toBe(201);
    const exported = await source.app.request(
      ...operationRequest('workspace.export', { workspaceId: source.workspace.id })
    );
    expect(exported.status).toBe(200);
    const { exportId } = await exported.json();
    const archive = await source.app.request(
      `/api/app/workspaces/${source.workspace.id}/exports/${exportId}/archive`
    );
    expect(archive.status).toBe(200);
    const imported = await source.app.request('/api/app/workspace-archives/import', {
      method: 'POST',
      headers: {
        'content-type': 'application/vnd.openkit.workspace-export+tar.zstd',
        'x-openkit-request-id': randomUUID(),
      },
      body: await archive.arrayBuffer(),
    });
    expect(imported.status).toBe(200);
    const { importedWorkspaceId } = await imported.json();
    const retained = source.store.listArtifacts(importedWorkspaceId);
    for (const original of originals) {
      const artifact = retained.find(({ contentDigest }) => contentDigest === original.sha256);
      expect(artifact).toBeDefined();
      const response = await source.app.request(
        `/api/app/operations/artifact.download?${new URLSearchParams({
          workspaceId: importedWorkspaceId,
          artifactId: artifact!.id,
          artifactVersion: String(artifact!.version),
        })}`
      );
      expect(response.status).toBe(200);
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes).toEqual(Buffer.from(original.patternHex.repeat(original.repeats), 'hex'));
      expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(original.sha256);
    }
  });

  it.each([
    'binary-file',
    'text-file',
    'retained-bytes',
    'retained-lines',
  ] as const)('refuses %s before effects when a reviewed original has no exact Worker delivery', async (kind) => {
    const decision = kind === 'binary-file' ? 'needs_refinement' : 'redo';
    const state = fixture();
    const { coreDb, dataRoot, workspace } = state;
    // This domain fixture owns its roster directly; App catalog projection is tested separately.
    const store = new FsStore({ dataRoot });
    const agentId = 'review-file-agent';
    store.upsertAgent(workspace.id, {
      id: agentId,
      name: 'Review file agent',
      kind: 'coder',
      status: 'enabled',
      modelId: null,
      skillIds: [],
      profiles: [],
      defaultProfileId: null,
      capabilities: [],
      sandboxSummary: null,
      health: { status: 'ready', message: null, checkedAt: new Date().toISOString() },
    });
    const thread = store.createThread(workspace.id, 'File Review', undefined, 'conversation', {
      visibility: 'private',
      privateOwnerUserId: LOCAL_USER_ID,
    });
    const turn = store.createTurn(workspace.id, thread.id, 'Produce original', {
      kind: 'user',
      id: LOCAL_USER_ID,
    });
    store.updateTurn(turn.id, { agentId });
    const bytes =
      kind === 'retained-lines'
        ? Buffer.from(`${'line\n'.repeat(50)}end`)
        : kind === 'binary-file'
          ? Buffer.from([0, 255, 128])
          : Buffer.alloc(2049, 120);
    const admission = new FileStorageAdmission(dataRoot, () => 0n);
    const reservation = admission.reserve({
      stagingBytes: BigInt(bytes.length),
      extractionBytes: 0n,
      derivativeBytes: 0n,
      publicationBytes: 65_536n,
    });
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const staged = kind.startsWith('retained')
      ? undefined
      : await stageArtifactPayload({
          workspaceRoot: join(dataRoot, 'workspaces', workspace.id),
          source: Readable.from([bytes]),
          expectedByteLength: bytes.length,
          expectedDigest: digest,
          reservation,
        });
    const artifactId = allocateEntityId('ar');
    const recordedAt = new Date().toISOString();
    try {
      store.createArtifact(
        {
          id: artifactId,
          workspaceId: workspace.id,
          threadId: thread.id,
          turnId: turn.id,
          kind: 'file',
          title: 'Reviewed exact original',
          status: 'ready',
          summary: null,
          version: 1,
          content: kind.startsWith('retained')
            ? { format: 'text', body: bytes.toString('utf8') }
            : {
                format: 'file',
                mediaType: decision === 'redo' ? 'text/plain' : 'application/octet-stream',
                byteLength: bytes.length,
              },
          contentDigest: digest,
          lastMutationRequestId: 'produce-review-file',
          origin: {
            kind: 'turn-output',
            requestId: 'produce-review-file',
            threadId: thread.id,
            turnId: turn.id,
          },
          createdAt: recordedAt,
          updatedAt: recordedAt,
        },
        staged
      );
    } finally {
      await staged?.remove();
      reservation.release();
    }
    store.updateTurn(turn.id, { status: 'completed', completedAt: recordedAt });
    const db = openWorkspaceDb(dataRoot, workspace.id);
    applyScopedMigrations(db);
    try {
      createArtifactReview(db, {
        artifactId,
        artifactVersion: 1,
        contentDigest: digest,
        sourceThreadId: thread.id,
        sourceTurnId: turn.id,
        sourceAgentId: agentId,
        materialProposal: null,
        createdAt: recordedAt,
      });
      const startModeWorkerTurn = vi.fn(async () => {
        throw new Error('A Worker must not start without its reviewed original.');
      });
      const handlers = createArtifactOperationImplementations({
        store,
        coreDb,
        inflightCommands: new WeakMap(),
        repositoryWorkspaceDb: () => openWorkspaceDb(dataRoot, workspace.id),
        startModeWorkerTurn,
      });
      const beforeReceipts = store.listCommandRequests();
      const requestId = randomUUID();
      await expect(
        handlers['artifact.review.decide'](
          {
            workspaceId: workspace.id,
            artifactId,
            artifactVersion: 1,
            decision,
            feedback: 'Use the original file.',
            requestId,
          },
          {
            kind: 'public',
            actor: { kind: 'local', userId: LOCAL_USER_ID },
            actorRef: { kind: 'user', id: LOCAL_USER_ID },
            scope: { kind: 'workspace', workspaceId: workspace.id },
            delivery: 'human',
          }
        )
      ).rejects.toMatchObject({ code: 'artifact_input_unavailable', status: 503 });
      expect(startModeWorkerTurn).not.toHaveBeenCalled();
      expect(getArtifactReview(db, artifactId, 1).decision).toBeNull();
      expect(
        store.listThreadTurns(workspace.id, thread.id).map((candidate) => candidate.id)
      ).toEqual([turn.id]);
      expect(store.listCommandRequests()).toEqual(beforeReceipts);
      expect(
        db.sqlite.prepare('SELECT COUNT(*) AS count FROM worker_turn_checkpoints').get()
      ).toEqual({ count: 0 });
      expect(
        coreDb.sqlite.prepare('SELECT COUNT(*) AS count FROM scheduler_admission_entries').get()
      ).toEqual({ count: 0 });
    } finally {
      db.sqlite.close();
    }
  });

  it('preserves exact binary originals through two authorized Workspace export and import cycles', async () => {
    const state = fixture();
    const original = corpus.originals.find((entry) => entry.id === 'binary-invalid-utf8')!;
    const acceptedResponse = await upload(state, original);
    expect(acceptedResponse.status).toBe(201);
    const accepted = (await acceptedResponse.json()) as { artifactId: string };
    let workspaceId = state.workspace.id;
    let previousArtifactId = accepted.artifactId;
    for (let cycle = 0; cycle < 2; cycle++) {
      const exported = await state.app.request(
        ...operationRequest('workspace.export', { workspaceId })
      );
      expect(exported.status, await exported.clone().text()).toBe(200);
      const { exportId } = await exported.json();
      const imported = await state.app.request(
        ...operationRequest(
          'workspace.import',
          {},
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sourceWorkspaceId: workspaceId,
              exportId,
              requestId: randomUUID(),
            }),
          }
        )
      );
      expect(imported.status, await imported.clone().text()).toBe(200);
      const { importedWorkspaceId } = await imported.json();
      const artifact = state.store
        .listArtifacts(importedWorkspaceId)
        .find((candidate) => candidate.contentDigest === original.sha256)!;
      expect(artifact.id).not.toBe(previousArtifactId);
      expect(artifact.workspaceId).toBe(importedWorkspaceId);
      expect(artifact.content).toEqual({
        format: 'file',
        mediaType: 'application/octet-stream',
        byteLength: original.size,
      });
      const downloaded = await state.app.request(
        `/api/app/operations/artifact.download?${new URLSearchParams({ workspaceId: importedWorkspaceId, artifactId: artifact.id, artifactVersion: '1' })}`
      );
      expect(downloaded.status).toBe(200);
      expect(downloaded.headers.get('x-openkit-content-digest')).toBe(original.sha256);
      expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(
        Buffer.from(original.patternHex, 'hex')
      );
      const restarted = new FsStore({ dataRoot: state.dataRoot });
      expect(restarted.getArtifact(importedWorkspaceId, artifact.id)).toEqual(artifact);
      workspaceId = importedWorkspaceId;
      previousArtifactId = artifact.id;
    }
  });

  it('downloads an original when retained title text contains an unpaired surrogate', async () => {
    const state = fixture(),
      original = corpus.originals[0]!;
    const imported = await upload(state, original);
    expect(imported.status).toBe(201);
    const accepted = (await imported.json()) as { artifactId: string };
    const metadataPath = join(
      state.dataRoot,
      'workspaces',
      state.workspace.id,
      'artifacts',
      accepted.artifactId,
      'artifact.json'
    );
    const retained = JSON.parse(readFileSync(metadataPath, 'utf8'));
    retained.title = 'File\ud800 title';
    writeFileSync(metadataPath, JSON.stringify(retained));
    state.store = new FsStore({ dataRoot: state.dataRoot });
    expect(state.store.getArtifact(state.workspace.id, accepted.artifactId).title).toContain(
      '\ud800'
    );
    state.app = createApp({ coreDb: state.coreDb, dataRoot: state.dataRoot, store: state.store });
    const response = await download(state, accepted.artifactId);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('%EF%BF%BD');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      Buffer.from(original.patternHex.repeat(original.repeats), 'hex')
    );
  });
  it('refuses a corrupt exact version with a recovery result instead of returning substituted bytes', async () => {
    const state = fixture(),
      original = corpus.originals.find((candidate) => candidate.size > 0)!;
    const imported = await upload(state, original);
    expect(imported.status).toBe(201);
    const accepted = (await imported.json()) as { artifactId: string };
    const payloadPath = artifactFilePayloadPath(
      join(state.dataRoot, 'workspaces', state.workspace.id),
      accepted.artifactId,
      1
    );
    const changed = readFileSync(payloadPath);
    changed[0] = changed[0]! ^ 255;
    writeFileSync(payloadPath, changed);
    const response = await download(state, accepted.artifactId);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'recovery_required' });
  });
  it.each(
    corpus.originals
  )('round-trips the frozen $id original and retains metadata without a body', async (original) => {
    const state = fixture();
    const imported = await upload(state, original);
    expect(imported.status).toBe(201);
    const accepted = (await imported.json()) as { artifactId: string; artifactVersion: number };
    const artifact = state.store.getArtifact(state.workspace.id, accepted.artifactId);
    expect(artifact.content).toEqual({
      format: 'file',
      mediaType: 'application/octet-stream',
      byteLength: original.size,
    });
    expect(artifact.contentDigest).toBe(original.sha256);
    expect(artifact.origin).toMatchObject({ kind: 'imported', sourceDigest: original.sha256 });
    const response = await download(state, accepted.artifactId);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe(String(original.size));
    expect(response.headers.get('x-openkit-content-digest')).toBe(original.sha256);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      Buffer.from(original.patternHex.repeat(original.repeats), 'hex')
    );
    const restarted = new FsStore({ dataRoot: state.dataRoot });
    expect(restarted.getArtifact(state.workspace.id, accepted.artifactId)).toEqual(artifact);
  });

  it('replays an accepted request without recapturing changed retry bytes', async () => {
    const state = fixture();
    const original = corpus.originals.find((entry) => entry.id === 'binary-invalid-utf8')!;
    const requestId = randomUUID();
    const first = await upload(state, original, { requestId });
    const accepted = (await first.json()) as { artifactId: string };
    const retry = await upload(state, original, { requestId, body: Buffer.alloc(original.size) });
    expect(retry.status).toBe(201);
    expect(await retry.json()).toEqual(accepted);
    const response = await download(state, accepted.artifactId);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      Buffer.from(original.patternHex, 'hex')
    );
    const conflict = await upload(state, original, {
      requestId,
      contentDigest: `sha256:${'0'.repeat(64)}`,
    });
    expect(conflict.status).toBe(409);
  });

  it('refuses a bad digest without publishing an Artifact', async () => {
    const state = fixture();
    const before = state.store.listArtifacts(state.workspace.id).map((artifact) => artifact.id);
    const original = corpus.originals.find((entry) => entry.id === 'binary-invalid-utf8')!;
    const response = await upload(state, original, { contentDigest: `sha256:${'0'.repeat(64)}` });
    expect(response.status).toBe(400);
    expect(state.store.listArtifacts(state.workspace.id).map((artifact) => artifact.id)).toEqual(
      before
    );
  });

  it('refuses a file that exceeds declared size or the one-billion-byte limit', async () => {
    const state = fixture();
    const original = corpus.originals.find((entry) => entry.id === 'binary-invalid-utf8')!;
    expect((await upload(state, original, { byteLength: 1 })).status).toBe(400);
    expect((await upload(state, original, { byteLength: 1_000_000_001 })).status).toBe(413);
  });

  it('does not substitute the latest file for a missing immutable version', async () => {
    const state = fixture();
    const response = await upload(state, corpus.originals[0]!);
    const accepted = (await response.json()) as { artifactId: string };
    expect((await download(state, accepted.artifactId, 2)).status).toBe(404);
  });
});
