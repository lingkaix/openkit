import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJsonText, writeRetainedV1 } from '@openkit/protocol';
import { sha256Hex } from '@openkit/protocol/digest';
import { expect, it, onTestFinished } from 'vitest';
import { listSqliteAuditEvents } from '../audit-events.js';
import {
  createOpenKitAccessTokenRecord,
  type OpenKitAccessTokenRecord,
} from '../auth/access-token-store.js';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { readWorkspaceNotebookSelection } from '../knowledge/notebook-workspace-selection.js';
import { commandRequestExpiresAt, commandRequestKey } from '../lib/store.js';
import { commandInputHash } from '../runtime/idempotent-command.js';
import { createAppWithLocalIdentity } from '../test-support/app.js';
import { serializeKnowledgePageFixture } from '../test-support/knowledge-page.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { closeTestCoreDb, createTestCoreDb, createTestStore } from '../test-support/store.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { WorkspaceMutationAdmission } from '../workspace-mutation-admission.js';
import { readControlKnowledgeHead } from './control-store-knowledge.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openWorkspaceDb } from './db.js';

it('applies only the exact reviewed complete schema report under its exclusive freeze', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'schema-application-'));
  const coreDb = createTestCoreDb(dataRoot);
  const userId = ensureLocalUser(coreDb);
  let store = createTestStore({ dataRoot });
  const workspace = await store.createWorkspace('Reviewed schema application');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const admission = new WorkspaceMutationAdmission();
  let app = createAppWithLocalIdentity({
    mode: 'server',
    coreDb,
    dataRoot,
    store,
    workspaceMutationAdmission: admission,
  });
  let db = openWorkspaceDb(dataRoot, workspace.id);
  onTestFinished(async () => {
    await shutdownControlStoreWorkerClient();
    if (db.sqlite.open) db.sqlite.close();
    closeTestCoreDb(coreDb);
    rmSync(dataRoot, { recursive: true, force: true });
  });

  const owner = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: userId,
    scope: 'workspace',
    workspaceIds: [workspace.id],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  const reader = createOpenKitAccessTokenRecord(coreDb, {
    ownerUserId: userId,
    scope: 'workspace-readonly',
    workspaceIds: [workspace.id],
    expiresAt: '2999-01-01T00:00:00.000Z',
  });
  const request = (
    operation: string,
    token: Pick<OpenKitAccessTokenRecord, 'secret'>,
    input: Record<string, unknown>
  ) => {
    const requestId = typeof input.requestId === 'string' ? input.requestId : randomUUID();
    return app.request(`/api/app/operations/${operation}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token.secret}`,
        'content-type': 'application/json',
        'x-openkit-request-id': requestId,
      },
      body: JSON.stringify({ workspaceId: workspace.id, ...input, requestId }),
    });
  };
  const call = async (
    operation: string,
    token: Pick<OpenKitAccessTokenRecord, 'secret'>,
    input: Record<string, unknown>
  ) => {
    const response = await request(operation, token, input);
    const text = await response.clone().text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // The baseline has no apply projection; retain its transport response for the deciding RED.
    }
    return { response, body };
  };

  const workspaceRoot = join(dataRoot, 'workspaces', workspace.id);
  const knowledgeRoot = join(workspaceRoot, 'knowledge');
  const knowledgeBaseId = readDefaultKnowledgeBaseId({
    dataRoot,
    scope: { kind: 'workspace', workspaceId: workspace.id },
  });
  const initialSelection = readWorkspaceNotebookSelection({
    workspaceDb: db,
    workspaceRoot,
    knowledgeBaseId,
  });
  const originalSchema = initialSelection.scopeSchemaText;
  const firstRevision = initialSelection.notebook.publishedRevision();
  const content = serializeKnowledgePageFixture(
    {
      title: 'Existing observation',
      content: 'A retained record that the review must classify.',
      createdAt: '2026-10-31T00:00:00.000Z',
      updatedAt: '2026-10-31T00:00:00.000Z',
    },
    { kind: 'workspace', workspaceId: workspace.id }
  );
  const created = await call('knowledge.notebook.create', owner, {
    baseRevision: firstRevision,
    path: 'existing-observation.md',
    content,
    summary: 'Create one real schema review member.',
  });
  expect(created.response.status, JSON.stringify(created.body)).toBe(200);
  const baseRevision = readWorkspaceNotebookSelection({
    workspaceDb: db,
    workspaceRoot,
    knowledgeBaseId,
  }).notebook.publishedRevision();

  const preview = async (schemaText: string) => {
    const result = await call('knowledge.schema.preview', owner, { baseRevision, schemaText });
    expect(result.response.status, JSON.stringify(result.body)).toBe(200);
    return result.body as Record<string, unknown>;
  };
  const restrictiveSchema = originalSchema.replace(/^allowed_types:.*$/m, 'allowed_types: [Claim]');
  const unrepaired = await preview(restrictiveSchema);
  expect(unrepaired.records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: 'existing-observation.md', status: 'needs-review' }),
    ])
  );
  const unrepairedRefusal = await call('knowledge.schema.apply', owner, {
    requestId: randomUUID(),
    baseRevision,
    schemaText: restrictiveSchema,
    reviewedReport: unrepaired,
  });
  expect(unrepairedRefusal.response.status, JSON.stringify(unrepairedRefusal.body)).toBe(400);

  const candidateSchema = `${originalSchema.trimEnd()}\n# reviewed schema candidate\n`;
  const reviewedReport = await preview(candidateSchema);
  expect(reviewedReport).toMatchObject({
    workspaceId: workspace.id,
    notebookRevision: baseRevision,
    inventoryComplete: true,
  });
  expect(
    (reviewedReport.records as Array<{ status: string }>).every((row) => row.status === 'valid')
  ).toBe(true);
  const retainedReport = canonicalJsonText(
    writeRetainedV1({ requiredFeatures: [], reviewedReport })
  );
  const reportDigest = `sha256:${sha256Hex(retainedReport)}`;
  const requestId = randomUUID();
  const applyInput = {
    requestId,
    baseRevision,
    schemaText: candidateSchema,
    reviewedReport,
  };
  const initialHead = readControlKnowledgeHead(db, knowledgeBaseId);
  const initialAudits = listSqliteAuditEvents(db.sqlite, workspace.id);
  const initialReceipt = store.getCommandRequest(
    'knowledge.schema.apply',
    requestId,
    { workspaceId: workspace.id, actorId: userId },
    db
  );

  const changedCandidate = await call('knowledge.schema.apply', owner, {
    ...applyInput,
    requestId: randomUUID(),
    schemaText: `${candidateSchema}# not reviewed\n`,
  });
  expect(changedCandidate.response.status).toBe(409);
  const incomplete = structuredClone(reviewedReport) as {
    inventoryComplete: boolean;
    dependencyInventory: Array<Record<string, unknown>>;
  };
  incomplete.inventoryComplete = false;
  incomplete.dependencyInventory[0] = {
    ...incomplete.dependencyInventory[0],
    complete: false,
    inventoryDigest: undefined,
  };
  const incompleteRefusal = await call('knowledge.schema.apply', owner, {
    ...applyInput,
    requestId: randomUUID(),
    reviewedReport: incomplete,
  });
  expect(incompleteRefusal.response.status).toBe(400);
  const unauthorized = await call('knowledge.schema.apply', reader, applyInput);
  expect(unauthorized.response.status).toBe(403);

  const competing = admission.tryFreeze(workspace.id, () => []);
  expect(competing.status).toBe('frozen');
  if (competing.status !== 'frozen') throw new Error('Expected a real competing freeze.');
  const busy = await call('knowledge.schema.apply', owner, applyInput);
  expect(busy.response.status).toBe(409);
  expect(busy.body).toMatchObject({
    code: 'workspace_frozen',
    details: {
      workspaceId: workspace.id,
      retryable: true,
      blockers: expect.any(Array),
    },
  });
  expect(
    (busy.body as { details: { blockers: unknown[] } }).details.blockers.length
  ).toBeGreaterThan(0);
  competing.release();

  expect(readControlKnowledgeHead(db, knowledgeBaseId)).toEqual(initialHead);
  expect(listSqliteAuditEvents(db.sqlite, workspace.id)).toEqual(initialAudits);
  expect(
    store.getCommandRequest(
      'knowledge.schema.apply',
      requestId,
      { workspaceId: workspace.id, actorId: userId },
      db
    )
  ).toEqual(initialReceipt);
  const applied = await call('knowledge.schema.apply', owner, applyInput);
  expect(applied.response.status, JSON.stringify(applied.body)).toBe(200);
  expect(applied.body).toMatchObject({
    workspaceId: workspace.id,
    notebookRevision: baseRevision,
    baseSchemaDigest: reviewedReport.baseSchemaDigest,
    candidateSchemaDigest: reviewedReport.candidateSchemaDigest,
    reportDigest,
  });
  const head = readControlKnowledgeHead(db, knowledgeBaseId);
  expect(head).toMatchObject({ notebookCommit: baseRevision });
  expect(head?.schemaContent.reference.contentDigest).toBe(reviewedReport.candidateSchemaDigest);
  const receipt = store.getCommandRequest(
    'knowledge.schema.apply',
    requestId,
    { workspaceId: workspace.id, actorId: userId },
    db
  );
  expect(receipt).not.toBeNull();
  expect(new Date(receipt!.createdAt).toISOString()).toBe(receipt!.createdAt);
  expect(receipt).toEqual({
    key: commandRequestKey('knowledge.schema.apply', requestId, {
      workspaceId: workspace.id,
      actorId: userId,
    }),
    command: 'knowledge.schema.apply',
    requestId,
    scope: { workspaceId: workspace.id, actorId: userId },
    inputHash: commandInputHash({ workspaceId: workspace.id, ...applyInput }),
    response: { kind: 'knowledge_schema_report', id: reportDigest },
    createdAt: receipt!.createdAt,
    expiresAt: commandRequestExpiresAt(receipt!.createdAt),
  });
  const audits = listSqliteAuditEvents(db.sqlite, workspace.id).filter(
    (event) => event.requestId === requestId
  );
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({ outcome: 'succeeded' });

  const historyRoot = join(knowledgeRoot, 'schema', 'history');
  const historyBytes = readdirSync(historyRoot, { recursive: true })
    .map(String)
    .map((entry) => join(historyRoot, entry))
    .filter((entry) => statSync(entry).isFile())
    .map((entry) => readFileSync(entry, 'utf8'));
  expect(historyBytes).toEqual(expect.arrayContaining([originalSchema, candidateSchema]));
  expect(historyBytes).toContain(retainedReport);

  await shutdownControlStoreWorkerClient();
  db.sqlite.close();
  store = createTestStore({ dataRoot });
  app = createAppWithLocalIdentity({
    mode: 'server',
    coreDb,
    dataRoot,
    store,
    workspaceMutationAdmission: admission,
  });
  db = openWorkspaceDb(dataRoot, workspace.id);
  const replay = await call('knowledge.schema.apply', owner, applyInput);
  expect(replay.response.status, JSON.stringify(replay.body)).toBe(200);
  expect(replay.body).toEqual(applied.body);
  expect(readControlKnowledgeHead(db, knowledgeBaseId)).toEqual(head);
  expect(
    store.getCommandRequest(
      'knowledge.schema.apply',
      requestId,
      { workspaceId: workspace.id, actorId: userId },
      db
    )
  ).toEqual(receipt);
  expect(
    listSqliteAuditEvents(db.sqlite, workspace.id).filter((event) => event.requestId === requestId)
  ).toEqual(audits);
  expect(
    readdirSync(historyRoot, { recursive: true })
      .map(String)
      .map((entry) => join(historyRoot, entry))
      .filter((entry) => statSync(entry).isFile())
      .map((entry) => readFileSync(entry, 'utf8'))
  ).toEqual(historyBytes);
});
