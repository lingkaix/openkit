import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import { listPendingUserTurns } from './pending-user-turns.js';
import {
  drainFollowUpInputs,
  drainSteeringForSafePoint,
  enqueueFollowUpInput,
  enqueueSteeringForSafePoint,
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
  it('enqueues and drains system-owned safe-point steering messages in order', () => {
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

      const drained = drainSteeringForSafePoint(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
      });

      expect(drained.map((message) => message.pendingTurn.requestId)).toEqual([
        'req_steering_earlier',
        'req_steering_later',
      ]);
      expect(drained).toMatchObject([
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
      ).toEqual(['req_follow_up']);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('drains follow-up inputs with one_at_a_time and all modes without starting workers', () => {
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

      const first = drainFollowUpInputs(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        drainMode: 'one_at_a_time',
      });
      const rest = drainFollowUpInputs(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        drainMode: 'all',
      });

      expect(first.map((input) => input.pendingTurn.requestId)).toEqual(['req_follow_up_1']);
      expect(rest.map((input) => input.pendingTurn.requestId)).toEqual([
        'req_follow_up_2',
        'req_follow_up_3',
      ]);
      expect([...first, ...rest].every((input) => input.startsWorkerTurn === false)).toBe(true);
      expect(
        listPendingUserTurns(workspaceDb, { workspaceId: 'ws_demo', threadId: 'th_demo' }).map(
          (turn) => turn.requestId
        )
      ).toEqual(['req_steering']);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('drains crash-safe persisted follow-up input after restart', () => {
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

      const drained = drainFollowUpInputs(restartedDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        drainMode: 'all',
      });

      expect(drained.map((input) => input.pendingTurn.requestId)).toEqual([
        'req_follow_up_1',
        'req_follow_up_2',
      ]);
      expect(drained).toMatchObject([
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
        listPendingUserTurns(restartedDb, { workspaceId: 'ws_demo', threadId: 'th_demo' })
      ).toEqual([]);
    } finally {
      restartedDb.sqlite.close();
    }
  });
});
