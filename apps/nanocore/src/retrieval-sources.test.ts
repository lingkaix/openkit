// openkit-test-platform: posix
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FsStore } from './lib/store.js';
import { closeRetrievalServices, getRetrievalService } from './retrieval-service.js';
import {
  collectProductRetrievalScopes,
  searchProductSources,
  unreadableFileDocument,
} from './retrieval-sources.js';
import { openWorkspaceDb } from './storage/db.js';
import { applyScopedMigrations } from './storage/migrate.js';
import { createWorkspaceMaterial, saveWorkspaceMaterialRevision } from './workspace-materials.js';

const stamp = '2026-10-15T00:00:00.000Z';
const actor = { userId: 'usr_00000000-0000-7000-8000-000000000001', kind: 'local' as const };
const hash = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const testRoots: string[] = [];
afterEach(async () => {
  await closeRetrievalServices();
  for (const root of testRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('canonical product retrieval adapters', () => {
  it('searches past Item, exact Artifact and Material text through real kernel generations without sidecars', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'retrieval-product-'));
    testRoots.push(dataRoot);
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Retrieval');
    const thread = store.createThread(workspace.id, 'Past conversation');
    const turn = store.createTurn(workspace.id, thread.id, 'old conversation marker', {
      kind: 'user',
      id: actor.userId,
    });
    message(store, turn, 'old conversation marker');
    const body = 'Artifact unique marker';
    store.createArtifact({
      id: 'ar_00000000-0000-7472-9b71-dafe5512cf50',
      workspaceId: workspace.id,
      threadId: thread.id,
      turnId: turn.id,
      kind: 'file',
      title: 'Readable JSON',
      status: 'ready',
      summary: null,
      version: 1,
      content: { format: 'json', body },
      contentDigest: hash(body),
      lastMutationRequestId: 'artifact_request',
      origin: {
        kind: 'turn-output',
        threadId: thread.id,
        turnId: turn.id,
        requestId: 'artifact_request',
      },
      createdAt: stamp,
      updatedAt: stamp,
    });
    const db = openWorkspaceDb(dataRoot, workspace.id);
    applyScopedMigrations(db);
    const material = createWorkspaceMaterial(db, {
      actor: { kind: 'user', id: actor.userId },
      acceptedAt: stamp,
      requestId: 'material_create',
      title: 'Material',
      kind: 'text',
      sensitivity: 'internal',
    });
    const materialText = 'Material unique marker';
    saveWorkspaceMaterialRevision(db, {
      actor: { kind: 'user', id: actor.userId },
      acceptedAt: stamp,
      requestId: 'material_save',
      materialId: material.materialId,
      expectedRevisionId: null,
      content: materialText,
      contentDigest: hash(materialText),
    });
    db.sqlite.close();
    const input = {
      store,
      actor,
      workspaceId: workspace.id,
      families: ['conversation', 'artifact', 'material'] as const,
    };
    const scopes = collectProductRetrievalScopes(input);
    const documents = scopes.flatMap(({ view }) => view.documents);
    expect(new Set(documents.map((doc) => doc.key.namespace))).toEqual(
      new Set(['conversation', 'artifact', 'material'])
    );
    expect(documents.every((doc) => doc.content.kind === 'inline-text')).toBe(true);
    const results = await searchProductSources(input, {
      mode: 'lexical',
      query: 'marker',
      limit: 1000,
    });
    expect(results.every((result) => result.complete && result.coverage.enumeration_complete)).toBe(
      true
    );
    expect(
      new Set(results.flatMap((result) => result.hits.map((hit) => hit.key.namespace)))
    ).toEqual(new Set(['conversation', 'artifact', 'material']));
    expect(
      results.flatMap((result) => result.hits).every((hit) => hit.representation === 'text')
    ).toBe(true);
    for (const { ownerRoot, view } of scopes) {
      const directory = join(
        ownerRoot,
        'indexes/retrieval',
        createHash('sha256').update(view.scope).digest('hex')
      );
      const generations = readdirSync(directory).filter((name) => /^[a-f0-9]{64}$/.test(name));
      for (const generation of generations)
        expect(readdirSync(join(directory, generation, 'sidecars'))).toEqual([]);
    }
  });

  it('excludes another private Thread before inventory and source access, and refuses private-to-shared context', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'retrieval-audience-'));
    testRoots.push(dataRoot);
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Audiences');
    const own = store.createThread(workspace.id, 'Own');
    const other = store.createThread(workspace.id, 'Other');
    const shared = store.createThread(workspace.id, 'Shared');
    Object.assign(own, { visibility: 'private', privateOwnerUserId: actor.userId });
    Object.assign(other, { visibility: 'private', privateOwnerUserId: 'other_user' });
    Object.assign(shared, { visibility: 'workspace' });
    delete (shared as unknown as Record<string, unknown>).privateOwnerUserId;
    for (const [thread, text] of [
      [own, 'own private marker'],
      [other, 'other secret marker'],
      [shared, 'shared marker'],
    ] as const) {
      const turn = store.createTurn(workspace.id, thread.id, text, {
        kind: 'user',
        id: actor.userId,
      });
      message(store, turn, text);
    }
    // A shared destination excludes private sources even for an eligible administrator.
    const input = {
      store,
      actor,
      workspaceId: workspace.id,
      outputThreadId: shared.id,
      families: ['conversation'] as const,
    };
    const scopes = collectProductRetrievalScopes(input);
    expect(
      scopes.flatMap(({ view }) => view.documents.map((doc) => doc.metadata?.threadId))
    ).toEqual([shared.id]);
    expect(JSON.stringify(scopes)).not.toContain('other secret');
    const results = await searchProductSources(input, {
      mode: 'exact',
      query: 'marker',
      limit: 20,
    });
    expect(results.flatMap((result) => result.hits).map((hit) => hit.provenance.threadId)).toEqual([
      shared.id,
    ]);
  });

  it('uses the stored verified binary digest for one identity-only sidecar and opens no binary body', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'retrieval-sidecar-'));
    testRoots.push(dataRoot);
    const identity = {
      key: { namespace: 'artifact', id: 'ar_00000000-0000-7361-99da-c4b29ba62194' },
      revision: 'version-1',
      digest: hash('binary-private-body-marker'),
      size: 999999,
      name: 'planning.pdf',
      mediaType: 'application/pdf',
    };
    expect(unreadableFileDocument({ ...identity, digest: null })).toBeNull();
    const document = unreadableFileDocument(identity)!;
    const view = { scope: 'admitted-binary', documents: [document] };
    const service = getRetrievalService(dataRoot, dataRoot);
    await service.publish(view, null);
    const found = await service.search({
      mode: 'exact',
      query: 'planning.pdf',
      scopes: [view],
      limit: 20,
    });
    expect(found).toMatchObject({
      complete: true,
      coverage: { unsupported_bodies: 1 },
      hits: [
        {
          key: identity.key,
          digest: identity.digest.slice(7),
          representation: 'sidecar',
          locator: { kind: 'metadata', field: 'name' },
        },
      ],
    });
    expect(
      (
        await service.search({
          mode: 'exact',
          query: 'binary-private-body-marker',
          scopes: [view],
          limit: 20,
        })
      ).hits
    ).toEqual([]);
  });
});

/** Adds the canonical visible message owned by a Turn; createTurn alone stores no Item. */
function message(store: FsStore, turn: ReturnType<FsStore['createTurn']>, text: string): void {
  store.createItem({
    id: `it_${turn.id}`,
    workspaceId: turn.workspaceId,
    threadId: turn.threadId,
    turnId: turn.id,
    type: 'user-message',
    status: 'completed',
    actor: { kind: 'user', id: actor.userId },
    text,
    createdAt: stamp,
    completedAt: stamp,
  });
}
