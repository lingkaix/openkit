import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CandidateSetRecordSchema,
  type JsonOperationId,
  WorkspaceExportResponseSchema,
} from '@openkit/app-api-schemas';
import { allocateEntityId } from '@openkit/protocol';
import { expect, it, onTestFinished } from 'vitest';
import { createArtifactReview } from '../artifact-reviews.js';
import { FsStore } from '../lib/store.js';
import { correctMaterialRange } from '../material-range-corrections.js';
import { createAppWithWorkspaceAuthority } from '../test-support/app.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { createWorkspaceMaterial, saveWorkspaceMaterialRevision } from '../workspace-materials.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openCoreDb, openWorkspaceDb } from './db.js';
import { applyMigrations, applyScopedMigrations } from './migrate.js';
import { verifyWorkspaceExportTree } from './workspace-export.js';
import { existingWorkspaceExportRoot } from './workspace-transfer-routes.js';

/** Hashes the expected original bytes independently of upload and export readers. */
function digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

it('preserves exact historical bytes, parents and publication lineage through the verified Workspace export', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'artifact-version-portability-'));
  const coreDb = openCoreDb(dataRoot);
  onTestFinished(async () => {
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const actor = { kind: 'user', id: FIXTURE_LOCAL_USER_ID } as const;
  const workspace = await store.createWorkspace('Historical output', {
    requestId: randomUUID(),
    producer: actor,
    instructionReference: 'test:artifact-version-portability',
  });
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: actor.id, workspaceId: workspace.id });
  const thread = await store.createThread(workspace.id, 'Publish revisions');
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
  const firstRecord = JSON.parse(
    verified.fileContents.get(`artifacts/${artifactId}/versions/1/version-record.json`)!
  );
  const secondRecord = JSON.parse(
    verified.fileContents.get(`artifacts/${artifactId}/versions/2/version-record.json`)!
  );
  expect(firstRecord.artifact.version).toBe(1);
  expect(firstRecord.version).not.toHaveProperty('artifactId');
  expect(firstRecord.version).not.toHaveProperty('workspaceId');
  expect(firstRecord.extensions).toEqual({
    sourceArtifactId: artifactId,
    sourceThreadId: thread.id,
  });
  expect(firstRecord.version.actor.description).toBe('Original publisher');
  expect(firstRecord.artifact.origin.actor.description).toBe('Original importer');
  expect(firstRecord.artifact.content.description).toBe('Exact original 1');
  expect(secondRecord.artifact.version).toBe(2);
  expect(secondRecord.version).not.toHaveProperty('artifactId');
  expect(secondRecord.version).not.toHaveProperty('workspaceId');
  expect(
    readFileSync(verified.artifactPayloadFiles.get(`artifacts/${artifactId}/versions/2/payload`)!)
  ).toEqual(Buffer.from(replacement));
  expect(secondRecord.extensions).toEqual({
    sourceArtifactId: artifactId,
    sourceThreadId: thread.id,
  });
  expect(secondRecord.version.actor.description).toBe('Original publisher');
  expect(secondRecord.artifact.origin.actor.description).toBe('Original importer');
  expect(secondRecord.artifact.content.description).toBe('Exact original 2');
  expect(
    readFileSync(verified.artifactPayloadFiles.get(`artifacts/${artifactId}/versions/1/payload`)!)
  ).toEqual(original);
  const publishedItems = verified.fileContents
    .get('records/turns.jsonl')!
    .trim()
    .split('\n')
    .flatMap(
      (line) => (JSON.parse(line) as { items?: readonly Record<string, unknown>[] }).items ?? []
    );
  expect(publishedItems).toContainEqual(
    expect.objectContaining({
      type: 'artifact-reference',
      artifactId,
      artifactVersion: 2,
    })
  );
});

it('retains historical Artifact event snapshots and Item deltas in the verified Workspace export', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'artifact-version-events-'));
  const coreDb = openCoreDb(dataRoot);
  onTestFinished(async () => {
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const actor = { kind: 'user', id: FIXTURE_LOCAL_USER_ID } as const;
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Historical event snapshots', {
    requestId: randomUUID(),
    producer: actor,
    instructionReference: 'test:historical-artifact-events',
  });
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: actor.id, workspaceId: workspace.id });
  const thread = await store.createThread(workspace.id, 'Retained output events');
  const turn = await store.createTurn(workspace.id, thread.id, 'Produce original output', actor);
  const requestId = randomUUID();
  const recordedAt = new Date().toISOString();
  const artifact = await store.createArtifact({
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
  store.emitTurnEvent(
    turn.id,
    await store.persistTurnEvent(turn.id, {
      ...eventScope,
      event: 'artifact.created',
      data: { type: 'artifact-created', artifact },
    })
  );
  store.emitTurnEvent(
    turn.id,
    await store.persistTurnEvent(turn.id, {
      ...eventScope,
      event: 'item.delta',
      data: {
        type: 'item-delta',
        itemId: reference.id,
        itemType: 'artifact-reference',
        deltaKind: 'artifact-updated',
        artifactId: artifact.id,
      },
    })
  );
  await store.completeTurn(turn.id, {
    status: 'completed',
    completedAt: recordedAt,
    durationMs: 0,
  });
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
  const verified = verifyWorkspaceExportTree({
    exportRoot: existingWorkspaceExportRoot(dataRoot, workspace.id, exported.exportId),
  });
  const versionOne = JSON.parse(
    verified.fileContents.get(`artifacts/${artifact.id}/versions/1/version-record.json`)!
  );
  const versionTwo = JSON.parse(
    verified.fileContents.get(`artifacts/${artifact.id}/versions/2/version-record.json`)!
  );
  expect(versionOne.artifact.version).toBe(1);
  expect(
    readFileSync(verified.artifactPayloadFiles.get(`artifacts/${artifact.id}/versions/1/payload`)!)
  ).toEqual(Buffer.from('Original retained output'));
  expect(versionTwo.artifact.version).toBe(2);
  expect(
    readFileSync(verified.artifactPayloadFiles.get(`artifacts/${artifact.id}/versions/2/payload`)!)
  ).toEqual(Buffer.from('Current retained output'));
  const events = verified.fileContents
    .get('records/turn-events.jsonl')!
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { data?: Record<string, unknown> });
  expect(events.find((event) => event.data?.type === 'artifact-created')?.data).toMatchObject({
    type: 'artifact-created',
    artifact: {
      id: artifact.id,
      version: 1,
      content: { format: 'text', body: 'Original retained output' },
    },
  });
  expect(events.find((event) => event.data?.type === 'item-delta')?.data).toMatchObject({
    type: 'item-delta',
    deltaKind: 'artifact-updated',
    artifactId: artifact.id,
  });
  const publishedItems = verified.fileContents
    .get('records/turns.jsonl')!
    .trim()
    .split('\n')
    .flatMap(
      (line) => (JSON.parse(line) as { items?: readonly Record<string, unknown>[] }).items ?? []
    );
  expect(publishedItems).toContainEqual(
    expect.objectContaining({
      type: 'artifact-reference',
      artifactId: artifact.id,
      artifactVersion: 1,
    })
  );
});

it('exports target-owned judgements, exact range results and candidate choices', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'evaluation-portability-'));
  const coreDb = openCoreDb(dataRoot);
  onTestFinished(async () => {
    if (coreDb.sqlite.open) coreDb.sqlite.close();
    await shutdownControlStoreWorkerClient();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const actor = { kind: 'user', id: userId } as const;
  const store = new FsStore({ dataRoot });
  const workspace = await store.createWorkspace('Evaluation history', {
    producer: actor,
    requestId: randomUUID(),
    instructionReference: 'test:evaluation-portability',
  });
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const thread = await store.createThread(workspace.id, 'Selected output');
  const turn = await store.createTurn(
    workspace.id,
    thread.id,
    'Produce selected output',
    actor,
    null,
    {
      agentId: 'portable-producer',
    }
  );
  const candidatePublications = ['First original', 'Second original'].map(async (body, index) => {
    const requestId = `portable-original-${index}`;
    const recordedAt = new Date().toISOString();
    const contentDigest = digest(Buffer.from(body));
    const artifact = await store.createArtifact({
      id: allocateEntityId('ar'),
      workspaceId: workspace.id,
      threadId: index === 0 ? thread.id : null,
      turnId: index === 0 ? turn.id : null,
      kind: 'file',
      title: body,
      status: 'ready',
      summary: null,
      version: 1,
      content: { format: 'text', body },
      contentDigest,
      lastMutationRequestId: requestId,
      origin:
        index === 0
          ? {
              kind: 'turn-output',
              threadId: thread.id,
              turnId: turn.id,
              requestId,
            }
          : {
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
  const candidates = await Promise.all(candidatePublications);
  await store.updateTurn(turn.id, {
    status: 'completed',
    completedAt: new Date().toISOString(),
    durationMs: 0,
  });
  const db = openWorkspaceDb(dataRoot, workspace.id);
  let originalRevisionId: string;
  let materialId: string;
  try {
    applyScopedMigrations(db);
    createArtifactReview(db, {
      ...candidates[0]!,
      sourceThreadId: thread.id,
      sourceTurnId: turn.id,
      sourceAgentId: turn.agentId!,
      materialProposal: null,
      createdAt: store.getArtifactVersion(workspace.id, candidates[0]!.artifactId, 1).version
        .recordedAt,
    });
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
    db.sqlite.transaction(() =>
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
  );
  await post(
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
  const selectionRequestId = 'portable-version-selection';
  await post(
    'artifact.review.select',
    {
      workspaceId: workspace.id,
      ...candidates[0],
      requestId: selectionRequestId,
      reason: 'Use this exact original.',
    },
    200
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
  const candidateSet = JSON.parse(
    verified.fileContents.get('records/evaluation-candidate-sets.jsonl')!.trim()
  );
  const review = JSON.parse(verified.fileContents.get('records/artifact-reviews.jsonl')!.trim());
  const revisions = verified.fileContents
    .get('records/workspace-material-revisions.jsonl')!
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as {
          content: string;
          judgements: Array<{
            description?: unknown;
            actor: { description?: string };
            target: { description?: string };
            choice?: {
              description?: string;
              resultingRevision?: { description?: string };
            };
          }>;
        }
    );
  expect(candidateSet.candidateSetId).toBe(set.candidateSetId);
  expect(candidateSet.description).toEqual(description);
  expect(candidateSet.createdBy.description).toBe('Historical creator');
  expect(candidateSet.candidates[0].description).toBe('Historical member');
  expect(revisions.map((revision) => revision.content)).toEqual(
    expect.arrayContaining(['Original 😀 source\r\n', 'Original new source\r\n'])
  );
  expect(review.judgements).toHaveLength(2);
  expect(review.judgements[1]).toMatchObject({
    kind: 'select',
    note: 'Use this exact original.',
    requestId: selectionRequestId,
  });
  const range = revisions.find((revision) => revision.content === 'Original 😀 source\r\n');
  if (!range) throw new Error('The historical Material revision is missing from the export.');
  for (const judgement of [candidateSet.judgements[0], review.judgements[0], range.judgements[0]]) {
    expect(judgement.description).toEqual(description);
    expect(judgement.actor.description).toBe('Historical actor');
    expect(judgement.target.description).toBe('Historical target');
  }
  expect(candidateSet.judgements[0].choice.description).toBe('Historical choice');
  expect(range.judgements[0].choice.description).toBe('Historical choice');
  expect(range.judgements[0].choice.resultingRevision.description).toBe(
    'Historical correction result'
  );
});
