import { describe, expect, it } from 'vitest';
import { allocateEntityId } from './common/entity-id.js';
import { CapabilityCallSchema } from './models/capability.js';
import { ItemSchema } from './models/item.js';
import { ThreadSchema } from './models/thread.js';
import { TurnSchema } from './models/turn.js';

const timestamp = '2026-10-19T00:00:00.000Z';
const workspaceId = allocateEntityId('ws');
const otherWorkspaceId = allocateEntityId('ws');
const threadId = allocateEntityId('th');
const turnId = allocateEntityId('tu');
const actor = { kind: 'user', id: allocateEntityId('usr') };
const owners = [{ kind: 'workspace', workspaceId }, { kind: 'server' }] as const;

/** Contract fixtures use one record family; owner selection does not choose another schema. */
function records(owner: (typeof owners)[number]) {
  const item = {
    id: allocateEntityId('it'),
    owner,
    threadId,
    turnId,
    type: 'assistant-message',
    text: 'Retained answer',
    status: 'completed',
    createdAt: timestamp,
    completedAt: timestamp,
  };
  return [
    {
      name: 'Thread',
      schema: ThreadSchema,
      value: {
        id: threadId,
        owner,
        name: 'Owned work',
        preview: 'Owned work',
        status: 'active',
        entryPath: 'knowledge-manager',
        visibility: owner.kind === 'server' ? 'server' : 'workspace',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
    { name: 'Item', schema: ItemSchema, value: item },
    {
      name: 'Turn',
      schema: TurnSchema,
      value: {
        id: turnId,
        owner,
        threadId,
        triggerActor: actor,
        items: [item],
        status: 'completed',
        error: null,
        configVersion: null,
        startedAt: timestamp,
        completedAt: timestamp,
        durationMs: 0,
      },
    },
    {
      name: 'CapabilityCall',
      schema: CapabilityCallSchema,
      value: {
        id: allocateEntityId('cap'),
        owner,
        threadId,
        turnId,
        itemId: item.id,
        agentSessionId: null,
        capabilityId: 'llm.responses',
        status: 'succeeded',
        summary: null,
        errorCode: null,
        startedAt: timestamp,
        completedAt: timestamp,
      },
    },
  ];
}

describe('one canonical work family with explicit owner authority', () => {
  for (const owner of owners) {
    for (const { name, schema, value } of records(owner)) {
      it(`admits ${owner.kind} ${name} through the canonical schema`, () => {
        const parsed = schema.parse({ ...value, description: 'additive description' });
        expect(parsed).toMatchObject(value);
        expect(parsed).not.toHaveProperty('workspaceId');
        expect(parsed).not.toHaveProperty('description');
      });

      it(`refuses absent, unknown, User and incomplete owner authority on ${owner.kind} ${name}`, () => {
        const { owner: _owner, ...withoutOwner } = value;
        for (const invalidOwner of [
          undefined,
          null,
          {},
          { kind: 'future' },
          { kind: 'user', userId: actor.id },
          { kind: 'workspace' },
          { kind: 'workspace', workspaceId: null },
          { kind: 'server', workspaceId },
        ]) {
          expect(
            schema.safeParse({ ...withoutOwner, owner: invalidOwner }).success,
            JSON.stringify(invalidOwner)
          ).toBe(false);
        }
      });

      it(`refuses retired top-level Workspace authority on ${owner.kind} ${name}`, () => {
        for (const retiredWorkspaceId of [workspaceId, otherWorkspaceId, null]) {
          expect(schema.safeParse({ ...value, workspaceId: retiredWorkspaceId }).success).toBe(
            false
          );
        }
        const { owner: _owner, ...withoutOwner } = value;
        expect(schema.safeParse({ ...withoutOwner, workspaceId }).success).toBe(false);
      });
    }

    it(`refuses an embedded Item from a different owner in a ${owner.kind} Turn`, () => {
      const turn = records(owner).find((record) => record.name === 'Turn')!.value;
      const item = records(owner).find((record) => record.name === 'Item')!.value;
      const foreignOwners =
        owner.kind === 'server'
          ? [{ kind: 'workspace', workspaceId }]
          : [{ kind: 'server' }, { kind: 'workspace', workspaceId: otherWorkspaceId }];
      for (const foreignOwner of foreignOwners) {
        expect(
          TurnSchema.safeParse({ ...turn, items: [{ ...item, owner: foreignOwner }] }).success
        ).toBe(false);
      }
    });
  }

  it('keeps the Workspace private audience while refusing a private User audience on Server work', () => {
    const workspaceThread = records(owners[0])[0].value;
    expect(
      ThreadSchema.safeParse({
        ...workspaceThread,
        visibility: 'private',
        privateOwnerUserId: actor.id,
      }).success
    ).toBe(true);
    const serverThread = records(owners[1])[0].value;
    expect(ThreadSchema.safeParse({ ...serverThread, privateOwnerUserId: actor.id }).success).toBe(
      false
    );
    expect(ThreadSchema.safeParse({ ...serverThread, visibility: 'workspace' }).success).toBe(
      false
    );
  });
});
