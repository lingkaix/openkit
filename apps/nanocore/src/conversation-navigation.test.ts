import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { SimulatedTurnExecutor } from './lib/simulator.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createTestAgentSetup } from './test-support/agent-environment.js';
import { createAppWithWorkspaceAuthority } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { ensureLocalUser } from './test-support/local-user.js';
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
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const token = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      scope: 'workspace',
      workspaceIds: ['ws_00000000-0000-7000-8000-000000000001'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    }).secret;
    store.archiveThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001'
    );
    const older = store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Older conversation'
    );
    const newer = store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Newer conversation'
    );
    const working = store.createThread('ws_00000000-0000-7000-8000-000000000001', 'Working');
    store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Private outsider',
      undefined,
      'conversation',
      {
        visibility: 'private',
        privateOwnerUserId: 'usr_00000000-0000-76a2-91eb-629d90835e80',
      }
    );
    const archived = store.createThread('ws_00000000-0000-7000-8000-000000000001', 'Archived');
    store.archiveThread('ws_00000000-0000-7000-8000-000000000001', archived.id);
    const olderTurn = store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      older.id,
      'Earlier input',
      { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      null,
      { startedAt: '2026-09-15T00:00:00.000Z' }
    );
    store.updateTurn(olderTurn.id, { agentId: 'quick-chat' });
    store.createItem({
      id: 'it_00000000-0000-76ec-a4bd-a0ffd301133c',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
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
      'ws_00000000-0000-7000-8000-000000000001',
      newer.id,
      'Newer input',
      { kind: 'user', id: 'usr_00000000-0000-7000-8000-000000000001' },
      null,
      { startedAt: '2026-09-15T02:00:00.000Z' }
    );
    store.updateTurn(newerTurn.id, { agentId: 'agent_codex_host' });
    store.updateTurn(newerTurn.id, {
      status: 'completed',
      completedAt: '2026-09-15T03:00:00.000Z',
    });
    store.createTurn('ws_00000000-0000-7000-8000-000000000001', working.id, 'Unassigned work', {
      kind: 'user',
      id: 'usr_00000000-0000-7000-8000-000000000001',
    });
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
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
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
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      workspaceId: 'ws_00000000-0000-7000-8000-000000000001',
    });
    const outsider = store.createThread(
      'ws_00000000-0000-7000-8000-000000000001',
      'Private outsider',
      undefined,
      'conversation',
      {
        visibility: 'private',
        privateOwnerUserId: 'usr_00000000-0000-76a2-91eb-629d90835e80',
      }
    );
    const app = createAppWithWorkspaceAuthority({
      mode: 'server',
      coreDb,
      store,
      agentManifests: [createTestAgentSetup().manifest],
      turnExecutor: new SimulatedTurnExecutor(),
    });
    const admin = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: 'usr_00000000-0000-7000-8000-000000000001',
      scope: 'server-admin',
      workspaceIds: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    }).secret;
    const adminResponse = await app.request(
      ...operationRequest(
        'conversation.navigation',
        { workspaceId: 'ws_00000000-0000-7000-8000-000000000001' },
        { headers: { authorization: `Bearer ${admin}` } }
      )
    );
    expect(adminResponse.status).toBe(200);
    expect(
      (await adminResponse.json()).items.map((row: { thread: { id: string } }) => row.thread.id)
    ).toContain(outsider.id);
  });
});
