import { describe, expect, it } from 'vitest';
import { SERVER_MCP_OPERATION_DEFINITIONS } from './server-mcp-operations.js';

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
