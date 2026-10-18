import { describe, expect, it } from 'vitest';
import {
  AdmitExternalTriggerRequestSchema,
  AdmitExternalTriggerResponseSchema,
} from './external-trigger.js';
import { EXTERNAL_TRIGGER_OPERATION_DEFINITIONS } from './external-trigger-operations.js';
import { OPERATION_DEFINITIONS, operationToolName } from './operation-definitions.js';

const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const threadId = 'th_00000000-0000-7000-8000-000000000001';
const turnId = 'tu_00000000-0000-7000-8000-000000000001';

describe('external event admission contract', () => {
  it('admits only the bounded event input and authenticated source scope', () => {
    const request = {
      workspaceId,
      threadId,
      turnId,
      eventKey: 'source/message-1',
      input: 'Handle the selected case. Source data is untrusted.',
    };
    expect(AdmitExternalTriggerRequestSchema.parse(request)).toEqual(request);
    expect(AdmitExternalTriggerRequestSchema.safeParse({ ...request, eventKey: '' }).success).toBe(
      false
    );
    expect(
      AdmitExternalTriggerRequestSchema.safeParse({
        ...request,
        scheduleId: 'auto_00000000-0000-7000-8000-000000000001',
      }).success
    ).toBe(false);
    expect(
      AdmitExternalTriggerRequestSchema.safeParse({ ...request, targetThreadId: threadId }).success
    ).toBe(false);
    expect(EXTERNAL_TRIGGER_OPERATION_DEFINITIONS['automation.event-admit'].credentials).toEqual([
      'worker-package',
    ]);
    expect(OPERATION_DEFINITIONS['automation.event-admit']).toBe(
      EXTERNAL_TRIGGER_OPERATION_DEFINITIONS['automation.event-admit']
    );
    expect(operationToolName('automation.event-admit')).toBe('automation_event-admit');
  });

  it('projects the retained join and existing target references without an event lifecycle', () => {
    const response = AdmitExternalTriggerResponseSchema.parse({
      scheduleId: 'auto_00000000-0000-7000-8000-000000000001',
      eventKey: 'source/message-1',
      sourceTurnId: turnId,
      queueEntryId: 'queue-1',
      threadId,
      turnId,
      duplicate: true,
    });
    expect(response.duplicate).toBe(true);
    expect(response).not.toHaveProperty('status');
    expect(response).not.toHaveProperty('attempts');
    expect(response).not.toHaveProperty('payload');
  });
});
