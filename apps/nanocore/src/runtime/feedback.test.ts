import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { ensureLocalUser } from '../auth/identity.js';
import type { BetterAuthServer } from '../auth/middleware.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createAppWithWorkspaceAuthority as createApp } from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { feedbackFilePath, readTurnFeedback } from './feedback.js';

/**
 * Creates a server-mode auth stub keyed by x-user-id.
 *
 * @returns Better Auth-compatible test double.
 */
function createHeaderAuthStub(): BetterAuthServer {
  return {
    api: {
      getSession: async ({ headers }) => {
        const userId = headers.get('x-user-id');

        return userId ? { session: { id: `session_${userId}` }, user: { id: userId } } : null;
      },
    },
    handler: async () => Response.json({ status: 'auth-ok' }),
  };
}

describe('turn feedback', () => {
  it('creates a feedback file when a turn completes', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-feedback-'));
    const store = createDemoStore({ dataRoot });
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run tests', {
      kind: 'user',
      id: 'user_local',
    });
    const completedAt = new Date().toISOString();

    store.updateTurn(turn.id, {
      agentId: 'agent_codex_host',
      completedAt,
      status: 'completed',
    });

    const feedbackPath = feedbackFilePath(store, store.getTurnById(turn.id));

    expect(existsSync(feedbackPath)).toBe(true);
    expect(feedbackPath).toBe(
      join(
        dataRoot,
        'workspaces',
        'ws_demo',
        'threads',
        'th_demo',
        'turns',
        turn.id,
        'feedback.json'
      )
    );
    expect(readTurnFeedback(store, turn.id)).toMatchObject({
      note: null,
      rating: null,
      turnId: turn.id,
      agentId: 'agent_codex_host',
    });
  });

  it('updates rating and note through the feedback route', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-feedback-'));
    const store = createDemoStore({ dataRoot });
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run tests', {
      kind: 'user',
      id: 'user_local',
    });
    store.updateTurn(turn.id, { completedAt: new Date().toISOString(), status: 'completed' });
    const app = createApp({ store });

    const res = await app.request(
      ...operationRequest(
        'turn.feedback',
        { turnId: turn.id },
        {
          body: JSON.stringify({ note: 'Worked well.', rating: 'good' }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      )
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      note: 'Worked well.',
      rating: 'good',
      turnId: turn.id,
    });
    expect(readTurnFeedback(store, turn.id)).toMatchObject({
      note: 'Worked well.',
      rating: 'good',
    });
  });

  it('returns a typed 400 response for invalid feedback bodies', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-feedback-'));
    const store = createDemoStore({ dataRoot });
    const turn = store.createTurn('ws_demo', 'th_demo', 'Run tests', {
      kind: 'user',
      id: 'user_local',
    });
    store.updateTurn(turn.id, { completedAt: new Date().toISOString(), status: 'completed' });
    const app = createApp({ store });

    const res = await app.request(
      ...operationRequest(
        'turn.feedback',
        { turnId: turn.id },
        {
          body: JSON.stringify({ note: 'Invalid rating.', rating: 'ok' }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }
      )
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      code: 'invalid_feedback',
    });
  });

  it('uses a temp file and rename for feedback updates', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'runtime', 'feedback.ts'), 'utf8');

    expect(source).toContain('renameSync');
    expect(source).toContain('.tmp');
  });

  it('keeps feedback Workspace-owned across authenticated request actors', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-feedback-'));
    const ownerStore = createDemoStore({ dataRoot }, 'user_1');
    const workspace = ownerStore.listWorkspaces().find((item) => item.kind === 'code') ?? null;
    const thread = workspace ? (ownerStore.listThreads(workspace.id)[0] ?? null) : null;

    if (!workspace || !thread) {
      throw new Error('Expected default server-mode workspace and thread.');
    }

    const turn = ownerStore.createTurn(workspace.id, thread.id, 'Run tests', {
      kind: 'user',
      id: 'user_local',
    });
    ownerStore.updateTurn(turn.id, { completedAt: new Date().toISOString(), status: 'completed' });
    const coreDb = openCoreDb(dataRoot);
    onTestFinished(() => coreDb.sqlite.close());
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    for (const userId of ['user_1', 'user_2']) {
      coreDb.sqlite
        .prepare(
          "INSERT INTO users (id, kind, display_name, email, email_verified, created_at, updated_at, last_seen_at) SELECT ?, kind, display_name, ?, email_verified, created_at, updated_at, last_seen_at FROM users WHERE id = 'user_local'"
        )
        .run(userId, `${userId}@local.openkit.invalid`);
    }
    recordWorkspaceOwnerMembership({ coreDb, ownerUserId: 'user_1', workspaceId: workspace.id });
    coreDb.sqlite
      .prepare(
        "INSERT INTO workspace_members (workspace_id, user_id, access_level, status, revision, joined_at, created_at, updated_at) VALUES (?, 'user_2', 'editor', 'active', 1, ?, ?, ?)"
      )
      .run(
        workspace.id,
        new Date().toISOString(),
        new Date().toISOString(),
        new Date().toISOString()
      );
    const app = createApp({
      coreDb,
      store: ownerStore,
      auth: createHeaderAuthStub(),
      dataRoot,
      mode: 'server',
    });

    const res = await app.request(
      ...operationRequest(
        'turn.feedback',
        { turnId: turn.id },
        {
          body: JSON.stringify({ note: 'Shared feedback.', rating: 'bad' }),
          headers: { 'content-type': 'application/json', 'x-user-id': 'user_2' },
          method: 'POST',
        }
      )
    );

    expect(res.status).toBe(200);
    expect(readTurnFeedback(ownerStore, turn.id)).toMatchObject({
      note: 'Shared feedback.',
      rating: 'bad',
    });
  });
});
