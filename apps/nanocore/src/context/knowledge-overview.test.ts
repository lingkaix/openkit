import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { KnowledgeNotebook } from '../knowledge/notebook.js';
import { initializeScopedNotebook } from '../knowledge/scoped-notebook-owner.js';
import { FsStore } from '../lib/store.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { KNOWLEDGE_OVERVIEW_BYTES, prepareKnowledgeOverview } from './knowledge-overview.js';

/** Real notebooks and live authority; no retrieval index or Provider is required for navigation. */
function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'knowledge-overview-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Overview');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  const thread = store.createThread(workspace.id, 'Working agent');
  const actor = { kind: 'user' as const, id: userId };
  const turn = store.createTurn(workspace.id, thread.id, 'Ask about Knowledge', actor);
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(dataRoot, 'workspaces', workspace.id, 'knowledge', 'notebook.git'),
  });
  onTestFinished(() => {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  return {
    store,
    coreDb,
    workspaceId: workspace.id,
    threadId: thread.id,
    turnId: turn.id,
    actor,
    userId,
    notebook,
  };
}

/** Publishes a real human root revision through the existing Git owner. */
function publishIndex(f: ReturnType<typeof fixture>, content: string) {
  const baseRevision = f.notebook.publishedRevision();
  const candidateRevision = f.notebook.prepare({
    baseRevision,
    changes: { 'index.md': content },
    metadata: {
      summary: 'Update overview',
      producer: f.actor,
      authority: { kind: 'direct', instructionReference: 'test:overview' },
      changeRequest: { requestId: randomUUID(), inputDigest: `sha256:${'a'.repeat(64)}` },
      sourceReferences: [],
    },
  });
  f.notebook.publish({ baseRevision, candidateRevision });
  return candidateRevision;
}

it('delivers a bounded UTF-8 overview at its source revision, stays pinned after publication and rechecks current authority', () => {
  const f = fixture();
  const content = `---\nokf_version: "0.2"\n---\n# Admissions\n${'€'.repeat(2000)}`;
  const revision = publishIndex(f, content);
  const result = prepareKnowledgeOverview(f);
  const payload = JSON.parse(
    result.text.split('<knowledge_overviews>')[1]!.split('</knowledge_overviews>')[0]!
  );
  expect(payload.instruction).toContain('knowledge_ask');
  expect(payload.overviews).toHaveLength(1);
  const overview = payload.overviews[0];
  expect(overview).toMatchObject({
    scope: `workspace:${f.workspaceId}`,
    path: 'index.md',
    notebookRevision: revision,
    contentDigest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    truncated: true,
  });
  expect(Buffer.byteLength(overview.content)).toBeLessThanOrEqual(KNOWLEDGE_OVERVIEW_BYTES);
  expect(overview.content).not.toContain('�');
  expect(overview.deliveredDigest).toBe(
    `sha256:${createHash('sha256').update(overview.content).digest('hex')}`
  );
  publishIndex(f, '---\nokf_version: "0.2"\n---\n# Later overview\n');
  expect(() => result.assertCurrent()).not.toThrow();
  expect(result.text).not.toContain('Later overview');
  // A Workspace credential with no current membership cannot reuse the pinned projection.
  f.coreDb.sqlite
    .prepare(
      "UPDATE workspace_members SET status = 'removed', removed_at = updated_at WHERE workspace_id = ?"
    )
    .run(f.workspaceId);
  expect(() => result.assertCurrent()).toThrow();
});

it('includes Server navigation only with the admitted current credential and marks unavailable indexes without diagnostics', () => {
  const f = fixture();
  const requestActor = { kind: 'local' as const, userId: f.userId };
  initializeScopedNotebook({
    coreDb: f.coreDb,
    actor: requestActor,
    target: { kind: 'server' },
    initialization: { requestId: randomUUID(), instructionReference: 'test:overview' },
  });
  const withoutServer = prepareKnowledgeOverview(f);
  expect(withoutServer.text).not.toContain('"scope":"server"');
  const admitted = prepareKnowledgeOverview({ ...f, requestActor });
  expect(admitted.text).toContain('"scope":"server"');
  expect(admitted.text).not.toContain('"unavailable":true');
  expect(() => admitted.assertCurrent()).not.toThrow();
  const unavailable = prepareKnowledgeOverview({ ...f, threadId: 'not-admitted' });
  expect(unavailable.text).toContain('"unavailable":true');
  expect(unavailable.text).not.toContain(f.coreDb.dataRoot);
});
