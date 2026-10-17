import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CandidateSetRecordSchema,
  type JsonOperationId,
  WorkspaceExportResponseSchema,
  WorkspaceImportResponseSchema,
} from '@openkit/app-api-schemas';
import { allocateEntityId } from '@openkit/protocol';
import { expect, it, onTestFinished } from 'vitest';
import { FsStore } from '../lib/store.js';
import { correctMaterialRange } from '../material-range-corrections.js';
import { createAppWithWorkspaceAuthority } from '../test-support/app.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import {
  createWorkspaceMaterial,
  getWorkspaceMaterialRevision,
  listWorkspaceMaterials,
  saveWorkspaceMaterialRevision,
} from '../workspace-materials.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';

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
  const restored = reopened
    .listArtifacts(imported.importedWorkspaceId)
    .find((item) => item.title === 'Revised output');
  expect(restored).toBeDefined();
  if (!restored) throw new Error('The imported Artifact is missing.');
  expect(restored.id).not.toBe(artifactId);
  expect(restored.origin).toMatchObject({ kind: 'imported', sourceDigest: digest(original) });
  expect(restored.threadId).toBeNull();
  expect(restored.turnId).toBeNull();
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

it('round trips target-owned judgements, exact range results and candidate choices with reminted references', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'evaluation-portability-'));
  const coreDb = openCoreDb(dataRoot);
  onTestFinished(() => {
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const actor = { kind: 'user', id: userId } as const;
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Evaluation history', {
    producer: actor,
    requestId: randomUUID(),
    instructionReference: 'test:evaluation-portability',
  });
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const candidates = ['First original', 'Second original'].map((body, index) => {
    const requestId = `portable-original-${index}`;
    const recordedAt = new Date().toISOString();
    const contentDigest = digest(Buffer.from(body));
    const artifact = store.createArtifact({
      id: allocateEntityId('ar'),
      workspaceId: workspace.id,
      threadId: null,
      turnId: null,
      kind: 'file',
      title: body,
      status: 'ready',
      summary: null,
      version: 1,
      content: { format: 'text', body },
      contentDigest,
      lastMutationRequestId: requestId,
      origin: {
        kind: 'imported',
        sourceKind: 'direct-import',
        sourceId: requestId,
        sourceDigest: contentDigest,
        actor,
        requestId,
        recordedAt,
      },
      createdAt: recordedAt,
      updatedAt: recordedAt,
    });
    return { artifactId: artifact.id, artifactVersion: 1, contentDigest };
  });
  const db = openWorkspaceDb(dataRoot, workspace.id);
  let originalRevisionId: string;
  let materialId: string;
  let correction: ReturnType<typeof correctMaterialRange>;
  try {
    applyScopedMigrations(db);
    const acceptedAt = new Date().toISOString();
    ({ materialId } = createWorkspaceMaterial(db, {
      actor,
      acceptedAt,
      requestId: 'portable-material',
      title: 'Portable feedback',
      kind: 'text',
      sensitivity: 'internal',
    }));
    const content = 'Original 😀 source\r\n';
    const contentDigest = digest(Buffer.from(content));
    ({ revisionId: originalRevisionId } = saveWorkspaceMaterialRevision(db, {
      actor,
      acceptedAt,
      materialId,
      requestId: 'portable-revision',
      expectedRevisionId: null,
      content,
      contentDigest,
    }));
    correction = db.sqlite.transaction(() =>
      correctMaterialRange(db, {
        workspaceId: workspace.id,
        actor,
        acceptedAt,
        requestId: 'portable-correction',
        target: {
          kind: 'material-range',
          offsetUnit: 'utf-16',
          materialId,
          revisionId: originalRevisionId,
          contentDigest,
          start: 9,
          end: 11,
          originalText: '😀',
        },
        replacementText: 'new',
        decision: 'apply',
        note: 'Exact feedback',
        extensions: { review: 'manual' },
      })
    )();
  } finally {
    db.sqlite.close();
  }
  const app = createAppWithWorkspaceAuthority({ coreDb, dataRoot, store });
  /** Invokes the public projection so the round trip also exercises the native family join. */
  async function post(operation: JsonOperationId, input: unknown, status: number) {
    const response = await app.request(
      ...operationRequest(operation, {}, { body: JSON.stringify(input) })
    );
    expect(response.status, await response.clone().text()).toBe(status);
    return response.json();
  }
  const set = CandidateSetRecordSchema.parse(
    await post(
      'evaluation.candidate-set-create',
      { workspaceId: workspace.id, requestId: 'portable-set', candidates },
      201
    )
  );
  const selected = CandidateSetRecordSchema.parse(
    await post(
      'evaluation.candidate-set-select',
      {
        workspaceId: workspace.id,
        candidateSetId: set.candidateSetId,
        requestId: 'portable-selection',
        choice: candidates[0],
        note: 'Preferred original',
      },
      200
    )
  );
  const assessment = await post(
    'evaluation.judgement-add',
    {
      workspaceId: workspace.id,
      requestId: 'portable-judgement',
      judgement: {
        kind: 'accept',
        target: { kind: 'artifact-version', ...candidates[0] },
        choice: null,
        note: 'Human acceptance',
      },
    },
    201
  );
  const exportedResponse = await app.request(
    ...operationRequest('workspace.export', { workspaceId: workspace.id })
  );
  expect(exportedResponse.status, await exportedResponse.clone().text()).toBe(200);
  const exported = WorkspaceExportResponseSchema.parse(await exportedResponse.json());
  const imported = WorkspaceImportResponseSchema.parse(
    await post(
      'workspace.import',
      { sourceWorkspaceId: workspace.id, exportId: exported.exportId, requestId: randomUUID() },
      200
    )
  );
  const restoredWorkspace = imported.importedWorkspaceId;
  const reopened = new FsStore({ dataRoot });
  const restoredArtifact = reopened
    .listArtifacts(restoredWorkspace)
    .find((item) => item.title === 'First original');
  expect(restoredArtifact).toBeDefined();
  const listedResponse = await app.request(
    ...operationRequest('evaluation.candidate-set-list', { workspaceId: restoredWorkspace })
  );
  expect(listedResponse.status).toBe(200);
  const listed = (await listedResponse.json()) as { items: unknown[] };
  const restoredSet = CandidateSetRecordSchema.parse(listed.items[0]);
  expect(restoredSet.workspaceId).toBe(restoredWorkspace);
  expect(restoredSet.candidates[0]).toEqual({ ...candidates[0], artifactId: restoredArtifact!.id });
  expect(restoredSet.judgements[0]).toMatchObject({
    actor,
    recordedAt: selected.judgements[0]!.recordedAt,
    kind: 'select',
    choice: {
      artifactId: restoredArtifact!.id,
      artifactVersion: 1,
      contentDigest: candidates[0]!.contentDigest,
    },
  });
  const reviewResponse = await app.request(
    ...operationRequest('artifact.review-list', {
      workspaceId: restoredWorkspace,
      artifactId: restoredArtifact!.id,
    })
  );
  expect(reviewResponse.status).toBe(200);
  const reviews = (await reviewResponse.json()) as { reviews: Array<{ judgements: unknown[] }> };
  expect(reviews.reviews[0]!.judgements[0]).toMatchObject({
    actor,
    recordedAt: assessment.judgement.recordedAt,
    kind: 'accept',
    target: { kind: 'artifact-version', artifactId: restoredArtifact!.id, artifactVersion: 1 },
  });
  const restoredDb = openWorkspaceDb(dataRoot, restoredWorkspace);
  try {
    const material = listWorkspaceMaterials(restoredDb).find(
      (item) => item.title === 'Portable feedback'
    )!;
    expect(material.materialId).not.toBe(materialId);
    const result = getWorkspaceMaterialRevision(
      restoredDb,
      material.materialId,
      material.currentRevisionId!
    );
    const original = getWorkspaceMaterialRevision(
      restoredDb,
      material.materialId,
      result.parentRevisionId!
    );
    expect(original.revisionId).not.toBe(originalRevisionId);
    expect(original.content).toBe('Original 😀 source\r\n');
    expect(result.content).toBe('Original new source\r\n');
    expect(original.judgements[0]).toMatchObject({
      actor,
      recordedAt: correction.recordedAt,
      kind: 'correct',
      target: {
        materialId: material.materialId,
        revisionId: original.revisionId,
        originalText: '😀',
        offsetUnit: 'utf-16',
      },
      choice: {
        outcome: 'apply',
        resultingRevision: {
          materialId: material.materialId,
          revisionId: result.revisionId,
          contentDigest: result.contentDigest,
        },
      },
    });
  } finally {
    restoredDb.sqlite.close();
  }
});
