import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import {
  KNOWLEDGE_NOTEBOOK_DIFF_TEXT_LIMIT_BYTES,
  KnowledgeNotebookDiffRequestSchema,
  KnowledgeNotebookDiffResponseSchema,
  KnowledgeNotebookHistoryRequestSchema,
  KnowledgeNotebookHistoryResponseSchema,
  RestoreKnowledgeNotebookRequestSchema,
  RestoreKnowledgeNotebookResponseSchema,
} from './index.js';

const workspaceId = allocateEntityId('ws');
const userId = allocateEntityId('usr');
const requestId = '11111111-1111-4111-8111-111111111111';

describe('knowledge notebook history, diff, and restore schemas', () => {
  it('bounds KnowledgeNotebookHistoryRequestSchema pagination limit and rejects unknown fields', () => {
    expect(KnowledgeNotebookHistoryRequestSchema.parse({})).toEqual({});
    expect(KnowledgeNotebookHistoryRequestSchema.parse({ revision: 'rev-10', limit: 100 })).toEqual(
      { revision: 'rev-10', limit: 100 }
    );

    for (const invalid of [
      { revision: '' },
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { workspaceId },
    ]) {
      expect(KnowledgeNotebookHistoryRequestSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('Separates available and unavailable rows in KnowledgeNotebookHistoryResponseSchema without leaking denied fields', () => {
    const valid = {
      notebookRevision: 'rev-2',
      revisions: [
        {
          revision: 'rev-2',
          parentRevision: 'rev-1',
          availability: 'available' as const,
          summary: 'Update architecture overview',
          producer: { kind: 'user' as const, id: userId },
          changedPaths: ['architecture/overview.md'],
        },
        {
          revision: 'rev-1',
          parentRevision: null,
          availability: 'unavailable' as const,
        },
      ],
      nextRevision: null,
    };
    expect(KnowledgeNotebookHistoryResponseSchema.parse(valid).revisions).toHaveLength(2);

    expect(
      KnowledgeNotebookHistoryResponseSchema.safeParse({
        ...valid,
        revisions: [
          {
            revision: 'rev-1',
            parentRevision: null,
            availability: 'unavailable',
            summary: 'leaked summary',
          },
        ],
      }).success
    ).toBe(false);
  });

  it('requires unique valid notebook page IDs and literal forRestore in KnowledgeNotebookDiffRequestSchema', () => {
    expect(
      KnowledgeNotebookDiffRequestSchema.parse({
        baseRevision: 'rev-1',
        fromRevision: 'rev-2',
        pageIds: ['architecture/overview', 'ops/runbook'],
        forRestore: true,
      }).pageIds
    ).toEqual(['architecture/overview', 'ops/runbook']);

    for (const invalid of [
      { baseRevision: 'rev-1', fromRevision: 'rev-2', pageIds: [] },
      { baseRevision: 'rev-1', fromRevision: 'rev-2', pageIds: ['ops/runbook', 'ops/runbook'] },
      { baseRevision: 'rev-1', fromRevision: 'rev-2', pageIds: ['../traversal'] },
      { baseRevision: 'rev-1', fromRevision: 'rev-2', pageIds: ['already.md'] },
      { baseRevision: 'rev-1', fromRevision: 'rev-2', forRestore: false },
    ]) {
      expect(KnowledgeNotebookDiffRequestSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('enforces the combined UTF-8 byte budget across before and after text in KnowledgeNotebookDiffResponseSchema', () => {
    const halfLimit = 'a'.repeat(KNOWLEDGE_NOTEBOOK_DIFF_TEXT_LIMIT_BYTES / 2);
    const baseDiff = {
      baseRevision: 'rev-1',
      fromRevision: 'rev-2',
      forRestore: true,
      truncated: false,
      changes: [
        {
          path: 'ops/runbook.md',
          before: halfLimit,
          after: halfLimit,
        },
      ],
    };
    expect(KnowledgeNotebookDiffResponseSchema.parse(baseDiff).changes).toHaveLength(1);

    expect(
      KnowledgeNotebookDiffResponseSchema.safeParse({
        ...baseDiff,
        changes: [
          {
            path: 'ops/runbook.md',
            before: halfLimit,
            after: `${halfLimit}x`,
          },
        ],
      }).success
    ).toBe(false);
  });

  it('validates RestoreKnowledgeNotebookRequestSchema and binds RestoreKnowledgeNotebookResponseSchema receipt operation to knowledge.notebook.restore', () => {
    expect(
      RestoreKnowledgeNotebookRequestSchema.parse({
        requestId,
        baseRevision: 'rev-2',
        fromRevision: 'rev-1',
        pageIds: ['ops/runbook'],
        summary: 'Restore runbook to rev-1',
        confirmRemoval: true,
      }).confirmRemoval
    ).toBe(true);

    expect(
      RestoreKnowledgeNotebookRequestSchema.safeParse({
        requestId,
        baseRevision: 'rev-2',
        fromRevision: 'rev-1',
        pageIds: ['ops/runbook'],
        summary: 'x'.repeat(4097),
      }).success
    ).toBe(false);

    const validResponse = {
      outcome: 'published' as const,
      ownerScope: { kind: 'workspace' as const, workspaceId },
      baseRevision: 'rev-2',
      notebookRevision: 'rev-3',
      changedPageIds: ['ops/runbook'],
      receiptRef: {
        operation: 'knowledge.notebook.restore' as const,
        requestId,
        ownerScope: { kind: 'workspace' as const, workspaceId },
      },
    };
    expect(RestoreKnowledgeNotebookResponseSchema.parse(validResponse).receiptRef.operation).toBe(
      'knowledge.notebook.restore'
    );

    expect(
      RestoreKnowledgeNotebookResponseSchema.safeParse({
        ...validResponse,
        receiptRef: {
          ...validResponse.receiptRef,
          operation: 'knowledge.notebook.update',
        },
      }).success
    ).toBe(false);
  });
});
