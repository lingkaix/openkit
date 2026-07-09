import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openWorkspaceDb, type WorkspaceDb } from '../storage/db.js';
import { applyScopedMigrations } from '../storage/migrate.js';
import {
  cancelPendingUserTurn,
  consumePendingUserTurn,
  convertPendingUserTurnToFollowUp,
  enqueuePendingUserTurn,
  listPendingUserTurns,
  recordPendingUserTurnEditedAuditEvent,
} from './pending-user-turns.js';

/**
 * Opens a migrated workspace database for pending user turn tests.
 *
 * @returns Migrated workspace database handle.
 */
function createWorkspaceDb(): WorkspaceDb {
  const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-pending-user-turns-'));
  const workspaceDb = openWorkspaceDb(dataRoot, 'user_demo', 'ws_demo');
  applyScopedMigrations(workspaceDb);
  return workspaceDb;
}

describe('pending user turn storage', () => {
  it('enqueues, lists, and consumes pending user turns in thread order', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      enqueuePendingUserTurn(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId: 'req_later',
        contentDigest: 'sha256_later',
        queueMode: 'follow_up',
        receivedAt: '2026-05-31T00:01:00.000Z',
      });
      const earlier = enqueuePendingUserTurn(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId: 'req_earlier',
        contentItemId: 'item_earlier',
        queueMode: 'safe_point_steering',
        receivedAt: '2026-05-31T00:00:00.000Z',
      });

      expect(earlier).toMatchObject({
        pendingTurnId: 'ws_demo:th_demo:req_earlier',
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId: 'req_earlier',
        contentItemId: 'item_earlier',
        contentDigest: null,
        queueMode: 'safe_point_steering',
        receivedAt: '2026-05-31T00:00:00.000Z',
      });
      expect(
        listPendingUserTurns(workspaceDb, { workspaceId: 'ws_demo', threadId: 'th_demo' }).map(
          (turn) => turn.requestId
        )
      ).toEqual(['req_earlier', 'req_later']);
      expect(
        consumePendingUserTurn(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          requestId: 'req_earlier',
        })
      ).toEqual(earlier);
      expect(
        listPendingUserTurns(workspaceDb, { workspaceId: 'ws_demo', threadId: 'th_demo' }).map(
          (turn) => turn.requestId
        )
      ).toEqual(['req_later']);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('treats duplicate request ids as idempotent within one thread scope', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      const first = enqueuePendingUserTurn(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId: 'req_duplicate',
        contentItemId: 'item_original',
        queueMode: 'follow_up',
        receivedAt: '2026-05-31T00:00:00.000Z',
      });
      const second = enqueuePendingUserTurn(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId: 'req_duplicate',
        contentItemId: 'item_changed',
        queueMode: 'blocked_gate',
        receivedAt: '2026-05-31T00:05:00.000Z',
      });

      expect(second).toEqual(first);
      expect(
        listPendingUserTurns(workspaceDb, { workspaceId: 'ws_demo', threadId: 'th_demo' })
      ).toEqual([first]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('records audit events when pending user turns are enqueued and consumed', () => {
    const workspaceDb = createWorkspaceDb();
    const requestId = '11111111-1111-4111-8111-111111111111';

    try {
      enqueuePendingUserTurn(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId,
        contentItemId: 'item_pending',
        queueMode: 'safe_point_steering',
        receivedAt: '2026-05-31T00:00:00.000Z',
      });
      enqueuePendingUserTurn(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId,
        contentItemId: 'item_duplicate',
        queueMode: 'follow_up',
        receivedAt: '2026-05-31T00:01:00.000Z',
      });

      expect(
        workspaceDb.sqlite
          .prepare(
            `SELECT action, category, outcome, severity, resource, thread_id, request_id, item_id, summary
            FROM audit_events
            WHERE action = 'human.pending_user_turn.enqueue'`
          )
          .all()
      ).toEqual([
        {
          action: 'human.pending_user_turn.enqueue',
          category: 'command',
          item_id: 'item_pending',
          outcome: 'succeeded',
          request_id: requestId,
          resource: `pending-user-turn:ws_demo:th_demo:${requestId}`,
          severity: 'info',
          summary: 'Pending user turn enqueued.',
          thread_id: 'th_demo',
        },
      ]);

      expect(
        consumePendingUserTurn(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          requestId,
        })
      ).toMatchObject({
        pendingTurnId: `ws_demo:th_demo:${requestId}`,
      });
      expect(
        consumePendingUserTurn(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          requestId,
        })
      ).toBeNull();

      expect(
        workspaceDb.sqlite
          .prepare(
            `SELECT action, category, outcome, severity, resource, thread_id, request_id, item_id, summary
            FROM audit_events
            WHERE action = 'human.pending_user_turn.consume'`
          )
          .all()
      ).toEqual([
        {
          action: 'human.pending_user_turn.consume',
          category: 'command',
          item_id: 'item_pending',
          outcome: 'succeeded',
          request_id: requestId,
          resource: `pending-user-turn:ws_demo:th_demo:${requestId}`,
          severity: 'info',
          summary: 'Pending user turn consumed.',
          thread_id: 'th_demo',
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('records audit events when pending user turns are cancelled', () => {
    const workspaceDb = createWorkspaceDb();
    const requestId = '22222222-2222-4222-8222-222222222222';

    try {
      enqueuePendingUserTurn(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId,
        contentItemId: 'item_pending_cancel',
        queueMode: 'safe_point_steering',
        receivedAt: '2026-05-31T00:00:00.000Z',
      });

      expect(
        cancelPendingUserTurn(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          requestId,
        })
      ).toMatchObject({
        pendingTurnId: `ws_demo:th_demo:${requestId}`,
      });
      expect(
        cancelPendingUserTurn(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          requestId,
        })
      ).toBeNull();
      expect(
        listPendingUserTurns(workspaceDb, { workspaceId: 'ws_demo', threadId: 'th_demo' })
      ).toEqual([]);
      expect(
        workspaceDb.sqlite
          .prepare(
            `SELECT action, category, outcome, severity, resource, thread_id, request_id, item_id, summary
            FROM audit_events
            WHERE action = 'human.pending_user_turn.cancel'`
          )
          .all()
      ).toEqual([
        {
          action: 'human.pending_user_turn.cancel',
          category: 'command',
          item_id: 'item_pending_cancel',
          outcome: 'cancelled',
          request_id: requestId,
          resource: `pending-user-turn:ws_demo:th_demo:${requestId}`,
          severity: 'info',
          summary: 'Pending user turn cancelled.',
          thread_id: 'th_demo',
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('records audit events when pending user turns are edited', () => {
    const workspaceDb = createWorkspaceDb();
    const requestId = '33333333-3333-4333-8333-333333333333';

    try {
      const pendingTurn = enqueuePendingUserTurn(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId,
        contentItemId: 'item_pending_edit',
        queueMode: 'safe_point_steering',
        receivedAt: '2026-05-31T00:00:00.000Z',
      });

      recordPendingUserTurnEditedAuditEvent(workspaceDb, pendingTurn);
      recordPendingUserTurnEditedAuditEvent(workspaceDb, pendingTurn);

      expect(
        workspaceDb.sqlite
          .prepare(
            `SELECT action, category, outcome, severity, resource, thread_id, request_id, item_id, summary
            FROM audit_events
            WHERE action = 'human.pending_user_turn.edit'`
          )
          .all()
      ).toEqual([
        {
          action: 'human.pending_user_turn.edit',
          category: 'command',
          item_id: 'item_pending_edit',
          outcome: 'succeeded',
          request_id: requestId,
          resource: `pending-user-turn:ws_demo:th_demo:${requestId}`,
          severity: 'info',
          summary: 'Pending user turn edited.',
          thread_id: 'th_demo',
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('converts pending user turns to follow-up delivery idempotently', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      enqueuePendingUserTurn(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId: 'req_convert',
        contentDigest: 'sha256_convert',
        queueMode: 'safe_point_steering',
        receivedAt: '2026-05-31T00:00:00.000Z',
      });

      expect(
        convertPendingUserTurnToFollowUp(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          requestId: 'req_convert',
        })
      ).toMatchObject({ queueMode: 'follow_up' });
      expect(
        convertPendingUserTurnToFollowUp(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          requestId: 'req_convert',
        })
      ).toMatchObject({ queueMode: 'follow_up' });
      expect(
        listPendingUserTurns(workspaceDb, { workspaceId: 'ws_demo', threadId: 'th_demo' })
      ).toMatchObject([{ queueMode: 'follow_up' }]);
      expect(
        workspaceDb.sqlite
          .prepare(
            `SELECT action, outcome, summary
            FROM audit_events
            WHERE action = 'human.pending_user_turn.convert_follow_up'`
          )
          .all()
      ).toEqual([
        {
          action: 'human.pending_user_turn.convert_follow_up',
          outcome: 'succeeded',
          summary: 'Pending user turn converted to follow-up.',
        },
      ]);
    } finally {
      workspaceDb.sqlite.close();
    }
  });

  it('recovers pending input after restart and keeps workspace and thread scopes separate', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'openkit-pending-user-turns-restart-'));
    const workspaceDb = openWorkspaceDb(dataRoot, 'user_demo', 'ws_demo');

    try {
      applyScopedMigrations(workspaceDb);
      enqueuePendingUserTurn(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_demo',
        requestId: 'req_target',
        contentDigest: 'sha256_target',
        queueMode: 'follow_up',
        receivedAt: '2026-05-31T00:00:00.000Z',
      });
      enqueuePendingUserTurn(workspaceDb, {
        workspaceId: 'ws_demo',
        threadId: 'th_other',
        requestId: 'req_other_thread',
        contentDigest: 'sha256_other_thread',
        queueMode: 'follow_up',
        receivedAt: '2026-05-31T00:01:00.000Z',
      });
      enqueuePendingUserTurn(workspaceDb, {
        workspaceId: 'ws_other',
        threadId: 'th_demo',
        requestId: 'req_other_workspace',
        contentDigest: 'sha256_other_workspace',
        queueMode: 'safe_point_steering',
        receivedAt: '2026-05-31T00:02:00.000Z',
      });
    } finally {
      workspaceDb.sqlite.close();
    }

    const restartedDb = openWorkspaceDb(dataRoot, 'user_demo', 'ws_demo');

    try {
      applyScopedMigrations(restartedDb);

      expect(
        listPendingUserTurns(restartedDb, { workspaceId: 'ws_demo', threadId: 'th_demo' })
      ).toMatchObject([
        {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          requestId: 'req_target',
          contentDigest: 'sha256_target',
          queueMode: 'follow_up',
        },
      ]);
      expect(
        listPendingUserTurns(restartedDb, { workspaceId: 'ws_demo', threadId: 'th_other' }).map(
          (turn) => turn.requestId
        )
      ).toEqual(['req_other_thread']);
      expect(
        listPendingUserTurns(restartedDb, { workspaceId: 'ws_other', threadId: 'th_demo' }).map(
          (turn) => turn.requestId
        )
      ).toEqual(['req_other_workspace']);
    } finally {
      restartedDb.sqlite.close();
    }
  });

  it('requires either a content item id or a content digest', () => {
    const workspaceDb = createWorkspaceDb();

    try {
      expect(() =>
        enqueuePendingUserTurn(workspaceDb, {
          workspaceId: 'ws_demo',
          threadId: 'th_demo',
          requestId: 'req_invalid',
          queueMode: 'follow_up',
          receivedAt: '2026-05-31T00:00:00.000Z',
        })
      ).toThrow('Pending user turn requires a content item id or content digest.');
    } finally {
      workspaceDb.sqlite.close();
    }
  });
});
