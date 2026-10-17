import { describe, expect, it } from 'vitest';
import { MEMORY_OPERATION_DEFINITIONS, PrepareMemoryForgetRequestSchema } from './memory.js';

describe('explicit self Memory contracts', () => {
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
