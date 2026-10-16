import { describe, expect, it } from 'vitest';
import { WorkspaceMcpHttpTransportSchema } from './mcp-catalog.js';
import { McpHttpEndpointSchema } from './mcp-credentials.js';
import { McpHttpDeclarationSchema } from './resource-catalog.js';

describe('one credential-free MCP HTTP endpoint criterion', () => {
  it.each([
    'https://ordinary-user:plain-password@example.invalid/mcp',
    'https://ordinary-user@example.invalid/mcp',
    'https://example.invalid/mcp#private',
    'file:///private/path',
    'not-a-url',
    '',
  ])('refuses unsafe endpoint across stored declaration and effective transport: %s', (endpoint) => {
    expect(McpHttpEndpointSchema.safeParse(endpoint).success).toBe(false);
    expect(McpHttpDeclarationSchema.safeParse({ kind: 'http', endpoint }).success).toBe(false);
    expect(WorkspaceMcpHttpTransportSchema.safeParse({ kind: 'http', endpoint }).success).toBe(
      false
    );
  });
  it('preserves an ordinary HTTP endpoint and its non-secret query', () => {
    const endpoint = 'https://example.invalid/mcp?region=west';
    expect(McpHttpEndpointSchema.parse(endpoint)).toBe(endpoint);
    expect(McpHttpDeclarationSchema.parse({ kind: 'http', endpoint })).toEqual({
      kind: 'http',
      endpoint,
      headers: {},
    });
  });
});
