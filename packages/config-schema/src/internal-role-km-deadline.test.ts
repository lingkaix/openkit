import { describe, expect, it } from 'vitest';
import { InternalRoleProfilesConfigSchema } from './internal-role.js';

describe('Knowledge Manager default run deadline', () => {
  it('gives omitted limits the accepted KM, Assistant and Coordinator defaults', () => {
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
        limits: { maxModelTurns: 16, maxToolCalls: 48, deadlineMs: 600_000 },
      },
      {
        roleId: 'workflow-coordinator',
        limits: { maxModelTurns: 16, maxToolCalls: 48, deadlineMs: 120_000 },
      },
    ]);
  });

  it.each([
    'knowledge-manager',
    'assistant',
    'workflow-coordinator',
  ])('refuses the %s deadline that overflows the host timer', (roleId) => {
    const config = (deadlineMs: number) => ({
      schemaVersion: 1,
      profiles: [{ id: roleId, roleId, limits: { maxModelTurns: 1, maxToolCalls: 1, deadlineMs } }],
    });
    expect(
      InternalRoleProfilesConfigSchema.parse(config(2_147_483_647)).profiles[0]!.limits.deadlineMs
    ).toBe(2_147_483_647);
    expect(InternalRoleProfilesConfigSchema.safeParse(config(2_147_483_648)).success).toBe(false);
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
