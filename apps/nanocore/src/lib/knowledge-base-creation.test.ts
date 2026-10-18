import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateEntityId, KnowledgeBaseIdSchema } from '@openkit/protocol';
import { expect, it, onTestFinished } from 'vitest';
import { readDefaultKnowledgeBaseId } from '../config/knowledge-base.js';
import { FsStore } from './store.js';

it('publishes one independent default base with each new Workspace and retains it after restart', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'workspace-base-creation-'));
  onTestFinished(() => rmSync(dataRoot, { recursive: true, force: true }));
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('First base');
  const owner = { dataRoot, scope: { kind: 'workspace' as const, workspaceId: workspace.id } };
  const knowledgeBaseId = readDefaultKnowledgeBaseId(owner);
  expect(KnowledgeBaseIdSchema.safeParse(knowledgeBaseId).success).toBe(true);
  const other = store.createWorkspace('Another base');
  expect(
    readDefaultKnowledgeBaseId({
      dataRoot,
      scope: { kind: 'workspace', workspaceId: other.id },
    })
  ).not.toBe(knowledgeBaseId);
  expect(new FsStore({ dataRoot }).getWorkspace(workspace.id)).toEqual(
    store.getWorkspace(workspace.id)
  );
  expect(readDefaultKnowledgeBaseId(owner)).toBe(knowledgeBaseId);
});

it('retains the trusted reminted import base before Notebook publication', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'workspace-base-import-'));
  onTestFinished(() => rmSync(dataRoot, { recursive: true, force: true }));
  const store = new FsStore({ dataRoot });
  const source = store.createWorkspace('Source');
  const workspaceId = allocateEntityId('ws');
  const knowledgeBaseId = allocateEntityId('kb');
  let stagedBase: unknown;
  store.importWorkspaceSnapshot({
    workspace: { ...source, id: workspaceId, name: 'Imported' },
    defaultKnowledgeBaseId: knowledgeBaseId,
    threads: [], turns: [], knowledge: [], itemRevisions: [], artifacts: [], agentSessions: [], turnEvents: [],
    initialNotebookFiles: {},
    notebookInitialization: {
      requestId: randomUUID(),
      producer: {kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001'},
      instructionReference: 'test:workspace-base-import',
    },
    stageWorkspace: ({ workspaceRoot }) => {
      stagedBase = JSON.parse(readFileSync(join(workspaceRoot, 'config', 'workspace.jsonc'), 'utf8')).workspace.defaultKnowledgeBaseId;
    },
  });
  expect(stagedBase).toBe(knowledgeBaseId);
  expect(readDefaultKnowledgeBaseId({dataRoot, scope: {kind: 'workspace', workspaceId}})).toBe(knowledgeBaseId);
});
