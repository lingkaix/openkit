import { readFileSync } from 'node:fs';

import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION } from './index.js';

const eventSchemaUrl = new URL('../generated/json-schema/event.schema.json', import.meta.url);
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
      items: [],
      error: null,
      configVersion: null,
      startedAt: '2026-05-27T00:00:00Z',
      completedAt: null,
      durationMs: null,
    };

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
});
