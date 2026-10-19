import { describe, expect, it } from 'vitest';
import { AgentEnvironmentMcpServerSchema } from './agent-environment.js';
import { WorkspaceMcpServerSchema } from './mcp-catalog.js';
import { McpBindingRecordSchema, parseResourceCatalogDocument } from './resource-catalog.js';

const supply = { allowedTools: ['echo'], schemaPolicy: 'tracking' };
const shapes = [
  {
    name: 'retained binding',
    schema: McpBindingRecordSchema,
    input: { ...supply, enabled: true, entryId: 'echo', packageDataKey: 'mcp_echo', revision: 1 },
  },
  {
    name: 'effective server',
    schema: WorkspaceMcpServerSchema,
    input: {
      ...supply,
      enabled: true,
      id: 'echo',
      transport: { kind: 'http', endpoint: 'https://mcp.example.test/mcp' },
    },
  },
  {
    name: 'AEP supply',
    schema: AgentEnvironmentMcpServerSchema,
    input: { ...supply, id: 'echo', catalogDigest: `sha256:${'1'.repeat(64)}` },
  },
];

describe('MCP permission cutover formats', () => {
  it.each(shapes)('serializes $name supply without retired permission defaults', ({
    schema,
    input,
  }) => {
    const parsed = schema.parse(input);
    expect(parsed.allowedTools).toEqual(['echo']);
    const serialized = JSON.parse(JSON.stringify(parsed));
    expect(serialized).not.toHaveProperty('approvalRequiredTools');
    expect(serialized).not.toHaveProperty('deniedTools');
  });

  it.each(shapes)('refuses retired permission fields in $name', ({ schema, input }) => {
    for (const field of ['approvalRequiredTools', 'deniedTools']) {
      const result = schema.safeParse({ ...input, [field]: [] });
      expect(result.success, `${field} must not be accepted, even when empty`).toBe(false);
    }
  });

  it('preserves descriptive binding annotations in retained catalog reads', () => {
    const document = {
      schemaVersion: 1,
      scope: 'workspace',
      revision: 1,
      mcp: { bindings: [{ ...shapes[0]!.input, annotation: 'retained description' }] },
      plugins: {},
      skills: {},
    };
    expect(parseResourceCatalogDocument(document).mcp.bindings[0]).toHaveProperty(
      'annotation',
      'retained description'
    );
  });

  it('refuses retired permission authority in the permissive retained catalog reader', () => {
    for (const field of ['approvalRequiredTools', 'deniedTools']) {
      const document = {
        schemaVersion: 1,
        scope: 'workspace',
        revision: 1,
        mcp: {
          bindings: [{ ...shapes[0]!.input, annotation: 'retained description', [field]: [] }],
        },
        plugins: {},
        skills: {},
      };
      expect(() => parseResourceCatalogDocument(document), field).toThrow();
    }
  });
});
