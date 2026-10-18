import { allocateEntityId } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import { MEMORY_OPERATION_DEFINITIONS, PrepareMemoryForgetRequestSchema } from './memory.js';

describe('explicit self Memory contracts', () => {
  it('keeps KM ask and tell bound to self, with no model-selected scope or publication authority', () => {
    const workspaceId = allocateEntityId('ws');
    expect(
      MEMORY_OPERATION_DEFINITIONS['memory.ask'].inputSchema.parse({
        workspaceId,
        question: 'What are my preferences?',
      })
    ).toEqual({ workspaceId, question: 'What are my preferences?' });
    const tell = {
      workspaceId,
      requestId: '00000000-0000-4000-8000-000000000001',
      content: 'Keep answers short.',
    };
    expect(MEMORY_OPERATION_DEFINITIONS['memory.tell'].inputSchema.parse(tell)).toMatchObject({
      sources: [],
    });
    for (const [id, input] of [
      ['memory.ask', { workspaceId, question: 'Preference?' }],
      ['memory.tell', tell],
    ] as const) {
      const schema = MEMORY_OPERATION_DEFINITIONS[id].inputSchema;
      expect(schema.safeParse({ ...input, userId: allocateEntityId('usr') }).success).toBe(false);
      expect(schema.safeParse({ ...input, sourceScope: 'server' }).success).toBe(false);
      expect(schema.safeParse({ ...input, approved: true }).success).toBe(false);
    }
  });

  it('keeps Memory search within one current self scope and an independent bounded budget', () => {
    const schema = MEMORY_OPERATION_DEFINITIONS['memory.search'].inputSchema;
    const input = { workspaceId: allocateEntityId('ws'), query: 'personal preference' };
    expect(schema.parse(input)).toMatchObject({
      limit: 5,
      states: ['active'],
      pinnedReferences: [],
    });
    for (const extra of [
      { userId: allocateEntityId('usr') },
      { sourceScope: 'workspace' },
      { limit: 21 },
      { limit: 0 },
    ]) {
      expect(schema.safeParse({ ...input, ...extra }).success).toBe(false);
    }
  });

  it('admits no caller-selected owner, Worker or caller confirmation flag', () => {
    expect(
      MEMORY_OPERATION_DEFINITIONS['memory.list'].inputSchema.safeParse({ userId: 'another' })
        .success
    ).toBe(false);
    expect(PrepareMemoryForgetRequestSchema.safeParse({ confirmed: true }).success).toBe(false);
    for (const operation of Object.values(MEMORY_OPERATION_DEFINITIONS)) {
      expect(operation.scope).toEqual({ kind: 'user' });
      expect(operation.credentials).not.toContain('worker-package');
      expect(operation.credentials).not.toContain('coordinator');
    }
  });
});
