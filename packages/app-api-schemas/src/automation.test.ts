import { describe, expect, it } from 'vitest';
import { testEntityId } from '../../../apps/nanocore/src/test-support/entity-ids.js';
import {
  AutomationCadenceSchema,
  CreateAutomationRequestSchema,
  MonthlyUtcScheduleSchema,
  UpdateAutomationRequestSchema,
} from './automation.js';
import { AUTOMATION_OPERATION_DEFINITIONS } from './automation-operations.js';

const definition = {
  workspaceId: testEntityId('ws', 'ws_test'),
  threadId: testEntityId('th', 'th_test'),
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
        automationId: testEntityId('auto', 'auto_one'),
        limit: 129,
      }).success
    ).toBe(false);
  });
});

describe('monthly UTC public contract', () => {
  it('admits an explicit bounded monthly rule without an artificial interval', () => {
    const { intervalSeconds: _interval, ...request } = definition;
    const monthly = {
      ...request,
      monthlyUtc: { zone: 'UTC', dayOfMonth: 28, hour: 9, minute: 0, second: 0 },
    };
    expect(CreateAutomationRequestSchema.strict().safeParse(monthly).success).toBe(true);
  });
});

it('rejects ambiguous, incomplete or unsupported monthly timing at the public boundary', () => {
  const monthlyUtc = { zone: 'UTC', dayOfMonth: 28, hour: 9, minute: 0, second: 0 };
  const { intervalSeconds: _interval, ...request } = definition;
  for (const value of [
    { ...monthlyUtc, dayOfMonth: 0 },
    { ...monthlyUtc, dayOfMonth: 29 },
    { ...monthlyUtc, dayOfMonth: 30 },
    { ...monthlyUtc, dayOfMonth: 31 },
    { ...monthlyUtc, dayOfMonth: 1.5 },
    { ...monthlyUtc, hour: 24 },
    { ...monthlyUtc, minute: 60 },
    { ...monthlyUtc, second: 60 },
    { ...monthlyUtc, zone: 'Etc/UTC' },
    { ...monthlyUtc, zone: '+00:00' },
    { ...monthlyUtc, zone: 'Australia/Melbourne' },
  ])
    expect(MonthlyUtcScheduleSchema.safeParse(value).success).toBe(false);
  expect(CreateAutomationRequestSchema.strict().safeParse(request).success).toBe(false);
  expect(
    CreateAutomationRequestSchema.strict().safeParse({ ...definition, monthlyUtc }).success
  ).toBe(false);
  expect(
    CreateAutomationRequestSchema.strict().safeParse({
      ...request,
      monthlyUtc: { ...monthlyUtc, milliseconds: 0 },
    }).success
  ).toBe(false);
  expect(
    UpdateAutomationRequestSchema.strict().safeParse({
      expectedRevision: 1,
      intervalSeconds: 5,
      monthlyUtc,
    }).success
  ).toBe(false);
  expect(
    AUTOMATION_OPERATION_DEFINITIONS['automation.update'].inputSchema.safeParse({
      automationId: 'schedule',
      expectedRevision: 1,
      intervalSeconds: 5,
      monthlyUtc,
    }).success
  ).toBe(false);
  expect(
    AutomationCadenceSchema.parse({ intervalSeconds: 5, description: 'Unowned additive note' })
  ).toEqual({ intervalSeconds: 5 });
});
