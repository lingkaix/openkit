import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeBaseIdSchema } from '@openkit/protocol';
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
