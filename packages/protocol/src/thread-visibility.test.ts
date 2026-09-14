import { describe, expect, it } from 'vitest';
import { ThreadSchema } from './models/thread.js';

const thread = {
  id: 'th_visibility',
  workspaceId: 'ws_visibility',
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
      { visibility: 'workspace', privateOwnerUserId: 'user_other' },
      { visibility: 'workspace', entryPath: 'administration' },
    ])
      expect(ThreadSchema.safeParse({ ...thread, ...invalid }).success).toBe(false);
    expect(
      ThreadSchema.parse({ ...thread, visibility: 'private', privateOwnerUserId: 'user_owner' })
    ).toMatchObject({ visibility: 'private', privateOwnerUserId: 'user_owner' });
    expect(ThreadSchema.parse({ ...thread, visibility: 'workspace' })).toMatchObject({
      visibility: 'workspace',
    });
  });
});
