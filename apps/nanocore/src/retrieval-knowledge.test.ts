import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { answerKnowledgeManager } from './knowledge-manager.js';
import { FsStore } from './lib/store.js';
import { closeRetrievalServices } from './retrieval-service.js';

const testRoots: string[] = [];
afterEach(async () => {
  await closeRetrievalServices();
  for (const root of testRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Knowledge retrieval and answer segmentation', () => {
  it.each([
    {
      title: 'Chinese body',
      body: '我们完成了测试，并修复了缺陷。',
      one: '测试',
      two: '测试 修复',
    },
    { title: 'Japanese body', body: '検索機能を改善しました。', one: '検索', two: '検索 改善' },
  ])('preserves one-term title sufficiency and cites two body terms: $title', async ({
    body,
    one,
    two,
  }) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'retrieval-knowledge-cjk-'));
    testRoots.push(dataRoot);
    const store = new FsStore({ dataRoot });
    const workspace = store.createWorkspace('Knowledge segmentation');
    const page = store.createKnowledgeEntry(workspace.id, {
      kind: 'project-context',
      title: 'Unrelated',
      content: body,
    });
    const answer = (query: string) =>
      answerKnowledgeManager({
        dataRoot,
        workspaceId: workspace.id,
        operationId: `answer-${query}`,
        caller: 'app-api',
        query,
        access: {
          store,
          actor: { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
          requestActor: { kind: 'local', userId: 'usr_00000000-0000-7000-8000-000000000001' },
        },
      });
    expect(await answer(one)).toMatchObject({ outcome: 'insufficient-evidence', citations: [] });
    expect(await answer(two)).toMatchObject({
      outcome: 'answered',
      citations: [{ reference: { scopeId: `page/workspace/${workspace.id}`, objectId: page.id } }],
    });
    store.updateKnowledgeEntry(workspace.id, page.id, { title: one });
    expect(await answer(one)).toMatchObject({
      outcome: 'answered',
      citations: [{ reference: { scopeId: `page/workspace/${workspace.id}`, objectId: page.id } }],
    });
  });
});
