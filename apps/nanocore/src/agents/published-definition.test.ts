import { describe, expect, it } from 'vitest';
import {
  preparePublishedDefinitionRevision,
  readPublishedDefinition,
} from './published-definition.js';

const workspaceId = 'ws_018f0000-0000-7000-8000-000000000001';
const selection = { definitionId: 'reports', definitionRevision: '1', workspaceId };
const definition = {
  kind: 'published',
  definitionId: selection.definitionId,
  definitionRevision: selection.definitionRevision,
  workspaceIds: [workspaceId],
  accountableUserId: 'usr_018f0000-0000-7000-8000-000000000002',
  agentId: 'published-reports',
  botUserId: '100000000000000001',
  displayName: 'Reports',
  prompt: 'Answer from the exact admitted fact.',
  policyRevision: 'read-only-role-v1',
  logicalModelId: 'synthetic-reports-model',
  slotSchemas: { metric: { kind: 'fact', schemaId: 'published-fact', schemaRevision: '1' } },
  ceilings: {
    basic: { inputTokens: 6000, outputTokens: 256 },
    expanded: { inputTokens: 16000, outputTokens: 512 },
  },
};

describe('published definition readback', () => {
  it('prepares only a fresh and admitted revision against the current owner head', () => {
    const input = {
      candidate: definition,
      definitionId: selection.definitionId,
      expectedCurrentRevision: null,
      currentRevision: null,
      hasRevision: () => false,
      admits: () => true,
    };
    expect(preparePublishedDefinitionRevision(input)).toEqual(definition);
    expect(preparePublishedDefinitionRevision({ ...input, currentRevision: '0' })).toBeUndefined();
    expect(
      preparePublishedDefinitionRevision({ ...input, hasRevision: () => true })
    ).toBeUndefined();
    expect(preparePublishedDefinitionRevision({ ...input, admits: () => false })).toBeUndefined();
  });
  it('requires the exact revision and allowed Workspace', () => {
    expect(readPublishedDefinition(definition, selection)).toEqual(definition);
    expect(readPublishedDefinition(definition, { ...selection, definitionRevision: '2' })).toBe(
      undefined
    );
    expect(
      readPublishedDefinition(definition, {
        ...selection,
        workspaceId: 'ws_018f0000-0000-7000-8000-000000000003',
      })
    ).toBe(undefined);
  });

  it('does not reinterpret Worker or unknown capability fields as published authority', () => {
    expect(readPublishedDefinition({ ...definition, kind: 'worker' }, selection)).toBe(undefined);
    expect(readPublishedDefinition({ ...definition, runtime: {} }, selection)).toBe(undefined);
    expect(
      readPublishedDefinition(
        {
          ...definition,
          slotSchemas: { metric: { ...definition.slotSchemas.metric, kind: 'file' } },
        },
        selection
      )
    ).toBe(undefined);
    expect(
      readPublishedDefinition(
        {
          ...definition,
          ceilings: { ...definition.ceilings, basic: { inputTokens: 6001, outputTokens: 256 } },
        },
        selection
      )
    ).toBe(undefined);
  });
});
