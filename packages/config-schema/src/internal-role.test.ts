import { ReasoningEffortSchema } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getConfigSchemaCatalog } from './catalog.js';
import {
  InternalRoleExecutionProfileSchema,
  InternalRoleProfilesConfigSchema,
} from './internal-role.js';

const roles = ['knowledge-manager', 'assistant', 'goal-orchestrator', 'custom-role'];

describe('internal-role reasoning effort', () => {
  it.each(roles)('preserves every canonical effort for %s', (roleId) => {
    for (const reasoningEffort of ReasoningEffortSchema.options) {
      expect(
        InternalRoleExecutionProfileSchema.parse({ id: 'profile', roleId, reasoningEffort })
      ).toHaveProperty('reasoningEffort', reasoningEffort);
    }
  });

  it.each(roles)('does not add effort when omitted for %s', (roleId) => {
    expect(InternalRoleExecutionProfileSchema.parse({ id: 'profile', roleId })).not.toHaveProperty(
      'reasoningEffort'
    );
  });

  it.each(roles)('rejects unknown core effort values for %s', (roleId) => {
    for (const reasoningEffort of ['default', 'off', '', null, 1]) {
      expect(
        InternalRoleExecutionProfileSchema.safeParse({ id: 'profile', roleId, reasoningEffort })
          .success
      ).toBe(false);
    }
  });

  it('exports the same optional effort enum in each JSON Schema branch', () => {
    const schema = z.toJSONSchema(InternalRoleExecutionProfileSchema, { io: 'input' });
    expect(schema.anyOf).toHaveLength(3);
    for (const branch of schema.anyOf ?? []) {
      expect(branch.properties?.reasoningEffort).toEqual({
        type: 'string',
        enum: ReasoningEffortSchema.options,
      });
      expect(branch.required).not.toContain('reasoningEffort');
    }
  });
});

describe('Knowledge Manager default run deadline', () => {
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

const exportedSchema = getConfigSchemaCatalog().find((entry) => entry.kind === 'internal-role');
if (!exportedSchema) throw new Error('Internal-role JSON Schema is unavailable.');

describe.each([
  { name: 'parsed profiles', schema: InternalRoleProfilesConfigSchema },
  { name: 'exported JSON Schema', schema: z.fromJSONSchema(exportedSchema.schema) },
])('Assistant deadline through $name', ({ schema }) => {
  it('defaults Assistant to 600 seconds while retaining KM and Coordinator limits', () => {
    const config = schema.parse({
      schemaVersion: 1,
      profiles: ['assistant', 'knowledge-manager', 'workflow-coordinator'].map((roleId) => ({
        id: roleId,
        roleId,
      })),
    });
    expect(config).toMatchObject({
      profiles: [
        {
          roleId: 'assistant',
          limits: { maxModelTurns: 16, maxToolCalls: 48, deadlineMs: 600_000 },
        },
        {
          roleId: 'knowledge-manager',
          limits: { maxModelTurns: 16, maxToolCalls: 48, deadlineMs: 300_000 },
        },
        {
          roleId: 'workflow-coordinator',
          limits: { maxModelTurns: 16, maxToolCalls: 48, deadlineMs: 120_000 },
        },
      ],
    });
  });

  it('preserves explicitly authored Assistant limits rather than applying defaults', () => {
    const limits = { maxModelTurns: 5, maxToolCalls: 11, deadlineMs: 4_000 };
    expect(
      schema.parse({
        schemaVersion: 1,
        profiles: [{ id: 'assistant-explicit', roleId: 'assistant', limits }],
      })
    ).toMatchObject({ profiles: [{ id: 'assistant-explicit', roleId: 'assistant', limits }] });
  });
});
