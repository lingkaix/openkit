import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { BetterAuthServer } from '../auth/middleware.js';
import { openCoreDb } from '../storage/db.js';
import { applyMigrations } from '../storage/migrate.js';
import { createAppWithWorkspaceAuthority as createApp } from '../test-support/app.js';
import { createDemoStore } from '../test-support/demo-store.js';
import { ensureLocalUser } from '../test-support/local-user.js';
import { operationRequest } from '../test-support/operation-request.js';
import { recordWorkspaceOwnerMembership } from '../workspace-membership.js';
import { feedbackFilePath, readTurnFeedback, updateTurnFeedback } from './feedback.js';

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
  it('preserves descriptive disk additions across update and reopen while returning only known fields', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-feedback-extension-'));
    const store = createDemoStore({ dataRoot });
    const turn = store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Feedback',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
    store.updateTurn(turn.id, { completedAt: new Date().toISOString(), status: 'completed' });
    const path = feedbackFilePath(store, turn);
    const original = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...original, futureNote: 'retained' }));
    expect(readTurnFeedback(store, turn.id)).toEqual(original);
    expect(
      updateTurnFeedback(store, turn.id, { rating: 'good', note: 'Updated' })
    ).not.toHaveProperty('futureNote');
    expect(readTurnFeedback(createDemoStore({ dataRoot }), turn.id).rating).toBe('good');
    expect(JSON.parse(readFileSync(path, 'utf8')).futureNote).toBe('retained');
    writeFileSync(path, JSON.stringify({ ...original, rating: 'future' }));
    expect(() => readTurnFeedback(store, turn.id)).toThrow();
    writeFileSync(
      path,
      JSON.stringify({ ...original, turnId: 'tu_00000000-0000-7629-845e-55588f675dfb' })
    );
    expect(() => readTurnFeedback(store, turn.id)).toThrow();
  });
  it('creates a feedback file when a turn completes', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-feedback-'));
    const store = createDemoStore({ dataRoot });
    const turn = store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Run tests',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
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
        'ws_00000000-0000-7000-8000-000000000001',
        'threads',
        'th_00000000-0000-7000-8000-000000000001',
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
    const turn = store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Run tests',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
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
    const turn = store.createTurn(
      'ws_00000000-0000-7000-8000-000000000001',
      'th_00000000-0000-7000-8000-000000000001',
      'Run tests',
      {
        kind: 'user',
        id: 'usr_00000000-0000-7000-8000-000000000001',
      }
    );
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

  it('retains replacement feedback on reopen and removes temporary files after success', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-feedback-replacement-'));
    try {
      const store = createDemoStore({ dataRoot });
      const turn = store.createTurn(
        'ws_00000000-0000-7000-8000-000000000001',
        'th_00000000-0000-7000-8000-000000000001',
        'Feedback replacement',
        {
          kind: 'user',
          id: 'usr_00000000-0000-7000-8000-000000000001',
        }
      );
      store.updateTurn(turn.id, { completedAt: new Date().toISOString(), status: 'completed' });
      const path = feedbackFilePath(store, store.getTurnById(turn.id));
      const entriesBefore = readdirSync(dirname(path)).sort();
      updateTurnFeedback(store, turn.id, { note: 'Prior feedback', rating: 'bad' });
      updateTurnFeedback(store, turn.id, { note: 'Replacement feedback', rating: 'good' });
      expect(readTurnFeedback(createDemoStore({ dataRoot }), turn.id)).toMatchObject({
        note: 'Replacement feedback',
        rating: 'good',
      });
      expect(readdirSync(dirname(path)).sort()).toEqual(entriesBefore);
    } finally {
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  it('keeps feedback Workspace-owned across authenticated request actors', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-feedback-'));
    const ownerStore = createDemoStore({ dataRoot }, 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b');
    const workspace = ownerStore.listWorkspaces().find((item) => item.kind === 'code') ?? null;
    const thread = workspace ? (ownerStore.listThreads(workspace.id)[0] ?? null) : null;

    if (!workspace || !thread) {
      throw new Error('Expected default server-mode workspace and thread.');
    }

    const turn = ownerStore.createTurn(workspace.id, thread.id, 'Run tests', {
      kind: 'user',
      id: 'usr_00000000-0000-7000-8000-000000000001',
    });
    ownerStore.updateTurn(turn.id, { completedAt: new Date().toISOString(), status: 'completed' });
    const coreDb = openCoreDb(dataRoot);
    onTestFinished(() => coreDb.sqlite.close());
    applyMigrations(coreDb);
    ensureLocalUser(coreDb);
    for (const userId of [
      'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b',
      'usr_00000000-0000-7a71-a8b1-dcc65a83481f',
    ]) {
      coreDb.sqlite
        .prepare(
          "INSERT INTO users (id, kind, display_name, email, email_verified, created_at, updated_at, last_seen_at) SELECT ?, kind, display_name, ?, email_verified, created_at, updated_at, last_seen_at FROM users WHERE id = 'usr_00000000-0000-7000-8000-000000000001'"
        )
        .run(userId, `${userId}@local.openkit.invalid`);
    }
    recordWorkspaceOwnerMembership({
      coreDb,
      ownerUserId: 'usr_00000000-0000-7e68-8ab1-8dcac1be1b5b',
      workspaceId: workspace.id,
    });
    coreDb.sqlite
      .prepare(
        "INSERT INTO workspace_members (workspace_id, user_id, access_level, status, revision, joined_at, created_at, updated_at) VALUES (?, 'usr_00000000-0000-7a71-a8b1-dcc65a83481f', 'editor', 'active', 1, ?, ?, ?)"
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
          headers: {
            'content-type': 'application/json',
            'x-user-id': 'usr_00000000-0000-7a71-a8b1-dcc65a83481f',
          },
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
