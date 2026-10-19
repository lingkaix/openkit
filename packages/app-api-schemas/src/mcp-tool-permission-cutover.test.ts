import { describe, expect, it } from 'vitest';
import { McpCatalogEntrySchema, UpdateMcpBindingRequestSchema } from './resource-catalog.js';
import { WorkspaceWorkerMcpServerSchema } from './workers.js';

const shapes = [
  {
    name: 'binding request',
    schema: UpdateMcpBindingRequestSchema,
    input: {
      allowedTools: ['echo'],
      bindingRevision: 1,
      enabled: true,
      expectedRevision: 2,
      requestId: '00000000-0000-4000-8000-000000000019',
      schemaPolicy: 'tracking',
    },
  },
  {
    name: 'catalog response',
    schema: McpCatalogEntrySchema,
    input: {
      allowedTools: ['echo'],
      availability: 'available',
      bindingRevision: 1,
      currentVersionDigest: `sha256:${'1'.repeat(64)}`,
      displayName: 'Echo',
      enabled: true,
      id: 'echo',
      schemaPolicy: 'tracking',
      timeoutMs: 2000,
      transportKind: 'http',
      versions: [],
    },
  },
  {
    name: 'Worker projection',
    schema: WorkspaceWorkerMcpServerSchema,
    input: { allowedTools: ['echo'], id: 'echo' },
  },
];

describe('MCP permission cutover App API', () => {
  it.each(shapes)('accepts and serializes $name without permission lists', ({ schema, input }) => {
    const parsed = schema.parse(input);
    expect(parsed.allowedTools).toEqual(['echo']);
    const serialized = JSON.parse(JSON.stringify(parsed));
    expect(serialized).not.toHaveProperty('approvalRequiredTools');
    expect(serialized).not.toHaveProperty('deniedTools');
  });

  it('refuses retired permission fields in binding requests', () => {
    const { schema, input } = shapes[0]!;
    for (const field of ['approvalRequiredTools', 'deniedTools']) {
      expect(schema.safeParse({ ...input, [field]: [] }).success).toBe(false);
    }
  });
});
