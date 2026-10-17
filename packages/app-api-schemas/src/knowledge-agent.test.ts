import { allocateEntityId } from '@openkit/protocol';
import { expect, it } from 'vitest';
import { KnowledgeMaintainRequestSchema } from './knowledge-agent.js';

it('retains the accepted maintenance instruction and optional admitted-page and Source selections', () => {
  const input = { workspaceId: allocateEntityId('ws'), requestId: '00000000-0000-4000-8000-000000000001',
    instruction: 'Reconcile the selected evidence.', pageIds: ['index', 'notes/release'], sourceIds: [allocateEntityId('ks')] };
  expect(KnowledgeMaintainRequestSchema.parse(input)).toEqual(input);
  expect(KnowledgeMaintainRequestSchema.safeParse({ ...input, pageIds: ['../private'] }).success).toBe(false);
});
