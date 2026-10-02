import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { ensureLocalUser } from './auth/identity.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createTestAgentSetup } from './test-support/agent-environment.js';
import { createAppWithWorkspaceAuthority } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { operationRequest } from './test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

/** Navigation must project current activity rather than creation order or terminal success. */
describe('conversation navigation', () => {
  it('orders working and recently replied conversations, hides foreign private and archived Threads for an ordinary member, and preserves unknown activity', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'navigation-member-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    onTestFinished(() => {
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    });
    const store = createDemoStore();
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
    const token = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: 'user_local',
      scope: 'workspace',
      workspaceIds: ['ws_demo'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    }).secret;
    store.archiveThread('ws_demo', 'th_demo');
    const older = store.createThread('ws_demo', 'Older conversation');
    const newer = store.createThread('ws_demo', 'Newer conversation');
    const working = store.createThread('ws_demo', 'Working');
    store.createThread('ws_demo', 'Private outsider', undefined, 'conversation', {
      visibility: 'private',
      privateOwnerUserId: 'user_outsider',
    });
    const archived = store.createThread('ws_demo', 'Archived');
    store.archiveThread('ws_demo', archived.id);
    const olderTurn = store.createTurn(
      'ws_demo',
      older.id,
      'Earlier input',
      { kind: 'user', id: 'user_local' },
      null,
      { startedAt: '2026-09-15T00:00:00.000Z' }
    );
    store.updateTurn(olderTurn.id, { agentId: 'quick-chat' });
    store.createItem({
      id: 'it_late_reply',
      workspaceId: 'ws_demo',
      threadId: older.id,
      turnId: olderTurn.id,
      type: 'assistant-message',
      status: 'completed',
      actor: { kind: 'agent', id: 'assistant' },
      text: 'Later reply',
      createdAt: '2026-09-15T04:00:00.000Z',
      completedAt: '2026-09-15T04:00:00.000Z',
    });
    store.updateTurn(olderTurn.id, {
      status: 'completed',
      completedAt: '2026-09-15T01:00:00.000Z',
    });
    const newerTurn = store.createTurn(
      'ws_demo',
      newer.id,
      'Newer input',
      { kind: 'user', id: 'user_local' },
      null,
      { startedAt: '2026-09-15T02:00:00.000Z' }
    );
    store.updateTurn(newerTurn.id, { agentId: 'agent_codex_host' });
    store.updateTurn(newerTurn.id, {
      status: 'completed',
      completedAt: '2026-09-15T03:00:00.000Z',
    });
    store.createTurn('ws_demo', working.id, 'Unassigned work', { kind: 'user', id: 'user_local' });
    const app = createAppWithWorkspaceAuthority({
      mode: 'server',
      coreDb,
      store,
      agentManifests: [createTestAgentSetup().manifest],
      turnExecutor: new SimulatedTurnExecutor(),
    });
    const response = await app.request(
      ...operationRequest(
        'conversation.navigation',
        { workspaceId: 'ws_demo' },
        { headers: { authorization: `Bearer ${token}` } }
      )
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.items.map((row: { thread: { id: string } }) => row.thread.id)).toEqual([
      working.id,
      older.id,
      newer.id,
    ]);
    expect(result.items[0]).toMatchObject({ activity: 'unknown', state: 'working' });
    expect(result.items[2]).toMatchObject({ activity: 'task', state: 'idle' });
    expect(result.items[1]).toMatchObject({
      activity: 'chat',
      state: 'idle',
      lastActivityAt: '2026-09-15T04:00:00.000Z',
    });
  });

  it('shows a foreign private Thread to a current administrator', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'navigation-admin-'));
    const coreDb = openCoreDb(dataRoot);
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    onTestFinished(() => {
      coreDb.sqlite.close();
      rmSync(dataRoot, { recursive: true, force: true });
    });
    const store = createDemoStore();
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
    const outsider = store.createThread('ws_demo', 'Private outsider', undefined, 'conversation', {
      visibility: 'private',
      privateOwnerUserId: 'user_outsider',
    });
    const app = createAppWithWorkspaceAuthority({
      mode: 'server',
      coreDb,
      store,
      agentManifests: [createTestAgentSetup().manifest],
      turnExecutor: new SimulatedTurnExecutor(),
    });
    const admin = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: 'user_local',
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    }).secret;
    const adminResponse = await app.request(
      ...operationRequest(
        'conversation.navigation',
        { workspaceId: 'ws_demo' },
        { headers: { authorization: `Bearer ${admin}` } }
      )
    );
    expect(adminResponse.status).toBe(200);
    expect(
      (await adminResponse.json()).items.map((row: { thread: { id: string } }) => row.thread.id)
    ).toContain(outsider.id);
  });
});
