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

it('validates Server-owned thread, turn, and record-less transcript events while refusing workspace scope', () => {
  const workspaceId = allocateEntityId('ws');
  const threadId = allocateEntityId('th');
  const turnId = allocateEntityId('tu');
  const baseEnvelope = {
    owner: { kind: 'server' as const },
    protocolVersion: '0.7.0',
    sequence: 2,
    requestId: null,
    timestamp,
    threadId,
    turnId,
  };
  const serverThread = {
    id: threadId,
    owner: { kind: 'server' as const },
    name: 'Maintenance',
    preview: 'Run',
    status: 'active' as const,
    entryPath: 'knowledge-manager' as const,
    visibility: 'server' as const,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const serverTurn = {
    id: turnId,
    owner: { kind: 'server' as const },
    threadId,
    triggerActor: { kind: 'system' as const, id: 'scheduler', responsibleUserId: null },
    items: [],
    status: 'completed' as const,
    error: null,
    configVersion: null,
    startedAt: timestamp,
    completedAt: timestamp,
    durationMs: 0,
  };

  for (const valid of [
    { event: 'thread.created', data: { type: 'thread-created', thread: serverThread } },
    { event: 'turn.updated', data: { type: 'turn-updated', turn: serverTurn } },
    {
      event: 'turn.completed',
      data: { type: 'turn-completed', stopReason: 'completed', turn: serverTurn },
    },
    { event: 'turn.started', data: { type: 'turn-started', turnId, status: 'running' } },
    { event: 'error', data: { type: 'error', code: 'failed', message: 'Failed.' } },
  ]) {
    expect(ServerTurnEventEnvelopeSchema.safeParse({ ...baseEnvelope, ...valid }).success).toBe(
      true
    );
  }

  for (const invalid of [
    {
      ...baseEnvelope,
      workspaceId,
      event: 'turn.started',
      data: { type: 'turn-started', turnId, status: 'running' },
    },
    {
      ...baseEnvelope,
      event: 'thread.created',
      data: {
        type: 'thread-created',
        thread: {
          ...serverThread,
          owner: { kind: 'workspace', workspaceId },
          visibility: 'workspace',
        },
      },
    },
    {
      ...baseEnvelope,
      event: 'turn.updated',
      data: {
        type: 'turn-updated',
        turn: { ...serverTurn, owner: { kind: 'workspace', workspaceId } },
      },
    },
    {
      ...baseEnvelope,
      event: 'workspace.updated',
      data: { type: 'workspace-updated', workspace: {} },
    },
  ]) {
    expect(ServerTurnEventEnvelopeSchema.safeParse(invalid).success).toBe(false);
  }
});
