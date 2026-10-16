import { describe, expect, it } from 'vitest';
import { CreateAutomationRequestSchema, UpdateAutomationRequestSchema } from './automation.js';
import { AUTOMATION_OPERATION_DEFINITIONS } from './automation-operations.js';

const definition = {
  workspaceId: 'ws_test',
  threadId: 'th_test',
  name: 'Poll',
  intervalSeconds: 5,
  prompt: 'Inspect status',
};
describe('fixed recurrence public contract', () => {
  it('admits only fixed integer intervals and an existing Thread selector', () => {
    expect(CreateAutomationRequestSchema.strict().parse(definition)).toEqual(definition);
    expect(
      CreateAutomationRequestSchema.parse({ ...definition, intervalSeconds: 2_147_483_648 })
        .intervalSeconds
    ).toBe(2_147_483_648);
    for (const input of [
      { ...definition, intervalSeconds: 4 },
      { ...definition, intervalSeconds: 5.5 },
      { ...definition, cron: '*' },
      { ...definition, actor: { kind: 'user', id: 'other' } },
      { ...definition, threadId: '' },
    ])
      expect(CreateAutomationRequestSchema.strict().safeParse(input).success).toBe(false);
  });
  it('requires revision and exact UTC instants and exposes bounded read-only history', () => {
    expect(UpdateAutomationRequestSchema.strict().safeParse({ status: 'active' }).success).toBe(
      false
    );
    expect(
      UpdateAutomationRequestSchema.strict().safeParse({
        expectedRevision: 1,
        status: 'active',
        scheduledAt: '2026-10-16T01:00:00+01:00',
      }).success
    ).toBe(false);
    expect(AUTOMATION_OPERATION_DEFINITIONS['automation.history']).toMatchObject({
      mutating: false,
      policyOperation: 'workspace.read',
    });
    for (const operation of [
      'automation.create',
      'automation.update',
      'automation.delete',
    ] as const)
      expect(AUTOMATION_OPERATION_DEFINITIONS[operation].policyOperation).toBe(
        'workspace.configure'
      );
    expect(
      AUTOMATION_OPERATION_DEFINITIONS['automation.history'].inputSchema.safeParse({
        automationId: 'auto_one',
        limit: 129,
      }).success
    ).toBe(false);
  });
});
