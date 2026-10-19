import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WorkspaceExportResponseSchema,
  WorkspaceImportResponseSchema,
} from '@openkit/app-api-schemas';
import { allocateEntityId } from '@openkit/protocol';
import { expect, it, onTestFinished } from 'vitest';
import { FsStore } from '../lib/store.js';
import { createAppWithWorkspaceAuthority } from '../test-support/app.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { openCoreDb } from './db.js';
import { applyMigrations } from './migrate.js';
import { verifyWorkspaceExportTree } from './workspace-export.js';
import { readWorkspaceImportSnapshot } from './workspace-import.js';
import { existingWorkspaceExportRoot } from './workspace-transfer-routes.js';

/** Hashes the expected original bytes independently of upload and export readers. */
function digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

it('preserves exact historical bytes, parents and publication lineage through Workspace import and reopen', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'artifact-version-portability-'));
  const coreDb = openCoreDb(dataRoot);
  onTestFinished(() => {
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const actor = { kind: 'user', id: FIXTURE_LOCAL_USER_ID } as const;
  const workspace = store.createWorkspace('Historical output', {
    requestId: randomUUID(),
    producer: actor,
    instructionReference: 'test:artifact-version-portability',
  });
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: actor.id, workspaceId: workspace.id });
  const thread = store.createThread(workspace.id, 'Publish revisions');
  const app = createAppWithWorkspaceAuthority({ coreDb, dataRoot, store });
  const original = Buffer.from([0, 255, 128, 13, 10]);
  const query = new URLSearchParams({
    workspaceId: workspace.id,
    title: 'Historical original',
    mediaType: 'application/octet-stream',
    byteLength: String(original.length),
    contentDigest: digest(original),
  });
  const uploaded = await app.request(`/api/app/operations/artifact.import?${query}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-openkit-request-id': randomUUID(),
    },
    body: original,
  });
  expect(uploaded.status, await uploaded.clone().text()).toBe(201);
  const { artifactId } = (await uploaded.json()) as { artifactId: string };
  const replacement = '\uFEFFExact new text\r\n😀\n';
  const committed = await app.request(
    ...operationRequest(
      'artifact.version-commit',
      {},
      {
        body: JSON.stringify({
          workspaceId: workspace.id,
          artifactId,
          threadId: thread.id,
          requestId: randomUUID(),
          expectedArtifactVersion: 1,
          title: 'Revised output',
          summary: null,
          content: { format: 'text', body: replacement },
        }),
      }
    )
  );
  expect(committed.status, await committed.clone().text()).toBe(201);

  // These annotations are retained descriptions, including strings that resemble owned references.
  const sourceVersionRoot = join(
    dataRoot,
    'workspaces',
    workspace.id,
    'artifacts',
    artifactId,
    'versions'
  );
  for (const version of [1, 2]) {
    const path = join(sourceVersionRoot, String(version), 'version-record.json');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.extensions = { sourceArtifactId: artifactId, sourceThreadId: thread.id };
    raw.version.actor.description = 'Original publisher';
    raw.artifact.origin.actor.description = 'Original importer';
    raw.artifact.content.description = `Exact original ${version}`;
    writeFileSync(path, `${JSON.stringify(raw)}\n`);
  }

  const exportedResponse = await app.request(
    ...operationRequest('workspace.export', { workspaceId: workspace.id })
  );
  expect(exportedResponse.status, await exportedResponse.clone().text()).toBe(200);
  const exported = WorkspaceExportResponseSchema.parse(await exportedResponse.json());
  const exportRoot = existingWorkspaceExportRoot(dataRoot, workspace.id, exported.exportId);
  for (const version of [1, 2]) {
    expect(
      readFileSync(
        join(
          exportRoot,
          'artifacts',
          artifactId,
          'versions',
          String(version),
          'version-record.json'
        )
      )
    ).toEqual(readFileSync(join(sourceVersionRoot, String(version), 'version-record.json')));
  }
  const verified = verifyWorkspaceExportTree({ exportRoot });
  const descriptorPath = `artifacts/${artifactId}/versions/2/version-record.json`;
  const rawHead = JSON.parse(verified.fileContents.get(descriptorPath)!);
  const invalidHeads = [
    { ...rawHead, formatVersion: 2 },
    { ...rawHead, version: { ...rawHead.version, parentVersion: null } },
    {
      ...rawHead,
      version: {
        ...rawHead.version,
        actor: { kind: 'system', id: 'different-publisher', responsibleUserId: null },
      },
    },
    {
      ...rawHead,
      artifact: { ...rawHead.artifact, title: 'Contradictory head' },
      version: { ...rawHead.version, title: 'Contradictory head' },
    },
    {
      ...rawHead,
      artifact: {
        ...rawHead.artifact,
        origin: { ...rawHead.artifact.origin, sourceDigest: digest(Buffer.from('different')) },
      },
    },
  ];
  for (const descriptor of invalidHeads) {
    const files = new Map(verified.fileContents);
    files.set(descriptorPath, JSON.stringify(descriptor));
    expect(() =>
      readWorkspaceImportSnapshot({
        verified: { ...verified, fileContents: files },
        targetWorkspaceId: workspace.id,
      })
    ).toThrow();
  }
  const missingOriginals = new Map(verified.artifactPayloadFiles);
  missingOriginals.delete(`artifacts/${artifactId}/versions/1/payload`);
  expect(() =>
    readWorkspaceImportSnapshot({
      verified: { ...verified, artifactPayloadFiles: missingOriginals },
      targetWorkspaceId: workspace.id,
    })
  ).toThrow(/original/);
  expect(() =>
    readWorkspaceImportSnapshot({
      verified: {
        ...verified,
        manifest: {
          ...verified.manifest,
          contentInventory: [
            ...verified.manifest.contentInventory,
            {
              path: `artifacts/${artifactId}/versions/3/payload`,
              digest: digest(Buffer.alloc(0)),
              bytes: 0,
            },
          ],
        },
      },
      targetWorkspaceId: workspace.id,
    })
  ).toThrow(/extra/);
  const importedResponse = await app.request(
    ...operationRequest(
      'workspace.import',
      {},
      {
        body: JSON.stringify({
          sourceWorkspaceId: workspace.id,
          exportId: exported.exportId,
          requestId: randomUUID(),
        }),
      }
    )
  );
  expect(importedResponse.status, await importedResponse.clone().text()).toBe(200);
  const imported = WorkspaceImportResponseSchema.parse(await importedResponse.json());
  const importedArtifact = store.listArtifacts(imported.importedWorkspaceId)[0]!;
  expect(
    store.listArtifactVersions(imported.importedWorkspaceId, importedArtifact.id)
  ).toHaveLength(2);
  const reopened = new FsStore({ dataRoot });
  const restored = reopened
    .listArtifacts(imported.importedWorkspaceId)
    .find((item) => item.title === 'Revised output');
  expect(restored).toBeDefined();
  if (!restored) throw new Error('The imported Artifact is missing.');
  expect(restored.id).not.toBe(artifactId);
  expect(restored.origin).toMatchObject({ kind: 'imported', sourceDigest: digest(original) });
  expect(restored.threadId).toBeNull();
  expect(restored.turnId).toBeNull();
  for (const version of [1, 2]) {
    const raw = JSON.parse(
      readFileSync(
        join(
          dataRoot,
          'workspaces',
          imported.importedWorkspaceId,
          'artifacts',
          restored.id,
          'versions',
          String(version),
          'version-record.json'
        ),
        'utf8'
      )
    );
    expect(raw.extensions).toEqual({ sourceArtifactId: artifactId, sourceThreadId: thread.id });
    expect(raw.version.actor.description).toBe('Original publisher');
    expect(raw.artifact.origin.actor.description).toBe('Original importer');
    expect(raw.artifact.content.description).toBe(`Exact original ${version}`);
    expect(raw.artifact.id).toBe(restored.id);
    expect(raw.version).not.toHaveProperty('artifactId');
    expect(raw.version).not.toHaveProperty('workspaceId');
    expect(raw.artifact.workspaceId).toBe(imported.importedWorkspaceId);
  }
  const first = reopened.getArtifactVersion(imported.importedWorkspaceId, restored.id, 1);
  const second = reopened.getArtifactVersion(imported.importedWorkspaceId, restored.id, 2);
  expect(first.version).toMatchObject({
    artifactVersion: 1,
    parentVersion: null,
    actor,
    threadId: null,
    turnId: null,
  });
  expect(second.version).toMatchObject({ artifactVersion: 2, parentVersion: 1, actor });
  expect(second.artifact.content).toEqual({ format: 'text', body: replacement });
  expect(second.version.threadId).not.toBe(thread.id);
  expect(second.version.turnId).not.toBeNull();
  const publication = reopened.getTurn(
    imported.importedWorkspaceId,
    second.version.threadId!,
    second.version.turnId!
  );
  expect(publication.items).toContainEqual(
    expect.objectContaining({
      type: 'artifact-reference',
      artifactId: restored.id,
      artifactVersion: 2,
    })
  );
  const downloaded = await app.request(
    `/api/app/operations/artifact.download?${new URLSearchParams({
      workspaceId: imported.importedWorkspaceId,
      artifactId: restored.id,
      artifactVersion: '1',
    })}`
  );
  expect(downloaded.status, await downloaded.clone().text()).toBe(200);
  const downloadedBytes = new Uint8Array(await downloaded.arrayBuffer());
  expect(Buffer.from(downloadedBytes)).toEqual(original);
  expect(digest(downloadedBytes)).toBe(first.version.contentDigest);
});

it('retains historical Artifact event snapshots and Item deltas after a newer version is imported', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'artifact-version-events-'));
  const coreDb = openCoreDb(dataRoot);
  onTestFinished(() => {
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const actor = { kind: 'user', id: FIXTURE_LOCAL_USER_ID } as const;
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Historical event snapshots', {
    requestId: randomUUID(),
    producer: actor,
    instructionReference: 'test:historical-artifact-events',
  });
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: actor.id, workspaceId: workspace.id });
  const thread = store.createThread(workspace.id, 'Retained output events');
  const turn = store.createTurn(workspace.id, thread.id, 'Produce original output', actor);
  const requestId = randomUUID();
  const recordedAt = new Date().toISOString();
  const artifact = store.createArtifact({
    id: allocateEntityId('ar'),
    workspaceId: workspace.id,
    threadId: thread.id,
    turnId: turn.id,
    kind: 'report',
    title: 'Original event output',
    summary: null,
    status: 'ready',
    version: 1,
    content: { format: 'text', body: 'Original retained output' },
    contentDigest: digest(Buffer.from('Original retained output')),
    lastMutationRequestId: requestId,
    origin: { kind: 'turn-output', threadId: thread.id, turnId: turn.id, requestId },
    createdAt: recordedAt,
    updatedAt: recordedAt,
  });
  const reference = store
    .getTurn(workspace.id, thread.id, turn.id)
    .items.find((item) => item.type === 'artifact-reference' && item.artifactId === artifact.id)!;
  const eventScope = {
    workspaceId: workspace.id,
    threadId: thread.id,
    turnId: turn.id,
    requestId: null,
  };
  store.emitTurnEvent(turn.id, {
    ...eventScope,
    event: 'artifact.created',
    data: { type: 'artifact-created', artifact },
  });
  store.emitTurnEvent(turn.id, {
    ...eventScope,
    event: 'item.delta',
    data: {
      type: 'item-delta',
      itemId: reference.id,
      itemType: 'artifact-reference',
      deltaKind: 'artifact-updated',
      artifactId: artifact.id,
    },
  });
  store.updateTurn(turn.id, { status: 'completed', completedAt: recordedAt, durationMs: 0 });
  const app = createAppWithWorkspaceAuthority({ coreDb, dataRoot, store });
  const committed = await app.request(
    ...operationRequest(
      'artifact.version-commit',
      {},
      {
        body: JSON.stringify({
          workspaceId: workspace.id,
          artifactId: artifact.id,
          threadId: thread.id,
          requestId: randomUUID(),
          expectedArtifactVersion: 1,
          title: 'Current event output',
          summary: null,
          content: { format: 'text', body: 'Current retained output' },
        }),
      }
    )
  );
  expect(committed.status, await committed.clone().text()).toBe(201);
  const exportedResponse = await app.request(
    ...operationRequest('workspace.export', { workspaceId: workspace.id })
  );
  expect(exportedResponse.status, await exportedResponse.clone().text()).toBe(200);
  const exported = WorkspaceExportResponseSchema.parse(await exportedResponse.json());
  const importedResponse = await app.request(
    ...operationRequest(
      'workspace.import',
      {},
      {
        body: JSON.stringify({
          sourceWorkspaceId: workspace.id,
          exportId: exported.exportId,
          requestId: randomUUID(),
        }),
      }
    )
  );
  expect(importedResponse.status, await importedResponse.clone().text()).toBe(200);
  const imported = WorkspaceImportResponseSchema.parse(await importedResponse.json());
  const reopened = new FsStore({ dataRoot });
  const restored = reopened.listArtifacts(imported.importedWorkspaceId)[0]!;
  const first = reopened.getArtifactVersion(imported.importedWorkspaceId, restored.id, 1);
  const events = reopened.getTurnEventsForExport(first.version.turnId!);
  expect(restored.version).toBe(2);
  expect(events.find((event) => event.data.type === 'artifact-created')?.data).toEqual({
    type: 'artifact-created',
    artifact: first.artifact,
  });
  expect(events.find((event) => event.data.type === 'item-delta')?.data).toMatchObject({
    type: 'item-delta',
    deltaKind: 'artifact-updated',
    artifactId: restored.id,
  });
  const importedTurn = reopened.getTurn(
    imported.importedWorkspaceId,
    first.version.threadId!,
    first.version.turnId!
  );
  expect(importedTurn.items).toContainEqual(
    expect.objectContaining({
      type: 'artifact-reference',
      artifactId: restored.id,
      artifactVersion: 1,
    })
  );
});
