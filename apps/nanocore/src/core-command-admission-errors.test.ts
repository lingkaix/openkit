import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORE_COMMAND_OPERATION_DEFINITIONS } from '@openkit/app-api-schemas';
import { expect, it, vi } from 'vitest';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { ensureLocalUser } from './auth/identity.js';
import type { FsStore } from './lib/store.js';
import { feedbackFilePath } from './runtime/feedback.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { operationRequest } from './test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';
import { WorkspaceMutationAdmission } from './workspace-mutation-admission.js';

const operations = [
  'workspace.read',
  'workspace.update',
  'workspace.dashboard',
  'thread.list',
  'thread.update',
  'thread.archive',
  'turn.start',
  'turn.interrupt',
  'turn.feedback',
  'chat.quick',
] as const;

/** Captures all canonical rows, including other Threads and the actor's Quick Chat Workspace. */
function snapshot(store: FsStore) {
  return {
    workspaces: store.listWorkspaces().map((workspace) => ({
      workspace,
      threads: store.listThreads(workspace.id).map((thread) => ({
        thread,
        turns: store.listThreadTurns(workspace.id, thread.id),
      })),
    })),
    receipts: store.listCommandRequests(),
  };
}

it.each(
  operations
)('%s unexpected admission failure reaches the HTTP error handler without effects or disclosure', async (id) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-core-command-admission-'));
  const coreDb = openCoreDb(dataRoot);
  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot });
    for (const workspace of store.listWorkspaces()) {
      recordWorkspaceOwnerMembership({
        coreDb,
        ownerUserId: 'user_local',
        workspaceId: workspace.id,
      });
    }
    const thread = store.createThread('ws_demo', 'Admission sentinel', undefined, 'conversation', {
      visibility: 'workspace',
    });
    const turn = store.createTurn('ws_demo', thread.id, 'Retained Turn', {
      kind: 'user',
      id: 'user_local',
    });
    const token = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: 'user_local',
      scope: 'workspace',
      workspaceIds: store.listWorkspaces().map((workspace) => workspace.id),
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const admission = new WorkspaceMutationAdmission();
    const app = createApp({
      coreDb,
      dataRoot,
      store,
      mode: 'server',
      workspaceMutationAdmission: admission,
    });
    const failure = new Error(`Private unexpected admission sentinel: ${id}`);
    const observed: Error[] = [];
    app.onError((error, context) => {
      observed.push(error);
      return context.text('Internal Server Error', 500);
    });
    const fence = vi.spyOn(admission, 'isClosed').mockImplementation(() => {
      throw failure;
    });
    const enter = vi.spyOn(admission, 'enter');
    const workspaceId =
      id === 'chat.quick'
        ? store.listWorkspaces().find((workspace) => workspace.kind === 'quick-chat')!.id
        : 'ws_demo';
    const inputs = {
      'workspace.read': { workspaceId },
      'workspace.update': { workspaceId, name: 'Must not rename', requestId: randomUUID() },
      'workspace.dashboard': { workspaceId },
      'thread.list': { workspaceId },
      'thread.update': {
        workspaceId,
        threadId: thread.id,
        name: 'Must not rename',
        requestId: randomUUID(),
      },
      'thread.archive': { workspaceId, threadId: thread.id, requestId: randomUUID() },
      'turn.start': {
        workspaceId,
        threadId: thread.id,
        input: 'Must not start',
        requestId: randomUUID(),
      },
      'turn.interrupt': {
        workspaceId,
        threadId: thread.id,
        turnId: turn.id,
        requestId: randomUUID(),
      },
      'turn.feedback': { turnId: turn.id, rating: 'good', note: 'Must not write' },
      'chat.quick': { input: 'Must not dispatch', stream: false },
    };
    expect(
      Object.keys(CORE_COMMAND_OPERATION_DEFINITIONS)
        .filter((key) => key !== 'workspace.create')
        .sort()
    ).toEqual([...operations].sort());
    const before = snapshot(store);
    const feedback = feedbackFilePath(store, turn);
    expect(existsSync(feedback)).toBe(false);
    const request = operationRequest(id, {}, { body: JSON.stringify(inputs[id]) });
    const unauthenticated = await app.request(...request);
    expect(unauthenticated.status).toBe(401);
    expect(fence).not.toHaveBeenCalled();
    expect(observed).toEqual([]);
    const headers = new Headers(request[1].headers);
    headers.set('authorization', `Bearer ${token.secret}`);
    const response = await app.request(request[0], { ...request[1], headers });
    expect(fence).toHaveBeenCalledExactlyOnceWith(workspaceId);
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toBe('Internal Server Error');
    expect(body).not.toContain(failure.message);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toBe(failure);
    expect(enter).not.toHaveBeenCalled();
    expect(snapshot(store)).toEqual(before);
    expect(existsSync(feedback)).toBe(false);
  } finally {
    vi.restoreAllMocks();
    coreDb.sqlite.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
