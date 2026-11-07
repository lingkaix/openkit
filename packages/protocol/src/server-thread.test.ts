import { expect, it } from 'vitest';
import { allocateEntityId } from './common/entity-id.js';
import { ServerTurnEventEnvelopeSchema } from './events/envelope.js';

const timestamp = '2026-10-18T00:00:00.000Z';

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
