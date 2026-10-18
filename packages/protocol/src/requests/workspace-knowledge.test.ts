import { describe, expect, it } from 'vitest';
import { ListKnowledgeEntriesResponseSchema } from './workspace.js';

describe('Workspace Knowledge collection identity', () => {
  it('exposes the exact selected Knowledge Base even for an empty collection', () => {
    const knowledgeBaseId = 'kb_0190f4c8-0000-7000-8000-000000000001';
    const response = { knowledgeBaseId, notebookRevision: '1'.repeat(40), items: [] };
    expect(ListKnowledgeEntriesResponseSchema.parse(response)).toEqual(response);
    expect(
      ListKnowledgeEntriesResponseSchema.safeParse({
        notebookRevision: response.notebookRevision,
        items: [],
      }).success
    ).toBe(false);
    expect(
      ListKnowledgeEntriesResponseSchema.safeParse({
        ...response,
        knowledgeBaseId: 'ws_0190f4c8-0000-7000-8000-000000000001',
      }).success
    ).toBe(false);
  });
});
