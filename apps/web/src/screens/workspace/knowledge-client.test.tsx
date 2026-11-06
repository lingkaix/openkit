import type { CoreClient } from '@openkit/core-client';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { KNOWLEDGE_NOTEBOOK_PAGE_LIMIT, workspaceKeys } from './data';
import { createOpenKitKnowledgeClient } from './knowledge-client';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const WORKSPACE_ID = 'ws_00000000-0000-7000-8000-000000000001';

function page(id: string, fields: { updatedAt?: string | null; parentId?: string | null } = {}) {
  return {
    id,
    path: `${id}.md`,
    content: 'Notes',
    contentDigest: DIGEST,
    ...fields,
  };
}

function client(operations: Partial<CoreClient['operations']>) {
  return { operations } as CoreClient;
}

describe('OpenKit knowledge cursor', () => {
  it('serves the loaded page and its server cursor without another list', async () => {
    const list = vi.fn();
    const adapter = createOpenKitKnowledgeClient({
      core: client({ 'knowledge.notebook.list': list }),
      workspaceId: WORKSPACE_ID,
      pages: [page('page-1', { updatedAt: '2026-10-16T00:00:00Z', parentId: null })],
      revision: 'rev-1',
      nextCursor: 'cursor-2',
    });

    const listed = await adapter.list(null);
    expect(listed.nodes).toEqual([
      expect.objectContaining({
        id: 'page-1',
        parentId: null,
        updatedAt: '2026-10-16T00:00:00Z',
      }),
    ]);
    expect(listed.nextCursor).toBe('cursor-2');
    expect(list).not.toHaveBeenCalled();
  });

  it('loads the next notebook page only when the server returns a cursor', async () => {
    const list = vi.fn(async (input: { cursor?: string }) =>
      input.cursor === 'cursor-2'
        ? {
            knowledgeBaseId: 'kb',
            notebookRevision: 'rev-2',
            pages: [page('page-2')],
            nextCursor: null,
          }
        : {
            knowledgeBaseId: 'kb',
            notebookRevision: 'rev-1',
            pages: [page('page-1')],
            nextCursor: 'cursor-2',
          }
    );
    const queries = new QueryClient();
    const key = workspaceKeys.knowledge(WORKSPACE_ID);
    queries.setQueryData(key, {
      knowledgeBaseId: 'kb',
      notebookRevision: 'rev-1',
      pages: [page('page-1')],
      nextCursor: 'cursor-2',
    });
    const adapter = createOpenKitKnowledgeClient({
      core: client({ 'knowledge.notebook.list': list }),
      workspaceId: WORKSPACE_ID,
      pages: [page('page-1')],
      revision: 'rev-1',
      nextCursor: 'cursor-2',
      queryClient: queries,
    });

    const listed = await adapter.list(null, 'cursor-2');
    expect(listed.nodes.map((node) => node.id)).toEqual(['page-2']);
    expect(listed.nextCursor).toBeNull();
    expect(list).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      limit: KNOWLEDGE_NOTEBOOK_PAGE_LIMIT,
      cursor: 'cursor-2',
    });
    expect(queries.getQueryData(key)).toEqual(
      expect.objectContaining({
        pages: [page('page-1'), page('page-2')],
        nextCursor: null,
      })
    );
    expect(JSON.stringify(queries.getQueryData(key))).not.toContain('cursor-2');
  });
});
