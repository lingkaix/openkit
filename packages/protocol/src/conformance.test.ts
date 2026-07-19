import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import {
  ActorRefSchema,
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
  { name: 'actor-ref', schema: ActorRefSchema },
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

describe('audit event actor attribution', () => {
  const auditEvent = {
    id: 'audit_actor_demo',
    action: 'workspace.member.add',
    outcome: 'succeeded',
    summary: 'Workspace member added.',
  } as const;

  it('accepts strict nullable actor and subject references', () => {
    const actor = { kind: 'user', id: 'user_owner' } as const;
    const subject = {
      kind: 'automation',
      id: 'automation_invitation',
      responsibleUserId: 'user_owner',
    } as const;

    expect(AuditEventSchema.parse({ ...auditEvent, actor, subject })).toMatchObject({
      actor,
      subject,
    });
    expect(AuditEventSchema.parse(auditEvent)).toMatchObject({ actor: null, subject: null });
  });

  it('accepts only nullable positive resource revisions', () => {
    expect(AuditEventSchema.parse({ ...auditEvent, resourceRevision: 2 }).resourceRevision).toBe(2);
    expect(AuditEventSchema.parse(auditEvent).resourceRevision).toBeNull();
    expect(AuditEventSchema.safeParse({ ...auditEvent, resourceRevision: 0 }).success).toBe(false);
    expect(AuditEventSchema.safeParse({ ...auditEvent, resourceRevision: 1.5 }).success).toBe(
      false
    );
  });

  it('rejects legacy, malformed, and secret-bearing attribution fields', () => {
    expect(AuditEventSchema.safeParse({ ...auditEvent, actorId: 'user_owner' }).success).toBe(
      false
    );
    expect(
      AuditEventSchema.safeParse({
        ...auditEvent,
        actor: { kind: 'automation', id: 'automation_invitation' },
      }).success
    ).toBe(false);
    expect(
      AuditEventSchema.safeParse({
        ...auditEvent,
        credential: { token: 'secret' },
        channel: { authorization: 'Bearer secret' },
      }).success
    ).toBe(false);
  });
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
