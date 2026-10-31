import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { listSqliteAuditEvents } from '../audit-events.js';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { FsStore } from '../lib/store.js';
import { createAppWithLocalIdentity } from '../test-support/app.js';
import {
  authorityRequestId,
  call,
  createFixture,
  decide,
} from '../test-support/knowledge-proposal-authority.js';
import { FIXTURE_LOCAL_USER_ID } from '../test-support/local-user.js';
import {
  readControlKnowledgeHead,
  readControlKnowledgeProposal,
} from './control-store-knowledge.js';
import { shutdownControlStoreWorkerClient } from './control-store-worker-client.js';
import { openWorkspaceDb, type WorkspaceDb } from './db.js';

function git(repositoryPath: string, ...args: string[]) {
  return execFileSync('git', ['--git-dir', repositoryPath, ...args], { encoding: 'utf8' }).trim();
}

it('selects the SQL Knowledge authority across stale projections and cold replay', async () => {
  const f = await createFixture('live-authority-cutover');
  let db: WorkspaceDb = openWorkspaceDb(f.dataRoot, f.workspaceId);
  onTestFinished(() => {
    if (db.sqlite.open) db.sqlite.close();
  });
  const knowledgeBaseId = readDefaultKnowledgeBaseId({
    dataRoot: f.dataRoot,
    scope: { kind: 'workspace', workspaceId: f.workspaceId },
  });
  const initialHead = readControlKnowledgeHead(db, knowledgeBaseId);

  // Expected RED before live activation: an actual fresh Workspace has no SQL Notebook head.
  expect(initialHead).toMatchObject({
    workspaceId: f.workspaceId,
    knowledgeBaseId,
    notebookCommit: f.proposal.baseRevision,
  });

  const reviewLabel = 'live-authority-accepted';
  const requestId = authorityRequestId(reviewLabel);
  const accepted = await decide(f, 'accepted', reviewLabel);
  const selectedRevision = f.proposal.candidateRevision;
  const head = readControlKnowledgeHead(db, knowledgeBaseId);
  const proposal = readControlKnowledgeProposal(db, f.proposal.id);
  expect(head).toMatchObject({ notebookCommit: selectedRevision });
  expect(proposal?.reviews).toContainEqual(accepted.review);

  const scope = { workspaceId: f.workspaceId, actorId: FIXTURE_LOCAL_USER_ID };
  const receipt = f.store.getCommandRequest('knowledge.proposal.decide', requestId, scope, db);
  expect(receipt).not.toBeNull();
  const audits = listSqliteAuditEvents(db.sqlite, f.workspaceId).filter(
    (event) => event.requestId === requestId
  );
  expect(audits.length).toBeGreaterThan(0);
  const headBytes = db.sqlite
    .prepare('SELECT record_json FROM knowledge_notebook_heads WHERE knowledge_base_id = ?')
    .pluck()
    .get(knowledgeBaseId) as string;

  const listed = await call(f, 'knowledge.notebook.list', {});
  const history = await call(f, 'knowledge.notebook.history', { limit: 10 });
  const replay = await decide(f, 'accepted', reviewLabel);
  expect(listed).toMatchObject({ notebookRevision: selectedRevision });
  expect(listed.pages).toContainEqual(
    expect.objectContaining({ id: f.knowledgePageId, content: f.canonicalPageBytes })
  );
  expect(history.revisions).toContainEqual(expect.objectContaining({ revision: selectedRevision }));
  expect(replay).toEqual(accepted);

  const schemaPath = join(f.workspaceRoot, 'knowledge/schema/scope-schema.yaml');
  git(f.repositoryPath, 'update-ref', 'refs/heads/published', f.proposal.baseRevision);
  rmSync(schemaPath, { force: true });
  expect(await call(f, 'knowledge.notebook.list', {})).toEqual(listed);
  expect(await call(f, 'knowledge.notebook.history', { limit: 10 })).toEqual(history);
  expect(await decide(f, 'accepted', reviewLabel)).toEqual(accepted);
  expect(git(f.repositoryPath, 'rev-parse', 'refs/heads/published')).toBe(f.proposal.baseRevision);
  expect(existsSync(schemaPath)).toBe(false);
  expect(f.store.getCommandRequest('knowledge.proposal.decide', requestId, scope, db)).toEqual(
    receipt
  );
  expect(
    listSqliteAuditEvents(db.sqlite, f.workspaceId).filter((event) => event.requestId === requestId)
  ).toEqual(audits);

  await shutdownControlStoreWorkerClient();
  db.sqlite.close();
  db = openWorkspaceDb(f.dataRoot, f.workspaceId);
  const coldStore = new FsStore({ dataRoot: f.dataRoot });
  const cold = {
    ...f,
    store: coldStore,
    app: createAppWithLocalIdentity({ coreDb: f.coreDb, dataRoot: f.dataRoot, store: coldStore }),
  };
  expect(readControlKnowledgeHead(db, knowledgeBaseId)).toEqual(head);
  expect(readControlKnowledgeProposal(db, f.proposal.id)).toEqual(proposal);
  expect(
    db.sqlite
      .prepare('SELECT record_json FROM knowledge_notebook_heads WHERE knowledge_base_id = ?')
      .pluck()
      .get(knowledgeBaseId)
  ).toBe(headBytes);
  expect(coldStore.getCommandRequest('knowledge.proposal.decide', requestId, scope, db)).toEqual(
    receipt
  );
  expect(
    listSqliteAuditEvents(db.sqlite, f.workspaceId).filter((event) => event.requestId === requestId)
  ).toEqual(audits);
  expect(await call(cold, 'knowledge.notebook.list', {})).toEqual(listed);
  expect(await call(cold, 'knowledge.notebook.history', { limit: 10 })).toEqual(history);
  expect(await decide(cold, 'accepted', reviewLabel)).toEqual(accepted);
  expect(git(f.repositoryPath, 'rev-parse', 'refs/heads/published')).toBe(f.proposal.baseRevision);
  expect(existsSync(schemaPath)).toBe(false);

  const raw = db.sqlite
    .prepare('SELECT record_json FROM knowledge_notebook_heads WHERE knowledge_base_id = ?')
    .pluck()
    .get(knowledgeBaseId) as string;
  db.sqlite
    .prepare('UPDATE knowledge_notebook_heads SET record_json = ? WHERE knowledge_base_id = ?')
    .run(
      JSON.stringify({ ...JSON.parse(raw), requiredFeatures: ['future-knowledge-head'] }),
      knowledgeBaseId
    );
  const beforeRefusal = db.sqlite.serialize();
  await expect(call(cold, 'knowledge.notebook.list', {})).rejects.toMatchObject({
    code: 'recovery_required',
  });
  expect(db.sqlite.serialize()).toEqual(beforeRefusal);
});
