import { describe, expect, it } from 'vitest';
import { TASK_OPERATION_DEFINITIONS } from './conversation-operations.js';
import type { OperationDefinition } from './operation-contract.js';

const request = {
  workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
  threadId: 'th_00000000-0000-7000-8000-000000000002',
  turnId: 'tu_00000000-0000-7000-8000-000000000003',
  requestId: '0190f4c8-0000-7000-8000-000000000004',
  input: '  Preserve these exact bytes.\n',
};
const steer = () =>
  (TASK_OPERATION_DEFINITIONS as Record<string, OperationDefinition>)['task.steer']!;

describe('task.steer operation boundary', () => {
  it('addresses one exact Task Turn under turn.run and preserves text', () => {
    const definition = steer();
    expect(definition, 'task.steer must be registered').toBeDefined();
    expect(definition.policyOperation).toBe('turn.run');
    expect(definition.target).toEqual({ kind: 'addressed-thread', threadField: 'threadId' });
    expect(definition.mutating).toBe(true);
    expect(definition.inputSchema.parse(request)).toEqual(request);
  });

  it('rejects missing selectors, whitespace, oversized UTF-8, and added authority before effects', () => {
    const definition = steer();
    expect(definition, 'task.steer must be registered').toBeDefined();
    for (const key of Object.keys(request)) {
      const candidate = { ...request } as Record<string, unknown>;
      delete candidate[key];
      expect(definition.inputSchema.safeParse(candidate).success, key).toBe(false);
    }
    for (const input of ['', ' \n\t', 'é'.repeat(8193), '\ud800']) {
      expect(definition.inputSchema.safeParse({ ...request, input }).success).toBe(false);
    }
    expect(definition.inputSchema.parse({ ...request, input: 'é'.repeat(8192) }).input).toBe(
      'é'.repeat(8192)
    );
    for (const key of [
      'actor',
      'agentSessionId',
      'modelId',
      'effort',
      'environment',
      'attachments',
    ]) {
      expect(
        definition.inputSchema.safeParse({ ...request, [key]: 'inapplicable' }).success,
        key
      ).toBe(false);
    }
  });

  it('success identifies native acceptance without claiming consumption', () => {
    const definition = steer();
    expect(definition, 'task.steer must be registered').toBeDefined();
    const result = {
      workspaceId: request.workspaceId,
      threadId: request.threadId,
      turnId: request.turnId,
      inputItemId: 'it_00000000-0000-7000-8000-000000000005',
      delivery: 'accepted',
    };
    expect(definition.outputSchema.parse(result)).toEqual(result);
    expect(definition.outputSchema.safeParse({ ...result, delivery: 'consumed' }).success).toBe(
      false
    );
  });
});
