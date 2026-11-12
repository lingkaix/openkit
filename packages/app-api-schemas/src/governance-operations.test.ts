import { describe, expect, it } from 'vitest';
import { GOVERNANCE_OPERATION_DEFINITIONS } from './governance-operations.js';

const selectors = {
  turnId: 'tu_00000000-0000-7000-8000-000000000001',
  capabilityCallId: 'cap_00000000-0000-7000-8000-000000000001',
  itemId: 'it_00000000-0000-7000-8000-000000000001',
};

describe('TB7 evidence read selectors', () => {
  it.each(['usage.read', 'audit.workspace-list', 'audit.server-list'] as const)(
    'accepts only canonical narrowing selectors for %s',
    (id) => {
      const base =
        id === 'audit.server-list'
          ? {}
          : { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' };
      const schema = GOVERNANCE_OPERATION_DEFINITIONS[id].inputSchema;
      expect(schema.safeParse({ ...base, ...selectors, limit: 1 }).success).toBe(true);
      for (const invalid of [
        { ...base, turnId: selectors.itemId },
        { ...base, capabilityCallId: selectors.turnId },
        { ...base, itemId: selectors.capabilityCallId },
        { ...base, ...selectors, userId: 'another-viewer' },
      ])
        expect(schema.safeParse(invalid).success).toBe(false);
    }
  );
});
