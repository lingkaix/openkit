import { ListAuthorizedWorkspacesResponseSchema } from '@openkit/app-api-schemas';
import { describe, expect, it } from 'vitest';
import { FsStore } from './lib/store.js';
import { createAppWithWorkspaceAuthority as createApp } from './test-support/app.js';

describe('personal Workspace mode', () => {
  it('provisions the ordinary owner-only personal Workspace', async () => {
    const app = createApp({ store: new FsStore() });
    const res = await app.request('/api/app/operations/workspace.list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = ListAuthorizedWorkspacesResponseSchema.parse(await res.json());

    expect(body.items.map((entry) => entry.workspace)).toContainEqual(
      expect.objectContaining({
        id: 'ws_quick_chat',
        name: 'Personal',
        kind: 'personal',
      })
    );
  });
});
