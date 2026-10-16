import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureLocalUser } from './auth/identity.js';
import { FsStore } from './lib/store.js';
import { artifactFilePayloadPath } from './storage/artifacts/file-records.js';
import { openCoreDb } from './storage/db.js';
import { LOCAL_USER_ID } from './storage/fs-layout.js';
import { applyMigrations } from './storage/migrate.js';
import { createAppWithWorkspaceAuthority as createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { operationRequest } from './test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

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
