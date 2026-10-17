import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { UpdateKnowledgeNotebookRequestSchema } from './knowledge-notebook.js';
import { KNOWLEDGE_ENTRY_OPERATION_DEFINITIONS } from './knowledge-operation-definitions.js';

/** Human payloads carry exact content intent and one fixed base, never publication authority. */
function request() {
  return {
    requestId: randomUUID(),
    baseRevision: 'opaque-retained-revision',
    changes: [{ path: 'index.md', content: '# Notebook' }],
    summary: 'Update navigation',
  };
}

describe('Fixed-base notebook publication contract', () => {
  it('preserves exact text and treats revisions as opaque content-owner values', () => {
    const value = request();
    expect(UpdateKnowledgeNotebookRequestSchema.parse(value)).toEqual(value);
    const definition = KNOWLEDGE_ENTRY_OPERATION_DEFINITIONS['knowledge.notebook.update'];
    expect(definition.mutating).toBe(true);
    expect(definition.policyOperation).toBe('knowledge.write');
    expect(
      definition.inputSchema.parse({
        ...value,
        workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
      }).changes
    ).toEqual(value.changes);
  });

  it.each([
    '../outside.md',
    '/outside.md',
    'a\\b.md',
    '.git/config.md',
    'a.md.md',
    'A.md',
  ])('refuses unsafe bundle paths: %s', (path) => {
    expect(
      UpdateKnowledgeNotebookRequestSchema.safeParse({
        ...request(),
        changes: [{ path, content: 'No' }],
      }).success
    ).toBe(false);
  });

  it('requires a fixed base and refuses authority fields or duplicate changed paths', () => {
    const value = request();
    expect(
      UpdateKnowledgeNotebookRequestSchema.safeParse({ ...value, baseRevision: '' }).success
    ).toBe(false);
    expect(
      UpdateKnowledgeNotebookRequestSchema.safeParse({
        ...value,
        actor: { kind: 'user', id: 'another-owner' },
      }).success
    ).toBe(false);
    expect(
      UpdateKnowledgeNotebookRequestSchema.safeParse({
        ...value,
        changes: [...value.changes, ...value.changes],
      }).success
    ).toBe(false);
    expect(UpdateKnowledgeNotebookRequestSchema.safeParse({ ...value, changes: [] }).success).toBe(
      false
    );
  });
});
