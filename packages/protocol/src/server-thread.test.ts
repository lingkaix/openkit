import { describe, expect, it } from 'vitest';
import { allocateEntityId } from './common/entity-id.js';
import { ServerItemSchema } from './models/item.js';
import { ServerThreadSchema, ThreadSchema } from './models/thread.js';

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
    expect(ServerThreadSchema.parse({ ...thread, description: 'additive' })).toEqual(thread);
    expect(
      ServerThreadSchema.safeParse({ ...thread, workspaceId: allocateEntityId('ws') }).success
    ).toBe(false);
    expect(ServerThreadSchema.safeParse({ ...thread, owner: { kind: 'future' } }).success).toBe(
      false
    );
    expect(ThreadSchema.safeParse(thread).success).toBe(false);
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
    expect(ServerItemSchema.parse(item)).toEqual(item);
    expect(
      ServerItemSchema.safeParse({ ...item, workspaceId: allocateEntityId('ws') }).success
    ).toBe(false);
  });
});
