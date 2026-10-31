import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId, deriveEntityId } from '@openkit/protocol';
import { LocalStorage, type StorageAccess, type StorageResult } from '@openkit/storage';
import { expect, it, onTestFinished } from 'vitest';
import { listSqliteAuditEvents, prepareAuditEventStatement } from '../audit-events.js';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { createFixture, decide } from '../test-support/knowledge-proposal-authority.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import {
  getCommandRequestRecordFromDb,
  prepareControlCommandRequestStatement,
} from './command-request-records.js';
import {
  type ControlKnowledgeProposal,
  controlKnowledgeHeadStatements,
  controlKnowledgeProposalStatement,
  controlKnowledgeReviewStatement,
  readControlKnowledgeHead,
  readControlKnowledgeProposal,
} from './control-store-knowledge.js';
import { getControlStoreWorkerClient } from './control-store-worker-client.js';
import { openWorkspaceDb, type WorkspaceDb } from './db.js';
import { workspaceDbPath } from './fs-layout.js';
import { publishImmutableContent } from './immutable-content.js';
import { applyScopedMigrations } from './migrate.js';
import { readWorkspaceKnowledgeProposalInventory } from './workspace-file-records.js';

/** Requires actual Storage stage and publication success, never a fabricated descriptor. */
function storageValue<T>(result: StorageResult<T>): T {
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error(`Storage setup refused: ${result.status}`);
  return result.value;
}

it('commits original ordered Reviews with the exact head, receipt and Audit or rolls back the whole tuple', async () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  const root = mkdtempSync(join(tmpdir(), 'control-knowledge-proposals-'));
  const client = getControlStoreWorkerClient();
  let db: WorkspaceDb | undefined;
  let sourceDb: WorkspaceDb | undefined;
  let storage: LocalStorage | undefined;
  onTestFinished(async () => {
    await client.shutdown();
    if (db?.sqlite.open) db.sqlite.close();
    if (sourceDb?.sqlite.open) sourceDb.sqlite.close();
    await storage?.close();
    for (const cleanup of cleanups.reverse()) await cleanup();
    rmSync(root, { recursive: true, force: true });
  });
  const source = await createFixture('native-proposal-tuple', true, (cleanup) =>
    cleanups.push(cleanup)
  );
  await decide(source, 'deferred', 'native-proposal-deferred');
  await decide(source, 'accepted', 'native-proposal-accepted');
  const reviews = readWorkspaceKnowledgeProposalInventory(
    source.workspaceRoot,
    source.workspaceId
  ).knowledgeProposalReviews.filter((review) => review.proposalId === source.proposal.id);
  expect(reviews.map((review) => review.decision)).toEqual(['deferred', 'accepted']);
  const deferred = reviews[0]!;
  const accepted = reviews[1]!;
  sourceDb = openWorkspaceDb(source.dataRoot, source.workspaceId);
  const receipts = reviews.map((review) => {
    const receipt = source.store.getCommandRequest(
      'knowledge.proposal.decide',
      review.requestId,
      { workspaceId: source.workspaceId, actorId: FIXTURE_LOCAL_USER_ID },
      sourceDb
    );
    expect(receipt).not.toBeNull();
    return receipt!;
  });
  const audits = listSqliteAuditEvents(sourceDb.sqlite, source.workspaceId).filter((event) =>
    reviews.some((review) => review.requestId === event.requestId)
  );
  for (const review of reviews)
    expect(audits.some((event) => event.requestId === review.requestId)).toBe(true);
  const proposalBytes = readFileSync(source.proposalPath, 'utf8');
  const reviewBytes = readFileSync(source.reviewPath, 'utf8');
  const knowledgeBaseId = readDefaultKnowledgeBaseId({
    dataRoot: source.dataRoot,
    scope: { kind: 'workspace', workspaceId: source.workspaceId },
  });
  const owner = { kind: 'workspace' as const, workspaceId: source.workspaceId };
  const contentRoot = join(root, 'immutable');
  const stagingRoot = join(root, 'staging');
  mkdirSync(contentRoot);
  mkdirSync(stagingRoot);
  const contentStorage = new LocalStorage({
    stagingRoot,
    mounts: [{ knowledgeBaseId, ownerScope: owner, name: 'private', root: contentRoot }],
  });
  storage = contentStorage;
  const access: StorageAccess = {
    basis: 'lease',
    grantId: allocateEntityId('grant'),
    knowledgeBaseId,
    ownerScope: owner,
    mount: 'private',
    pathPrefix: '',
    mode: 'staged-write',
    expiresAt: '2099-01-01T00:00:00.000Z',
    revoked: false,
  };
  const publish = async (text: string) => {
    const bytes = Buffer.from(text);
    const { handle } = storageValue(
      await contentStorage.beginStage({
        access,
        locator: { ownerScope: owner, mount: 'private', path: 'original.txt' },
        maxByteLength: bytes.length,
      })
    );
    storageValue(
      await contentStorage.writeStage({ access, handle, data: bytes.toString('base64') })
    );
    const stage = storageValue(await contentStorage.finishStage({ access, handle }));
    try {
      return await publishImmutableContent({
        storage: contentStorage,
        access,
        stage,
        mountRoot: contentRoot,
      });
    } finally {
      storageValue(await contentStorage.discardStage({ access, handle }));
    }
  };
  // Same-owner dormant metadata composition only; this target is not a Workspace migration.
  db = openWorkspaceDb(root, source.workspaceId);
  applyScopedMigrations(db);
  await client.open({
    database: 'proposal-tuple',
    path: workspaceDbPath(root, source.workspaceId),
    create: false,
    initialize: 'workspace',
    productOwner: owner,
    dataRoot: root,
  });
  source.notebook.inspectRevision(source.proposal.baseRevision);
  source.notebook.inspectRevision(source.proposal.candidateRevision);
  const head = {
    workspaceId: source.workspaceId,
    knowledgeBaseId,
    notebookCommit: source.proposal.baseRevision,
    schemaContent: await publish(
      readFileSync(join(source.workspaceRoot, 'knowledge/schema/scope-schema.yaml'), 'utf8')
    ),
  };
  const proposal: ControlKnowledgeProposal = {
    workspaceId: source.workspaceId,
    knowledgeBaseId,
    proposalId: source.proposal.id,
    baseRevision: source.proposal.baseRevision,
    candidateRevision: source.proposal.candidateRevision,
    contentDigest: source.proposal.contentDigest,
    documentContent: await publish(proposalBytes),
    target: { knowledgePageId: source.knowledgePageId },
  };
  expect(readControlKnowledgeProposal(db, proposal.proposalId)).toBeNull();
  await client.write('proposal-tuple', [
    ...controlKnowledgeHeadStatements(head, null),
    controlKnowledgeProposalStatement(proposal),
  ]);
  const metadata = db.sqlite
    .prepare('SELECT record_json FROM knowledge_notebook_proposals WHERE proposal_id = ?')
    .get(proposal.proposalId) as { record_json: string };
  const annotated = JSON.parse(metadata.record_json);
  annotated.target.futureNote = 'Inert retained target annotation';
  const annotatedJson = JSON.stringify(annotated);
  db.sqlite
    .prepare('UPDATE knowledge_notebook_proposals SET record_json = ? WHERE proposal_id = ?')
    .run(annotatedJson, proposal.proposalId);
  // COMPAT-001: retained descriptive additions are inert; both known target forms still conflict.
  expect(readControlKnowledgeProposal(db, proposal.proposalId)).toEqual({ proposal, reviews: [] });
  db.sqlite
    .prepare('UPDATE knowledge_notebook_proposals SET record_json = ? WHERE proposal_id = ?')
    .run(
      JSON.stringify({
        ...annotated,
        target: {
          ...annotated.target,
          changedPageIds: [source.knowledgePageId],
        },
      }),
      proposal.proposalId
    );
  expect(() => readControlKnowledgeProposal(db!, proposal.proposalId)).toThrow();
  expect(() => controlKnowledgeReviewStatement(db!, proposal.proposalId, deferred)).toThrow();
  db.sqlite
    .prepare('UPDATE knowledge_notebook_proposals SET record_json = ? WHERE proposal_id = ?')
    .run(annotatedJson, proposal.proposalId);
  const staleAccepted = controlKnowledgeReviewStatement(db, proposal.proposalId, accepted);
  const deferredStatement = controlKnowledgeReviewStatement(db, proposal.proposalId, deferred);
  const row = db.sqlite
    .prepare(
      'SELECT record_json, reviews_json FROM knowledge_notebook_proposals WHERE proposal_id = ?'
    )
    .get(proposal.proposalId) as { record_json: string; reviews_json: string };
  const futureCore = JSON.stringify({
    ...JSON.parse(row.record_json),
    requiredFeatures: ['unsupported-proposal-authority'],
  });
  db.sqlite
    .prepare('UPDATE knowledge_notebook_proposals SET record_json = ? WHERE proposal_id = ?')
    .run(futureCore, proposal.proposalId);
  expect(() => readControlKnowledgeProposal(db!, proposal.proposalId)).toThrow();
  await expect(client.write('proposal-tuple', [deferredStatement])).rejects.toThrow();
  expect(
    db.sqlite
      .prepare(
        'SELECT record_json, reviews_json FROM knowledge_notebook_proposals WHERE proposal_id = ?'
      )
      .get(proposal.proposalId)
  ).toEqual({ record_json: futureCore, reviews_json: row.reviews_json });
  db.sqlite
    .prepare('UPDATE knowledge_notebook_proposals SET record_json = ? WHERE proposal_id = ?')
    .run(row.record_json, proposal.proposalId);
  const deferredAudits = audits.filter((event) => event.requestId === deferred.requestId);
  await client.write('proposal-tuple', [
    deferredStatement,
    prepareControlCommandRequestStatement(source.workspaceId, receipts[0]!),
    ...deferredAudits.map(prepareAuditEventStatement),
  ]);
  const next = { ...head, notebookCommit: proposal.candidateRevision };
  const acceptedTuple = [
    ...controlKnowledgeHeadStatements(next, head),
    prepareControlCommandRequestStatement(source.workspaceId, receipts[1]!),
    ...audits
      .filter((event) => event.requestId === accepted.requestId)
      .map(prepareAuditEventStatement),
  ];
  // NotebookEditing11/DX147: stale append must roll back every earlier tuple member.
  await expect(client.write('proposal-tuple', [...acceptedTuple, staleAccepted])).rejects.toThrow();
  expect(readControlKnowledgeHead(db, knowledgeBaseId)).toEqual(head);
  expect(readControlKnowledgeProposal(db, proposal.proposalId)).toEqual({
    proposal,
    reviews: [deferred],
  });
  expect(getCommandRequestRecordFromDb(db, receipts[1]!.key, receipts[1]!.createdAt)).toBeNull();
  expect(listSqliteAuditEvents(db.sqlite, source.workspaceId)).toEqual(deferredAudits);
  await client.write('proposal-tuple', [
    ...acceptedTuple,
    controlKnowledgeReviewStatement(db, proposal.proposalId, accepted),
  ]);
  const beforeRefusal = db.sqlite.serialize();
  const requestId = randomUUID();
  // Deliberate invalid-order input; this new identity is not an emitted human Review.
  const terminalFault = {
    ...deferred,
    requestId,
    reviewId: deriveEntityId('kr', {
      ownerScope: owner,
      proposalId: proposal.proposalId,
      requestId,
    }),
  };
  expect(() => controlKnowledgeReviewStatement(db!, proposal.proposalId, terminalFault)).toThrow();
  expect(() =>
    controlKnowledgeReviewStatement(db!, proposal.proposalId, {
      ...accepted,
      decidedAt: new Date(Date.parse(accepted.decidedAt) + 1_000).toISOString(),
    })
  ).toThrow();
  expect(db.sqlite.serialize()).toEqual(beforeRefusal);
  await client.shutdown();
  db.sqlite.close();
  db = openWorkspaceDb(root, source.workspaceId);
  expect(readControlKnowledgeHead(db, knowledgeBaseId)).toEqual(next);
  expect(readControlKnowledgeProposal(db, proposal.proposalId)).toEqual({ proposal, reviews });
  expect(
    db.sqlite
      .prepare('SELECT record_json FROM knowledge_notebook_proposals WHERE proposal_id = ?')
      .get(proposal.proposalId)
  ).toEqual({ record_json: annotatedJson });
  for (const receipt of receipts)
    expect(getCommandRequestRecordFromDb(db, receipt.key, receipt.createdAt)).toEqual(receipt);
  expect(listSqliteAuditEvents(db.sqlite, source.workspaceId)).toEqual(audits);
  expect(
    readFileSync(join(contentRoot, proposal.documentContent.reference.locator.path), 'utf8')
  ).toBe(proposalBytes);
  expect(readFileSync(source.proposalPath, 'utf8')).toBe(proposalBytes);
  expect(readFileSync(source.reviewPath, 'utf8')).toBe(reviewBytes);
});
