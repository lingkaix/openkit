import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { getConfigSchemaCatalog } from './catalog.js';
import { InternalRoleProfilesConfigSchema } from './internal-role.js';

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
