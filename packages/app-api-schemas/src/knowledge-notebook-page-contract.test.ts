import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { OperationDefinition } from './operation-contract.js';
import { OPERATION_DEFINITIONS } from './operation-definitions.js';

const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const ownerScope = { kind: 'workspace', workspaceId };
const content =
  '---\ntype: KnowledgePage\ntitle: Human note\ncustom: {nested: [one, two]}\n---\nExact body.\n';

/** Lookup keeps absent new operations an assertion failure rather than a collection error. */
function definition(operation: string): OperationDefinition {
  const found = (OPERATION_DEFINITIONS as Record<string, OperationDefinition>)[operation];
  expect(found, `Missing canonical Notebook operation ${operation}`).toBeDefined();
  return found!;
}

/** Public commands name one base and full page bytes; authority is supplied by native admission. */
function createInput() {
  return {
    workspaceId,
    requestId: randomUUID(),
    baseRevision: 'opaque-base',
    path: 'notes/human.md',
    content,
    summary: 'Save human note',
  };
}

describe('one public OKF Notebook page contract', () => {
  it('offers list/create/update/delete only through the Notebook family', () => {
    for (const suffix of ['list', 'create', 'update', 'delete']) {
      expect(Object.keys(OPERATION_DEFINITIONS)).toContain(`knowledge.notebook.${suffix}`);
      expect(Object.keys(OPERATION_DEFINITIONS)).not.toContain(`knowledge.${suffix}`);
    }
  });

  it('accepts complete page creation and refuses the retired entry edit shape and unsafe paths', () => {
    const operation = definition('knowledge.notebook.create');
    const input = createInput();
    expect(operation.inputSchema.parse(input)).toEqual(input);
    expect(operation.policyOperation).toBe('knowledge.write');
    expect(operation.mutating).toBe(true);
    for (const override of [
      { path: '../outside.md' },
      { baseRevision: '' },
      { content: 'é'.repeat(1024 * 1024 + 1) },
      { actor: { kind: 'user', id: 'another-user' } },
      { kind: 'project-context', title: 'Parallel title', knowledgePageId: 'notes/human' },
    ]) {
      expect(operation.inputSchema.safeParse({ ...input, ...override }).success).toBe(false);
    }
  });

  it('requires exact removal confirmation and returns the existing publication facts for both commands', () => {
    const input = createInput();
    const removal = {
      workspaceId,
      requestId: randomUUID(),
      baseRevision: input.baseRevision,
      path: input.path,
      expectedContentDigest: `sha256:${'a'.repeat(64)}`,
      confirmRemoval: true,
      summary: 'Remove selected page; history remains',
    };
    const operation = definition('knowledge.notebook.delete');
    expect(operation.inputSchema.parse(removal)).toEqual(removal);
    for (const override of [
      { confirmRemoval: false },
      { expectedContentDigest: '' },
      { baseRevision: '' },
      { path: '/outside.md' },
    ]) {
      expect(operation.inputSchema.safeParse({ ...removal, ...override }).success).toBe(false);
    }
    const { confirmRemoval: _confirmation, ...unconfirmed } = removal;
    expect(operation.inputSchema.safeParse(unconfirmed).success).toBe(false);
    for (const name of ['knowledge.notebook.create', 'knowledge.notebook.delete']) {
      const result = {
        outcome: 'published',
        ownerScope,
        baseRevision: input.baseRevision,
        notebookRevision: 'opaque-published',
        changedPageIds: ['notes/human'],
        receiptRef: { operation: name, requestId: input.requestId, ownerScope },
      };
      expect(definition(name).outputSchema.parse(result)).toEqual(result);
    }
  });

  it('lists canonical bytes and their digest without a parallel entry DTO', () => {
    const result = {
      knowledgeBaseId: 'kb_00000000-0000-7000-8000-000000000001',
      notebookRevision: 'opaque-published',
      pages: [
        {
          id: 'notes/human',
          path: 'notes/human.md',
          content,
          contentDigest: `sha256:${'a'.repeat(64)}`,
        },
      ],
    };
    const operation = definition('knowledge.notebook.list');
    expect(operation.outputSchema.parse(result)).toEqual(result);
    expect(operation.policyOperation).toBe('knowledge.read');
    expect(operation.mutating).toBe(false);
    expect(
      operation.outputSchema.safeParse({
        notebookRevision: result.notebookRevision,
        items: [
          {
            id: 'notes/human',
            title: 'Human note',
            kind: 'project-context',
            content: 'Exact body.',
          },
        ],
      }).success
    ).toBe(false);
  });
});
