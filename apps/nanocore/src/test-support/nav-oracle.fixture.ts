import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationNavigationResponseSchema } from '@openkit/app-api-schemas';
import { allocateEntityId } from '@openkit/protocol';
import { expect, onTestFinished } from 'vitest';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { createAppWithWorkspaceAuthority } from './app.js';
import { createDemoStore } from './demo-store.js';
import { ensureLocalUser, FIXTURE_LOCAL_USER_ID } from './local-user.js';
import { operationRequest } from './operation-request.js';
import { disposeTestStore } from './store.js';

/** Real owner-backed source state; no navigation producer or consumer is doubled. */
export async function navigationFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'navigation-oracle-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  onTestFinished(() => disposeTestStore(dataRoot, coreDb));
  const store = await createDemoStore({ dataRoot });
  const workspaceId = 'ws_00000000-0000-7000-8000-000000000001';
  recordWorkspaceOwnerMembership({ coreDb, ownerUserId: FIXTURE_LOCAL_USER_ID, workspaceId });
  await store.archiveThread(workspaceId, 'th_00000000-0000-7000-8000-000000000001');
  const thread = await store.createThread(workspaceId, 'Oracle conversation');
  const actor = { kind: 'user' as const, id: FIXTURE_LOCAL_USER_ID };
  const turn = await store.createTurn(workspaceId, thread.id, 'Oracle input', actor, null, {
    startedAt: '2026-09-15T00:00:00.000Z',
  });
  const app = createAppWithWorkspaceAuthority({ store, coreDb });
  const request = () =>
    app.request(...operationRequest('conversation.navigation', { workspaceId }));
  const row = async () => {
    const response = await request();
    expect(response.status).toBe(200);
    const parsed = ConversationNavigationResponseSchema.parse(await response.json());
    const selected = parsed.items.find((entry) => entry.thread.id === thread.id);
    expect(selected).toBeDefined();
    return selected!;
  };
  const message = async (
    text: string,
    type: 'assistant-message' | 'user-message' = 'assistant-message',
    own = false
  ) => {
    const id = allocateEntityId('it');
    await store.createItem({
      id,
      owner: { kind: 'workspace', workspaceId },
      threadId: thread.id,
      turnId: turn.id,
      type,
      status: 'completed',
      actor: own ? actor : { kind: 'agent', id: 'assistant', responsibleUserId: actor.id },
      text,
      createdAt: '2026-09-15T04:00:00.000Z',
      completedAt: '2026-09-15T04:00:00.000Z',
    });
    return id;
  };
  return { app, coreDb, dataRoot, store, workspaceId, thread, turn, actor, request, row, message };
}
