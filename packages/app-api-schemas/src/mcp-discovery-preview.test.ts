import { describe, expect, it } from 'vitest';
import { SERVER_MCP_OPERATION_DEFINITIONS } from './server-mcp-operations.js';

const preview = SERVER_MCP_OPERATION_DEFINITIONS['administration.mcp-discovery-preview'];

describe('MCP discovery observation boundary', () => {
  it('discards descriptive additions without relaxing required tool metadata or invocation authority', () => {
    const observation = {
      mcpId: 'proof',
      versionDigest: `sha256:${'a'.repeat(64)}`,
      observedAt: '2026-10-16T12:00:00.000Z',
      serverVersion: null,
      tools: [{ name: 'read', inputSchema: { type: 'object' } }],
    };
    expect(
      preview.outputSchema.parse({
        ...observation,
        displayHint: 'Additional descriptive metadata',
        tools: [{ ...observation.tools[0], displayHint: 'Additional tool metadata' }],
      })
    ).toEqual(observation);
    expect(
      preview.outputSchema.safeParse({
        ...observation,
        tools: [{ name: '', inputSchema: {} }],
      }).success
    ).toBe(false);
    expect(
      preview.outputSchema.safeParse({ ...observation, serverVersion: { unknown: true } }).success
    ).toBe(false);
    const invocation = {
      catalogScope: { kind: 'server' },
      mcpId: observation.mcpId,
      versionDigest: observation.versionDigest,
      expectedRevision: 0,
      expectedBindingRevision: null,
    };
    expect(preview.inputSchema.safeParse(invocation).success).toBe(true);
    expect(preview.inputSchema.safeParse({ ...invocation, enabled: true }).success).toBe(false);
    expect(
      preview.inputSchema.safeParse({ ...invocation, catalogScope: { kind: 'unknown' } }).success
    ).toBe(false);
  });
});

describe('Server MCP primary Policy resource declarations', () => {
  it('declares MCP ownership for every Server operation without changing Workspace admission', () => {
    for (const definition of Object.values(SERVER_MCP_OPERATION_DEFINITIONS)) {
      if (definition.scope.kind === 'server') {
        expect(definition.target).toEqual({ kind: 'server', family: 'mcp' });
        expect(definition.policyOperation).toBe('api.call');
      } else {
        expect(definition.target).toEqual({ kind: 'workspace' });
      }
    }
  });
});
