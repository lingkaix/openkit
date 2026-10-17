import { describe, expect, it } from 'vitest';
import { MEMORY_OPERATION_DEFINITIONS, PrepareMemoryForgetRequestSchema } from './memory.js';
import { allocateEntityId } from '@openkit/protocol';

describe('explicit self Memory contracts', () => {
  it('keeps Memory search within one current self scope and an independent bounded budget', () => {
    const schema = MEMORY_OPERATION_DEFINITIONS['memory.search'].inputSchema;
    const input = { workspaceId: allocateEntityId('ws'), query: 'personal preference' };
    expect(schema.parse(input)).toMatchObject({ limit: 5, states: ['active'], pinnedReferences: [] });
    for (const extra of [{ userId: allocateEntityId('usr') }, { sourceScope: 'workspace' }, { limit: 21 }, { limit: 0 }]) {
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
