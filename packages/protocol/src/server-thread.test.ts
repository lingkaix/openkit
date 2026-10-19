import { describe, expect, it } from 'vitest';
import { allocateEntityId } from './common/entity-id.js';
import { ServerTurnEventEnvelopeSchema } from './events/envelope.js';
import { ItemSchema } from './models/item.js';
import { ThreadSchema } from './models/thread.js';

const timestamp = '2026-10-18T00:00:00.000Z';

describe('Server work ownership', () => {
  it('admits the general Server owner and refuses Workspace placement or unknown owner kinds', () => {
    const thread = {
      id: allocateEntityId('th'),
      owner: { kind: 'server' },
      name: 'Server work',
      preview: 'Server work',
      status: 'active',
      entryPath: 'knowledge-manager',
      visibility: 'server',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    expect(ThreadSchema.parse({ ...thread, description: 'additive' })).toEqual(thread);
    expect(ThreadSchema.safeParse({ ...thread, workspaceId: allocateEntityId('ws') }).success).toBe(
      false
    );
    expect(ThreadSchema.safeParse({ ...thread, owner: { kind: 'future' } }).success).toBe(false);
    expect(ThreadSchema.safeParse(thread).success).toBe(true);
    const item = {
      id: allocateEntityId('it'),
      owner: { kind: 'server' },
      threadId: thread.id,
      turnId: allocateEntityId('tu'),
      type: 'assistant-message',
      text: 'Result',
      status: 'completed',
      createdAt: timestamp,
      completedAt: timestamp,
    };
    expect(ItemSchema.parse(item)).toEqual(item);
    expect(ItemSchema.safeParse({ ...item, workspaceId: allocateEntityId('ws') }).success).toBe(
      false
    );
  });
});

it('refuses a Workspace Item inside a Server-owned transcript envelope', () => {
  const threadId = allocateEntityId('th');
  const turnId = allocateEntityId('tu');
  const item = {
    id: allocateEntityId('it'),
    owner: { kind: 'workspace', workspaceId: allocateEntityId('ws') },
    threadId,
    turnId,
    type: 'assistant-message',
    text: 'Foreign',
    status: 'completed',
    createdAt: timestamp,
    completedAt: timestamp,
  };
  const event = {
    owner: { kind: 'server' },
    protocolVersion: '0.6.0',
    event: 'item.created',
    sequence: 1,
    requestId: null,
    timestamp,
    threadId,
    turnId,
    data: { type: 'item-created', item },
  };
  expect(ServerTurnEventEnvelopeSchema.safeParse(event).success).toBe(false);
  expect(
    ServerTurnEventEnvelopeSchema.safeParse({
      ...event,
      data: { ...event.data, item: { ...item, owner: { kind: 'server' } } },
    }).success
  ).toBe(true);
});
