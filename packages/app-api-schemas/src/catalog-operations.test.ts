import { describe, expect, it } from 'vitest';
import { AGENT_OPERATION_DEFINITIONS } from './agent-operations.js';
import { CATALOG_OPERATION_DEFINITIONS } from './catalog-operations.js';
import {
  OPERATION_DEFINITIONS,
  operationMcpEligible,
  operationModelInput,
} from './operation-definitions.js';
import { WORKER_OPERATION_DEFINITIONS } from './worker-operations.js';

describe('Agent, Worker and resource catalog definitions', () => {
  it('composes exactly seventeen strict JSON operations with truthful MCP and mutation facts', () => {
    const definitions = {
      ...AGENT_OPERATION_DEFINITIONS,
      ...WORKER_OPERATION_DEFINITIONS,
      ...CATALOG_OPERATION_DEFINITIONS,
    };
    expect(Object.keys(definitions)).toHaveLength(17);
    const digest = `sha256:${'a'.repeat(64)}`;
    const tree = [{ kind: 'file', path: 'SKILL.md', contentBase64: 'cHJvb2Y=' }];
    const validModelInputs = {
      'agent.health-refresh': {},
      'agent.list': {},
      'agent.read': { agentId: 'agent_proof' },
      'worker.list': {},
      'catalog.read': {},
      'catalog.skill-list': {},
      'catalog.skill-import': { displayName: 'Proof', expectedRevision: 1, tree },
      'catalog.skill-candidate-submit': {
        skillId: 'proof',
        baseDigest: digest,
        expectedRevision: 1,
        summary: 'Proof candidate',
        tree,
      },
      'catalog.skill-candidate-decide': {
        candidateId: 'candidate_proof',
        decision: 'promoted',
        expectedRevision: 1,
      },
      'catalog.skill-select': { skillId: 'proof', digest, expectedRevision: 1 },
      'catalog.skill-pin': { skillId: 'proof', digest: null, expectedRevision: 1 },
      'catalog.mcp-list': {},
      'catalog.mcp-create': {
        displayName: 'Proof MCP',
        expectedRevision: 1,
        allowedTools: ['proof'],
        declaration: { kind: 'http', url: 'https://example.com/mcp' },
      },
      'catalog.mcp-select': { mcpId: 'proof', digest, expectedRevision: 1 },
      'catalog.mcp-binding': {
        mcpId: 'proof',
        allowedTools: ['proof'],
        bindingRevision: 1,
        enabled: false,
        expectedRevision: 1,
        schemaPolicy: 'tracking',
      },
      'catalog.plugin-list': {},
      'catalog.plugin-import': { expectedRevision: 1, tree },
    } satisfies Record<keyof typeof definitions, unknown>;
    for (const [id, definition] of Object.entries(definitions)) {
      expect(OPERATION_DEFINITIONS[id as keyof typeof definitions]).toBe(definition);
      expect(definition.binding).toBe('json');
      expect(operationMcpEligible(definition)).toBe(true);
      const model = operationModelInput(definition.inputSchema, ['workspaceId', 'requestId']);
      const validInput = validModelInputs[id as keyof typeof definitions];
      expect(model.safeParse(validInput).success, id).toBe(true);
      const unknownFieldInput = { ...validInput, unowned: true };
      expect(model.safeParse(unknownFieldInput).success, id).toBe(false);
      expect(model.strip().safeParse(unknownFieldInput).success, id).toBe(true);
      expect(model.shape).not.toHaveProperty('workspaceId');
      expect(model.shape).not.toHaveProperty('requestId');
    }
    expect(AGENT_OPERATION_DEFINITIONS['agent.health-refresh'].mutating).toBe(true);
    expect(WORKER_OPERATION_DEFINITIONS['worker.list'].mutating).toBe(false);
    expect(CATALOG_OPERATION_DEFINITIONS['catalog.skill-candidate-submit'].policyOperation).toBe(
      'workspace.write'
    );
    expect(CATALOG_OPERATION_DEFINITIONS['catalog.skill-import'].policyOperation).toBe(
      'workspace.configure'
    );
  });

  it('admits null pin removal and refuses null default selection through complete and model inputs', () => {
    const input = {
      workspaceId: 'ws_demo',
      skillId: 'proof',
      digest: null,
      expectedRevision: 1,
      requestId: '00000000-0000-4000-8000-000000000001',
    };
    expect(
      CATALOG_OPERATION_DEFINITIONS['catalog.skill-pin'].inputSchema.safeParse(input).success
    ).toBe(true);
    expect(
      CATALOG_OPERATION_DEFINITIONS['catalog.skill-select'].inputSchema.safeParse(input).success
    ).toBe(false);
    const model = operationModelInput(
      CATALOG_OPERATION_DEFINITIONS['catalog.skill-select'].inputSchema,
      ['workspaceId', 'requestId']
    );
    expect(model.safeParse({ skillId: 'proof', digest: null, expectedRevision: 1 }).success).toBe(
      false
    );
    expect(
      model.safeParse({ skillId: 'proof', digest: `sha256:${'a'.repeat(64)}`, expectedRevision: 1 })
        .success
    ).toBe(true);
  });
});
