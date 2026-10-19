import { describe, expect, it } from 'vitest';
import { ActorRefSchema } from '../models/actor.js';
import { ThreadSchema } from '../models/thread.js';
import {
  AccessTokenIdSchema,
  ArtifactIdSchema,
  AuditEventIdSchema,
  PermissionDecisionIdSchema,
  UserIdSchema,
  VaultGrantIdSchema,
  WorkspaceIdSchema,
} from './ids.js';
import { parseReferenceScope, RetrievalTraceReferenceSchema } from './object-reference.js';

const uuid7 = '01890f3e-0000-7000-8000-000000000001';
const uuid5 = '01890f3e-0000-5000-8000-000000000001';
const uuid4 = '01890f3e-0000-4000-8000-000000000001';

describe('owned identifier admission boundaries', () => {
  it('uses the same canonical grammar in a named schema and its JSON Schema projection', () => {
    const schema = WorkspaceIdSchema.toJSONSchema();
    expect(schema.type).toBe('string');
    const projected = new RegExp(schema.pattern!);
    for (const value of [
      `ws_${uuid7}`,
      `ws_${uuid5}`,
      `th_${uuid7}`,
      `ws_${uuid4}`,
      `ws_${uuid7}\n`,
      `ws_${uuid7.toUpperCase()}`,
      `ws_${uuid7.replace('-8000-', '-c000-')}`,
      'ws_legacy',
    ]) {
      expect(projected.test(value)).toBe(WorkspaceIdSchema.safeParse(value).success);
    }
    expect(projected.test(`ws_${uuid7}`)).toBe(true);
    expect(projected.test(`ws_${uuid5}`)).toBe(true);
    expect(projected.test(`ws_${uuid4}`)).toBe(false);
  });
  it('admits declared derived kinds and refuses derived forms for independent-only kinds', () => {
    expect(ArtifactIdSchema.safeParse(`ar_${uuid5}`).success).toBe(true);
    expect(AccessTokenIdSchema.safeParse(`tok_${uuid5}`).success).toBe(true);
    expect(AuditEventIdSchema.safeParse(`aud_${uuid5}`).success).toBe(true);
    expect(PermissionDecisionIdSchema.safeParse(`pd_${uuid5}`).success).toBe(true);
    expect(UserIdSchema.safeParse(`usr_${uuid5}`).success).toBe(false);
    expect(VaultGrantIdSchema.safeParse(`grant_${uuid5}`).success).toBe(false);
    expect(VaultGrantIdSchema.safeParse(`grant_${uuid7}`).success).toBe(true);
  });
  it('validates R2 scope components at their expected kinds without decoding them', () => {
    expect(parseReferenceScope(`page/user/usr_${uuid7}/kb_${uuid7}`)).toEqual({
      family: 'page',
      kind: 'user',
      userId: `usr_${uuid7}`,
      knowledgeBaseId: `kb_${uuid7}`,
    });
    expect(
      parseReferenceScope(`retrieval-trace/turn/ws_${uuid5}/th_${uuid5}/tu_${uuid7}`)
    ).toMatchObject({ family: 'retrieval-trace', kind: 'turn' });
    for (const invalid of [
      `page/user/user_local/kb_${uuid7}`,
      `page/user/usr_${uuid5}/kb_${uuid7}`,
      `page/workspace/th_${uuid7}/kb_${uuid7}`,
      `page/workspace/ws_${uuid4}/kb_${uuid7}`,
      `retrieval-trace/turn/ws_${uuid7}/th_${uuid7}/th_${uuid7}`,
      `page/workspace/ws_%30${uuid7.slice(1)}/kb_${uuid7}`,
    ]) {
      expect(parseReferenceScope(invalid)).toBeNull();
    }
    expect(
      RetrievalTraceReferenceSchema.safeParse({
        scopeId: `retrieval-trace/thread/ws_${uuid5}/th_${uuid7}`,
        objectId: `krt_${uuid5}`,
      }).success
    ).toBe(true);
    expect(
      RetrievalTraceReferenceSchema.safeParse({
        scopeId: `retrieval-trace/thread/ws_${uuid5}/th_${uuid7}`,
        objectId: `krt_${uuid4}`,
      }).success
    ).toBe(false);
  });
  it('requires canonical human and automation identity while preserving authored actor selectors', () => {
    expect(ActorRefSchema.safeParse({ kind: 'user', id: `usr_${uuid7}` }).success).toBe(true);
    expect(ActorRefSchema.safeParse({ kind: 'user', id: `ws_${uuid7}` }).success).toBe(false);
    expect(
      ActorRefSchema.safeParse({
        kind: 'automation',
        id: `auto_${uuid7}`,
        responsibleUserId: `usr_${uuid7}`,
      }).success
    ).toBe(true);
    expect(
      ActorRefSchema.safeParse({ kind: 'automation', id: 'auto_legacy', responsibleUserId: null })
        .success
    ).toBe(false);
    expect(
      ActorRefSchema.safeParse({ kind: 'agent', id: 'authored-agent', responsibleUserId: null })
        .success
    ).toBe(true);
    expect(
      ActorRefSchema.safeParse({
        kind: 'system',
        id: 'pending-owner',
        responsibleUserId: 'user_local',
      }).success
    ).toBe(false);
  });
  it('retains the separate receiving Thread parent and refuses wrong-kind ownership', () => {
    const thread = {
      id: `th_${uuid7}`,
      workspaceId: `ws_${uuid7}`,
      parentThreadId: `th_${uuid5}`,
      name: 'Receiving work',
      preview: 'Handoff',
      status: 'active',
      entryPath: 'conversation',
      visibility: 'workspace',
      createdAt: '2026-10-16T00:00:00.000Z',
      updatedAt: '2026-10-16T00:00:00.000Z',
    };
    expect(ThreadSchema.parse(thread).parentThreadId).toBe(thread.parentThreadId);
    expect(ThreadSchema.safeParse({ ...thread, parentThreadId: thread.workspaceId }).success).toBe(
      false
    );
    expect(ThreadSchema.safeParse({ ...thread, parentThreadId: thread.id }).success).toBe(false);
  });
});
