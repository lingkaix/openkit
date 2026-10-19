import { describe, expect, it } from 'vitest';
import { InternalRoleProfilesConfigSchema } from './internal-role.js';

describe('Knowledge Manager default run deadline', () => {
  it('gives an omitted KM limit object 300 seconds without changing other role defaults', () => {
    const config = InternalRoleProfilesConfigSchema.parse({
      schemaVersion: 1,
      profiles: ['knowledge-manager', 'assistant', 'workflow-coordinator'].map((roleId) => ({
        id: roleId,
        roleId,
      })),
    });
    expect(config.profiles.map(({ roleId, limits }) => ({ roleId, limits }))).toEqual([
      {
        roleId: 'knowledge-manager',
        limits: { maxModelTurns: 16, maxToolCalls: 48, deadlineMs: 300_000 },
      },
      {
        roleId: 'assistant',
        limits: { maxModelTurns: 16, maxToolCalls: 48, deadlineMs: 120_000 },
      },
      {
        roleId: 'workflow-coordinator',
        limits: { maxModelTurns: 16, maxToolCalls: 48, deadlineMs: 120_000 },
      },
    ]);
  });

  it('preserves an explicitly authored KM limit object exactly', () => {
    const limits = { maxModelTurns: 7, maxToolCalls: 19, deadlineMs: 90_000 };
    const config = InternalRoleProfilesConfigSchema.parse({
      schemaVersion: 1,
      profiles: [{ id: 'km-explicit', roleId: 'knowledge-manager', limits }],
    });
    expect(config.profiles[0]!.limits).toEqual(limits);
  });
});
