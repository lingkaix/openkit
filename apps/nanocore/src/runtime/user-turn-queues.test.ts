import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { listPendingUserTurns } from './pending-user-turns.js';
import {
  enqueueFollowUpInput,
  enqueueSteeringForSafePoint,
  selectFollowUpInputs,
  selectSteeringForSafePoint,
} from './user-turn-queues.js';

/**
 * Opens a migrated workspace database for user turn queue tests.
 *
 * @returns Migrated workspace database handle.
 */
function createWorkspaceDb(): WorkspaceDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-user-turn-queues-'));
  const workspaceDb = openWorkspaceDb(dataRoot, 'user_demo', 'ws_demo');
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

describe('user turn queue helpers', () => {
  it('selects system-owned safe-point steering messages without consuming them', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      enqueueSteeringForSafePoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId: 'req_steering_later',
        contentDigest: 'sha256_later',
        receivedAt: '2026-05-31T00:02:00.000Z',
      });
      enqueueFollowUpInput(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId: 'req_follow_up',
        contentDigest: 'sha256_follow_up',
        receivedAt: '2026-05-31T00:01:00.000Z',
      });
      enqueueSteeringForSafePoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId: 'req_steering_earlier',
        contentItemId: 'item_steering_earlier',
        receivedAt: '2026-05-31T00:00:00.000Z',
      });

      const selected = selectSteeringForSafePoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
      });

      expect(selected.map((message) => message.pendingTurn.requestId)).toEqual([
        'req_steering_earlier',
        'req_steering_later',
      ]);
      expect(selected).toMatchObject([
        {
          kind: 'safe_point_steering_message',
          owner: 'system',
          startsWorkerTurn: false,
          pendingTurn: { queueMode: 'safe_point_steering' },
        },
        {
          kind: 'safe_point_steering_message',
          owner: 'system',
          startsWorkerTurn: false,
          pendingTurn: { queueMode: 'safe_point_steering' },
        },
      ]);
      expect(
        listPendingUserTurns(workspaceDb, { workspaceId: 'ws_demo', threadId: 'th_demo' }).map(
          (turn) => turn.requestId
        )
      ).toEqual(['req_steering_earlier', 'req_follow_up', 'req_steering_later']);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('selects follow-up inputs without consuming or starting workers', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      enqueueFollowUpInput(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId: 'req_follow_up_1',
        contentDigest: 'sha256_1',
        receivedAt: '2026-05-31T00:00:00.000Z',
      });
      enqueueSteeringForSafePoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId: 'req_steering',
        contentDigest: 'sha256_steering',
        receivedAt: '2026-05-31T00:01:00.000Z',
      });
      enqueueFollowUpInput(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId: 'req_follow_up_2',
        contentDigest: 'sha256_2',
        receivedAt: '2026-05-31T00:02:00.000Z',
      });
      enqueueFollowUpInput(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId: 'req_follow_up_3',
        contentDigest: 'sha256_3',
        receivedAt: '2026-05-31T00:03:00.000Z',
      });

      const first = selectFollowUpInputs(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        drainMode: 'one_at_a_time',
      });
      const all = selectFollowUpInputs(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        drainMode: 'all',
      });

      expect(first.map((input) => input.pendingTurn.requestId)).toEqual(['req_follow_up_1']);
      expect(all.map((input) => input.pendingTurn.requestId)).toEqual([
        'req_follow_up_1',
        'req_follow_up_2',
        'req_follow_up_3',
      ]);
      expect([...first, ...all].every((input) => input.startsWorkerTurn === false)).toBe(true);
      expect(
        listPendingUserTurns(workspaceDb, { workspaceId: 'ws_demo', threadId: 'th_demo' }).map(
          (turn) => turn.requestId
        )
      ).toEqual(['req_follow_up_1', 'req_steering', 'req_follow_up_2', 'req_follow_up_3']);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('selects crash-safe persisted follow-up input after restart without deleting it', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-user-turn-queues-restart-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'user_demo', 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      enqueueFollowUpInput(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId: 'req_follow_up_1',
        contentDigest: 'sha256_1',
        receivedAt: '2026-05-31T00:00:00.000Z',
      });
      enqueueFollowUpInput(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId: 'req_follow_up_2',
        contentDigest: 'sha256_2',
        receivedAt: '2026-05-31T00:01:00.000Z',
      });
    } finally {
      workspaceDb.sqlite.close();
    }

    const restartedDb = openWorkspaceDb(dataRoot, 'user_demo', 'ws_demo');

    try {
      applyScopedMigrations(restartedDb);

      const selected = selectFollowUpInputs(restartedDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        drainMode: 'all',
      });

      expect(selected.map((input) => input.pendingTurn.requestId)).toEqual([
        'req_follow_up_1',
        'req_follow_up_2',
      ]);
      expect(selected).toMatchObject([
        {
          kind: 'queued_follow_up_input',
          owner: 'user',
          startsWorkerTurn: false,
          pendingTurn: { queueMode: 'follow_up' },
        },
        {
          kind: 'queued_follow_up_input',
          owner: 'user',
          startsWorkerTurn: false,
          pendingTurn: { queueMode: 'follow_up' },
        },
      ]);
      expect(
        listPendingUserTurns(restartedDb, { workspaceId: 'ws_demo', threadId: 'th_demo' }).map(
          (turn) => turn.requestId
        )
      ).toEqual(['req_follow_up_1', 'req_follow_up_2']);
    } finally {
      restartedDb.sqlite.close();
    }
  });
});
