import { readFileSync } from 'node:fs';

import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import { AuditEventSchema, CapabilityCallSchema, PROTOCOL_VERSION } from './index.js';

const eventSchemaUrl = new URL('../generated/json-schema/event.schema.json', import.meta.url);
const actorRefSchemaUrl = new URL(
  '../generated/json-schema/actor-ref.schema.json',
  import.meta.url
);
const auditEventSchemaUrl = new URL(
  '../generated/json-schema/audit-event.schema.json',
  import.meta.url
);
const capabilityCallSchemaUrl = new URL(
  '../generated/json-schema/capability-call.schema.json',
  import.meta.url
);
const stopReasonSchemaUrl = new URL(
  '../generated/json-schema/stop-reason.schema.json',
  import.meta.url
);
const turnSchemaUrl = new URL('../generated/json-schema/turn.schema.json', import.meta.url);

/**
 * Loads one checked-in generated JSON Schema for parity tests.
 */
function loadJsonSchema(schemaUrl: URL): unknown {
  return JSON.parse(readFileSync(schemaUrl, 'utf8'));
}

/**
 * Builds a draft 2020-12 JSON Schema validator for generated protocol artifacts.
 */
function createValidator(schemaUrl: URL = eventSchemaUrl) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat('uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);
  return ajv.compile(loadJsonSchema(schemaUrl));
}

/**
 * Builds a valid terminal turn-completed event envelope for schema parity assertions.
 */
function createTurnCompletedEnvelope(stopReason: string = 'completed') {
  return {
    protocolVersion: PROTOCOL_VERSION,
    event: 'turn.completed',
    sequence: 3,
    requestId: '0190f4c8-0000-7000-8000-000000000132',
    timestamp: '2026-05-27T00:00:02Z',
    workspaceId: 'ws_demo',
    threadId: 'th_demo',
    turnId: 'tu_demo',
    data: {
      type: 'turn-completed',
      stopReason,
      turn: {
        id: 'tu_demo',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        triggerActor: { kind: 'user', id: 'user_demo' },
        items: [],
        status: 'completed',
        humanGate: null,
        error: null,
        configVersion: null,
        startedAt: '2026-05-27T00:00:00Z',
        completedAt: '2026-05-27T00:00:02Z',
        durationMs: 2000,
      },
    },
  };
}

describe('generated JSON Schema event parity', () => {
  it('generates a standalone closed ActorRef JSON Schema artifact', () => {
    const validate = createValidator(actorRefSchemaUrl);
    const actor = { kind: 'user', id: 'user_demo' };

    expect(validate(actor)).toBe(true);
    expect(validate({ ...actor, responsibleUserId: actor.id })).toBe(false);
    expect(
      validate({ kind: 'automation', id: 'automation_demo', responsibleUserId: actor.id })
    ).toBe(true);
    expect(validate({ ...actor, displayName: 'Demo User' })).toBe(false);
  });

  it('keeps AuditEvent actor attribution closed and secret-free', () => {
    const validate = createValidator(auditEventSchemaUrl);
    const auditEvent = AuditEventSchema.parse({
      id: 'audit_actor_demo',
      actor: { kind: 'user', id: 'user_owner' },
      subject: {
        kind: 'automation',
        id: 'automation_invitation',
        responsibleUserId: 'user_owner',
      },
      action: 'workspace.member.add',
      outcome: 'succeeded',
      summary: 'Workspace member added.',
    });

    expect(validate(auditEvent)).toBe(true);
    expect(validate({ ...auditEvent, resourceRevision: 2 })).toBe(true);
    expect(validate({ ...auditEvent, resourceRevision: 0 })).toBe(false);
    expect(validate({ ...auditEvent, actorId: 'user_owner' })).toBe(false);
    expect(
      validate({
        ...auditEvent,
        actor: { kind: 'automation', id: 'automation_invitation' },
      })
    ).toBe(false);
    expect(
      validate({
        ...auditEvent,
        credential: { token: 'secret' },
        channel: { authorization: 'Bearer secret' },
      })
    ).toBe(false);
  });

  it('accepts valid item delta matrix combinations', () => {
    const validate = createValidator();
    const envelope = {
      protocolVersion: PROTOCOL_VERSION,
      event: 'item.delta',
      sequence: 1,
      requestId: '0190f4c8-0000-7000-8000-000000000130',
      timestamp: '2026-05-27T00:00:00Z',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      data: {
        type: 'item-delta',
        itemId: 'it_assistant',
        itemType: 'assistant-message',
        deltaKind: 'text-delta',
        delta: 'hello',
      },
    };

    expect(validate(envelope)).toBe(true);
  });

  it('rejects invalid item delta matrix combinations', () => {
    const validate = createValidator();
    const envelope = {
      protocolVersion: PROTOCOL_VERSION,
      event: 'item.delta',
      sequence: 1,
      requestId: '0190f4c8-0000-7000-8000-000000000131',
      timestamp: '2026-05-27T00:00:00Z',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_demo',
      data: {
        type: 'item-delta',
        itemId: 'it_artifact',
        itemType: 'artifact-reference',
        deltaKind: 'text-delta',
        delta: 'Artifact references cannot stream text deltas.',
      },
    };

    expect(validate(envelope)).toBe(false);
  });

  it('requires human gates to match awaiting human turns', () => {
    const validate = createValidator(turnSchemaUrl);
    const baseTurn = {
      id: 'tu_demo',
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      triggerActor: { kind: 'user', id: 'user_demo' },
      items: [],
      error: null,
      configVersion: null,
      startedAt: '2026-05-27T00:00:00Z',
      completedAt: null,
      durationMs: null,
    };
    const { triggerActor: _triggerActor, ...turnWithoutTriggerActor } = baseTurn;

    expect(validate({ ...turnWithoutTriggerActor, status: 'running', humanGate: null })).toBe(
      false
    );
    expect(
      validate({
        ...baseTurn,
        status: 'awaiting_human',
        humanGate: {
          kind: 'approval',
          approvalRequestId: 'ap_demo',
          itemId: 'it_approval_demo',
        },
      })
    ).toBe(true);
    expect(validate({ ...baseTurn, status: 'awaiting_human', humanGate: null })).toBe(false);
    expect(
      validate({
        ...baseTurn,
        status: 'running',
        humanGate: {
          kind: 'user-input',
          userInputRequestId: 'ui_demo',
          itemId: 'it_question_demo',
        },
      })
    ).toBe(false);
    expect(validate({ ...baseTurn, status: 'awaiting_approval', humanGate: null })).toBe(false);
  });

  it('accepts terminal turn completion records with stop reasons', () => {
    const validate = createValidator();

    expect(validate(createTurnCompletedEnvelope('completed'))).toBe(true);
    expect(validate(createTurnCompletedEnvelope('ask_user'))).toBe(true);
    expect(validate(createTurnCompletedEnvelope('budget_exhausted'))).toBe(true);
  });

  it('rejects terminal turn completion records with missing or invalid stop reasons', () => {
    const validate = createValidator();
    const missingStopReasonEnvelope = createTurnCompletedEnvelope();
    delete (missingStopReasonEnvelope.data as { stopReason?: string }).stopReason;

    expect(validate(missingStopReasonEnvelope)).toBe(false);
    expect(validate(createTurnCompletedEnvelope('unknown'))).toBe(false);
  });

  it('generates a standalone StopReason JSON Schema artifact', () => {
    const validate = createValidator(stopReasonSchemaUrl);

    expect(validate('completed')).toBe(true);
    expect(validate('error')).toBe(true);
    expect(validate('aborted')).toBe(true);
    expect(validate('length')).toBe(true);
    expect(validate('ask_user')).toBe(true);
    expect(validate('budget_exhausted')).toBe(true);
    expect(validate('unknown')).toBe(false);
  });

  it('preserves representable CapabilityCall timestamp lifecycle constraints', () => {
    const validate = createValidator(capabilityCallSchemaUrl);
    const terminal = CapabilityCallSchema.parse({
      agentSessionId: null,
      capabilityId: 'llm.responses',
      completedAt: '2026-07-05T00:00:02.000Z',
      errorCode: null,
      id: 'cap_demo',
      startedAt: '2026-07-05T00:00:01.000Z',
      status: 'succeeded',
      summary: null,
      threadId: null,
      turnId: null,
      workspaceId: 'ws_demo',
    });

    expect(validate(terminal)).toBe(true);
    expect(validate({ ...terminal, completedAt: null })).toBe(false);
    expect(validate({ ...terminal, completedAt: null, startedAt: null, status: 'queued' })).toBe(
      true
    );
    expect(validate({ ...terminal, completedAt: null, startedAt: null, status: 'running' })).toBe(
      false
    );
    expect(
      validate({
        ...terminal,
        completedAt: '2026-07-05T00:00:02.000Z',
        startedAt: null,
        status: 'running',
      })
    ).toBe(false);

    const reversedInstants = {
      ...terminal,
      completedAt: '2026-07-05T01:30:00.000+01:00',
      startedAt: '2026-07-05T01:00:00.000Z',
    };
    expect(CapabilityCallSchema.safeParse(reversedInstants).success).toBe(false);
    expect(validate(reversedInstants)).toBe(true);
    expect(loadJsonSchema(capabilityCallSchemaUrl)).toMatchObject({
      description: expect.stringContaining('JSON Schema cannot compare sibling date-time values'),
    });
  });
});
