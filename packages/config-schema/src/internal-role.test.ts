import { ReasoningEffortSchema } from '@openkit/protocol';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { InternalRoleExecutionProfileSchema } from './internal-role.js';

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
