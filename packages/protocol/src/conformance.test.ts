import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import {
  AgentSessionSchema,
  ApiErrorSchema,
  ApprovalRequestSchema,
  ArtifactSchema,
  AuditEventSchema,
  CapabilityCallSchema,
  ItemDeltaEventSchema,
  ItemSchema,
  KnowledgeEntrySchema,
  PROTOCOL_VERSION,
  SseEventEnvelopeSchema,
  ThreadSchema,
  TurnSchema,
  UsageRecordSchema,
  WorkspaceRecordSchema,
} from './index.js';

const FIXTURES_DIR = new URL('../conformance/', import.meta.url);

const cases = [
  { name: 'workspace', schema: WorkspaceRecordSchema },
  { name: 'thread', schema: ThreadSchema },
  { name: 'turn', schema: TurnSchema },
  { name: 'item', schema: ItemSchema },
  { name: 'artifact', schema: ArtifactSchema },
  { name: 'approval-request', schema: ApprovalRequestSchema },
  { name: 'agent-session', schema: AgentSessionSchema },
  { name: 'capability-call', schema: CapabilityCallSchema },
  { name: 'usage-record', schema: UsageRecordSchema },
  { name: 'audit-event', schema: AuditEventSchema },
  { name: 'knowledge-entry', schema: KnowledgeEntrySchema },
  { name: 'event-envelope', schema: SseEventEnvelopeSchema },
  { name: 'system-event-envelope', schema: SseEventEnvelopeSchema },
  { name: 'api-error', schema: ApiErrorSchema },
] as const;

const validItemDeltaCases = [
  'valid-item-delta-indexed-text',
  'valid-item-delta-request-started',
] as const;

const invalidItemDeltaCases = [
  'invalid-item-delta-missing-part-id',
  'invalid-item-delta-missing-request-ref-id',
  'invalid-item-delta-matrix',
] as const;

describe('conformance fixtures round-trip via @openkit/protocol schemas', () => {
  for (const { name, schema } of cases) {
    it(`${name}.json parses and JSON-round-trips`, () => {
      const raw = JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES_DIR), 'utf8'));
      expect(raw.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(raw.schema).toBe(name);

      const parsed = schema.parse(raw.data);

      expect(JSON.parse(JSON.stringify(parsed))).toEqual(raw.data);
    });
  }
});

describe('item delta conformance fixtures', () => {
  for (const name of validItemDeltaCases) {
    it(`${name}.json parses`, () => {
      const raw = JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES_DIR), 'utf8'));
      expect(raw.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(raw.schema).toBe('item-delta');

      expect(() => ItemDeltaEventSchema.parse(raw.data)).not.toThrow();
    });
  }

  for (const name of invalidItemDeltaCases) {
    it(`${name}.json is rejected`, () => {
      const raw = JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES_DIR), 'utf8'));
      expect(raw.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(raw.schema).toBe('item-delta');

      expect(() => ItemDeltaEventSchema.parse(raw.data)).toThrow();
    });
  }
});
