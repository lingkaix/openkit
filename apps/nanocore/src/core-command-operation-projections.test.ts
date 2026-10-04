import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BootReadinessSnapshot } from '@openkit/app-api-schemas';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCoreClient } from '../../../packages/core-client/src/index.js';
import { createOpenKitAccessTokenRecord } from './auth/access-token-store.js';
import { ensureLocalUser } from './auth/identity.js';
import { computeBootReadinessSnapshot } from './bootstrap/readiness.js';
import { FsStore } from './lib/store.js';
import { feedbackFilePath } from './runtime/feedback.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createAppWithWorkspaceAuthority } from './test-support/app.js';
import { createDemoStore } from './test-support/demo-store.js';
import { operationRequest } from './test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Each request reaches a concrete owner response under real local Workspace authority. */
function fixture(bootReadiness?: BootReadinessSnapshot) {
  const root = mkdtempSync(join(tmpdir(), 'openkit-core-command-cutover-'));
  roots.push(root);
  const store = createDemoStore({ dataRoot: root });
  const thread = store.createThread('ws_demo', 'Commands', undefined, 'conversation', {
    visibility: 'workspace',
  });
  const turn = store.createTurn('ws_demo', thread.id, 'Interrupt me', {
    kind: 'user',
    id: 'user_local',
  });
  const idle = store.createThread('ws_demo', 'Idle', undefined, 'conversation', {
    visibility: 'workspace',
  });
  const app = createAppWithWorkspaceAuthority({
    store,
    ...(bootReadiness ? { bootReadiness } : {}),
  });
  const requestId = randomUUID();
  return {
    store,
    app,
    thread,
    turn,
    rows: [
      ['workspace.create', 'POST', '/api/workspaces', { name: 'Created', requestId }, 201],
      ['workspace.read', 'GET', '/api/workspaces/ws_demo', {}, 200],
      ['workspace.update', 'PATCH', '/api/workspaces/ws_demo', { name: 'Renamed', requestId }, 200],
      ['workspace.dashboard', 'GET', '/api/app/workspaces/ws_demo/dashboard', {}, 200],
      ['thread.list', 'GET', '/api/workspaces/ws_demo/threads', {}, 200],
      [
        'thread.update',
        'PATCH',
        `/api/workspaces/ws_demo/threads/${thread.id}`,
        { name: 'Renamed', requestId },
        200,
      ],
      [
        'thread.archive',
        'POST',
        `/api/workspaces/ws_demo/threads/${thread.id}/archive`,
        { requestId },
        200,
      ],
      [
        'turn.start',
        'POST',
        '/api/turns',
        { workspaceId: 'ws_demo', threadId: idle.id, input: 'Hello', requestId },
        409,
      ],
      [
        'turn.interrupt',
        'POST',
        `/api/workspaces/ws_demo/threads/${thread.id}/turns/${turn.id}/interrupt`,
        { workspaceId: 'ws_demo', threadId: thread.id, turnId: turn.id, requestId },
        404,
      ],
      [
        'turn.feedback',
        'POST',
        `/api/turns/${turn.id}/feedback`,
        { rating: 'good', note: 'Useful' },
        200,
      ],
      ['chat.quick', 'POST', '/api/app/quick-chat', { input: 'Hello', stream: false }, 500],
    ] as const,
  };
}

describe('core command operation cutover', () => {
  for (let index = 0; index < 11; index++) {
    it(`retires former route ${index + 1} after an authorized owner response on the base`, async () => {
      const { app, rows, store } = fixture();
      const [id, method, path, body] = rows[index]!;
      const before = store.listCommandRequests();
      const response = await app.request(path, {
        method,
        ...(method === 'GET'
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      expect(response.status, id).toBe(404);
      expect(await response.text()).toBe('404 Not Found');
      expect(store.listCommandRequests()).toEqual(before);
    });
    for (const projection of ['http', 'client', 'cli'] as const) {
      it(`preserves owner outcome ${index + 1} through ${projection}`, async () => {
        const { app, rows, store, thread, turn } = fixture();
        const [id, , , body, status] = rows[index]!;
        const selectors =
          id === 'workspace.create' || id === 'chat.quick'
            ? {}
            : id === 'turn.feedback'
              ? { turnId: turn.id }
              : id.startsWith('thread.') && id !== 'thread.list'
                ? { workspaceId: 'ws_demo', threadId: thread.id }
                : id === 'turn.interrupt'
                  ? { workspaceId: 'ws_demo', threadId: thread.id, turnId: turn.id }
                  : { workspaceId: 'ws_demo' };
        const input = { ...body, ...selectors };
        const before = store.getTurnById(turn.id);
        const receipts = store.listCommandRequests();
        const client = createCoreClient({
          baseUrl: 'http://localhost',
          fetch: (request, init) =>
            app.request(request instanceof Request ? request : String(request), init),
        });
        let output: unknown;
        if (projection === 'http') {
          const response = await app.request(
            ...operationRequest(id, selectors, { body: JSON.stringify(body) })
          );
          expect(response.status, id).toBe(status);
          output = await response.json();
        } else {
          const call =
            projection === 'client'
              ? () => client.operations[id](input as never)
              : async () => {
                  const { operationCatalog } = await import(
                    '../../../skills/openkit-operations.mjs'
                  );
                  const row = operationCatalog.find((entry: { id: string }) => entry.id === id)!;
                  return row.handler({ client }, row.inputSchema.parse(input));
                };
          if (status >= 400) {
            try {
              await call();
              throw new Error('Expected the owner refusal.');
            } catch (error) {
              expect(error).toMatchObject({
                status,
                code:
                  id === 'turn.start'
                    ? 'agent_not_configured'
                    : id === 'turn.interrupt'
                      ? 'turn_interrupt_failed'
                      : 'quick_chat_failed',
              });
            }
          } else output = await call();
        }
        if (status >= 400) {
          if (projection === 'http')
            expect(output).toMatchObject({
              code:
                id === 'turn.start'
                  ? 'agent_not_configured'
                  : id === 'turn.interrupt'
                    ? 'turn_interrupt_failed'
                    : 'quick_chat_failed',
            });
          expect(store.getTurnById(turn.id)).toEqual(before);
          expect(store.listCommandRequests()).toEqual(receipts);
        } else if (id === 'turn.feedback')
          expect(output).toMatchObject({ turnId: turn.id, rating: 'good', note: 'Useful' });
        else if (id === 'thread.archive')
          expect(output).toMatchObject({ id: thread.id, status: 'archived' });
        else if (id === 'workspace.create') expect(output).toMatchObject({ name: 'Created' });
        else expect(output).toBeTypeOf('object');
      });
    }
  }
});

for (const index of [0, 2, 5, 6]) {
  it(`replays command ${index + 1} without a second canonical receipt`, async () => {
    const { app, rows, store, thread } = fixture();
    const [id, , , body, status] = rows[index]!;
    const selectors =
      id === 'workspace.create'
        ? {}
        : id.startsWith('thread.')
          ? { workspaceId: 'ws_demo', threadId: thread.id }
          : { workspaceId: 'ws_demo' };
    const response = await app.request(
      ...operationRequest(id, selectors, { body: JSON.stringify(body) })
    );
    expect(response.status).toBe(status);
    const output = await response.json();
    const receipts = store.listCommandRequests();
    expect(receipts.filter((row) => row.command === id)).toHaveLength(1);
    const replay = await app.request(
      ...operationRequest(id, selectors, { body: JSON.stringify(body) })
    );
    expect(replay.status).toBe(status);
    expect(await replay.json()).toEqual(output);
    expect(store.listCommandRequests()).toEqual(receipts);
  });
}

it('gates every migrated HTTP mutation before Workspace, Turn, feedback or receipt writes', async () => {
  const bootReadiness = computeBootReadinessSnapshot({
    bootId: 'boot_core_commands',
    subsystems: {
      storage: {
        state: 'failed',
        reasons: [{ code: 'storage.failed', message: 'Unavailable.', blocks: ['product_work'] }],
      },
    },
  });
  const { app, rows, store, thread, turn } = fixture(bootReadiness);
  const workspaces = store.listWorkspaces();
  const threads = store.listThreads('ws_demo');
  const receipts = store.listCommandRequests();
  const feedbackPath = feedbackFilePath(store, turn);
  expect(existsSync(feedbackPath)).toBe(false);
  for (const index of [0, 2, 5, 6, 7, 8, 9, 10]) {
    const [id, , , body] = rows[index]!;
    const selectors =
      id === 'workspace.create' || id === 'chat.quick'
        ? {}
        : id === 'turn.feedback'
          ? { turnId: turn.id }
          : {
              workspaceId: 'ws_demo',
              ...(id.startsWith('thread.') ? { threadId: thread.id } : {}),
            };
    const response = await app.request(
      ...operationRequest(id, selectors, { body: JSON.stringify(body) })
    );
    expect(response.status, id).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'product_work_unavailable' });
    expect(store.listWorkspaces()).toEqual(workspaces);
    expect(store.listThreads('ws_demo')).toEqual(threads);
    expect(store.getTurnById(turn.id)).toEqual(turn);
    expect(existsSync(feedbackPath)).toBe(false);
    expect(store.listCommandRequests()).toEqual(receipts);
  }
});

it('keeps workspace.update lifecycle admission and refuses an editor before row or receipt writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-workspace-update-editor-'));
  roots.push(root);
  const store = createDemoStore({ dataRoot: root });
  const coreDb = openCoreDb(root);
  try {
    applyMigrations(coreDb);
    const now = Date.now();
    const timestamp = new Date(now).toISOString();
    coreDb.sqlite
      .prepare(
        `INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind) VALUES ('user_owner', 'Owner', 'owner@example.com', false, ?, ?, 'human'), ('user_editor', 'Editor', 'editor@example.com', false, ?, ?, 'human')`
      )
      .run(now, now, now, now);
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_owner', workspaceId: 'ws_demo' });
    coreDb.sqlite
      .prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, status, access_level, invitation_id, joined_at, removed_at, revision, created_at, updated_at) VALUES ('ws_demo', 'user_editor', 'active', 'editor', NULL, ?, NULL, 1, ?, ?)`
      )
      .run(timestamp, timestamp, timestamp);
    const app = createAppWithWorkspaceAuthority({
      store,
      coreDb,
      mode: 'server',
      auth: {
        api: {
          getSession: async () => ({
            session: { id: 'session_editor' },
            user: { id: 'user_editor' },
          }),
        },
        handler: async () => Response.json({ status: 'auth-ok' }),
      },
    });
    const before = store.getWorkspace('ws_demo');
    const receipts = store.listCommandRequests();
    const response = await app.request(
      ...operationRequest(
        'workspace.update',
        { workspaceId: 'ws_demo' },
        { body: JSON.stringify({ name: 'Editor rename', requestId: randomUUID() }) }
      )
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'workspace_access_denied' });
    expect(store.getWorkspace('ws_demo')).toEqual(before);
    expect(store.listCommandRequests()).toEqual(receipts);
  } finally {
    coreDb.sqlite.close();
  }
});

it.each([
  0, 2,
])('preserves command %s fallback after its receipt commits but count projection fails', async (index) => {
  const { app, rows, store } = fixture();
  const [id, , , body] = rows[index]!;
  let committed = false;
  const recordCommandRequest = store.recordCommandRequest.bind(store);
  vi.spyOn(store, 'recordCommandRequest').mockImplementation((...args) => {
    const receipt = recordCommandRequest(...args);
    committed = true;
    return receipt;
  });
  const listThreads = store.listThreads.bind(store);
  vi.spyOn(store, 'listThreads').mockImplementation((workspaceId) => {
    if (committed) throw new Error('Count projection unavailable.');
    return listThreads(workspaceId);
  });
  const response = await app.request(
    ...operationRequest(id, id === 'workspace.create' ? {} : { workspaceId: 'ws_demo' }, {
      body: JSON.stringify(body),
    })
  );
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({
    code: id === 'workspace.create' ? 'workspace_create_failed' : 'workspace_update_failed',
    message: 'Count projection unavailable.',
  });
  const receipt = store.listCommandRequests().filter((row) => row.command === id);
  expect(receipt).toHaveLength(1);
  expect(new FsStore({ dataRoot: store.getDataRoot()! }).listCommandRequests()).toEqual(receipt);
  expect(store.getWorkspace(receipt[0]!.response.id).name).toBe(
    id === 'workspace.create' ? 'Created' : 'Renamed'
  );
});

it.each([
  'HTTP',
  'MCP',
] as const)('preserves missing interrupt outcome through %s without changes', async (projection) => {
  const root = mkdtempSync(join(tmpdir(), 'openkit-missing-interrupt-'));
  roots.push(root);
  const coreDb = openCoreDb(root);
  try {
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    const store = createDemoStore({ dataRoot: root });
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_local', workspaceId: 'ws_demo' });
    const issued = createOpenKitAccessTokenRecord(coreDb, {
      ownerUserId: 'user_local',
      scope: 'workspace',
      workspaceIds: ['ws_demo'],
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const app = createAppWithWorkspaceAuthority({ store, coreDb, mode: 'server' });
    const input = {
      workspaceId: 'ws_demo',
      threadId: 'th_demo',
      turnId: 'tu_missing',
      requestId: randomUUID(),
    };
    const observed = () => ({
      workspace: store.getWorkspace('ws_demo'),
      thread: store.getThread('ws_demo', 'th_demo'),
      turns: store.listThreadTurns('ws_demo', 'th_demo'),
      items: store.listThreadItems('ws_demo', 'th_demo'),
      receipts: store.listCommandRequests(),
    });
    const before = structuredClone(observed());
    const response = await app.request(
      projection === 'HTTP' ? '/api/app/operations/turn.interrupt' : '/mcp',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${issued.secret}`,
          ...(projection === 'HTTP'
            ? { 'x-openkit-request-id': input.requestId }
            : { accept: 'application/json, text/event-stream' }),
        },
        body: JSON.stringify(
          projection === 'HTTP'
            ? input
            : {
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: { name: 'call', arguments: { operation: 'turn.interrupt', input } },
              }
        ),
      }
    );
    expect(observed()).toEqual(before);
    const code = 'turn_interrupt_failed';
    const message = 'Turn not found: tu_missing';
    if (projection === 'HTTP') {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ protocolVersion: '0.5.0', code, message });
    } else {
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.error).toBeUndefined();
      expect(body.result.isError).toBe(true);
      expect(JSON.parse(body.result.content[0].text)).toEqual({ code, message, status: 404 });
    }
  } finally {
    coreDb.sqlite.close();
  }
});
