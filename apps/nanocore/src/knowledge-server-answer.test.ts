import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { createRuntimeConfigManager } from './config/runtime-config.js';
import { KnowledgeNotebook } from './knowledge/notebook.js';
import { initializeScopedNotebook } from './knowledge/scoped-notebook-owner.js';
import { publishScopedNotebook } from './knowledge/scoped-notebook-publication.js';
import { FsStore } from './lib/store.js';
import { createOperationInvocation } from './operation-composition.js';
import { openCoreDb, openWorkspaceDb } from './storage/db.js';
import { applyMigrations, applyScopedMigrations } from './storage/migrate.js';
import { ensureLocalUser } from './test-support/local-user.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

it('projects an admitted Server citation through the existing answer operation with its actual scope', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'km-server-answer-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  const userId = ensureLocalUser(coreDb);
  onTestFinished(() => {
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const actor = { kind: 'local' as const, userId };
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Shared Knowledge reader');
  recordWorkspaceOwnerMembership({ coreDb, workspaceId: workspace.id, ownerUserId: userId });
  initializeScopedNotebook({
    coreDb,
    actor,
    target: { kind: 'server' },
    initialization: { requestId: randomUUID(), instructionReference: 'Create shared Knowledge.' },
  });
  const notebook = new KnowledgeNotebook({
    repositoryPath: join(dataRoot, 'server', 'knowledge', 'notebook.git'),
  });
  const content = `---
type: KnowledgePage
title: Shared release rule
schema_version: openkit-scope-knowledge-schema-v4
requiredFeatures: [openkit.knowledge-owner-scope.v1, openkit.knowledge-git-notebook.v1]
openkit_status: active
status: stable
scope: {kind: server}
source_refs: []
review_state: user-authored
sensitivity: normal
freshness: current
created_at: "2026-10-17T00:00:00.000Z"
updated_at: "2026-10-17T00:00:00.000Z"
---
Release after the shared gate passes.
`;
  const published = await publishScopedNotebook(
    {
      coreDb,
      actor,
      store,
      target: { kind: 'server' },
      runtimeConfigManager: createRuntimeConfigManager({ dataRoot }),
      inflightCommands: new WeakMap(),
    },
    {
      requestId: randomUUID(),
      baseRevision: notebook.publishedRevision(),
      summary: 'Save shared release rule',
      changes: [{ path: 'release-rule.md', content }],
    }
  );
  const thread = store.createThread(
    workspace.id,
    'Knowledge answer',
    undefined,
    'knowledge-manager'
  );
  const turn = store.createTurn(
    workspace.id,
    thread.id,
    'Release rule',
    { kind: 'user', id: userId },
    null,
    { agentId: 'knowledge-manager', executorKind: 'assistant' }
  );
  const invoke = createOperationInvocation({
    coreDb,
    store,
    inflightCommands: new WeakMap(),
    workspaceMutationAdmission: new WorkspaceMutationAdmission(),
    repositoryWorkspaceDb: (workspaceId) => {
      const db = openWorkspaceDb(dataRoot, workspaceId);
      applyScopedMigrations(db);
      return db;
    },
    knowledgeAgent: {
      ask: async () => ({
        threadId: thread.id,
        turnId: turn.id,
        answer: 'Wait for the shared gate.',
        uncertainty: null,
        citations: [
          {
            reference: `page/server/release-rule@${published.notebookRevision}`,
            revision: published.notebookRevision,
            contentDigest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
            sourceReferences: [],
          },
        ],
      }),
      maintain: async () => {
        throw new Error('This read has no maintenance effect.');
      },
    },
  });
  const result = await invoke(
    'knowledge.answer',
    { workspaceId: workspace.id, query: 'When can we release?' },
    { kind: 'public', actor }
  );
  expect(result).toMatchObject({
    outcome: 'answered',
    answer: 'Wait for the shared gate.',
    citations: [
      {
        reference: { scopeId: 'page/server', objectId: 'release-rule' },
        title: 'Shared release rule',
        excerpt: 'Release after the shared gate passes.',
      },
    ],
  });
});
