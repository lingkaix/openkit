import { describe, expect, it } from 'vitest';
import { ThreadSchema } from './models/thread.js';

const thread = {
  id: 'th_00000000-0000-786f-b17e-bf6a02be4df9',
  workspaceId: 'ws_00000000-0000-7597-ab9d-3fade0b012de',
  name: 'Example',
  preview: 'Example',
  status: 'active',
  entryPath: 'conversation',
  createdAt: '2026-09-14T00:00:00.000Z',
  updatedAt: '2026-09-14T00:00:00.000Z',
};

describe('durable Thread audience', () => {
  it('requires explicit visibility and an owner exactly for private Threads', () => {
    expect(ThreadSchema.safeParse(thread).success).toBe(false);
    for (const invalid of [
      { visibility: 'private' },
      { visibility: 'private', privateOwnerUserId: '' },
      { visibility: 'workspace', privateOwnerUserId: 'usr_00000000-0000-73d4-904a-d4c4b905df7c' },
      { visibility: 'workspace', entryPath: 'administration' },
    ])
      expect(ThreadSchema.safeParse({ ...thread, ...invalid }).success).toBe(false);
    expect(
      ThreadSchema.parse({
        ...thread,
        visibility: 'private',
        privateOwnerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
      })
    ).toMatchObject({
      visibility: 'private',
      privateOwnerUserId: 'usr_00000000-0000-7011-88df-c2b1e8466b6f',
    });
    expect(ThreadSchema.parse({ ...thread, visibility: 'workspace' })).toMatchObject({
      visibility: 'workspace',
    });
  });
});
