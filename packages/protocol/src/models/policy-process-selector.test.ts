import { describe, expect, it } from 'vitest';
import { allocateEntityId } from '../common/entity-id.js';
import { PolicyContainerV1Schema, PolicyScopeV1Schema } from './policy-v1.js';

const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
const process = {
  kind: 'process',
  workspaceId,
  threadId: 'th_00000000-0000-7000-8000-000000000001',
  turnId: 'tu_00000000-0000-7000-8000-000000000001',
};
const scope = {
  subjects: [process],
  actions: ['tool.use'],
  resources: [{ kind: 'mcp-tool', workspaceId, serverId: 'fixture', toolName: 'read' }],
};

describe('exact execution selectors and quarantine provenance', () => {
  it.each(['workspaceId', 'threadId', 'turnId'])(
    'requires the native %s identity family on a process selector',
    (field) => {
      expect(PolicyScopeV1Schema.safeParse(scope).success).toBe(true);
      expect(
        PolicyScopeV1Schema.safeParse({
          ...scope,
          subjects: [{ ...process, [field]: allocateEntityId('aud') }],
        }).success
      ).toBe(false);
    }
  );

  it('rejects extra process selector fields rather than creating an authority alias', () => {
    expect(PolicyScopeV1Schema.safeParse(scope).success).toBe(true);
    expect(
      PolicyScopeV1Schema.safeParse({ ...scope, subjects: [{ ...process, id: 'process-alias' }] })
        .success
    ).toBe(false);
  });

  it('requires the original Audit identity and Server owner for quarantine', () => {
    const anchor = {
      owner: { kind: 'server' },
      kind: 'quarantine',
      id: allocateEntityId('aud'),
    };
    expect(PolicyContainerV1Schema.safeParse(anchor).success).toBe(true);
    expect(
      PolicyContainerV1Schema.safeParse({ ...anchor, id: allocateEntityId('tu') }).success
    ).toBe(false);
    expect(
      PolicyContainerV1Schema.safeParse({
        ...anchor,
        owner: { kind: 'workspace', workspaceId },
      }).success
    ).toBe(false);
  });
});
