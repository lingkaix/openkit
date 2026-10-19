import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const description = {
    artifactId: candidates[0]!.artifactId,
    materialId,
    candidateSetId: set.candidateSetId,
  };
  /** Adds ignored descriptions whose reference-looking strings must survive without reminting. */
  function addDescriptions(raw: {
    actor: object;
    target: object;
    choice: unknown;
    description?: unknown;
  }) {
    raw.description = description;
    raw.actor = { ...raw.actor, description: 'Historical actor' };
    raw.target = { ...raw.target, description: 'Historical target' };
    if (typeof raw.choice === 'object' && raw.choice !== null)
      raw.choice = { ...raw.choice, description: 'Historical choice' };
  }
  const sourceDb = openWorkspaceDb(dataRoot, workspace.id);
  try {
    const setRow = sourceDb.sqlite
      .prepare(
        'SELECT payload_json AS payload FROM evaluation_candidate_sets WHERE candidate_set_id = ?'
      )
      .get(set.candidateSetId) as { payload: string };
    const rawSet = JSON.parse(setRow.payload);
    rawSet.description = description;
    rawSet.createdBy.description = 'Historical creator';
    rawSet.candidates[0].description = 'Historical member';
    addDescriptions(rawSet.judgements[0]);
    sourceDb.sqlite
      .prepare('UPDATE evaluation_candidate_sets SET payload_json = ? WHERE candidate_set_id = ?')
      .run(JSON.stringify(rawSet), set.candidateSetId);
    const reviewRow = sourceDb.sqlite
      .prepare(
        'SELECT judgements FROM artifact_reviews WHERE artifact_id = ? AND artifact_version = 1'
      )
      .get(candidates[0]!.artifactId) as { judgements: string };
    const reviewJudgements = JSON.parse(reviewRow.judgements);
    addDescriptions(reviewJudgements[0]);
    sourceDb.sqlite
      .prepare(
        'UPDATE artifact_reviews SET judgements = ? WHERE artifact_id = ? AND artifact_version = 1'
      )
      .run(JSON.stringify(reviewJudgements), candidates[0]!.artifactId);
    const revisionRow = sourceDb.sqlite
      .prepare(
        'SELECT judgements FROM workspace_material_revisions WHERE material_id = ? AND revision_id = ?'
      )
      .get(materialId, originalRevisionId) as { judgements: string };
    const rangeJudgements = JSON.parse(revisionRow.judgements);
    addDescriptions(rangeJudgements[0]);
    rangeJudgements[0].choice.resultingRevision.description = 'Historical correction result';
    sourceDb.sqlite
      .prepare(
        'UPDATE workspace_material_revisions SET judgements = ? WHERE material_id = ? AND revision_id = ?'
      )
      .run(JSON.stringify(rangeJudgements), materialId, originalRevisionId);
  } finally {
    sourceDb.sqlite.close();
  }
  const exportedResponse = await app.request(
    ...operationRequest('workspace.export', { workspaceId: workspace.id })
  );
  expect(exportedResponse.status, await exportedResponse.clone().text()).toBe(200);
  const exported = WorkspaceExportResponseSchema.parse(await exportedResponse.json());
  const verified = verifyWorkspaceExportTree({
    exportRoot: existingWorkspaceExportRoot(dataRoot, workspace.id, exported.exportId),
  });
  const files = new Map(verified.fileContents);
  const revisionsPath = 'records/workspace-material-revisions.jsonl';
  const invalidRevisions = files
    .get(revisionsPath)!
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  invalidRevisions.find(
    (revision) => revision.revisionId === originalRevisionId
  ).judgements[0].target.originalText = 'xx';
  files.set(
    revisionsPath,
    `${invalidRevisions.map((revision) => JSON.stringify(revision)).join('\n')}\n`
  );
  expect(() =>
    readWorkspaceImportSnapshot({
      verified: { ...verified, fileContents: files },
      targetWorkspaceId: workspace.id,
    })
  ).toThrow('Portable judgement contradicts its exact original UTF-16 Material range.');
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
    const rawSet = JSON.parse(
      (
        restoredDb.sqlite
          .prepare(
            'SELECT payload_json AS payload FROM evaluation_candidate_sets WHERE candidate_set_id = ?'
          )
          .get(restoredSet.candidateSetId) as { payload: string }
      ).payload
    );
    expect(rawSet.description).toEqual(description);
    expect(rawSet.createdBy.description).toBe('Historical creator');
    expect(rawSet.candidates[0].description).toBe('Historical member');
    const rawReview = JSON.parse(
      (
        restoredDb.sqlite
          .prepare(
            'SELECT judgements FROM artifact_reviews WHERE artifact_id = ? AND artifact_version = 1'
          )
          .get(restoredArtifact!.id) as { judgements: string }
      ).judgements
    );
    const rawRange = JSON.parse(
      (
        restoredDb.sqlite
          .prepare(
            'SELECT judgements FROM workspace_material_revisions WHERE material_id = ? AND revision_id = ?'
          )
          .get(material.materialId, original.revisionId) as { judgements: string }
      ).judgements
    );
    for (const judgement of [rawSet.judgements[0], rawReview[0], rawRange[0]]) {
      expect(judgement.description).toEqual(description);
      expect(judgement.actor.description).toBe('Historical actor');
      expect(judgement.target.description).toBe('Historical target');
    }
    expect(rawSet.judgements[0].choice.description).toBe('Historical choice');
    expect(rawRange[0].choice.description).toBe('Historical choice');
    expect(rawRange[0].choice.resultingRevision.description).toBe('Historical correction result');
  } finally {
    restoredDb.sqlite.close();
  }
});
