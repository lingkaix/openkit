import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createOpenKitAccessTokenRecord,
  revokeOpenKitAccessTokenRecord,
} from './auth/access-token-store.js';
import { ensureLocalUser } from './auth/identity.js';
import { FsStore } from './lib/store.js';
import { openCoreDb } from './storage/db.js';
import { applyMigrations } from './storage/migrate.js';
import { createApp } from './test-support/app.js';
import { recordWorkspaceOwnerMembership } from './workspace-membership.js';

const STAMP = '2026-09-14T00:00:00.000Z';
const TOKEN_EXPIRY = '2999-01-01T00:00:00.000Z';
const GRANTED_DELTA = 'audience-granted';
const REVOKED_DELTA = 'audience-revoked-secret';

/**
 * Builds a CoreDb server-mode fixture with one shared Thread and two ordinary active members.
 *
 * @returns App, store, shared Turn, durable token id, and cleanup.
 */
function createSharedStreamFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-thread-audience-stream-'));
  const coreDb = openCoreDb(dataRoot);
  applyMigrations(coreDb);
  ensureLocalUser(coreDb);
  const store = new FsStore({ dataRoot });
  const workspace = store.createWorkspace('Team');
  recordWorkspaceOwnerMembership({
    coreDb,
    ownerUserId: 'user_local',
    workspaceId: workspace.id,
  });
  const now = Date.now();
  coreDb.sqlite
    .prepare(
      `INSERT INTO users (id, display_name, email, email_verified, created_at, updated_at, kind, status, disabled_at) VALUES ('user_other', 'Other', 'other@example.invalid', false, ?, ?, 'human', 'active', NULL)`
    )
    .run(now, now);
  coreDb.sqlite
    .prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, status, access_level, invitation_id, joined_at, removed_at, revision, created_at, updated_at) VALUES (?, 'user_other', 'active', 'editor', NULL, ?, NULL, 1, ?, ?)`
    )
    .run(workspace.id, STAMP, STAMP, STAMP);
  const thread = store.createThread(workspace.id, 'shared stream', undefined, 'conversation', {
    visibility: 'workspace',
  });
  const turn = store.createTurn(workspace.id, thread.id, 'Stream while a member', {
    kind: 'user',
    id: 'user_local',
  });
  store.createItem({
    completedAt: null,
    createdAt: STAMP,
    id: `it_stream_${turn.id}`,
    status: 'in_progress',
    text: '',
    threadId: thread.id,
    turnId: turn.id,
    type: 'assistant-message',
    workspaceId: workspace.id,
  });
  store.emitTurnEvent(turn.id, {
    data: { status: 'running', turnId: turn.id, type: 'turn-started' },
    event: 'turn.started',
    threadId: thread.id,
    turnId: turn.id,
    workspaceId: workspace.id,
  });
  store.emitTurnEvent(turn.id, {
    data: {
      delta: GRANTED_DELTA,
      deltaKind: 'text-delta',
      itemId: `it_stream_${turn.id}`,
      itemType: 'assistant-message',
      type: 'item-delta',
    },
    event: 'item.delta',
    threadId: thread.id,
    turnId: turn.id,
    workspaceId: workspace.id,
  });
  const issued = createOpenKitAccessTokenRecord(coreDb, {
    expiresAt: TOKEN_EXPIRY,
    ownerUserId: 'user_other',
    scope: 'workspace-readonly',
    workspaceIds: [workspace.id],
  });
  const app = createApp({
    auth: {
      api: { getSession: async () => null },
      handler: async () => new Response(null, { status: 404 }),
    },
    coreDb,
    dataRoot,
    mode: 'server',
    store,
  });
  return {
    app,
    authorization: `Bearer ${issued.secret}`,
    close: () => {
      coreDb.sqlite.close();
      rmSync(dataRoot, { force: true, recursive: true });
    },
    coreDb,
    store,
    thread,
    tokenId: issued.tokenId,
    turn,
    workspace,
  };
}

type StreamFixture = ReturnType<typeof createSharedStreamFixture>;

/**
 * Revokes the ordinary other member's current Workspace membership.
 *
 * @param coreDb Core database owning membership rows.
 * @param workspaceId Workspace whose membership is revoked.
 */
function revokeOtherMembership(coreDb: ReturnType<typeof openCoreDb>, workspaceId: string): void {
  coreDb.sqlite
    .prepare(
      `UPDATE workspace_members
       SET status = 'removed', removed_at = ?, revision = revision + 1, updated_at = ?
       WHERE workspace_id = ? AND user_id = 'user_other'`
    )
    .run(STAMP, STAMP, workspaceId);
}

/**
 * Waits for an SSE response body to end, clearing the hang timeout on every exit.
 *
 * @param bodyPromise In-flight SSE text read.
 * @returns Closed stream text.
 */
async function readClosedSseBody(bodyPromise: Promise<string>): Promise<string> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      bodyPromise,
      new Promise<string>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error('turn event stream did not close after revocation'));
        }, 2000);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

const REVOCATIONS = [
  {
    kind: 'membership',
    revoke: (fixture: StreamFixture) => revokeOtherMembership(fixture.coreDb, fixture.workspace.id),
  },
  {
    kind: 'token',
    revoke: (fixture: StreamFixture) => {
      revokeOpenKitAccessTokenRecord(fixture.coreDb, fixture.tokenId);
    },
  },
] as const;

describe('core Thread audience streams', () => {
  it.each(REVOCATIONS)('blocks the next turn event after ordinary $kind revocation', async ({
    revoke,
  }) => {
    const fixture = createSharedStreamFixture();
    const listenerSpy = vi.spyOn(fixture.store, 'addTurnListener');
    try {
      const response = await fixture.app.request(
        `/api/workspaces/${fixture.workspace.id}/threads/${fixture.thread.id}/events?turnId=${fixture.turn.id}&since=0`,
        { headers: { authorization: fixture.authorization } }
      );
      expect(response.status).toBe(200);
      const bodyPromise = response.text();
      await vi.waitFor(() => expect(listenerSpy).toHaveBeenCalledTimes(1));

      revoke(fixture);
      fixture.store.emitTurnEvent(fixture.turn.id, {
        data: {
          delta: REVOKED_DELTA,
          deltaKind: 'text-delta',
          itemId: `it_stream_${fixture.turn.id}`,
          itemType: 'assistant-message',
          type: 'item-delta',
        },
        event: 'item.delta',
        threadId: fixture.thread.id,
        turnId: fixture.turn.id,
        workspaceId: fixture.workspace.id,
      });

      const text = await readClosedSseBody(bodyPromise);
      expect(text).toContain(GRANTED_DELTA);
      expect(text).not.toContain(REVOKED_DELTA);
    } finally {
      listenerSpy.mockRestore();
      fixture.close();
    }
  });
});
