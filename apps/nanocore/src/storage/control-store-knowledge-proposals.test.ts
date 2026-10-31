import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
  prepareControlKnowledgeAuthorityTransfer,
  prepareControlKnowledgeProposal,
  readControlKnowledgeHead,
  readControlKnowledgeProposal,
} from './control-store-knowledge.js';
import { getControlStoreWorkerClient } from './control-store-worker-client.js';
import { openWorkspaceDb, type WorkspaceDb } from './db.js';
import { workspaceDbPath } from './fs-layout.js';
import { type ImmutableContentHandoff, publishImmutableContent } from './immutable-content.js';
import {
  applyNativeScopeMigrations,
  applyScopedMigrations,
  listAppliedNativeMigrationIds,
} from './migrate.js';
import { serializeKnowledgeProposalRecord } from './workspace-file-records.js';

/** Requires actual Storage stage and publication success, never a fabricated descriptor. */
function storageValue<T>(result: StorageResult<T>): T {
  expect(result.status).toBe('ok');
  if (result.status !== 'ok') throw new Error(`Storage setup refused: ${result.status}`);
  return result.value;
}

// Real Git/SQLite preparation and the full rollback matrix measured 37s with V8 coverage.
// The 60s per-case harness budget is not a product latency requirement.
it('commits original ordered Reviews with the exact head, receipt and Audit or rolls back the whole tuple', {
  timeout: 60_000,
}, async () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  const root = mkdtempSync(join(tmpdir(), 'control-knowledge-proposals-'));
  const client = getControlStoreWorkerClient();
  let db: WorkspaceDb | undefined;
  let sourceDb: WorkspaceDb | undefined;
  let transferDb: WorkspaceDb | undefined;
  let storage: LocalStorage | undefined;
  onTestFinished(async () => {
    await client.shutdown();
    if (db?.sqlite.open) db.sqlite.close();
    if (sourceDb?.sqlite.open) sourceDb.sqlite.close();
    if (transferDb?.sqlite.open) transferDb.sqlite.close();
    await storage?.close();
    for (const cleanup of cleanups.reverse()) await cleanup();
    rmSync(root, { recursive: true, force: true });
  });
  const source = await createFixture('native-proposal-tuple', true, (cleanup) =>
    cleanups.push(cleanup)
  );
  await decide(source, 'deferred', 'native-proposal-deferred');
  await decide(source, 'accepted', 'native-proposal-accepted');
  sourceDb = openWorkspaceDb(source.dataRoot, source.workspaceId);
  const sourceState = readControlKnowledgeProposal(sourceDb, source.proposal.id);
  expect(sourceState).not.toBeNull();
  const originalProposal = source.proposal;
  const reviews = sourceState!.reviews;
  expect(reviews.map((review) => review.decision)).toEqual(['deferred', 'accepted']);
  const deferred = reviews[0]!;
  const accepted = reviews[1]!;
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
  const sourceReviewRow = sourceDb.sqlite
    .prepare('SELECT reviews_json FROM knowledge_notebook_proposals WHERE proposal_id = ?')
    .get(source.proposal.id) as { reviews_json: string };
  const originalRawDecisions = JSON.parse(sourceReviewRow.reviews_json) as unknown[];
  expect(originalRawDecisions).toHaveLength(2);
  const knowledgeBaseId = readDefaultKnowledgeBaseId({
    dataRoot: source.dataRoot,
    scope: { kind: 'workspace', workspaceId: source.workspaceId },
  });
  const owner = { kind: 'workspace' as const, workspaceId: source.workspaceId };
  const sourceHead = readControlKnowledgeHead(sourceDb, knowledgeBaseId);
  expect(sourceHead).not.toBeNull();
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
  const stageContent = async (text: string): Promise<ImmutableContentHandoff> => {
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
    return { storage: contentStorage, access, stage, mountRoot: contentRoot };
  };
  const discard = async (content: ImmutableContentHandoff) =>
    storageValue(await contentStorage.discardStage({ access, handle: content.stage.handle }));
  const publish = async (text: string) => {
    const content = await stageContent(text);
    try {
      return await publishImmutableContent(content);
    } finally {
      await discard(content);
    }
  };
  // Same-owner dormant metadata composition only; this target is not a Workspace migration.
  db = openWorkspaceDb(root, source.workspaceId);
  applyScopedMigrations(db, undefined, 'pre-knowledge');
  const transferRoot = join(root, 'transfer');
  transferDb = openWorkspaceDb(transferRoot, source.workspaceId);
  applyScopedMigrations(transferDb, undefined, 'pre-knowledge');
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
  const sourceSchemaBytes = readFileSync(
    join(
      source.workspaceRoot,
      'knowledge',
      'content',
      sourceHead!.schemaContent.reference.locator.path
    ),
    'utf8'
  );
  const head = {
    workspaceId: source.workspaceId,
    knowledgeBaseId,
    notebookCommit: source.proposal.baseRevision,
    schemaContent: await publish(sourceSchemaBytes),
  };
  const content = await stageContent(proposalBytes);
  const expectedProposal: ControlKnowledgeProposal = {
    workspaceId: source.workspaceId,
    knowledgeBaseId,
    proposalId: source.proposal.id,
    baseRevision: source.proposal.baseRevision,
    candidateRevision: source.proposal.candidateRevision,
    contentDigest: source.proposal.contentDigest,
    documentContent: {
      ...content.stage.content,
      reference: {
        ...content.stage.content.reference,
        locator: {
          ...content.stage.content.reference.locator,
          path: `sha256/${content.stage.content.reference.contentDigest.slice('sha256:'.length)}`,
        },
      },
    },
    target: { knowledgePageId: source.knowledgePageId },
  };
  const beforePreparation = db.sqlite.serialize();
  const publishedRevision = sourceHead!.notebookCommit;
  const publishedFiles = readdirSync(contentRoot, { recursive: true }).sort();
  const unchangedBeforePublication = () => {
    expect(db!.sqlite.serialize()).toEqual(beforePreparation);
    expect(readControlKnowledgeHead(db!, knowledgeBaseId)).toBeNull();
    expect(readControlKnowledgeHead(sourceDb!, knowledgeBaseId)?.notebookCommit).toBe(
      publishedRevision
    );
    expect(readdirSync(contentRoot, { recursive: true }).sort()).toEqual(publishedFiles);
    expect(readFileSync(source.proposalPath, 'utf8')).toBe(proposalBytes);
  };
  const preparation = { db, knowledgeBaseId, notebook: source.notebook, content };
  let proposal: ControlKnowledgeProposal;
  try {
    // NotebookEditing13: document bytes alone cannot prove the supplied candidate body.
    const bodyFault = {
      ...originalProposal,
      canonicalPageBytes: `${originalProposal.canonicalPageBytes}\nAdditional valid Markdown.\n`,
    };
    expect(serializeKnowledgeProposalRecord(bodyFault)).toBe(proposalBytes);
    await expect(
      prepareControlKnowledgeProposal({ ...preparation, proposal: bodyFault })
    ).rejects.toThrow();
    unchangedBeforePublication();
    const lineageFault = { ...originalProposal, candidateRevision: originalProposal.baseRevision };
    const wrongCandidateContent = await stageContent(
      serializeKnowledgeProposalRecord(lineageFault)
    );
    try {
      await expect(
        prepareControlKnowledgeProposal({
          ...preparation,
          proposal: lineageFault,
          content: wrongCandidateContent,
        })
      ).rejects.toThrow();
      unchangedBeforePublication();
    } finally {
      await discard(wrongCandidateContent);
    }
    proposal = await prepareControlKnowledgeProposal({
      ...preparation,
      proposal: originalProposal,
    });
    expect(proposal).toEqual(expectedProposal);
    expect(db.sqlite.serialize()).toEqual(beforePreparation);
    expect(readControlKnowledgeHead(db, knowledgeBaseId)).toBeNull();
    expect(readControlKnowledgeHead(sourceDb!, knowledgeBaseId)?.notebookCommit).toBe(
      publishedRevision
    );
    expect(
      readFileSync(join(contentRoot, proposal.documentContent.reference.locator.path), 'utf8')
    ).toBe(proposalBytes);
  } finally {
    await discard(content);
  }
  const transferHead = sourceHead!;
  expect(transferHead.notebookCommit).toBe(proposal.candidateRevision);
  expect(
    readFileSync(join(contentRoot, transferHead.schemaContent.reference.locator.path))
  ).toEqual(Buffer.from(sourceSchemaBytes));
  const migrationRoot = new URL('../../drizzle/workspace/', import.meta.url);
  const productionJournal = JSON.parse(
    readFileSync(new URL('meta/_journal.json', migrationRoot), 'utf8')
  ) as {
    entries: Array<{
      breakpoints: boolean;
      idx: number;
      tag: string;
      version: string;
      when: number;
    }>;
  };
  expect(productionJournal.entries.at(-1)?.tag).toBe('0019_knowledge_authority');
  const authorityEntry = productionJournal.entries.at(-1)!;
  const authorityMigrationFolder = (name: string, failLedger: boolean) => {
    const folder = join(root, name);
    mkdirSync(join(folder, 'meta'), { recursive: true });
    for (const entry of productionJournal.entries)
      copyFileSync(new URL(`${entry.tag}.sql`, migrationRoot), join(folder, `${entry.tag}.sql`));
    writeFileSync(join(folder, 'meta/_journal.json'), JSON.stringify(productionJournal));
    if (failLedger)
      writeFileSync(
        join(folder, `${authorityEntry.tag}.sql`),
        `${readFileSync(new URL(`${authorityEntry.tag}.sql`, migrationRoot), 'utf8')}
--> statement-breakpoint
CREATE TEMP TRIGGER refuse_knowledge_authority_ledger
           BEFORE INSERT ON __drizzle_migrations
           WHEN NEW.created_at = ${authorityEntry.when}
           BEGIN
             SELECT RAISE(ABORT, 'deciding knowledge authority rollback');
           END;`
      );
    return folder;
  };
  expect(() =>
    prepareControlKnowledgeAuthorityTransfer({ db: sourceDb!, heads: [], proposals: [] })
  ).toThrow();
  const beforeRejectedReview = sourceDb.sqlite.serialize();
  expect(() =>
    prepareControlKnowledgeAuthorityTransfer({
      db: sourceDb!,
      heads: [transferHead],
      proposals: [
        {
          proposal,
          reviews: [
            {
              ...(originalRawDecisions[0] as Record<string, unknown>),
              requiredFeatures: ['future-review-authority'],
            },
            ...originalRawDecisions.slice(1),
          ],
        },
      ],
    })
  ).toThrow();
  expect(sourceDb.sqlite.serialize()).toEqual(beforeRejectedReview);
  const transferRawDecisions = originalRawDecisions.map((review, index) =>
    index === 0
      ? { ...(review as Record<string, unknown>), futureNote: 'Inert retained Review annotation' }
      : review
  );
  const sourceTransfer = prepareControlKnowledgeAuthorityTransfer({
    db: sourceDb,
    heads: [transferHead],
    proposals: [{ proposal, reviews: transferRawDecisions }],
  });
  const transfer = prepareControlKnowledgeAuthorityTransfer({
    db: transferDb,
    heads: [transferHead],
    proposals: [{ proposal, reviews: transferRawDecisions }],
  });
  const sourceReceipts = receipts.map((receipt) =>
    getCommandRequestRecordFromDb(sourceDb!, receipt.key, receipt.createdAt)
  );
  const sourceAudits = listSqliteAuditEvents(sourceDb.sqlite, source.workspaceId);
  const sourceFiles = {
    proposal: readFileSync(source.proposalPath),
    reviewsJson: sourceReviewRow.reviews_json,
    revision: sourceHead!.notebookCommit,
    immutable: readdirSync(contentRoot, { recursive: true }).sort(),
    schemaContent: readFileSync(join(contentRoot, head.schemaContent.reference.locator.path)),
    proposalContent: readFileSync(
      join(contentRoot, proposal.documentContent.reference.locator.path)
    ),
  };
  const assertOriginalEvidence = () => {
    expect(
      receipts.map((receipt) =>
        getCommandRequestRecordFromDb(sourceDb!, receipt.key, receipt.createdAt)
      )
    ).toEqual(sourceReceipts);
    expect(listSqliteAuditEvents(sourceDb!.sqlite, source.workspaceId)).toEqual(sourceAudits);
    expect(readFileSync(source.proposalPath)).toEqual(sourceFiles.proposal);
    expect(
      sourceDb!.sqlite
        .prepare('SELECT reviews_json FROM knowledge_notebook_proposals WHERE proposal_id = ?')
        .pluck()
        .get(source.proposal.id)
    ).toBe(sourceFiles.reviewsJson);
    expect(readControlKnowledgeHead(sourceDb!, knowledgeBaseId)?.notebookCommit).toBe(
      sourceFiles.revision
    );
    expect(readdirSync(contentRoot, { recursive: true }).sort()).toEqual(sourceFiles.immutable);
    expect(readFileSync(join(contentRoot, head.schemaContent.reference.locator.path))).toEqual(
      sourceFiles.schemaContent
    );
    expect(
      readFileSync(join(contentRoot, proposal.documentContent.reference.locator.path))
    ).toEqual(sourceFiles.proposalContent);
  };
  const successfulMigration = authorityMigrationFolder('authority-success', false);
  const targetBeforeMissingTransfer = transferDb.sqlite.serialize();
  expect(() =>
    applyNativeScopeMigrations(transferDb!.sqlite, 'workspace', successfulMigration)
  ).toThrow();
  expect(transferDb.sqlite.serialize()).toEqual(targetBeforeMissingTransfer);
  expect(
    listAppliedNativeMigrationIds(transferDb.sqlite, 'workspace', successfulMigration)
  ).not.toContain('workspace_0019_knowledge_authority');
  const targetBeforeWrongBinding = transferDb.sqlite.serialize();
  expect(() =>
    applyNativeScopeMigrations(transferDb!.sqlite, 'workspace', successfulMigration, sourceTransfer)
  ).toThrow();
  expect(transferDb.sqlite.serialize()).toEqual(targetBeforeWrongBinding);
  expect(
    listAppliedNativeMigrationIds(transferDb.sqlite, 'workspace', successfulMigration)
  ).not.toContain('workspace_0019_knowledge_authority');

  const failedMigration = authorityMigrationFolder('authority-rollback', true);
  expect(() =>
    applyNativeScopeMigrations(transferDb!.sqlite, 'workspace', failedMigration, transfer)
  ).toThrow();
  expect(readControlKnowledgeHead(transferDb, knowledgeBaseId)).toBeNull();
  expect(readControlKnowledgeProposal(transferDb, proposal.proposalId)).toBeNull();
  expect(
    listAppliedNativeMigrationIds(transferDb.sqlite, 'workspace', failedMigration)
  ).not.toContain('workspace_0019_knowledge_authority');
  assertOriginalEvidence();

  applyNativeScopeMigrations(transferDb.sqlite, 'workspace', successfulMigration, transfer);
  expect(readControlKnowledgeHead(transferDb, knowledgeBaseId)).toEqual(transferHead);
  expect(readControlKnowledgeProposal(transferDb, proposal.proposalId)).toEqual({
    proposal,
    reviews,
  });
  const retainedReviews = transferDb.sqlite
    .prepare('SELECT reviews_json FROM knowledge_notebook_proposals WHERE proposal_id = ?')
    .get(proposal.proposalId) as { reviews_json: string };
  expect(JSON.parse(retainedReviews.reviews_json)).toEqual(
    transferRawDecisions.map((review) => ({
      ...(review as Record<string, unknown>),
      requiredFeatures: [],
      schemaVersion: 1,
    }))
  );
  expect(
    listAppliedNativeMigrationIds(transferDb.sqlite, 'workspace', successfulMigration)
  ).toContain('workspace_0019_knowledge_authority');
  assertOriginalEvidence();
  const afterTransfer = transferDb.sqlite.serialize();
  applyNativeScopeMigrations(transferDb.sqlite, 'workspace', successfulMigration);
  expect(transferDb.sqlite.serialize()).toEqual(afterTransfer);
  assertOriginalEvidence();

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
  expect(
    sourceDb.sqlite
      .prepare('SELECT reviews_json FROM knowledge_notebook_proposals WHERE proposal_id = ?')
      .pluck()
      .get(source.proposal.id)
  ).toBe(sourceReviewRow.reviews_json);
});
